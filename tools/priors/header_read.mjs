// tools/priors/header_read.mjs
//
// CHEAP, header-only metadata extraction for the prior lane. NO full decodes, NO
// solves (the box is contested). FITS = 2880-byte ASCII card blocks. CR2 = TIFF/EXIF
// IFD walk over the first ~256 KB only. Every reader is best-effort: any parse
// failure returns honest-null fields, never throws.
//
// Output: a frame *descriptor* consumable by priors_core.computePriors().

import fs from 'node:fs';
import path from 'node:path';

// Small sensor pixel-pitch fallback table (µm) keyed by EXIF/INSTRUME substrings.
// Used only when the header/EXIF does not carry pixel size directly.
const SENSOR_PITCH_UM = [
  [/1300d|rebel\s?t6|eos\s?t6|canon\s?t6/i, 4.29],   // Canon T6 / 1300D (18MP APS-C)
  [/eos\s?60da|60da|eos\s?60d/i, 4.29],              // Canon 60D / 60Da (18MP APS-C)
  [/5d\s?mark\s?iii|5dmkiii|5d3|eos\s?5d/i, 6.25],   // Canon 5D Mk III (22MP FF)
  [/imx585/i, 2.90],                                 // ZWO SeeStar imx585
];

/** Read a FITS primary header (header-only) into a flat keyword map. */
export function readFitsHeader(file, maxBlocks = 40) {
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(2880 * maxBlocks);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    const s = buf.toString('latin1', 0, n);
    const kv = {};
    for (let i = 0; i + 80 <= s.length; i += 80) {
      const card = s.slice(i, i + 80);
      if (card.startsWith('END ') || card.trim() === 'END') break;
      const key = card.slice(0, 8).trim();
      if (!key || card[8] !== '=') continue;
      let val = card.slice(10).split('/')[0].trim();
      if (val.startsWith("'")) val = val.replace(/^'|'$/g, '').trim();
      else if (/^[-+]?[\d.]+([eE][-+]?\d+)?$/.test(val)) val = Number(val);
      else if (val === 'T') val = true; else if (val === 'F') val = false;
      if (!(key in kv)) kv[key] = val;
    }
    return kv;
  } catch { return null; }
}

/** Build a descriptor from a FITS file using its header only. */
export function descriptorFromFits(file) {
  const h = readFitsHeader(file);
  const d = { path: file, filename: path.basename(file), format: 'FITS' };
  if (!h) return d;
  const ra = num(h.RA ?? h.CRVAL1 ?? h.OBJCTRA);
  const dec = num(h.DEC ?? h.CRVAL2 ?? h.OBJCTDEC);
  const focal = num(h.FOCALLEN);
  const pitch = num(h.XPIXSZ ?? h.PIXSIZE1);
  let scale = null;
  if (focal && pitch) scale = 206264.806247 * (pitch / 1000) / focal;
  if (num(h.CD1_1) != null) scale = Math.abs(num(h.CD1_1)) * 3600;
  else if (num(h.CDELT1) != null) scale = Math.abs(num(h.CDELT1)) * 3600;
  const present = Number.isFinite(ra) && Number.isFinite(dec);
  d.fits_wcs = { present, ra_deg: ra ?? null, dec_deg: dec ?? null, scale_arcsec_px: scale };
  if (Number.isFinite(focal)) { d.fl_mm = focal; d.fl_source = 'fits:FOCALLEN'; }
  if (Number.isFinite(pitch)) { d.pixel_pitch_um = pitch; d.pitch_source = 'fits:XPIXSZ'; }
  else { const pp = pitchFromModel(h.INSTRUME); if (pp) { d.pixel_pitch_um = pp; d.pitch_source = 'sensor_db'; } }
  const exp = num(h.EXPOSURE ?? h.EXPTIME);
  if (Number.isFinite(exp)) d.exposure_s = exp;
  const gain = num(h.GAIN ?? h.ISOSPEED);
  if (Number.isFinite(gain)) d.iso = gain; // FITS "GAIN" is not ISO but seeds the regime coarsely
  if (Number.isFinite(num(h.SITELAT))) { d.site_lat = num(h.SITELAT); d.site_lon = num(h.SITELONG); }
  if (typeof h['DATE-OBS'] === 'string') { d.timestamp_iso = h['DATE-OBS']; d.timestamp_trusted = true; }
  if (typeof h.OBJECT === 'string') d.header_object = h.OBJECT;
  return d;
}

/** Build a descriptor from a Canon CR2 (TIFF/EXIF) using header IFDs only. */
export function descriptorFromCr2(file) {
  const d = { path: file, filename: path.basename(file), format: 'CR2' };
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(Math.min(262144, fs.fstatSync(fd).size));
    fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    const exif = parseExif(buf);
    if (exif) {
      if (Number.isFinite(exif.FocalLength)) { d.fl_mm = exif.FocalLength; d.fl_source = 'exif:FocalLength'; }
      if (Number.isFinite(exif.ISO)) d.iso = exif.ISO;
      if (Number.isFinite(exif.ExposureTime)) d.exposure_s = exif.ExposureTime;
      if (Number.isFinite(exif.PixelPitchUm)) { d.pixel_pitch_um = exif.PixelPitchUm; d.pitch_source = 'exif:FocalPlaneResolution'; }
      else { const pp = pitchFromModel(exif.Model); if (pp) { d.pixel_pitch_um = pp; d.pitch_source = 'sensor_db'; } }
      if (exif.DateTimeOriginal) { d.timestamp_iso = exif.DateTimeOriginal; d.timestamp_trusted = true; }
      if (exif.GPSLat != null) { d.gps = { lat: exif.GPSLat, lon: exif.GPSLon }; }
      if (exif.Model) d.camera_model = exif.Model;
    }
  } catch { /* honest-null: leave fields unset */ }
  return d;
}

/** Dispatch by extension. FITS + CR2 are parsed; anything else = filename-only. */
export function buildDescriptor(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.fit' || ext === '.fits' || ext === '.fts') return descriptorFromFits(file);
  if (ext === '.cr2' || ext === '.cr3' || ext === '.tif' || ext === '.tiff') return descriptorFromCr2(file);
  return { path: file, filename: path.basename(file), format: ext.replace('.', '').toUpperCase() || null };
}

// --- minimal TIFF/EXIF reader (Canon CR2 is TIFF-based) --------------------
function parseExif(buf) {
  let le;
  if (buf.slice(0, 2).toString('latin1') === 'II') le = true;
  else if (buf.slice(0, 2).toString('latin1') === 'MM') le = false;
  else return null;
  const u16 = (o) => (le ? buf.readUInt16LE(o) : buf.readUInt16BE(o));
  const u32 = (o) => (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
  const out = {};
  const readIfd = (off, kind) => {
    if (off <= 0 || off + 2 > buf.length) return;
    const count = u16(off);
    let exifPtr = 0, gpsPtr = 0;
    let fpXRes = null, fpResUnit = null;
    for (let i = 0; i < count; i++) {
      const e = off + 2 + i * 12;
      if (e + 12 > buf.length) break;
      const tag = u16(e), type = u16(e + 2), cnt = u32(e + 4);
      const valOff = e + 8;
      const rational = () => { const p = u32(valOff); return p + 8 <= buf.length ? u32(p) / (u32(p + 4) || 1) : null; };
      const short = () => u16(valOff);
      const asciiAt = () => { const p = cnt <= 4 ? valOff : u32(valOff); return p + cnt <= buf.length ? buf.toString('latin1', p, p + cnt).replace(/\0.*$/, '').trim() : null; };
      switch (tag) {
        case 0x829a: out.ExposureTime = rational(); break;      // ExposureTime
        case 0x8827: out.ISO = short(); break;                  // ISOSpeedRatings
        case 0x920a: out.FocalLength = rational(); break;       // FocalLength
        case 0x9003: out.DateTimeOriginal = fmtExifDate(asciiAt()); break;
        case 0x0110: if (!out.Model) out.Model = asciiAt(); break; // Model (IFD0)
        case 0xa20e: fpXRes = rational(); break;                // FocalPlaneXResolution
        case 0xa210: fpResUnit = short(); break;                // FocalPlaneResolutionUnit
        case 0x8769: exifPtr = u32(valOff); break;              // EXIF IFD
        case 0x8825: gpsPtr = u32(valOff); break;               // GPS IFD
        default: break;
      }
    }
    if (fpXRes && fpResUnit) { const mmPerUnit = fpResUnit === 3 ? 10 : 25.4; out.PixelPitchUm = (mmPerUnit / fpXRes) * 1000; }
    if (kind === 'ifd0' && exifPtr) readIfd(exifPtr, 'exif');
    if (kind === 'ifd0' && gpsPtr) readGps(gpsPtr);
    if (kind === 'exif') { /* nested done */ }
  };
  const readGps = (off) => {
    if (off <= 0 || off + 2 > buf.length) return;
    const count = u16(off);
    let latRef = 'N', lonRef = 'E', lat = null, lon = null;
    const dms = (valOff) => { const p = u32(valOff); if (p + 24 > buf.length) return null; const d = u32(p) / (u32(p + 4) || 1); const m = u32(p + 8) / (u32(p + 12) || 1); const s = u32(p + 16) / (u32(p + 20) || 1); return d + m / 60 + s / 3600; };
    for (let i = 0; i < count; i++) {
      const e = off + 2 + i * 12; if (e + 12 > buf.length) break;
      const tag = u16(e); const valOff = e + 8;
      if (tag === 1) latRef = buf.toString('latin1', valOff, valOff + 1);
      else if (tag === 2) lat = dms(valOff);
      else if (tag === 3) lonRef = buf.toString('latin1', valOff, valOff + 1);
      else if (tag === 4) lon = dms(valOff);
    }
    if (lat != null) out.GPSLat = latRef === 'S' ? -lat : lat;
    if (lon != null) out.GPSLon = lonRef === 'W' ? -lon : lon;
  };
  const ifd0 = u32(4);
  readIfd(ifd0, 'ifd0');
  return out;
}

function fmtExifDate(s) { if (!s) return null; const m = s.match(/(\d{4}):(\d{2}):(\d{2})\s+(\d{2}:\d{2}:\d{2})/); return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}` : s; }
function pitchFromModel(model) { if (!model) return null; for (const [re, p] of SENSOR_PITCH_UM) if (re.test(String(model))) return p; return null; }
function num(v) { const n = typeof v === 'number' ? v : Number(v); return Number.isFinite(n) ? n : null; }
