/** Minimal glTF/GLB container round-trip: parse the raw file bytes to a mutable JSON
 *  document (+ optional binary chunk), and re-serialize after in-place edits (e.g.
 *  renamed mesh names). This intentionally does NOT use babylon-lite's loader — it
 *  only needs the JSON structure, not GPU upload, and babylon-lite has no exporter
 *  (it's a loader-only runtime). Lab-only tooling; not part of the published package. */

const GLB_MAGIC = 0x46546c67; // "glTF"
const CHUNK_TYPE_JSON = 0x4e4f534a; // "JSON"
const CHUNK_TYPE_BIN = 0x004e4942; // "BIN\0"

export interface ParsedGltfContainer {
    /** Mutable parsed JSON document — safe to edit in place before re-export. */
    json: any;
    /** Raw GLB binary chunk (geometry/texture bytes), or null for a plain .gltf (external buffers). */
    binChunk: Uint8Array | null;
    /** True if the source was a binary .glb; false for a plain JSON .gltf. */
    isBinary: boolean;
}

/** Parse a .glb or .gltf ArrayBuffer into its JSON document (+ binary chunk for .glb). */
export function parseGltfContainer(data: ArrayBuffer): ParsedGltfContainer {
    const dv = new DataView(data);
    if (dv.byteLength >= 12 && dv.getUint32(0, true) === GLB_MAGIC) {
        let offset = 12;
        let json: any = null;
        let binChunk: Uint8Array | null = null;
        while (offset + 8 <= dv.byteLength) {
            const chunkLength = dv.getUint32(offset, true);
            const chunkType = dv.getUint32(offset + 4, true);
            const chunkStart = offset + 8;
            if (chunkType === CHUNK_TYPE_JSON) {
                json = JSON.parse(new TextDecoder("utf-8").decode(new Uint8Array(data, chunkStart, chunkLength)));
            } else if (chunkType === CHUNK_TYPE_BIN) {
                binChunk = new Uint8Array(data.slice(chunkStart, chunkStart + chunkLength));
            }
            offset = chunkStart + chunkLength;
        }
        if (!json) {
            throw new Error("Invalid GLB: missing JSON chunk");
        }
        return { json, binChunk, isBinary: true };
    }
    return { json: JSON.parse(new TextDecoder("utf-8").decode(data)), binChunk: null, isBinary: false };
}

/** One flattened babylon-lite Mesh's glTF origin: which `meshes[]` entry and which
 *  primitive within it produced it, plus the `nodes[]` entry that placed it in the
 *  scene (the node babylon-lite's Mesh is parented to) — used by the "combine meshes
 *  within this model" feature to find the live SceneNode for a Layers-panel row and to
 *  update that node's own glTF JSON entry. */
export interface MeshPrimitiveRef {
    meshIndex: number;
    primitiveIndex: number;
    nodeIndex: number;
}

/** DFS over the glTF node hierarchy, mirroring babylon-lite's internal
 *  `buildNodeHierarchy` traversal order exactly (children before own primitives),
 *  so the returned list of refs lines up 1:1, in order, with
 *  `getContainerMeshes(container)`'s flattened Mesh array. One entry per
 *  primitive (babylon-lite builds one Mesh per glTF primitive). */
export function collectMeshIndicesInContainerOrder(json: any): MeshPrimitiveRef[] {
    const nodes: any[] = json.nodes ?? [];
    const meshes: any[] = json.meshes ?? [];
    const refs: MeshPrimitiveRef[] = [];
    const visit = (nodeIdx: number): void => {
        const node = nodes[nodeIdx];
        if (!node) {
            return;
        }
        if (node.children) {
            for (const childIdx of node.children) {
                visit(childIdx);
            }
        }
        if (node.mesh !== undefined) {
            const primCount = meshes[node.mesh]?.primitives?.length ?? 1;
            for (let p = 0; p < primCount; p++) {
                refs.push({ meshIndex: node.mesh, primitiveIndex: p, nodeIndex: nodeIdx });
            }
        }
    };
    const roots: number[] = json.scenes?.[json.scene ?? 0]?.nodes ?? [];
    for (const r of roots) {
        visit(r);
    }
    return refs;
}

/** Per-primitive glTF material-clone tracking, keyed by `"meshIndex:primitiveIndex"`, so
 *  repeated opacity/color edits on the same primitive keep reusing the same cloned export
 *  material instead of growing `json.materials` on every slider tick. One Map per loaded
 *  container; callers should create a fresh one per load. */
export type ExportMaterialClones = Map<string, { index: number; originalAlphaMode?: string }>;

/** Look up (or lazily create) the cloned export material for a primitive, shared by both
 *  `setPrimitiveExportAlpha` and `setPrimitiveExportColor` so toggling opacity then color
 *  (or vice versa) on the same primitive edits the SAME clone instead of each helper
 *  creating its own and clobbering the other's edit.
 *
 *  The primitive's source material is cloned into a new `json.materials[]` entry the first
 *  time any primitive referencing it is edited, so sibling primitives/meshes that still
 *  share the original material are left untouched — matching the runtime behavior where
 *  `setMeshOpacity`/`setMeshColor` clone `mesh.material` instead of mutating it in place. */
function getOrCreateExportMaterialClone(json: any, clones: ExportMaterialClones, meshIndex: number, primitiveIndex: number): any | null {
    const primitive = json.meshes?.[meshIndex]?.primitives?.[primitiveIndex];
    if (!primitive) {
        return null;
    }

    const key = `${meshIndex}:${primitiveIndex}`;
    let entry = clones.get(key);
    if (entry === undefined) {
        json.materials = json.materials ?? [];
        const source = primitive.material !== undefined ? json.materials[primitive.material] : undefined;
        // Deep-clone only the parts we touch (pbrMetallicRoughness.baseColorFactor); everything
        // else (textures, name, extensions) is shared by reference with the original material.
        const cloned = {
            ...source,
            pbrMetallicRoughness: {
                ...source?.pbrMetallicRoughness,
                baseColorFactor: source?.pbrMetallicRoughness?.baseColorFactor ? [...source.pbrMetallicRoughness.baseColorFactor] : [1, 1, 1, 1],
            },
        };
        entry = { index: json.materials.length, originalAlphaMode: source?.alphaMode };
        json.materials.push(cloned);
        clones.set(key, entry);
        primitive.material = entry.index;
    }
    return json.materials[entry.index];
}

/** Bake a primitive's opacity into the glTF JSON for export. Mirrors the runtime opacity
 *  slider (`setMeshOpacity`) but edits the standard metallic-roughness representation
 *  (`baseColorFactor[3]` + `alphaMode`) instead of babylon-lite's in-memory material props. */
export function setPrimitiveExportAlpha(json: any, clones: ExportMaterialClones, meshIndex: number, primitiveIndex: number, alpha: number): void {
    const material = getOrCreateExportMaterialClone(json, clones, meshIndex, primitiveIndex);
    if (!material) {
        return;
    }
    const entry = clones.get(`${meshIndex}:${primitiveIndex}`)!;
    material.pbrMetallicRoughness.baseColorFactor[3] = Math.min(1, Math.max(0, alpha));
    if (alpha < 1) {
        material.alphaMode = "BLEND";
    } else if (entry.originalAlphaMode !== undefined) {
        material.alphaMode = entry.originalAlphaMode;
    } else {
        delete material.alphaMode;
    }
}

/** Bake a primitive's base color into the glTF JSON for export. Mirrors the runtime color
 *  picker (`setMeshColor`) by writing the linear-RGB channels of `baseColorFactor`, leaving
 *  the alpha channel (index 3) untouched so it keeps whatever opacity was set separately.
 *  Also removes any `baseColorTexture`: glTF composites baseColorTexture * baseColorFactor,
 *  so an exported file that kept the texture would show its per-texel shading tinted by the
 *  new color instead of the flat, uniform fill the picker is meant to produce. */
export function setPrimitiveExportColor(json: any, clones: ExportMaterialClones, meshIndex: number, primitiveIndex: number, rgbLinear: readonly [number, number, number]): void {
    const material = getOrCreateExportMaterialClone(json, clones, meshIndex, primitiveIndex);
    if (!material) {
        return;
    }
    const factor = material.pbrMetallicRoughness.baseColorFactor;
    factor[0] = rgbLinear[0];
    factor[1] = rgbLinear[1];
    factor[2] = rgbLinear[2];
    delete material.pbrMetallicRoughness.baseColorTexture;
}

/** Permanently strip primitives marked for deletion from the glTF JSON at export time.
 *  `deletedKeys` holds `"meshIndex:primitiveIndex"` strings (see MeshPrimitiveRef), matching
 *  the Layers panel row the user clicked Delete on. Deletion is applied here — in one batch,
 *  right before export — rather than immediately on click, because splicing a primitive out
 *  of `json.meshes[meshIndex].primitives` shifts the indices of any later primitives on the
 *  SAME mesh def; doing all of a mesh's removals in one descending-index pass avoids that
 *  shift corrupting a second pending deletion on the same multi-primitive mesh.
 *
 *  If removing primitives empties a mesh def entirely, every node referencing that meshIndex
 *  has its `mesh` reference cleared (rather than deleting the mesh def itself, which would
 *  require renumbering every other mesh index throughout the document) — the node survives
 *  as an empty transform, and the exported file stays valid glTF (no 0-primitive mesh defs). */
export function applyPrimitiveDeletions(json: any, deletedKeys: ReadonlySet<string>): void {
    if (deletedKeys.size === 0) {
        return;
    }
    const byMesh = new Map<number, number[]>();
    for (const key of deletedKeys) {
        const [meshIndexStr, primitiveIndexStr] = key.split(":");
        const meshIndex = Number(meshIndexStr);
        const primitiveIndex = Number(primitiveIndexStr);
        const list = byMesh.get(meshIndex) ?? [];
        list.push(primitiveIndex);
        byMesh.set(meshIndex, list);
    }

    const emptiedMeshIndices = new Set<number>();
    for (const [meshIndex, primitiveIndices] of byMesh) {
        const meshDef = json.meshes?.[meshIndex];
        if (!meshDef?.primitives) {
            continue;
        }
        // Descending order so earlier splices don't shift the indices still queued for removal.
        for (const primitiveIndex of [...primitiveIndices].sort((a, b) => b - a)) {
            meshDef.primitives.splice(primitiveIndex, 1);
        }
        if (meshDef.primitives.length === 0) {
            emptiedMeshIndices.add(meshIndex);
        }
    }

    if (emptiedMeshIndices.size > 0) {
        for (const node of json.nodes ?? []) {
            if (node.mesh !== undefined && emptiedMeshIndices.has(node.mesh)) {
                delete node.mesh;
            }
        }
    }
}

function padChunk(bytes: Uint8Array, padByte: number): Uint8Array {
    const pad = (4 - (bytes.length % 4)) % 4;
    if (pad === 0) {
        return bytes;
    }
    const padded = new Uint8Array(bytes.length + pad);
    padded.set(bytes);
    padded.fill(padByte, bytes.length);
    return padded;
}

function chunkHeader(length: number, type: number): Uint8Array {
    const header = new Uint8Array(8);
    const view = new DataView(header.buffer);
    view.setUint32(0, length, true);
    view.setUint32(4, type, true);
    return header;
}

/** Re-serialize an edited JSON document back into a GLB, reusing the original
 *  (unmodified) binary chunk. JSON chunk is space-padded, BIN chunk zero-padded,
 *  per the GLB spec's 4-byte chunk alignment requirement. */
export function serializeGlb(json: any, binChunk: Uint8Array | null): Blob {
    const jsonBytes = padChunk(new TextEncoder().encode(JSON.stringify(json)), 0x20);
    const parts: Uint8Array[] = [chunkHeader(jsonBytes.length, CHUNK_TYPE_JSON), jsonBytes];

    if (binChunk) {
        const binBytes = padChunk(binChunk, 0x00);
        parts.push(chunkHeader(binBytes.length, CHUNK_TYPE_BIN), binBytes);
    }

    const totalLength = 12 + parts.reduce((sum, p) => sum + p.length, 0);
    const header = new Uint8Array(12);
    const headerView = new DataView(header.buffer);
    headerView.setUint32(0, GLB_MAGIC, true);
    headerView.setUint32(4, 2, true); // glTF version 2
    headerView.setUint32(8, totalLength, true);

    return new Blob([header, ...parts] as BlobPart[], { type: "model/gltf-binary" });
}

/** Re-serialize an edited plain-JSON .gltf document (external buffers/images untouched). */
export function serializeGltfJson(json: any): Blob {
    return new Blob([JSON.stringify(json, null, 2)], { type: "model/gltf+json" });
}
