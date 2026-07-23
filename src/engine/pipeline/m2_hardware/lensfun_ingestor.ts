
/**
 * ΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉ
 * LENSFUN INGESTOR ΓÇö The Hardware Detective
 * ΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉ
 * 
 * Responsible for ingesting and parsing the Lensfun XML database.
 * Normalizes lens data into a robust JSON format for the SkyCruncher.
 */

import { matchLens, extractFocalsMm, type LensRegistryEntry } from './identifier_matcher';

/**
 * ─── LENSFUN PHOTOMETRIC (VIGNETTING) MODEL ─────────────────────────────────
 * Lensfun ships exactly ONE vignetting model, "pa" (the PanoTools/Hugin radial
 * photometric polynomial). Its stored coefficients k1/k2/k3 encode the ATTENUATION
 *
 *     att(r) = 1 + k1·r² + k2·r⁴ + k3·r⁶
 *
 * where the OBSERVED brightness = ideal · att(r), so the correction is
 * ideal = observed / att(r) (k1 is typically negative → light falls off toward the
 * edges). `r` is the radius NORMALIZED TO THE HALF-DIAGONAL (r = 1 at the image
 * corner) — the hugin/lensfun stored-coefficient convention, which is the SAME
 * normalization our internal `m10_psf/vignette_map.ts` (a2/a4 over the half-diag
 * from center) uses. Convention verified against a real XF23mmF2 f/2 prior by the
 * row-509 researcher: D:/AstroLogic/test_artifacts/vignette_prior_check_2026-07-22/
 * deviation_stats.json — "half-diagonal, r=1 at image corner
 * (hugin/lensfun stored-coeff convention == our r_norm)" (f/2 edge attenuation
 * lf_edge_I = 0.3559506918230613 at r = 0.821).
 *
 * This is a BOOK PRIOR (published DB coefficients), NEVER a measured per-frame fit
 * → always tier APPROXIMATE. Breakpoints are keyed on (focal, aperture, distance);
 * `selectVignetting` picks nearest by (focal, aperture) and RECORDS the choice.
 * INGEST ONLY — no consumer wiring; the per-star 4-way application rides the
 * trusted-fit gate (WIRING_SPEC R8; PSF_RENDER_PROGRAM_AUDIT item 9).
 */

/** One lensfun "pa" vignetting breakpoint (attenuation polynomial). */
export interface VignettePABreakpoint {
    focal: number;      // mm
    aperture: number;   // f-number
    distance: number;   // focus distance (m); Infinity for the lensfun "1000"/∞ sentinel
    k1: number;         // att(r)=1+k1·r²+k2·r⁴+k3·r⁶  (r over half-diag, r=1 at corner)
    k2: number;
    k3: number;
}

/** A lens's ingested lensfun vignetting model (pa only), tier APPROXIMATE. */
export interface LensfunVignetting {
    model: 'pa';
    tier: 'APPROXIMATE';
    breakpoints: VignettePABreakpoint[];
}

/** The recorded outcome of a nearest-breakpoint selection. */
export interface VignetteSelection {
    breakpoint: VignettePABreakpoint;
    requested: { focal: number; aperture: number };
    /** breakpoint.focal − requested.focal (mm). */
    focalDeltaMm: number;
    /** breakpoint.aperture − requested.aperture (f-stops). */
    apertureDelta: number;
    /** True when the chosen breakpoint matches the request exactly on both axes. */
    exact: boolean;
}

export interface LensProfile {
    model: string;
    make: string;
    mount: string;
    cropFactor: number;
    calibration: {
        distortion?: {
            model: 'ptlens' | 'poly3' | 'poly5';
            focalLength: number;
            k1: number; // mapped from a
            k2: number; // mapped from b
            k3: number; // mapped from c
        }[];
        /** Lensfun "pa" photometric prior (APPROXIMATE book prior; ingest-only). */
        vignetting?: LensfunVignetting;
    };
    aliases: string[];
}

export class LensfunIngestor {

    private static readonly BASE_URL = 'https://raw.githubusercontent.com/lensfun/lensfun/master/data/db/';
    
    // Common files to fetch (we can't list the directory easily without GitHub API)
    private static readonly FILES = [
        'mil-samyang.xml',
        'mil-sony.xml',
        'mil-canon.xml',
        'mil-nikon.xml',
        'mil-sigma.xml',
        'mil-zeiss.xml',
        'slr-canon.xml',
        'slr-nikon.xml',
        'slr-samyang.xml',
        'slr-sigma.xml',
        'slr-tamron.xml',
        'slr-tokina.xml',
        'slr-zeiss.xml'
    ];

    private static readonly BRAND_ALIASES: Record<string, string[]> = {
        'Samyang': ['Rokinon', 'Bower', 'Walimex', 'Vivitar', 'Falcon', 'Pro-Optic', 'Opteka'],
        'Rokinon': ['Samyang'], // Reverse lookup helper
    };

    /**
     * Ingests the Lensfun database and returns a normalized map.
     */
    public static async ingest(): Promise<LensProfile[]> {
        const profiles: LensProfile[] = [];
        const parser = new DOMParser();

        console.log('[LensfunIngestor] Starting ingestion...');

        for (const file of this.FILES) {
            try {
                const url = `${this.BASE_URL}${file}`;
                console.log(`[LensfunIngestor] Fetching ${url}...`);
                const response = await fetch(url);
                if (!response.ok) {
                    console.warn(`[LensfunIngestor] Failed to fetch ${file}: ${response.statusText}`);
                    continue;
                }
                const text = await response.text();
                const doc = parser.parseFromString(text, 'text/xml');
                
                const lenses = doc.querySelectorAll('lens');
                
                lenses.forEach(lens => {
                    const profile = this.parseLensNode(lens);
                    if (profile) profiles.push(profile);
                });

            } catch (err) {
                console.error(`[LensfunIngestor] Error processing ${file}:`, err);
            }
        }

        console.log(`[LensfunIngestor] Ingested ${profiles.length} lens profiles.`);
        return profiles;
    }

    private static parseLensNode(lensNode: Element): LensProfile | null {
        const makerNode = lensNode.querySelector('maker');
        const modelNode = lensNode.querySelector('model');
        const mountNode = lensNode.querySelector('mount');
        const cropNode = lensNode.querySelector('cropfactor');
        
        if (!makerNode || !modelNode) return null;

        const make = makerNode.textContent || 'Unknown';
        const model = modelNode.textContent || 'Unknown';
        const mount = mountNode ? mountNode.textContent || 'Generic' : 'Generic';
        const cropFactor = cropNode ? parseFloat(cropNode.textContent || '1.0') : 1.0;

        const profile: LensProfile = {
            make,
            model,
            mount,
            cropFactor,
            calibration: { distortion: [] },
            aliases: []
        };

        // Handle Aliases
        if (this.BRAND_ALIASES[make]) {
            profile.aliases = this.BRAND_ALIASES[make];
        }

        // Parse Calibration
        const calibrations = lensNode.querySelectorAll('calibration');
        const vignBreakpoints: VignettePABreakpoint[] = [];
        calibrations.forEach(cal => {
            const distortion = cal.querySelector('distortion');
            if (distortion) {
                const distModel = distortion.getAttribute('model') || 'ptlens';
                const focal = parseFloat(distortion.getAttribute('focal') || '0');
                const k1 = parseFloat(distortion.getAttribute('k1') || '0'); // PTLens a
                const k2 = parseFloat(distortion.getAttribute('k2') || '0'); // PTLens b
                const k3 = parseFloat(distortion.getAttribute('k3') || '0'); // PTLens c

                // Lensfun uses "k1" attribute for "a" coefficient in PTLens model usually?
                // Actually, Lensfun XML attributes are often `k1`, `k2`, `k3` directly even for PTLens model.
                // We map them 1:1 for now, assuming the Flattening Engine understands the model type.
                // But specifically for PTLens: a -> k1, b -> k2, c -> k3.

                profile.calibration.distortion?.push({
                    model: distModel as any,
                    focalLength: focal,
                    k1,
                    k2,
                    k3
                });
            }

            // Parse Vignetting — the SAME DOM walk as distortion. Lensfun ships
            // only model="pa"; `parseVignettingModel` gates it and coerces the
            // (focal, aperture, distance, k1..k3) into a typed pa breakpoint.
            const vigs = cal.querySelectorAll('vignetting');
            vigs.forEach(v => {
                const bp = LensfunIngestor.parseVignettingModel({
                    model: v.getAttribute('model'),
                    focal: v.getAttribute('focal'),
                    aperture: v.getAttribute('aperture'),
                    distance: v.getAttribute('distance'),
                    k1: v.getAttribute('k1'),
                    k2: v.getAttribute('k2'),
                    k3: v.getAttribute('k3'),
                });
                if (bp) vignBreakpoints.push(bp);
            });
        });
        if (vignBreakpoints.length > 0) {
            profile.calibration.vignetting = { model: 'pa', tier: 'APPROXIMATE', breakpoints: vignBreakpoints };
        }

        return profile;
    }

    /**
     * Parse ONE lensfun `<vignetting>` attribute map → a typed pa breakpoint, or
     * `null` for a non-"pa" / malformed / unkeyed entry (honest absence). PURE —
     * shared by the DOM ingest path and the DOM-free `parseVignettingTags`.
     * Lensfun encodes k1/k2/k3 as the pa attenuation-polynomial coefficients
     * directly (see the LENSFUN PHOTOMETRIC MODEL header above).
     */
    public static parseVignettingModel(
        attrs: Record<string, string | null | undefined>,
    ): VignettePABreakpoint | null {
        const model = String(attrs.model ?? '').trim().toLowerCase();
        if (model !== 'pa') return null; // lensfun ships only the "pa" vignetting model today
        const num = (v: string | null | undefined, d: number): number => {
            const n = parseFloat(String(v ?? ''));
            return Number.isFinite(n) ? n : d;
        };
        const focal = num(attrs.focal, NaN);
        const aperture = num(attrs.aperture, NaN);
        // Breakpoints MUST be keyed on (focal, aperture) — an unkeyed entry cannot
        // be selected against, so it is dropped rather than silently mis-selected.
        if (!Number.isFinite(focal) || !Number.isFinite(aperture)) return null;
        // Lensfun uses "1000" (m) as the ∞-focus sentinel for most vignetting rows.
        const rawDist = num(attrs.distance, 1000);
        const distance = rawDist >= 1000 ? Infinity : rawDist;
        return { focal, aperture, distance, k1: num(attrs.k1, 0), k2: num(attrs.k2, 0), k3: num(attrs.k3, 0) };
    }

    /**
     * DOM-FREE parse of every `<vignetting>` tag in a lens-node XML fragment.
     * The live `ingest()` runs in the BROWSER via DOMParser, but node/tools + unit
     * tests have no DOMParser — this regex path parses the same tags without a DOM
     * (and is the node-side ingest entry). Returns `null` when the fragment carries
     * no valid pa breakpoint (honest absence).
     */
    public static parseVignettingTags(xml: string): LensfunVignetting | null {
        const breakpoints: VignettePABreakpoint[] = [];
        const tagRe = /<vignetting\b([^>]*?)\/?>/gi;
        let m: RegExpExecArray | null;
        while ((m = tagRe.exec(xml)) !== null) {
            const attrs: Record<string, string> = {};
            const attrRe = /([\w:-]+)\s*=\s*"([^"]*)"/g;
            let a: RegExpExecArray | null;
            while ((a = attrRe.exec(m[1])) !== null) attrs[a[1].toLowerCase()] = a[2];
            const bp = this.parseVignettingModel(attrs);
            if (bp) breakpoints.push(bp);
        }
        if (breakpoints.length === 0) return null;
        return { model: 'pa', tier: 'APPROXIMATE', breakpoints };
    }

    /**
     * Nearest-breakpoint selection by (focal, aperture) — focal is the primary key
     * (the bigger physical driver of vignetting), aperture breaks focal ties. The
     * chosen breakpoint AND the deltas are RECORDED so a consumer can honestly
     * report which book breakpoint (and how far off) fed a correction. Returns
     * `null` on an empty/absent model.
     */
    public static selectVignetting(
        vig: LensfunVignetting | null | undefined,
        focal: number,
        aperture: number,
    ): VignetteSelection | null {
        if (!vig || vig.breakpoints.length === 0) return null;
        let best = vig.breakpoints[0];
        for (const b of vig.breakpoints) {
            const dfBest = Math.abs(best.focal - focal);
            const dfB = Math.abs(b.focal - focal);
            if (dfB < dfBest - 1e-9) { best = b; continue; }
            if (Math.abs(dfB - dfBest) <= 1e-9 &&
                Math.abs(b.aperture - aperture) < Math.abs(best.aperture - aperture) - 1e-9) {
                best = b;
            }
        }
        return {
            breakpoint: best,
            requested: { focal, aperture },
            focalDeltaMm: best.focal - focal,
            apertureDelta: best.aperture - aperture,
            exact: best.focal === focal && best.aperture === aperture,
        };
    }

    /**
     * Helper to find a profile by name, checking aliases.
     *
     * Routes through the canonical `matchLens` (identifier_matcher.ts) so the
     * lens-domain lookup can't reintroduce the loose-substring bug: the old body
     * matched `model` with a single-direction `.includes()`, so `'35mm'` matched
     * `'135mm'` (35 ⊂ 135) and a bare focal matched siblings (flag #9). Now:
     * exact full-model → brand+focal agreement → honest undefined. Focal is by
     * numeric equality (35 ≠ 135), never substring. Dead-path insurance today
     * (getDistortionProfile/LandDatabaseAdapter have no live caller).
     */
    public static findProfile(db: LensProfile[], make: string, model: string): LensProfile | undefined {
        // Direct exact match (make + model) — fast path, preserved.
        const direct = db.find(p =>
            p.make.toLowerCase() === make.toLowerCase() &&
            p.model.toLowerCase() === model.toLowerCase()
        );
        if (direct) return direct;

        // Otherwise defer to the shared lens matcher (brand aliases + numeric
        // focal agreement). A lensfun maker's brand aliases (Samyang↔Rokinon↔…)
        // are folded into the matcher's own alias table.
        const registry: LensRegistryEntry<LensProfile>[] = db.map(p => ({
            entry: p,
            model: p.model,
            manufacturer: [p.make, ...p.aliases].join(' '),
            focalLengths: extractFocalsMm(p.model),
        }));
        return matchLens({ make, model }, registry) ?? undefined;
    }
}

