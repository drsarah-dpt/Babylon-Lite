/** Custom model viewer — drag & drop (or pick) any local .glb/.gltf file and view it in Babylon Lite.
 *  Keeps a single WebGPU engine alive across loads; each new file tears down the previous
 *  scene and builds a fresh one (loadGltf accepts ArrayBuffer directly — no object URL needed). */

import {
    addToScene,
    startEngine,
    stopEngine,
    createEngine,
    createSceneContext,
    createDefaultCamera,
    loadGltf,
    createHemisphericLight,
    attachControl,
    registerScene,
    unregisterScene,
    disposeScene,
    getContainerMeshes,
    setMeshVisible,
    isPbrMaterial,
    isStandardMaterial,
    rebuildMaterial,
    linearToSrgbByte,
    srgbByteToLinear,
    getViewProjectionMatrix,
    createPickingRay,
    pickMeshesWithRayPrecise,
    type EngineContext,
    type SceneContext,
    type Mesh,
    type Camera,
    type PbrMaterialProps,
    type StandardMaterialProps,
} from "babylon-lite";
import {
    parseGltfContainer,
    collectMeshIndicesInContainerOrder,
    setPrimitiveExportAlpha,
    setPrimitiveExportColor,
    applyPrimitiveDeletions,
    serializeGlb,
    serializeGltfJson,
    type ParsedGltfContainer,
    type MeshPrimitiveRef,
    type ExportMaterialClones,
} from "./gltf-container-io.js";
import { createAnnotationOverlay, parseStoredAnnotations } from "./annotation-overlay.js";
import { loadSheetsConfig, saveSheetsConfig, connect as connectSheets, isConnected as isSheetsConnected } from "./google-sheets.js";

const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
const dropZone = document.getElementById("drop-zone")!;
const fileInput = document.getElementById("file-input") as HTMLInputElement;
const statusEl = document.getElementById("status")!;
const layersPanel = document.getElementById("layers-panel")!;
const layersList = document.getElementById("layers-list")!;
const showAllButton = document.getElementById("show-all-button") as HTMLButtonElement;
const exportButton = document.getElementById("export-button") as HTMLButtonElement;
const annotationsPanel = document.getElementById("annotations-panel")!;
const annotationsList = document.getElementById("annotations-list")!;
const annotationPinLayer = document.getElementById("annotation-pins")!;
const annotationPlaceButton = document.getElementById("annotation-place-button") as HTMLButtonElement;
const sheetsPanel = document.getElementById("sheets-panel")!;
const sheetsCloseButton = document.getElementById("sheets-close-button") as HTMLButtonElement;
const sheetsReopenButton = document.getElementById("sheets-reopen-button") as HTMLButtonElement;
const sheetsClientIdInput = document.getElementById("sheets-client-id") as HTMLInputElement;
const sheetsSpreadsheetIdInput = document.getElementById("sheets-spreadsheet-id") as HTMLInputElement;
const sheetsTabNameInput = document.getElementById("sheets-tab-name") as HTMLInputElement;
const sheetsConnectButton = document.getElementById("sheets-connect-button") as HTMLButtonElement;
const sheetsStatusEl = document.getElementById("sheets-status")!;

let engine: EngineContext | null = null;
let activeScene: SceneContext | null = null;

/** The currently loaded file's raw glTF JSON document + binary chunk, kept around
 *  purely so renames/opacity can be baked back in and the model re-exported. Edited
 *  in place by buildLayersPanel()'s rename and opacity handlers. */
let loadedContainer: ParsedGltfContainer | null = null;
let originalFileName = "model.glb";

/** Tracks cloned export materials created by the opacity slider for the currently loaded
 *  file — see setPrimitiveExportAlpha(). Reset on every new load. */
let exportMaterialClones: ExportMaterialClones = new Map();

/** Primitives the user has marked for permanent removal via each row's Delete button,
 *  keyed `"meshIndex:primitiveIndex"` (see MeshPrimitiveRef). Only applied to the glTF JSON
 *  at export time — see applyPrimitiveDeletions(). Reset on every new load. */
let deletedPrimitiveKeys = new Set<string>();

/** Viewport-click-to-select state: the active camera (for ray unprojection), the
 *  currently loaded meshes (ray-pick candidates), and a mesh→row lookup so a click in the
 *  3D view can highlight the matching Layers panel row. All reset on every new load. */
let activeCamera: Camera | null = null;
let pickableMeshes: Mesh[] = [];
let meshRowMap = new Map<Mesh, HTMLDivElement>();
let selectedRow: HTMLDivElement | null = null;

/** Custom extras key annotations are stored under in the glTF JSON, namespaced to avoid
 *  colliding with other tools' `extras` usage. */
const ANNOTATIONS_EXTRAS_KEY = "babylonLiteAnnotations";

const annotationOverlay = createAnnotationOverlay({
    canvas,
    pinLayer: annotationPinLayer,
    listEl: annotationsList,
    placeButton: annotationPlaceButton,
    getScene: () => activeScene,
    onChange: () => {
        // Annotations live purely in-memory until Export is clicked, same as mesh renames.
    },
});

(function pinUpdateLoop(): void {
    annotationOverlay.renderFrame();
    requestAnimationFrame(pinUpdateLoop);
})();

// Google Sheets panel: restores saved Client ID / Spreadsheet ID / Tab name (never the access
// token — that stays in-memory only and must be re-granted each page load) and wires up Connect.
(function initSheetsPanel(): void {
    sheetsPanel.classList.remove("hidden");
    const config = loadSheetsConfig();
    sheetsClientIdInput.value = config.clientId;
    sheetsSpreadsheetIdInput.value = config.spreadsheetId;
    sheetsTabNameInput.value = config.tabName;

    sheetsCloseButton.addEventListener("click", () => {
        sheetsPanel.classList.add("hidden");
        sheetsReopenButton.classList.remove("hidden");
    });
    sheetsReopenButton.addEventListener("click", () => {
        sheetsReopenButton.classList.add("hidden");
        sheetsPanel.classList.remove("hidden");
    });

    sheetsConnectButton.addEventListener("click", () => {
        const clientId = sheetsClientIdInput.value.trim();
        if (!clientId) {
            sheetsStatusEl.textContent = "Enter an OAuth Client ID first.";
            return;
        }
        saveSheetsConfig({
            clientId,
            spreadsheetId: sheetsSpreadsheetIdInput.value.trim(),
            tabName: sheetsTabNameInput.value.trim(),
        });
        sheetsConnectButton.disabled = true;
        sheetsStatusEl.textContent = "Connecting…";
        connectSheets(clientId)
            .then(() => {
                sheetsStatusEl.textContent = isSheetsConnected() ? "Connected." : "Not connected.";
            })
            .catch((err: Error) => {
                sheetsStatusEl.textContent = `Connect failed: ${err.message}`;
            })
            .finally(() => {
                sheetsConnectButton.disabled = false;
            });
    });
})();

/** Remembers whether a mesh's material was already alpha-blended (translucent) before the
 *  opacity slider touched it, so dialing the slider back to 100% restores the original blend
 *  mode instead of always forcing opaque. Keyed by mesh so unrelated meshes aren't affected. */
const originalAlphaBlend = new WeakMap<Mesh, boolean>();

/** Read the current opacity (0-1) of a mesh's material, defaulting to fully opaque for
 *  material kinds that don't expose an alpha factor. */
function getMeshAlpha(mesh: Mesh): number {
    const material = mesh.material;
    if (isPbrMaterial(material) || isStandardMaterial(material)) {
        return material.alpha ?? 1;
    }
    return 1;
}

/** Read the current base color of a mesh's material as a sRGB "#rrggbb" hex string (the
 *  format native `<input type="color">` pickers use), converting from the material's
 *  linear-RGB storage. Defaults to white for material kinds with no solid-color factor. */
function getMeshColorHex(mesh: Mesh): string {
    const material = mesh.material;
    const linear: readonly [number, number, number] = isPbrMaterial(material)
        ? [material.baseColorFactor?.[0] ?? 1, material.baseColorFactor?.[1] ?? 1, material.baseColorFactor?.[2] ?? 1]
        : isStandardMaterial(material)
          ? material.diffuseColor
          : [1, 1, 1];
    const toHex = (c: number) => linearToSrgbByte(c).toString(16).padStart(2, "0");
    return `#${toHex(linear[0])}${toHex(linear[1])}${toHex(linear[2])}`;
}

/** Parse a sRGB "#rrggbb" hex color string into a linear-RGB triple, the representation
 *  both PBR's baseColorFactor and Standard's diffuseColor actually store. */
function hexToLinearRgb(hex: string): [number, number, number] {
    return [srgbByteToLinear(parseInt(hex.slice(1, 3), 16)), srgbByteToLinear(parseInt(hex.slice(3, 5), 16)), srgbByteToLinear(parseInt(hex.slice(5, 7), 16))];
}

/** Set a mesh's base color at runtime from a sRGB "#rrggbb" hex string, converting to the
 *  linear RGB the material actually stores. Clones the mesh's material via spread (same
 *  isolation pattern as setMeshOpacity) and calls rebuildMaterial() to refresh its UBO with
 *  the new color — a plain mesh.material reassignment alone does trigger a full renderable
 *  rebuild via the material-swap queue, but rebuildMaterial() is called explicitly here too
 *  so a combined color+opacity edit on the same material only ever goes through one,
 *  well-understood refresh path.
 *
 *  Also clears any base-color/diffuse texture on the clone: glTF composites
 *  baseColorTexture * baseColorFactor, so leaving a texture in place would still show its
 *  per-texel shading tinted by the new color instead of a flat, uniform fill — which is what
 *  picking a solid color is meant to produce. */
function setMeshColor(mesh: Mesh, hex: string): void {
    const [r, g, b] = hexToLinearRgb(hex);
    const material = mesh.material;
    if (isPbrMaterial(material)) {
        const alpha = material.baseColorFactor?.[3] ?? 1;
        const updated: PbrMaterialProps = { ...material, baseColorFactor: [r, g, b, alpha], baseColorTexture: undefined };
        mesh.material = updated;
        if (activeScene) {
            rebuildMaterial(activeScene, updated);
        }
    } else if (isStandardMaterial(material)) {
        const updated: StandardMaterialProps = { ...material, diffuseColor: [r, g, b], diffuseTexture: null };
        mesh.material = updated;
        if (activeScene) {
            rebuildMaterial(activeScene, updated);
        }
    }
}

/** Set a mesh's opacity at runtime (0 = fully transparent, 1 = fully opaque). Clones the
 *  mesh's material via spread so meshes sharing a source material aren't all affected, then
 *  reassigns mesh.material and calls rebuildMaterial() to recompute the pipeline's
 *  transparent/opaque classification. The material setter alone isn't enough here: the clone
 *  spread copies the source's cached render-feature bits along with it, so without an explicit
 *  rebuildMaterial() the renderer keeps using the stale (pre-opacity-change) feature flags and
 *  never actually switches the mesh into the alpha-blended render pass. */
function setMeshOpacity(mesh: Mesh, alpha: number): void {
    const material = mesh.material;
    if (!originalAlphaBlend.has(mesh)) {
        originalAlphaBlend.set(mesh, isPbrMaterial(material) ? material.alphaBlend === true : false);
    }
    const clamped = Math.min(1, Math.max(0, alpha));
    if (isPbrMaterial(material)) {
        const updated: PbrMaterialProps = { ...material, alpha: clamped, alphaBlend: (originalAlphaBlend.get(mesh) ?? false) || clamped < 1 };
        mesh.material = updated;
        if (activeScene) {
            rebuildMaterial(activeScene, updated);
        }
    } else if (isStandardMaterial(material)) {
        // Standard materials derive alpha-blend state from `alpha < 1` automatically.
        const updated: StandardMaterialProps = { ...material, alpha: clamped };
        mesh.material = updated;
        if (activeScene) {
            rebuildMaterial(activeScene, updated);
        }
    }
}

function setStatus(text: string, isError = false): void {
    statusEl.textContent = text;
    statusEl.style.color = isError ? "#f85149" : "#8b949e";
}

/** Build the layer-toggle checklist from the loaded meshes. Each checkbox drives
 *  setMeshVisible() directly — no scene re-register needed, the render bundle
 *  cache invalidates itself on the visibility epoch bump. The name field is an
 *  editable text input that writes back to both mesh.name (live display) and the
 *  underlying glTF JSON's `meshes[idx].name` (for permanent export). The opacity
 *  slider and color picker mirror that pattern: they drive the live material via
 *  setMeshOpacity()/setMeshColor() AND bake the same value into the source JSON via
 *  setPrimitiveExportAlpha()/setPrimitiveExportColor(). The trash button marks a
 *  primitive for permanent removal — unlike the checkbox (display-only hide), a
 *  deleted mesh is actually stripped out of the exported file by
 *  applyPrimitiveDeletions() in exportModel(). The magnifier button isolates a mesh
 *  (hides every other mesh live, purely a viewing aid — never baked into export) so an
 *  ambiguous or generically-named row can be visually matched to its place in the model. */
function buildLayersPanel(meshes: Mesh[], meshRefs: MeshPrimitiveRef[]): void {
    layersList.replaceChildren();
    showAllButton.classList.add("hidden");
    pickableMeshes = meshes;
    meshRowMap = new Map();
    selectedRow = null;
    if (meshes.length === 0) {
        layersPanel.classList.add("hidden");
        return;
    }
    layersPanel.classList.remove("hidden");

    // One entry per row, filled in below as rows are built, so the isolate/show-all
    // wiring (added after the loop) can see every row's mesh/checkbox/elements at once.
    const entries: { mesh: Mesh; checkbox: HTMLInputElement; row: HTMLDivElement; locateButton: HTMLButtonElement }[] = [];
    let isolatedMesh: Mesh | null = null;

    const exitIsolation = () => {
        isolatedMesh = null;
        showAllButton.classList.add("hidden");
        for (const entry of entries) {
            setMeshVisible(entry.mesh, entry.checkbox.checked);
            entry.row.classList.remove("layer-row-isolated");
            entry.locateButton.classList.remove("active");
        }
    };
    showAllButton.onclick = exitIsolation;

    const seenNames = new Map<string, number>();
    meshes.forEach((mesh, i) => {
        const baseName = mesh.name || `mesh ${i}`;
        const count = seenNames.get(baseName) ?? 0;
        seenNames.set(baseName, count + 1);
        const ref = meshRefs[i];

        const row = document.createElement("div");
        row.className = "layer-row";

        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.checked = mesh.visible !== false;
        checkbox.addEventListener("change", () => setMeshVisible(mesh, checkbox.checked));

        const colorInput = document.createElement("input");
        colorInput.type = "color";
        colorInput.className = "layer-color";
        colorInput.title = "Mesh color";
        colorInput.value = getMeshColorHex(mesh);
        colorInput.addEventListener("input", () => {
            setMeshColor(mesh, colorInput.value);

            // Bake the same value back into the source JSON so Export produces a file
            // with it baked in permanently, same as the rename/opacity above.
            if (ref && loadedContainer) {
                setPrimitiveExportColor(loadedContainer.json, exportMaterialClones, ref.meshIndex, ref.primitiveIndex, hexToLinearRgb(colorInput.value));
            }
        });

        const nameInput = document.createElement("input");
        nameInput.type = "text";
        nameInput.className = "layer-name";
        nameInput.value = mesh.name ?? "";
        nameInput.placeholder = `mesh ${i}`;
        nameInput.title = "Click to rename this mesh";
        const commitRename = () => {
            const trimmed = nameInput.value.trim();
            const finalName = trimmed || `mesh ${i}`;
            mesh.name = finalName;
            nameInput.value = finalName;

            // Write the rename back into the source JSON so Export produces a file
            // with it baked in permanently, not just an in-memory display change.
            const meshIdx = meshRefs[i]?.meshIndex;
            const meshDef = meshIdx !== undefined ? loadedContainer?.json.meshes?.[meshIdx] : undefined;
            if (meshDef) {
                meshDef.name = finalName;
            }
        };
        nameInput.addEventListener("change", commitRename);
        nameInput.addEventListener("keydown", (e) => {
            if (e.key === "Enter") {
                nameInput.blur();
            }
        });

        const deleteButton = document.createElement("button");
        deleteButton.type = "button";
        deleteButton.className = "layer-delete";
        deleteButton.textContent = "🗑";
        deleteButton.title = "Remove this mesh from the model permanently when you export";
        const deleteKey = ref ? `${ref.meshIndex}:${ref.primitiveIndex}` : undefined;
        const setDeleted = (deleted: boolean) => {
            row.classList.toggle("layer-row-deleted", deleted);
            deleteButton.textContent = deleted ? "↺" : "🗑";
            deleteButton.title = deleted ? "Undo — keep this mesh in the model" : "Remove this mesh from the model permanently when you export";
            checkbox.disabled = deleted;
            colorInput.disabled = deleted;
            nameInput.disabled = deleted;
            opacitySlider.disabled = deleted;
            // Hide live too, so the canvas reflects what Export will actually produce.
            setMeshVisible(mesh, deleted ? false : checkbox.checked);
        };
        deleteButton.addEventListener("click", () => {
            if (!deleteKey) {
                return;
            }
            const nowDeleted = !deletedPrimitiveKeys.has(deleteKey);
            if (nowDeleted) {
                deletedPrimitiveKeys.add(deleteKey);
            } else {
                deletedPrimitiveKeys.delete(deleteKey);
            }
            setDeleted(nowDeleted);
        });

        const locateButton = document.createElement("button");
        locateButton.type = "button";
        locateButton.className = "layer-locate";
        locateButton.textContent = "🔍";
        locateButton.title = "Isolate this mesh in the viewer — hides every other mesh so you can see where it is";
        locateButton.addEventListener("click", () => {
            if (isolatedMesh === mesh) {
                exitIsolation();
                return;
            }
            isolatedMesh = mesh;
            showAllButton.classList.remove("hidden");
            for (const entry of entries) {
                const isTarget = entry.mesh === mesh;
                setMeshVisible(entry.mesh, isTarget);
                entry.row.classList.toggle("layer-row-isolated", isTarget);
                entry.locateButton.classList.toggle("active", isTarget);
            }
        });

        const mainRow = document.createElement("div");
        mainRow.className = "layer-row-main";
        mainRow.append(checkbox, colorInput, nameInput, locateButton, deleteButton);
        if (count > 0) {
            const badge = document.createElement("span");
            badge.className = "layer-dup-badge";
            badge.textContent = `#${count + 1}`;
            badge.title = "Duplicate name in source file";
            mainRow.append(badge);
        }
        row.append(mainRow);

        const opacityRow = document.createElement("div");
        opacityRow.className = "layer-opacity-row";
        const opacitySlider = document.createElement("input");
        opacitySlider.type = "range";
        opacitySlider.className = "layer-opacity";
        opacitySlider.min = "0";
        opacitySlider.max = "100";
        opacitySlider.step = "1";
        const initialPercent = Math.round(getMeshAlpha(mesh) * 100);
        opacitySlider.value = String(initialPercent);
        opacitySlider.title = "Opacity — drag left to make this mesh transparent";
        const opacityValue = document.createElement("span");
        opacityValue.className = "layer-opacity-value";
        opacityValue.textContent = `${initialPercent}%`;
        opacitySlider.addEventListener("input", () => {
            const percent = Number(opacitySlider.value);
            opacityValue.textContent = `${percent}%`;
            const alpha = percent / 100;
            setMeshOpacity(mesh, alpha);

            // Bake the same value back into the source JSON so Export produces a file
            // with it baked in permanently, same as the rename above.
            if (ref && loadedContainer) {
                setPrimitiveExportAlpha(loadedContainer.json, exportMaterialClones, ref.meshIndex, ref.primitiveIndex, alpha);
            }
        });
        opacityRow.append(opacitySlider, opacityValue);
        row.append(opacityRow);

        entries.push({ mesh, checkbox, row, locateButton });
        meshRowMap.set(mesh, row);
        layersList.appendChild(row);
    });
}

/** Highlight the Layers panel row for `mesh` (clearing any previous highlight) and
 *  scroll it into view. Called after a viewport click resolves to a picked mesh, so the
 *  user can find a mesh in the list just by clicking on it in the 3D view. Pass `null` to
 *  clear the highlight with no replacement (e.g. a click that hit nothing). */
function selectMeshRow(mesh: Mesh | null): void {
    if (selectedRow) {
        selectedRow.classList.remove("layer-row-selected");
        selectedRow = null;
    }
    if (!mesh) {
        return;
    }
    const row = meshRowMap.get(mesh);
    if (!row) {
        return;
    }
    row.classList.add("layer-row-selected");
    row.scrollIntoView({ block: "nearest", behavior: "smooth" });
    selectedRow = row;
}

/** Click-to-select: cast a ray from the clicked canvas point through the active camera and
 *  highlight whatever mesh it hits in the Layers panel. Uses the triangle-precise CPU pick
 *  (not the cheaper AABB-only pick) — bounding boxes of overlapping anatomy meshes nest/overlap
 *  heavily, so an AABB-only test would often "win" on a large mesh's box well in front of the
 *  actual surface under the cursor. Hidden (unchecked) meshes are excluded via the predicate so
 *  they don't block picks to whatever is visible behind them. Tracks pointerdown/up positions so
 *  an orbit-camera drag (attachControl's pointer-driven rotate/pan) isn't misread as a click. */
let pointerDownPos: { x: number; y: number } | null = null;
canvas.addEventListener("pointerdown", (e) => {
    pointerDownPos = { x: e.clientX, y: e.clientY };
});
canvas.addEventListener("pointerup", (e) => {
    const down = pointerDownPos;
    pointerDownPos = null;
    if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5 || e.button !== 0) {
        return;
    }
    if (!activeCamera) {
        return;
    }
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const vp = getViewProjectionMatrix(activeCamera, rect.width / rect.height);
    const ray = createPickingRay(x, y, vp, rect.width, rect.height);
    if (!ray) {
        return;
    }
    const info = pickMeshesWithRayPrecise(pickableMeshes, ray, { predicate: (mesh) => mesh.visible !== false });
    const picked = info.hit && info.pickedMesh && meshRowMap.has(info.pickedMesh as Mesh) ? (info.pickedMesh as Mesh) : null;
    selectMeshRow(picked);
});

/** Download the current model with all renames + opacity + color + deletions +
 *  annotations baked into its glTF JSON. */
function exportModel(): void {
    if (!loadedContainer) {
        return;
    }
    const json = loadedContainer.json;
    json.extras = { ...json.extras, [ANNOTATIONS_EXTRAS_KEY]: annotationOverlay.getAnnotations() };
    applyPrimitiveDeletions(json, deletedPrimitiveKeys);

    const base = originalFileName.replace(/\.(glb|gltf)$/i, "");
    const outName = loadedContainer.isBinary ? `${base}-renamed.glb` : `${base}-renamed.gltf`;
    const blob = loadedContainer.isBinary ? serializeGlb(json, loadedContainer.binChunk) : serializeGltfJson(json);

    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = outName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    setStatus(`Exported "${outName}" with updated mesh names, opacity, color, deletions, and annotations.`);
}
exportButton.addEventListener("click", exportModel);

/** Acquire the WebGPU context + engine as early as possible (page load, not on first
 *  user interaction). A canvas can only ever bind one context type for its lifetime —
 *  waiting until a file drop to call createEngine() risks another consumer (e.g. a
 *  host preview/thumbnail snapshot) claiming a 2D context on the same canvas first,
 *  which permanently blocks WebGPU with "context not available". */
const enginePromise: Promise<EngineContext> = createEngine(canvas);

async function loadModel(file: File): Promise<void> {
    setStatus(`Loading "${file.name}"…`);
    try {
        const data = await file.arrayBuffer();
        const parsed = parseGltfContainer(data);
        loadedContainer = parsed;
        originalFileName = file.name;
        exportMaterialClones = new Map();
        deletedPrimitiveKeys = new Set();
        exportButton.disabled = false;

        if (!engine) {
            engine = await enginePromise;
        } else {
            stopEngine(engine);
        }
        if (activeScene) {
            unregisterScene(activeScene);
            disposeScene(activeScene);
            activeScene = null;
        }

        const scene = createSceneContext(engine);
        const container = await loadGltf(engine, data);
        addToScene(scene, container);
        addToScene(scene, createHemisphericLight());

        const cam = createDefaultCamera(scene);
        attachControl(cam, canvas, scene);
        activeCamera = cam;

        await registerScene(scene);
        await startEngine(engine);
        activeScene = scene;

        const meshRefs = collectMeshIndicesInContainerOrder(parsed.json);
        buildLayersPanel(getContainerMeshes(container), meshRefs);

        annotationOverlay.setAnnotations(parseStoredAnnotations(parsed.json.extras?.[ANNOTATIONS_EXTRAS_KEY]));
        annotationsPanel.classList.remove("hidden");

        Object.assign(canvas.dataset, { ready: true });
        dropZone.classList.add("hidden");
        setStatus(`Loaded "${file.name}". Drop another file to replace it.`);
        dropZone.classList.remove("hidden");
    } catch (err) {
        setStatus(`Failed to load "${file.name}": ${(err as Error).message}`, true);
        console.error(err);
    }
}

function isModelFile(file: File): boolean {
    return /\.(glb|gltf)$/i.test(file.name);
}

dropZone.addEventListener("dragover", (e) => {
    e.preventDefault();
    dropZone.classList.add("drag-over");
});
dropZone.addEventListener("dragleave", () => dropZone.classList.remove("drag-over"));
dropZone.addEventListener("drop", (e) => {
    e.preventDefault();
    dropZone.classList.remove("drag-over");
    const file = e.dataTransfer?.files?.[0];
    if (file && isModelFile(file)) {
        void loadModel(file);
    } else if (file) {
        setStatus(`Unsupported file "${file.name}" — expected .glb or .gltf`, true);
    }
});
dropZone.addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", () => {
    const file = fileInput.files?.[0];
    if (file) {
        void loadModel(file);
    }
});

// Mark the loader overlay ready immediately — there is no model to wait for until the user picks one.
Object.assign(canvas.dataset, { ready: true });
enginePromise
    .then(() => setStatus("Drop a .glb/.gltf file here, or click to browse."))
    .catch((err) => setStatus(`WebGPU unavailable: ${(err as Error).message}`, true));
