# SphereX

## Star Details, Sky Culture, and Gaia

Open **Star Details** below the timeline for the selected named target or preset.
**Sky Culture** shows reviewed accounts for the displayed field, including cited
Hawaiian, Vedic, Bengali, and Lakota entries. Arabic al-Sufi and Kamilaroi/Euahlayi selectors
explain their pending adaptation permissions; the five-group content target is
not yet complete. Enable **Gaia stars** under Overlays for approximate dated
catalog markers and an accessible source list. `culture` and `gaia=1` travel in
shared links. See [content sourcing, maintenance, astrometric limits, and tests](docs/cultural-context-and-gaia.md).

Set a contact-bearing `WIKIMEDIA_USER_AGENT` and run `npm run import:stars` to
collect English Wikipedia articles using its stellar infobox, plus the reviewed
preset profiles. The importer follows all result pages and adds Wikidata catalog
aliases and discovery facts where present. It writes `.local/star-profiles.json`,
which the local server uses after a restart.

To publish the catalog, apply the [star profiles migration](supabase/migrations/20261109000000_star_profiles.sql)
to the same Supabase project as the search cache and configure the existing
server-side `SUPABASE_URL` and `SUPABASE_SERVICE_KEY`. The default import uploads
when these variables are set. Use `npm run import:stars -- --collect-only` for
local collection and `npm run import:stars -- --from-snapshot` to upload an
existing snapshot without repeating the download. The viewer uses the local
snapshot or bundled profiles when Supabase has no match or is unavailable.

## Railway deployment

Railway runs alongside Vercel. The Railway GitHub Actions workflow deploys pushes to `main`, supports manual runs, and accepts an exact `source_ref` when called by the daily observation-index workflow. Each deployment runs the regression suite before uploading the checked-out source. The CLI is pinned to [Railway v5.63.1](https://github.com/railwayapp/cli/releases/tag/v5.63.1).

To configure an existing Railway project:

1. Create or select the app service in the **production** environment. Use the repository root (`/`) as the service root so `railway.json`, the frontend, and the committed observation index are all included.
2. In Railway project settings, create a **Project Token** scoped to that production environment. Save it as the GitHub repository Actions secret `RAILWAY_TOKEN`. Use a project token rather than an account API token.
3. Copy the target service ID from Railway and save it as the GitHub repository Actions secret `RAILWAY_SERVICE_ID`.
4. Disable Railway's native GitHub autodeploy for this service (disconnect its GitHub source if needed). GitHub Actions uploads the source with the CLI; enabling both paths would deploy the same changes twice.
5. In the service's Networking settings, generate a public Railway domain. Uploading with the CLI does not create a public domain automatically.
6. Run **Railway Production Deployment** from the GitHub Actions tab. Check the Railway deployment health and then open the public homepage and `/api/index-status`.

Railpack uses Node.js 24 from `package.json`. The Railway build command checks server syntax rather than running the Vercel-specific artifact builder. The start command is `HOST=0.0.0.0 NODE_OPTIONS=--max-old-space-size=192 npm start`; the server reads Railway's assigned `PORT`. Local `npm start` and `npm run dev` default to `127.0.0.1:5173`. Railway checks `/` with a 60-second startup timeout and restarts failed processes up to three times.

The workflow uses `railway up --service "$RAILWAY_SERVICE_ID" --ci`, which waits for the build, not runtime health verification. Confirm deployment health in Railway before treating a release as live. See [Railway CLI deployment documentation](https://docs.railway.com/cli/deploying) and [configuration reference](https://docs.railway.com/config-as-code/reference).

When the daily index changes, the update workflow calls each configured deployment independently with the saved commit SHA. Missing Railway secrets skip only that scheduled Railway deployment; the index is still saved and Vercel remains eligible to deploy. Direct Railway workflow runs report missing secrets as errors. No persistent volume or server-side FITS storage is configured.

## Observation searches and resource limits

Every target, including presets, uses backend IRSA metadata queries first. Successful pages (including empty results) are cached for five minutes in server memory, with a shared limit of eight entries and 8 MiB of serialized data across collection variants. Least-recently-used entries are evicted, oversized results are served without caching, and identical in-flight searches share one archive query. Serialized cache size estimates retained data; it is not a measurement of JavaScript heap usage. Caches are separate per process and deployment and reset on restart.

The daily preset index is backup metadata for the five exact preset positions. It is read only when an initial live search fails upstream, or when continuing a version-pinned fallback search. Results show the index check time and an outage warning, even when no rows match. Index data older than 48 hours is marked stale. Invalid input, busy responses, and successful empty live results do not select fallback data. Live pagination never switches to the preset index; a failed next page leaves loaded rows available for retry. Daily index updates download metadata, not FITS images.

Each process permits one distinct upstream observation query and one cutout transfer at a time. Additional work returns HTTP 503 with `Retry-After: 5`. New upstream work is also declined at 320 MiB process RSS; cached metadata stays available. Railway limits Node's old-generation heap to 192 MiB, which does not limit total process memory. The resource smoke test (`node scripts/check-resource-budget.mjs`) measures a separate server process with near-limit metadata responses, 24 MiB streamed cutouts, and slow clients; it requires peak RSS below 350 MiB. Verify the deployed service's memory and disk use before rollout on a 500 MB instance. Original images remain at IRSA; no Redis or persistent image cache is needed. A shared metadata cache in Supabase is optional (below).

### Shared search cache (optional, Supabase)

Live searches (proper-motion stars such as Barnard's Star, custom positions, comets and asteroids) can be saved in one Supabase table, so a search made once is served instantly to every visitor and survives deploys and cold starts. Only metadata is stored, never images. The browser also keeps its own copy for up to six hours.

1. Create a free Supabase project and run this in its SQL editor:

   ```sql
   create table public.search_cache (
     key text primary key,
     kind text not null check (kind in ('observations','moving')),
     params jsonb not null,
     result jsonb not null,
     saved_at timestamptz not null default now(),
     checked_at timestamptz not null default now(),
     last_used_at timestamptz not null default now()
   );
   create index on public.search_cache (last_used_at);
   alter table public.search_cache enable row level security;
   grant select, insert, update, delete on public.search_cache to service_role;
   ```

2. Set `SUPABASE_URL` and `SUPABASE_SERVICE_KEY` (the project's secret or `service_role` key) on Railway, on Vercel, and as GitHub Actions secrets. The key stays on the server; with RLS on and no policies, nothing else can read the table.

Saved results are fresh for 36 hours when the search covers the last 30 days (or has no end date), and for 7 days otherwise. If IRSA, MOST or JPL Horizons is down, results up to 7 days past that are served with a warning. The daily update workflow runs `npm run refresh:cache`, which re-runs recent-range searches, re-runs comet searches only when JPL's orbit solution changed, and deletes rows unused for 7 days. Any Supabase failure is treated as a cache miss; without the variables the cache is off.

## Object-name lookup

Choose **Object name**, enter one common name (such as `Sirius`) or catalog identifier (such as `M31`), and choose **Resolve**. Review the returned identifier, full-precision RA/Dec, ICRS frame, catalog resolver, and retrieval time. **Use this target** applies that position and starts the existing IRSA observation search with the current filters. Resolving alone does not change your target or results.

The backend uses [CDS Sesame](https://tapvizier.cds.unistra.fr/vizier/doc/sesame.htx), querying SIMBAD, then NED, then VizieR until a position is found. If Sesame fails or takes longer than two seconds, lookup falls back to the independently hosted [SIMBAD Harvard mirror](https://simbad.cfa.harvard.edu/simbad/). Both requests share a 10-second overall deadline, within the 15-second Vercel function limit. The interface names the service that actually supplied the coordinates. The mirror's ICRS sexagesimal coordinates are converted to degrees without display rounding. An authoritative Sesame miss remains a 404; a mirror-only miss while Sesame is unavailable is a service error, since NED/VizieR coverage could not be checked. Successful responses are cached for 24 hours in a bounded, 200-entry process-local cache. Cache reuse depends on the server or function instance remaining warm. Failures are not cached.

`GET /api/resolve-object?name=…` returns `submittedName`, optional `resolvedName` (null when unavailable), `raDeg`, `decDeg`, `frame`, `source`, and `retrievedAt`. Errors distinguish invalid input (400), unrecognized names (404), upstream failures (502), and timeouts (504). Enter a single name of at most 200 characters; control characters, ampersands, semicolons, and repeated name parameters are rejected. The supplied local server and Vercel deployment both serve this endpoint.

The search autocomplete groups **Stars and deep-sky objects**, **Moving objects**, and **Search by coordinates** as distinct categories. It suggests popular targets before typing, searches names and aliases as the user types, and offers typo corrections (for example, `Siruis` suggests Sirius). The fixed-target catalogue includes Milky Way along with familiar stars, galaxies, nebulae, clusters, and the five presets. The moving-object category has its own suggestions for comets, asteroids, and interstellar objects; selecting a target uses the date range and moving-object archive search. Users can still submit other names and designations to the live resolver or moving-object search. Matching ignores case and punctuation; spelling suggestions use one edit for three–seven normalized characters and two edits for longer names. A resolver outage is reported separately from an unrecognized name; presets and manual coordinates remain available.

Successful name resolution establishes a catalog position, not SPHEREx coverage or a source detection. IRSA searches determine available observations separately. Catalog-derived positions retain their returned precision and provenance; preset coordinates and their scheduled index are unchanged.

### Future consideration: tracking stellar motion

This release uses fixed catalog positions interpreted in ICRS. It does not propagate positions to observation dates or provide Solar System ephemerides. A catalog coordinate system or J2000 label does not by itself establish the position's reference epoch.

The Barnard’s Star, Epsilon Indi B and WISE 0855 presets use linear proper motion from a J2000 reference position (`MOTIONS` in `frontend/presets.js`) for archive searches, and center each cutout at the exposure midpoint. See [the pointing benchmark](docs/stacking-within-observing-periods.md#fixed-star-contrast-benchmark) for coverage and contrast results. The WISE 0855 preset keeps the challenge's discovery-epoch coordinates as its identity; the dwarf itself is about 2′ west of them in 2025–2026 SPHEREx data, where it appears at the predicted position in D5/D6 stacks. The Epsilon Indi B preset is centered on the brown-dwarf pair, 6.7′ east of the bright primary Epsilon Indi A. Parallax (up to 0.55″ for these stars) and radial velocity are not modelled.

Turn off **Follow the star’s proper motion** (View panel) to hold the sky fixed at the star’s 2026-01-01 position instead. Background stars then stay still and the star’s own motion shows up in blink, difference and motion-trail views; for Barnard’s Star, the August 2025 → August 2026 difference shows a 10″ northward shift as an orange/blue pair.

## FITS cutouts and aligned display

Open an observation's **Details** row in the search results and choose **View aligned cutout**. The normal loader reads bounded FITS headers and the needed IMAGE/FLAGS rows directly from the public SPHEREx S3 mirror. A shared queue runs up to four exposure jobs; FITS decoding, exact WCS projection, background estimation, and median computation run in a module Web Worker. All selected exposures remain eligible; loading does not introduce a four-exposure sampling cap. Completed daily frames appear while the deep stack builds, with previews labelled and exports enabled only after completion.

If cloud access fails or a FITS layout is unsupported, the backend asks IRSA's IBE for a padded target-centered cutout, validates its initial FITS signature, and streams it to the browser with backpressure. Fallback cutouts are limited to 24 MiB and remain serialized; server-busy responses receive bounded retries. An unavailable worker retains a main-thread fallback. Original-file links still download directly from IRSA and are not subject to the cutout limit.

The browser reprojects each observation from its FITS celestial WCS onto a common north-up, east-left grid centered on the selected target. Both loading paths crop to the same detector footprint, including interpolation and inspection neighbours, before background estimation. The padded fallback fixes edge clipping in the previous unpadded cutout path, so some boundary pixels can now have data. The shared decoded/rendered cache has a 128 MiB byte budget, and a conservative preflight refuses stacks estimated to exceed the 256 MiB working budget without dropping exposures. These estimates do not limit total browser process memory.

Run the app locally with `npm run dev` from this repository. Cutouts are never saved on the server or buffered there as complete files. Successful responses permit private browser caching for one hour. Client disconnects cancel archive transfers. The first cutout request removes only the app's legacy `spherex-cutouts-v1` temporary cache before beginning retrieval.

See [image loading and performance verification](docs/image-loading-performance.md) for worker integration, rollback, and the opt-in live benchmark.

## Shareable links and the embeddable viewer

Every part of a view that describes *where and when* you are looking can travel in the URL. The address bar is rewritten with `history.replaceState` as you work, so the link is always shareable without a "save" step, and sharing never adds entries the back button has to fight through. A bare page writes no query string until the view actually differs from the default.

| Parameter | Meaning | Omitted when |
| --- | --- | --- |
| `ra`, `dec` | ICRS position in decimal degrees | position is the default target |
| `fov` | Field of view in arcminutes (5, 10, 16, 25) | 16 |
| `band` | Detector band 1–6 | 2 |
| `from`, `to` | Observation date range, `YYYY-MM-DD` | unset |
| `at` | The dated frame the sender was looking at | no frame opened |
| `mra`, `mdec` | Marked candidate source position | no source marked |
| `target` | Curated target id, for the highlighted card | custom or resolved position |
| `embed` | `1` renders the compact, embeddable layout | not embedded |
| `mode`, `ref`, `refat` | View mode, comparison reference, and the pinned reference frame's date | defaults (`time-lapse`, `previous`) |
| `look`, `bright`, `contrast`, `stretch`, `scale`, `colours`, `invert` | Display settings | defaults |
| `stack`, `blink`, `thresh` | Deep-stack day limit, blink interval (ms), difference threshold (σ) | defaults |
| `note` | One-line note from the AI guide, shown in a banner on arrival (≤200 chars) | no note |

When a link carries any view or display setting, all of them apply, so the recipient sees the sender's exact view instead of a mix with their own remembered settings. `at` and `refat` pick the frame observed on that UTC date, or the nearest one.

`url-state.js` owns the encoding and validation, and is the only module that decides what a link means. It is DOM-free and unit tested, so a truncated or hand-edited link degrades field by field: an impossible declination, an unoffered field of view, or a date such as `2026-02-31` falls back to the default for that field and is reported in a notice at the top of the page rather than failing the whole view. Right ascension wraps into 0–360° because it is cyclic; a mark with only one of its two coordinates is dropped rather than half-applied. A reversed date range is cleared instead of inverted.

Opening a link restores the position, the field of view, the detector band, the date range and the marked source, then runs the archive search and jumps to the closest dated frame to `at`. Frames reached by playback deliberately do not rewrite the URL, so a running time-lapse does not churn the address bar; only a frame the visitor opens is recorded.

**Marking a source.** Click the sky image to drop a candidate-source marker at the position under the cursor. The marker is an absolute sky position, so it survives frame changes, band changes and new searches. `sky-projection.js` holds the single canvas↔sky transformation used by both the renderer and the marker, and a round-trip unit test pins it. When the field of view changes, the marker keeps its sky position and moves toward the centre of a wider field; when a marked source falls outside the current field, it is drawn clamped to the edge and labelled `outside field` rather than disappearing. **Clear mark** removes it and drops the parameters from the link.

**Embedding.** `?embed=1`, or simply being inside an iframe, switches to a compact layout that keeps the viewer and its timeline, hides the page chrome, settings and observation table, and adds `is-embed` on the document element before first paint to avoid a flash of the full page. The **Embed this view** button produces an `<iframe>` snippet for the current position, field of view, band, dates and marked source. The app sets no `X-Frame-Options` or `frame-ancestors` restriction, so the snippet works as-is.

Both `frontend/server.mjs` and `scripts/build-vercel.mjs` keep an explicit list of public assets. `url-state.js`, `sky-projection.js`, `share.js` and `share-ui.js` are registered in both; add any new frontend module to both lists or it will 404 in production while working locally. PlanetX's `planetx.html` and `planetx.js` must also remain in the Vercel build's public asset list.

## AI guide (OpenRouter)

The **AI guide** section under the viewer lets visitors ask in plain words ("is anything moving here?", "compare the first and latest frame", "make the faint stars brighter", "show me WISE 0855"). The guide works the real viewer through tools and answers from what the viewer reports (difference σ and brighter/fainter pixel counts, deep-stack records, frame dates), and it can make a share link that reopens its view with a short note.

- `frontend/api/agent.js` is a stateless proxy to OpenRouter's chat completions API. It holds the key, the system prompt and the tool schemas, sanitises the history, and rate-limits each client (30 requests a minute).
- `frontend/lib/agent-tools.js` defines the 24 tools and validates their arguments against the viewer-settings rules (the server and the browser share it). Viewer tools: `get_view_state`, `set_display`, `set_view_mode`, `compare_frames`, `playback`, `set_view`, `go_to_target`, `make_share_link`. Investigation tools: `find_changes`, `mark_spot`, `measure_source`, `get_spectrum`, `crossmatch`, `get_case`, `pick_epochs`, `predict_parallax_pair`, `precover`, `second_opinion`. Modes: `start_quest`, `check_answer`, `planet_nine_region`, `patrol`, `start_tour`, `prepare_report`.
- `frontend/agent-ui.js` runs the tool-calling loop in the browser; `frontend/agent-controller.js` carries out each call through the same window events the controls use, then waits for the viewer to report what it rendered.

Set `OPENROUTER_API_KEYS` in `.env` for local development (`npm run dev` loads it) and in the Vercel and Railway environments. It takes one or more keys separated by commas (`OPENROUTER_API_KEYS=sk-or-a,sk-or-b,sk-or-c`); a single `OPENROUTER_API_KEY` still works and is added to the pool. Requests take the keys in round-robin order. When a key hits its per-minute or per-day limit, it is set aside until OpenRouter's reset time (a per-day limit with no reset time waits until the next UTC midnight) and the request moves on to the next key. A rejected or out-of-credit key is set aside for an hour. The guide only reports that it is busy when every key is limited. OpenRouter counts free-model limits per account, so keys from the same account share one limit. The default model is NVIDIA Nemotron 3 Ultra (`nvidia/nemotron-3-ultra-550b-a55b`), which uses OpenRouter credits. If `OPENROUTER_MODEL` is already set, remove it to use the default or update it to the desired OpenRouter model ID with tool calling support. Without a key, the guide reports that setup is required.

### The sky detective: spots, case files, games and Planet Nine

**Spots.** Click the image to mark numbered spots (up to nine). Visitor spots are gold, spots the guide marks are blue, predicted positions are dashed purple. Hover a marker to remove it; click its number to attach it to your next message. New spots appear as reply chips above the message box ("↩ Spot 1") and the message reaches the model as `[Spot 1: ra=…, dec=…]`. Spot 1 keeps the `mra`/`mdec` link parameters; later spots travel in `spots=ra,dec;ra,dec`. While the guide is closed, a red dot on its header icon says when a spot is marked, the guide marks spots, a difference view finds changes, or a preset has a game.

**Case files** (`frontend/lib/case-file.js`). Every spot has a list of suspects: glitch, colour-shift ghost, known star, fast-moving star, known asteroid, variable star, something distant. Tool results rule suspects out or support them by fixed rules (for example, seen on two or more dates rules out a glitch; a Gaia star within 6″ supports a known star; a JPL match within 30″ supports a known asteroid). The verdict is computed by code, never by the model, and is only "unexplained — needs follow-up" when every ordinary suspect is ruled out. Case cards in the chat show ✓/✗/? for each suspect.

**Checks on every reply** (`frontend/lib/agent-guard.js`). Before a reply is shown, every number must appear in a tool result, the visitor's message or a short list of historical facts, and discovery claims ("we discovered a new planet", "this is Planet Nine") are refused. A failing reply gets one rewrite round; if that also fails, the unsupported sentences are removed and the visitor is told. The proxy also flags discovery claims.

**Investigation tools** (`frontend/agent-investigate.js`):
- `find_changes` finds compact brighter and fainter patches in the difference view (`lib/blobs.js`), pairs them, and marks the strongest as spots.
- `measure_source` and `get_spectrum` use the aperture photometry shared with the spectrum explorer (`lib/photometry.js`). `get_spectrum` adds plain-language hints (`lib/spectral-hints.js`), such as a methane-like dip near 3.3 μm.
- `crossmatch` checks Gaia DR3 (`/api/gaia-sources`, proper motion applied) and NASA JPL's Small-Body Identification API (`/api/known-objects`). SBIdent can take over a minute in crowded fields: the endpoint waits 20 s, then answers `pending` while the lookup finishes and fills a 24-hour cache.
- `pick_epochs` compares frames about six months apart. SPHEREx looks about 90° from the Sun, so a distant body shifts by roughly 2 AU ÷ distance between those visits (about 14′ at 500 AU) while barely moving within days. `predict_parallax_pair` (`lib/ecliptic.js`) predicts where a body at a chosen distance would appear on the other date. `precover` follows the motion between two spots into the other frames.

**Games** (`lib/quests.js`). *Be Barnard* checks the click against Barnard's Star's catalogued motion. *Be Tombaugh* blinks North Ecliptic Pole frames a few days apart and accepts any spot JPL identifies as a moving body. *Be Le Verrier* searches the top Planet Nine cell. *Find the hidden planet* adds a fake moving source of one fixed brightness to every rendered exposure, in a copy of the data, never the cache. After three misses the guide reveals it, and keeps a found/missed record by brightness for the session.

**Planet Nine region.** `node scripts/planet-nine-region.mjs [reference_population.csv]` bins the Brown & Batygin (2021) reference population (CaltechDATA record 8fjad-x7y61, CC0) into 5° cells. It keeps the synthetic planets the ZTF, DES and Pan-STARRS searches would have missed, about 22% of 100,000, and writes `frontend/data/planet-nine.json`. `planet_nine_region` and `patrol` use it. A patrol moves to each cell, compares frames six months apart, lists the changes and crossmatches them. A quiet cell is reported as "nothing changed", not as proof that nothing is there.

**Tour and reports.** The *Take the tour* card plays `lib/tours.js` directly, with no model, so it cannot stall during a demo. `prepare_report` builds a "Think you've got one?" card: position, suspects ruled out and still open, and a share link.

**Optional features** (each off until configured; `GET /api/agent?capabilities` reports which are on):
- `OPENROUTER_VISION_MODEL` (a vision-capable OpenRouter model) turns on `second_opinion` (`/api/agent-vision`). It shows new, reference and difference stamps around a spot, asks twice, and reports disagreement as "unsure". The opinion is a note in the case file and never decides a suspect.
- `OPENROUTER_CRITIC_MODEL` turns on the sceptic. When a case is about to become "unexplained", a second model argues for the most ordinary explanation, and the guide gets one round to answer.
- `OPENROUTER_FAST_MODEL` (a quicker OpenRouter model) answers the guide's short automatic turns after a background check finishes, and is the last retry when the main model runs past the 26-second request budget. Without it, slow answers are retried with a shorter history on the main model.
- `SUPABASE_URL` and `SUPABASE_SERVICE_KEY`, with the migration [`supabase/migrations/20261110000000_agent_records.sql`](supabase/migrations/20261110000000_agent_records.sql) applied, save patrol results and let visitors send reports to the team (`/api/cases`, table `agent_records`, positions and measurements only). Without them, reports offer only the share link.

On wide screens the guide is a side panel and the image stays clickable for marking spots; below 900 px it stays a modal drawer. New guide modules are listed once in `frontend/agent-assets.js`, which both the local server and the Vercel build publish.

## Documentation

`docs/SPHEREx_Challenge_Documentation.docx` is generated, not hand-edited. Edit [`scripts/build-docs.py`](scripts/build-docs.py) and rebuild:

```bash
python scripts/build-docs.py            # writes SPHEREx_Challenge_Documentation.docx
python scripts/build-docs.py out.docx   # or to an explicit path
```

The script writes to the repository root by default and needs `python-docx`. Screenshots are read from `docs/screenshots/`; if they are absent the build still succeeds and says which figures were skipped. Word documents are listed in `.gitignore`, so a rebuild never creates a stray commit — commit the script and the screenshots, regenerate the `.docx` only for submission.
