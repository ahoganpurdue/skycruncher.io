
import fs from 'fs';
import path from 'path';

const INPUT_FILE = path.resolve('public/atlas/level_1_anchors.json');

interface Star {
    id: number;
    proper?: string;
    ra: number;
    dec: number;
    mag_g: number;
    bp_rp: number;
    pm_ra: number;
    pm_dec: number;
    source_id: number;
}

function format() {
    const data = fs.readFileSync(INPUT_FILE, 'utf8');
    const stars: Star[] = JSON.parse(data);

    let output = `#[derive(Debug, Clone, Copy)]\npub struct AtlasEntry {\n    pub ra_rad: f64,\n    pub dec_rad: f64,\n    pub unit: [f64; 3],\n    pub mag_g: f64,\n    pub bp_rp: f64,\n    pub pm_ra: f64,\n    pub pm_dec: f64,\n    pub hip_id: u32,\n    pub source_id: u64,\n}\n\n`;

    output += `pub fn get_visible_stars(lat: f64, lon: f64, jd: f64, alt_limit: f64) -> Vec<AtlasEntry> {\n    let mut visible = Vec::new();\n    let lst = get_lst(lon, jd);\n    \n    for entry in BRIGHT_ATLAS {\n        let alt = get_altitude(entry.ra_rad, entry.dec_rad, lat, lst);\n        if alt > alt_limit {\n            visible.push(entry.clone());\n        }\n    }\n    visible\n}\n\n`;

    output += `fn get_lst(lon: f64, jd: f64) -> f64 {\n    let d = jd - 2451545.0;\n    let lst = (18.697374558 + 24.06570982441908 * d) % 24.0;\n    (lst * 15.0).to_radians() + lon\n}\n\n`;

    output += `fn get_altitude(ra: f64, dec: f64, lat: f64, lst: f64) -> f64 {\n    let ha = lst - ra;\n    let sin_alt = lat.sin() * dec.sin() + lat.cos() * dec.cos() * ha.cos();\n    sin_alt.asin()\n}\n\n`;

    output += `pub const BRIGHT_ATLAS: &[AtlasEntry] = &[\n`;
    
    stars.forEach(s => {
        const raRad = s.ra * (Math.PI / 12);
        const decRad = s.dec * (Math.PI / 180);
        const x = Math.cos(decRad) * Math.cos(raRad);
        const y = Math.cos(decRad) * Math.sin(raRad);
        const z = Math.sin(decRad);
        const name = s.proper ? ` // ${s.proper}` : '';
        output += `    AtlasEntry { ra_rad: ${raRad.toFixed(6)}, dec_rad: ${decRad.toFixed(6)}, unit: [${x.toFixed(6)}, ${y.toFixed(6)}, ${z.toFixed(6)}], mag_g: ${s.mag_g.toFixed(2)}, bp_rp: ${(s.bp_rp||0).toFixed(3)}, pm_ra: ${(s.pm_ra||0).toFixed(1)}, pm_dec: ${(s.pm_dec||0).toFixed(1)}, hip_id: ${s.id}, source_id: ${s.source_id} },${name}\n`;
    });
    
    output += `];\n`;

    const targetFile = path.resolve('src/engine/wasm_compute/src/bright_star_atlas.rs');
    fs.writeFileSync(targetFile, output);
    console.log(`Updated ${targetFile} with ${stars.length} stars.`);
}

format();
