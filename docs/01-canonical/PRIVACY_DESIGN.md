<!-- REFERENCE · location/data-privacy design for the hosted results archive; revise at next receipt schema bump or when archive MVP lands · owner: ahogan -->
# Results Archive — Location & Data Privacy Design

**Status:** design note (owner-decided 2026-07-09). This wave is **docs only**: this file states the tier contract and write-path invariants; **zero code changes now** — the receipt is bit-identity-gated (§8), so schema work waits for the next version bump. Companion to [`docs/DATA_PLATFORM.md`](../DATA_PLATFORM.md) §2, which this document refines and partially supersedes (§9).

**The one-line thesis:** a backyard imaging site is a home address, and the sky itself is a GPS — so location privacy here is a *contract over correlated fields*, enforced at write time, never a mask over one column at read time.

---

## 1. The tier contract — correlated fields, not columns

Three tiers, chosen per site at upload:

**EXACT (opt-in)** · **COMMUNITY (~10 km)** · **REGION-ONLY**

A tier is **not** a precision setting on the GPS columns. It is a coherence contract binding **GPS precision AND timestamp precision AND airmass/alt-az precision** together, because the sky re-derives the ground:

**The sky is a GPS.** A solved field gives the exact RA/Dec of the frame center. Combine that with an exact timestamp and the reported zenith angle and the observing site falls out of spherical astronomy: `cos z = sin φ·sin δ + cos φ·cos δ·cos H`, where the hour angle *H* is fixed by time and longitude. The sky rotates ~15°/hr, so **one minute of time = 0.25° of hour angle ≈ 21 km of longitude at 40° latitude** (111 km/° × cos φ). Minute-level time rounding therefore leaves ≈ **20 km of longitude ambiguity** — the scale that makes it coherent with a ~10 km GPS radius. Publish a 10 km-fuzzed GPS point next to a millisecond timestamp and a full-precision altitude, and the fuzz is decoration: the attacker solves for (φ, λ) and ignores the GPS columns entirely.

**Coherence rule:** for each tier, timestamp and airmass/alt-az precision MUST be chosen so that the position re-derivable from *(field center, time, zenith angle)* is no tighter than the tier's GPS radius — evaluated at the worst case (highest zenith angle) in the upload, since airmass sensitivity `dX/dz = sec z·tan z` grows steeply toward the horizon.

Indicative tier table (freeze exact values at implementation, with the coherence rule as the acceptance test):

| Correlated field | EXACT (opt-in) | COMMUNITY (~10 km) | REGION-ONLY |
|---|---|---|---|
| GPS coordinates | full precision | stored per-site fuzzed point, ~10 km (§4) | region label / ~500 km cell only |
| Timestamp | full precision | rounded to the minute (≈ 20 km longitude ambiguity — the math above) | rounded to coherent coarseness (≥ tens of minutes) |
| Airmass / alt-az | full precision | quantized so re-derived position ≥ ~10 km at worst-case z | quantized to match region scale, or absent |

The tier is recorded openly on every receipt (§5). One tier per site; the per-upload choice is which site record the upload attaches to.

## 2. The invariant — degrade at write, never mask at read

> **INVARIANT: exact GPS never leaves the device unless the user opts in.**

- Everything that genuinely needs exact coordinates — ephemeris, refraction, airmass — consumes them **locally at solve time**. The precise values do their scientific work on-device and are then done.
- The archive's science is **fully served at km scale**: extinction-coefficient time series and light-pollution mapping (per [`docs/DATA_PLATFORM.md`](../DATA_PLATFORM.md) §2 derived views) do not improve with meter-level site coordinates.
- Degradation happens **at write**. A mask-at-read design stores the truth server-side and keeps it one bug, one breach, or one subpoena away from disclosure; a degrade-at-write design cannot leak what was never stored. This is the whole argument — there is no "read-side ACL" variant of this design.

## 3. FITS header scrubbing on upload

Uploaded FITS carry `SITELAT`/`SITELONG` (and device serial numbers) in their headers — the headers are as identifying as any receipt column. The upload path MUST:

1. **Rewrite `SITELAT`/`SITELONG` to the site's tier precision** (for COMMUNITY: the stored fuzzed point of §4, verbatim).
2. **Remove or rewrite device serial numbers.**
3. **Add a provenance note** — e.g. `HISTORY location degraded to COMMUNITY tier` — so the header is honest about its own precision. **Never silent** (LAW 3, honest-or-absent): a scrubbed coordinate that still *looks* exact is a fabricated value, which is worse than an absent one.

## 4. Fuzzing — once per site, deterministic, stored

**NEVER per-upload jitter.** Independent jitter is a statistical gift to the attacker: N jittered points average back to the true site at σ/√N, and astrophotographers image from home **hundreds of times**. A 10 km jitter over 400 uploads reconstructs the backyard to ~500 m.

Instead:

- The fuzzed point is generated **once per site**, stored, and **reused verbatim for every upload from that site**. N uploads then carry exactly the information of one upload — averaging gains nothing.
- The offset is **deterministic and stored**, not re-derived: recomputation drift would leak (two nearby-but-different fuzzed points bracket the truth).
- Do not grid-snap: a lattice is detectable (§5) and invites "which cell corner" inference. A stored random offset within the tier radius is sufficient.

## 5. The precision column is open, not hidden

Every receipt carries its location tier / coordinate precision **as an ordinary, queryable column**. Two reasons, both load-bearing:

1. **Science consumers need it.** Coordinate precision feeds error bars on anything site-dependent. Honest-or-absent (LAW 3) applies to metadata exactly as it applies to measurements — shipping a degraded coordinate without its stated precision is shipping a wrong number.
2. **Camouflage is neither achievable nor needed.** A hidden precision flag is one `SELECT` away from any reader of the store; grid-snapped fuzzing is detectable because real sites don't sit on a lattice (an off-lattice test outs it immediately). The protection is **consent and write-time degradation**, not obscurity about which rows were degraded.

## 6. Identifiers — pseudonymization, said out loud

- **Observer IDs are random opaque IDs minted at signup.** The ID↔account mapping is stored separately and is deletable.
- **NOT salted username hashes.** Usernames are low-entropy; a global salt leaves them open to dictionary attack, and per-record salts destroy the cross-upload stability the science needs (a per-site extinction series requires the same observer/site key across hundreds of uploads). The hash construction fails in both directions; random IDs fail in neither.
- If a **stateless derivation** is ever operationally required: HMAC over the username with a **server-held pepper** — keyed, not salted-and-published.
- **Label it honestly: this is PSEUDONYMIZATION, not anonymization.** Upload patterns, device fingerprints, and sky coverage can re-identify; we do not claim otherwise (honest-or-absent applies to our privacy claims too).
- **`site_id` is keyed separately from `observer_id`.** When a user opts a site into EXACT, the blast radius is **that one site** — it does not transitively expose the observer's other sites.

## 7. EXACT tier — opt-in UX and the linkage warning

Owner decision: the EXACT tier is **buried in advanced settings** AND requires a **per-upload confirmation**. Consent is recorded **per upload**, and the consent record stores the **version of the dialog that was shown**.

**Linkage warning (verbatim requirement).** Because the fuzzed point / site record is shared across all uploads from a site (§4, §6), publishing exact coordinates once de-anonymizes the whole series. The per-upload confirmation MUST state this. Canonical copy (revise only with a dialog-version bump):

> **Publish exact coordinates for this upload?**
>
> Observations from this site share one site record. Publishing exact coordinates for this upload effectively reveals the location of **ALL observations from this site — past and future**.
>
> [ Keep COMMUNITY (~10 km) ]   [ Publish exact coordinates ]

## 8. Encryption posture and deletion

- **Shared tiers (COMMUNITY / REGION-ONLY) are protected by degradation, not encryption.** They exist to be read — encrypting data published for community science is theater; the privacy property lives in what was written, not in who holds a key.
- **The private full-fidelity archive is client-side encrypted:** AES-GCM per blob, under a key held locally by the user, applied **before** upload. The platform stores and serves ciphertext it cannot read.
- **Deletion = crypto-shredding.** The archive log is append-only ([`docs/DATA_PLATFORM.md`](../DATA_PLATFORM.md) §2); deleting the locally-held key renders every private blob permanently unrecoverable without mutating the log. This is the resolution of *immutable log vs right-to-delete*. On the metadata side, deleting the separately-stored ID mapping (§6) severs receipts from the account.

## 9. Relationship to `docs/DATA_PLATFORM.md` and sequencing

This document is the expansion of [`docs/DATA_PLATFORM.md`](../DATA_PLATFORM.md) §2's privacy line. Specifically:

| DATA_PLATFORM line | Disposition |
|---|---|
| §2 "**Privacy tiers:** … exact (private) / rounded-to-~10 km (community) / region-only (public). Decided at upload, enforced at write." | **Superseded by §1–§2 here.** Tier names become EXACT (opt-in) / COMMUNITY (~10 km) / REGION-ONLY; a tier now binds the correlated fields (GPS + timestamp + airmass/alt-az), not the GPS columns alone; "enforced at write" is strengthened to *degrade at write, never mask at read*, plus the on-device invariant. |
| §2 "receipt → metadata store (Postgres) indexed on … site geohash …" | **Refined.** D1 suffices for the receipt index at current scale; Postgres at fleet scale. The site geohash is computed from the stored fuzzed point (§4) at tier precision — never from raw GPS — and keyed by `site_id` (§6). |
| §3 step 3 "Results archive MVP … post-C2PA (Phase S)" | **Unchanged — reaffirmed.** The archive MVP stays post-C2PA. |

**Sequencing (owner-agreed):**

| Step | What | When |
|---|---|---|
| now | This doc + the write-path invariants it states. **No code changes** — the receipt is bit-identity-gated (`RECEIPT_SCHEMA_VERSION`, `src/engine/pipeline/stages/schema_versions.ts` — authoritative, cite it rather than hand-copying; the api-smoke gate requires IEEE bit-identical receipts) | this session |
| next schema bump | Receipt gains `location_tier` at the **next** `RECEIPT_SCHEMA_VERSION` bump, not before | with whatever forces the bump |
| archive lands | Iceberg / R2 Data Catalog on a **separate bucket** from the starplates dataplane ([`docs/STARPLATES_SPEC.md`](../STARPLATES_SPEC.md)); D1 receipt index | post-C2PA per DATA_PLATFORM §3 |
| fleet scale | Postgres for the receipt index | when D1 strains |

## 10. Threat model

| Adversary | Data reached | Attack | Mitigation |
|---|---|---|---|
| Any archive reader | Shared-tier receipts + FITS headers | Read site coordinates directly | Tier degradation at write (§1–§2); header scrubbing with provenance note (§3) |
| Correlation analyst / doxxer | Many uploads from one site | Average per-upload jitter back to truth (σ/√N over hundreds of home uploads) | Deterministic once-per-site fuzz reused verbatim — N uploads carry the information of one (§4) |
| Correlation analyst / doxxer | Timestamps + solved WCS + airmass/alt-az | Sky-as-GPS re-derivation of (φ, λ) from time + zenith angle + field center | Tier contract binds time and alt-az precision to the GPS radius; coherence rule at worst-case z (§1) |
| Breach attacker / malicious insider | Full metadata-store dump | Read the "hidden" exact columns | There are none: exact GPS is never stored server-side without opt-in — degrade-at-write means nothing to steal (§2) |
| Breach attacker / malicious insider | Private full-fidelity blobs | Read blobs from object storage | Client-side AES-GCM under a locally-held key; platform holds ciphertext only (§8) |
| Legal compulsion | Anything the platform holds | Compel production | Cannot produce exact GPS never uploaded (§2); cannot decrypt private blobs (§8) |
| Identity linker | Observer identifiers | Dictionary attack on salted username hashes | Random opaque IDs, no derivation from username; mapping stored separately, deletable (§6) |
| Identity linker | One EXACT opt-in site | Pivot from the exposed site to the observer's other sites | `site_id` keyed separately from `observer_id` — blast radius is one site (§6) |
| Device fingerprinting | FITS headers | Track a device serial across sites/observers | Serial scrubbing on upload (§3) |
| The platform itself (post-deletion request) | Append-only log | Immutability vs right-to-delete | Crypto-shredding: key deletion ⇒ blobs unrecoverable; ID mapping deletion severs receipts (§8) |

## 11. Non-goals

- **Anonymization.** We do pseudonymization and label it as such (§6). Re-identification via upload patterns, device fingerprints, or sky coverage is out of scope of the guarantee.
- **Hiding participation.** That a given observer uploads at all, and how often, is not concealed. No traffic-analysis resistance.
- **Protecting EXACT opt-in users from their own published coordinates.** Consent — informed by the §7 linkage warning — is the protection. Once published exact, coordinates are public.
- **Encrypting shared tiers.** Community data exists to be read (§8).
- **Formal k-anonymity or differential-privacy guarantees on aggregate views.** The derived views (coverage maps, extinction series) may warrant this later; it is not claimed now.
- **Location privacy against the user's own device.** The app consumes exact GPS locally by design (§2); a hostile client build is out of scope.
- **Concealing which rows were degraded.** The precision column is deliberately open (§5); camouflage is a non-goal by decision, not by omission.

## Related
- [DATA_PLATFORM.md](../DATA_PLATFORM.md) — the platform doc this design refines and partially supersedes (§9)
- [STARPLATES_SPEC.md](../STARPLATES_SPEC.md) — the dataplane bucket the archive is kept separate from
- [PROVENANCE_HANDOFF_DESIGN.md](../PROVENANCE_HANDOFF_DESIGN.md) — C2PA provenance work that gates the archive MVP (§9 sequencing)
- [COMMUNITY_DATABASE_SPEC.md](../COMMUNITY_DATABASE_SPEC.md) — the community upload/receipt store these privacy tiers apply to
