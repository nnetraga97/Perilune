const GLB_MAGIC = 0x46546c67;
const GLB_VERSION = 2;
const JSON_CHUNK = 0x4e4f534a;
const BIN_CHUNK = 0x004e4942;
const KTX2_IDENTIFIER = [0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a];

function requireInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer`);
  return value;
}

function uint64(view, offset, label) {
  const value = view.getBigUint64(offset, true);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`${label} exceeds the safe integer range`);
  return Number(value);
}

function inspectKtx2(bytes, label) {
  if (bytes.byteLength < 80) throw new Error(`${label} KTX2 payload is too short`);
  if (KTX2_IDENTIFIER.some((value, index) => bytes[index] !== value)) {
    throw new Error(`${label} must contain a KTX2 payload`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const typeSize = requireInteger(view.getUint32(16, true), `${label} KTX2 type size`);
  const width = requireInteger(view.getUint32(20, true), `${label} KTX2 width`);
  const height = requireInteger(view.getUint32(24, true), `${label} KTX2 height`);
  const depth = requireInteger(view.getUint32(28, true), `${label} KTX2 depth`);
  const layers = requireInteger(view.getUint32(32, true), `${label} KTX2 layer count`);
  const faces = requireInteger(view.getUint32(36, true), `${label} KTX2 face count`);
  const levels = requireInteger(view.getUint32(40, true), `${label} KTX2 level count`);
  const supercompression = requireInteger(view.getUint32(44, true), `${label} KTX2 supercompression scheme`);
  if (typeSize === 0 || supercompression > 3) throw new Error(`${label} KTX2 header is invalid`);
  if (width === 0 || height === 0) throw new Error(`${label} KTX2 dimensions must be positive`);
  if (depth !== 0 || layers !== 0 || faces !== 1) {
    throw new Error(`${label} KTX2 must be a single-layer 2D texture`);
  }
  const fullLevelCount = Math.floor(Math.log2(Math.max(width, height))) + 1;
  if (levels === 0 || levels > fullLevelCount || 80 + levels * 24 > bytes.byteLength) {
    throw new Error(`${label} KTX2 level index is invalid`);
  }
  const dataFormatOffset = requireInteger(view.getUint32(48, true), `${label} KTX2 data format offset`);
  const dataFormatLength = requireInteger(view.getUint32(52, true), `${label} KTX2 data format length`);
  const keyValueOffset = requireInteger(view.getUint32(56, true), `${label} KTX2 key/value offset`);
  const keyValueLength = requireInteger(view.getUint32(60, true), `${label} KTX2 key/value length`);
  const supercompressionOffset = uint64(view, 64, `${label} KTX2 supercompression offset`);
  const supercompressionLength = uint64(view, 72, `${label} KTX2 supercompression length`);
  const levelDataMinimum = 80 + levels * 24;
  if (dataFormatLength === 0 || dataFormatOffset < levelDataMinimum ||
    dataFormatOffset + dataFormatLength > bytes.byteLength ||
    (keyValueLength > 0 && keyValueOffset < levelDataMinimum) ||
    keyValueOffset + keyValueLength > bytes.byteLength ||
    (supercompressionLength > 0 && supercompressionOffset < levelDataMinimum) ||
    supercompressionOffset + supercompressionLength > bytes.byteLength) {
    throw new Error(`${label} KTX2 metadata ranges are invalid`);
  }
  for (let level = 0; level < levels; level++) {
    const entryOffset = 80 + level * 24;
    const byteOffset = uint64(view, entryOffset, `${label} KTX2 level ${level} offset`);
    const byteLength = uint64(view, entryOffset + 8, `${label} KTX2 level ${level} length`);
    uint64(view, entryOffset + 16, `${label} KTX2 level ${level} uncompressed length`);
    if (byteLength === 0 || byteOffset < levelDataMinimum || byteOffset + byteLength > bytes.byteLength) {
      throw new Error(`${label} KTX2 level ${level} exceeds its payload`);
    }
  }

  // Runtime accounting deliberately assumes uncompressed RGBA8 allocation for
  // every texel in a complete mip chain, regardless of KTX2 payload encoding.
  let mipWidth = width;
  let mipHeight = height;
  let gpuBytes = 0;
  for (;;) {
    gpuBytes += mipWidth * mipHeight * 4;
    if (mipWidth === 1 && mipHeight === 1) break;
    mipWidth = Math.max(1, Math.floor(mipWidth / 2));
    mipHeight = Math.max(1, Math.floor(mipHeight / 2));
  }
  if (!Number.isSafeInteger(gpuBytes)) throw new Error(`${label} KTX2 GPU allocation exceeds the safe integer range`);
  return { width, height, levels, gpuBytes };
}

function accessorAt(document, index, label) {
  const accessor = document.accessors?.[index];
  if (!accessor || typeof accessor !== 'object' || Array.isArray(accessor)) {
    throw new Error(`${label} references missing accessor ${String(index)}`);
  }
  requireInteger(accessor.count, `${label} accessor count`);
  return accessor;
}

function validateAccessorBounds(accessor, label) {
  if (!accessor || typeof accessor !== 'object' || Array.isArray(accessor)) {
    throw new Error(`${label} must be an object`);
  }
  for (const key of ['min', 'max']) {
    if (accessor[key] === undefined) continue;
    if (!Array.isArray(accessor[key]) || accessor[key].some((value) => !Number.isFinite(value))) {
      throw new Error(`${label} accessor ${key} must contain only finite numbers`);
    }
  }
}

function primitiveTriangles(mode, count) {
  if (mode === 4) return Math.floor(count / 3);
  if (mode === 5 || mode === 6) return Math.max(0, count - 2);
  return 0;
}

function decodedBounds(accessor) {
  const decode = accessor.normalized
    ? accessor.componentType === 5120 ? (value) => Math.max(value / 127, -1)
      : accessor.componentType === 5121 ? (value) => value / 255
        : accessor.componentType === 5122 ? (value) => Math.max(value / 32767, -1)
          : accessor.componentType === 5123 ? (value) => value / 65535
            : (value) => value
    : (value) => value;
  return { min: accessor.min.map(decode), max: accessor.max.map(decode) };
}

function multiplyMatrices(a, b) {
  const result = new Array(16).fill(0);
  for (let column = 0; column < 4; column++) {
    for (let row = 0; row < 4; row++) {
      for (let index = 0; index < 4; index++) result[column * 4 + row] += a[index * 4 + row] * b[column * 4 + index];
    }
  }
  return result;
}

function nodeMatrix(node, label) {
  if (node.matrix !== undefined) {
    if (!Array.isArray(node.matrix) || node.matrix.length !== 16 || node.matrix.some((value) => !Number.isFinite(value))) {
      throw new Error(`${label} matrix must contain 16 finite numbers`);
    }
    return node.matrix;
  }
  const translation = node.translation ?? [0, 0, 0];
  const rotation = node.rotation ?? [0, 0, 0, 1];
  const scale = node.scale ?? [1, 1, 1];
  if (!Array.isArray(translation) || translation.length !== 3 || translation.some((value) => !Number.isFinite(value)) ||
    !Array.isArray(rotation) || rotation.length !== 4 || rotation.some((value) => !Number.isFinite(value)) ||
    !Array.isArray(scale) || scale.length !== 3 || scale.some((value) => !Number.isFinite(value))) {
    throw new Error(`${label} transform must contain finite TRS values`);
  }
  const [x, y, z, w] = rotation;
  const [sx, sy, sz] = scale;
  return [
    (1 - 2 * (y * y + z * z)) * sx, (2 * (x * y + z * w)) * sx, (2 * (x * z - y * w)) * sx, 0,
    (2 * (x * y - z * w)) * sy, (1 - 2 * (x * x + z * z)) * sy, (2 * (y * z + x * w)) * sy, 0,
    (2 * (x * z + y * w)) * sz, (2 * (y * z - x * w)) * sz, (1 - 2 * (x * x + y * y)) * sz, 0,
    translation[0], translation[1], translation[2], 1,
  ];
}

function includeTransformedBounds(targetMin, targetMax, local, matrix) {
  for (const x of [local.min[0], local.max[0]]) {
    for (const y of [local.min[1], local.max[1]]) {
      for (const z of [local.min[2], local.max[2]]) {
        const point = [
          matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12],
          matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13],
          matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14],
        ];
        for (let axis = 0; axis < 3; axis++) {
          targetMin[axis] = Math.min(targetMin[axis], point[axis]);
          targetMax[axis] = Math.max(targetMax[axis], point[axis]);
        }
      }
    }
  }
}

/** Inspect the structural and budget-relevant contents of a binary glTF file. */
export function inspectGlb(input, { requireKtx2 = false } = {}) {
  const bytes = input instanceof Uint8Array
    ? input
    : input instanceof ArrayBuffer ? new Uint8Array(input) : null;
  if (!bytes) throw new TypeError('GLB input must be a Uint8Array or ArrayBuffer');
  if (bytes.byteLength < 20) throw new Error('GLB is too short');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== GLB_MAGIC) throw new Error('GLB magic is invalid');
  if (view.getUint32(4, true) !== GLB_VERSION) throw new Error('GLB version must be 2');
  const declaredLength = view.getUint32(8, true);
  if (declaredLength !== bytes.byteLength) {
    throw new Error(`GLB length mismatch: header declares ${declaredLength}, received ${bytes.byteLength}`);
  }

  let offset = 12;
  let jsonBytes;
  let binLength = 0;
  let binStart = 0;
  let hasBinChunk = false;
  let chunkIndex = 0;
  while (offset < bytes.byteLength) {
    if (offset + 8 > bytes.byteLength) throw new Error('GLB has a truncated chunk header');
    const chunkLength = view.getUint32(offset, true);
    const chunkType = view.getUint32(offset + 4, true);
    if (chunkLength % 4 !== 0) throw new Error(`GLB chunk ${chunkIndex} length is not 4-byte aligned`);
    const start = offset + 8;
    const end = start + chunkLength;
    if (end > bytes.byteLength) throw new Error(`GLB chunk ${chunkIndex} exceeds the declared file length`);
    if (chunkIndex === 0 && chunkType !== JSON_CHUNK) throw new Error('GLB first chunk must be JSON');
    if (chunkType === JSON_CHUNK) {
      if (jsonBytes) throw new Error('GLB contains more than one JSON chunk');
      jsonBytes = bytes.subarray(start, end);
    } else if (chunkType === BIN_CHUNK) {
      if (hasBinChunk) throw new Error('GLB contains more than one BIN chunk');
      hasBinChunk = true;
      binLength = chunkLength;
      binStart = start;
    }
    offset = end;
    chunkIndex++;
  }
  if (!jsonBytes) throw new Error('GLB JSON chunk is missing');

  let document;
  try {
    const json = new TextDecoder('utf-8', { fatal: true }).decode(jsonBytes).replace(/[\u0000\u0020]+$/u, '');
    document = JSON.parse(json);
  } catch (error) {
    throw new Error(`GLB JSON chunk is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!document || typeof document !== 'object' || Array.isArray(document)) throw new Error('GLB JSON must be an object');
  if (document.asset?.version !== '2.0') throw new Error('GLB asset version must be 2.0');

  const bufferViews = Array.isArray(document.bufferViews) ? document.bufferViews : [];
  const buffers = Array.isArray(document.buffers) ? document.buffers : [];
  for (const [index, buffer] of buffers.entries()) {
    if (!buffer || typeof buffer !== 'object' || Array.isArray(buffer)) throw new Error(`GLB buffer ${index} must be an object`);
    if (buffer.uri !== undefined) throw new Error(`GLB buffer ${index} must not have a uri`);
  }
  const declaredBufferLength = buffers[0]?.byteLength;
  if (declaredBufferLength !== undefined) {
    requireInteger(declaredBufferLength, 'GLB buffer byteLength');
    if (declaredBufferLength > binLength) throw new Error('GLB BIN chunk is shorter than its declared buffer');
  }
  function bufferViewAt(index, label) {
    const bufferView = bufferViews[index];
    if (!bufferView || typeof bufferView !== 'object' || Array.isArray(bufferView)) {
      throw new Error(`${label} references missing bufferView ${String(index)}`);
    }
    const bufferIndex = bufferView.buffer ?? 0;
    const buffer = buffers[bufferIndex];
    if (!buffer || typeof buffer !== 'object' || Array.isArray(buffer)) {
      throw new Error(`${label} references missing buffer ${String(bufferIndex)}`);
    }
    const byteOffset = requireInteger(bufferView.byteOffset ?? 0, `${label} bufferView byteOffset`);
    const byteLength = requireInteger(bufferView.byteLength, `${label} bufferView byteLength`);
    const bufferLength = requireInteger(buffer.byteLength, `${label} buffer byteLength`);
    if (byteOffset + byteLength > bufferLength) throw new Error(`${label} bufferView exceeds its buffer`);
    if (bufferIndex === 0) {
      if (byteOffset + byteLength > binLength) throw new Error(`${label} bufferView exceeds the BIN chunk`);
    } else {
      const meshopt = bufferView.extensions?.EXT_meshopt_compression;
      if (buffer.uri !== undefined || buffer.extensions?.EXT_meshopt_compression?.fallback !== true || !meshopt) {
        throw new Error(`${label} references a non-embedded buffer without a Meshopt fallback`);
      }
      if ((meshopt.buffer ?? 0) !== 0) throw new Error(`${label} Meshopt payload must use embedded buffer 0`);
      const compressedOffset = requireInteger(meshopt.byteOffset ?? 0, `${label} Meshopt byteOffset`);
      const compressedLength = requireInteger(meshopt.byteLength, `${label} Meshopt byteLength`);
      if (compressedOffset + compressedLength > binLength) {
        throw new Error(`${label} Meshopt payload exceeds the BIN chunk`);
      }
    }
    return bufferView;
  }

  const accessors = Array.isArray(document.accessors) ? document.accessors : [];
  accessors.forEach((accessor, index) => validateAccessorBounds(accessor, `GLB accessor ${index}`));

  const geometryViews = new Set();
  let triangles = 0;
  const boundsMin = [Infinity, Infinity, Infinity];
  const boundsMax = [-Infinity, -Infinity, -Infinity];
  let positionAccessors = 0;
  const meshBounds = [];
  const collectAccessor = (index, label) => {
    const accessor = accessorAt(document, index, label);
    validateAccessorBounds(accessor, label);
    if (accessor.bufferView !== undefined) {
      bufferViewAt(accessor.bufferView, label);
      geometryViews.add(accessor.bufferView);
    }
    for (const [sparsePart, sparseRecord] of Object.entries(accessor.sparse ?? {})) {
      if ((sparsePart === 'indices' || sparsePart === 'values') && sparseRecord?.bufferView !== undefined) {
        bufferViewAt(sparseRecord.bufferView, `${label} sparse ${sparsePart}`);
        geometryViews.add(sparseRecord.bufferView);
      }
    }
    return accessor;
  };

  for (const [meshIndex, mesh] of (document.meshes ?? []).entries()) {
    const localBounds = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
    for (const [primitiveIndex, primitive] of (mesh.primitives ?? []).entries()) {
      const label = `GLB mesh ${meshIndex} primitive ${primitiveIndex}`;
      if (primitive.indices !== undefined) {
        const indices = collectAccessor(primitive.indices, `${label} indices`);
        triangles += primitiveTriangles(primitive.mode ?? 4, indices.count);
      }
      for (const [semantic, accessorIndex] of Object.entries(primitive.attributes ?? {})) {
        const accessor = collectAccessor(accessorIndex, `${label} attribute ${semantic}`);
        if (semantic === 'POSITION') {
          if (!Array.isArray(accessor.min) || accessor.min.length !== 3 ||
            !Array.isArray(accessor.max) || accessor.max.length !== 3) {
            throw new Error(`${label} POSITION accessor must declare three-component min and max bounds`);
          }
          const decoded = decodedBounds(accessor);
          for (let axis = 0; axis < 3; axis++) {
            localBounds.min[axis] = Math.min(localBounds.min[axis], decoded.min[axis]);
            localBounds.max[axis] = Math.max(localBounds.max[axis], decoded.max[axis]);
          }
          positionAccessors++;
        }
      }
      for (const [targetIndex, target] of (primitive.targets ?? []).entries()) {
        for (const [semantic, accessorIndex] of Object.entries(target ?? {})) {
          collectAccessor(accessorIndex, `${label} target ${targetIndex} ${semantic}`);
        }
      }
      const dracoBufferView = primitive.extensions?.KHR_draco_mesh_compression?.bufferView;
      if (dracoBufferView !== undefined) {
        bufferViewAt(dracoBufferView, `${label} Draco geometry`);
        geometryViews.add(dracoBufferView);
      }
    }
    if (Number.isFinite(localBounds.min[0])) meshBounds[meshIndex] = localBounds;
  }
  if (positionAccessors === 0) throw new Error('GLB contains no bounded POSITION accessors');

  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const nodes = Array.isArray(document.nodes) ? document.nodes : [];
  const childNodes = new Set(nodes.flatMap((node) => Array.isArray(node?.children) ? node.children : []));
  const scene = Array.isArray(document.scenes) ? document.scenes[document.scene ?? 0] : undefined;
  const roots = Array.isArray(scene?.nodes)
    ? scene.nodes
    : nodes.map((_, index) => index).filter((index) => !childNodes.has(index));
  const visit = (nodeIndex, parentMatrix, ancestors) => {
    if (!Number.isSafeInteger(nodeIndex) || nodeIndex < 0 || !nodes[nodeIndex]) {
      throw new Error(`GLB scene references missing node ${String(nodeIndex)}`);
    }
    if (ancestors.has(nodeIndex)) throw new Error(`GLB node graph contains a cycle at node ${nodeIndex}`);
    const node = nodes[nodeIndex];
    const worldMatrix = multiplyMatrices(parentMatrix, nodeMatrix(node, `GLB node ${nodeIndex}`));
    if (node.mesh !== undefined) {
      if (!Number.isSafeInteger(node.mesh) || !meshBounds[node.mesh]) throw new Error(`GLB node ${nodeIndex} references missing bounded mesh`);
      includeTransformedBounds(boundsMin, boundsMax, meshBounds[node.mesh], worldMatrix);
    }
    const nextAncestors = new Set(ancestors).add(nodeIndex);
    for (const child of node.children ?? []) visit(child, worldMatrix, nextAncestors);
  };
  if (roots.length) {
    for (const root of roots) visit(root, identity, new Set());
  } else {
    for (const localBounds of meshBounds) if (localBounds) includeTransformedBounds(boundsMin, boundsMax, localBounds, identity);
  }
  if (!Number.isFinite(boundsMin[0]) || boundsMin.some((value) => !Number.isFinite(value)) ||
    boundsMax.some((value) => !Number.isFinite(value))) {
    throw new Error('GLB has no finite scene bounds');
  }

  let geometryBytes = 0;
  for (const index of geometryViews) geometryBytes += bufferViewAt(index, 'GLB geometry').byteLength;

  const imageViews = [];
  for (const [index, image] of (document.images ?? []).entries()) {
    if (!image || typeof image !== 'object' || Array.isArray(image)) throw new Error(`GLB image ${index} must be an object`);
    if (image.uri !== undefined) throw new Error(`GLB image ${index} must not have a uri`);
    if (image.bufferView === undefined) throw new Error(`GLB image ${index} must have an embedded bufferView`);
    if (requireKtx2 && image.mimeType !== 'image/ktx2') {
      throw new Error(`GLB image ${index} mimeType must be image/ktx2 after optimization`);
    }
    bufferViewAt(image.bufferView, `GLB image ${index}`);
    imageViews.push({ imageIndex: index, bufferViewIndex: image.bufferView });
  }
  let textureBytes = 0;
  let textureGpuBytes = 0;
  let textureMaxDimension = 0;
  const textures = [];
  for (const { imageIndex, bufferViewIndex } of imageViews) {
    const bufferView = bufferViewAt(bufferViewIndex, `GLB image ${imageIndex}`);
    if ((bufferView.buffer ?? 0) !== 0) throw new Error('GLB images must use embedded buffer 0');
    textureBytes += bufferView.byteLength;
    const payload = bytes.subarray(
      binStart + (bufferView.byteOffset ?? 0),
      binStart + (bufferView.byteOffset ?? 0) + bufferView.byteLength,
    );
    const isKtx2 = KTX2_IDENTIFIER.every((value, identifierIndex) => payload[identifierIndex] === value);
    if (requireKtx2 && !isKtx2) {
      throw new Error(`GLB image ${imageIndex} bufferView ${bufferViewIndex} must be embedded KTX2 after optimization`);
    }
    if (isKtx2) {
      const texture = inspectKtx2(payload, `GLB image ${imageIndex} bufferView ${bufferViewIndex}`);
      textures.push(texture);
      textureGpuBytes += texture.gpuBytes;
      textureMaxDimension = Math.max(textureMaxDimension, texture.width, texture.height);
    }
  }

  return {
    triangles,
    geometryBytes,
    textureBytes,
    textureGpuBytes,
    textureMaxDimension,
    textures,
    boundsMin,
    boundsMax,
    extensionsUsed: [...new Set(document.extensionsUsed ?? [])].sort(),
    animationClips: Array.isArray(document.animations) ? document.animations.length : 0,
  };
}
