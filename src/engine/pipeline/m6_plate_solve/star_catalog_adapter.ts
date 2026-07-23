
import { StandardStar } from './standard_stars';
import { AstrometryEngine } from '../m7_astrometry/astrometry_engine';
import { loadAtlasWithLocalTier } from './atlas_local_tier';

/**
 * Atlas asset loader — takes the same path strings the browser fetches
 * (`/atlas/...`) and returns a Response. Injectable via
 * StarCatalogAdapter.setAtlasLoader for headless (Node) consumers.
 */
export type AtlasLoader = (path: string) => Promise<Response>;

/**
 * Starplates v2 query signature (adapter units: RA in HOURS). Returns
 * mag-sorted StandardStar[] or null on failure (⇒ fall back to v1).
 * Injectable via StarCatalogAdapter.setStarplatesQuery for tests.
 */
export type StarplatesQueryFn = (
    raCenterHours: number, decCenterDeg: number, radiusDeg: number, obsJd: number
) => Promise<StandardStar[] | null>;

/**
 * Deep-catalog row for the CONFIRM lane (g15u Gaia-only source). Position + G
 * mag + id — the subset projectCatalogToPixels + the neighbor lane read. RA is
 * in HOURS (converted from the arrow's degrees at the g15u boundary).
 */
export interface DeepCatalogRow {
    ra_hours: number;
    dec_degrees: number;
    magnitude_V: number;
    gaia_id: string;
    band: 'GaiaG';
}

/**
 * g15u deep-catalog cone query (adapter units: RA in HOURS). Returns MAG-SORTED
 * rows (`magMin < g_mag <= magLimit`) or null on any absence (⇒ hybrid fallback).
 * Injectable via StarCatalogAdapter.setG15uQuery for tests (mirrors
 * setStarplatesQuery).
 */
export type G15uQueryFn = (
    raHours: number, decDeg: number, radiusDeg: number, magLimit: number
) => Promise<DeepCatalogRow[] | null>;

/**
 * Honest catalog-health record (LAW 3). The adapter used to swallow every
 * catalog failure to the console and return silently — in the packaged app a
 * failed atlas/sector load made the whole solve fail INVISIBLY (bare
 * no-solution). This record distinguishes REAL failures (network error, JSON
 * parse failure, atlas never loaded) — which are RECORDED and EMITTED — from a
 * legitimately-absent/empty sector (a void sky region that 404s or returns an
 * empty list), which is normal and stays SILENT. No fabricated values: every
 * field is a measured count / boolean / the real error text.
 */
export interface CatalogHealth {
    /** Atlas anchor load (level 1 & 2) threw — the catalog is unusable. */
    atlasLoadFailed: boolean;
    /** loadCatalog() completed and the anchors are in memory. */
    loaded: boolean;
    /** Sector loads that THREW (network error / JSON parse failure) — REAL failures. */
    sectorLoadErrors: number;
    /** Sector fetches that returned !ok (404/5xx). RECORDED, not emitted — a void
     *  sky sector legitimately 404s, so a single miss is ambiguous (stays silent). */
    sectorHttpMisses: number;
    /** findStarsInField was called before the catalog finished loading — REAL. */
    queriedBeforeLoad: boolean;
    /** Human text of the most recent REAL failure (never a fabricated value). */
    lastError: string | null;
}

/** A honest-degradation warning shaped exactly like the event bus `warning` kind. */
export type CatalogHealthWarning = { kind: 'warning'; message: string; stage?: string };

/** Sink for catalog-health warnings — a `PipelineEventBus.emit` (or a test spy). */
export type CatalogHealthSink = (event: CatalogHealthWarning) => void;

/** A fresh, all-clear health record (no fake numbers — everything zero/false). */
function freshCatalogHealth(): CatalogHealth {
    return {
        atlasLoadFailed: false,
        loaded: false,
        sectorLoadErrors: 0,
        sectorHttpMisses: 0,
        queriedBeforeLoad: false,
        lastError: null,
    };
}

// Import the CSV as a URL (Vite feature) - REMOVED, using JSON Atlas


/**
 * Adapter for the shipped HYBRID star atlas — Gaia + HYG rows in one dataset,
 * discriminated PER ROW (Gaia: RA in DEGREES + mag_g; HYG: RA in HOURS). The
 * old single HYG v3.8 CSV was retired for the JSON atlas (see the note above).
 * Loads the atlas, parses it, and provides optimized spatial queries.
 */
export class StarCatalogAdapter {
    private static instance: StarCatalogAdapter;
    private stars: StandardStar[] = [];
    private isLoaded = false;
    private isNative = false;
    private loadPromise: Promise<void> | null = null;


    // Spatial Index: DEC bands of 10 degrees.
    // Index i corresponds to dec range [i*10 - 90, i*10 - 80]
    // 18 bands total: -90..-80 (0), -80..-70 (1), ..., 80..90 (17)
    private decBands: StandardStar[][] = Array.from({ length: 18 }, () => []);

    private loadedSectors = new Set<number>();
    private quadIndex = new Map<string, any[]>();

    // ─── Catalog-health (LAW 3: honest-or-absent) ────────────────────────────
    private health: CatalogHealth = freshCatalogHealth();
    /** De-dupe: each distinct REAL failure emits a warning at most once per reset. */
    private emittedFailureKeys = new Set<string>();
    /** Injected warning sink (set by the solve stage from the session event bus). */
    private static healthSink: CatalogHealthSink | null = null;

    // ─── FLAG-GATED binary (Arrow) atlas source ───────────────────────────
    // DEFAULT ON (owner-ratified 2026-07-09 after the Option-A evidence run:
    // SeeStar sacred byte-identical on BOTH paths, Arrow-path-served proven by
    // network trace, full converter verify 2,785,645 rows / 36 sectors /
    // 0 mismatches; ledger row 81). Each sector tries its compact `.arrow` twin
    // first (value-equivalent to JSON->rows; see atlas_arrow_codec +
    // tools/atlas/atlas_to_arrow.mjs) and falls back PER-SECTOR to JSON when the
    // `.arrow` is absent — so machines without shipped twins behave exactly as
    // before. Disable via VITE_ATLAS_BINARY=false or setBinarySource(false).
    private static binarySourceEnabled: boolean =
        ((import.meta as any).env?.VITE_ATLAS_BINARY !== 'false');

    /** @internal De-risk toggle for the binary atlas source (default OFF). */
    public static setBinarySource(enabled: boolean): void {
        StarCatalogAdapter.binarySourceEnabled = enabled;
    }

    /** @internal Current state of the binary atlas source flag. */
    public static isBinarySourceEnabled(): boolean {
        return StarCatalogAdapter.binarySourceEnabled;
    }

    // ─── FLAG-GATED starplates (native v2 catalog) source — STARPLATES_SPEC §1 ──
    // DEFAULT OFF. When ON **and native**, findStarsInField routes to the
    // `query_catalog_v2` Arrow-IPC binary protocol (docs/STARPLATES_SPEC.md §5)
    // via the dynamically-imported starplates_provider; any failure falls back
    // to the JSON dec-band path. When OFF, zero new code
    // executes on the solve path (mirrors the VITE_ATLAS_BINARY seam above).
    // Enable via VITE_STARPLATES=true or StarCatalogAdapter.setStarplatesSource(true).
    private static starplatesEnabled: boolean =
        ((import.meta as any).env?.VITE_STARPLATES === 'true');

    /** @internal De-risk toggle for the starplates v2 source (default OFF). */
    public static setStarplatesSource(enabled: boolean): void {
        StarCatalogAdapter.starplatesEnabled = enabled;
    }

    /** @internal Current state of the starplates v2 source flag. */
    public static isStarplatesSourceEnabled(): boolean {
        return StarCatalogAdapter.starplatesEnabled;
    }

    // ─── FLAG: starplates background cell sync — STARPLATES_SPEC §1 ───────
    // DEFAULT OFF. Normative flag name reserved by the spec; consumed ONLY by
    // the background R2 cell-sync layer (spec §9.1 step 6 — lands after the
    // parity gate). It is read by no solve-path code and never will be:
    // R2/CDN is a sync source, NEVER a runtime dependency (offline-first rule).
    private static starplatesSyncEnabled: boolean =
        ((import.meta as any).env?.VITE_STARPLATES_SYNC === 'true');

    /** @internal Toggle for background starplates cell sync (default OFF). */
    public static setStarplatesSync(enabled: boolean): void {
        StarCatalogAdapter.starplatesSyncEnabled = enabled;
    }

    /** @internal Current state of the starplates sync flag. */
    public static isStarplatesSyncEnabled(): boolean {
        return StarCatalogAdapter.starplatesSyncEnabled;
    }

    // ─── FLAG-GATED g15u Gaia-only CONFIRM-lane catalog source ────────────
    // DEFAULT OFF. When ON, the post-solve confirm/deep-verify lane
    // (runPostSolveDeepHarvest + runPostSolveConfirmation) reads the greenfield
    // quad-index's stars.arrow (Gaia DR3 G<15) instead of the legacy hybrid
    // Gaia+HYG sector JSON — owner Gaia-only ruling 2026-07-22. Desktop +
    // headless ONLY (the file is read via Node fs / Tauri fs plugin); the BROWSER
    // tier never engages (flag OFF + fail-soft fall-back). SOLVE-path detection
    // + matched_stars are untouched — this flag only re-sources the confirm lane.
    // DEFAULT ON since the 2026-07-22 Gaia cutover train (rows 527-536: hardened
    // adaptive-null gate × full-cone g15u — SeeStar BY 210/210 CONFIRMED, CR2
    // honest BY 17/30 CONFIRMED). Opt out via VITE_CATALOG_G15U=false or
    // setG15uCatalogSource(false) (the legacy hybrid-sectors confirm source).
    private static g15uEnabled: boolean =
        ((import.meta as any).env?.VITE_CATALOG_G15U !== 'false');

    /** @internal Toggle for the g15u Gaia-only confirm-lane source (default ON). */
    public static setG15uCatalogSource(enabled: boolean): void {
        StarCatalogAdapter.g15uEnabled = enabled;
    }

    /** @internal Current state of the g15u confirm-lane source flag. */
    public static isG15uCatalogSourceEnabled(): boolean {
        return StarCatalogAdapter.g15uEnabled;
    }

    // ─── INJECTABLE g15u query — test seam (mirrors setStarplatesQuery) ────
    private static g15uQueryOverride: G15uQueryFn | null = null;

    /** @internal Inject a g15u query fn (tests). null restores the real module. */
    public static setG15uQuery(fn: G15uQueryFn | null): void {
        StarCatalogAdapter.g15uQueryOverride = fn;
    }

    /**
     * FLAG-GATED (default OFF): deep-catalog cone read from the g15u Gaia-only
     * `stars.arrow` for the CONFIRM lane. Returns MAG-SORTED rows
     * (`g_mag <= magLimit`) shaped for projectCatalogToPixels + the neighbor
     * lane, or null on ANY failure/absence (unresolved path, browser tier, decode
     * error) — in which case the caller falls back to the hybrid dec-band path,
     * so this can never make the confirm lane worse than the legacy atlas.
     * The g15u module is dynamically imported so its Node/Tauri fs read is only
     * pulled in when the flag is actually enabled (VITE_ATLAS_BINARY precedent).
     * This RETIRES the ensureSectorLoaded full-sector paging class on the ON path.
     */
    public async queryDeepCatalogG15u(
        raHours: number, decDeg: number, radiusDeg: number, magLimit: number,
    ): Promise<DeepCatalogRow[] | null> {
        try {
            if (StarCatalogAdapter.g15uQueryOverride) {
                return await StarCatalogAdapter.g15uQueryOverride(raHours, decDeg, radiusDeg, magLimit);
            }
            const { queryG15uCatalog } = await import('./g15u_catalog');
            return await queryG15uCatalog({ raHours, decDeg, radiusDeg, magLimit });
        } catch (e) {
            console.warn('[StarCatalog] g15u confirm-lane query failed, falling back to the hybrid dec-band index.', e);
            return null;
        }
    }

    // ─── INJECTABLE starplates query — test seam (mirrors setAtlasLoader) ──
    // Lets vitest prove flag routing + flag-OFF inertness without a Tauri
    // runtime: when set, tryQueryStarplates calls this instead of importing
    // the provider. null restores the real dynamic-import path.
    private static starplatesQueryOverride: StarplatesQueryFn | null = null;

    /** @internal Inject a starplates query fn (tests). null restores the provider. */
    public static setStarplatesQuery(fn: StarplatesQueryFn | null): void {
        StarCatalogAdapter.starplatesQueryOverride = fn;
    }

    // ─── INJECTABLE atlas loader — Toolchest API seam (I1.1) ──────────────
    // DEFAULT: the desktop local-dir tier (atlas_local_tier.ts) with plain
    // fetch(path) as its embedded-asset fallback. The tier is PROVABLY INERT
    // off-desktop — in Node (headless api smoke) and a plain browser (e2e) its
    // `isTauri()` gate is false, so it returns fetch(path) UNCHANGED (byte-
    // identical; no Tauri plugin imported). On the DESKTOP it prefers a
    // downloaded atlas_root (StarDataSection atlas row) over the bundled/embedded
    // atlas, and is byte-identical when no download exists. Headless drivers
    // (tools/api) still inject their own fs-backed loader, replacing this default.
    // Precedent: binarySourceEnabled above.
    private static atlasLoader: AtlasLoader = (p) => loadAtlasWithLocalTier(p, (q) => fetch(q));

    /** @internal Inject an atlas loader (tools/api headless). null restores the desktop-tier default. */
    public static setAtlasLoader(fn: AtlasLoader | null): void {
        StarCatalogAdapter.atlasLoader =
            fn ?? ((p) => loadAtlasWithLocalTier(p, (q) => fetch(q)));
    }

    // ─── Catalog-health API (record + emit REAL failures; UI/tests read this) ──

    /**
     * Inject the warning sink (the solve stage passes the session event bus's
     * `emit`). `null` restores the default (no-op) — no warnings are emitted.
     * Static because the adapter is a process singleton; the solve stage sets it
     * for the duration of a solve and clears it after (see stages/solve.ts).
     */
    public static setHealthSink(fn: CatalogHealthSink | null): void {
        StarCatalogAdapter.healthSink = fn;
    }

    /** Current catalog-health snapshot + a derived `usable` verdict (pure read). */
    public getHealth(): Readonly<CatalogHealth> & { usable: boolean } {
        return {
            ...this.health,
            // Usable ⇔ anchors loaded, no atlas failure, and it was never queried
            // before loading. Sector HTTP misses alone do NOT make it unusable
            // (a void sector legitimately 404s).
            usable: this.health.loaded && !this.health.atlasLoadFailed && !this.health.queriedBeforeLoad,
        };
    }

    /** Reset the health record + emit de-dupe (called by the solve stage per run). */
    public resetHealth(): void {
        this.health = freshCatalogHealth();
        this.emittedFailureKeys.clear();
    }

    /**
     * Record a REAL failure and emit an honest warning at most once per `key`.
     * The message is the exact, non-fabricated degradation text; emission is
     * fully guarded so a throwing sink can never break a catalog operation.
     */
    private noteRealFailure(key: string, message: string): void {
        this.health.lastError = message;
        if (this.emittedFailureKeys.has(key)) return;
        this.emittedFailureKeys.add(key);
        try {
            StarCatalogAdapter.healthSink?.({ kind: 'warning', message, stage: 'catalog' });
        } catch (e) {
            // A subscriber throwing must never break the catalog path.
            console.error('[StarCatalog] health sink threw:', e);
        }
    }

    private constructor() {}

    public static getinstance(): StarCatalogAdapter {
        if (!StarCatalogAdapter.instance) {
            StarCatalogAdapter.instance = new StarCatalogAdapter();
        }
        return StarCatalogAdapter.instance;
    }

    /**
     * Returns the full list of loaded stars.
     */
    public getStars(): StandardStar[] {
        return this.stars;
    }

    /**
     * Initializes the catalog (Levels 1 & 2). Repeated calls return the same promise.
     */
    public async loadCatalog(): Promise<void> {
        if (this.isLoaded) return;
        if (this.loadPromise) return this.loadPromise;

        this.loadPromise = this.fetchAndParse();
        return this.loadPromise;
    }

    /**
     * Ensures the high-density Layer 3 sector(s) for a given sky position are loaded.
     * Handles sector overlap by loading adjacent sectors if the radius crosses a boundary.
     * @param ra - Right Ascension in Hours
     * @param dec - Declination in Degrees
     * @param radiusDeg - Search radius in Degrees (default 5)
     */
    public async ensureSectorLoaded(ra: number, dec: number, radiusDeg: number = 5): Promise<void> {
        // Calculate bounding box
        const decMin = Math.max(-90, dec - radiusDeg);
        const decMax = Math.min(90, dec + radiusDeg);
        
        // RA width depends on declination (cos(dec))
        // At poles, load all RA sectors
        let raWidthHours = (radiusDeg / 15) / Math.max(0.1, Math.cos(dec * Math.PI / 180));
        if (Math.abs(dec) > 80) raWidthHours = 12; // Load effectively everything near pole

        const raMin = (ra - raWidthHours + 24) % 24;
        const raMax = (ra + raWidthHours + 24) % 24;

        // Identify unique sectors
        const sectorsToLoad = new Set<number>();
        
        // Scan grid points covering the box
        // We step by 2h RA and 15d Dec (half sector sizes) to ensure we catch everything
        const raStep = 2; 
        const decStep = 15;

        // Handle RA wrap-around scan
        const raPoints: number[] = [];
        if (raMin <= raMax) {
            for (let r = raMin; r <= raMax + 0.1; r += raStep) raPoints.push(r);
            raPoints.push(raMax);
        } else {
            // Wrap case: partial scan [raMin..24] and [0..raMax]
            for (let r = raMin; r < 24; r += raStep) raPoints.push(r);
            for (let r = 0; r <= raMax + 0.1; r += raStep) raPoints.push(r);
        }

        for (let d = decMin; d <= decMax + 0.1; d += decStep) {
            for (const r of raPoints) {
                sectorsToLoad.add(this.getSectorId(r, d));
            }
        }
        sectorsToLoad.add(this.getSectorId(ra, dec)); // Always include center

        const promises = Array.from(sectorsToLoad).map(async sectorId => {
            if (this.loadedSectors.has(sectorId)) return;
            
            // console.log(`[StarCatalog] Loading Deep Sector ${sectorId} (Window: RA ${ra.toFixed(1)} / Dec ${dec.toFixed(1)})`);
            
            try {
                // FLAG-GATED (default OFF): try the compact Arrow twin first. On a
                // hit we ingest value-equivalent rows and skip JSON entirely; on a
                // miss (no `.arrow`) we fall through to the unchanged JSON path.
                if (StarCatalogAdapter.binarySourceEnabled) {
                    const arrowRows = await this.tryLoadArrowSector(sectorId);
                    if (arrowRows) {
                        this.ingestStars(arrowRows);
                        this.loadedSectors.add(sectorId);
                        return;
                    }
                }

                const url = `/atlas/sectors/level_3_sector_${sectorId}.json`;
                const response = await StarCatalogAdapter.atlasLoader(url);
                if (!response.ok) {
                     // A void sky sector legitimately 404s (no file shipped for an
                     // empty region), so a single miss is AMBIGUOUS — record it for
                     // the health snapshot but stay SILENT (no user-facing warning),
                     // preserving byte-identical behavior for healthy solves.
                     this.health.sectorHttpMisses++;
                     return;
                }
                const stars = await response.json();
                this.ingestStars(stars);
                this.loadedSectors.add(sectorId);
                // console.log(`[StarCatalog] Sector ${sectorId} loaded.`);
            } catch (e) {
                // A THROW here (network error / JSON parse failure) is a REAL
                // infrastructure failure, not a void sector — record + emit.
                console.error(`[StarCatalog] Failed to load sector ${sectorId}`, e);
                this.health.sectorLoadErrors++;
                this.noteRealFailure(
                    'sector_error',
                    'Star catalog degraded — a sector failed to load (network or parse error); some regions may lack catalog stars.'
                );
            }
        });

        await Promise.all(promises);
    }

    /**
     * FLAG-GATED (default OFF): fetch + decode a sector's compact Arrow twin
     * (`/atlas/sectors/level_3_sector_N.arrow`). Returns rows that are
     * value-equivalent to `JSON.parse` of the `.json` sector (verified by
     * tools/atlas/atlas_to_arrow.mjs), or null if the `.arrow` is absent /
     * fails to decode — in which case the caller falls back to JSON.
     * The Arrow codec is dynamically imported so it is only pulled into the
     * bundle when the flag is actually enabled.
     */
    private async tryLoadArrowSector(sectorId: number): Promise<any[] | null> {
        try {
            const url = `/atlas/sectors/level_3_sector_${sectorId}.arrow`;
            const response = await StarCatalogAdapter.atlasLoader(url);
            if (!response.ok) return null;
            const buf = new Uint8Array(await response.arrayBuffer());
            const { decodeArrowSector } = await import('./atlas_arrow_codec');
            return decodeArrowSector(buf);
        } catch (e) {
            console.warn(`[StarCatalog] Arrow sector ${sectorId} decode failed, falling back to JSON.`, e);
            return null;
        }
    }

    /**
     * FLAG-GATED (default OFF): query the starplates native v2 catalog
     * (`query_catalog_v2`, Arrow IPC stream — docs/STARPLATES_SPEC.md §5).
     * The provider is dynamically imported so it is only pulled into the
     * bundle when the flag is actually enabled (VITE_ATLAS_BINARY precedent).
     * Returns mag-sorted StandardStar[] or null on ANY failure, in which
     * case the caller falls back to the JSON dec-band index path.
     */
    private async tryQueryStarplates(
        raCenterHours: number, decCenterDeg: number, radiusDeg: number, obsJd: number
    ): Promise<StandardStar[] | null> {
        try {
            if (StarCatalogAdapter.starplatesQueryOverride) {
                return await StarCatalogAdapter.starplatesQueryOverride(raCenterHours, decCenterDeg, radiusDeg, obsJd);
            }
            const { queryStarsV2 } = await import('./starplates_provider');
            return await queryStarsV2(raCenterHours, decCenterDeg, radiusDeg, obsJd, 't1');
        } catch (e) {
            console.warn('[StarCatalog] starplates v2 query failed, falling back to the JSON dec-band index.', e);
            return null;
        }
    }

    /**
     * Pre-emptively loads a 3x3 grid of sectors surrounding the given center.
     * This prevents "Dead Star" errors during expanded spiral searches.
     */
    public async loadSearchGrid(ra: number, dec: number, fovDeg: number): Promise<void> {
        // Load the center and neighbors (ensureSectorLoaded already handles multi-sector overlap
        // but this makes it explicit for a search field).
        return this.ensureSectorLoaded(ra, dec, fovDeg * 1.5);
    }

    private getSectorId(ra: number, dec: number): number {
        // Must match generation logic:
        // RA slices (4h each) -> 6 slices
        // Dec slices (30deg each) -> 6 slices
        // Sector ID = decIndex * 6 + raIndex
        
        // Clamp inputs
        const r = (ra % 24 + 24) % 24;
        const d = Math.max(-90, Math.min(90, dec));

        const raIndex = Math.min(5, Math.floor(r / 4));
        const decIndex = Math.min(5, Math.floor((d + 90) / 30));
        return decIndex * 6 + raIndex;
    }

    private async fetchAndParse(): Promise<void> {
        console.log('[StarCatalog] Initializing star catalog (JSON atlas)...');

        // Detect native (Tauri). The starplates v2 catalog (query_catalog_v2,
        // flag-gated, default OFF) is the only native catalog path; when it is
        // disabled or unavailable, every caller uses the JSON atlas below.
        try {
            const { invoke } = await import('@tauri-apps/api/core');
            this.isNative = await invoke<boolean>('is_native').catch(() => false);
        } catch (e) {
            this.isNative = false;
        }

        try {
            // Load the JSON atlas (levels 1 & 2 anchors) — the single, canonical
            // catalog source for browser, headless, and native callers.
            console.log('[StarCatalog] Loading JSON atlas (levels 1 & 2 anchors)...');
            const [l1, l2] = await Promise.all([
                StarCatalogAdapter.atlasLoader('/atlas/level_1_anchors.json').then(r => r.json()),
                StarCatalogAdapter.atlasLoader('/atlas/level_2_pattern.json').then(r => r.json())
            ]);

            this.ingestStars(l1);
            this.ingestStars(l2);

            this.isLoaded = true;
            this.health.loaded = true;
            console.log(`[StarCatalog] JSON atlas loaded. Total stars: ${this.stars.length}`);

            // Build initial quad index for Level 1 & 2 stars (Fast search)
            this.buildInitialQuadIndex();
        } catch (e) {
            // The atlas anchors (level 1 & 2) are the base catalog — a failure here
            // makes the catalog UNUSABLE. Record + emit an honest error (LAW 3) so
            // the failure is not swallowed to the console, then re-throw as before.
            console.error('[StarCatalog] Failed to load atlas:', e);
            this.health.atlasLoadFailed = true;
            this.noteRealFailure(
                'atlas_load',
                `Star catalog unavailable — atlas anchors failed to load (${e instanceof Error ? e.message : String(e)}). Solve cannot use catalog stars.`
            );
            throw e;
        }
    }

    /** Approximate B-RP color index from spectral type prefix */
    private static spectralTypeToBpRp(spect: string): number {
        if (!spect || spect === 'Unknown') return 0.82; // roughly Sun
        const letter = spect.charAt(0).toUpperCase();
        // Mean BP-RP derived from G-band and B-V approximations
        const map: Record<string, number> = {
            'O': -0.40, 'B': -0.20, 'A': 0.05, 'F': 0.45,
            'G': 0.82, 'K': 1.50, 'M': 2.30,
        };
        return map[letter] ?? 0.82;
    }

    /** @internal Exposed for unit testing (m6_atlas_ingest.test.ts). */
    public ingestStars(rawStars: any[]) {
        for (const s of rawStars) {
            // Filter out Sol (id=0) â€” ephemeris handles the Sun dynamically.
            // Gaia-format atlas records (level 1/2/3 JSON) write id:0 for EVERY star,
            // so the Sol filter must only apply to the legacy HYG record shape.
            if (s.id === 0 && s.source_id === undefined) continue;

            const spect = s.spect || 'Unknown';
            const bp_rp = s.bp_rp ?? StarCatalogAdapter.spectralTypeToBpRp(spect);

            // Gaia-format records (atlas generator output) carry `ra` in DEGREES;
            // legacy HYG records carry `ra` in HOURS.
            const isGaiaFormat = s.source_id !== undefined || s.mag_g !== undefined;

            // [SCHEMA B] Tycho-2 / Hipparcos bright-star SUPPLEMENT rows
            // (build_gaia_pure_sectors.mjs): a `mag_system` tag is present and there
            // is NO source_id. These rows are Gaia-SHAPED (ra in DEGREES, mag_g
            // present, so isGaiaFormat is true and the ra/mag reads below are all
            // correct) but are NOT Gaia photometry — `mag_g` holds the NATIVE
            // VT/BT/Hp magnitude, never transformed to Gaia G (LAW 3). The tag is
            // load-bearing: these are the sky's brightest ~52k SPCC/PSF/vignette
            // anchors; labeling them GaiaG (the pre-fix default) or prefixing the id
            // with the RETIRED `HYG_` namespace would poison downstream ZP/color
            // fits (the VT−G / Hp−G offset runs ~+0.1..+0.4 mag, more for red stars).
            const magSystem: string | undefined = s.mag_system;
            const isSupplement = magSystem !== undefined && s.source_id === undefined;

            // Map Gaia native format if available, fallback to legacy structure
            const star: StandardStar = {
                name: s.proper || s.name || `Star ${s.source_id || s.id}`,
                ra_hours: s.ra_deg !== undefined
                    ? s.ra_deg / 15.0
                    : (isGaiaFormat ? s.ra / 15.0 : s.ra),
                dec_degrees: s.dec_deg !== undefined ? s.dec_deg : s.dec,
                // Supplement rows: mag_g IS the native VT/BT/Hp magnitude (banded
                // below), carried through without any cross-system transform (LAW 3).
                magnitude_V: s.mag_g !== undefined ? s.mag_g : s.mag,
                color_index_BV: bp_rp, // Note: We should rename this to bp_rp_index in StandardStar eventually
                // [SCHEMA B] Per-row band tag (hybrid-atlas discriminant): supplement
                // rows carry their native Tycho/Hip band (read from mag_system);
                // other Gaia-format rows put Gaia G; legacy HYG rows put Johnson V.
                band: isSupplement
                    ? (magSystem === 'Hp' ? 'HipparcosHp'
                        : magSystem === 'BT' ? 'TychoBT'
                        : 'TychoVT')
                    : (isGaiaFormat ? 'GaiaG' : 'JohnsonV'),
                spectral_type: spect,
                // Provenance id: Gaia -> Gaia_<source_id>; supplement -> catalog-native
                // TYC_/HIP_ namespace (NEVER the retired HYG_ prefix); legacy HYG -> HYG_.
                gaia_id: s.source_id
                    ? `Gaia_${s.source_id}`
                    : isSupplement
                        ? `${magSystem === 'Hp' ? 'HIP' : 'TYC'}_${s.cat_id ?? s.id}`
                        : `HYG_${s.id}`,
                // [SCHEMA B] Additive Tycho B_T−V_T color carry-through (never
                // fabricated; only set when the supplement row provides it).
                bt_vt: typeof s.bt_vt === 'number' ? s.bt_vt : undefined,
                pmra: s.pm_ra || 0,
                pmdec: s.pm_dec || 0,
                rv_kms: 0,
                temperature_K: 0,
                expected_xy: { x: 0.33, y: 0.33 },
                constellation: ''
            };

            this.stars.push(star);

            // Pre-calculate cos(dec) for fast radial lookups
            star.cosDecRad = Math.cos(star.dec_degrees * Math.PI / 180);

            // Add to spatial index (use the mapped value — robust to either record shape)
            const bandIdx = Math.floor((star.dec_degrees + 90) / 10);
            if (bandIdx >= 0 && bandIdx < 18) {
                this.decBands[bandIdx].push(star);
            }
        }
    }

    /**
     * Find stars in a circular region.
     * Uses the Dec-band index over the JSON atlas. When the starplates v2
     * native catalog is enabled (flag-gated, default OFF) it replaces this
     * query on success; otherwise the JSON dec-band index answers.
     */
    public async findStarsInField(raCenter: number, decCenter: number, radiusDegrees: number, obsJd: number): Promise<StandardStar[]> {
        if (!this.isLoaded) {
            // Querying before the catalog finished loading is a REAL failure: the
            // solve gets ZERO catalog stars and would otherwise fail invisibly.
            console.warn('[StarCatalog] Catalog not loaded, returning empty list.');
            this.health.queriedBeforeLoad = true;
            this.noteRealFailure(
                'queried_before_load',
                'Star catalog unavailable — catalog is not loaded; solve cannot use catalog stars.'
            );
            return [];
        }

        // FLAG-GATED (default OFF): starplates v2 native catalog
        // (docs/STARPLATES_SPEC.md §5). Requires native (Tauri). On success it
        // REPLACES the JSON query below; on any failure (store missing, native
        // command absent, decode error) it returns null and the JSON dec-band
        // path runs — v2 can never make a solve worse than the JSON atlas.
        if (this.isNative && StarCatalogAdapter.starplatesEnabled) {
            const v2Stars = await this.tryQueryStarplates(raCenter, decCenter, radiusDegrees, obsJd);
            if (v2Stars) return v2Stars;
        }

        const minDec = decCenter - radiusDegrees;
        const maxDec = decCenter + radiusDegrees;
        
        const minBand = Math.max(0, Math.floor((minDec + 90) / 10));
        const maxBand = Math.min(17, Math.floor((maxDec + 90) / 10));

        const res: StandardStar[] = [];
        const radSq = radiusDegrees * radiusDegrees;
        
        const dDecMax = radiusDegrees;
        
        for (let b = minBand; b <= maxBand; b++) {
            const bandStars = this.decBands[b];
            
            for (let i = 0; i < bandStars.length; i++) {
                const s = bandStars[i];
                
                const dDec = s.dec_degrees - decCenter;
                if (Math.abs(dDec) > dDecMax) continue;

                let dRa = Math.abs(s.ra_hours - raCenter);
                if (dRa > 12) dRa = 24 - dRa;
                
                const raDistDeg = dRa * 15 * Math.cos(s.dec_degrees * Math.PI / 180);
                if (Math.abs(raDistDeg) > radiusDegrees) continue; // Box check

                if (dDec * dDec + raDistDeg * raDistDeg <= radSq) {
                    res.push(s);
                }
            }
        }

        return res.sort((a, b) => a.magnitude_V - b.magnitude_V);
    }

    /**
     * Builds a geometric pattern index for the brightest stars.
     */
    private buildInitialQuadIndex() {
        console.log('[StarCatalog] Building Geometric Quad Index...');
        const start = performance.now();
        
        // Use top 150 brightest stars for the global index
        const seeds = this.stars
            .filter(s => s.magnitude_V < 4.5)
            .sort((a,b) => a.magnitude_V - b.magnitude_V)
            .slice(0, 150);

        const quadCount = this.indexQuads(seeds);
        console.log(`[StarCatalog] Quad Index built: ${quadCount} quads in ${Math.round(performance.now() - start)}ms.`);
    }

    private indexQuads(stars: any[]): number {
        let count = 0;
        const n = stars.length;
        
        // Ported logic from plate_solver.ts generateQuads but optimized for indexing
        for (let i = 0; i < n; i++) {
            // Find 8 nearest neighbors
            const neighbors: { idx: number; dist: number }[] = [];
            for (let j = 0; j < n; j++) {
                if (i === j) continue;
                // Simple Euclidean in degrees is sufficient for small distances
                const d = Math.sqrt(
                    Math.pow(stars[i].ra_hours * 15 - stars[j].ra_hours * 15, 2) + 
                    Math.pow(stars[i].dec_degrees - stars[j].dec_degrees, 2)
                );
                neighbors.push({ idx: j, dist: d });
            }
            neighbors.sort((a, b) => a.dist - b.dist);
            const nearby = neighbors.slice(0, 8);

            for (let a = 0; a < nearby.length; a++) {
                for (let b = a + 1; b < nearby.length; b++) {
                    for (let c = b + 1; c < nearby.length; c++) {
                        const quadPoints = [
                            { x: stars[i].ra_hours * 15, y: stars[i].dec_degrees, id: stars[i].gaia_id },
                            { x: stars[nearby[a].idx].ra_hours * 15, y: stars[nearby[a].idx].dec_degrees, id: stars[nearby[a].idx].gaia_id },
                            { x: stars[nearby[b].idx].ra_hours * 15, y: stars[nearby[b].idx].dec_degrees, id: stars[nearby[b].idx].gaia_id },
                            { x: stars[nearby[c].idx].ra_hours * 15, y: stars[nearby[c].idx].dec_degrees, id: stars[nearby[c].idx].gaia_id }
                        ];

                        const q = (AstrometryEngine as any).buildQuad(
                            quadPoints, 
                            [stars[i].gaia_id, stars[nearby[a].idx].gaia_id, stars[nearby[b].idx].gaia_id, stars[nearby[c].idx].gaia_id]
                        );

                        if (q) {
                            const list = this.quadIndex.get(q.hashKey) || [];
                            list.push({
                                ...q,
                                ra: stars[i].ra_hours,
                                dec: stars[i].dec_degrees
                            });
                            this.quadIndex.set(q.hashKey, list);
                            count++;
                        }
                    }
                }
            }
        }
        return count;
    }

    public lookupQuads(hashKey: string): any[] {
        return this.quadIndex.get(hashKey) || [];
    }
}

