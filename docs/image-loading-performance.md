# Image loading and performance verification

The viewer first asks the `/api/crop` proxy for each exposure, and otherwise loads IMAGE and FLAGS rows directly from the public SPHEREx S3 mirror.

## Cropping proxy

Measured on 2026-11-07 for Barnard D1 (16 days, 60 exposures, 16′), direct S3 loading took 205 s. Replaying the same 155 MB from memory took 22 s, so about 89% of the time was spent downloading. Range reads must fetch whole 2040-pixel detector rows, yet only about 230 columns are used. S3 offers neither HTTP/2 nor multi-range responses, so the browser cannot request less.

`api/crop.js` runs the same range loader server-side. It is pinned to Vercel `iad1`, next to the `us-east-1` bucket, and returns only the cropped IMAGE/FLAGS (and optional VARIANCE) pixels as a gzipped binary payload decoded by `lib/crop-codec.js`. It stores nothing itself, but successful crops are cacheable: with a `revision` (the product's modification time, which the viewer always sends) the response is `public, max-age=31536000, s-maxage=31536000, immutable`; without one it is `public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800`. Vercel's CDN caches them per region, so only the first request for an exposure in each region pays the S3 read. Errors (400, 422, 502, 503, 504) stay `no-store`.

- **Payload size:** about 98 KB per exposure on the wire, against about 2.6 MB of ranged S3 bytes (27× less).
- **Fallback:** 503 (busy) is retried twice. Any other proxy failure falls back to direct S3, then to IRSA. A 422 (no detector coverage) is reported as is.
- **Local overrides:** `localStorage.setItem('spherex-image-loader', 's3')` skips the proxy, and `'legacy'` uses IRSA only.
- **No local speedup:** under `npm run dev` the proxy runs on the developer's machine, so it reads S3 over the same link and is not faster. The gain only appears when deployed.
- **Parity:** `node scripts/benchmark-image-loading.mjs --days=2 --runs=1 --modes=s3,proxy --base=http://127.0.0.1:5173` reported a maximum pixel difference of 0 and 0 coverage mismatches, with 487,797 proxy bytes against 13,238,400 S3 bytes for 5 exposures. Run it with `--base=<deployment>` to measure the deployed speedup.

The range loader now converts only the cropped columns of each fetched row (FLAGS rows are still Rice-decoded in full). In an isolated microbenchmark on 2040-pixel rows this cut decoding from 27 ms to 16 ms per exposure. The browser runs `min(4, cores - 1)` image workers, and each load goes to the least-busy worker.

## Saved tour view

The guided tour hands off to the viewer at Barnard's Star. That search follows proper motion, so it is a live multi-window IRSA query (15–25 s measured on 2026-11-14) followed by 47 exposure downloads, all behind the loading screen. The tour instead opens from files saved with the site:

- `frontend/data/tour/barnard.json` holds the search result and an index of saved crops; `frontend/data/tour/crops/*.spxc` holds one gzipped `/api/crop` payload per D2 exposure at the default 16′ field (61 files, 2.6 MB). Each crop is filed under the exact proxy query it answers, and its name is a hash of that query.
- Gzip alone saves little on float pixels, whose low bits are noise: the exact values came to 5.7 MB at the maximum level, and byte-shuffling before gzip would only reach about 5.0 MB. The bake therefore rounds each pixel to a power-of-two step of at most 1/16 of that image's own noise before gzipping, so every saved value is within 1/32 of the noise of the archive's (largest measured difference 0.025σ). The layout is still exactly a proxy payload, so the decoder is unchanged. The results panel states the rounding, and `npm run bake:tour -- --lossless` keeps the exact values instead.
- `lib/baked-view.js` serves the saved search only to the search the tour itself opens (`viewer.html?target=barnard&tour=N`). The search then announces itself as instant and the loading screen stays closed. Measured locally: first image 0.85 s after navigation, all 16 frames 7 s, against 15 s or more before the first image.
- The image worker tries a saved crop before the proxy. The file has the proxy payload's layout, so decoding, projection, stacking and inspection are unchanged. Another detector, field of view, proper-motion tracking or a revised product is simply a miss and loads through the proxy as usual.
- The results panel labels the list "Saved tour example" with the date it was saved. Any search the visitor starts afterwards uses the live archive.
- Refresh with `npm run bake:tour` after the archive adds or revises Barnard exposures. Unchanged crops are kept, outdated ones are removed, and `tests/baked-view.test.js` fails if the saved files stop matching what the default view requests.

## Direct S3 path

The direct S3 path is unchanged apart from the column-only decode. It keeps live metadata searches and existing contribution records. No account, database, persistent server image cache, or new external package is required.

## Pipeline

- One shared scheduler permits four exposure jobs. Selected frames have priority 0, deep stacks priority 1, and speculative warm-up priority 2. Identical requests share work; cancelling one subscriber leaves other subscribers intact. Active requests finish or settle cancellation before their slot is reused.
- One module worker reads and decodes FITS, applies the existing quality mask, estimates backgrounds, computes exact TAN/TAN-SIP projections, and calculates daily/deep medians. Results use transferable buffers. The main thread paints canvases and retains bounded cropped source arrays for compatibility with existing hover, pixel inspection, and transient-check APIs. Stack objects hold source URLs instead of retaining all source arrays; inspection can reload evicted sources.
- Headers are cached by product and revision in a worker cache bounded to 64 entries and 8 MiB. The sky-coordinate grid is reused for the current target/field. IMAGE row reads and FLAGS reads overlap; four exposure jobs issue no more than eight simultaneous range requests. Range reservations are capped at 32 MiB, and any single response is capped at 24 MiB.
- Range reads require HTTP 206 and exactly the requested number of bytes. Full responses are cancelled before body consumption. Content-Range is checked when visible; it is not exposed to browser JavaScript by the tested bucket. Transient failures retry twice with jitter, bounded Retry-After, cancellation, and per-attempt deadlines.
- S3 failure or unsupported layouts fall back once per exposure through the existing single-slot IRSA queue. Cancellation and memory rejection do not initiate fallback. Missing FLAGS remain explicitly unavailable in the inspection UI.

Both paths normalize to a deterministic detector rectangle covering the sky grid plus a three-pixel neighbourhood. The optional `aligned=1` cutout API parameter requests a larger detector rectangle (`min(300, fovArcmin * sqrt(2) + 1)` arcminutes) before client cropping. Ordinary cutout API requests retain their prior size semantics. Live comparison found the old unpadded cutout clipped boundary samples; the padded path and ranged original produced identical pixels and coverage in the checked exposure.

The shared decoded/rendered LRU cache accounts for typed-array buffers and canvas pixels, with a 128 MiB limit. Stack preflight budgets daily grids, up to four concurrent daily groups, median workspace, and transfer headroom against 256 MiB including cache capacity. It refuses excessive selections rather than silently removing exposures. Accounting is conservative and does not measure total browser RSS, JavaScript object/sort overhead, graphics-driver allocations, or HTTP caches.

## Verification and rollback

`npm test` includes synthetic MEFs with floating-point scaling, TAN-SIP, detector edges, RA wrap, missing data, and both FLAGS layouts. Real Rice rows use the existing Astropy oracle. Node-hosted worker integration tests execute the actual browser worker module and exercise transfers, fallback, startup failure, cancellation, and median results. A viewer harness verifies previews, all contributors, export state, detector changes, and stale-result suppression. The harness is not a browser memory or paint benchmark.

For an internal transport rollback, set `localStorage.setItem('spherex-image-loader', 'legacy')` in a developer console and reload. Remove that key to restore S3. This switch bypasses cloud image reads; it does not revert scientific processing, padding, or worker median computation. Deployment assets include every worker dependency in both the local server allowlist and Vercel output.

The live benchmark is opt-in because it accesses NASA services:

```powershell
node scripts/benchmark-image-loading.mjs --days=16 --runs=5
node scripts/benchmark-image-loading.mjs --days=4 --runs=1 --concurrency=8
node scripts/benchmark-image-loading.mjs --target=draconis --days=4 --runs=1
node scripts/benchmark-image-loading.mjs --days=16 --runs=1 --mode=s3
```

It preserves all exposures in the selected UTC days, compares four S3 jobs against serialized padded IRSA cutouts, and reports first-image time, final-stack time, bytes, request counts, maximum pixel difference, and coverage differences. Application caches start fresh each run; upstream/CDN caches and network latency cannot be controlled. Node timings do not measure browser painting or browser peak memory. Incomplete comparisons are reported rather than presented as speedups. Use the browser separately for interactivity and memory profiling before claiming the planned 2x full-stack acceptance target.

## Checks performed on 2026-11-05

- All 140 automated tests, the production build, and `git diff --check` passed. The backend resource check peaked at 224.5 MiB RSS against its 350 MiB limit.
- A real browser completed a four-day D1 stack with all 13 exposures, enabled PNG export, and reported no browser errors.
- The full preset D1 selection completed through the ranged loader: 16 UTC days, 60 exposures, 158,012,608 response bytes, and 242 requests. First completed daily image: 8.98 seconds; final median: 200.37 seconds. This was a Node-hosted transport/processing run, not a browser memory measurement.
- A live single-exposure comparison after fallback padding had zero maximum pixel difference and zero coverage mismatches. Initial timing comparisons ranged from slower S3 on one run to over 2x faster on others. The fifth paired run and the multi-day IRSA baseline were interrupted by archive connection failures; the five-pair, 16-day speedup target is not established. No full-stack numerical speedup is claimed.
- Cropped source arrays remain on the main thread for the existing synchronous hover and inspection flow; heavy decoding, projection, and median operations run in the worker. Full browser peak-memory profiling remains outstanding.
