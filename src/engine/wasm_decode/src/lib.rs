// ═══════════════════════════════════════════════════════════════════════════
// wasm_decode — rawler CFA decode rail (decoder-cutover #14, parallel rail)
// ═══════════════════════════════════════════════════════════════════════════
// Promotion of the pre-stage probe (tools/rawlab/rawler_probe — bit-identical
// vs the frozen ground truth, see test_results/decoder_prestage/PRESTAGE_REPORT
// .md) into a proper wasm package the engine can load. This crate is the
// FLAG-SELECTED arm of the m1 decode seam (VITE_DECODER_RAWLER): DEFAULT OFF,
// the live path stays libraw-wasm byte-identical until the cutover flips it.
//
// CONTRACT (owner ruling; LAW 7 boundary `rawler_cfa` in
// src/engine/contracts/binary_layouts.ts): FULL sensor frame including the
// optical-black borders (per-frame bias/dark anchor — DARK_CALIBRATION_POLICY
// §1 "Reading B"), per-channel black levels, white level, WB coeffs, active/
// crop rects, OB mask geometry. Decode entry = RawSource::new_from_slice
// (buffer-based, no mmap/fs) so ONE function runs native and on wasm32.
//
// wasm32 facts settled by the pre-stage (do not re-litigate):
//   * uuid needs the "js" feature (Cargo.toml) — the sole wasm32 compile fix.
//   * rayon auto-degrades to single-thread via rayon-core's Unsupported-spawn
//     fallback: blocking par_iters run sequentially + deterministically. No
//     wasm-bindgen-rayon, no manual pinning.
//   * memmap2 compiles via its stub; the slice path never mmaps.
//
// The integer u16 demosaic lives IN-CRATE (deterministic arm): exact port of
// the verified reference kernel (tools/rawlab/demosaic_reference.mjs →
// rawler_probe::integer_demosaic_luma_le). `demosaic_luma_full_le()` must
// reproduce the committed golden vector md5 (test_results/decoder_prestage/
// golden/IMG_1653.CR2.golden_manifest.json) bit-for-bit.

use rawler::decoders::RawDecodeParams;
use rawler::rawsource::RawSource;
use rawler::RawImageData;
use serde::Serialize;
use wasm_bindgen::prelude::*;

#[derive(Serialize, Clone, Copy)]
struct RectJson {
    x: usize,
    y: usize,
    w: usize,
    h: usize,
}

/// Decode metadata serialized to JSON at the wasm boundary (numbers/strings
/// only; WB NaN channels are mapped to null — schema-draft rule).
#[derive(Serialize)]
struct MetaJson {
    decoder: &'static str,
    make: String,
    model: String,
    clean_make: String,
    clean_model: String,
    /// FULL decoded frame dims (includes optical-black borders).
    width: usize,
    height: usize,
    cpp: usize,
    bps: usize,
    /// CFA pattern name at FULL-frame origin (e.g. "GBRG").
    cfa_pattern_full: String,
    /// CFA pattern read at the ACTIVE-AREA origin (phase-shifted view a
    /// consumer sees if it crops the mosaic to the active rect).
    cfa_pattern_active: String,
    /// 2x2 tile colors at full-frame origin, phase = (y&1)*2 + (x&1); 0=R,1=G,2=B.
    cfa_tile: [usize; 4],
    /// Per-channel black levels (repeat-tile flattened + bayer [R,G,B,E]).
    blacklevel: Vec<f32>,
    blacklevel_bayer: [f32; 4],
    /// Saturation / white level(s).
    whitelevel: Vec<u32>,
    /// WB multipliers (RGBE order); NaN (absent E channel) → null.
    wb_coeffs: [Option<f32>; 4],
    active_area: Option<RectJson>,
    crop_area: Option<RectJson>,
    /// Optical-black mask rectangles (bias/dark anchor source; may be empty).
    black_areas: Vec<RectJson>,
    data_is_integer: bool,
}

fn to_rect(r: &rawler::imgop::Rect) -> RectJson {
    RectJson { x: r.p.x, y: r.p.y, w: r.d.w, h: r.d.h }
}

const COLOR_CHARS: [char; 4] = ['R', 'G', 'B', 'E'];

fn pattern_at(pat: &[usize; 4], oy: usize, ox: usize) -> String {
    // 2x2 pattern string read starting at absolute origin (oy, ox).
    let mut s = String::with_capacity(4);
    for dy in 0..2usize {
        for dx in 0..2usize {
            let c = pat[(((oy + dy) & 1) * 2) + ((ox + dx) & 1)];
            s.push(*COLOR_CHARS.get(c).unwrap_or(&'?'));
        }
    }
    s
}

/// One decoded raw frame. Holds the full-frame u16 mosaic; every accessor is a
/// pure function of that single decode (no re-decode per call).
#[wasm_bindgen]
pub struct DecodedRaw {
    width: usize,
    height: usize,
    data: Vec<u16>,
    /// 2x2 CFA tile at full-frame origin, phase = (y&1)*2 + (x&1); 0=R,1=G,2=B.
    pat: [usize; 4],
    /// Active area (x, y, w, h); defaults to the full frame when absent.
    active: (usize, usize, usize, usize),
    ob_areas: Vec<(usize, usize, usize, usize)>,
    meta_json: String,
}

/// Decode a full RAW file buffer (CR2 today; anything rawler supports) into the
/// rawler_cfa contract. Errors are surfaced as JS exceptions with the rawler
/// error text — the TS seam maps them to the m1 null-on-failure contract.
#[wasm_bindgen]
pub fn decode_raw(bytes: &[u8]) -> Result<DecodedRaw, JsError> {
    let src = RawSource::new_from_slice(bytes);
    let img = rawler::decode(&src, &RawDecodeParams::default())
        .map_err(|e| JsError::new(&format!("rawler decode error: {e:?}")))?;

    let (data, is_int): (Vec<u16>, bool) = match img.data {
        RawImageData::Integer(v) => (v, true),
        RawImageData::Float(v) => (
            v.iter().map(|f| f.round().clamp(0.0, 65535.0) as u16).collect(),
            false,
        ),
    };

    let width = img.width;
    let height = img.height;
    if width == 0 || height == 0 || data.len() < width * height {
        return Err(JsError::new(&format!(
            "bad dims {width}x{height} vs data {}",
            data.len()
        )));
    }

    let cfa = &img.camera.cfa;
    let pat = [cfa.color_at(0, 0), cfa.color_at(0, 1), cfa.color_at(1, 0), cfa.color_at(1, 1)];

    let active = match img.active_area.as_ref() {
        Some(r) => (r.p.x, r.p.y, r.d.w, r.d.h),
        None => (0, 0, width, height),
    };

    let ob_areas: Vec<(usize, usize, usize, usize)> = img
        .blackareas
        .iter()
        .map(|r| (r.p.x, r.p.y, r.d.w, r.d.h))
        .collect();

    let wb = img.wb_coeffs;
    let meta = MetaJson {
        decoder: "rawler-0.7.2",
        make: img.make.clone(),
        model: img.model.clone(),
        clean_make: img.clean_make.clone(),
        clean_model: img.clean_model.clone(),
        width,
        height,
        cpp: img.cpp,
        bps: img.bps,
        cfa_pattern_full: pattern_at(&pat, 0, 0),
        cfa_pattern_active: pattern_at(&pat, active.1, active.0),
        cfa_tile: pat,
        blacklevel: img.blacklevel.as_vec(),
        blacklevel_bayer: img.blacklevel.as_bayer_array(),
        whitelevel: img.whitelevel.0.clone(),
        wb_coeffs: [
            if wb[0].is_finite() { Some(wb[0]) } else { None },
            if wb[1].is_finite() { Some(wb[1]) } else { None },
            if wb[2].is_finite() { Some(wb[2]) } else { None },
            if wb[3].is_finite() { Some(wb[3]) } else { None },
        ],
        active_area: img.active_area.as_ref().map(to_rect),
        crop_area: img.crop_area.as_ref().map(to_rect),
        black_areas: img.blackareas.iter().map(to_rect).collect(),
        data_is_integer: is_int,
    };
    let meta_json = serde_json::to_string(&meta)
        .map_err(|e| JsError::new(&format!("meta serialize error: {e}")))?;

    Ok(DecodedRaw { width, height, data, pat, active, ob_areas, meta_json })
}

/// Scatter the mosaic into per-color planes (0=R,1=G,2=B; E folds into B like
/// the reference kernel's `_ =>` arm). Shared by both demosaic kernels so the
/// full-frame golden arm and the active-window pipeline arm cannot diverge.
fn scatter_planes(data: &[u16], w: usize, h: usize, pat: &[usize; 4]) -> (Vec<u16>, Vec<u16>, Vec<u16>) {
    let n = w * h;
    let mut r = vec![0u16; n];
    let mut g = vec![0u16; n];
    let mut b = vec![0u16; n];
    for y in 0..h {
        let row = y * w;
        let pr = (y & 1) * 2;
        for x in 0..w {
            let c = pat[pr + (x & 1)];
            let v = data[row + x];
            match c {
                0 => r[row + x] = v,
                1 => g[row + x] = v,
                _ => b[row + x] = v,
            }
        }
    }
    (r, g, b)
}

#[inline]
fn d2(a: u16, b: u16) -> u32 {
    (a as u32 + b as u32 + 1) >> 1
}
#[inline]
fn d4(a: u16, b: u16, c: u16, d: u16) -> u32 {
    (a as u32 + b as u32 + c as u32 + d as u32 + 2) >> 2
}

/// Interpolate R/G/B at absolute pixel (y, x) with neighbor coords clamped to
/// the window [wx0,wx1)×[wy0,wy1). Integer bilinear, rounded /2 and /4 shifts —
/// bit-identical on any integer engine. Exact port of the reference kernel
/// (rawler_probe::integer_demosaic_luma_le), with the clamp bounds generalized
/// from the full frame to a window (full frame ⇒ identical behavior).
#[allow(clippy::too_many_arguments)]
#[inline]
fn interp_rgb(
    r: &[u16],
    g: &[u16],
    b: &[u16],
    pat: &[usize; 4],
    w: usize,
    y: usize,
    x: usize,
    wx0: usize,
    wx1: usize,
    wy0: usize,
    wy1: usize,
    rp: (usize, usize),
    bp: (usize, usize),
) -> (u32, u32, u32) {
    let (ry, rx) = rp;
    let (by, bx) = bp;
    let yp = y & 1;
    let xp = x & 1;
    let c = pat[yp * 2 + xp];
    let xl = if x > wx0 { x - 1 } else { wx0 };
    let xr = if x + 1 < wx1 { x + 1 } else { wx1 - 1 };
    let yu = (if y > wy0 { y - 1 } else { wy0 }) * w;
    let yd = (if y + 1 < wy1 { y + 1 } else { wy1 - 1 }) * w;
    let row = y * w;

    let gg = if c == 1 {
        g[row + x] as u32
    } else {
        d4(g[yu + x], g[yd + x], g[row + xl], g[row + xr])
    };
    let rr = if yp == ry && xp == rx {
        r[row + x] as u32
    } else if yp == by && xp == bx {
        d4(r[yu + xl], r[yu + xr], r[yd + xl], r[yd + xr])
    } else if yp == ry {
        d2(r[row + xl], r[row + xr])
    } else {
        d2(r[yu + x], r[yd + x])
    };
    let bb = if yp == by && xp == bx {
        b[row + x] as u32
    } else if yp == ry && xp == rx {
        d4(b[yu + xl], b[yu + xr], b[yd + xl], b[yd + xr])
    } else if yp == by {
        d2(b[row + xl], b[row + xr])
    } else {
        d2(b[yu + x], b[yd + x])
    };
    (rr, gg, bb)
}

#[wasm_bindgen]
impl DecodedRaw {
    /// Full decoded frame width (includes OB borders).
    #[wasm_bindgen(getter)]
    pub fn width(&self) -> u32 {
        self.width as u32
    }
    /// Full decoded frame height (includes OB borders).
    #[wasm_bindgen(getter)]
    pub fn height(&self) -> u32 {
        self.height as u32
    }
    #[wasm_bindgen(getter)]
    pub fn active_x(&self) -> u32 {
        self.active.0 as u32
    }
    #[wasm_bindgen(getter)]
    pub fn active_y(&self) -> u32 {
        self.active.1 as u32
    }
    #[wasm_bindgen(getter)]
    pub fn active_w(&self) -> u32 {
        self.active.2 as u32
    }
    #[wasm_bindgen(getter)]
    pub fn active_h(&self) -> u32 {
        self.active.3 as u32
    }

    /// Decode metadata as JSON (see MetaJson; WB NaN → null).
    pub fn meta_json(&self) -> String {
        self.meta_json.clone()
    }

    /// FULL-frame raw CFA mosaic (u16, cpp=1, length = width*height, row-major,
    /// index = y*width + x). Raw ADU with the black pedestal — NOT black-
    /// subtracted, NOT scaled. LAW 7 boundary `rawler_cfa`.
    pub fn cfa_full(&self) -> Vec<u16> {
        self.data.clone()
    }

    /// Deterministic integer-bilinear demosaic over the ACTIVE AREA: interleaved
    /// RGB16 (u16 ×3 per pixel, length = active_w*active_h*3), raw-ADU domain
    /// (no black subtraction, no scaling). Neighbor clamping happens at the
    /// ACTIVE-AREA boundary so optical-black border values never bleed into
    /// science pixels. CFA phase is taken from ABSOLUTE full-frame coordinates,
    /// so the crop is phase-correct for any active-area origin.
    pub fn rgb16_active(&self) -> Vec<u16> {
        let (ax, ay, aw, ah) = self.active;
        let w = self.width;
        let (r, g, b) = scatter_planes(&self.data, w, self.height, &self.pat);
        let p_r = self.pat.iter().position(|&c| c == 0).unwrap_or(0);
        let p_b = self.pat.iter().position(|&c| c == 2).unwrap_or(3);
        let rp = (p_r >> 1, p_r & 1);
        let bp = (p_b >> 1, p_b & 1);
        let (wx0, wx1) = (ax, ax + aw);
        let (wy0, wy1) = (ay, ay + ah);
        let mut out = Vec::with_capacity(aw * ah * 3);
        for y in wy0..wy1 {
            for x in wx0..wx1 {
                let (rr, gg, bb) =
                    interp_rgb(&r, &g, &b, &self.pat, w, y, x, wx0, wx1, wy0, wy1, rp, bp);
                // Averages of u16 stay within u16 range.
                out.push(rr as u16);
                out.push(gg as u16);
                out.push(bb as u16);
            }
        }
        out
    }

    /// GOLDEN-VECTOR arm: full-frame integer-demosaic luma L=R+G+B as u32
    /// little-endian bytes — must reproduce the committed golden manifest md5
    /// (pre-stage: 4f7560079a37316dae7595006bc46e1f for bundled IMG_1653).
    /// Clamps at FULL-frame edges (the golden was captured full-frame).
    pub fn demosaic_luma_full_le(&self) -> Vec<u8> {
        let w = self.width;
        let h = self.height;
        let (r, g, b) = scatter_planes(&self.data, w, h, &self.pat);
        let p_r = self.pat.iter().position(|&c| c == 0).unwrap_or(0);
        let p_b = self.pat.iter().position(|&c| c == 2).unwrap_or(3);
        let rp = (p_r >> 1, p_r & 1);
        let bp = (p_b >> 1, p_b & 1);
        let mut out = Vec::with_capacity(w * h * 4);
        for y in 0..h {
            for x in 0..w {
                let (rr, gg, bb) =
                    interp_rgb(&r, &g, &b, &self.pat, w, y, x, 0, w, 0, h, rp, bp);
                let l = rr + gg + bb;
                out.extend_from_slice(&l.to_le_bytes());
            }
        }
        out
    }

    /// FULL-frame raw CFA serialized as u16 little-endian bytes — must reproduce
    /// the committed golden manifest md5 (968381f814547668c6a85b75f31038f2 for
    /// bundled IMG_1653). Explicit LE so the hash is portable.
    pub fn cfa_full_le(&self) -> Vec<u8> {
        let mut le = Vec::with_capacity(self.data.len() * 2);
        for &v in &self.data {
            le.push((v & 0xff) as u8);
            le.push((v >> 8) as u8);
        }
        le
    }

    /// Number of optical-black mask areas reported by rawler.
    pub fn ob_area_count(&self) -> u32 {
        self.ob_areas.len() as u32
    }

    /// Raw CFA pixels of OB mask area `idx` (row-major within the rect, raw ADU)
    /// — the per-frame bias/dark anchor harvest (DARK_CALIBRATION_POLICY §1,
    /// Reading B). Record-only at this stage: no engine consumer is wired.
    pub fn ob_pixels(&self, idx: u32) -> Vec<u16> {
        let Some(&(x, y, w, h)) = self.ob_areas.get(idx as usize) else {
            return Vec::new();
        };
        let x1 = (x + w).min(self.width);
        let y1 = (y + h).min(self.height);
        let mut out = Vec::with_capacity(w * h);
        for row in y..y1 {
            let base = row * self.width;
            out.extend_from_slice(&self.data[base + x..base + x1]);
        }
        out
    }
}
