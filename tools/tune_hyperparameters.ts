import { solvePlate, autoSolvePlate } from '../src/SKYCRUNCHER_AI/pipeline/plate_solver';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Hyperparameter Tuning Utility
 * 
 * establecer truth via Tool A (Spherical) and sweep parameters for Tool B (Planar).
 */

async function tune() {
    console.log('--- SKYCRUNCHER HYPERPARAMETER TUNER ---');

    const testDir = './test_data/raw_samples';
    if (!fs.existsSync(testDir)) {
        console.warn(`[Tuner] Test directory ${testDir} not found. Please populate with tagged RAW files.`);
        return;
    }

    const samples = fs.readdirSync(testDir).filter(f => f.endsWith('.cr2') || f.endsWith('.fits'));
    const results: any[] = [];

    for (const file of samples) {
        console.log(`\n[Tuner] Processing Sample: ${file}`);
        
        // 1. Establish Truth (Tool A - Spherical)
        const truth = await autoSolvePlate({} as any, { 
            focalLength: 14, // Extracted from filename or EXIF in real impl
            basePixelScale: 30.0,
            hints: { ra_hours: 5.5, dec_degrees: -5.0 } // Orion test case
        } as any);

        if (!truth.success || !truth.solution) {
            console.error(`[Tuner] Failed to establish truth for ${file}. Skipping.`);
            continue;
        }

        console.log(`[Tuner] ✅ Ground Truth Established: center [${truth.solution.ra_hours.toFixed(4)}, ${truth.solution.dec_degrees.toFixed(4)}]`);



        // 3. Focal Length Sweep (Loop Detection)
        console.log(`[Tuner] 🔍 Running Focal Length Sweep for loop detection...`);
        const focalLengths = [12, 14, 16, 18, 20, 24, 35, 50];
        for (const fl of focalLengths) {
            const start = performance.now();
            const flResult = await autoSolvePlate({} as any, {
                focalLengthMm: fl,
                basePixelScale: (206265 * 0.0039) / fl,
                hints: { ra_hours: truth.solution.ra_hours, dec_degrees: truth.solution.dec_degrees }
            } as any);
            const time = performance.now() - start;

            if (flResult.success && flResult.solution) {
                const nominalScale = (206265 * 0.0039) / fl;
                const scaleError = Math.abs(flResult.solution.pixel_scale - nominalScale) / nominalScale;
                console.log(`[Tuner]   - Hint FL: ${fl}mm | LOCK: SUCCESS | Final Scale: ${flResult.solution.pixel_scale.toFixed(2)}"/px | Scale Error: ${(scaleError * 100).toFixed(1)}% | Time: ${time.toFixed(0)}ms`);
                results.push({ file, mode: 'focal_sweep', inputFL: fl, resultFL: (206265 * 0.0039) / flResult.solution.pixel_scale, success: true });
            } else {
                console.log(`[Tuner]   - Hint FL: ${fl}mm | LOCK: FAILED`);
                results.push({ file, mode: 'focal_sweep', inputFL: fl, success: false });
            }
        }
    }

    fs.writeFileSync('./tools/hyperparameter_results.json', JSON.stringify(results, null, 2));
    console.log('\n[Tuner] 🏁 Tuning Complete. Results saved to tools/hyperparameter_results.json');
}

function calculateAngularError(s1: any, s2: any): number {
    const dRA = (s1.ra_hours - s2.ra_hours) * 15;
    const dDec = s1.dec_degrees - s2.dec_degrees;
    return Math.sqrt(dRA * dRA + dDec * dDec);
}

// Entry point
tune().catch(console.error);
