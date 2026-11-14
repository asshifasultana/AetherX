# SphereX

## Cultural sky context and Gaia

Open **Cultural sky context** below the timeline for cited Hawaiian, Vedic,
Bengali, and Lakota entries. Arabic al-Sufi and Kamilaroi/Euahlayi selectors
explain their pending adaptation permissions; the five-group content target is
not yet complete. Enable **Gaia stars** under Overlays for approximate dated
catalog markers and an accessible source list. `culture` and `gaia=1` travel in
shared links. See [content sourcing, maintenance, astrometric limits, and tests](docs/cultural-context-and-gaia.md).

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

Each process permits one distinct upstream observation query and one cutout transfer at a time. Additional work returns HTTP 503 with `Retry-After: 5`. New upstream work is also declined at 320 MiB process RSS; cached metadata stays available. Railway limits Node's old-generation heap to 192 MiB, which does not limit total process memory. The resource smoke test (`node scripts/check-resource-budget.mjs`) measures a separate server process with near-limit metadata responses, 24 MiB streamed cutouts, and slow clients; it requires peak RSS below 350 MiB. Verify the deployed service's memory and disk use before rollout on a 500 MB instance. Original images remain at IRSA; no Redis, database, or persistent image cache is needed.

## Object-name lookup

Choose **Object name**, enter one common name (such as `Sirius`) or catalog identifier (such as `M31`), and choose **Resolve**. Review the returned identifier, full-precision RA/Dec, ICRS frame, catalog resolver, and retrieval time. **Use this target** applies that position and starts the existing IRSA observation search with the current filters. Resolving alone does not change your target or results.

The backend uses [CDS Sesame](https://tapvizier.cds.unistra.fr/vizier/doc/sesame.htx), querying SIMBAD, then NED, then VizieR until a position is found. If Sesame fails or takes longer than two seconds, lookup falls back to the independently hosted [SIMBAD Harvard mirror](https://simbad.cfa.harvard.edu/simbad/). Both requests share a 10-second overall deadline, within the 15-second Vercel function limit. The interface names the service that actually supplied the coordinates. The mirror's ICRS sexagesimal coordinates are converted to degrees without display rounding. An authoritative Sesame miss remains a 404; a mirror-only miss while Sesame is unavailable is a service error, since NED/VizieR coverage could not be checked. Successful responses are cached for 24 hours in a bounded, 200-entry process-local cache. Cache reuse depends on the server or function instance remaining warm. Failures are not cached.

`GET /api/resolve-object?name=…` returns `submittedName`, optional `resolvedName` (null when unavailable), `raDeg`, `decDeg`, `frame`, `source`, and `retrievedAt`. Errors distinguish invalid input (400), unrecognized names (404), upstream failures (502), and timeouts (504). Enter a single name of at most 200 characters; control characters, ampersands, semicolons, and repeated name parameters are rejected. The supplied local server and Vercel deployment both serve this endpoint.

For unrecognized names, the interface offers up to three spelling suggestions from a name-only list of 20 familiar objects and aliases, including the five presets. Matching ignores case and punctuation, requires at least four normalized characters, and allows one edit for four–seven characters or two edits for longer names. Swapping adjacent letters counts as one edit (for example, `Siruis` suggests Sirius). Suggestions are limited to that list; the live resolver supports other identifiers. Choosing a suggestion performs another live lookup and still requires confirmation. A resolver outage is reported separately from an unrecognized name; presets and manual coordinates remain available.

Successful name resolution establishes a catalog position, not SPHEREx coverage or a source detection. IRSA searches determine available observations separately. Catalog-derived positions retain their returned precision and provenance; preset coordinates and their scheduled index are unchanged.

### Future consideration: tracking stellar motion

This release uses fixed catalog positions interpreted in ICRS. It does not propagate positions to observation dates or provide Solar System ephemerides. A catalog coordinate system or J2000 label does not by itself establish the position's reference epoch.

The Barnard’s Star preset uses linear proper motion for archive searches and centers each cutout at the exposure midpoint. See [the pointing benchmark](docs/stacking-within-observing-periods.md#fixed-star-contrast-benchmark) for coverage and contrast results. Extending this to other nearby sources, such as WISE 0855, requires verified astrometry and a reference epoch for each source. Parallax and radial velocity can be included for finer astrometry.

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

`url-state.js` owns the encoding and validation, and is the only module that decides what a link means. It is DOM-free and unit tested, so a truncated or hand-edited link degrades field by field: an impossible declination, an unoffered field of view, or a date such as `2026-02-31` falls back to the default for that field and is reported in a notice at the top of the page rather than failing the whole view. Right ascension wraps into 0–360° because it is cyclic; a mark with only one of its two coordinates is dropped rather than half-applied. A reversed date range is cleared instead of inverted.

Opening a link restores the position, the field of view, the detector band, the date range and the marked source, then runs the archive search and jumps to the closest dated frame to `at`. Frames reached by playback deliberately do not rewrite the URL, so a running time-lapse does not churn the address bar; only a frame the visitor opens is recorded.

**Marking a source.** Click the sky image to drop a candidate-source marker at the position under the cursor. The marker is an absolute sky position, so it survives frame changes, band changes and new searches. `sky-projection.js` holds the single canvas↔sky transformation used by both the renderer and the marker, and a round-trip unit test pins it. When the field of view changes, the marker keeps its sky position and moves toward the centre of a wider field; when a marked source falls outside the current field, it is drawn clamped to the edge and labelled `outside field` rather than disappearing. **Clear mark** removes it and drops the parameters from the link.

**Embedding.** `?embed=1`, or simply being inside an iframe, switches to a compact layout that keeps the viewer and its timeline, hides the page chrome, settings and observation table, and adds `is-embed` on the document element before first paint to avoid a flash of the full page. The **Embed this view** button produces an `<iframe>` snippet for the current position, field of view, band, dates and marked source. The app sets no `X-Frame-Options` or `frame-ancestors` restriction, so the snippet works as-is.

Both `frontend/server.mjs` and `scripts/build-vercel.mjs` keep an explicit list of public assets. `url-state.js`, `sky-projection.js`, `share.js` and `share-ui.js` are registered in both; add any new frontend module to both lists or it will 404 in production while working locally.

## Documentation

`docs/SPHEREx_Challenge_Documentation.docx` is generated, not hand-edited. Edit [`scripts/build-docs.py`](scripts/build-docs.py) and rebuild:

```bash
python scripts/build-docs.py            # writes SPHEREx_Challenge_Documentation.docx
python scripts/build-docs.py out.docx   # or to an explicit path
```

The script writes to the repository root by default and needs `python-docx`. Screenshots are read from `docs/screenshots/`; if they are absent the build still succeeds and says which figures were skipped. Word documents are listed in `.gitignore`, so a rebuild never creates a stray commit — commit the script and the screenshots, regenerate the `.docx` only for submission.
