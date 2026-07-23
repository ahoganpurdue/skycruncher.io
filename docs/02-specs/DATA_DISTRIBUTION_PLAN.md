# Data Distribution & Governance Plan

Status: §0 describes the shipped star-data and app-release distribution architecture. §§1-6 are
the original install-time depth-selection design — plan-level, not fully implemented as of this
revision, retained for the reasoning they document. Companion to the starplates flip (JSON-atlas
retirement) and `docs/01-canonical/TEST_ARCHITECTURE.md`.

## 0. Current distribution architecture (shipped)
SkyCruncher ships as a small installer and pulls its large reference datasets — the star catalog
and the solver's search index — on demand, rather than bundling gigabytes of astronomical data
into the app itself. All of that data, plus the app's own update packages, is served from a
public, CDN-backed object storage bucket (Cloudflare R2). Everything a client fetches is
content-addressed: each release publishes a JSON manifest listing every file's exact byte size
and SHA-256 hash, so the app can verify what it downloaded is exactly what was published, byte
for byte.

Two kinds of star data live in the `starplates` bucket, each its own versioned, immutable release
folder (for example `starplates-2026.07-quadidx-g15u`, `atlas-2026.07-gaiapure-legacydepth`): the
solver's quad-match search index (a multi-gigabyte Gaia-derived star catalog split into "bands,"
some bands further split into resumable chunks when they exceed the storage provider's
single-upload size limit), and the star atlas used for confirming a solve (per-sector JSON files
plus a manifest). A separate `app-releases` bucket holds signed desktop-app installers under
versioned paths, alongside a small, frequently-overwritten `latest.json` file that the
auto-updater polls (`docs/R2_STARDATA_LAYOUT.md`; `src/config/starDataSource.ts`).

In the desktop app, a background download command streams each manifest-listed file over HTTP
(with resume-on-interrupt support), verifies its SHA-256 against the manifest as it lands, and
writes it into the app's local data directory. If a chunked file is missing as a single object,
the client automatically falls back to fetching its numbered parts and reassembling them,
verifying both the parts and the whole. The app always prefers data the user has explicitly
downloaded over data bundled inside the installer, and falls back to the bundled ("embedded")
copy — or an honest "not available" state — if nothing has been downloaded; nothing here ever
blocks or silently degrades an offline solve (`src-tauri/src/star_data_fetch.rs`;
`src/engine/pipeline/m6_plate_solve/atlas_local_tier.ts`).

The auto-updater works the same way as any Tauri-based desktop app: the client periodically
fetches the small `latest.json` manifest from a fixed, public endpoint; if it names a newer
version, the app downloads the matching signed installer and verifies its cryptographic signature
before offering to apply it (`tools/release/make_latest_json.mjs`;
`tools/release/publish_app_release.mjs`; `src-tauri/tauri.conf.json`).

This distribution layer is what makes the install-time depth-selection design below practical:
the depth chooser (§1) and the settings-panel catalog growth (§2) are UI built on top of exactly
this download/verify/tier mechanism, not a separate pipeline.

## 1. Install-time depth selection (plan)
**The thin installer ships with zero stars — no bundled T0 seed — so the measured install weight
reflects the true lightweight footprint.** First-run flow: an honest no-catalog state ("no star
database installed — solving requires one") is followed by the depth chooser as the mandatory
first step before the first solve. The true shell weight (app + wasm, no catalog, no demo data)
is measured at flip time and becomes the advertised install size; demo assets become opt-in
alongside the catalog tiers.

The installer/first-run flow lets the user CHOOSE the starplates depth tier pulled onto disk
(e.g. Bright-anchors-only / Standard / Deep / Complete), with per-tier download size + what-it-unlocks
(FOV-class solvability) stated honestly at choice time. **Delivery architecture: a THIN installer +
FIRST-RUN in-app depth chooser + background download — not an NSIS component page.** Decisive:
Tauri's NSIS template only supports silent installerHooks (custom-template overrides are
documented-discouraged), and the updater's `installMode: passive` shows no interactive pages —
any install-time choice would be frozen at first install and silently bypassed on every
auto-update. The first-run chooser reuses machinery that already exists (scoped-fs grants,
manifest shard hashing, resumable range requests) and survives updates trivially. Catalog data
lives in app-data, never the install dir.

**Resilience — dual-installer strategy:** host TWO installers: (1) the PRIMARY thin installer,
zero stars, kept reasonably current (no constant rebuilds — rides normal release cadence); (2) a
FROZEN/LEGACY FALLBACK installer with a meaningful number of stars pre-loaded (the §3 ladder's
fragility-clearing tier is the natural choice), rebuilt rarely. Failure UX: if the first-run star
download errors (star server down/unreachable), the app presents an honest error plus a LINK to
the fallback installer — the user is never stranded starless by our infrastructure.
**Self-healing property: the fallback carries the auto-updater**, so its app version is
irrelevant — the user installs it for the star payload, then immediately self-updates to current.
The frozen installer therefore freezes only the CATALOG payload and needs rebuilding only on
catalog-schema breaks, never for app currency (catalog lives in app-data; updates never touch
it). DESIGN OBLIGATION this creates: the current app must retain READ-COMPATIBILITY with older
starplates release schemas (the versioned manifest is the contract) — or detect the mismatch and
offer an honest catalog refresh, never a silent failure.

## 2. Post-install catalog growth (plan)
Settings gains a "Star database" panel: add depth (download deeper tiers from the configured
host), add coverage (per-sky-region shards), and LOAD LOCAL (import shards from disk via the
dialog-granted scoped-fs machinery). All additions verified against the starplates manifest
hashes; partial/resumable downloads; honest per-tier provenance display (catalog lineage +
version).

## 3. Depth question — how much catalog depth avoids solve failures from insufficient data?
This depth-vs-coverage analysis predates the Gaia-pure atlas described in §0 above; it is
retained for the reasoning framework, not as a live description of the shipped tiers.

Framework: solvability floor = stars-per-FOV at the sparsest sky (galactic pole) must exceed the
solver's quad/matching needs per FOV class; depth requirement scales inversely with FOV.

**Measured (research; full evidence in the starplates-distribution-research run):**
- Tiers at the time of this analysis: T0 seed G≤9.0 (119,306 rows, 4.77MB, bundled) · T1 G≤12.5
  (2,999,976 rows, 133.7MB, R2) · T2 G≤16 reserved (no data). Bytes/row measured: 40B payload,
  ~44.6B with cell framing.
- **The real blocker was coverage, not depth: T1 was cap-harvested (ESA TAP 3M-row cap) — 13.6%
  of HEALPix cells were empty.** Any pointing in an empty cell has zero catalog stars at any
  depth. A full-sky re-harvest (→ ~3.47M rows, ~155MB) was the first prerequisite of the atlas
  flip.
- Depth at T1 (G≤12.5) ≈ atlas-equivalent, in a ~2.5× denser container. Adequate for 5°/20°/60° FOV
  everywhere incl. the pole (≥475 in-frame). **Marginal for 0.7° narrow at the galactic pole:
  ~9-19 in-frame stars ≈ the quad floor.**
- Depth ladder (all-sky rows → R2 size): G≤12.5 → 3.47M/153MB · **+1 mag G≤13.5 → 8.4M/370MB
  (~22-45 pole stars in 0.7°: clears fragility)** · **+2 mag G≤14.5 → 20.5M/902MB (~54-110 pole
  stars: robust — recommended default-deep tier)** · G≤16 → 68M/~3GB (over-provisioned for
  solving; photometric-depth use only).
- Solvability floor anchors (measured): quad ≥4; robust matching ~20-30 in-frame; pinned-grade
  ~50-100+ (the greenfield reference solve for the M66 Leo Triplet field matches 265 stars,
  consistent with the legacy pin for the same field at 272 matched; synthetic sparse-narrow-field
  tests solved at 108-203 matched).

**Readiness correction (measured):** the local harvest was cell-COMPLETE (12,287/12,288 t1 cells,
64/64 chunks, 213MB) — the 13.6%-empty finding traced back to the stale bundled manifest; the
residual defect was uneven DEPTH truncation (~21% of sky short of G≤12.5) from the ESA 3M-row
cap. A bundled seed manifest that diverges from the harvest manifest under the same release id
is an immutability violation; resolution: complete harvests mint a NEW release id (releases are
immutable).
**The dominant flip blocker was architectural, not data:** the starplates provider overrode only
`findStarsInField` and was Tauri-native-only (isNative gate) — it never fed `getStars()`
(solver_entry.ts:379,430 + metrology.ts:40) and could never run in browser/headless. The R2
credentials issue traced to a 0-byte decoy `.env.r2` at repo root — the canonical file is
`src/engine/ui/dashboard/.env.r2` (287B, intact, powers the release tooling); deleting the root
decoy (a guarded manual step) unblocked R2 verification/publish. Origin posture clean: native
query = zero-CORS local; R2 sync = native Rust HTTP (CORS/COEP moot).

RULE (pre-registered): the flip to starplates-as-sole-catalog requires (a) uncapped re-harvest (or
depth-truncation proven acceptable per the §3 ladder) published under a NEW immutable release id;
(b) `getStars()` parity + a browser/headless-capable arrow read path (the architectural gap);
(c) the parity A/B reproducing the pinned solves' outcomes off starplates; (d) the shipped default
tier covering every currently-solvable FOV class at the galactic pole with margin; (e) R2
credentials restored + complete release published. "Full and complete replacement" remains
PENDING — honest status, not yet a claim.

## 4. Data-plane split: testing vs production
- R2 buckets cannot be renamed (platform fact) → renaming would mean a needless bucket migration;
  the alternative adopted: **current buckets are DESIGNATED TESTING in place** (governance marker
  object + this doc + config labels), names unchanged.
- **PRODUCTION buckets are created fresh** when real user data begins (config-driven endpoints per
  LAW 6 — never literals), so community-contributed data is born clean.
- **MIGRATION CRITERIA (testing → production)** — a file crosses ONLY if: (a) full receipt at a known
  schema version; (b) **pipeline-provenance stamps prove it post-dates the relevant correctness
  events** — for example, anything whose pixel-derived products came through the libraw decode
  (pre-rawler-flip) is TAINTED for pixel products (coordinate products judged separately per the
  two-ledger law); (c) version-controlled continuity — re-derivable with pinned tool versions.
  Consequence: receipts/dossiers MUST carry decoder + catalog + pipeline version identifiers (receipt
  schema already versions; decoder/catalog lineage stamps ride the respective rail flips).
- Rationale: development iterates quickly enough that data captured during this phase should not
  be represented as carrying the same provenance guarantees as data collected once the schemas
  and processors are stable enough to call production.

### 4b. Database plane (extends §4 one plane over)
- **Current database = TEST/DEV**, designated in place (same move as the buckets): schemas and
  processors are changing at development pace, so nothing in it carries production provenance.
- **A second, PRIMARY database is deployed fresh for user-submitted data** when data schemas and
  processors are *mostly locked in* — user data is born clean, never migrated out of the dev store.
- **DDIA-compliant backward/forward compatibility is a day-one obligation on the PRIMARY** (not
  retrofitted): every persisted record stamped with its producing schema version (the receipt
  discipline generalized to DB rows); additive-only changes within a major version, no field-name
  reuse with changed semantics; readers tolerate unknown fields (forward compat), writers never
  drop fields old readers require (backward compat).
- **Conformance, not intention:** old-reader/new-record + new-reader/old-record fixture tests ride
  the graduation harness — the JSON-level twin of LAW 7's golden-vector pattern for binary
  boundaries. The existing catalog-schema read-compat obligation (§ this doc) is the same rule.
- **"Mostly locked in" needs a measurable gate** (still to be defined): e.g. no breaking
  receipt/DB schema change for N consecutive releases + processors passing conformance on the
  full golden corpus. Until then, all captured data is TESTING-provenance forever (never silently
  promoted — §4 migration criteria apply unchanged).
- Sibling seam: the DISTRIBUTION plane (updater endpoint baked into installers) needs the same
  production-endpoint decision plus a written migration story; one design note should cover both
  planes.

## 5. Synthetic previews & storage tiering (plan)
**Purpose:** click a lightweight dataset entry and get a computed-on-demand visual impression of
what that frame looked like — before and after processing — so contributors can get a sense of
what kind of data is producing a given result, visually, without storing petabytes. Explicitly
NOT a truth claim about the recorded image; a browsing/selection affordance.

**Mechanism:** dossier parameters (fitted WCS, detection list incl. non-catalog detections w/ fluxes,
measured PSF field, background model, noise stats, distortion + color params) + the starplates
dataplane → the tools/synth render machinery in RECEIPT-DRIVEN mode (the verified generator pointed at
a receipt instead of a random pointing). **UX: a two-state flip.** Both states are simulations of
the same dossier: PRE-PROCESS sim = as-shot parameters (measured PSF blur, distortion applied,
measured noise/background gradient, uncalibrated color) ↔ POST-PROCESS sim = corrected transforms
(undistorted, PSF-deconvolved, background-flattened, color-calibrated). The user flips between
them at selection time — what the data looked like vs. what processing would make of it, both
explicitly synthetic, both badged (the honesty contract below applies to BOTH states equally).
A dossier is ~100KB vs ~30MB raw (~300:1); previews are computed on demand and never
stored/hosted.

**Honesty contract (LAW 3 — non-negotiable):** every synthetic preview is BADGED as such
("SYNTHETIC PREVIEW — model-rendered from measured parameters, not the recorded image") with a
distinct visual treatment; the badge states the model's known blindness (extended structure —
nebulosity/galaxies — absent until the layers/NEBULOSITY model exists). Never presented anywhere a
user could mistake it for the capture.

**Storage tiers:**
- **T1 — parameters, always** (the dossier: tiny, permanent, the durable corpus).
- **T2 — compressed residual, optional** (actual − model): where the model is good, residuals are noise
  and compress hard; structured residuals = the scientifically interesting unmodeled content, preserved
  at fidelity automatically. Preview+residual ≈ the real image; the residual doubles as a per-frame
  MEASUREMENT of model miss.
- **T3 — raw, gated**: retained under the harvest-before-clear gate AND the §4 taint rules (never
  cleared while the extracting pipeline version is known-wrong); ephemeral only for frames whose
  residuals confirm nothing unmodeled remains.

**Sequencing:** receipt-driven render mode = post-flip extension of tools/synth; the dataset-browser
preview affordance pairs with the replay dashboard; residual-map producer joins the harvest lane.

## 6. Sequencing
1. Research (depth math + delivery architecture) + starplates readiness A/B → fill §3's table.
2. Quiet-box starplates flip (separate gated step from the decoder flip; each gets clean attribution):
   JSON atlas removed, pins/tests migrated to starplates baselines, installer diet 234MB→~45MB.
3. Depth-selection first-run flow + settings panel = post-flip implementation wave.
4. Production buckets + migration tooling = when the community funnel opens.

## Related
- [Data Platform — system I/O map](../DATA_PLATFORM.md) — the DDIA lens and DB-plane row this plan's §4b ruling feeds
- [Starplates Spec](../STARPLATES_SPEC.md) — the starplates flip this plan is a companion document to
- [Test Architecture](../01-canonical/TEST_ARCHITECTURE.md) — companion doc named alongside this plan (header)
- [Rig Identity Spec](RIG_IDENTITY_SPEC.md) — its privacy boundary binds to this plan's §4
- [Community Science Laboratory](../COMMUNITY_SCIENCE_LAB.md) — sequences its rollout after this plan's §4b production database
