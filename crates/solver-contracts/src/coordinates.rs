//! Coordinate newtypes — distinct types so frame/unit mixups fail at compile time (LAW-3).
//! Pixel convention: NATIVE image pixels, 0-based, y-down (detection-table convention).
//! Sky: ICRS degrees at the index release's declared epoch (J2016.0 for g15u).

use serde::{Deserialize, Serialize};

/// Native image pixel position (0-based, y-down).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct PixelXY {
    pub x: f64,
    pub y: f64,
}

/// Sky position, ICRS degrees.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct SkyDeg {
    pub ra: f64,
    pub dec: f64,
}

/// Unit direction vector (RA/Dec on the unit sphere).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct UnitVec3 {
    pub x: f64,
    pub y: f64,
    pub z: f64,
}

/// Gnomonic tangent-plane position in DEGREES about a stated tangent point
/// (the builder convention: band_hash.mjs `gnomonic`, output divided by D2R).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct TangentDeg {
    pub x: f64,
    pub y: f64,
}

impl UnitVec3 {
    #[inline]
    pub fn from_sky(s: SkyDeg) -> Self {
        let (ra, dec) = (s.ra.to_radians(), s.dec.to_radians());
        let cd = dec.cos();
        Self { x: cd * ra.cos(), y: cd * ra.sin(), z: dec.sin() }
    }
    #[inline]
    pub fn dot(&self, o: &UnitVec3) -> f64 {
        self.x * o.x + self.y * o.y + self.z * o.z
    }
}

/// TAN WCS (FITS convention internally: CRPIX handled 0-based at the contract boundary —
/// the receipt states the convention explicitly).
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct TanWcs {
    pub crval: SkyDeg,
    /// 0-based native pixel of the tangent point.
    pub crpix: PixelXY,
    /// deg/px matrix mapping (x - crpix.x, y - crpix.y) -> (xi, eta) intermediate world coords.
    pub cd: [[f64; 2]; 2],
}

impl TanWcs {
    /// Pixel scale in arcsec/px (geometric mean of the CD singular-value proxy sqrt(|det|)).
    #[inline]
    pub fn scale_arcsec_px(&self) -> f64 {
        let det = self.cd[0][0] * self.cd[1][1] - self.cd[0][1] * self.cd[1][0];
        det.abs().sqrt() * 3600.0
    }
    /// Parity: sign of det(CD). Pre-registered M5 criterion (plan rev 2).
    #[inline]
    pub fn parity_sign(&self) -> i8 {
        let det = self.cd[0][0] * self.cd[1][1] - self.cd[0][1] * self.cd[1][0];
        if det >= 0.0 { 1 } else { -1 }
    }
}
