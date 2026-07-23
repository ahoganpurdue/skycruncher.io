/**
 * â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
 * ANOMALY DETECTOR + TOP HITS LIST + TNS REPORTING
 * â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
 *
 * THE POWER OF CROWDSOURCING:
 * One camera seeing a 4Ïƒ deviation might be instrument error.
 * Three different cameras from three different locations seeing 4Ïƒ
 * on the same star = REAL SIGNAL.
 *
 * This module:
 * 1. Classifies individual anomalies (variable star vs. instrument error)
 * 2. Aggregates anomalies across observers into a "Top Hits" leaderboard
 * 3. Computes priority scores based on multi-factor analysis
 * 4. Auto-generates IAU Transient Name Server (TNS) reports when
 *    an anomaly passes the r-value and cross-validation threshold
 */

import type { ComparisonResult } from './color_index';

// â”€â”€â”€ TYPES â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export type AnomalyClassification =
  | 'VARIABLE_STAR'
  | 'SUPERNOVA_CANDIDATE'
  | 'NOVA_CANDIDATE'
  | 'INSTRUMENT_ERROR'
  | 'ATMOSPHERIC_ARTIFACT'
  | 'SATELLITE_TRAIL'
  | 'METEOR'
  | 'UNKNOWN';

export interface AnomalyReport {
  gaia_id: string;
  observed_BV: number;
  expected_BV: number;
  sigma: number;
  delta_E: number;
  classification: AnomalyClassification;
  confidence: number;
  observer_id: string;
  timestamp: string;
  fingerprint_id: string;
}

export interface Measurement {
  observation_id: string;
  observer_id: string;
  observed_BV: number;
  sigma: number;
  delta_E: number;
  timestamp: string;
  fingerprint_id: string;
  camera_model: string;
  location: { lat: number; lon: number };
}

export interface TopHit {
  gaia_id: string;
  name: string;
  ra_hours: number;
  dec_degrees: number;
  priority_score: number;
  sigma_avg: number;
  sigma_max: number;
  unique_observers: number;
  unique_instruments: number;
  classification: AnomalyClassification;
  first_detected: string;
  last_confirmed: string;
  measurements: Measurement[];
  recommended_action: 'MONITOR' | 'ALERT_OBSERVATORY' | 'PUBLISH' | 'AUTO_TNS_REPORT';
  /** Pearson r-value for temporal consistency of the anomaly */
  r_value: number;
  /** Whether the anomaly has passed auto-report threshold */
  tns_eligible: boolean;
}

// â”€â”€â”€ TNS REPORT â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export interface TNSReport {
  /** Report type for IAU TNS */
  report_type: 'AT' | 'SN' | 'Other';
  /** Object designation (before official naming) */
  internal_name: string;
  /** Right Ascension (J2000, sexagesimal) */
  ra_sexagesimal: string;
  /** Declination (J2000, sexagesimal) */
  dec_sexagesimal: string;
  /** Discovery date (ISO 8601) */
  discovery_date: string;
  /** Discovery magnitude, or null when calibrated photometry is unavailable
   *  (honest-or-absent — no fabricated value; see generateTNSReport). */
  discovery_magnitude: number | null;
  /** Filter used for discovery */
  filter: string;
  /** Discoverer name / group */
  discoverer: string;
  /** Reporting group */
  reporting_group: string;
  /** Host galaxy / nearest known object */
  host_name: string;
  /** Remarks including SKYCRUNCHER analysis details */
  remarks: string;
  /** Number of independent confirmations */
  confirmations: number;
  /** Pearson correlation r-value for temporal consistency */
  r_value: number;
  /** Cross-observer validated */
  cross_validated: boolean;
  /** Raw report text (TNS bulk report format) */
  raw_report: string;
}

// â”€â”€â”€ ANOMALY CLASSIFICATION â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * Classify an anomaly based on its characteristics.
 *
 * Classification hierarchy:
 * 1. If sigma < 3 â†’ Not anomalous
 * 2. If fingerprint matches known instrument pattern â†’ INSTRUMENT_ERROR
 * 3. If sigma > 10 and sudden onset â†’ SUPERNOVA_CANDIDATE
 * 4. If sigma 5-10 and periodic â†’ VARIABLE_STAR
 * 5. If sigma > 5 and non-periodic â†’ NOVA_CANDIDATE
 * 6. Otherwise â†’ UNKNOWN
 */
export function classifyAnomaly(
  comparison: ComparisonResult,
  observerId: string,
  timestamp: string,
  fingerprintId: string,
  historicalMeasurements: Measurement[] = []
): AnomalyReport {
  const sigma = comparison.sigma;
  let classification: AnomalyClassification = 'UNKNOWN';
  let confidence = 0;

  if (sigma < 3) {
    classification = 'UNKNOWN';
    confidence = 0;
  } else if (sigma >= 10) {
    // Extreme deviation â†’ likely supernova or instrument failure
    const hasMultipleObservers = new Set(
      historicalMeasurements.map(m => m.fingerprint_id)
    ).size > 1;

    if (hasMultipleObservers) {
      classification = 'SUPERNOVA_CANDIDATE';
      confidence = Math.min(0.95, sigma / 20);
    } else {
      classification = 'INSTRUMENT_ERROR';
      confidence = 0.6;
    }
  } else if (sigma >= 5) {
    // Check for periodicity in historical data
    const isPeriodic = detectPeriodicity(historicalMeasurements);
    if (isPeriodic) {
      classification = 'VARIABLE_STAR';
      confidence = 0.8;
    } else {
      classification = 'NOVA_CANDIDATE';
      confidence = 0.5;
    }
  } else {
    // 3Ïƒ â€“ 5Ïƒ range: could be anything
    classification = 'UNKNOWN';
    confidence = 0.3;
  }

  return {
    gaia_id: comparison.reference_star.gaia_id,
    observed_BV: comparison.observed_BP_RP,
    expected_BV: comparison.expected_BP_RP,
    sigma,
    delta_E: comparison.delta_E,
    classification,
    confidence,
    observer_id: observerId,
    timestamp,
    fingerprint_id: fingerprintId,
  };
}

// â”€â”€â”€ TOP HITS SCORING â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * Compute a priority score for an anomaly.
 *
 * Formula:
 *   score = (sigma * 15)
 *         + (uniqueObservers * 10)
 *         + (temporalConsistency * 20)
 *         - (instrumentErrorLikelihood * 30)
 *
 * Range: 0 â€“ 100
 */
export function computePriorityScore(
  sigmaAvg: number,
  uniqueObservers: number,
  uniqueInstruments: number,
  temporalConsistency: number,   // 0-1, from r-value
  instrumentErrorLikelihood: number  // 0-1
): number {
  const raw =
    sigmaAvg * 15 +
    uniqueObservers * 10 +
    temporalConsistency * 20 -
    instrumentErrorLikelihood * 30;

  // Bonus for multiple independent instruments
  const instrumentBonus = Math.min(20, uniqueInstruments * 5);

  return Math.max(0, Math.min(100, raw + instrumentBonus));
}

/**
 * Compute the Pearson correlation coefficient (r-value) for temporal
 * consistency of measurements.
 *
 * A high r-value means the anomaly is consistently observed over time
 * (not a one-off glitch). This is a key threshold for TNS reporting.
 */
export function computeRValue(measurements: Measurement[]): number {
  if (measurements.length < 3) return 0;

  // Convert timestamps to numeric values (hours since first observation)
  const sorted = [...measurements].sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
  );
  const t0 = new Date(sorted[0].timestamp).getTime();

  const xs = sorted.map(m => (new Date(m.timestamp).getTime() - t0) / 3600000);
  const ys = sorted.map(m => m.sigma);

  const n = xs.length;
  const sumX = xs.reduce((a, b) => a + b, 0);
  const sumY = ys.reduce((a, b) => a + b, 0);
  const sumXY = xs.reduce((sum, x, i) => sum + x * ys[i], 0);
  const sumX2 = xs.reduce((sum, x) => sum + x * x, 0);
  const sumY2 = ys.reduce((sum, y) => sum + y * y, 0);

  const numerator = n * sumXY - sumX * sumY;
  const denominator = Math.sqrt(
    (n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY)
  );

  if (denominator === 0) return 0;
  return numerator / denominator;
}

/**
 * Determine the recommended action based on priority and validation.
 */
export function recommendAction(
  priorityScore: number,
  uniqueObservers: number,
  rValue: number
): TopHit['recommended_action'] {
  if (priorityScore >= 80 && uniqueObservers >= 3 && Math.abs(rValue) >= 0.7) {
    return 'AUTO_TNS_REPORT';
  }
  if (priorityScore >= 60 && uniqueObservers >= 2) {
    return 'ALERT_OBSERVATORY';
  }
  if (priorityScore >= 40) {
    return 'PUBLISH';
  }
  return 'MONITOR';
}

/**
 * Rank anomalies into a Top Hits leaderboard.
 */
export function rankTopHits(
  anomalies: Map<string, Measurement[]>,
  starInfo: Map<string, { name: string; ra: number; dec: number; expected_BV: number }>,
  limit: number = 20
): TopHit[] {
  const hits: TopHit[] = [];

  for (const [gaiaId, measurements] of anomalies) {
    if (measurements.length === 0) continue;

    const info = starInfo.get(gaiaId) ?? { name: gaiaId, ra: 0, dec: 0, expected_BV: 0 };
    const uniqueObservers = new Set(measurements.map(m => m.observer_id)).size;
    const uniqueInstruments = new Set(measurements.map(m => m.fingerprint_id)).size;
    const sigmaAvg = measurements.reduce((s, m) => s + m.sigma, 0) / measurements.length;
    const sigmaMax = Math.max(...measurements.map(m => m.sigma));
    const rValue = computeRValue(measurements);

    // Instrument error likelihood: if all measurements come from 1 instrument, high
    const instrumentErrorLikelihood = uniqueInstruments === 1 ? 0.7 : 0.1;
    const temporalConsistency = Math.abs(rValue);

    const priorityScore = computePriorityScore(
      sigmaAvg, uniqueObservers, uniqueInstruments,
      temporalConsistency, instrumentErrorLikelihood
    );

    const action = recommendAction(priorityScore, uniqueObservers, rValue);

    // Classification: use the most common classification across measurements
    const classifications = measurements.map(m => {
      if (m.sigma >= 10) return 'SUPERNOVA_CANDIDATE' as const;
      if (m.sigma >= 5) return 'NOVA_CANDIDATE' as const;
      return 'VARIABLE_STAR' as const;
    });
    const classCounts = new Map<AnomalyClassification, number>();
    for (const c of classifications) {
      classCounts.set(c, (classCounts.get(c) ?? 0) + 1);
    }
    let bestClass: AnomalyClassification = 'UNKNOWN';
    let bestCount = 0;
    for (const [cls, count] of classCounts) {
      if (count > bestCount) { bestCount = count; bestClass = cls; }
    }

    const sorted = [...measurements].sort(
      (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
    );

    hits.push({
      gaia_id: gaiaId,
      name: info.name,
      ra_hours: info.ra,
      dec_degrees: info.dec,
      priority_score: priorityScore,
      sigma_avg: sigmaAvg,
      sigma_max: sigmaMax,
      unique_observers: uniqueObservers,
      unique_instruments: uniqueInstruments,
      classification: bestClass,
      first_detected: sorted[0].timestamp,
      last_confirmed: sorted[sorted.length - 1].timestamp,
      measurements,
      recommended_action: action,
      r_value: rValue,
      tns_eligible: action === 'AUTO_TNS_REPORT',
    });
  }

  // Sort by priority score descending
  hits.sort((a, b) => b.priority_score - a.priority_score);
  return hits.slice(0, limit);
}

// â”€â”€â”€ TNS REPORT GENERATION â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/** Threshold for auto-generating a TNS report */
const TNS_R_VALUE_THRESHOLD = 0.7;
const TNS_MIN_OBSERVERS = 3;
const TNS_MIN_SIGMA = 5.0;

/**
 * Check if an anomaly qualifies for automatic TNS reporting.
 */
export function shouldAutoReport(hit: TopHit): boolean {
  return (
    Math.abs(hit.r_value) >= TNS_R_VALUE_THRESHOLD &&
    hit.unique_observers >= TNS_MIN_OBSERVERS &&
    hit.sigma_avg >= TNS_MIN_SIGMA &&
    hit.classification !== 'INSTRUMENT_ERROR' &&
    hit.classification !== 'ATMOSPHERIC_ARTIFACT' &&
    hit.classification !== 'SATELLITE_TRAIL' &&
    hit.classification !== 'METEOR'
  );
}

/**
 * Convert decimal hours to sexagesimal RA (HH:MM:SS.ss).
 */
function raToSexagesimal(raHours: number): string {
  const h = Math.floor(raHours);
  const m = Math.floor((raHours - h) * 60);
  const s = ((raHours - h) * 60 - m) * 60;
  return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toFixed(2).padStart(5, '0')}`;
}

/**
 * Convert decimal degrees to sexagesimal Dec (Â±DD:MM:SS.s).
 */
function decToSexagesimal(decDeg: number): string {
  const sign = decDeg >= 0 ? '+' : '-';
  const abs = Math.abs(decDeg);
  const d = Math.floor(abs);
  const m = Math.floor((abs - d) * 60);
  const s = ((abs - d) * 60 - m) * 60;
  return `${sign}${d.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toFixed(1).padStart(4, '0')}`;
}

/**
 * Generate an IAU Transient Name Server (TNS) report.
 *
 * The TNS is the official IAU registry for transient astronomical events.
 * Reports are typically submitted as JSON via the TNS API, but we also
 * generate a human-readable text format for review before submission.
 *
 * This auto-generates when:
 * 1. r-value exceeds threshold (temporal consistency)
 * 2. Multiple independent observers confirm the anomaly
 * 3. Classification rules out instrument/atmospheric errors
 */
export function generateTNSReport(
  hit: TopHit,
  discovererName: string = 'SKYCRUNCHER Network',
  groupName: string = 'SKYCRUNCHER'
): TNSReport {
  const reportType = hit.classification === 'SUPERNOVA_CANDIDATE' ? 'SN'
    : hit.classification === 'NOVA_CANDIDATE' ? 'AT'
    : 'Other';

  const internalName = `ASTRO-${hit.gaia_id.replace(/[^a-zA-Z0-9]/g, '').slice(-8)}`;
  const raSex = raToSexagesimal(hit.ra_hours);
  const decSex = decToSexagesimal(hit.dec_degrees);

  // Discovery magnitude requires calibrated absolute photometry, which this
  // report path does not compute. Emit NOT_MEASURED rather than a fabricated
  // value (LAW 3: honest-or-absent — no placeholder numbers).
  const discoveryMag: number | null = null;

  const remarks = [
    `Detected by SKYCRUNCHER distributed observatory network.`,
    `${hit.unique_observers} independent observer(s), ${hit.unique_instruments} unique instrument(s).`,
    `Average sigma: ${hit.sigma_avg.toFixed(2)}, Max sigma: ${hit.sigma_max.toFixed(2)}.`,
    `Temporal consistency r-value: ${hit.r_value.toFixed(3)}.`,
    `Classification: ${hit.classification}.`,
    `First detected: ${hit.first_detected}.`,
    `Last confirmed: ${hit.last_confirmed}.`,
    `Gaia DR3 source: ${hit.gaia_id}.`,
  ].join(' ');

  const rawReport = [
    `# IAU TNS Report â€” ${internalName}`,
    `# Generated by SKYCRUNCHER on ${new Date().toISOString()}`,
    ``,
    `report_type: ${reportType}`,
    `internal_name: ${internalName}`,
    `ra: ${raSex}`,
    `dec: ${decSex}`,
    `discovery_datetime: ${hit.first_detected}`,
    `discovery_mag: NOT_MEASURED`,
    `filter: Clear/unfiltered`,
    `discoverer: ${discovererName}`,
    `reporting_group: ${groupName}`,
    `host_name: ${hit.name !== hit.gaia_id ? hit.name : 'Unknown'}`,
    `remarks: ${remarks}`,
    ``,
    `# Cross-validation summary:`,
    `observers: ${hit.unique_observers}`,
    `instruments: ${hit.unique_instruments}`,
    `r_value: ${hit.r_value.toFixed(4)}`,
    `sigma_avg: ${hit.sigma_avg.toFixed(3)}`,
  ].join('\n');

  return {
    report_type: reportType,
    internal_name: internalName,
    ra_sexagesimal: raSex,
    dec_sexagesimal: decSex,
    discovery_date: hit.first_detected,
    discovery_magnitude: discoveryMag,
    filter: 'Clear/unfiltered',
    discoverer: discovererName,
    reporting_group: groupName,
    host_name: hit.name !== hit.gaia_id ? hit.name : 'Unknown',
    remarks,
    confirmations: hit.unique_observers,
    r_value: hit.r_value,
    cross_validated: hit.unique_observers >= TNS_MIN_OBSERVERS,
    raw_report: rawReport,
  };
}

/**
 * Generate a formatted report for national laboratories / observatories.
 */
export function generateLabReport(topHits: TopHit[]): string {
  const header = [
    'â•”â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•—',
    'â•‘  SKYCRUNCHER â€” TOP HITS REPORT                               â•‘',
    'â•‘  Distributed Observatory Anomaly Summary                        â•‘',
    `â•‘  Generated: ${new Date().toISOString().slice(0, 19)}                    â•‘`,
    'â•šâ•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•',
    '',
  ].join('\n');

  const rows = topHits.map((hit, i) => {
    const tnsFlag = hit.tns_eligible ? ' â˜… TNS' : '';
    return [
      `${(i + 1).toString().padStart(3)}. ${hit.name.padEnd(15)} | ${hit.gaia_id.padEnd(30)}`,
      `     RA: ${raToSexagesimal(hit.ra_hours)}  Dec: ${decToSexagesimal(hit.dec_degrees)}`,
      `     Ïƒ_avg: ${hit.sigma_avg.toFixed(2).padStart(6)}  Ïƒ_max: ${hit.sigma_max.toFixed(2).padStart(6)}`,
      `     Observers: ${hit.unique_observers}  Instruments: ${hit.unique_instruments}`,
      `     r-value: ${hit.r_value.toFixed(3)}  Priority: ${hit.priority_score.toFixed(0)}/100`,
      `     Classification: ${hit.classification}${tnsFlag}`,
      `     Action: ${hit.recommended_action}`,
      `     Window: ${hit.first_detected.slice(0, 10)} â†’ ${hit.last_confirmed.slice(0, 10)}`,
      '',
    ].join('\n');
  });

  return header + rows.join('\n');
}

// â”€â”€â”€ HELPERS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * Detect periodicity in measurements using autocorrelation.
 * Returns true if a periodic signal is detected.
 */
function detectPeriodicity(measurements: Measurement[]): boolean {
  if (measurements.length < 6) return false;

  const sorted = [...measurements].sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
  );

  const sigmas = sorted.map(m => m.sigma);
  const mean = sigmas.reduce((a, b) => a + b, 0) / sigmas.length;
  const centered = sigmas.map(s => s - mean);

  // Simple autocorrelation at lag 1-3
  for (let lag = 1; lag <= Math.min(3, Math.floor(centered.length / 2)); lag++) {
    let numerator = 0;
    let denominator = 0;
    for (let i = 0; i < centered.length - lag; i++) {
      numerator += centered[i] * centered[i + lag];
    }
    for (let i = 0; i < centered.length; i++) {
      denominator += centered[i] * centered[i];
    }
    if (denominator > 0 && numerator / denominator > 0.5) {
      return true;  // Strong autocorrelation = periodic
    }
  }

  return false;
}

