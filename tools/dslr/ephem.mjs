// Compact geocentric planetary ephemeris (Schlyter, ~1 arcmin) — shared by the
// CR2 dump + capture tools so planet anchor-centers come from ONE source.
// stjarnhimlen.se/comp/ppcomp.html. Good to arcminutes for the naked-eye
// planets, far inside the ~0.5° anchor-center tolerance. The app's Kepler/WASM
// path does the same physics; the vitest WASM mock's crude conversion does not.
const D2R = Math.PI / 180;
const rev = (x) => ((x % 360) + 360) % 360;

export function computePlanets(date) {
    const Y = date.getUTCFullYear(), Mo = date.getUTCMonth() + 1, D = date.getUTCDate();
    const UT = date.getUTCHours() + date.getUTCMinutes() / 60 + date.getUTCSeconds() / 3600;
    const d = 367 * Y - Math.floor(7 * (Y + Math.floor((Mo + 9) / 12)) / 4) + Math.floor(275 * Mo / 9) + D - 730530 + UT / 24;
    const ecl = 23.4393 - 3.563e-7 * d;
    // Sun (Earth's orbit) → rectangular ecliptic geocentric position of the Sun
    const ws = 282.9404 + 4.70935e-5 * d, es = 0.016709 - 1.151e-9 * d, Ms = rev(356.0470 + 0.9856002585 * d);
    const Es = Ms + (180 / Math.PI) * es * Math.sin(Ms * D2R) * (1 + es * Math.cos(Ms * D2R));
    const xvs = Math.cos(Es * D2R) - es, yvs = Math.sqrt(1 - es * es) * Math.sin(Es * D2R);
    const vs = Math.atan2(yvs, xvs) / D2R, rsun = Math.hypot(xvs, yvs);
    const lonsun = rev(vs + ws);
    const xs = rsun * Math.cos(lonsun * D2R), ys = rsun * Math.sin(lonsun * D2R);
    const els = {
        jupiter: [100.4542 + 2.76854e-5 * d, 1.3030 - 1.557e-7 * d, 273.8777 + 1.64505e-5 * d, 5.20256, 0.048498 + 4.469e-9 * d, 19.8950 + 0.0830853001 * d, -2.6],
        saturn: [113.6634 + 2.38980e-5 * d, 2.4886 - 1.081e-7 * d, 339.3939 + 2.97661e-5 * d, 9.55475, 0.055546 - 9.499e-9 * d, 316.9670 + 0.0334442282 * d, 0.5],
        mars: [49.5574 + 2.11081e-5 * d, 1.8497 - 1.78e-8 * d, 286.5016 + 2.92961e-5 * d, 1.523688, 0.093405 + 2.516e-9 * d, 18.6021 + 0.5240207766 * d, 1.0],
        venus: [76.6799 + 2.46590e-5 * d, 3.3946 + 2.75e-8 * d, 54.8910 + 1.38374e-5 * d, 0.723330, 0.006773 - 1.302e-9 * d, 48.0052 + 1.6021302244 * d, -4.0],
    };
    const out = [];
    for (const [name, [N, i, w, a, e]] of Object.entries(els)) {
        const M = rev(els[name][5]);
        let E = M + (180 / Math.PI) * e * Math.sin(M * D2R) * (1 + e * Math.cos(M * D2R));
        for (let k = 0; k < 8; k++) E = E - (E - (180 / Math.PI) * e * Math.sin(E * D2R) - M) / (1 - e * Math.cos(E * D2R));
        const xv = a * (Math.cos(E * D2R) - e), yv = a * Math.sqrt(1 - e * e) * Math.sin(E * D2R);
        const v = Math.atan2(yv, xv) / D2R, r = Math.hypot(xv, yv);
        const Nr = N * D2R, ir = i * D2R, vw = (v + w) * D2R;
        const xh = r * (Math.cos(Nr) * Math.cos(vw) - Math.sin(Nr) * Math.sin(vw) * Math.cos(ir));
        const yh = r * (Math.sin(Nr) * Math.cos(vw) + Math.cos(Nr) * Math.sin(vw) * Math.cos(ir));
        const zh = r * Math.sin(vw) * Math.sin(ir);
        const xg = xh + xs, yg = yh + ys, zg = zh; // geocentric ecliptic
        const xe = xg, ye = yg * Math.cos(ecl * D2R) - zg * Math.sin(ecl * D2R), ze = yg * Math.sin(ecl * D2R) + zg * Math.cos(ecl * D2R);
        const raH = rev(Math.atan2(ye, xe) / D2R) / 15;
        const decD = Math.atan2(ze, Math.hypot(xe, ye)) / D2R;
        out.push({ name, ra_hours: +raH.toFixed(5), dec_degrees: +decD.toFixed(4), dist_au: +Math.hypot(xg, yg, zg).toFixed(3), mag: els[name][6] });
    }
    return out;
}

// Geocentric apparent Sun RA/Dec (same Schlyter model, ~arcmin). The Sun's
// equatorial position is location-independent (no meaningful diurnal parallax),
// so this is exact enough to seed the ultra-wide sun-proximity veto from a
// frame's trusted timestamp. e.g. 2019-06-03T06:50:55Z → ~4.73h / +22.3°.
export function computeSun(date) {
    const Y = date.getUTCFullYear(), Mo = date.getUTCMonth() + 1, D = date.getUTCDate();
    const UT = date.getUTCHours() + date.getUTCMinutes() / 60 + date.getUTCSeconds() / 3600;
    const d = 367 * Y - Math.floor(7 * (Y + Math.floor((Mo + 9) / 12)) / 4) + Math.floor(275 * Mo / 9) + D - 730530 + UT / 24;
    const ecl = 23.4393 - 3.563e-7 * d;
    const ws = 282.9404 + 4.70935e-5 * d, es = 0.016709 - 1.151e-9 * d, Ms = rev(356.0470 + 0.9856002585 * d);
    const Es = Ms + (180 / Math.PI) * es * Math.sin(Ms * D2R) * (1 + es * Math.cos(Ms * D2R));
    const xvs = Math.cos(Es * D2R) - es, yvs = Math.sqrt(1 - es * es) * Math.sin(Es * D2R);
    const vs = Math.atan2(yvs, xvs) / D2R, rsun = Math.hypot(xvs, yvs);
    const lonsun = rev(vs + ws);
    // Sun sits on the ecliptic (latitude 0) → rotate ecliptic (xs,ys,0) to equatorial.
    const xs = rsun * Math.cos(lonsun * D2R), ys = rsun * Math.sin(lonsun * D2R);
    const xe = xs, ye = ys * Math.cos(ecl * D2R), ze = ys * Math.sin(ecl * D2R);
    const raH = rev(Math.atan2(ye, xe) / D2R) / 15;
    const decD = Math.atan2(ze, Math.hypot(xe, ye)) / D2R;
    return { ra_hours: +raH.toFixed(5), dec_degrees: +decD.toFixed(4) };
}
