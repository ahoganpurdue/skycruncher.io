
import { SolarSystem } from '../engine/pipeline/m6_plate_solve/solar_system';
import { CELESTIAL_DB } from '../engine/core/celestial_data';

// --- Verification Configuration ---
const TEST_DATE = new Date('2026-02-18T20:00:00Z'); // Current rough timeframe
const TEST_LAT = 34.0522;  // Los Angeles
const TEST_LON = -118.2437;

console.log(`\nðŸª SKYCRUNCHER Solar System Verification ðŸª`);
console.log(`Date: ${TEST_DATE.toISOString()}`);
console.log(`Location: ${TEST_LAT}, ${TEST_LON}\n`);

// 1. Database Integrity Check
console.log(`[1] Checking Database Integrity...`);
const bodyCount = Object.keys(CELESTIAL_DB).length;
console.log(`    - Database contains ${bodyCount} bodies.`);
if (bodyCount < 10) {
    console.error(`    âŒ FAIL: Too few bodies in database.`);
    process.exit(1);
} else {
    console.log(`    âœ… PASS: Database populated.`);
}

// 2. Hierarchy Build Test
console.log(`\n[2] Building Solar System Hierarchy...`);
try {
    const hierarchy = SolarSystem.getHierarchy(TEST_DATE, TEST_LAT, TEST_LON);
    console.log(`    - Retrieved ${hierarchy.length} visible root bodies.`);
    
    const sun = hierarchy.find(b => b.id === 'sun');
    if (!sun) throw new Error("Sun not found in hierarchy");
    console.log(`    - Sun: Alt ${sun.altitude?.toFixed(2)}Â°, Az ${sun.azimuth?.toFixed(2)}Â°`);

    // Check for deeply nested moons (e.g. Jupiter -> Io)
    const jupiter = hierarchy.find(b => b.id === 'jupiter');
    if (jupiter && jupiter.children && jupiter.children.length > 0) {
        console.log(`    - Jupiter has ${jupiter.children.length} moons.`);
        jupiter.children.forEach(m => {
            console.log(`      - ${m.name}: Mag ${m.mag.toFixed(1)}, Dist ${m.dist_au?.toFixed(4)} AU`);
        });
        console.log(`    âœ… PASS: Hierarchy structure valid.`);
    } else {
        console.warn(`    âš ï¸ WARN: Jupiter moons not found or not nested correctly.`);
    }
} catch (e: any) {
    console.error(`    âŒ FAIL: Hierarchy build failed: ${e.message}`);
    process.exit(1);
}

// 3. Coordinate Sanity Check (Sun vs Moon)
console.log(`\n[3] Coordinate Sanity Check...`);
const context = SolarSystem.getCelestialContext(TEST_LAT, TEST_LON, TEST_DATE);
console.log(`    - Day/Night: ${context.is_daylight ? 'DAY' : 'NIGHT'}`);
console.log(`    - Moon Phase: ${(context.moon_phase * 100).toFixed(1)}%`);

if (context.moon_phase >= 0.0 && context.moon_phase <= 1.0) {
    console.log(`    âœ… PASS: Moon phase in range.`);
} else {
    console.error(`    âŒ FAIL: Invalid moon phase.`);
}

// 4. Occultation Logic Test
console.log(`\n[4] Occultation Logic Test...`);
const jupiter = SolarSystem.getHierarchy(TEST_DATE, TEST_LAT, TEST_LON).find(b => b.id === 'jupiter');
if (jupiter) {
    // Test a point exactly at Jupiter's center
    const isCenterOcculted = SolarSystem.isOcculting(jupiter.ra, jupiter.dec, jupiter);
    // Test a point far away
    const isFarOcculted = SolarSystem.isOcculting(jupiter.ra + 5, jupiter.dec + 5, jupiter);

    if (isCenterOcculted && !isFarOcculted) {
        console.log(`    âœ… PASS: Occultation logic works (Center=True, Far=False).`);
    } else {
        console.error(`    âŒ FAIL: Occultation logic broken.`);
    }
}

console.log(`\nVerification Complete.`);

