// tools/intake/alpaca/alpaca_image.mjs
// ─────────────────────────────────────────────────────────────────────────────
// ASCOM Alpaca Camera image wire-format codec: DECODE (imagebytes / imagearray →
// Float32 planes) + ENCODE (planes → imagebytes / imagearray, used by the mock
// server). Pure, dependency-free, unit-testable; the encode/decode pair round-trips.
//
// PROVENANCE / LAW-4 NOTE: the DECODE half mirrors the parser embedded in the
// existing control lane (`tools/seestar/ctl.mjs` parseImageBytes/parseImageArray).
// That parser is not exported and ctl.mjs runs a CLI `main()` on import, so it
// cannot be reused without editing an UNGATED file outside this task's scope.
// This module is the DRY home for the format going forward (it is unit-gated by
// alpaca_image.test.mjs); folding ctl.mjs onto it is a queued consolidation.
//
// ImageBytes binary layout (ASCOM AlpacaImageBytes metadata version 1, 44-byte
// header, all little-endian Int32/UInt32):
//   off  0  MetadataVersion   (Int32  = 1)
//   off  4  ErrorNumber       (Int32  = 0 on success)
//   off  8  ClientTransactionID (UInt32)
//   off 12  ServerTransactionID (UInt32)   ← used as the per-frame identity
//   off 16  DataStart         (Int32  = 44)
//   off 20  ImageElementType  (Int32)      original element type
//   off 24  TransmissionElementType (Int32) type actually on the wire
//   off 28  Rank              (Int32  = 2 mono | 3 colour)
//   off 32  Dimension1 (W)    (Int32)
//   off 36  Dimension2 (H)    (Int32)
//   off 40  Dimension3 (NP)   (Int32  = 0 when rank 2)
//   data from DataStart: values in X-OUTER order, element index (((x*H)+y)*NP+c).
// FITS wants y*W+x (x fastest), so decode transposes.
// ─────────────────────────────────────────────────────────────────────────────

export const IMAGE_ELEMENT_TYPE = {
  Unknown: 0, Int16: 1, Int32: 2, Double: 3, Single: 4,
  UInt64: 5, Byte: 6, Int64: 7, UInt16: 8,
};
export const IMAGE_ELEMENT_NAME = Object.fromEntries(
  Object.entries(IMAGE_ELEMENT_TYPE).map(([k, v]) => [v, k]));

export function elementSize(t) {
  if (t === 6) return 1;               // Byte
  if (t === 1 || t === 8) return 2;    // Int16 / UInt16
  if (t === 2 || t === 4) return 4;    // Int32 / Single
  return 8;                            // Double / Int64 / UInt64
}

function readEl(dv, off, t) {
  switch (t) {
    case 1: return dv.getInt16(off, true);
    case 2: return dv.getInt32(off, true);
    case 3: return dv.getFloat64(off, true);
    case 4: return dv.getFloat32(off, true);
    case 5: return Number(dv.getBigUint64(off, true));
    case 6: return dv.getUint8(off);
    case 7: return Number(dv.getBigInt64(off, true));
    case 8: return dv.getUint16(off, true);
    default: throw new Error(`unsupported element type ${t}`);
  }
}

function writeEl(dv, off, t, v) {
  const iv = Math.round(v);
  switch (t) {
    case 1: dv.setInt16(off, iv, true); break;
    case 2: dv.setInt32(off, iv, true); break;
    case 3: dv.setFloat64(off, v, true); break;
    case 4: dv.setFloat32(off, v, true); break;
    case 5: dv.setBigUint64(off, BigInt(Math.max(0, iv)), true); break;
    case 6: dv.setUint8(off, Math.max(0, Math.min(255, iv))); break;
    case 7: dv.setBigInt64(off, BigInt(iv), true); break;
    case 8: dv.setUint16(off, Math.max(0, Math.min(65535, iv)), true); break;
    default: throw new Error(`unsupported element type ${t}`);
  }
}

// ── DECODE ──────────────────────────────────────────────────────────────────

/**
 * Decode an ASCOM ImageBytes buffer → { planes:Float32Array[], W, H, NP,
 * elementType (name), transmissionType, serverTxnId, clientTxnId }.
 * Throws on a non-zero ErrorNumber (honest failure, never a partial silent frame).
 */
export function parseImageBytes(buf) {
  if (!buf || buf.length < 44) throw new Error('imagebytes too short (< 44-byte metadata)');
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.length);
  const errorNumber = dv.getInt32(4, true);
  if (errorNumber !== 0) throw new Error(`imagebytes ErrorNumber ${errorNumber}`);
  const clientTxnId = dv.getUint32(8, true);
  const serverTxnId = dv.getUint32(12, true);
  const dataStart = dv.getInt32(16, true);
  const imageType = dv.getInt32(20, true);
  const tType = dv.getInt32(24, true);
  const rank = dv.getInt32(28, true);
  const W = dv.getInt32(32, true), H = dv.getInt32(36, true), d3 = dv.getInt32(40, true);
  const NP = rank === 3 ? d3 : 1;
  if (W <= 0 || H <= 0 || NP <= 0) throw new Error(`imagebytes bad dims ${W}x${H}x${NP}`);
  const sz = elementSize(tType);
  const need = dataStart + W * H * NP * sz;
  if (buf.length < need) throw new Error(`imagebytes truncated: have ${buf.length}B need ${need}B`);
  const planes = Array.from({ length: NP }, () => new Float32Array(W * H));
  for (let x = 0; x < W; x++)
    for (let y = 0; y < H; y++)
      for (let c = 0; c < NP; c++)
        planes[c][y * W + x] = readEl(dv, dataStart + (((x * H) + y) * NP + c) * sz, tType);
  return {
    planes, W, H, NP,
    elementType: IMAGE_ELEMENT_NAME[imageType] || String(imageType),
    transmissionType: IMAGE_ELEMENT_NAME[tType] || String(tType),
    serverTxnId, clientTxnId,
  };
}

/**
 * Decode an ASCOM imagearray JSON envelope (rank 2 mono or rank 3 colour) →
 * the same shape as parseImageBytes. Value is [x][y] (rank2) / [x][y][c] (rank3).
 */
export function parseImageArray(json) {
  if (!json || typeof json !== 'object') throw new Error('imagearray: no JSON envelope');
  if (typeof json.ErrorNumber === 'number' && json.ErrorNumber !== 0)
    throw new Error(`imagearray ErrorNumber ${json.ErrorNumber} ${json.ErrorMessage || ''}`.trim());
  const rank = json.Rank, val = json.Value;
  if (!Array.isArray(val) || !val.length) throw new Error('imagearray: empty Value');
  const W = val.length;
  const serverTxnId = json.ServerTransactionID ?? 0, clientTxnId = json.ClientTransactionID ?? 0;
  const typeName = IMAGE_ELEMENT_NAME[json.Type] || 'imagearray';
  if (rank === 2) {
    const H = val[0].length, plane = new Float32Array(W * H);
    for (let x = 0; x < W; x++) for (let y = 0; y < H; y++) plane[y * W + x] = val[x][y];
    return { planes: [plane], W, H, NP: 1, elementType: typeName, transmissionType: typeName, serverTxnId, clientTxnId };
  }
  const H = val[0].length, NP = val[0][0].length;
  const planes = Array.from({ length: NP }, () => new Float32Array(W * H));
  for (let x = 0; x < W; x++) for (let y = 0; y < H; y++) for (let c = 0; c < NP; c++) planes[c][y * W + x] = val[x][y][c];
  return { planes, W, H, NP, elementType: typeName, transmissionType: typeName, serverTxnId, clientTxnId };
}

// ── ENCODE (mock server side) ────────────────────────────────────────────────

/**
 * Encode Float32 planes → an ASCOM ImageBytes buffer (inverse of parseImageBytes).
 * opts: { planes, W, H, elementType (number|name, default UInt16), serverTxnId,
 * clientTxnId }. NP = planes.length.
 */
export function buildImageBytes({ planes, W, H, elementType = 8, serverTxnId = 1, clientTxnId = 1 }) {
  const t = typeof elementType === 'string' ? IMAGE_ELEMENT_TYPE[elementType] : elementType;
  if (t == null) throw new Error(`unknown elementType ${elementType}`);
  const NP = planes.length;
  const rank = NP > 1 ? 3 : 2;
  const sz = elementSize(t);
  const dataStart = 44;
  const buf = Buffer.alloc(dataStart + W * H * NP * sz);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.length);
  dv.setInt32(0, 1, true);            // MetadataVersion
  dv.setInt32(4, 0, true);            // ErrorNumber
  dv.setUint32(8, clientTxnId >>> 0, true);
  dv.setUint32(12, serverTxnId >>> 0, true);
  dv.setInt32(16, dataStart, true);
  dv.setInt32(20, t, true);           // ImageElementType
  dv.setInt32(24, t, true);           // TransmissionElementType
  dv.setInt32(28, rank, true);
  dv.setInt32(32, W, true);
  dv.setInt32(36, H, true);
  dv.setInt32(40, rank === 3 ? NP : 0, true);
  for (let x = 0; x < W; x++)
    for (let y = 0; y < H; y++)
      for (let c = 0; c < NP; c++)
        writeEl(dv, dataStart + (((x * H) + y) * NP + c) * sz, t, planes[c][y * W + x]);
  return buf;
}

/**
 * Encode Float32 planes → an ASCOM imagearray JSON envelope (inverse of
 * parseImageArray). Value is [x][y] (mono) / [x][y][c] (colour).
 */
export function buildImageArrayJson({ planes, W, H, elementType = 8, serverTxnId = 1, clientTxnId = 1 }) {
  const t = typeof elementType === 'string' ? IMAGE_ELEMENT_TYPE[elementType] : elementType;
  const NP = planes.length;
  const round = (t === 3 || t === 4) ? (v) => v : (v) => Math.round(v);
  const Value = new Array(W);
  for (let x = 0; x < W; x++) {
    const col = new Array(H);
    for (let y = 0; y < H; y++) {
      if (NP === 1) col[y] = round(planes[0][y * W + x]);
      else { const px = new Array(NP); for (let c = 0; c < NP; c++) px[c] = round(planes[c][y * W + x]); col[y] = px; }
    }
    Value[x] = col;
  }
  return {
    Type: t, Rank: NP > 1 ? 3 : 2, Value,
    ClientTransactionID: clientTxnId, ServerTransactionID: serverTxnId,
    ErrorNumber: 0, ErrorMessage: '',
  };
}

/**
 * Deterministic synthetic star-field frame for tests / mock default — a dark
 * background with a handful of Gaussian "stars", so the frame is NOT uniform
 * (exercises stats + is visibly a sky frame) without needing any bundled asset.
 */
export function syntheticStarFrame({ W = 64, H = 48, NP = 1, seed = 1234, floor = 200, peak = 60000 } = {}) {
  const planes = Array.from({ length: NP }, () => new Float32Array(W * H).fill(floor));
  // Simple LCG so the field is reproducible across runs/processes.
  let s = seed >>> 0;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const nStars = 8;
  for (let k = 0; k < nStars; k++) {
    const cx = Math.floor(rnd() * W), cy = Math.floor(rnd() * H);
    const amp = peak * (0.3 + 0.7 * rnd()), sig = 0.8 + 1.6 * rnd();
    for (let y = Math.max(0, cy - 4); y < Math.min(H, cy + 5); y++)
      for (let x = Math.max(0, cx - 4); x < Math.min(W, cx + 5); x++) {
        const g = amp * Math.exp(-((x - cx) ** 2 + (y - cy) ** 2) / (2 * sig * sig));
        for (let c = 0; c < NP; c++) planes[c][y * W + x] = Math.min(65535, planes[c][y * W + x] + g);
      }
  }
  return { planes, W, H, NP, elementType: 'UInt16' };
}
