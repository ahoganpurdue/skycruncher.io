/**
 * ═══════════════════════════════════════════════════════════════════════════
 * IDENTIFIER MATCHER — the canonical identifier→registry lookup (ultracode 2026-07-10)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ONE home for every "resolve an identifier string (camera body / lens model /
 * rig tag) to a registry entry" lookup, so the loose-substring bug class cannot
 * recur. It generalizes the already-correct `sensor_db.findSensorByCamera`
 * semantics (@005a91a: exact-first + overlap-scored + ambiguity→null) and adds
 * the RESIDUAL-TOKEN guard that the `optics_resolver` R6 residual exposed.
 *
 * LEDGER: N/A (pure string/identity logic — no COORDINATE math, no PIXEL ops).
 * LAW 4 (incubator / one-home): every ad-hoc identifier matcher routes HERE; the
 * `identifier_matcher.conformance.test.ts` grep-pin (M5) keeps it that way.
 *
 * LADDER PRINCIPLE — honest-null over a wrong entry, ALWAYS:
 *   0. SERIAL exact (M6, when a per-serial resolver is supplied)  → per-copy entry.
 *   1. EXACT normalized-string equality                          → wins outright.
 *      Two DISTINCT entries claiming the same exact form         → null (DB defect).
 *   2. Specificity substring: overlap = min(len(body), len(query)); best wins.
 *      Best overlap tied by ≥2 DISTINCT entries                  → null.
 *   3. RESIDUAL-TOKEN GUARD: a confident substring return requires the matched
 *      body's CORE token-set (brand/filler stripped) to EQUAL the query's core
 *      token-set. A query that drops (or adds) a DISTINGUISHING token vs the
 *      matched body (`R6` ⊄ `R6 II`, `T7i` ≠ `T7`)              → null.
 *   4. Nothing clean                                             → null.
 *
 * WHY RULE 3 IS NEW WORK (not covered by @005a91a): the sensor-DB fix closes
 * DB-*internal* sibling ties (bare `5d mark ii` ties 5D2/5D3 → null) and
 * length-specificity, but when a real full EXIF body is simply ABSENT and is a
 * clean prefix of one LONE longer sibling, the ambiguity check has nothing to
 * tie against and returns a confident wrong profile (`Canon EOS R6` → the
 * `R6 II` sensor). Rule 3 treats "query differs from the matched body by a
 * distinguishing (non-filler) token" as NON-confident. It is deliberately scoped
 * to the tier-2 substring winner only, so it can never turn a tier-1 exact match
 * (the SeeStar / bundled-CR2 body resolves) into a miss.
 */

// ─── QUERY SIGNATURE (M6: serial-aware; serial optional / absent-tolerant) ───

/** Generic identifier query. `serial` is optional and absent-tolerant today —
 *  the per-copy (Optical Workbench) resolver is stubbed to the model tier until
 *  the body-serial-surface leg (branch `m1/body-serial-surface`) merges. */
export interface IdentifierQuery {
  make?: string;
  model: string;
  serial?: string;
}

// ─── SHARED TOKEN HELPERS ────────────────────────────────────────────────────

/** Lowercase + split on any run of non-alphanumerics. `t6i` stays one token
 *  (no boundary between `t6` and `i`), so `t6` never matches `t6i`/`t6s`. */
export function tokenize(raw: string): string[] {
  return raw.toLowerCase().split(/[^a-z0-9]+/i).filter(Boolean);
}

/** Whole-token membership (word-boundary match) — the rig-tag / M4 primitive:
 *  `hasWholeToken('Canon EOS Rebel T6i', 't6')` is FALSE, but
 *  `hasWholeToken('Canon T6 + Rokinon 14mm', 't6')` is TRUE. */
export function hasWholeToken(haystack: string | null | undefined, token: string): boolean {
  if (!haystack) return false;
  const t = token.toLowerCase();
  return tokenize(haystack).includes(t);
}

/** Brand/series words that do NOT establish sibling identity in a body string.
 *  Everything NOT in this set (generation numerals, `pro`, model codes like
 *  `r6`/`t6`/`s30`) is a DISTINGUISHING "core" token for rule 3. */
const BODY_FILLER = new Set([
  'canon', 'eos', 'nikon', 'sony', 'zwo', 'qhy', 'asi', 'rebel', 'seestar',
  'camera', 'digital', 'mark', 'kiss',
]);

/** Core token set = tokens minus brand/filler. Rule-3 confidence key. */
function coreTokenSet(s: string): Set<string> {
  const out = new Set<string>();
  for (const t of tokenize(s)) if (!BODY_FILLER.has(t)) out.add(t);
  return out;
}

function setsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

/** Rule 3: a tier-2 substring winner is CONFIDENT only when the query and the
 *  matched body share the same core (distinguishing) token set. Differing only
 *  by filler/brand tokens is fine (`EOS Rebel T6` ⇄ `Canon EOS Rebel T6`);
 *  differing by a distinguishing token is a residual misroute (`R6` vs
 *  `R6 II`). */
function isConfidentBodyMatch(query: string, body: string): boolean {
  return setsEqual(coreTokenSet(query), coreTokenSet(body));
}

// ─── BODY-STRING DOMAIN (generalizes findSensorByCamera; also rig-body lookups) ──

/** A registry entry keyed by one or more body/model strings. */
export interface BodyRegistryEntry<T> {
  entry: T;
  /** All acceptable body strings/aliases for this entry (case-insensitive). */
  bodies: string[];
}

/**
 * Resolve an identifier to a registry entry by body-string match. Mirrors the
 * post-@005a91a `findSensorByCamera` ladder EXACTLY (tier 1 exact / tier 2
 * overlap-scored substring / ambiguity→null) and ADDS the rule-3 residual guard
 * on the surviving tier-2 winner. `serialResolve` (M6) is consulted FIRST when
 * both it and a serial are supplied; it is inert (returns null) by default.
 */
export function matchByBody<T>(
  query: string,
  registry: Iterable<BodyRegistryEntry<T>>,
  opts?: { serial?: string; serialResolve?: (serial: string) => T | null },
): T | null {
  // Tier 0 — per-serial (M6): stubbed to null today (model-tier fallback).
  if (opts?.serial && opts.serialResolve) {
    const perCopy = opts.serialResolve(opts.serial);
    if (perCopy != null) return perCopy;
  }

  const st = query.toLowerCase().trim();
  if (!st) return null;

  let exact: T | null = null;
  let exactAmbiguous = false;
  let best: { entry: T; overlap: number; body: string; ambiguous: boolean } | null = null;

  for (const { entry, bodies } of registry) {
    for (const body of bodies) {
      const b = body.toLowerCase();
      if (b === st) {
        if (exact !== null && exact !== entry) exactAmbiguous = true;
        exact = entry;
        continue;
      }
      if (b.includes(st) || st.includes(b)) {
        const overlap = Math.min(b.length, st.length);
        if (!best || overlap > best.overlap) {
          best = { entry, overlap, body, ambiguous: false };
        } else if (overlap === best.overlap && best.entry !== entry) {
          best.ambiguous = true;
        }
      }
    }
  }

  if (exact !== null) return exactAmbiguous ? null : exact;
  // Rule 3: only return a tier-2 substring winner when it is CONFIDENT.
  if (best && !best.ambiguous && isConfidentBodyMatch(st, best.body)) return best.entry;
  return null;
}

/** Optional per-copy (serial-first) resolver. Stubbed OFF today; wired to the
 *  Optical Workbench per-serial store when body-serial-surfacing graduates. */
export type SerialResolve<T> = (serial: string) => T | null;

/**
 * Canonical serial-aware entry point (§2.2 signature). Ladder:
 *   tier 0 — SERIAL exact (when a serial AND a `serialResolve` are supplied):
 *            the measured per-copy profile wins over any model-tier match. This
 *            is WHY exact-first + honest-null is non-negotiable — a per-serial
 *            world cannot tolerate a model-substring shadowing a measured
 *            per-copy profile.
 *   tier 1+ — model-tier body match (matchByBody: exact / overlap / rule-3).
 *
 * `serial` is optional and ABSENT-TOLERANT: with no serial (or no resolver) this
 * is byte-identical to `matchByBody(query.model, …)`. `make` is reserved for a
 * future normalizer; the model tier keys on `query.model` today so existing
 * call sites (findSensorByCamera) are unchanged. The `m1/body-serial-surface`
 * leg is unmerged, so no producer supplies `serial` yet.
 */
export function matchIdentifier<T>(
  query: IdentifierQuery,
  registry: Iterable<BodyRegistryEntry<T>>,
  opts?: { serialResolve?: SerialResolve<T> },
): T | null {
  return matchByBody(query.model, registry, {
    serial: query.serial,
    serialResolve: opts?.serialResolve,
  });
}

// ─── LENS DOMAIN (a bare focal length is NOT identity) ───────────────────────

/**
 * Brand token → canonical brand. Rebadge families collapse to one canonical id
 * (Rokinon ⇄ Samyang ⇄ Bower ⇄ Walimex ⇄ …), so a Samyang query resolves the
 * Rokinon profile. Covers the lensfun BRAND_ALIASES set (M5) too.
 */
const LENS_BRAND_ALIASES: Record<string, string> = {
  rokinon: 'rokinon', samyang: 'rokinon', bower: 'rokinon', walimex: 'rokinon',
  vivitar: 'rokinon', falcon: 'rokinon', 'pro-optic': 'rokinon', opteka: 'rokinon',
  canon: 'canon', nikon: 'nikon', sony: 'sony', sigma: 'sigma', tamron: 'tamron',
  tokina: 'tokina', zeiss: 'zeiss', pentax: 'pentax', fujifilm: 'fujifilm',
  fujinon: 'fujifilm', olympus: 'olympus', panasonic: 'panasonic', leica: 'leica',
};

/** Canonicalize a single lowercase brand token, or null if not a known brand. */
function canonBrand(token: string): string | null {
  return LENS_BRAND_ALIASES[token] ?? null;
}

/** All canonical brands named in a manufacturer string ('Rokinon / Samyang' → {rokinon}). */
function brandsOf(manufacturer: string): Set<string> {
  const out = new Set<string>();
  for (const t of tokenize(manufacturer)) {
    const cb = canonBrand(t);
    if (cb) out.add(cb);
  }
  return out;
}

/** Extract focal lengths (mm) from a lens string. Ranges ('15-35mm') contribute
 *  BOTH endpoints. A number is a focal ONLY when immediately followed by 'mm' —
 *  so '135mm' → 135, never 35 (the substring bug this closes). */
export function extractFocalsMm(raw: string): number[] {
  const focals: number[] = [];
  const re = /(\d+(?:\.\d+)?)(?:-(\d+(?:\.\d+)?))?\s*mm\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw.toLowerCase())) !== null) {
    focals.push(parseFloat(m[1]));
    if (m[2]) focals.push(parseFloat(m[2]));
  }
  return focals;
}

/** Parse a free-text lens string into {normalized, brand, focals(mm)}. */
function parseLens(raw: string): { norm: string; brand: string | null; focals: number[] } {
  const norm = raw.toLowerCase().replace(/\s+/g, ' ').trim();
  let brand: string | null = null;
  for (const t of tokenize(norm)) {
    const cb = canonBrand(t);
    if (cb) { brand = cb; break; }
  }
  return { norm, brand, focals: extractFocalsMm(norm) };
}

/** A lens registry entry the matcher can score. */
export interface LensRegistryEntry<T> {
  entry: T;
  /** Canonical model string, e.g. '14mm f/2.8 ED AS IF UMC'. */
  model: string;
  /** Manufacturer string (aliases folded via brandsOf), e.g. 'Rokinon / Samyang'. */
  manufacturer: string;
  /** Sampled focal lengths (mm) this profile covers. */
  focalLengths: number[];
}

/**
 * Resolve a lens query to a registry entry. Ladder:
 *   1. EXACT normalized full-model string (make-prefixed or bare) → win; a
 *      distinct-entry exact collision → null.
 *   2. BRAND + FOCAL agreement: query brand (alias-resolved) matches the
 *      profile's manufacturer AND a query focal is covered by the profile.
 *      Exactly one such entry → win; ≥2 → null (ambiguous).
 *   3. Anything less (bare focal with no brand, brand with no DB entry, brand
 *      present but focal mismatch) → null. **Focal alone is never identity.**
 */
export function matchLens<T>(
  query: IdentifierQuery,
  registry: Iterable<LensRegistryEntry<T>>,
): T | null {
  const raw = `${query.make ?? ''} ${query.model ?? ''}`.trim();
  const q = parseLens(raw);
  if (!q.norm) return null;

  const items = Array.from(registry);

  // Tier 1 — exact full-model string.
  let exact: T | null = null;
  let exactAmbiguous = false;
  for (const it of items) {
    if (it.model.toLowerCase().replace(/\s+/g, ' ').trim() === q.norm) {
      if (exact !== null && exact !== it.entry) exactAmbiguous = true;
      exact = it.entry;
    }
  }
  if (exact !== null) return exactAmbiguous ? null : exact;

  // Tier 2 — brand + focal agreement (both required; focal alone is insufficient).
  if (q.brand !== null && q.focals.length > 0) {
    const matches: T[] = [];
    for (const it of items) {
      const brandOk = brandsOf(it.manufacturer).has(q.brand);
      const focalOk = q.focals.some((f) => it.focalLengths.includes(f));
      if (brandOk && focalOk && !matches.includes(it.entry)) matches.push(it.entry);
    }
    if (matches.length === 1) return matches[0];
    return null; // 0 (brand present, no entry) or ≥2 (ambiguous) → honest null
  }

  // Bare focal / no brand / no exact model → honest UNKNOWN.
  return null;
}
