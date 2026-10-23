/** 3D point annotations: click any point on the model's surface to drop a pin with a
 *  note + a spreadsheet row/ID reference. Pins are plain HTML elements kept in screen-space
 *  sync with the camera every frame (no 3D geometry/materials needed for the markers).
 *  Annotations round-trip through the glTF file itself via `json.extras.babylonLiteAnnotations`,
 *  so they travel with the model on export and are restored on re-load. Lab-only tooling. */

import { createPickingRay, getViewProjectionMatrix, getViewMatrix, resolveCameraViewport, projectWorldToScreenToRef, pickMeshesWithRayPrecise, type SceneContext, type ScreenProjectionResult } from "babylon-lite";
import { isConnected, loadSheetsConfig, readRow, appendAnnotationRow } from "./google-sheets.js";

/** One point annotation. Plain data — this is exactly what gets serialized into glTF `extras`. */
export interface Annotation {
    id: string;
    position: [number, number, number];
    note: string;
    spreadsheetRef: string;
    /** CSS color string (e.g. "#da3633") for the pin dot. */
    color: string;
}

export interface AnnotationOverlayOptions {
    canvas: HTMLCanvasElement;
    /** Absolutely-positioned, pointer-events:none container overlaid exactly on the canvas; pins are its children. */
    pinLayer: HTMLElement;
    /** Sidebar list element showing every annotation (note + spreadsheet ref + edit/delete). */
    listEl: HTMLElement;
    /** Toggle button that enables/disables "click to place a pin" mode. */
    placeButton: HTMLButtonElement;
    /** Returns the currently active scene (or null while no model is loaded), for picking + camera projection. */
    getScene: () => SceneContext | null;
    /** Called whenever the annotation set changes, so the caller can mark the export as dirty. */
    onChange: () => void;
}

export interface AnnotationOverlay {
    /** Replace all annotations (e.g. restored from a loaded file's extras) and re-render. */
    setAnnotations(list: Annotation[]): void;
    getAnnotations(): Annotation[];
    /** Re-project every pin to its current screen position; call once per animation frame. */
    renderFrame(): void;
    dispose(): void;
}

const scratchResult: ScreenProjectionResult = { x: 0, y: 0, z: 0, cssX: 0, cssY: 0, clipW: 0, behindCamera: false, clipped: false, offscreen: false };

const DEFAULT_PIN_COLOR = "#da3633";

function makeId(): string {
    return `ann_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** Validate untrusted `extras` data from a loaded file into a safe Annotation[], dropping anything malformed. */
export function parseStoredAnnotations(raw: unknown): Annotation[] {
    if (!Array.isArray(raw)) {
        return [];
    }
    const result: Annotation[] = [];
    for (const entry of raw) {
        if (
            entry &&
            typeof entry === "object" &&
            Array.isArray(entry.position) &&
            entry.position.length === 3 &&
            entry.position.every((n: unknown) => typeof n === "number")
        ) {
            result.push({
                id: typeof entry.id === "string" ? entry.id : makeId(),
                position: [entry.position[0], entry.position[1], entry.position[2]],
                note: typeof entry.note === "string" ? entry.note : "",
                spreadsheetRef: typeof entry.spreadsheetRef === "string" ? entry.spreadsheetRef : "",
                color: typeof entry.color === "string" ? entry.color : DEFAULT_PIN_COLOR,
            });
        }
    }
    return result;
}

export function createAnnotationOverlay(options: AnnotationOverlayOptions): AnnotationOverlay {
    const { canvas, pinLayer, listEl, placeButton, getScene, onChange } = options;

    let annotations: Annotation[] = [];
    let placing = false;
    const pinEls = new Map<string, HTMLElement>();
    let openForm: HTMLElement | null = null;

    function closeForm(): void {
        openForm?.remove();
        openForm = null;
    }

    /** Floating note/reference editor, positioned near (clientX, clientY) relative to the canvas's offset parent. */
    function showForm(clientX: number, clientY: number, existing: Annotation | null, onSave: (note: string, ref: string, color: string) => void): void {
        closeForm();
        const form = document.createElement("div");
        form.className = "annotation-form";
        form.style.left = `${clientX}px`;
        form.style.top = `${clientY}px`;

        const noteLabel = document.createElement("label");
        noteLabel.textContent = "Note";
        const noteInput = document.createElement("textarea");
        noteInput.rows = 2;
        noteInput.value = existing?.note ?? "";
        noteInput.placeholder = "What is this?";

        const refLabel = document.createElement("label");
        refLabel.textContent = "Spreadsheet row number";
        const refInput = document.createElement("input");
        refInput.type = "text";
        refInput.value = existing?.spreadsheetRef ?? "";
        refInput.placeholder = "e.g. 14";

        // Google Sheets section: push this annotation as a new row, or fetch/show an existing
        // row's full column data. Only usable once the user has connected (see settings panel).
        const sheetsSection = document.createElement("div");
        sheetsSection.className = "annotation-sheets-section";

        const sheetsStatus = document.createElement("div");
        sheetsStatus.className = "annotation-sheets-status";

        const sheetsButtons = document.createElement("div");
        sheetsButtons.className = "annotation-form-buttons";

        const pushBtn = document.createElement("button");
        pushBtn.textContent = "Push to Sheet (new row)";
        pushBtn.className = "secondary";
        pushBtn.addEventListener("click", () => {
            if (!isConnected()) {
                sheetsStatus.textContent = "Not connected. Use the Google Sheets panel to connect first.";
                return;
            }
            const config = loadSheetsConfig();
            pushBtn.disabled = true;
            sheetsStatus.textContent = "Pushing…";
            const position: [number, number, number] = existing?.position ?? [0, 0, 0];
            appendAnnotationRow(config, { id: existing?.id ?? makeId(), note: noteInput.value.trim(), color: colorInput.value, position })
                .then((rowNumber) => {
                    refInput.value = String(rowNumber);
                    sheetsStatus.textContent = `Saved as row ${rowNumber}.`;
                })
                .catch((err: Error) => {
                    sheetsStatus.textContent = `Push failed: ${err.message}`;
                })
                .finally(() => {
                    pushBtn.disabled = false;
                });
        });

        const viewBtn = document.createElement("button");
        viewBtn.textContent = "View row data";
        viewBtn.className = "secondary";
        const rowDataEl = document.createElement("div");
        rowDataEl.className = "annotation-row-data";
        viewBtn.addEventListener("click", () => {
            const rowNumber = Number(refInput.value.trim());
            if (!isConnected()) {
                sheetsStatus.textContent = "Not connected. Use the Google Sheets panel to connect first.";
                return;
            }
            if (!Number.isInteger(rowNumber) || rowNumber < 2) {
                sheetsStatus.textContent = "Enter a valid row number (2 or greater) first.";
                return;
            }
            const config = loadSheetsConfig();
            viewBtn.disabled = true;
            sheetsStatus.textContent = "Loading…";
            rowDataEl.replaceChildren();
            readRow(config, rowNumber)
                .then((data) => {
                    sheetsStatus.textContent = data ? "" : "Row not found.";
                    if (data) {
                        for (const [key, value] of Object.entries(data)) {
                            const line = document.createElement("div");
                            line.className = "annotation-row-data-line";
                            const k = document.createElement("strong");
                            k.textContent = `${key}: `;
                            line.append(k, document.createTextNode(value));
                            rowDataEl.appendChild(line);
                        }
                    }
                })
                .catch((err: Error) => {
                    sheetsStatus.textContent = `Load failed: ${err.message}`;
                })
                .finally(() => {
                    viewBtn.disabled = false;
                });
        });

        sheetsButtons.append(pushBtn, viewBtn);
        sheetsSection.append(sheetsButtons, sheetsStatus, rowDataEl);

        const colorLabel = document.createElement("label");
        colorLabel.textContent = "Dot color";
        const colorInput = document.createElement("input");
        colorInput.type = "color";
        colorInput.className = "annotation-color-input";
        colorInput.value = existing?.color ?? DEFAULT_PIN_COLOR;

        const buttons = document.createElement("div");
        buttons.className = "annotation-form-buttons";

        const saveBtn = document.createElement("button");
        saveBtn.textContent = existing ? "Save" : "Add";
        saveBtn.addEventListener("click", () => {
            onSave(noteInput.value.trim(), refInput.value.trim(), colorInput.value);
            closeForm();
        });

        const cancelBtn = document.createElement("button");
        cancelBtn.textContent = "Cancel";
        cancelBtn.className = "secondary";
        cancelBtn.addEventListener("click", closeForm);

        buttons.append(saveBtn, cancelBtn);
        if (existing) {
            const deleteBtn = document.createElement("button");
            deleteBtn.textContent = "Delete";
            deleteBtn.className = "danger";
            deleteBtn.addEventListener("click", () => {
                annotations = annotations.filter((a) => a.id !== existing.id);
                closeForm();
                render();
                onChange();
            });
            buttons.append(deleteBtn);
        }

        form.append(noteLabel, noteInput, refLabel, refInput, sheetsSection, colorLabel, colorInput, buttons);
        document.body.appendChild(form);
        openForm = form;
        noteInput.focus();

        // Auto-fetch the row's data immediately when opening a pin that's already linked to a sheet row.
        if (existing?.spreadsheetRef && isConnected()) {
            viewBtn.click();
        }
    }

    function render(): void {
        // Pins
        const liveIds = new Set(annotations.map((a) => a.id));
        for (const [id, el] of pinEls) {
            if (!liveIds.has(id)) {
                el.remove();
                pinEls.delete(id);
            }
        }
        annotations.forEach((ann) => {
            let el = pinEls.get(ann.id);
            if (!el) {
                el = document.createElement("div");
                el.className = "annotation-pin";
                el.addEventListener("click", (e) => {
                    e.stopPropagation();
                    const rect = el!.getBoundingClientRect();
                    showForm(rect.left, rect.bottom + 4, ann, (note, spreadsheetRef, color) => {
                        ann.note = note;
                        ann.spreadsheetRef = spreadsheetRef;
                        ann.color = color;
                        render();
                        onChange();
                    });
                });
                pinLayer.appendChild(el);
                pinEls.set(ann.id, el);
            }
            el.style.background = ann.color;
            el.title = ann.note || "(no note)";
        });

        // Sidebar list
        listEl.replaceChildren();
        if (annotations.length === 0) {
            const empty = document.createElement("div");
            empty.className = "annotation-empty";
            empty.textContent = placing ? "Click the model to drop a pin." : "No annotations yet.";
            listEl.appendChild(empty);
        }
        annotations.forEach((ann, index) => {
            const row = document.createElement("div");
            row.className = "annotation-row";

            const swatch = document.createElement("span");
            swatch.className = "annotation-row-swatch";
            swatch.style.background = ann.color;

            const label = document.createElement("div");
            label.className = "annotation-row-text";
            label.textContent = `${index + 1}. ${ann.note || "(no note)"}`;
            if (ann.spreadsheetRef) {
                const ref = document.createElement("span");
                ref.className = "annotation-row-ref";
                ref.textContent = ann.spreadsheetRef;
                label.appendChild(ref);
            }
            const clickToEdit = () => {
                const el = pinEls.get(ann.id);
                const rect = (el ?? canvas).getBoundingClientRect();
                showForm(rect.left, rect.bottom + 4, ann, (note, spreadsheetRef, color) => {
                    ann.note = note;
                    ann.spreadsheetRef = spreadsheetRef;
                    ann.color = color;
                    render();
                    onChange();
                });
            };
            swatch.addEventListener("click", clickToEdit);
            label.addEventListener("click", clickToEdit);

            row.append(swatch, label);
            listEl.appendChild(row);
        });
    }

    function onCanvasClick(e: MouseEvent): void {
        if (!placing) {
            return;
        }
        const scene = getScene();
        const camera = scene?.camera;
        if (!scene || !camera) {
            return;
        }
        const rect = canvas.getBoundingClientRect();
        const ray = createPickingRay(e.clientX - rect.left, e.clientY - rect.top, getViewProjectionMatrix(camera, canvas.width / canvas.height), rect.width, rect.height);
        if (!ray) {
            return;
        }
        const hit = pickMeshesWithRayPrecise(scene.meshes, ray);
        if (!hit.hit || !hit.pickedPoint) {
            return;
        }
        const point = hit.pickedPoint;
        showForm(e.clientX, e.clientY, null, (note, spreadsheetRef, color) => {
            annotations.push({ id: makeId(), position: point, note, spreadsheetRef, color });
            render();
            onChange();
        });
    }
    canvas.addEventListener("click", onCanvasClick);

    placeButton.addEventListener("click", () => {
        placing = !placing;
        placeButton.classList.toggle("active", placing);
        placeButton.textContent = placing ? "Click the model… (cancel)" : "📍 Add Annotation";
        canvas.style.cursor = placing ? "crosshair" : "";
        render();
    });

    function renderFrame(): void {
        const scene = getScene();
        const camera = scene?.camera;
        if (!camera || annotations.length === 0) {
            return;
        }
        const view = getViewMatrix(camera);
        const vp = getViewProjectionMatrix(camera, canvas.width / canvas.height);
        const viewport = resolveCameraViewport(camera, canvas.width, canvas.height);
        const rect = canvas.getBoundingClientRect();

        for (const ann of annotations) {
            const el = pinEls.get(ann.id);
            if (!el) {
                continue;
            }
            const point = { x: ann.position[0], y: ann.position[1], z: ann.position[2] };
            const projected = projectWorldToScreenToRef(
                point,
                view,
                vp,
                { viewport, backingWidth: canvas.width, backingHeight: canvas.height, cssWidth: rect.width, cssHeight: rect.height },
                scratchResult
            );
            if (projected.clipped) {
                el.style.display = "none";
                continue;
            }
            el.style.display = "";
            el.style.left = `${projected.cssX}px`;
            el.style.top = `${projected.cssY}px`;
        }
    }

    function setAnnotations(list: Annotation[]): void {
        annotations = list.map((a) => ({ ...a }));
        render();
    }

    function dispose(): void {
        canvas.removeEventListener("click", onCanvasClick);
        closeForm();
        for (const el of pinEls.values()) {
            el.remove();
        }
        pinEls.clear();
    }

    render();
    return {
        setAnnotations,
        getAnnotations: () => annotations.map((a) => ({ ...a })),
        renderFrame,
        dispose,
    };
}
