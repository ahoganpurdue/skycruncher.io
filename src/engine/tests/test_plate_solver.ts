import * as fs from 'fs';
import * as path from 'path';
import { solvePlate } from '../Mainlogic_entry';
import { SourceExtractor } from '../pipeline/m4_signal_detect/source_extractor';

import { STANDARD_STARS } from '../pipeline/m6_plate_solve/standard_stars';

// Mock ImageData for Node environment
class MockImageData {
    width: number;
    height: number;
    data: Uint8ClampedArray;

    constructor(width: number, height: number) {
        this.width = width;
        this.height = height;
        this.data = new Uint8ClampedArray(width * height * 4);
    }
}

function gnomonic(
    raH: number, decD: number,
    ra0H: number, dec0D: number
): { xi: number; eta: number } {
    const ra = raH * 15 * Math.PI / 180;
    const dec = decD * Math.PI / 180;
    const ra0 = ra0H * 15 * Math.PI / 180;
    const dec0 = dec0D * Math.PI / 180;

    const cosDec = Math.cos(dec);
    const sinDec = Math.sin(dec);
    const cosDec0 = Math.cos(dec0);
    const sinDec0 = Math.sin(dec0);
    const cosDRA = Math.cos(ra - ra0);

    const denom = sinDec0 * sinDec + cosDec0 * cosDec * cosDRA;
    if (denom < 0.001) return { xi: NaN, eta: NaN };

    const xi = (cosDec * Math.sin(ra - ra0)) / denom;
    const eta = (cosDec0 * sinDec - sinDec0 * cosDec * cosDRA) / denom;

    return {
        xi: xi * 180 / Math.PI,
        eta: eta * 180 / Math.PI,
    };
}

async function testSolver() {
    console.log('--- Synthetic Star Field Test ---');
    
    const width = 1024;
    const height = 1024;
    const img = new MockImageData(width, height);
    
    const ra0 = 18.6156;
    const dec0 = 38.7837;
    const pixelScale = 5.0; 
    const degPerPx = pixelScale / 3600;

    console.log(`Centering on Vega (RA ${ra0}, Dec ${dec0}) at ${pixelScale}"/px`);

    const testStars = [
        { ra: 18.6156, dec: 38.7837, mag: 0.03, name: "Vega" },
        { ra: 18.62, dec: 38.80, mag: 1.0, name: "ST_1" },
        { ra: 18.61, dec: 38.75, mag: 1.2, name: "ST_2" },
        { ra: 18.60, dec: 38.82, mag: 1.5, name: "ST_3" },
        { ra: 18.63, dec: 38.72, mag: 1.8, name: "ST_4" },
        { ra: 18.64, dec: 38.85, mag: 2.1, name: "ST_5" },
        { ra: 18.58, dec: 38.80, mag: 2.4, name: "ST_6" },
        { ra: 18.65, dec: 38.75, mag: 2.7, name: "ST_7" }
    ];

    for (const s of testStars) {
        if (s.name !== 'Vega') {
            STANDARD_STARS.push({
                name: s.name,
                gaia_id: `MOCK_${s.name}`,
                ra_hours: s.ra,
                dec_degrees: s.dec,
                magnitude_V: s.mag,
                color_index_BV: 0.5,
                spectral_type: 'A0',
                temperature_K: 9000,
                pmra: 0, pmdec: 0, rv_kms: 0,
                expected_xy: { x: 0.3, y: 0.3 },
                constellation: 'Lyra'
            });
        }
    }

    for (let i = 0; i < img.data.length; i += 4) {
        const noise = Math.random() * 8;
        img.data[i] = noise;
        img.data[i + 1] = noise;
        img.data[i + 2] = noise;
        img.data[i + 3] = 255;
    }

    for (const s of testStars) {
        const proj = gnomonic(s.ra, s.dec, ra0, dec0);
        const px = Math.round(width / 2 + proj.xi / degPerPx);
        const py = Math.round(height / 2 - proj.eta / degPerPx);
        
        if (px >= 5 && px < width - 5 && py >= 5 && py < height - 5) {
            console.log(`Placing star ${s.name.padEnd(5)} at (${px}, ${py})`);
            const peek = 255 - (s.mag * 30);
            for (let ox = -2; ox <= 2; ox++) {
                for (let oy = -2; oy <= 2; oy++) {
                    const r2 = ox*ox + oy*oy;
                    const val = peek * Math.exp(-r2 / 1.2);
                    const idx = ((py + oy) * width + (px + ox)) * 4;
                    img.data[idx] = Math.max(img.data[idx], val);
                    img.data[idx + 1] = Math.max(img.data[idx + 1], val);
                    img.data[idx + 2] = Math.max(img.data[idx + 2], val);
                }
            }
        }
    }

    // --- VISUAL ASCII MAP (40x20) ---
    console.log('\n--- Star Map (ASCII) ---');
    const mapW = 40;
    const mapH = 20;
    let asciiMap = '';
    for (let my = 0; my < mapH; my++) {
        let line = '';
        for (let mx = 0; mx < mapW; mx++) {
            const px = Math.floor((mx / mapW) * width);
            const py = Math.floor((my / mapH) * height);
            const idx = (py * width + px) * 4;
            const lum = img.data[idx];
            if (lum > 200) line += 'â˜…';
            else if (lum > 100) line += 'â˜†';
            else if (lum > 30) line += 'Â·';
            else line += ' ';
        }
        asciiMap += line + '\n';
    }
    console.log(asciiMap);

    // Polyfill fetch for node environment to load atlas files and WASM
    (global as any).fetch = async (url: string) => {
        let fullPath = '';
        if (url.includes('wasm_compute_bg.wasm')) {
            fullPath = path.resolve('src/engine/wasm_compute/pkg/wasm_compute_bg.wasm');
        } else {
            fullPath = path.resolve('public', url.startsWith('/') ? url.slice(1) : url);
        }

        if (fs.existsSync(fullPath)) {
            const data = fs.readFileSync(fullPath);
            return {
                ok: true,
                arrayBuffer: async () => data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
                json: async () => JSON.parse(data.toString('utf8')),
                headers: new Map([['Content-Type', url.endsWith('.wasm') ? 'application/wasm' : 'application/json']])
            } as any;
        }
        return { ok: false, statusText: 'Not Found' };
    };

    // 3. Extract Stars
    const detected = (await SourceExtractor.extractStars(img as any, 3.0)).stars;
    console.log(`Detected ${detected.length} stars.`);

    if (detected.length >= 4) {
        // 4. Solve Plate
        const result = await solvePlate(img as any, pixelScale, { ra_hours: ra0, dec_degrees: dec0 });
        if (result.success && result.solution) {
            const solution = result.solution;
            console.log('SUCCESS: Plate Solved!');
            console.log(`Solved Center: RA ${solution.ra_hours.toFixed(4)}, Dec ${solution.dec_degrees.toFixed(4)}`);
            console.log(`Stars Matched: ${solution.num_stars}`);
            console.log(`confidence: ${(solution.confidence * 100).toFixed(1)}%`);
        } else {
            console.log('FAILED: Solver could not find solution.');
        }
    } else {
        console.log('FAILED: Not enough stars detected for solving.');
    }
}

testSolver();

