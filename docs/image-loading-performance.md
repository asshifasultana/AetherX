# Image loading and performance verification

The viewer normally loads IMAGE and FLAGS rows directly from the public SPHEREx S3 mirror. It keeps live metadata searches and existing contribution records. No account, database, persistent server image cache, or new external package is required.

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
