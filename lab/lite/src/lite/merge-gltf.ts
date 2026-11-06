/** Merge two parsed glTF/GLB containers into a single combined document — used by the
 *  "Merge Model" feature in custom-model-viewer.ts to combine two separately-loaded
 *  files into one model with one unified mesh list (so every mesh, from either source
 *  file, gets a single on/off visibility toggle and can be exported as one .glb).
 *
 *  Scope / limitations (kept deliberately narrow — this is lab tooling, not a general
 *  glTF merge library):
 *  - Each input must have exactly one buffer (the common case for any GLB exported by
 *    a standard tool — Blender, the Babylon.js exporter, etc. all emit a single
 *    implicit buffer embedded in the GLB's BIN chunk, or a self-contained data: URI
 *    for a plain .gltf). Multiple/external buffer files are rejected with a clear
 *    error rather than silently producing a broken merge.
 *  - Only the default scene (json.scene ?? 0) of each file is carried into the merged
 *    document's single output scene; any other scenes defined in either file are
 *    dropped (vanishingly rare in practice — most exporters emit exactly one scene).
 *  - Annotations (babylon-lite's custom extras) are NOT merged — only whichever
 *    container is passed as `a` keeps its extras; callers that need both models'
 *    annotations preserved should bake them into `a` before merging.
 *
 *  The merge always produces a binary (.glb) result, regardless of whether either
 *  input was a plain .gltf, since the combined binary data needs single-buffer
 *  packing and a GLB's BIN chunk is the simplest self-contained place for that. */

import type { ParsedGltfContainer } from "./gltf-container-io.js";

/** Read a container's single buffer's raw bytes, decoding a data: URI (plain .gltf with an
 *  inline base64 buffer) if present. Throws with a clear, actionable message for anything
 *  this merge doesn't support (multiple buffers, or a buffer backed by an external file). */
function getSingleBufferBytes(container: ParsedGltfContainer, label: string): Uint8Array {
    const buffers: any[] = container.json.buffers ?? [];
    if (buffers.length === 0) {
        return new Uint8Array(0);
    }
    if (buffers.length > 1) {
        throw new Error(`Merge only supports a model with a single buffer; "${label}" has ${buffers.length}.`);
    }
    const buffer = buffers[0];
    if (buffer.uri === undefined) {
        if (!container.binChunk) {
            throw new Error(`"${label}" is missing its embedded binary chunk.`);
        }
        return container.binChunk;
    }
    if (buffer.uri.startsWith("data:")) {
        const base64 = buffer.uri.slice(buffer.uri.indexOf(",") + 1);
        const binary = atob(base64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
            bytes[i] = binary.charCodeAt(i);
        }
        return bytes;
    }
    throw new Error(`Merge does not support an external buffer file ("${label}" references "${buffer.uri}"). Use a self-contained .glb instead.`);
}

/** Pad a byte length up to the next multiple of 4 — used so the second file's byte range
 *  starts on a 4-byte boundary within the combined buffer, preserving every bufferView's
 *  original internal alignment relative to its own file's buffer start. */
function padTo4(length: number): number {
    return (length + 3) & ~3;
}

/** Deep-walk a material (or any nested value under json.materials[]) and add `base` to every
 *  `index` field found on a plain object — this is exactly glTF's textureInfo shape
 *  (`{ index, texCoord? }`), used by baseColorTexture/normalTexture/emissiveTexture/etc. AND
 *  by every KHR_materials_* extension's own texture references (clearcoatTexture,
 *  sheenColorTexture, transmissionTexture, ...). Scoping this walk to the materials subtree
 *  only (never called on the whole document) makes the heuristic safe: nothing else in a
 *  glTF material definition uses an "index" key for anything other than a texture reference. */
function remapMaterialTextureIndices(node: unknown, base: number): any {
    if (Array.isArray(node)) {
        return node.map((item) => remapMaterialTextureIndices(item, base));
    }
    if (node && typeof node === "object") {
        const out: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
            out[key] = remapMaterialTextureIndices(value, base);
        }
        if (typeof out.index === "number") {
            out.index = out.index + base;
        }
        return out;
    }
    return node;
}

function remapAttributes(attrs: Record<string, number> | undefined, accessorBase: number): Record<string, number> | undefined {
    if (!attrs) {
        return attrs;
    }
    const out: Record<string, number> = {};
    for (const [key, value] of Object.entries(attrs)) {
        out[key] = value + accessorBase;
    }
    return out;
}

/** Merge two parsed glTF containers into one combined document. `a`'s index space is kept
 *  untouched (so edits already baked into `a.json`, e.g. renames/opacity/color, survive
 *  unchanged); everything from `b` is appended with every cross-reference (accessor,
 *  bufferView, material, texture, image, sampler, mesh, node, skin, camera, light, animation)
 *  shifted by `a`'s corresponding array length. */
export function mergeGltfContainers(a: ParsedGltfContainer, b: ParsedGltfContainer, labelA = "model A", labelB = "model B"): ParsedGltfContainer {
    const aBytes = getSingleBufferBytes(a, labelA);
    const bBytes = getSingleBufferBytes(b, labelB);
    const aBytesPaddedLength = padTo4(aBytes.length);
    const combinedBin = new Uint8Array(aBytesPaddedLength + bBytes.length);
    combinedBin.set(aBytes, 0);
    combinedBin.set(bBytes, aBytesPaddedLength);
    const byteOffsetAddForB = aBytesPaddedLength;

    const aJson = a.json;
    const bJson = b.json;

    const bufferViewIndexBaseForB = (aJson.bufferViews ?? []).length;
    const accessorIndexBaseForB = (aJson.accessors ?? []).length;
    const imageIndexBaseForB = (aJson.images ?? []).length;
    const samplerIndexBaseForB = (aJson.samplers ?? []).length;
    const textureIndexBaseForB = (aJson.textures ?? []).length;
    const materialIndexBaseForB = (aJson.materials ?? []).length;
    const meshIndexBaseForB = (aJson.meshes ?? []).length;
    const cameraIndexBaseForB = (aJson.cameras ?? []).length;
    const skinIndexBaseForB = (aJson.skins ?? []).length;
    const nodeIndexBaseForB = (aJson.nodes ?? []).length;
    const lightIndexBaseForB = (aJson.extensions?.KHR_lights_punctual?.lights ?? []).length;

    const remapBufferView = (bv: any, byteOffsetAdd: number) => ({ ...bv, buffer: 0, byteOffset: (bv.byteOffset ?? 0) + byteOffsetAdd });
    const mergedBufferViews = [...(aJson.bufferViews ?? []).map((bv: any) => remapBufferView(bv, 0)), ...(bJson.bufferViews ?? []).map((bv: any) => remapBufferView(bv, byteOffsetAddForB))];

    const remapAccessor = (acc: any, bufferViewAdd: number) => {
        const out = { ...acc };
        if (out.bufferView !== undefined) {
            out.bufferView += bufferViewAdd;
        }
        if (out.sparse) {
            out.sparse = {
                ...out.sparse,
                indices: { ...out.sparse.indices, bufferView: out.sparse.indices.bufferView + bufferViewAdd },
                values: { ...out.sparse.values, bufferView: out.sparse.values.bufferView + bufferViewAdd },
            };
        }
        return out;
    };
    const mergedAccessors = [...(aJson.accessors ?? []).map((acc: any) => remapAccessor(acc, 0)), ...(bJson.accessors ?? []).map((acc: any) => remapAccessor(acc, bufferViewIndexBaseForB))];

    const remapImage = (img: any, bufferViewAdd: number) => (img.bufferView !== undefined ? { ...img, bufferView: img.bufferView + bufferViewAdd } : img);
    const mergedImages = [...(aJson.images ?? []).map((img: any) => remapImage(img, 0)), ...(bJson.images ?? []).map((img: any) => remapImage(img, bufferViewIndexBaseForB))];

    const mergedSamplers = [...(aJson.samplers ?? []), ...(bJson.samplers ?? [])];

    const remapTexture = (tex: any, samplerAdd: number, imageAdd: number) => {
        const out = { ...tex };
        if (out.sampler !== undefined) {
            out.sampler += samplerAdd;
        }
        if (out.source !== undefined) {
            out.source += imageAdd;
        }
        if (out.extensions?.KHR_texture_basisu?.source !== undefined) {
            out.extensions = { ...out.extensions, KHR_texture_basisu: { ...out.extensions.KHR_texture_basisu, source: out.extensions.KHR_texture_basisu.source + imageAdd } };
        }
        return out;
    };
    const mergedTextures = [...(aJson.textures ?? []).map((t: any) => remapTexture(t, 0, 0)), ...(bJson.textures ?? []).map((t: any) => remapTexture(t, samplerIndexBaseForB, imageIndexBaseForB))];

    const mergedMaterials = [...(aJson.materials ?? []), ...(bJson.materials ?? []).map((m: any) => remapMaterialTextureIndices(m, textureIndexBaseForB))];

    const remapPrimitive = (prim: any, accessorAdd: number, materialAdd: number) => {
        const out = { ...prim, attributes: remapAttributes(prim.attributes, accessorAdd) };
        if (out.indices !== undefined) {
            out.indices += accessorAdd;
        }
        if (out.material !== undefined) {
            out.material += materialAdd;
        }
        if (out.targets) {
            out.targets = out.targets.map((t: Record<string, number>) => remapAttributes(t, accessorAdd));
        }
        return out;
    };
    const remapMesh = (mesh: any, accessorAdd: number, materialAdd: number) => ({ ...mesh, primitives: (mesh.primitives ?? []).map((p: any) => remapPrimitive(p, accessorAdd, materialAdd)) });
    const mergedMeshes = [...(aJson.meshes ?? []).map((m: any) => remapMesh(m, 0, 0)), ...(bJson.meshes ?? []).map((m: any) => remapMesh(m, accessorIndexBaseForB, materialIndexBaseForB))];

    const mergedCameras = [...(aJson.cameras ?? []), ...(bJson.cameras ?? [])];

    const remapSkin = (skin: any, accessorAdd: number, nodeAdd: number) => {
        const out = { ...skin };
        if (out.inverseBindMatrices !== undefined) {
            out.inverseBindMatrices += accessorAdd;
        }
        if (out.skeleton !== undefined) {
            out.skeleton += nodeAdd;
        }
        if (out.joints) {
            out.joints = out.joints.map((j: number) => j + nodeAdd);
        }
        return out;
    };
    const mergedSkins = [...(aJson.skins ?? []).map((s: any) => remapSkin(s, 0, 0)), ...(bJson.skins ?? []).map((s: any) => remapSkin(s, accessorIndexBaseForB, nodeIndexBaseForB))];

    const aLights = aJson.extensions?.KHR_lights_punctual?.lights ?? [];
    const bLights = bJson.extensions?.KHR_lights_punctual?.lights ?? [];
    const mergedLights = [...aLights, ...bLights];

    const remapNode = (node: any, add: { meshAdd: number; skinAdd: number; cameraAdd: number; nodeAdd: number; lightAdd: number }) => {
        const out = { ...node };
        if (out.mesh !== undefined) {
            out.mesh += add.meshAdd;
        }
        if (out.skin !== undefined) {
            out.skin += add.skinAdd;
        }
        if (out.camera !== undefined) {
            out.camera += add.cameraAdd;
        }
        if (out.children) {
            out.children = out.children.map((c: number) => c + add.nodeAdd);
        }
        if (out.extensions?.KHR_lights_punctual?.light !== undefined) {
            out.extensions = { ...out.extensions, KHR_lights_punctual: { ...out.extensions.KHR_lights_punctual, light: out.extensions.KHR_lights_punctual.light + add.lightAdd } };
        }
        return out;
    };
    const mergedNodes = [
        ...(aJson.nodes ?? []).map((n: any) => remapNode(n, { meshAdd: 0, skinAdd: 0, cameraAdd: 0, nodeAdd: 0, lightAdd: 0 })),
        ...(bJson.nodes ?? []).map((n: any) =>
            remapNode(n, { meshAdd: meshIndexBaseForB, skinAdd: skinIndexBaseForB, cameraAdd: cameraIndexBaseForB, nodeAdd: nodeIndexBaseForB, lightAdd: lightIndexBaseForB }),
        ),
    ];

    const remapAnimation = (anim: any, accessorAdd: number, nodeAdd: number) => ({
        ...anim,
        channels: (anim.channels ?? []).map((ch: any) => ({ ...ch, target: ch.target?.node !== undefined ? { ...ch.target, node: ch.target.node + nodeAdd } : ch.target })),
        samplers: (anim.samplers ?? []).map((s: any) => ({ ...s, input: s.input + accessorAdd, output: s.output + accessorAdd })),
    });
    const mergedAnimations = [...(aJson.animations ?? []).map((an: any) => remapAnimation(an, 0, 0)), ...(bJson.animations ?? []).map((an: any) => remapAnimation(an, accessorIndexBaseForB, nodeIndexBaseForB))];

    const aRoots: number[] = aJson.scenes?.[aJson.scene ?? 0]?.nodes ?? [];
    const bRoots: number[] = (bJson.scenes?.[bJson.scene ?? 0]?.nodes ?? []).map((n: number) => n + nodeIndexBaseForB);

    const extensionsUsed = Array.from(new Set([...(aJson.extensionsUsed ?? []), ...(bJson.extensionsUsed ?? [])]));
    const extensionsRequired = Array.from(new Set([...(aJson.extensionsRequired ?? []), ...(bJson.extensionsRequired ?? [])]));

    const mergedJson: any = {
        asset: { version: "2.0", generator: "Babylon-Lite merge tool" },
        scene: 0,
        scenes: [{ name: "Merged Scene", nodes: [...aRoots, ...bRoots] }],
        nodes: mergedNodes,
        meshes: mergedMeshes,
        materials: mergedMaterials,
        textures: mergedTextures,
        samplers: mergedSamplers,
        images: mergedImages,
        accessors: mergedAccessors,
        bufferViews: mergedBufferViews,
        buffers: [{ byteLength: combinedBin.length }],
        extras: aJson.extras,
    };
    if (mergedCameras.length > 0) {
        mergedJson.cameras = mergedCameras;
    }
    if (mergedSkins.length > 0) {
        mergedJson.skins = mergedSkins;
    }
    if (mergedAnimations.length > 0) {
        mergedJson.animations = mergedAnimations;
    }
    if (mergedLights.length > 0) {
        mergedJson.extensions = { ...mergedJson.extensions, KHR_lights_punctual: { lights: mergedLights } };
    }
    if (extensionsUsed.length > 0) {
        mergedJson.extensionsUsed = extensionsUsed;
    }
    if (extensionsRequired.length > 0) {
        mergedJson.extensionsRequired = extensionsRequired;
    }

    return { json: mergedJson, binChunk: combinedBin, isBinary: true };
}

/** One entry per mesh definition in a file, for a "pick which meshes to bring in"
 *  selection UI. `instanceCount` is how many nodes in the file's default scene place
 *  this mesh (almost always 1) — meshes with 0 instances aren't reachable from the
 *  scene root and are omitted, since there'd be nothing to extract a world transform for. */
export interface SelectableMeshEntry {
    meshIndex: number;
    name: string;
    instanceCount: number;
}

/** List every mesh in `container` that's actually placed somewhere in its default scene,
 *  for a mesh-selection checklist (e.g. "only bring in the two organ meshes, not the
 *  whole duplicate skeleton/muscle set"). */
export function listSelectableMeshes(container: ParsedGltfContainer): SelectableMeshEntry[] {
    const json = container.json;
    const nodes: any[] = json.nodes ?? [];
    const meshes: any[] = json.meshes ?? [];
    const instanceCounts = new Map<number, number>();
    const roots: number[] = json.scenes?.[json.scene ?? 0]?.nodes ?? [];
    const visited = new Set<number>();
    const visit = (nodeIndex: number): void => {
        if (visited.has(nodeIndex)) {
            return;
        }
        visited.add(nodeIndex);
        const node = nodes[nodeIndex];
        if (!node) {
            return;
        }
        if (node.mesh !== undefined) {
            instanceCounts.set(node.mesh, (instanceCounts.get(node.mesh) ?? 0) + 1);
        }
        for (const child of node.children ?? []) {
            visit(child);
        }
    };
    for (const root of roots) {
        visit(root);
    }
    const entries: SelectableMeshEntry[] = [];
    meshes.forEach((mesh, meshIndex) => {
        const instanceCount = instanceCounts.get(meshIndex) ?? 0;
        if (instanceCount > 0) {
            entries.push({ meshIndex, name: mesh.name || `mesh ${meshIndex}`, instanceCount });
        }
    });
    return entries;
}

/** Identity 4x4 (column-major, matching glTF's node.matrix convention). */
function mat4Identity(): number[] {
    return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}

/** Compose a node's local matrix from its TRS properties (or identity defaults), using the
 *  exact formula the glTF spec defines for node.translation/rotation/scale -> matrix. */
function mat4FromTRS(node: any): number[] {
    const [tx, ty, tz] = node.translation ?? [0, 0, 0];
    const [qx, qy, qz, qw] = node.rotation ?? [0, 0, 0, 1];
    const [sx, sy, sz] = node.scale ?? [1, 1, 1];
    return [
        (1 - 2 * qy * qy - 2 * qz * qz) * sx,
        (2 * qx * qy + 2 * qz * qw) * sx,
        (2 * qx * qz - 2 * qy * qw) * sx,
        0,
        (2 * qx * qy - 2 * qz * qw) * sy,
        (1 - 2 * qx * qx - 2 * qz * qz) * sy,
        (2 * qy * qz + 2 * qx * qw) * sy,
        0,
        (2 * qx * qz + 2 * qy * qw) * sz,
        (2 * qy * qz - 2 * qx * qw) * sz,
        (1 - 2 * qx * qx - 2 * qy * qy) * sz,
        0,
        tx,
        ty,
        tz,
        1,
    ];
}

/** Column-major 4x4 matrix multiply: returns a*b (b applied first, then a) — the standard
 *  "world = parentWorld * localMatrix" composition used to walk a glTF node hierarchy. */
function mat4Multiply(a: number[], b: number[]): number[] {
    const out = new Array(16).fill(0);
    for (let col = 0; col < 4; col++) {
        for (let row = 0; row < 4; row++) {
            let sum = 0;
            for (let k = 0; k < 4; k++) {
                sum += (a[k * 4 + row] ?? 0) * (b[col * 4 + k] ?? 0);
            }
            out[col * 4 + row] = sum;
        }
    }
    return out;
}

/** World matrix (column-major 16-number array) for every node reachable from `json`'s
 *  default scene, computed by walking the hierarchy from each root with an identity
 *  parent transform. */
function computeWorldMatrices(json: any): Map<number, number[]> {
    const nodes: any[] = json.nodes ?? [];
    const world = new Map<number, number[]>();
    const visit = (nodeIndex: number, parentWorld: number[]): void => {
        const node = nodes[nodeIndex];
        if (!node) {
            return;
        }
        const local = node.matrix ?? mat4FromTRS(node);
        const worldMatrix = mat4Multiply(parentWorld, local);
        world.set(nodeIndex, worldMatrix);
        for (const child of node.children ?? []) {
            visit(child, worldMatrix);
        }
    };
    const roots: number[] = json.scenes?.[json.scene ?? 0]?.nodes ?? [];
    for (const root of roots) {
        visit(root, mat4Identity());
    }
    return world;
}

/** Deep-walk collecting every numeric `index` field found under a material (or any nested
 *  value within it) — see remapMaterialTextureIndices' doc comment for why this is a safe
 *  heuristic scoped to a single material's own subtree. Used here just to find which
 *  texture indices a needed material depends on, before the main compacting pass. */
function collectTextureIndices(node: unknown, out: Set<number>): void {
    if (Array.isArray(node)) {
        for (const item of node) {
            collectTextureIndices(item, out);
        }
        return;
    }
    if (node && typeof node === "object") {
        for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
            if (key === "index" && typeof value === "number") {
                out.add(value);
            } else {
                collectTextureIndices(value, out);
            }
        }
    }
}

/** Result of {@link mergeSelectedMeshesIntoContainer} — the merged container plus the
 *  glTF node index of each newly-added top-level node (in the same order the matched
 *  meshes were found), so a caller can later re-locate and adjust each merged mesh's
 *  placement (see the "align merged meshes" flow in custom-model-viewer.ts). */
export interface SelectedMeshMergeResult {
    container: ParsedGltfContainer;
    newNodeIndices: number[];
}

/** Merge only specific meshes from `source` into `base` — e.g. just a pair of organ
 *  meshes rather than an entire duplicate body — instead of mergeGltfContainers' whole-file
 *  merge. This computes each selected mesh instance's *world* matrix within `source`'s own
 *  scene hierarchy and adds it to `base` as a single new top-level node (no parent chain
 *  carried over), so it lands in the same place it occupied in `source`'s own scene.
 *  Only the accessors/bufferViews/materials/textures/images/samplers actually used by the
 *  selected meshes are copied — unlike the whole-file merge, this does NOT bring in any
 *  of `source`'s other geometry, so merging in e.g. two small organ meshes stays cheap
 *  even when `source` itself is a huge full-body model.
 *
 *  Limitations: skins and morph targets on the selected meshes are not supported (their
 *  accessors/vertex data would need the whole skeleton/joint hierarchy to make sense) —
 *  pick a non-skinned, non-animated mesh, or use mergeGltfContainers for the whole file
 *  instead. Node-level extensions (e.g. KHR_lights_punctual) on the selected mesh's own
 *  node, and animations targeting it, are also not carried over. */
export function mergeSelectedMeshesIntoContainer(base: ParsedGltfContainer, source: ParsedGltfContainer, selectedMeshIndices: number[], sourceLabel = "model B"): SelectedMeshMergeResult {
    if (selectedMeshIndices.length === 0) {
        throw new Error("Select at least one mesh to merge in.");
    }
    const baseBytes = getSingleBufferBytes(base, "current model");
    const sourceBytes = getSingleBufferBytes(source, sourceLabel);
    const baseJson = base.json;
    const sourceJson = source.json;

    const selectedSet = new Set(selectedMeshIndices);
    const worldMatrices = computeWorldMatrices(sourceJson);
    const sourceNodes: any[] = sourceJson.nodes ?? [];
    const sourceMeshes: any[] = sourceJson.meshes ?? [];
    const sourceAccessors: any[] = sourceJson.accessors ?? [];
    const sourceBufferViews: any[] = sourceJson.bufferViews ?? [];
    const sourceMaterials: any[] = sourceJson.materials ?? [];
    const sourceTextures: any[] = sourceJson.textures ?? [];
    const sourceImages: any[] = sourceJson.images ?? [];
    const sourceSamplers: any[] = sourceJson.samplers ?? [];

    const matches: { nodeIndex: number; meshIndex: number; worldMatrix: number[] }[] = [];
    sourceNodes.forEach((node, nodeIndex) => {
        if (node?.mesh !== undefined && selectedSet.has(node.mesh)) {
            if (node.skin !== undefined) {
                throw new Error(`"${node.name ?? `node ${nodeIndex}`}" is a skinned mesh (rigged to a skeleton), so it can't be merged in by itself — uncheck it, or merge in that model's skeleton too.`);
            }
            matches.push({ nodeIndex, meshIndex: node.mesh, worldMatrix: worldMatrices.get(nodeIndex) ?? mat4Identity() });
        }
    });
    if (matches.length === 0) {
        throw new Error("None of the selected meshes are placed in this file's scene.");
    }

    const neededMeshIndices = Array.from(new Set(matches.map((m) => m.meshIndex)));
    const neededAccessorIndices = new Set<number>();
    const neededMaterialIndices = new Set<number>();
    for (const meshIndex of neededMeshIndices) {
        for (const prim of sourceMeshes[meshIndex]?.primitives ?? []) {
            if (prim.targets?.length) {
                throw new Error(`"${sourceMeshes[meshIndex].name ?? `mesh ${meshIndex}`}" has morph targets (shape-key animation), which aren't supported when merging in individual meshes — uncheck it to continue.`);
            }
            for (const accIdx of Object.values(prim.attributes ?? {}) as number[]) {
                neededAccessorIndices.add(accIdx);
            }
            if (prim.indices !== undefined) {
                neededAccessorIndices.add(prim.indices);
            }
            if (prim.material !== undefined) {
                neededMaterialIndices.add(prim.material);
            }
        }
    }

    const neededBufferViewIndices = new Set<number>();
    for (const accIdx of neededAccessorIndices) {
        const acc = sourceAccessors[accIdx];
        if (acc?.bufferView !== undefined) {
            neededBufferViewIndices.add(acc.bufferView);
        }
        if (acc?.sparse) {
            neededBufferViewIndices.add(acc.sparse.indices.bufferView);
            neededBufferViewIndices.add(acc.sparse.values.bufferView);
        }
    }

    const neededTextureIndices = new Set<number>();
    for (const matIdx of neededMaterialIndices) {
        collectTextureIndices(sourceMaterials[matIdx], neededTextureIndices);
    }

    const neededSamplerIndices = new Set<number>();
    const neededImageIndices = new Set<number>();
    for (const texIdx of neededTextureIndices) {
        const tex = sourceTextures[texIdx];
        if (tex?.sampler !== undefined) {
            neededSamplerIndices.add(tex.sampler);
        }
        if (tex?.source !== undefined) {
            neededImageIndices.add(tex.source);
        }
        const basisuSource = tex?.extensions?.KHR_texture_basisu?.source;
        if (basisuSource !== undefined) {
            neededImageIndices.add(basisuSource);
        }
    }
    for (const imgIdx of neededImageIndices) {
        const bv = sourceImages[imgIdx]?.bufferView;
        if (bv !== undefined) {
            neededBufferViewIndices.add(bv);
        }
    }

    // --- Pack only the needed bufferView byte ranges, each kept at the same 4-byte
    // alignment remainder it had in `source`'s own buffer, so every accessor that reads
    // from it stays correctly aligned even though it's now at a different absolute offset. ---
    const bufferViewIndexBase = (baseJson.bufferViews ?? []).length;
    const bufferViewOldToNew = new Map<number, number>();
    const newBufferViews: any[] = [];
    const appendedChunks: Uint8Array[] = [];
    const paddedBaseLength = padTo4(baseBytes.length);
    let cursor = 0;
    for (const oldIdx of Array.from(neededBufferViewIndices).sort((x, y) => x - y)) {
        const bv = sourceBufferViews[oldIdx];
        const oldByteOffset = bv.byteOffset ?? 0;
        const targetRemainder = oldByteOffset % 4;
        const pad = (targetRemainder - (cursor % 4) + 4) % 4;
        if (pad > 0) {
            appendedChunks.push(new Uint8Array(pad));
            cursor += pad;
        }
        const newByteOffset = paddedBaseLength + cursor;
        appendedChunks.push(sourceBytes.slice(oldByteOffset, oldByteOffset + bv.byteLength));
        cursor += bv.byteLength;
        bufferViewOldToNew.set(oldIdx, bufferViewIndexBase + newBufferViews.length);
        newBufferViews.push({ ...bv, buffer: 0, byteOffset: newByteOffset });
    }
    const combinedBin = new Uint8Array(paddedBaseLength + cursor);
    combinedBin.set(baseBytes, 0);
    {
        let writeOffset = paddedBaseLength;
        for (const chunk of appendedChunks) {
            combinedBin.set(chunk, writeOffset);
            writeOffset += chunk.length;
        }
    }

    const accessorIndexBase = (baseJson.accessors ?? []).length;
    const accessorOldToNew = new Map<number, number>();
    const newAccessors: any[] = [];
    for (const oldIdx of Array.from(neededAccessorIndices).sort((x, y) => x - y)) {
        const acc = { ...sourceAccessors[oldIdx] };
        if (acc.bufferView !== undefined) {
            acc.bufferView = bufferViewOldToNew.get(acc.bufferView)!;
        }
        if (acc.sparse) {
            acc.sparse = {
                ...acc.sparse,
                indices: { ...acc.sparse.indices, bufferView: bufferViewOldToNew.get(acc.sparse.indices.bufferView)! },
                values: { ...acc.sparse.values, bufferView: bufferViewOldToNew.get(acc.sparse.values.bufferView)! },
            };
        }
        accessorOldToNew.set(oldIdx, accessorIndexBase + newAccessors.length);
        newAccessors.push(acc);
    }

    const imageIndexBase = (baseJson.images ?? []).length;
    const imageOldToNew = new Map<number, number>();
    const newImages: any[] = [];
    for (const oldIdx of Array.from(neededImageIndices).sort((x, y) => x - y)) {
        const img = { ...sourceImages[oldIdx] };
        if (img.bufferView !== undefined) {
            img.bufferView = bufferViewOldToNew.get(img.bufferView)!;
        }
        imageOldToNew.set(oldIdx, imageIndexBase + newImages.length);
        newImages.push(img);
    }

    const samplerIndexBase = (baseJson.samplers ?? []).length;
    const samplerOldToNew = new Map<number, number>();
    const newSamplers: any[] = [];
    for (const oldIdx of Array.from(neededSamplerIndices).sort((x, y) => x - y)) {
        samplerOldToNew.set(oldIdx, samplerIndexBase + newSamplers.length);
        newSamplers.push(sourceSamplers[oldIdx]);
    }

    const textureIndexBase = (baseJson.textures ?? []).length;
    const textureOldToNew = new Map<number, number>();
    const newTextures: any[] = [];
    for (const oldIdx of Array.from(neededTextureIndices).sort((x, y) => x - y)) {
        const tex = { ...sourceTextures[oldIdx] };
        if (tex.sampler !== undefined) {
            tex.sampler = samplerOldToNew.get(tex.sampler)!;
        }
        if (tex.source !== undefined) {
            tex.source = imageOldToNew.get(tex.source)!;
        }
        if (tex.extensions?.KHR_texture_basisu?.source !== undefined) {
            tex.extensions = { ...tex.extensions, KHR_texture_basisu: { ...tex.extensions.KHR_texture_basisu, source: imageOldToNew.get(tex.extensions.KHR_texture_basisu.source)! } };
        }
        textureOldToNew.set(oldIdx, textureIndexBase + newTextures.length);
        newTextures.push(tex);
    }

    const remapMaterialTextureIndicesViaMap = (node: unknown): any => {
        if (Array.isArray(node)) {
            return node.map(remapMaterialTextureIndicesViaMap);
        }
        if (node && typeof node === "object") {
            const out: Record<string, unknown> = {};
            for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
                out[key] = remapMaterialTextureIndicesViaMap(value);
            }
            if (typeof out.index === "number") {
                out.index = textureOldToNew.get(out.index as number)!;
            }
            return out;
        }
        return node;
    };
    const materialIndexBase = (baseJson.materials ?? []).length;
    const materialOldToNew = new Map<number, number>();
    const newMaterials: any[] = [];
    for (const oldIdx of Array.from(neededMaterialIndices).sort((x, y) => x - y)) {
        materialOldToNew.set(oldIdx, materialIndexBase + newMaterials.length);
        newMaterials.push(remapMaterialTextureIndicesViaMap(sourceMaterials[oldIdx]));
    }

    const meshIndexBase = (baseJson.meshes ?? []).length;
    const meshOldToNew = new Map<number, number>();
    const newMeshes: any[] = [];
    for (const meshIndex of neededMeshIndices) {
        const mesh = sourceMeshes[meshIndex];
        const newPrimitives = (mesh.primitives ?? []).map((prim: any) => {
            const out: any = { ...prim, attributes: Object.fromEntries(Object.entries(prim.attributes ?? {}).map(([k, v]) => [k, accessorOldToNew.get(v as number)!])) };
            if (out.indices !== undefined) {
                out.indices = accessorOldToNew.get(out.indices)!;
            }
            if (out.material !== undefined) {
                out.material = materialOldToNew.get(out.material)!;
            }
            return out;
        });
        meshOldToNew.set(meshIndex, meshIndexBase + newMeshes.length);
        newMeshes.push({ ...mesh, primitives: newPrimitives });
    }

    const nodeIndexBase = (baseJson.nodes ?? []).length;
    const newNodes = matches.map(({ nodeIndex, meshIndex, worldMatrix }) => {
        const baseName = sourceNodes[nodeIndex]?.name ?? sourceMeshes[meshIndex]?.name ?? `mesh ${meshIndex}`;
        return { name: `${sourceLabel}: ${baseName}`, mesh: meshOldToNew.get(meshIndex)!, matrix: worldMatrix };
    });
    const newNodeIndices = newNodes.map((_, i) => nodeIndexBase + i);

    const mergedJson: any = {
        ...baseJson,
        buffers: [{ byteLength: combinedBin.length }],
        bufferViews: [...(baseJson.bufferViews ?? []), ...newBufferViews],
        accessors: [...(baseJson.accessors ?? []), ...newAccessors],
        images: [...(baseJson.images ?? []), ...newImages],
        samplers: [...(baseJson.samplers ?? []), ...newSamplers],
        textures: [...(baseJson.textures ?? []), ...newTextures],
        materials: [...(baseJson.materials ?? []), ...newMaterials],
        meshes: [...(baseJson.meshes ?? []), ...newMeshes],
        nodes: [...(baseJson.nodes ?? []), ...newNodes],
    };
    const sceneIndex = mergedJson.scene ?? 0;
    mergedJson.scenes = (mergedJson.scenes ?? []).map((scene: any, i: number) => (i === sceneIndex ? { ...scene, nodes: [...(scene.nodes ?? []), ...newNodeIndices] } : scene));
    mergedJson.scene = sceneIndex;

    // A new resource is only safe to introduce silently via extensionsUsed (harmless if
    // over-declared); extensionsRequired is stricter, so only carry forward entries that
    // are demonstrably present in the newly added subtree.
    const newSubtreeText = JSON.stringify({ newMaterials, newTextures, newImages });
    const usedExtensions = new Set<string>(baseJson.extensionsUsed ?? []);
    for (const ext of sourceJson.extensionsUsed ?? []) {
        if (newSubtreeText.includes(ext)) {
            usedExtensions.add(ext);
        }
    }
    const requiredExtensions = new Set<string>(baseJson.extensionsRequired ?? []);
    for (const ext of sourceJson.extensionsRequired ?? []) {
        if (newSubtreeText.includes(ext)) {
            requiredExtensions.add(ext);
        }
    }
    if (usedExtensions.size > 0) {
        mergedJson.extensionsUsed = Array.from(usedExtensions);
    } else {
        delete mergedJson.extensionsUsed;
    }
    if (requiredExtensions.size > 0) {
        mergedJson.extensionsRequired = Array.from(requiredExtensions);
    } else {
        delete mergedJson.extensionsRequired;
    }

    return { container: { json: mergedJson, binChunk: combinedBin, isBinary: true }, newNodeIndices };
}
