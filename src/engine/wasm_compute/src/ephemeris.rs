use wasm_bindgen::prelude::*;
use std::f64::consts::PI;

pub const DEG2RAD: f64 = PI / 180.0;
pub const RAD2DEG: f64 = 180.0 / PI;
pub const J2000: f64 = 2451545.0;

use serde::{Serialize, Deserialize};
use serde_wasm_bindgen;

#[wasm_bindgen]
#[derive(Clone, Copy, Debug)]
pub struct Vector3 {
    pub x: f64,
    pub y: f64,
    pub z: f64,
}

#[wasm_bindgen]
impl Vector3 {
    #[wasm_bindgen(constructor)]
    pub fn new(x: f64, y: f64, z: f64) -> Vector3 {
        Vector3 { x, y, z }
    }
}

/// Represents the Keplerian orbital elements of a celestial body
#[wasm_bindgen]
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct OrbitalElements {
    pub n: f64, // longitude of ascending node
    pub i: f64, // inclination
    pub w: f64, // argument of perihelion
    pub a: f64, // semi-major axis
    pub e: f64, // eccentricity
    pub m: f64, // mean anomaly
}

#[wasm_bindgen]
impl OrbitalElements {
    #[wasm_bindgen(constructor)]
    pub fn new(n: f64, i: f64, w: f64, a: f64, e: f64, m: f64) -> OrbitalElements {
        OrbitalElements { n, i, w, a, e, m }
    }
}

/// Solves Kepler's equation for a given time `d` (days since J2000)
// WasmCelestialBody is now a plain data struct for Serde, no wasm_bindgen impl needed.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct WasmCelestialBody {
    pub id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub body_type: String,
    pub orbits_id: Option<String>,
    pub radius_km: f64,
    pub mass_kg: f64,
    pub bv_index: f64,
    pub n: f64,
    pub i: f64,
    pub w: f64,
    pub a: f64,
    pub e: f64,
    pub m: f64,
    pub mag_base: f64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct WasmEphemerisResult {
    pub id: String,
    pub ra: f64,
    pub dec: f64,
    pub alt: f64,
    pub az: f64,
    pub mag: f64,
    pub dist_au: f64,
    pub radius_arcsec: f64,
}

/// Solves Kepler's equation for a given time `d` (days since J2000)
pub fn solve_kepler_internal(n_node: f64, i: f64, w: f64, a: f64, e: f64, m: f64, d: f64) -> Vector3 {
    let n_vel = 0.9856076686 / a.powf(1.5);
    let mut m_deg = (m + n_vel * d) % 360.0;
    if m_deg < 0.0 { m_deg += 360.0; }

    let mut e_deg = m_deg + e * RAD2DEG * (m_deg * DEG2RAD).sin() * (1.0 + e * (m_deg * DEG2RAD).cos());

    for _ in 0..5 {
        let e_rad = e_deg * DEG2RAD;
        e_deg = e_deg - (e_deg - (e * RAD2DEG * e_rad.sin()) - m_deg) / (1.0 - e * e_rad.cos());
    }

    let e_rad = e_deg * DEG2RAD;
    let xv = a * (e_rad.cos() - e);
    let yv = a * ((1.0 - e * e).sqrt() * e_rad.sin());

    let v_deg = yv.atan2(xv) * RAD2DEG;
    let r = (xv * xv + yv * yv).sqrt();

    let vw_rad = (v_deg + w) * DEG2RAD;
    let node_rad = n_node * DEG2RAD;
    let i_rad = i * DEG2RAD;

    let x = r * (node_rad.cos() * vw_rad.cos() - node_rad.sin() * vw_rad.sin() * i_rad.cos());
    let y = r * (node_rad.sin() * vw_rad.cos() + node_rad.cos() * vw_rad.sin() * i_rad.cos());
    let z = r * (vw_rad.sin() * i_rad.sin());

    Vector3 { x, y, z }
}

#[wasm_bindgen]
pub fn solve_kepler(el: &OrbitalElements, d: f64) -> Vector3 {
    solve_kepler_internal(el.n, el.i, el.w, el.a, el.e, el.m, d)
}

#[wasm_bindgen]
pub fn batch_solve_ephemeris(
    bodies_val: JsValue,
    lat: f64,
    lon: f64,
    d: f64,
    _jd: f64
) -> Result<JsValue, JsValue> {
    use std::collections::HashMap;

    let bodies: Vec<WasmCelestialBody> = serde_wasm_bindgen::from_value(bodies_val)?;

    let mut local_vectors: HashMap<String, Vector3> = HashMap::new();
    local_vectors.insert("sun".to_string(), Vector3 { x: 0.0, y: 0.0, z: 0.0 });

    for b in &bodies {
        if b.id == "sun" { continue; }
        let pos = solve_kepler_internal(b.n, b.i, b.w, b.a, b.e, b.m, d);
        local_vectors.insert(b.id.clone(), pos);
    }

    let mut absolute_vectors: HashMap<String, Vector3> = HashMap::new();

    fn resolve_absolute(
        id: &str,
        bodies_map: &HashMap<String, &WasmCelestialBody>,
        local_vecs: &HashMap<String, Vector3>,
        abs_vecs: &mut HashMap<String, Vector3>,
        depth: usize
    ) -> Vector3 {
        if depth > 10 { return Vector3 { x: 0.0, y: 0.0, z: 0.0 }; }
        if let Some(vec) = abs_vecs.get(id) { return *vec; }

        let b = match bodies_map.get(id) {
            Some(body) => body,
            None => return Vector3 { x: 0.0, y: 0.0, z: 0.0 },
        };

        let my_vec = local_vecs.get(id).cloned().unwrap_or(Vector3 { x: 0.0, y: 0.0, z: 0.0 });

        let abs_vec = match &b.orbits_id {
            Some(parent_id) => {
                let parent_vec = resolve_absolute(parent_id, bodies_map, local_vecs, abs_vecs, depth + 1);
                Vector3 {
                    x: parent_vec.x + my_vec.x,
                    y: parent_vec.y + my_vec.y,
                    z: parent_vec.z + my_vec.z,
                }
            }
            None => my_vec,
        };

        abs_vecs.insert(id.to_string(), abs_vec);
        abs_vec
    }

    let bodies_map: HashMap<String, &WasmCelestialBody> = bodies.iter().map(|b| (b.id.clone(), b)).collect();

    // Ensure Earth is resolved
    resolve_absolute("earth", &bodies_map, &local_vectors, &mut absolute_vectors, 0);
    let earth_vec = absolute_vectors.get("earth").cloned().unwrap_or(Vector3 { x: 0.0, y: 0.0, z: 0.0 });

    let mut results = Vec::new();
    let obl_rad = 23.43929 * DEG2RAD;
    let cos_obl = obl_rad.cos();
    let sin_obl = obl_rad.sin();

    for b in &bodies {
        if b.id == "earth" { continue; }

        let abs_vec = resolve_absolute(&b.id, &bodies_map, &local_vectors, &mut absolute_vectors, 0);
        let geo_vec = Vector3 {
            x: abs_vec.x - earth_vec.x,
            y: abs_vec.y - earth_vec.y,
            z: abs_vec.z - earth_vec.z,
        };

        let r_heliocen = (abs_vec.x.powi(2) + abs_vec.y.powi(2) + abs_vec.z.powi(2)).sqrt();
        let dist_au = (geo_vec.x.powi(2) + geo_vec.y.powi(2) + geo_vec.z.powi(2)).sqrt();

        // Magnitude estimation
        let mag = if b.id == "sun" {
            -26.7
        } else {
            b.mag_base + 5.0 * (r_heliocen * dist_au).log10()
        };

        // Optimization skip
        if mag > 20.0 && b.body_type == "MOON" && b.id != "luna" { continue; }

        // Ecliptic to Equatorial
        let x_eq = geo_vec.x;
        let y_eq = geo_vec.y * cos_obl - geo_vec.z * sin_obl;
        let z_eq = geo_vec.y * sin_obl + geo_vec.z * cos_obl;

        let mut ra_rad = y_eq.atan2(x_eq);
        let dec_rad = z_eq.atan2((x_eq.powi(2) + y_eq.powi(2)).sqrt());

        let mut ra_hours = ra_rad * RAD2DEG / 15.0;
        if ra_hours < 0.0 { ra_hours += 24.0; }
        let mut dec_deg = dec_rad * RAD2DEG;

        // Topocentric correction
        if b.body_type == "MOON" || dist_au < 0.1 {
            let topo = apply_topocentric_correction_internal(ra_hours, dec_deg, dist_au, lat, lon, d);
            ra_hours = topo[0];
            dec_deg = topo[1];
        }

        // Alt/Az
        let gmst_hours = (18.697374558 + 24.06570982441908 * d) % 24.0;
        let mut lst_hours = (gmst_hours + lon / 15.0) % 24.0;
        if lst_hours < 0.0 { lst_hours += 24.0; }
        
        let ha_rad = (lst_hours - ra_hours) * 15.0 * DEG2RAD;
        let lat_rad = lat * DEG2RAD;
        let dec_corr_rad = dec_deg * DEG2RAD;

        let sin_alt = lat_rad.sin() * dec_corr_rad.sin() + lat_rad.cos() * dec_corr_rad.cos() * ha_rad.cos();
        let alt = sin_alt.asin();
        
        let cos_az = (dec_corr_rad.sin() - lat_rad.sin() * sin_alt) / (lat_rad.cos() * alt.cos());
        let mut az = cos_az.clamp(-1.0, 1.0).acos();
        if ha_rad.sin() > 0.0 { az = 2.0 * PI - az; }

        let radius_arcsec = ( (b.radius_km / 149597870.7) / dist_au ) * 206264.806;

        results.push(WasmEphemerisResult {
            id: b.id.clone(),
            ra: ra_hours,
            dec: dec_deg,
            alt: alt * RAD2DEG,
            az: az * RAD2DEG,
            mag,
            dist_au,
            radius_arcsec,
        });
    }

    serde_wasm_bindgen::to_value(&results).map_err(|e| e.into())
}

fn apply_topocentric_correction_internal(
    ra_hours: f64, dec_deg: f64,
    dist_au: f64, lat_deg: f64, lon_deg: f64,
    d_since_j2000: f64
) -> [f64; 2] {
    let dist_km = dist_au * 149597870.7;
    let earth_radius_km = 6378.14; 
    let pi_rad = (earth_radius_km / dist_km).asin();
    
    let gmst_hours = (18.697374558 + 24.06570982441908 * d_since_j2000) % 24.0;
    let mut lst_hours = (gmst_hours + lon_deg / 15.0) % 24.0;
    if lst_hours < 0.0 { lst_hours += 24.0; }
    
    let ha_rad = (lst_hours - ra_hours) * 15.0 * DEG2RAD;
    let lat_rad = lat_deg * DEG2RAD;
    let dec_rad = dec_deg * DEG2RAD;

    let rho_cos_phi = lat_rad.cos();
    let rho_sin_phi = lat_rad.sin();

    let a = dec_rad.cos() * ha_rad.sin();
    let b = dec_rad.cos() * ha_rad.cos() - rho_cos_phi * pi_rad.sin();
    let c = dec_rad.sin() - rho_sin_phi * pi_rad.sin();

    let h_prime_rad = a.atan2(b);
    let mut ra_prime_hours = (lst_hours - (h_prime_rad * RAD2DEG) / 15.0) % 24.0;
    if ra_prime_hours < 0.0 { ra_prime_hours += 24.0; }
    
    let dec_prime_deg = (c * h_prime_rad.cos()).atan2(b) * RAD2DEG;

    [ra_prime_hours, dec_prime_deg]
}

#[wasm_bindgen]
pub fn apply_topocentric_correction(
    ra_hours: f64, dec_deg: f64,
    dist_au: f64, lat_deg: f64, lon_deg: f64,
    d_since_j2000: f64
) -> Vec<f64> {
    let res = apply_topocentric_correction_internal(ra_hours, dec_deg, dist_au, lat_deg, lon_deg, d_since_j2000);
    vec![res[0], res[1]]
}
