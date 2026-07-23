// ═══════════════════════════════════════════════════════════════════════════
// rawler_probe (native binary) — decoder-cutover #14 pre-stage harness
// ═══════════════════════════════════════════════════════════════════════════
//   cargo run --release --bin probe -- <file.CR2> [--golden <outdir>]
//
// Decodes the raw with rawler 0.7.2 via the SAME buffer-based `probe_from_bytes`
// the wasm lib exposes, prints a JSON report, and (for the bundled IMG_1653)
// compares every field to the frozen overnight row-91 ground truth so a MATCH /
// MISMATCH verdict is machine-readable. `--golden <dir>` writes the raw full-frame
// CFA (LE-u16) + a manifest for the cutover's layout-contract golden battery.
//
// Reads the raw file into an owned Vec<u8> (NO mmap) so the decode path is
// byte-identical to the wasm32 target. Never prints raw pixel bytes to stdout.

use std::fs;
use std::path::Path;
use rawler_probe::{probe_from_bytes, raw_cfa_le_u16, integer_demosaic_luma_le, parity_metrics, ProbeReport, RectReport};

// Frozen ground truth for the bundled CR2 (tools/rawlab/libraw_cfa_hash.mjs:22-26,
// overnight row-91 rawler spike). MISMATCH here is a FINDING, not a failure.
const GT_FULL: (usize, usize) = (5344, 3516);
const GT_CFA: &str = "GBRG";
const GT_BLACK: [f32; 4] = [2046.0, 2046.0, 2049.0, 2049.0];
const GT_WHITE: u32 = 15094;
const GT_ACTIVE: (usize, usize) = (5202, 3465);
const GT_CROP: (usize, usize) = (5184, 3456);
const GT_MD5: &str = "968381f814547668c6a85b75f31038f2";
const GT_MIN: u16 = 1;
const GT_MAX: u16 = 15935;
const GT_MEAN: f64 = 2618.13;

fn rect_json(r: &Option<RectReport>) -> String {
    match r {
        Some(v) => format!("{{\"x\":{},\"y\":{},\"w\":{},\"h\":{}}}", v.x, v.y, v.w, v.h),
        None => "null".to_string(),
    }
}

fn f32arr(a: &[f32]) -> String {
    // Emit `null` for non-finite (e.g. wb_coeffs[3]=NaN for RGGB's absent E
    // channel) so the report stays valid JSON.
    let parts: Vec<String> = a.iter().map(|v| if v.is_finite() { format!("{v}") } else { "null".to_string() }).collect();
    format!("[{}]", parts.join(","))
}

fn u32arr(a: &[u32]) -> String {
    let parts: Vec<String> = a.iter().map(|v| format!("{v}")).collect();
    format!("[{}]", parts.join(","))
}

fn is_bundled(path: &str) -> bool {
    let l = path.to_ascii_uppercase().replace('\\', "/");
    l.ends_with("IMG_1653.CR2")
}

fn report_json(rel: &str, r: &ProbeReport, parity_json: &str) -> String {
    let bundled = is_bundled(rel);
    let mut cmp = String::new();
    if bundled {
        let white_first = r.whitelevel.first().copied().unwrap_or(0);
        let md5_match = r.fullframe_cfa_le_u16_md5 == GT_MD5;
        let full_match = (r.width, r.height) == GT_FULL;
        let cfa_match = r.cfa_name == GT_CFA;
        let black_match = r.blacklevel_bayer == GT_BLACK;
        let white_match = white_first == GT_WHITE;
        let active_match = r.active_area.map(|a| (a.w, a.h)) == Some(GT_ACTIVE);
        let crop_match = r.crop_area.map(|a| (a.w, a.h)) == Some(GT_CROP);
        let stats_match = r.min == GT_MIN && r.max == GT_MAX && (r.mean - GT_MEAN).abs() < 0.5;
        let all = md5_match && full_match && cfa_match && black_match && white_match && active_match && crop_match && stats_match;
        cmp = format!(
            ",\n  \"ground_truth_comparison\": {{\n    \
             \"OVERALL\": \"{}\",\n    \
             \"full_dims\": {{\"got\":\"{}x{}\",\"gt\":\"{}x{}\",\"match\":{}}},\n    \
             \"cfa\": {{\"got\":\"{}\",\"gt\":\"{}\",\"match\":{}}},\n    \
             \"blacklevel_bayer\": {{\"got\":{},\"gt\":{},\"match\":{}}},\n    \
             \"whitelevel\": {{\"got\":{},\"gt\":{},\"match\":{}}},\n    \
             \"active_area\": {{\"got\":\"{}\",\"gt\":\"{}x{}\",\"match\":{}}},\n    \
             \"crop_area\": {{\"got\":\"{}\",\"gt\":\"{}x{}\",\"match\":{}}},\n    \
             \"md5\": {{\"got\":\"{}\",\"gt\":\"{}\",\"match\":{}}},\n    \
             \"stats\": {{\"got_min\":{},\"got_max\":{},\"got_mean\":{:.2},\"gt\":\"min {} max {} mean {}\",\"match\":{}}}\n  }}",
            if all { "MATCH" } else { "MISMATCH" },
            r.width, r.height, GT_FULL.0, GT_FULL.1, full_match,
            r.cfa_name, GT_CFA, cfa_match,
            f32arr(&r.blacklevel_bayer), f32arr(&GT_BLACK), black_match,
            white_first, GT_WHITE, white_match,
            r.active_area.map(|a| format!("{}x{}", a.w, a.h)).unwrap_or_else(|| "null".into()), GT_ACTIVE.0, GT_ACTIVE.1, active_match,
            r.crop_area.map(|a| format!("{}x{}", a.w, a.h)).unwrap_or_else(|| "null".into()), GT_CROP.0, GT_CROP.1, crop_match,
            r.fullframe_cfa_le_u16_md5, GT_MD5, md5_match,
            r.min, r.max, r.mean, GT_MIN, GT_MAX, GT_MEAN, stats_match,
        );
    }

    let ob: Vec<String> = r.black_area_stats.iter().map(|s| {
        format!("{{\"idx\":{},\"rect\":{{\"x\":{},\"y\":{},\"w\":{},\"h\":{}}},\"mean\":{:.3},\"std\":{:.3},\"min\":{},\"max\":{},\"n\":{},\"row_gradient\":{:.3}}}",
            s.idx, s.rect.x, s.rect.y, s.rect.w, s.rect.h, s.mean, s.std, s.min, s.max, s.n, s.row_gradient)
    }).collect();

    format!(
        "{{\n  \"file\": \"{}\",\n  \"make\": \"{}\",\n  \"model\": \"{}\",\n  \"clean\": \"{} {}\",\n  \
         \"full_dims\": \"{}x{}\",\n  \"cpp\": {},\n  \"bps\": {},\n  \
         \"cfa\": {{\"name\":\"{}\",\"w\":{},\"h\":{}}},\n  \
         \"blacklevel\": {{\"vec\":{},\"bayer\":{},\"tile_whc\":[{},{},{}]}},\n  \
         \"whitelevel\": {},\n  \"wb_coeffs\": {},\n  \
         \"active_area\": {},\n  \"crop_area\": {},\n  \
         \"data\": {{\"len\":{},\"integer\":{},\"min\":{},\"max\":{},\"mean\":{:.3}}},\n  \
         \"fullframe_cfa_le_u16_md5\": \"{}\",\n  \
         \"black_areas\": {},\n  \"black_area_stats\": [{}]{}\n}}",
        rel, r.make, r.model, r.clean_make, r.clean_model,
        r.width, r.height, r.cpp, r.bps,
        r.cfa_name, r.cfa_w, r.cfa_h,
        f32arr(&r.blacklevel), f32arr(&r.blacklevel_bayer), r.blacklevel_dims.0, r.blacklevel_dims.1, r.blacklevel_dims.2,
        u32arr(&r.whitelevel), f32arr(&r.wb_coeffs),
        rect_json(&r.active_area), rect_json(&r.crop_area),
        r.data_len, r.data_is_integer, r.min, r.max, r.mean,
        r.fullframe_cfa_le_u16_md5,
        r.black_areas.len(), ob.join(","),
        format!("{cmp}{parity_json}"),
    )
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let mut file: Option<String> = None;
    let mut golden: Option<String> = None;
    let mut want_parity = false;
    let mut i = 1;
    while i < args.len() {
        match args[i].as_str() {
            "--golden" => { golden = args.get(i + 1).cloned(); i += 2; }
            "--parity" => { want_parity = true; i += 1; }
            other => { file = Some(other.to_string()); i += 1; }
        }
    }
    let file = match file {
        Some(f) => f,
        None => { eprintln!("usage: probe <file.CR2> [--golden <outdir>]"); std::process::exit(2); }
    };

    let bytes = match fs::read(&file) {
        Ok(b) => b,
        Err(e) => { eprintln!("read error {file}: {e}"); std::process::exit(1); }
    };

    let report = match probe_from_bytes(&bytes) {
        Ok(r) => r,
        Err(e) => { eprintln!("DECODE FAILED for {file}: {e}"); std::process::exit(1); }
    };

    let rel = Path::new(&file).file_name().and_then(|s| s.to_str()).unwrap_or(&file).to_string();
    let parity_json = if want_parity {
        match parity_metrics(&bytes) {
            Ok(p) => format!(
                ",\n  \"parity\": {{\n    \"domain\": \"black-subtracted (per-phase pedestal removed); comparable to libraw ~0-black arm\",\n    \
                 \"raw_cfa\": {{\"mean\":{:.2},\"checker\":{:.6e},\"rowParity\":{:.6e},\"colParity\":{:.6e}}},\n    \
                 \"integer_demosaic_luma\": {{\"mean\":{:.2},\"checker\":{:.6e},\"rowParity\":{:.6e},\"colParity\":{:.6e}}},\n    \
                 \"checker_reduction_pct\": {:.1},\n    \"rowParity_reduction_pct\": {:.1},\n    \"colParity_reduction_pct\": {:.1}\n  }}",
                p.raw_cfa.mean, p.raw_cfa.checker, p.raw_cfa.row_parity, p.raw_cfa.col_parity,
                p.demosaic_luma.mean, p.demosaic_luma.checker, p.demosaic_luma.row_parity, p.demosaic_luma.col_parity,
                p.checker_reduction_pct, p.row_reduction_pct, p.col_reduction_pct,
            ),
            Err(e) => format!(",\n  \"parity\": {{\"error\":\"{e}\"}}"),
        }
    } else { String::new() };
    println!("{}", report_json(&rel, &report, &parity_json));

    if let Some(dir) = golden {
        fs::create_dir_all(&dir).ok();
        // 1) raw full-frame CFA (LE u16)
        match raw_cfa_le_u16(&bytes) {
            Ok((w, h, le)) => {
                let cfa_path = format!("{dir}/{rel}.cfa_le_u16.bin");
                fs::write(&cfa_path, &le).ok();
                let d = md5::compute(&le);
                // 2) integer-demosaic luma (LE u32) — ported reference kernel
                let (dw, dh, dle, dmd5) = match integer_demosaic_luma_le(&bytes) {
                    Ok((dw, dh, dle)) => { let dd = md5::compute(&dle); let p = format!("{dir}/{rel}.demosaic_luma_le_u32.bin"); fs::write(&p, &dle).ok(); (dw, dh, dle.len(), format!("{dd:x}")) }
                    Err(e) => { eprintln!("demosaic failed: {e}"); (0, 0, 0, "ERROR".to_string()) }
                };
                let manifest = format!(
                    "{{\n  \"file\": \"{}\",\n  \"cfa\": {{\"dims\":\"{}x{}\",\"pattern\":\"{}\",\"dtype\":\"u16_le\",\"len_bytes\":{},\"md5\":\"{:x}\"}},\n  \
                     \"demosaic_luma\": {{\"dims\":\"{}x{}\",\"dtype\":\"u32_le\",\"len_bytes\":{},\"md5\":\"{}\",\"formula\":\"L=R+G+B, integer bilinear (rounded /2,/4 shifts) over full-frame raw CFA, no black-subtraction\"}},\n  \
                     \"blacklevel_bayer\": {},\n  \"whitelevel\": {},\n  \"active_area\": {},\n  \"crop_area\": {},\n  \"black_areas_count\": {}\n}}",
                    rel, w, h, report.cfa_name, le.len(), d,
                    dw, dh, dle, dmd5,
                    f32arr(&report.blacklevel_bayer), u32arr(&report.whitelevel),
                    rect_json(&report.active_area), rect_json(&report.crop_area), report.black_areas.len(),
                );
                fs::write(format!("{dir}/{rel}.golden_manifest.json"), manifest).ok();
                eprintln!("[golden] wrote {rel} CFA ({} bytes) + demosaic luma to {dir}", le.len());
            }
            Err(e) => eprintln!("golden CFA dump failed: {e}"),
        }
    }
}
