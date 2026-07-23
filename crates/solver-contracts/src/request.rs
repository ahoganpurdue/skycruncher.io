//! SolveRequest — the public input boundary. Every request self-classifies
//! BLIND | HINTED | ORACLE_ASSISTED from its CONTENTS (never a hand-written label).

use serde::{Deserialize, Serialize};

use crate::coordinates::SkyDeg;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Detection {
    pub id: u32,
    /// Native pixel coordinates, 0-based, y-down.
    pub x: f64,
    pub y: f64,
    pub flux: f64,
    /// Normalized peak sample value (saturation-clipped; carries brightness when flux is
    /// saturation-scrambled — M-1 measurement).
    pub peak_value: f64,
    pub fwhm: f64,
    pub snr: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum RequestClass {
    Blind,
    Hinted,
    OracleAssisted,
}

/// Optional prior. ANY present prior makes the request HINTED; an oracle-derived pose makes it
/// ORACLE_ASSISTED (diagnostics only, never pooled with blind results).
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Priors {
    /// Narrowed scale window (arcsec/px). The BLIND default window lives in SearchPolicy,
    /// not here — only a NARROWER-than-default window counts as a hint.
    pub scale_window: Option<(f64, f64)>,
    /// Sky cone prior (center + radius deg).
    pub sky_cone: Option<(SkyDeg, f64)>,
    /// Oracle pose (desk-check / diagnostics ONLY).
    pub oracle_pose: Option<crate::coordinates::TanWcs>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SolveRequest {
    pub frame_id: String,
    pub width: u32,
    pub height: u32,
    pub detections: Vec<Detection>,
    #[serde(default)]
    pub priors: Priors,
}

impl SolveRequest {
    /// Classification is DERIVED, never asserted.
    pub fn classification(&self) -> RequestClass {
        if self.priors.oracle_pose.is_some() {
            RequestClass::OracleAssisted
        } else if self.priors.scale_window.is_some() || self.priors.sky_cone.is_some() {
            RequestClass::Hinted
        } else {
            RequestClass::Blind
        }
    }
}
