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
    createUtilityLayer,
    registerUtilityLayer,
    disposeUtilityLayer,
    createPositionGizmo,
    attachPositionGizmoToNode,
    disposePositionGizmo,
    createRotationGizmo,
    attachRotationGizmoToNode,
    disposeRotationGizmo,
    createScaleGizmo,
    attachScaleGizmoToNode,
    disposeScaleGizmo,
    createTransformNode,
    setParent,
    type EngineContext,
    type SceneContext,
    type Mesh,
    type Camera,
    type PbrMaterialProps,
    type StandardMaterialProps,
    type SceneNode,
    type UtilityLayer,
    type PositionGizmo,
    type RotationGizmo,
    type ScaleGizmo,
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
import { mergeSelectedMeshesIntoContainer, listSelectableMeshes } from "./merge-gltf.js";

const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
const dropZone = document.getElementById("drop-zone")!;
const fileInput = document.getElementById("file-input") as HTMLInputElement;
const statusEl = document.getElementById("status")!;
const layersPanel = document.getElementById("layers-panel")!;
const layersList = document.getElementById("layers-list")!;
const showAllButton = document.getElementById("show-all-button") as HTMLButtonElement;
const exportButton = document.getElementById("export-button") as HTMLButtonElement;
const mergeButton = document.getElementById("merge-button") as HTMLButtonElement;
const mergeFileInput = document.getElementById("merge-file-input") as HTMLInputElement;
const mergeSelectPanel = document.getElementById("merge-select-panel")!;
const mergeSelectHint = document.getElementById("merge-select-hint")!;
const mergeSelectList = document.getElementById("merge-select-list")!;
const mergeSelectConfirm = document.getElementById("merge-select-confirm") as HTMLButtonElement;
const mergeSelectCancel = document.getElementById("merge-select-cancel") as HTMLButtonElement;
const combineButton = document.getElementById("combine-button") as HTMLButtonElement;
const combineSelectPanel = document.getElementById("combine-select-panel")!;
const combineSelectName = document.getElementById("combine-select-name") as HTMLInputElement;
const combineSelectList = document.getElementById("combine-select-list")!;
const combineSelectConfirm = document.getElementById("combine-select-confirm") as HTMLButtonElement;
const combineSelectCancel = document.getElementById("combine-select-cancel") as HTMLButtonElement;
const alignGroupsPanel = document.getElementById("align-groups-panel")!;
const alignGroupsList = document.getElementById("align-groups-list")!;
const alignToolbar = document.getElementById("align-toolbar")!;
const alignToolbarLabel = document.getElementById("align-toolbar-label")!;
const alignModeMoveButton = document.getElementById("align-mode-move") as HTMLButtonElement;
const alignModeRotateButton = document.getElementById("align-mode-rotate") as HTMLButtonElement;
const alignModeScaleButton = document.getElementById("align-mode-scale") as HTMLButtonElement;
const alignResetButton = document.getElementById("align-toolbar-reset") as HTMLButtonElement;
const alignDoneButton = document.getElementById("align-toolbar-done") as HTMLButtonElement;
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

/** One "Merge Selected" click's set of newly-added top-level glTF nodes, grouped so they
 *  can be moved/rotated/scaled together as a rigid unit via the Align toolbar. `nodes` are
 *  the live SceneNode objects (one per merged top-level node — a mesh.parent, not the Mesh
 *  itself; see mergeSelectedMeshes()). `nodeIndices` are the matching glTF node indices in
 *  `loadedContainer.json.nodes`, so commitAlignment() can bake the final placement back
 *  into the export JSON. */
interface MergeGroup {
    id: number;
    label: string;
    nodeIndices: number[];
    nodes: SceneNode[];
}
let nextAlignGroupId = 1;
let mergeGroups: MergeGroup[] = [];
let activeAlignGroup: MergeGroup | null = null;

/** A "Combine Meshes" group: several meshes already in the currently loaded model,
 *  gathered under one new wrapper glTF node so the Layers panel can show them as a
 *  single row with one on/off toggle (see combineSelectedNodes()/renderLayerGroupRow()).
 *  Unlike MergeGroup (which only groups newly merged-in nodes for alignment), this
 *  group is permanent — it's written into loadedContainer.json's node hierarchy so it
 *  survives Export. `memberNodeIndices` are the ORIGINAL glTF node indices of the
 *  meshes that were combined (unchanged — only their parent changed); `wrapperNodeIndex`
 *  is the new node's own index. */
interface CombinedGroup {
    id: number;
    label: string;
    wrapperNodeIndex: number;
    memberNodeIndices: number[];
}
let nextCombinedGroupId = 1;
let combinedGroups: CombinedGroup[] = [];

/** The glTF node-index refs for the Layers panel rows currently on screen (parallel to
 *  `pickableMeshes`), kept at module scope so combineSelectedNodes()/ungroupCombinedGroup()
 *  can re-render the Layers panel after editing loadedContainer.json without a full reload. */
let currentMeshRefs: MeshPrimitiveRef[] = [];

/** The scene's synthetic root TransformNode (container.entities[0] from the glTF loader —
 *  see load-gltf.ts's buildNodeHierarchy), used as the reparent target both for each
 *  align-group's wrapper node and for un-wrapping on commit. Reset on every new load. */
let sceneRootNode: SceneNode | null = null;
/** The wrapper TransformNode a MergeGroup's nodes are temporarily reparented under while
 *  aligning — see startAligning()/commitAlignment(). */
let alignWrapper: SceneNode | null = null;
let alignUtilityLayer: UtilityLayer | null = null;
let alignPositionGizmo: PositionGizmo | null = null;
let alignRotationGizmo: RotationGizmo | null = null;
let alignScaleGizmo: ScaleGizmo | null = null;
type AlignMode = "move" | "rotate" | "scale";
let alignMode: AlignMode = "move";



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
    currentMeshRefs = meshRefs;
    meshRowMap = new Map();
    selectedRow = null;
    if (meshes.length === 0) {
        layersPanel.classList.add("hidden");
        combineButton.disabled = true;
        return;
    }
    layersPanel.classList.remove("hidden");
    combineButton.disabled = meshes.length < 2;

    // Rows whose mesh belongs to a CombinedGroup are routed into that group's
    // collapsible body (see appendLayerGroupRow()) instead of straight into
    // layersList — built once up front so the per-mesh loop below can look each
    // mesh's group up by its glTF node index in O(1).
    const nodeIndexToGroup = new Map<number, CombinedGroup>();
    for (const group of combinedGroups) {
        for (const idx of group.memberNodeIndices) {
            nodeIndexToGroup.set(idx, group);
        }
    }
    const groupContainers = new Map<number, { bodyDiv: HTMLDivElement; checkbox: HTMLInputElement; members: { mesh: Mesh; checkbox: HTMLInputElement }[] }>();

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

        const group = ref ? nodeIndexToGroup.get(ref.nodeIndex) : undefined;
        if (group) {
            let container = groupContainers.get(group.id);
            if (!container) {
                container = appendLayerGroupRow(group);
                groupContainers.set(group.id, container);
            }
            checkbox.classList.add("layer-group-member-checkbox");
            container.members.push({ mesh, checkbox });
            container.bodyDiv.appendChild(row);
        } else {
            layersList.appendChild(row);
        }
    });

    // Reconcile each group's header checkbox now that every member row exists —
    // checked only when every member in the group is currently visible.
    for (const container of groupContainers.values()) {
        container.checkbox.checked = container.members.every((m) => m.checkbox.checked);
    }
}

/** Create and append a CombinedGroup's header row (single on/off toggle + rename +
 *  expand/collapse + ungroup) plus its collapsible member-row body, returning the live
 *  handles buildLayersPanel()'s per-mesh loop needs to route that group's own rows into
 *  the body and keep the header checkbox in sync. */
function appendLayerGroupRow(group: CombinedGroup): { bodyDiv: HTMLDivElement; checkbox: HTMLInputElement; members: { mesh: Mesh; checkbox: HTMLInputElement }[] } {
    const wrapperDiv = document.createElement("div");
    wrapperDiv.className = "layer-group";

    const header = document.createElement("div");
    header.className = "layer-group-header";

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = true;
    checkbox.title = "Toggle every mesh in this group on/off together";

    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.className = "layer-group-name";
    nameInput.value = group.label;
    nameInput.title = "Click to rename this group";
    const commitGroupRename = () => {
        const trimmed = nameInput.value.trim();
        const finalName = trimmed || group.label;
        group.label = finalName;
        nameInput.value = finalName;
        const jsonNode = loadedContainer?.json.nodes?.[group.wrapperNodeIndex];
        if (jsonNode) {
            jsonNode.name = finalName;
        }
    };
    nameInput.addEventListener("change", commitGroupRename);
    nameInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
            nameInput.blur();
        }
    });

    const toggleButton = document.createElement("button");
    toggleButton.type = "button";
    toggleButton.className = "layer-group-toggle";
    toggleButton.textContent = "▾";
    toggleButton.title = "Expand/collapse this group's individual meshes (to adjust their own color/opacity)";

    const ungroupButton = document.createElement("button");
    ungroupButton.type = "button";
    ungroupButton.className = "layer-group-ungroup";
    ungroupButton.textContent = "✕";
    ungroupButton.title = "Ungroup — restore each mesh's own on/off toggle";
    ungroupButton.addEventListener("click", () => ungroupCombinedGroup(group));

    header.append(checkbox, nameInput, toggleButton, ungroupButton);

    const bodyDiv = document.createElement("div");
    bodyDiv.className = "layer-group-body hidden";
    toggleButton.addEventListener("click", () => bodyDiv.classList.toggle("hidden"));

    const groupContainer = { bodyDiv, checkbox, members: [] as { mesh: Mesh; checkbox: HTMLInputElement }[] };
    checkbox.addEventListener("change", () => {
        for (const member of groupContainer.members) {
            member.checkbox.checked = checkbox.checked;
            setMeshVisible(member.mesh, checkbox.checked);
        }
    });

    wrapperDiv.append(header, bodyDiv);
    layersList.appendChild(wrapperDiv);
    return groupContainer;
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

/** Core load path shared by "replace model" and "merge in another model": takes raw
 *  file bytes that have already been decided on (a plain loaded file, or the
 *  re-serialized result of a merge), parses them, and rebuilds the whole scene +
 *  Layers panel from scratch. `displayName` is only used for status messages and as
 *  the export file name. `mergeInfo`, when present, means this reload followed a
 *  "Merge Selected" click — it's used to locate the newly-added nodes and
 *  immediately start an alignment session for them (see startAligning()). */
async function loadModelFromBuffer(data: ArrayBuffer, displayName: string, mergeInfo?: { nodeIndices: number[]; primitiveCounts: number[]; label: string }): Promise<void> {
    const parsed = parseGltfContainer(data);
    loadedContainer = parsed;
    originalFileName = displayName;
    exportMaterialClones = new Map();
    deletedPrimitiveKeys = new Set();
    exportButton.disabled = false;
    mergeButton.disabled = false;

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
    // Tear down any gizmo/utility-layer state from the previous load — the whole
    // scene (and every SceneNode in it, including any align wrapper) is being
    // discarded, so an in-progress-but-uncommitted alignment is simply lost along
    // with it (same as any other unsaved viewport edit on a reload).
    disposeAlignGizmos();
    mergeGroups = [];
    combinedGroups = [];
    activeAlignGroup = null;
    alignWrapper = null;
    sceneRootNode = null;
    alignGroupsPanel.classList.add("hidden");
    alignGroupsList.replaceChildren();
    alignToolbar.classList.add("hidden");

    const scene = createSceneContext(engine);
    const container = await loadGltf(engine, data);
    addToScene(scene, container);
    addToScene(scene, createHemisphericLight());

    const cam = createDefaultCamera(scene);
    attachControl(cam, canvas, scene);
    activeCamera = cam;

    await registerScene(scene);

    sceneRootNode = (container.entities[0] as SceneNode) ?? null;
    alignUtilityLayer = createUtilityLayer(engine, scene);
    alignPositionGizmo = createPositionGizmo(engine, alignUtilityLayer);
    alignRotationGizmo = createRotationGizmo(engine, alignUtilityLayer);
    alignScaleGizmo = createScaleGizmo(engine, alignUtilityLayer);
    await registerUtilityLayer(alignUtilityLayer);

    await startEngine(engine);
    activeScene = scene;

    const meshRefs = collectMeshIndicesInContainerOrder(parsed.json);
    buildLayersPanel(getContainerMeshes(container), meshRefs);

    annotationOverlay.setAnnotations(parseStoredAnnotations(parsed.json.extras?.[ANNOTATIONS_EXTRAS_KEY]));
    annotationsPanel.classList.remove("hidden");

    Object.assign(canvas.dataset, { ready: true });
    dropZone.classList.add("hidden");
    setStatus(`Loaded "${displayName}". Drop another file to replace it.`);
    dropZone.classList.remove("hidden");

    if (mergeInfo && mergeInfo.nodeIndices.length > 0) {
        const total = mergeInfo.primitiveCounts.reduce((a, b) => a + b, 0);
        const tail = pickableMeshes.slice(pickableMeshes.length - total);
        const nodes: SceneNode[] = [];
        let cursor = 0;
        for (const count of mergeInfo.primitiveCounts) {
            const firstMeshOfNode = tail[cursor];
            if (firstMeshOfNode?.parent) {
                nodes.push(firstMeshOfNode.parent as SceneNode);
            }
            cursor += count;
        }
        if (nodes.length === mergeInfo.nodeIndices.length) {
            const group: MergeGroup = { id: nextAlignGroupId++, label: mergeInfo.label, nodeIndices: mergeInfo.nodeIndices, nodes };
            mergeGroups.push(group);
            renderAlignGroupsPanel();
            startAligning(group);
            setStatus(`Merged ${nodes.length} mesh group(s) from "${mergeInfo.label}" — drag the gizmo to align them, then click Done.`);
        }
    }
}

// ─── Combine meshes within the current model ────────────────────────────
// Unlike "+ Merge In Another Model" (which brings meshes IN from a second file), this
// groups meshes that are ALREADY in the currently loaded model under one new wrapper
// node so the Layers panel shows them as a single row with one on/off toggle — e.g.
// collapsing several small vein/nerve/lymphatic meshes into one "Vasculature" toggle,
// while still letting each keep its own color/opacity (expand the group to reach them).
// The grouping is written directly into loadedContainer.json so it's preserved by
// Export; it does NOT touch any vertex/geometry data (see the ask_user choice this
// feature was built from — "keep separate colors, just group under one toggle").

/** Drop `nodeIndex` from wherever it's referenced as a child in `json` — the default
 *  scene's root node list, or any other node's `children` array — so it can be safely
 *  re-parented elsewhere without leaving a dangling duplicate reference. */
function removeNodeReference(json: any, nodeIndex: number): void {
    const sceneIndex = json.scene ?? 0;
    json.scenes = (json.scenes ?? []).map((scene: any, i: number) =>
        i === sceneIndex ? { ...scene, nodes: (scene.nodes ?? []).filter((n: number) => n !== nodeIndex) } : scene);
    for (const node of json.nodes ?? []) {
        if (node?.children) {
            node.children = node.children.filter((n: number) => n !== nodeIndex);
        }
    }
}

/** Find the live SceneNode currently hosting the mesh placed by glTF node `nodeIndex`,
 *  by looking up a Layers-panel row whose ref matches it (see MeshPrimitiveRef). */
function findLiveNodeForJsonNode(nodeIndex: number): SceneNode | undefined {
    const i = currentMeshRefs.findIndex((r) => r.nodeIndex === nodeIndex);
    const mesh = i >= 0 ? pickableMeshes[i] : undefined;
    return mesh?.parent as SceneNode | undefined;
}

/** Combine the meshes placed by `nodeIndices` (their CURRENT glTF node indices — these
 *  don't change, only their parent does) into one new wrapper node named `label`. Each
 *  node is reparented under a fresh permanent TransformNode, preserving its current
 *  world position/rotation/scale exactly like the Align toolbar's wrapper-and-bake
 *  pattern (see commitAlignment()) — then the glTF JSON is restructured to match: a new
 *  `{ name, children: nodeIndices }` node replaces them as a scene root. */
function combineSelectedNodes(nodeIndices: number[], label: string): void {
    if (!loadedContainer || !sceneRootNode) {
        setStatus("Load a model first.", true);
        return;
    }
    const json = loadedContainer.json;
    const nodes: any[] = json.nodes ?? [];

    const liveNodes: SceneNode[] = [];
    for (const nodeIndex of nodeIndices) {
        const liveNode = findLiveNodeForJsonNode(nodeIndex);
        if (!liveNode) {
            setStatus(`Couldn't find a mesh for node ${nodeIndex} to combine — try reloading the model.`, true);
            return;
        }
        liveNodes.push(liveNode);
    }

    const wrapper = createTransformNode(label);
    setParent(wrapper, sceneRootNode);
    liveNodes.forEach((node, i) => {
        setParent(node, wrapper);
        const localMatrix = node._localMatrix;
        const jsonNode = nodes[nodeIndices[i]!];
        if (localMatrix && jsonNode) {
            jsonNode.matrix = Array.from({ length: 16 }, (_, k) => localMatrix[k]);
            delete jsonNode.translation;
            delete jsonNode.rotation;
            delete jsonNode.scale;
        }
    });

    for (const nodeIndex of nodeIndices) {
        removeNodeReference(json, nodeIndex);
    }
    const wrapperNodeIndex = nodes.length;
    nodes.push({ name: label, children: [...nodeIndices] });
    json.nodes = nodes;
    const sceneIndex = json.scene ?? 0;
    json.scenes = (json.scenes ?? []).map((scene: any, i: number) =>
        i === sceneIndex ? { ...scene, nodes: [...(scene.nodes ?? []), wrapperNodeIndex] } : scene);

    combinedGroups.push({ id: nextCombinedGroupId++, label, wrapperNodeIndex, memberNodeIndices: [...nodeIndices] });
    setStatus(`Combined ${nodeIndices.length} meshes into "${label}" — toggle them together from the Layers panel, or expand the group to adjust each one's color.`);
    buildLayersPanel(pickableMeshes, currentMeshRefs);
}

/** Undo a combine: reparent each member node back under the scene root (preserving its
 *  current world transform, baked into the export JSON the same way combineSelectedNodes
 *  bakes it in), then drop the now-childless wrapper node from the scene so each mesh
 *  gets its own Layers panel row and toggle back. The wrapper's glTF node entry is left
 *  in place but unreferenced (harmless — exporters/viewers only walk nodes reachable from
 *  a scene root) rather than spliced out, so no other stored node index needs remapping. */
function ungroupCombinedGroup(group: CombinedGroup): void {
    if (!loadedContainer || !sceneRootNode) {
        return;
    }
    const json = loadedContainer.json;
    const nodes: any[] = json.nodes ?? [];

    for (const nodeIndex of group.memberNodeIndices) {
        const liveNode = findLiveNodeForJsonNode(nodeIndex);
        if (!liveNode) {
            continue;
        }
        setParent(liveNode, sceneRootNode);
        const localMatrix = liveNode._localMatrix;
        const jsonNode = nodes[nodeIndex];
        if (localMatrix && jsonNode) {
            jsonNode.matrix = Array.from({ length: 16 }, (_, k) => localMatrix[k]);
            delete jsonNode.translation;
            delete jsonNode.rotation;
            delete jsonNode.scale;
        }
    }

    removeNodeReference(json, group.wrapperNodeIndex);
    const wrapperJsonNode = nodes[group.wrapperNodeIndex];
    if (wrapperJsonNode) {
        wrapperJsonNode.children = [];
    }
    const sceneIndex = json.scene ?? 0;
    json.scenes = (json.scenes ?? []).map((scene: any, i: number) =>
        i === sceneIndex ? { ...scene, nodes: [...(scene.nodes ?? []), ...group.memberNodeIndices] } : scene);

    combinedGroups = combinedGroups.filter((g) => g.id !== group.id);
    setStatus(`Ungrouped "${group.label}" — each mesh has its own toggle again.`);
    buildLayersPanel(pickableMeshes, currentMeshRefs);
}

/** Show the "pick meshes to combine" panel, listing one row per distinct glTF node
 *  currently placing a mesh in the scene (deduplicated so a multi-primitive mesh's
 *  several Layers-panel rows don't produce duplicate entries here — see
 *  collectMeshIndicesInContainerOrder's doc comment). Meshes already in a combined
 *  group are left out — ungroup first if you want to regroup one differently. */
function openCombineSelectionPanel(): void {
    if (!loadedContainer || pickableMeshes.length < 2) {
        setStatus("Load a model with at least two meshes to combine.", true);
        return;
    }
    const groupedNodeIndices = new Set(combinedGroups.flatMap((g) => g.memberNodeIndices));
    const seen = new Set<number>();
    combineSelectList.replaceChildren();
    pickableMeshes.forEach((mesh, i) => {
        const nodeIndex = currentMeshRefs[i]?.nodeIndex;
        if (nodeIndex === undefined || seen.has(nodeIndex) || groupedNodeIndices.has(nodeIndex)) {
            return;
        }
        seen.add(nodeIndex);
        const row = document.createElement("label");
        row.className = "merge-select-row";
        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.dataset.nodeIndex = String(nodeIndex);
        const nameSpan = document.createElement("span");
        nameSpan.textContent = mesh.name || `mesh ${i}`;
        row.append(checkbox, nameSpan);
        combineSelectList.appendChild(row);
    });
    combineSelectName.value = "";
    combineSelectPanel.classList.remove("hidden");
    setStatus('Choose at least two meshes to combine into one group, give it a name, then click "Combine".');
}
combineButton.addEventListener("click", openCombineSelectionPanel);
combineSelectConfirm.addEventListener("click", () => {
    const selectedNodeIndices = [...combineSelectList.querySelectorAll("input[type=checkbox]")]
        .filter((cb) => (cb as HTMLInputElement).checked)
        .map((cb) => Number((cb as HTMLInputElement).dataset.nodeIndex));
    if (selectedNodeIndices.length < 2) {
        setStatus("Select at least two meshes to combine.", true);
        return;
    }
    const label = combineSelectName.value.trim() || `Combined (${selectedNodeIndices.length} meshes)`;
    combineSelectPanel.classList.add("hidden");
    combineSelectedNodes(selectedNodeIndices, label);
});
combineSelectCancel.addEventListener("click", () => combineSelectPanel.classList.add("hidden"));

// ─── Merged-mesh alignment ──────────────────────────────────────────────
// After a selective merge, the newly-added meshes land at their SOURCE file's own
// world placement (see mergeSelectedMeshesIntoContainer) — which only lines up with
// the base model when both files share a common origin/scale/orientation. When they
// don't, the user needs to manually move/rotate/scale the merged group into place.
// We do this by temporarily reparenting the merged group's nodes under a throwaway
// wrapper TransformNode (preserving their current world position — no visual jump),
// attaching a Move/Rotate/Scale gizmo to the WRAPPER so the whole group drags as one
// rigid unit, then on "Done" reparenting each node back out from under the wrapper —
// which bakes the adjustment into each node's local matrix — and writing that matrix
// into the export JSON.

function disposeAlignGizmos(): void {
    if (alignUtilityLayer) {
        if (alignPositionGizmo) {
            disposePositionGizmo(alignPositionGizmo, alignUtilityLayer);
        }
        if (alignRotationGizmo) {
            disposeRotationGizmo(alignRotationGizmo, alignUtilityLayer);
        }
        if (alignScaleGizmo) {
            disposeScaleGizmo(alignScaleGizmo, alignUtilityLayer);
        }
        disposeUtilityLayer(alignUtilityLayer);
    }
    alignUtilityLayer = null;
    alignPositionGizmo = null;
    alignRotationGizmo = null;
    alignScaleGizmo = null;
}

/** Attach the gizmo for the current alignMode to `node` (or detach all three when
 *  `node` is null), so only one gizmo is ever visible/draggable at a time. */
function applyAlignGizmoAttachment(node: SceneNode | null): void {
    if (alignPositionGizmo) {
        attachPositionGizmoToNode(alignPositionGizmo, node && alignMode === "move" ? node : null);
    }
    if (alignRotationGizmo) {
        attachRotationGizmoToNode(alignRotationGizmo, node && alignMode === "rotate" ? node : null);
    }
    if (alignScaleGizmo) {
        attachScaleGizmoToNode(alignScaleGizmo, node && alignMode === "scale" ? node : null);
    }
}

function setAlignMode(mode: AlignMode): void {
    alignMode = mode;
    applyAlignGizmoAttachment(alignWrapper);
    for (const [button, m] of [
        [alignModeMoveButton, "move"],
        [alignModeRotateButton, "rotate"],
        [alignModeScaleButton, "scale"],
    ] as const) {
        button.classList.toggle("active", m === mode);
    }
}

/** Begin (or resume) an alignment session for `group`: wraps its nodes in a fresh
 *  TransformNode and attaches the current-mode gizmo to that wrapper. Auto-commits
 *  any other group that's mid-alignment first, so only one group is ever being
 *  edited at once. */
function startAligning(group: MergeGroup): void {
    if (activeAlignGroup && activeAlignGroup !== group) {
        commitAlignment(activeAlignGroup);
    }
    if (activeAlignGroup === group && alignWrapper) {
        alignToolbar.classList.remove("hidden");
        renderAlignGroupsPanel();
        return;
    }
    if (!sceneRootNode) {
        return;
    }
    const wrapper = createTransformNode(`align-wrapper-${group.id}`);
    setParent(wrapper, sceneRootNode);
    for (const node of group.nodes) {
        setParent(node, wrapper);
    }
    alignWrapper = wrapper;
    activeAlignGroup = group;
    alignMode = "move";
    applyAlignGizmoAttachment(wrapper);
    alignToolbarLabel.textContent = group.label;
    alignModeMoveButton.classList.add("active");
    alignModeRotateButton.classList.remove("active");
    alignModeScaleButton.classList.remove("active");
    alignToolbar.classList.remove("hidden");
    renderAlignGroupsPanel();
}

/** Undo the current wrapper adjustment (move/rotate/scale back to identity), without
 *  ending the alignment session — the group stays wrapped and gizmo-editable. */
function resetAlignment(): void {
    if (!alignWrapper) {
        return;
    }
    alignWrapper.position.set(0, 0, 0);
    alignWrapper.rotationQuaternion.set(0, 0, 0, 1);
    alignWrapper.scaling.set(1, 1, 1);
}

/** Bake the group's current wrapper-adjusted world placement back into each node's
 *  local matrix (relative to the scene root, matching glTF's top-level-node
 *  convention) and write it into the export JSON, then discard the wrapper. */
function commitAlignment(group: MergeGroup): void {
    if (activeAlignGroup !== group || !alignWrapper || !sceneRootNode || !loadedContainer) {
        return;
    }
    const nodes = loadedContainer.json.nodes ?? [];
    for (let i = 0; i < group.nodes.length; i++) {
        const node = group.nodes[i]!;
        const nodeIndex = group.nodeIndices[i]!;
        setParent(node, sceneRootNode);
        const localMatrix = node._localMatrix;
        const jsonNode = nodes[nodeIndex];
        if (localMatrix && jsonNode) {
            jsonNode.matrix = Array.from({ length: 16 }, (_, k) => localMatrix[k]);
            delete jsonNode.translation;
            delete jsonNode.rotation;
            delete jsonNode.scale;
        }
    }
    setParent(alignWrapper, null);
    applyAlignGizmoAttachment(null);
    alignWrapper = null;
    activeAlignGroup = null;
    alignToolbar.classList.add("hidden");
    renderAlignGroupsPanel();
}

function renderAlignGroupsPanel(): void {
    if (mergeGroups.length === 0) {
        alignGroupsPanel.classList.add("hidden");
        alignGroupsList.replaceChildren();
        return;
    }
    alignGroupsPanel.classList.remove("hidden");
    alignGroupsList.replaceChildren();
    for (const group of mergeGroups) {
        const row = document.createElement("div");
        row.className = "align-group-row";
        const label = document.createElement("span");
        label.textContent = `${group.label} (${group.nodes.length} mesh${group.nodes.length === 1 ? "" : "es"})`;
        const button = document.createElement("button");
        const isActive = activeAlignGroup === group;
        button.textContent = isActive ? "Aligning…" : "Align";
        button.classList.toggle("active", isActive);
        button.addEventListener("click", () => startAligning(group));
        row.append(label, button);
        alignGroupsList.appendChild(row);
    }
}

alignModeMoveButton.addEventListener("click", () => setAlignMode("move"));
alignModeRotateButton.addEventListener("click", () => setAlignMode("rotate"));
alignModeScaleButton.addEventListener("click", () => setAlignMode("scale"));
alignResetButton.addEventListener("click", resetAlignment);
alignDoneButton.addEventListener("click", () => {
    if (activeAlignGroup) {
        commitAlignment(activeAlignGroup);
    }
});

async function loadModel(file: File): Promise<void> {
    setStatus(`Loading "${file.name}"…`);
    try {
        const data = await file.arrayBuffer();
        await loadModelFromBuffer(data, file.name);
    } catch (err) {
        setStatus(`Failed to load "${file.name}": ${(err as Error).message}`, true);
        console.error(err);
    }
}

/** State for the "pick which meshes to merge in" panel — set when a merge file has been
 *  parsed and is awaiting the user's mesh selection, cleared on confirm/cancel. */
let pendingMergeParsed: ParsedGltfContainer | null = null;
let pendingMergeFileName: string | null = null;

/** Parse a newly-picked merge file and show the mesh-selection panel, rather than
 *  merging the whole file in blindly — a full-body source model can be far heavier
 *  than the handful of meshes actually needed (e.g. just a pair of organ meshes), so
 *  letting the user pick exactly which meshes to bring in keeps the merge cheap and
 *  avoids pulling in a duplicate skeleton/muscle set. */
async function openMergeSelectionPanel(file: File): Promise<void> {
    if (!loadedContainer) {
        setStatus("Load a model first, then use \"+ Merge In Another Model\" to combine a second one in.", true);
        return;
    }
    setStatus(`Reading "${file.name}"…`);
    try {
        const data = await file.arrayBuffer();
        const parsed = parseGltfContainer(data);
        const entries = listSelectableMeshes(parsed);
        if (entries.length === 0) {
            setStatus(`"${file.name}" has no meshes placed in its scene to merge in.`, true);
            return;
        }
        pendingMergeParsed = parsed;
        pendingMergeFileName = file.name;
        mergeSelectHint.textContent = `From "${file.name}" — only the meshes you check are merged in, so you can bring in just the parts you need (e.g. a pair of organ meshes) without the rest of the file.`;
        mergeSelectList.replaceChildren();
        for (const entry of entries) {
            const row = document.createElement("label");
            row.className = "merge-select-row";
            const checkbox = document.createElement("input");
            checkbox.type = "checkbox";
            checkbox.dataset.meshIndex = String(entry.meshIndex);
            const nameSpan = document.createElement("span");
            nameSpan.textContent = entry.name;
            row.append(checkbox, nameSpan);
            if (entry.instanceCount > 1) {
                const countSpan = document.createElement("span");
                countSpan.className = "instance-count";
                countSpan.textContent = `×${entry.instanceCount}`;
                row.appendChild(countSpan);
            }
            mergeSelectList.appendChild(row);
        }
        mergeSelectPanel.classList.remove("hidden");
        setStatus(`Choose which meshes from "${file.name}" to merge in, then click "Merge Selected".`);
    } catch (err) {
        setStatus(`Failed to read "${file.name}": ${(err as Error).message}`, true);
        console.error(err);
    }
}

/** Merge only the checked meshes from the pending merge file into the currently loaded
 *  model. Pending deletions/renames/opacity/color edits already made on the current
 *  model are baked into its JSON first (the same "apply deletions before serializing"
 *  step used by exportModel), so they aren't lost in the merge. */
async function mergeSelectedMeshes(selectedMeshIndices: number[]): Promise<void> {
    if (!loadedContainer || !pendingMergeParsed || !pendingMergeFileName) {
        return;
    }
    const parsedB = pendingMergeParsed;
    const sourceFileName = pendingMergeFileName;
    pendingMergeParsed = null;
    pendingMergeFileName = null;
    setStatus(`Merging ${selectedMeshIndices.length} mesh(es) from "${sourceFileName}"…`);
    try {
        applyPrimitiveDeletions(loadedContainer.json, deletedPrimitiveKeys);
        deletedPrimitiveKeys = new Set();

        const sourceLabel = sourceFileName.replace(/\.(glb|gltf)$/i, "");
        // Count primitives per newly-merged top-level node (one source node can carry a
        // multi-primitive mesh) BEFORE merging, in the same source-node-array order the
        // merge itself uses — this lets us slice the exact tail of the reloaded
        // pickableMeshes array back into per-node groups for the alignment feature,
        // without needing any node-index map from the loader (see custom-model-viewer.ts
        // top-of-file comment on MergeGroup).
        const selectedSet = new Set(selectedMeshIndices);
        const sourceNodes = parsedB.json.nodes ?? [];
        const sourceMeshes = parsedB.json.meshes ?? [];
        const primitiveCounts: number[] = [];
        for (const node of sourceNodes) {
            if (node?.mesh !== undefined && selectedSet.has(node.mesh)) {
                primitiveCounts.push(sourceMeshes[node.mesh]?.primitives?.length ?? 1);
            }
        }

        const merged = mergeSelectedMeshesIntoContainer(loadedContainer, parsedB, selectedMeshIndices, sourceLabel);
        const blob = serializeGlb(merged.container.json, merged.container.binChunk ?? new Uint8Array(0));
        const mergedBuffer = await blob.arrayBuffer();
        await loadModelFromBuffer(mergedBuffer, originalFileName, { nodeIndices: merged.newNodeIndices, primitiveCounts, label: sourceLabel });
    } catch (err) {
        setStatus(`Failed to merge: ${(err as Error).message}`, true);
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

mergeButton.addEventListener("click", () => mergeFileInput.click());
mergeFileInput.addEventListener("change", () => {
    const file = mergeFileInput.files?.[0];
    mergeFileInput.value = "";
    if (file) {
        void openMergeSelectionPanel(file);
    }
});
mergeSelectConfirm.addEventListener("click", () => {
    const selected = [...mergeSelectList.querySelectorAll("input[type=checkbox]")]
        .filter((cb) => (cb as HTMLInputElement).checked)
        .map((cb) => Number((cb as HTMLInputElement).dataset.meshIndex));
    if (selected.length === 0) {
        setStatus("Select at least one mesh to merge in.", true);
        return;
    }
    mergeSelectPanel.classList.add("hidden");
    void mergeSelectedMeshes(selected);
});
mergeSelectCancel.addEventListener("click", () => {
    mergeSelectPanel.classList.add("hidden");
    pendingMergeParsed = null;
    pendingMergeFileName = null;
    setStatus("Merge cancelled.");
});

// Mark the loader overlay ready immediately — there is no model to wait for until the user picks one.
Object.assign(canvas.dataset, { ready: true });
enginePromise
    .then(() => setStatus("Drop a .glb/.gltf file here, or click to browse."))
    .catch((err) => setStatus(`WebGPU unavailable: ${(err as Error).message}`, true));
