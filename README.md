# SphereX

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

For stars with substantial proper motion, such as Barnard’s Star and WISE 0855, future work should retrieve proper-motion measurements, their conventions and uncertainties, and the position's reference epoch. Calculate positions for each observation date, incorporating parallax and radial velocity where available and appropriate. Adapt archive searches to cover the object's changing position, center cutouts at the calculated locations, and update markers and time-lapse alignment. Missing motion or epoch data must be shown explicitly rather than treated as zero motion. This would improve small-cutout centering and tracking across dates, but requires separate scientific validation.

## FITS cutouts and aligned display

Open an observation's **Details** row in the search results and choose **View aligned cutout**. The backend asks IRSA's IBE for a target-centered SPHEREx MEF cutout, validates its initial FITS signature, and streams it to the browser with backpressure. Cutouts are limited to 24 MiB; choose a smaller field of view if a request exceeds that limit. Transfers interrupted after streaming begins appear as failed downloads and can be retried. Original-file links download directly from IRSA and are not subject to the cutout limit, including approximately 70 MB original observations.

The browser reads the science image HDU and reprojects each observation from its FITS celestial WCS onto a common north-up, east-left grid centered on the selected target. The selected square field of view is therefore consistent when switching observations. Rendering uses the image data and display stretch controls; the delivered cutout retains the other FITS HDUs for later processing.

Run the app locally with `npm run dev` from this repository. Cutouts are never saved on the server or buffered there as complete files. Successful responses permit private browser caching for one hour. Client disconnects cancel archive transfers. The first cutout request removes only the app's legacy `spherex-cutouts-v1` temporary cache before beginning retrieval.
