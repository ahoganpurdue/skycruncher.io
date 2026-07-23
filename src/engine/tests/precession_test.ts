
// Simple script to test precession shift from J2000 to J2026.13 (approx today)
const J2000_RA = 17.2514 * 15; // deg
const J2000_DEC = -22.4251; // deg

const T = (2026.13 - 2000.0) / 100.0; // Century since J2000

// Constant coefficients (IAU precession model) in arcseconds
const M = 12.81232; // RA deg per century?? No, usually M = 3.075s per year
const m = (3.075 / 15) * 100; // deg per century
const n = (20.043 / 3600) * 100; // deg per century

const dRA = (m + n * Math.sin(J2000_RA * Math.PI / 180) * Math.tan(J2000_DEC * Math.PI / 180)) * T;
const dDec = (n * Math.cos(J2000_RA * Math.PI / 180)) * T;

console.log(`J2000: RA ${J2000_RA/15}h, Dec ${J2000_DEC}Â°`);
console.log(`Shift: dRA ${(dRA/15).toFixed(4)}h, dDec ${dDec.toFixed(4)}Â°`);
console.log(`JNow:  RA ${(J2000_RA/15 + dRA/15).toFixed(4)}h, Dec ${(J2000_DEC + dDec).toFixed(4)}Â°`);

