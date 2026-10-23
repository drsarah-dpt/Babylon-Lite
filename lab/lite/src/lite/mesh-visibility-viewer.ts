/** Dual mesh-visibility viewer — two independent GLB/glTF viewports side by side,
 *  each with only an on/off checkbox per mesh (no rename/color/opacity/delete/
 *  locate/export, unlike the full custom-model-viewer). Both viewports share a
 *  single WebGPU engine/device: panel A renders through the engine's primary
 *  surface, panel B through a second surface created via createSurface(). Each
 *  panel owns a fully independent SceneContext (its own meshes/camera/lights),
 *  so loading or swapping a model in one panel never affects the other's scene
 *  content — only the shared stop/start of the single render loop (required by
 *  the engine for safe scene teardown) can cause a brief shared-frame pause. */

import {
    addToScene,
    startEngine,
    stopEngine,
    createEngine,
    createSurface,
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
    type EngineContext,
    type SurfaceContext,
    type SceneContext,
    type Mesh,
} from "babylon-lite";

interface PanelElements {
    canvas: HTMLCanvasElement;
    dropZone: HTMLElement;
    fileInput: HTMLInputElement;
    statusEl: HTMLElement;
    layersPanel: HTMLElement;
    layersList: HTMLElement;
}

interface Panel extends PanelElements {
    id: "A" | "B";
    getSurface: () => Promise<SurfaceContext>;
    scene: SceneContext | null;
}

function queryPanelElements(suffix: "a" | "b"): PanelElements {
    return {
        canvas: document.getElementById(suffix === "a" ? "renderCanvas" : "renderCanvasB") as HTMLCanvasElement,
        dropZone: document.getElementById(`drop-zone-${suffix}`)!,
        fileInput: document.getElementById(`file-input-${suffix}`) as HTMLInputElement,
        statusEl: document.getElementById(`status-${suffix}`)!,
        layersPanel: document.getElementById(`layers-panel-${suffix}`)!,
        layersList: document.getElementById(`layers-list-${suffix}`)!,
    };
}

/** Acquire the shared engine as early as possible (page load, not on first user
 *  interaction) — same rationale as custom-model-viewer.ts: a canvas can only ever
 *  bind one context type for its lifetime. Panel B's auxiliary surface can only be
 *  created once the engine (and thus its GPU device) exists, so it is built inside
 *  this same promise chain. */
const canvasA = document.getElementById("renderCanvas") as HTMLCanvasElement;
const canvasB = document.getElementById("renderCanvasB") as HTMLCanvasElement;
const enginePromise: Promise<EngineContext> = createEngine(canvasA);
let engine: EngineContext | null = null;
let surfaceB: SurfaceContext | null = null;
// Tracks whether startEngine() has ever been called on the shared engine. Both panels'
// (re)loads must stopEngine() before building a new scene if it's already running —
// mirrors custom-model-viewer.ts's single-scene teardown pattern, just gated on the
// whole engine instead of one panel, since the render loop is shared across surfaces.
let engineStarted = false;
const surfaceBPromise: Promise<SurfaceContext> = enginePromise.then((eng) => {
    engine = eng;
    surfaceB = createSurface(eng, canvasB);
    return surfaceB;
});

function setStatus(panel: Panel, text: string, isError = false): void {
    panel.statusEl.textContent = text;
    panel.statusEl.style.color = isError ? "#f85149" : "#8b949e";
}

function isModelFile(file: File): boolean {
    return /\.(glb|gltf)$/i.test(file.name);
}

/** Build the visibility-only checklist: one row per mesh with a checkbox and its
 *  name (read-only text, not editable — this viewer never writes back to the
 *  source file). A duplicate-name badge is shown for a quick sanity check when a
 *  model reuses the same mesh name on multiple primitives. */
function buildLayersList(panel: Panel, meshes: Mesh[]): void {
    panel.layersList.replaceChildren();
    if (meshes.length === 0) {
        panel.layersPanel.classList.add("hidden");
        return;
    }
    panel.layersPanel.classList.remove("hidden");

    const seenNames = new Map<string, number>();
    for (const mesh of meshes) {
        const baseName = mesh.name || "mesh";
        seenNames.set(baseName, (seenNames.get(baseName) ?? 0) + 1);
    }
    const seenSoFar = new Map<string, number>();

    meshes.forEach((mesh, i) => {
        const baseName = mesh.name || `mesh ${i}`;
        const occurrence = (seenSoFar.get(baseName) ?? 0) + 1;
        seenSoFar.set(baseName, occurrence);

        const row = document.createElement("div");
        row.className = "layer-row";

        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.checked = mesh.visible !== false;
        checkbox.addEventListener("change", () => setMeshVisible(mesh, checkbox.checked));

        const nameEl = document.createElement("span");
        nameEl.className = "layer-row-name";
        nameEl.textContent = baseName;
        nameEl.title = baseName;

        row.append(checkbox, nameEl);

        const total = seenNames.get(baseName) ?? 1;
        if (total > 1) {
            const badge = document.createElement("span");
            badge.className = "layer-dup-badge";
            badge.textContent = `#${occurrence}`;
            row.append(badge);
        }

        panel.layersList.append(row);
    });
}

async function loadModel(panel: Panel, file: File): Promise<void> {
    setStatus(panel, `Loading "${file.name}"…`);
    try {
        const data = await file.arrayBuffer();
        const surface = await panel.getSurface();
        const eng = engine;
        if (!eng) {
            throw new Error("Engine not ready");
        }

        // Stopping/restarting the shared engine pauses BOTH panels' rendering for a
        // frame — required for safe scene teardown before building a new one. The
        // other panel's scene content (meshes/camera/visibility) is untouched; only
        // the render loop briefly halts and resumes.
        if (engineStarted) {
            stopEngine(eng);
        }
        if (panel.scene) {
            unregisterScene(panel.scene);
            disposeScene(panel.scene);
            panel.scene = null;
        }

        const scene = createSceneContext(surface);
        const container = await loadGltf(eng, data);
        addToScene(scene, container);
        addToScene(scene, createHemisphericLight());

        const cam = createDefaultCamera(scene);
        attachControl(cam, panel.canvas, scene);

        await registerScene(scene);
        await startEngine(eng);
        engineStarted = true;
        panel.scene = scene;

        buildLayersList(panel, getContainerMeshes(container));

        Object.assign(panel.canvas.dataset, { ready: true });
        panel.dropZone.classList.add("hidden");
        setStatus(panel, `Loaded "${file.name}". Drop another file to replace it.`);
        panel.dropZone.classList.remove("hidden");
    } catch (err) {
        setStatus(panel, `Failed to load "${file.name}": ${(err as Error).message}`, true);
        console.error(err);
    }
}

function wirePanel(suffix: "a" | "b", id: "A" | "B", getSurface: () => Promise<SurfaceContext>): Panel {
    const elements = queryPanelElements(suffix);
    const panel: Panel = { ...elements, id, getSurface, scene: null };

    panel.dropZone.addEventListener("dragover", (e) => {
        e.preventDefault();
        panel.dropZone.classList.add("drag-over");
    });
    panel.dropZone.addEventListener("dragleave", () => panel.dropZone.classList.remove("drag-over"));
    panel.dropZone.addEventListener("drop", (e) => {
        e.preventDefault();
        panel.dropZone.classList.remove("drag-over");
        const file = e.dataTransfer?.files?.[0];
        if (file && isModelFile(file)) {
            void loadModel(panel, file);
        } else if (file) {
            setStatus(panel, `Unsupported file "${file.name}" — expected .glb or .gltf`, true);
        }
    });
    panel.dropZone.addEventListener("click", () => panel.fileInput.click());
    panel.fileInput.addEventListener("change", () => {
        const file = panel.fileInput.files?.[0];
        if (file) {
            void loadModel(panel, file);
        }
    });

    return panel;
}

const panelA = wirePanel("a", "A", () => enginePromise);
const panelB = wirePanel("b", "B", () => surfaceBPromise);

Object.assign(canvasA.dataset, { ready: true });
enginePromise
    .then(() => setStatus(panelA, "Drop a .glb/.gltf file here, or click to browse."))
    .catch((err) => setStatus(panelA, `WebGPU unavailable: ${(err as Error).message}`, true));
surfaceBPromise
    .then(() => setStatus(panelB, "Drop a .glb/.gltf file here, or click to browse."))
    .catch((err) => setStatus(panelB, `WebGPU unavailable: ${(err as Error).message}`, true));
