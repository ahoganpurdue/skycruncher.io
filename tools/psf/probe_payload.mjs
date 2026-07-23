// One-off probe: what does the mem_image payload ACTUALLY look like per Bayer
// parity? Reads the decode cache written by measure_and_clean.mjs --cache.
import fs from 'node:fs';

const cacheFile = process.argv[2] || 'test_results/psf/.decode_cache_IMG_1653.CR2.bin';
const buf = fs.readFileSync(cacheFile);
if (buf.readUInt32LE(0) !== 0x50534632) throw new Error('bad cache magic');
const w = buf.readUInt32LE(4), h = buf.readUInt32LE(8);
const rgb16 = new Uint16Array(buf.buffer.slice(12), 0, w * h * 3);
console.log(`payload ${w}x${h}`);

// raw 6x6 block of triplets
const bx = 2000, by = 1500;
console.log(`\ntriplets at (${bx}..${bx + 5}, ${by}..${by + 5}):`);
for (let y = by; y < by + 6; y++) {
    const row = [];
    for (let x = bx; x < bx + 6; x++) {
        const i = (y * w + x) * 3;
        row.push(`[${rgb16[i]},${rgb16[i + 1]},${rgb16[i + 2]}]`.padEnd(20));
    }
    console.log(`  y=${y} ${y % 2 ? 'odd ' : 'even'} ${row.join('')}`);
}

// per-parity stats over a big sample
const stats = Array.from({ length: 4 }, () => ({
    n: 0, nzHist: [0, 0, 0, 0],
    sum: [0, 0, 0], nz: [0, 0, 0], max: [0, 0, 0],
}));
for (let y = 100; y < h - 100; y += 7) {
    for (let x = 100; x < w - 100; x += 11) {
        const p = (y & 1) * 2 + (x & 1);
        const s = stats[p];
        const i = (y * w + x) * 3;
        let nz = 0;
        for (let c = 0; c < 3; c++) {
            const v = rgb16[i + c];
            s.sum[c] += v;
            if (v > 0) { nz++; s.nz[c]++; }
            if (v > s.max[c]) s.max[c] = v;
        }
        s.n++;
        s.nzHist[nz]++;
    }
}
console.log('\nper-parity channel stats (mean | nonzero-fraction | max):');
for (let p = 0; p < 4; p++) {
    const s = stats[p];
    const desc = ['R', 'G', 'B'].map((c, i) =>
        `${c}: ${(s.sum[i] / s.n).toFixed(0)} ${(s.nz[i] / s.n).toFixed(2)} ${s.max[i]}`).join('   ');
    console.log(`  (y${p >> 1},x${p & 1}): n=${s.n}  ${desc}`);
    console.log(`        nz-count hist 0/1/2/3: ${s.nzHist.map((v) => (v / s.n).toFixed(3)).join(' / ')}`);
}
