// ═══════════════════════════════════════════════════════════════════════════
// rawler_probe — decoder-cutover #14 PRE-STAGE library
// ═══════════════════════════════════════════════════════════════════════════
// Committed replacement for the throwaway overnight row-91 rawler spike. Decodes
// a Canon CR2 with rawler 0.7.2 and reports the FULL raw-CFA contract the cutover
// will consume: full-frame dims, CFA pattern, per-channel black/white levels, WB
// coeffs, active-area / recommended-crop rects, the optical-black mask areas
// (synthetic-dark anchor data — DARK_CALIBRATION_POLICY §1 "Reading B"), and an
// LE-u16 md5 of the raw mosaic so the decode can be checked bit-for-bit.
//
// DECODE ENTRY = `RawSource::new_from_slice(&[u8])` (buffer-based, NO mmap, NO
// filesystem) -> the SAME function runs natively (ground-truth arbiter, main.rs)
// AND compiles to wasm32-unknown-unknown (the cutover target). Nothing here is
// imported by src/ — the live decode path stays byte-identical by construction.
//
// wasm32 notes (verified for the cutover, see README):
//   * uuid v4 -> getrandom needs the browser backend on wasm32-unknown-unknown;
//     Cargo.toml enables uuid's "js" feature (the row-91 "sole fix"). getrandom
//     is only reached for uuid v4 generation, never on the CR2 decode hot path.
//   * memmap2 compiles via its stub.rs on non-unix/windows targets; the mmap
//     path is never taken because we decode from a slice.
//   * rayon (used by rawler's parallel iterators) auto-degrades to a single
//     thread on wasm via rayon-core's built-in "Unsupported spawn" fallback.

use rawler::decoders::RawDecodeParams;
use rawler::rawsource::RawSource;
use rawler::RawImageData;

/// A sensor optical-black / active rectangle in full-frame pixel coordinates.
#[derive(Debug, Clone, Copy)]
pub struct RectReport {
    pub x: usize,
    pub y: usize,
    pub w: usize,
    pub h: usize,
}

/// The full decode contract for one raw frame (decoder-cutover #14 target shape).
#[derive(Debug, Clone)]
pub struct ProbeReport {
    pub make: String,
    pub model: String,
    pub clean_make: String,
    pub clean_model: String,
    /// Full decoded frame dimensions (includes optical-black borders).
    pub width: usize,
    pub height: usize,
    /// Components per pixel (1 = Bayer CFA mosaic).
    pub cpp: usize,
    pub bps: usize,
    /// CFA pattern name at full-frame origin (e.g. "GBRG"), + tile dims.
    pub cfa_name: String,
    pub cfa_w: usize,
    pub cfa_h: usize,
    /// Per-channel black levels (bayer [R,G,B,E] / repeat-tile flattened).
    pub blacklevel: Vec<f32>,
    pub blacklevel_bayer: [f32; 4],
    pub blacklevel_dims: (usize, usize, usize), // (width, height, cpp) of the repeat tile
    /// Saturation / white levels (RGBE order or single).
    pub whitelevel: Vec<u32>,
    /// White-balance multipliers as encoded in the file (RGBE order).
    pub wb_coeffs: [f32; 4],
    /// Usable (non-black) area — the active-area crop.
    pub active_area: Option<RectReport>,
    /// Recommended display crop.
    pub crop_area: Option<RectReport>,
    /// Optical-black mask rectangles (bias/dark anchor source; may be empty).
    pub black_areas: Vec<RectReport>,
    // (OB per-area first-look stats live in `black_area_stats` below.)
    /// Raw mosaic stats over the full frame.
    pub data_len: usize,
    pub data_is_integer: bool,
    pub min: u16,
    pub max: u16,
    pub mean: f64,
    /// md5 of the full-frame mosaic serialized as little-endian u16 bytes.
    pub fullframe_cfa_le_u16_md5: String,
    /// Per-black-area OB first-look stats (synthetic-dark anchor; ITEM C).
    pub black_area_stats: Vec<BlackAreaStat>,
}

/// Optical-black region first-look statistics (bias/dark anchor, DARK_CALIBRATION
/// _POLICY.md "Reading B"). Raw ADU (no black subtraction). `std` = population std
/// (read-noise + FPN proxy); `row_gradient` = mean(top 10% rows) − mean(bottom 10%
/// rows) of the OB strip (flags a vertical bias gradient / amp glow).
#[derive(Debug, Clone)]
pub struct BlackAreaStat {
    pub idx: usize,
    pub rect: RectReport,
    pub mean: f64,
    pub std: f64,
    pub min: u16,
    pub max: u16,
    pub n: usize,
    pub row_gradient: f64,
}

fn to_rect(r: &rawler::imgop::Rect) -> RectReport {
    RectReport { x: r.p.x, y: r.p.y, w: r.d.w, h: r.d.h }
}

/// Decode `bytes` (a full CR2/raw file) and produce the cutover contract report.
/// Buffer-based (no mmap / no fs) so it is wasm32-safe and native-identical.
pub fn probe_from_bytes(bytes: &[u8]) -> Result<ProbeReport, String> {
    let src = RawSource::new_from_slice(bytes);
    let img = rawler::decode(&src, &RawDecodeParams::default()).map_err(|e| format!("rawler decode error: {e:?}"))?;

    let (data_u16, is_int): (Vec<u16>, bool) = match &img.data {
        RawImageData::Integer(v) => (v.clone(), true),
        RawImageData::Float(v) => (v.iter().map(|f| f.round().clamp(0.0, 65535.0) as u16).collect(), false),
    };

    // Full-frame mosaic stats.
    let mut min = u16::MAX;
    let mut max = 0u16;
    let mut sum: u64 = 0;
    for &v in &data_u16 {
        if v < min { min = v; }
        if v > max { max = v; }
        sum += v as u64;
    }
    let n = data_u16.len().max(1);
    let mean = sum as f64 / n as f64;

    // LE-u16 byte serialization (portable; matches the JS Buffer(u16 LE) ground truth).
    let mut le_bytes = Vec::with_capacity(data_u16.len() * 2);
    for &v in &data_u16 {
        le_bytes.push((v & 0xff) as u8);
        le_bytes.push((v >> 8) as u8);
    }
    let digest = md5::compute(&le_bytes);
    let md5_hex = format!("{digest:x}");

    let black_areas: Vec<RectReport> = img.blackareas.iter().map(to_rect).collect();

    // OB first-look: mean / std (noise) / min / max / n + vertical row-gradient
    // per black area over the raw mosaic. Two passes (mean, then variance) for
    // numerical stability; row-band means captured for the gradient probe.
    let width = img.width;
    let mut black_area_stats = Vec::new();
    for (bi, ba) in black_areas.iter().enumerate() {
        let y0 = ba.y;
        let y1 = (ba.y + ba.h).min(img.height);
        let x0 = ba.x;
        let x1 = (ba.x + ba.w).min(width);
        let mut bmin = u16::MAX;
        let mut bmax = 0u16;
        let mut bsum: u64 = 0;
        let mut cnt: usize = 0;
        // per-row sums for the gradient probe
        let mut row_means: Vec<f64> = Vec::new();
        for row in y0..y1 {
            let base = row * width;
            let mut rsum: u64 = 0;
            let mut rcnt: usize = 0;
            for col in x0..x1 {
                let idx = base + col;
                let v = data_u16[idx];
                if v < bmin { bmin = v; }
                if v > bmax { bmax = v; }
                bsum += v as u64;
                cnt += 1;
                rsum += v as u64;
                rcnt += 1;
            }
            if rcnt > 0 { row_means.push(rsum as f64 / rcnt as f64); }
        }
        if cnt > 0 {
            let mean = bsum as f64 / cnt as f64;
            // variance pass
            let mut var_acc: f64 = 0.0;
            for row in y0..y1 {
                let base = row * width;
                for col in x0..x1 {
                    let d = data_u16[base + col] as f64 - mean;
                    var_acc += d * d;
                }
            }
            let std = (var_acc / cnt as f64).sqrt();
            // vertical gradient: mean(top 10% rows) - mean(bottom 10% rows)
            let nr = row_means.len();
            let band = (nr / 10).max(1);
            let top: f64 = row_means.iter().take(band).sum::<f64>() / band as f64;
            let bot: f64 = row_means.iter().rev().take(band).sum::<f64>() / band as f64;
            black_area_stats.push(BlackAreaStat { idx: bi, rect: *ba, mean, std, min: bmin, max: bmax, n: cnt, row_gradient: top - bot });
        } else {
            black_area_stats.push(BlackAreaStat { idx: bi, rect: *ba, mean: 0.0, std: 0.0, min: 0, max: 0, n: 0, row_gradient: 0.0 });
        }
    }

    Ok(ProbeReport {
        make: img.make.clone(),
        model: img.model.clone(),
        clean_make: img.clean_make.clone(),
        clean_model: img.clean_model.clone(),
        width: img.width,
        height: img.height,
        cpp: img.cpp,
        bps: img.bps,
        cfa_name: img.camera.cfa.name.clone(),
        cfa_w: img.camera.cfa.width,
        cfa_h: img.camera.cfa.height,
        blacklevel: img.blacklevel.as_vec(),
        blacklevel_bayer: img.blacklevel.as_bayer_array(),
        blacklevel_dims: (img.blacklevel.width, img.blacklevel.height, img.blacklevel.cpp),
        whitelevel: img.whitelevel.0.clone(),
        wb_coeffs: img.wb_coeffs,
        active_area: img.active_area.as_ref().map(to_rect),
        crop_area: img.crop_area.as_ref().map(to_rect),
        black_areas,
        data_len: data_u16.len(),
        data_is_integer: is_int,
        min,
        max,
        mean,
        fullframe_cfa_le_u16_md5: md5_hex,
        black_area_stats,
    })
}

/// DETERMINISTIC INTEGER (fixed-point u16) bilinear demosaic -> L = R+G+B luma
/// (u32), serialized LE. Ported from the verified JS reference kernel
/// (tools/rawlab/demosaic_reference.mjs `demosaicIntegerLuma`) into the crate that
/// the cutover will own (LAW 4 incubator->port). Sums of <=4 u16 fit in u32; /2
/// and /4 are rounded integer shifts -> bit-identical on any integer engine (GPU
/// port safe). Pattern taken from rawler's authoritative `cfa.color_at`. Runs over
/// the FULL-frame raw CFA (no black-subtraction) so it is a pure, reproducible
/// function of the decode — the golden vector, NOT a science-calibrated develop.
pub fn integer_demosaic_luma_le(bytes: &[u8]) -> Result<(usize, usize, Vec<u8>), String> {
    let src = RawSource::new_from_slice(bytes);
    let img = rawler::decode(&src, &RawDecodeParams::default()).map_err(|e| format!("rawler decode error: {e:?}"))?;
    let data: Vec<u16> = match &img.data {
        RawImageData::Integer(v) => v.clone(),
        RawImageData::Float(v) => v.iter().map(|f| f.round().clamp(0.0, 65535.0) as u16).collect(),
    };
    let w = img.width;
    let h = img.height;
    if w == 0 || h == 0 || data.len() < w * h {
        return Err(format!("bad dims {w}x{h} vs data {}", data.len()));
    }
    let cfa = &img.camera.cfa;
    // 2x2 pattern lookup (0=R,1=G,2=B), phase = (y&1)*2 + (x&1).
    let pat = [cfa.color_at(0, 0), cfa.color_at(0, 1), cfa.color_at(1, 0), cfa.color_at(1, 1)];
    let n = w * h;
    // scatter native photosite into per-color plane
    let mut r = vec![0u16; n];
    let mut g = vec![0u16; n];
    let mut b = vec![0u16; n];
    for y in 0..h {
        let row = y * w;
        let pr = (y & 1) * 2;
        for x in 0..w {
            let c = pat[pr + (x & 1)];
            let v = data[row + x];
            match c { 0 => r[row + x] = v, 1 => g[row + x] = v, _ => b[row + x] = v }
        }
    }
    // locate R and B phase within the 2x2 tile
    let p_r = pat.iter().position(|&c| c == 0).unwrap_or(0);
    let p_b = pat.iter().position(|&c| c == 2).unwrap_or(3);
    let (ry, rx) = (p_r >> 1, p_r & 1);
    let (by, bx) = (p_b >> 1, p_b & 1);
    let clx = |x: isize| -> usize { if x < 0 { 0 } else if x as usize >= w { w - 1 } else { x as usize } };
    let cly = |y: isize| -> usize { if y < 0 { 0 } else if y as usize >= h { h - 1 } else { y as usize } };
    let d2 = |a: u16, b2: u16| -> u32 { (a as u32 + b2 as u32 + 1) >> 1 };
    let d4 = |a: u16, b2: u16, c2: u16, dd: u16| -> u32 { (a as u32 + b2 as u32 + c2 as u32 + dd as u32 + 2) >> 2 };

    let mut out = Vec::with_capacity(n * 4);
    for y in 0..h {
        let row = y * w;
        let yu = cly(y as isize - 1) * w;
        let yd = cly(y as isize + 1) * w;
        let yp = y & 1;
        for x in 0..w {
            let xp = x & 1;
            let c = pat[yp * 2 + xp];
            let xl = clx(x as isize - 1);
            let xr = clx(x as isize + 1);
            // G plane
            let gg = if c == 1 { g[row + x] as u32 } else { d4(g[yu + x], g[yd + x], g[row + xl], g[row + xr]) };
            // R plane
            let rr = if yp == ry && xp == rx { r[row + x] as u32 }
                else if yp == by && xp == bx { d4(r[yu + xl], r[yu + xr], r[yd + xl], r[yd + xr]) }
                else if yp == ry { d2(r[row + xl], r[row + xr]) }
                else { d2(r[yu + x], r[yd + x]) };
            // B plane
            let bb = if yp == by && xp == bx { b[row + x] as u32 }
                else if yp == ry && xp == rx { d4(b[yu + xl], b[yu + xr], b[yd + xl], b[yd + xr]) }
                else if yp == by { d2(b[row + xl], b[row + xr]) }
                else { d2(b[yu + x], b[yd + x]) };
            let l = rr + gg + bb;
            out.push((l & 0xff) as u8);
            out.push(((l >> 8) & 0xff) as u8);
            out.push(((l >> 16) & 0xff) as u8);
            out.push(((l >> 24) & 0xff) as u8);
        }
    }
    Ok((w, h, out))
}

/// Period-2 parity power (checker/row/col), normalized by mean, mirroring the JS
/// reference (`tools/rawlab/demosaic_reference.mjs::parity`). Measured on the
/// BLACK-SUBTRACTED domain (per-phase pedestal removed) so the rawler-arm numbers
/// are comparable to the libraw-arm (which is already ~0-black). Reports the raw
/// CFA mosaic (before demosaic) vs the integer-demosaic luma (after) + reductions.
#[derive(Debug, Clone)]
pub struct ParityReport {
    pub mean: f64,
    pub checker: f64,
    pub row_parity: f64,
    pub col_parity: f64,
}

#[derive(Debug, Clone)]
pub struct ParityAB {
    pub width: usize,
    pub height: usize,
    pub black_bayer: [f32; 4],
    pub raw_cfa: ParityReport,
    pub demosaic_luma: ParityReport,
    pub checker_reduction_pct: f64,
    pub row_reduction_pct: f64,
    pub col_reduction_pct: f64,
}

fn parity_of(l: &[i64], w: usize, h: usize) -> ParityReport {
    let mut sum: i128 = 0;
    let mut checker: i128 = 0;
    let mut rowp: i128 = 0;
    let mut colp: i128 = 0;
    let mut n: i128 = 0;
    for y in 0..h {
        let yodd = y & 1;
        for x in 0..w {
            let v = l[y * w + x] as i128;
            sum += v;
            n += 1;
            checker += if (x + y) & 1 == 1 { -v } else { v };
            rowp += if yodd == 1 { -v } else { v };
            colp += if (x & 1) == 1 { -v } else { v };
        }
    }
    let n_f = n.max(1) as f64;
    let mean = sum as f64 / n_f;
    let denom = mean.abs().max(1e-9);
    ParityReport {
        mean,
        checker: (checker as f64 / n_f).abs() / denom,
        row_parity: (rowp as f64 / n_f).abs() / denom,
        col_parity: (colp as f64 / n_f).abs() / denom,
    }
}

pub fn parity_metrics(bytes: &[u8]) -> Result<ParityAB, String> {
    let src = RawSource::new_from_slice(bytes);
    let img = rawler::decode(&src, &RawDecodeParams::default()).map_err(|e| format!("rawler decode error: {e:?}"))?;
    let data: Vec<u16> = match &img.data {
        RawImageData::Integer(v) => v.clone(),
        RawImageData::Float(v) => v.iter().map(|f| f.round().clamp(0.0, 65535.0) as u16).collect(),
    };
    let w = img.width;
    let h = img.height;
    if w == 0 || h == 0 || data.len() < w * h {
        return Err(format!("bad dims {w}x{h} vs data {}", data.len()));
    }
    let cfa = &img.camera.cfa;
    let pat = [cfa.color_at(0, 0), cfa.color_at(0, 1), cfa.color_at(1, 0), cfa.color_at(1, 1)];
    let black = img.blacklevel.as_bayer_array();
    let n = w * h;

    // per-phase black-subtracted planes + raw-CFA (black-subtracted) mosaic
    let mut r = vec![0i64; n];
    let mut g = vec![0i64; n];
    let mut b = vec![0i64; n];
    let mut cfa_bs = vec![0i64; n];
    for y in 0..h {
        let row = y * w;
        let pr = (y & 1) * 2;
        for x in 0..w {
            let phase = pr + (x & 1);
            let c = pat[phase];
            let bl = black[phase] as i64;
            let v = (data[row + x] as i64 - bl).max(0);
            cfa_bs[row + x] = v;
            match c { 0 => r[row + x] = v, 1 => g[row + x] = v, _ => b[row + x] = v }
        }
    }
    let p_r = pat.iter().position(|&c| c == 0).unwrap_or(0);
    let p_b = pat.iter().position(|&c| c == 2).unwrap_or(3);
    let (ry, rx) = (p_r >> 1, p_r & 1);
    let (by, bx) = (p_b >> 1, p_b & 1);
    let clx = |x: isize| -> usize { if x < 0 { 0 } else if x as usize >= w { w - 1 } else { x as usize } };
    let cly = |y: isize| -> usize { if y < 0 { 0 } else if y as usize >= h { h - 1 } else { y as usize } };
    let d2 = |a: i64, b2: i64| -> i64 { (a + b2 + 1) >> 1 };
    let d4 = |a: i64, b2: i64, c2: i64, dd: i64| -> i64 { (a + b2 + c2 + dd + 2) >> 2 };

    let mut luma = vec![0i64; n];
    for y in 0..h {
        let row = y * w;
        let yu = cly(y as isize - 1) * w;
        let yd = cly(y as isize + 1) * w;
        let yp = y & 1;
        for x in 0..w {
            let xp = x & 1;
            let c = pat[yp * 2 + xp];
            let xl = clx(x as isize - 1);
            let xr = clx(x as isize + 1);
            let gg = if c == 1 { g[row + x] } else { d4(g[yu + x], g[yd + x], g[row + xl], g[row + xr]) };
            let rr = if yp == ry && xp == rx { r[row + x] }
                else if yp == by && xp == bx { d4(r[yu + xl], r[yu + xr], r[yd + xl], r[yd + xr]) }
                else if yp == ry { d2(r[row + xl], r[row + xr]) }
                else { d2(r[yu + x], r[yd + x]) };
            let bb = if yp == by && xp == bx { b[row + x] }
                else if yp == ry && xp == rx { d4(b[yu + xl], b[yu + xr], b[yd + xl], b[yd + xr]) }
                else if yp == by { d2(b[row + xl], b[row + xr]) }
                else { d2(b[yu + x], b[yd + x]) };
            luma[row + x] = rr + gg + bb;
        }
    }

    let raw = parity_of(&cfa_bs, w, h);
    let dem = parity_of(&luma, w, h);
    let red = |a: f64, b2: f64| -> f64 { if a > 0.0 { ((a - b2) / a) * 100.0 } else { 0.0 } };
    Ok(ParityAB {
        width: w,
        height: h,
        black_bayer: black,
        checker_reduction_pct: red(raw.checker, dem.checker),
        row_reduction_pct: red(raw.row_parity, dem.row_parity),
        col_reduction_pct: red(raw.col_parity, dem.col_parity),
        raw_cfa: raw,
        demosaic_luma: dem,
    })
}

/// The full-frame raw mosaic as LE-u16 bytes — used by main.rs to persist golden
/// vectors. Kept separate so the wasm lib need not always allocate the payload.
pub fn raw_cfa_le_u16(bytes: &[u8]) -> Result<(usize, usize, Vec<u8>), String> {
    let src = RawSource::new_from_slice(bytes);
    let img = rawler::decode(&src, &RawDecodeParams::default()).map_err(|e| format!("rawler decode error: {e:?}"))?;
    let data_u16: Vec<u16> = match &img.data {
        RawImageData::Integer(v) => v.clone(),
        RawImageData::Float(v) => v.iter().map(|f| f.round().clamp(0.0, 65535.0) as u16).collect(),
    };
    let mut le = Vec::with_capacity(data_u16.len() * 2);
    for &v in &data_u16 {
        le.push((v & 0xff) as u8);
        le.push((v >> 8) as u8);
    }
    Ok((img.width, img.height, le))
}
