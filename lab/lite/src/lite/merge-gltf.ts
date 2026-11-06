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
