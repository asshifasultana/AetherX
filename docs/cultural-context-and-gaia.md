# Cultural context and Gaia markers

The viewer now offers two independent context features: a lazily loaded cultural
panel below the timeline and optional Gaia DR3 markers over the FITS image.
Neither feature changes science pixels, image loading, stacking, or PNG exports.

## Content coverage and publication status

Ten cards are published: three Hawaiian starline accounts, three Vedic named
figures/stars, one Bengali Saptarshi identification, and three Lakota identification
notes. Vedic and Bengali have separate labels. The Lakota notes link to CAIRNS
and published scholarship; they do not reproduce ceremonial narratives or artwork.
Editorial source checking is not community review or community endorsement.

**The five-group content milestone is not complete.** The imported Arabic al-Sufi
source is CC BY-ND 4.0; Kamilaroi/Euahlayi is CC BY-NC-ND 4.0. Adapted cards from
those sources remain unpublished pending appropriate adaptation permission.
Their selectors show the gap rather than substituting other traditions or
inventing accounts. The three-card target for each group is recorded in the
generated source manifest. Chinese is excluded.

Original files are retained without edits under `data/sky-cultures/stellarium`.
The selected Stellarium commit is `3c4a720f313ada6124b86fef24131fa65900133f`.
Only the permissively adaptable Hawaiian and Indian originals are served by the
app, with their original author/license sections. Converted restricted-source
drafts are local ignored intermediates and are not deployment assets.

Every published card has a source, attribution, content license/reuse statement,
and an editorial review note. Hand-written identification notes describe facts;
they do not import source prose under an assumed open license. Native names and
translations follow the cited versions and are not universal community claims.

## Updating cultural data

Run `npm run build:cultures` (or `node scripts/ingest-sky-cultures.mjs`) offline.
It reads cached original JSON/Markdown, `anchors.json`, `extra-anchors.json`, and
`curated.json`. It writes:

- `frontend/cultural-sky.json`: approved cards and the source manifest.
- `frontend/cultural-sources.json`: revision, hashes, credits, licenses, and coverage.
- `data/sky-cultures/ingestion-report.json`: unresolved anchors and unpublished records.
- `data/sky-cultures/normalized.json`: ignored local draft catalog, including source metadata.

Normal app and deployment builds use committed outputs and do not query catalogs.
Keep original files, the pinned revision, and source hashes together when updating.
Review the diff of generated artifacts before accepting an updated source revision.

Refresh HIP coordinates explicitly with `npm run cache:culture-anchors`. If the
primary VizieR TAP service is unavailable, download its ASU TSV from the Harvard
mirror and run `node scripts/cache-sky-anchors.mjs --hip-tsv PATH`. The input must
contain HIP, RAICRS, DEICRS columns in that order. The compact cache retains only
referenced stars, ICRS/J1991.25 provenance, and the CDS rights URL. Gaia IDs and
verified non-star coordinates may be added to `extra-anchors.json` with frame,
epoch, and source provenance. No Gaia anchors are required by the current inputs.

The importer preserves HIP/Gaia/DSO identifier types, star-name arrays, figures,
asterisms, references, description sections, source regions, and lunar/zodiac
metadata. Long Gaia IDs remain strings. Explicit Stellarium line coordinates use
hours for RA and degrees for Dec. Unresolved points break polylines; no segment
bridges a missing star. Planets remain unresolved rather than receiving invented
fixed positions. Label centers are independent from points, polylines, and region
bounds. Normalized region rings describe the local, minor spherical interior;
source boundary definitions are also retained in the draft catalog.

To approve a card, add its source-backed text, credits, license, and review note
to `curated.json`, then set publication status to `published`. Source-level
adaptation restrictions still override that status. Do not bypass the restriction
to meet a card count: record explicit permission and update the source policy
first. The current source policy only approves the exact CC BY-SA 4.0 designation.

The panel distinguishes viewport intersections from nearby geometry within 15°.
It uses the existing north-up, east-left square projection and great-circle
segments. Six cards per tradition per section are shown initially, with Show more.
The `culture` link option is one of all, arabic-al-sufi, hawaiian, kamilaroi, vedic,
bengali, or lakota. The panel starts collapsed, including in embedded views.

## Gaia service and astrometric limits

`GET /api/gaia-sources?ra=56.75&dec=24.1167&radius=0.1` accepts ICRS degrees and a
positive radius no greater than the half-diagonal of a 30 arcminute square.
Repeated/unknown parameters, non-numeric input, invalid Dec, and RA outside
0–360° are rejected. The client requests the field half-diagonal; the server
adds 380 arcseconds for reference-epoch motion, based on a conservative maximum
stellar proper motion of 20 arcseconds/year from J2016.0 to J2035.0.

The fixed ESA TAP query selects G ≤ 18, orders by G then source ID, and requests
1001 rows. Responses retain at most 1000 sources and report truncation. CSV avoids
rounding 64-bit source identifiers during JSON parsing. Returned fields are
`sourceId`, `raDeg`, `decDeg`, `refEpoch`, `pmra`, `pmdec`, and `gMag`, with catalog,
frame, query field, retrieval time, attribution, and motion-margin metadata.

Each process uses a separate eight-entry/2 MiB cache for 24 hours, coalesces
identical requests, and admits one distinct upstream request. The shared work-gate
implementation declines new work at 320 MiB RSS. Response bodies are capped at
2 MiB per response. The primary archive has five seconds for headers and body
reads, followed by up to eight seconds for the same catalog at the IDIA VizieR
mirror if the primary request fails. AllWISE uses the same timeout policy. Cache size is
serialized data, not total process memory. Busy responses are 503 with Retry-After;
archive errors are 502 and timeouts 504. Failures are not cached.

The marker overlay is off unless `gaia=1` or the visitor enables it. It propagates
reference positions with tangent-vector proper motion, treating pmra as
mu_alpha*cos(dec), then projects onto the displayed grid. Missing motion keeps a
source at its reference position and is labelled. Annual parallax, observer
effects, perspective acceleration, uncertainties, and identification confidence
are not modeled. Gaia markers are context, not SPHEREx source detections.

Supported epochs are J2025.0–J2035.0. A single exposure uses its midpoint; a daily
stack uses the midpoint of its contributing start/end interval. Deep stacks,
difference/motion-trail modes, and the moving-target viewer suspend markers.
Blink publishes the actual A/B epoch and center separately. A deep blink reference
has no single epoch, so markers disappear during that reference phase.

`sky:display-grid-changed` contains centerRaDeg, centerDecDeg, width, height,
arcsecPerPixel, startUtc, endUtc, epoch, and daily; null clears the overlay.
The renderer emits this on fresh/cached display, blink alternation, clearing, and
resize. Overlay toggles never dispatch processing-settings changes or reload FITS.
The transparent marker canvas ignores pointer events, leaving image inspection
and source marking available. A scrollable source list provides the same positions
and provenance for keyboard and screen-reader users.

## Verification

- `node --test frontend/coordinates.test.js frontend/tests/*.test.js`
- `node scripts/build-vercel.mjs`
- `node scripts/check-resource-budget.mjs`
- `node scripts/check-context-deployment.mjs` (after building)
- `node scripts/check-sky-context-browser.mjs`

The browser smoke test uses an isolated headless Chromium profile and deterministic
synthetic astronomy responses. Set SKY_CONTEXT_BROWSER if Chrome/Brave is not in a
standard location. It checks marker display, playback epochs, cultural cards,
permission notices, navigation, and mobile overflow; saves screenshots in `.local`;
and checks Gaia toggles do not reload FITS. Fixtures are not astronomical evidence.
The Node tests cover geometry, ingestion, publication gates, numeric astrometry,
API limits/errors/cache/deadline, and stale browser requests.

The local server and Vercel builder share `context-assets.js`. The isolated Gaia
function includes its complete transitive imports. Original restricted datasets,
draft normalized records, and ingestion tools are not public assets.
