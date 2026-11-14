# Stacking within observing periods

This page documents how SphereX groups and combines exposures, how the deep stack is built, and where to find the contribution record.

## UTC-day frames

With **Combine exposures from the same day** enabled, observations are grouped by their UTC calendar date and detector. Each date stays a separate timeline frame. The frame's start is the earliest observation start and its end is the latest observation end. The archive exposure-time total is shown after loading and counts only successfully included exposures. The UI states this UTC-day definition because a calendar day can include more than one SPHEREx visit/OBSID.

## Daily combination method

For every exposure in a daily frame, SphereX:

1. retrieves and decodes its FITS cutout;
2. applies the FITS quality mask before sampling;
3. estimates and subtracts that cutout's robust sky pedestal for display;
4. reprojects its pixels onto the common north-up sky grid;
5. combines the resulting pixel values with a **per-pixel median**.

Masked, missing, and uncovered pixels are represented as invalid samples and omitted from that pixel's median. They are never inserted as zero. The median is robust to a small number of artifacts; it is not an exposure-time-weighted sum and does not preserve a calibrated integrated flux. Dates remain separate frames, so the daily combination does not merge different observing periods.

## Deep median stack

Choose **Deep stack** to build a second median across chronological UTC-day frames. By default, each day's quality-aware stack is aligned to the selected sky position. The Barnard’s Star preset instead aligns each exposure to the star's predicted position at its midpoint before combining the pixels. **Maximum deep-stack frames** defaults to 80 and can be set from 4 to 400. When there are more available frames than the selected limit, the stack uses the earliest frames and reports how many later frames were excluded. Failed daily frames and failed source exposures are reported separately.

Exposures load through a shared four-job pool using S3 byte ranges, with serialized IRSA cutout fallback. The first completed daily frame appears immediately. Subsequent deep-stack previews include complete daily frames only and refresh at most once per second between batches. Preview progress reports days, loaded exposures, and failed exposures; PNG exports become available after the final median. Completion order does not change contributor ordering. No additional exposure cap is applied. Memory preflight may require a smaller field or a lower explicit frame limit before downloading.

Barnard’s Star uses linear proper motion. Live archive searches use one predicted position per 180-day window because IRSA TAP accepts one footprint position per query. Cutouts use individual exposure times, and the outage fallback uses the stored index. Enter coordinates manually to view a fixed sky position. Comet ephemeris tracking runs through the separate pipeline below.

## Fixed-star contrast benchmark

`node scripts/benchmark-fixed-stack.mjs --target=barnard --detector=2 --limit=21` compares the daily-then-deep median with a single median, mean, and sky-noise-weighted mean across individual exposures. All four methods use the same quality-masked 49 × 49 projections and sky annulus. The script reports peak contrast, the peak and sky scatter separately, the background-subtracted aperture sum, and the contrast after leaving each UTC date out. The aperture sum is an image diagnostic, not calibrated photometry.

For Barnard's Star the benchmark and viewer propagate the [SIMBAD position and Gaia proper motion](https://simbad.cds.unistra.fr/simbad/sim-id?Ident=Barnard%27s+Star) to each exposure midpoint. This is a linear approximation without parallax or perspective acceleration. Use `--catalog-center` for the older pointing or `--fixed-at=2025-08-27` for a single corrected center. The script selects the earliest matching products in the local snapshot (optionally bounded by `--from` and `--through` UTC dates) and reports product IDs and coverage exclusions. Use `--live-search` to score live archive candidates and add `--fixed-search` to search the old position while keeping proper-motion alignment. Use `--include-masked-center` to retain exposures with a masked center and enough valid sky pixels.

| D2 field | Usable / sampled | Daily then deep median | Exposure median | Exposure mean | Sky-weighted mean |
| --- | ---: | ---: | ---: | ---: | ---: |
| Barnard's Star, with proper motion | 9 / 21 | 17,327 | 16,050 | 15,282 | 15,971 |
| RW Aurigae, fixed pointing | 21 / 21 | 10,949 | 8,424 | 9,101 | 9,144 |

The two-stage median led on both full samples, but the ordering changed on some date omissions. Barnard's Star lay outside the 49 × 49 grid at the stored catalog position, and its corrected peak still had sparse coverage. This run did not reproduce the earlier 9,706 baseline, so the scores are not a before-and-after comparison with that benchmark.

Repeating the Barnard's Star comparison with `--include-masked-center` gave these daily-then-deep median scores on the same 21 snapshot products.

| Pointing | Peak contrast | Included exposures | Exposures contributing to peak |
| --- | ---: | ---: | ---: |
| Stored catalog center, star outside cutout | 1.24 (sky) | 21 | 21 |
| Fixed at 2025-08-27 | 15,826 | 20 | 5 |
| Exposure midpoint | 15,713 | 20 | 5 |

For 2025-08-20 through 2025-08-31, the live D2 search returned 19 candidates at the old position and 18 using the predicted position. The extra candidate from the old search had insufficient usable sky. With exposure midpoint alignment, both lists gave a peak contrast of 15,144 from the same 18 usable inputs.

Extending the live search through 2026-03-22 gave 36 usable exposures with either alignment. Peak contrast increased from 16,395 at the fixed August pointing to 17,210 with exposure midpoint alignment, a 5.0% gain. The peak amplitude and its five contributors were nearly identical. The gain came from lower measured sky scatter.

To compare the WISE-inspired projection variants on that same date range, run:

```powershell
node scripts/benchmark-fixed-stack.mjs --live-search --include-masked-center --projection-trials --limit=100 --from=2025-08-20 --through=2026-03-22
```

The trial uses the same exposure list, pointing, finite-pixel footprint, daily median and scoring annulus in all four variants. The sky plane fits a clipped gradient to projected pixels outside the scoring annulus (radius greater than 20 pixels) and removes its slopes while keeping the central zero point. Lanczos-3 uses the full 6 × 6 stencil where it is valid and falls back to bilinear sampling at masks and edges. The report includes aperture sum, coverage at the peak, how often the peak was sampled with Lanczos, and results after omitting each date.

| D2 field | Exposures | Baseline | Sky plane | Lanczos-3 | Both |
| --- | ---: | ---: | ---: | ---: | ---: |
| Barnard’s Star | 36 | 17,210 | 17,205 | 15,155 | 15,773 |
| RW Aurigae | 21 | 10,949 | 10,879 | 12,434 | 12,217 |

For Barnard’s Star, all five exposures contributing at the peak fell back to bilinear sampling. Lanczos increased the measured sky scatter and lowered contrast in all ten date omissions. For RW Aurigae, 11 of the 21 exposures contributing at the peak used Lanczos. The peak rose 17.7%, the aperture sum rose 6.7%, and contrast rose 13.6%. The contrast gain persisted in all four date omissions. The benchmark enables these options explicitly.

Add `--reconstruction-trials` to the same benchmark command to compare the daily-then-deep median with mask-aware Drizzle. Drizzle combines the detector pixels directly using the overlap of each shrunken pixel with the output grid, with a drop width of 0.8 native pixel. It runs on the same 49 × 49 grid and on a 98 × 98 grid at half the pixel spacing. Only the same-grid comparison uses identical peak and sky sample locations. The benchmark injects one calibrated ePSF at a fixed offset and measures recovery in a three-native-pixel aperture. It also reports the scatter across eight off-target apertures, which can include real field sources.

The same option fits the calibrated ePSF and a local sky plane to each exposure’s unmasked native pixels using the archive variance. It reports the median amplitude across exposures and the scatter of fits at off-target positions. The native amplitude contrast is a separate statistic from image peak contrast. The synthetic native fit uses the same ePSF for injection and recovery, which checks the measurement path without testing ePSF model accuracy.

| D2 field | Exposures | Median baseline | Same-grid Drizzle | Half-pixel Drizzle |
| --- | ---: | ---: | ---: | ---: |
| Barnard’s Star | 36 | 17,210 | 15,873 | 16,676 |
| RW Aurigae | 21 | 10,949 | 9,894 | 13,368 |

At matched pixel scale, Drizzle lowered peak contrast by 7.8% and 9.6%, respectively. Aperture recovery of the injected source was 98.4%–99.0% for Drizzle and 99.2%–99.7% for the median. The half-pixel RW Aurigae image gave a higher peak score on its finer grid, while the off-target aperture scatter rose from 2.73 to 2.80 in native-pixel sum units.

Barnard’s Star occupied 15 of 16 subpixel phase bins, with no valid nearest detector pixel at the predicted center. The native fit used stellar wings in nine exposures. RW Aurigae had 20 valid nearest detector pixels and 21 usable native fits. Its native fit uses the [SIMBAD source position](https://simbad.cds.unistra.fr/simbad/sim-id?Ident=RW+Aur), about 10 arcseconds from the historical image grid center.

## Moving-target pipeline

Open **Track moving object**, enter a known comet or asteroid designation and a UTC date range, then select and load exposures from one detector. IRSA MOST supplies candidates and JPL Horizons supplies astrometric positions as seen from SPHEREx. The worker verifies FITS timing and coverage and reports the local wavelength and estimated smear. The timeline combines exposures by UTC day. Choose the wavelength range before building the tracked median. The download includes the orbit solution, exposure products, exclusions, pixel arrays, and contribution counts.

**Enhanced contrast** checks for independent reference exposures within 30 days on either side of each science exposure, then tries wavelength-matched exposures from other UTC days with the moving object masked. An enhanced pixel needs at least two usable references. Use the tracked image to inspect areas that lack enhancement coverage. The enhanced result reports aperture contrast and synthetic core and outer recovery. These diagnostics are for evaluating the visualization and do not calibrate flux. Loading supports 80 exposures, and enhancement supports 24 per stack.

Live validation on 2026-11-06 found 20 D1 candidates for 3I/ATLAS (August 10–15, 2025) and eight D2 candidates for 4 Vesta (July 2025). The six selected 3I/ATLAS benchmark observations, re-centered with live Horizons solution JPL#55, scored 24.31 for the tracked median and 37.39 for enhanced contrast. The enhanced view covered 84.3% of the grid and recovered 79.6% of the injected diffuse outer coma. The live run uses different positions and reference selection from the pinned comparison below.

The moving-target benchmark also runs from the command line:

```powershell
node scripts/benchmark-moving-stack.mjs --manifest manifest.json stack-products.json
node scripts/export-comet-benchmark.mjs frontend/tests/fixtures/comet-august-d1.json --check
```

The manifest contains an `ephemeris` array of spacecraft-relative `{mjd, ra, dec}` points in chronological order and a `cases` array. Each case has a `name` and `exposures` for one epoch and wavelength bin. Supply each exposure's IRSA Level 2 `url`, start `mjd`, and `detector`. Include `endMjd` or `exposureSeconds` when the archive header lacks duration. A case can supply `referenceExposures` explicitly, with `cometFree: true` on independent sky exposures. Otherwise the pipeline builds references from the other exposures in the case, masking their comet positions and checking the reference wavelength at the science position.

The three stages report a tracked UTC-day median, the same median after stationary sky subtraction, and a clipped inverse-variance coadd of the cleaned exposures. Reference subtraction requires two usable reference samples per pixel. The benchmark injects compact, diffuse and elongated profiles into detector pixels before projecting both science exposures and reused references. It reports flux recovery by radial zone and aperture contrast against offset apertures. Its output JSON includes the exposure manifest, image arrays, contributor counts, and the weighted stack's nominal variance. Correlated noise from reprojection and shared references is not represented by that variance, so the benchmark measures scatter empirically.

The native-pixel benchmark reads the same manifest or the JSON output of the stack benchmark.

```powershell
node scripts/benchmark-comet-fit.mjs stack-products.json
node scripts/benchmark-comet-fit.mjs --official-co2
```

The fit uses the published SPHEREx ePSFs, excludes masked detector pixels, and fits a compact source and an extended coma with a separate background plane and field-source amplitudes per exposure. The benchmark uses bright field peaks as candidate stars. The spectral mode fits the August and December campaigns separately, using five nearby D5 exposures per campaign, calibrated detector-pixel `CWAVE` and `CBAND`, and published D5 transmission curves. The CO₂ template uses a Gaussian centered at 4.26 µm and a locally flat continuum. It reports template amplitudes and empirical offset-track contrast. The outputs are benchmark measurements, with no conversion to integrated physical flux or production rate.

### Current choice and follow-up

Keep the **star-subtracted median for viewing** and the **native-pixel fit for measuring**. On the six-exposure August D1 benchmark, the star-subtracted median gave the highest aperture contrast (19.97), while the native fit recovered 99.5% of the injected diffuse core and 100.2% of the injected outer coma. That recovery applies to the tested profile. Variance weighting remains experimental.

- [ ] **Validate integrated CO₂ flux first.** Inject line profiles with different widths and the same integrated flux. Measure recovered flux bias and uncertainty for each campaign separately.
- [ ] **Test sensitivity to coma shape and visit selection.** Inject asymmetric tails, flat-topped cores, and different radial slopes. Measure aperture and radial-profile recovery with the same offset-track controls, then repeat with one visit held out at a time.
- [ ] **Test independent comet-free sky references.** Match their wavelength response and PSF to the science exposures, then compare contrast and outer-coma recovery against the current reference subtraction. Widening the reference mask in the D1 benchmark improved outer-coma recovery from 58% to 79% while lowering aperture contrast from 19.97 to 12.73.

## Contribution record and exports

Open **Frame contribution record** under the timeline metadata. It lists the UTC period, source observation IDs, combination method, how many exposures loaded, total exposure time, valid input-pixel contributions, and output pixels with data. A contributor can be marked as a fetch failure. The image caption summarizes the stack; **Export frame contributions CSV** writes one row per source exposure with its observation/product IDs, release and processing version, start time, exposure seconds, stack status, and valid output pixels. **PNG** includes a caption, stack summary, and the contributing observation IDs.

For a single inspected stack pixel, the viewer also reports how many input exposures contributed at that output pixel. Quality inspection uses a representative underlying exposure's FLAGS information while it reports the displayed median value separately.

## Files

- `frontend/timelapse-core.js` — chronological grouping, UTC-day period metadata, release provenance, and exposure totals.
- `frontend/lib/stack.js` — pure per-pixel median and contribution-count operation.
- `frontend/fits-viewer.js` — cutout loading, quality-aware projection, daily/deep stacking, contributor records, PNG export, and pixel counts.
- `frontend/timelapse.js` — frame-level provenance display and CSV export.
- `frontend/app.js` and `frontend/index.html` — same-day option and deep-stack frame cap controls.
- `frontend/tests/stack.test.js` and `frontend/tests/timelapse.test.js` — invalid-sample exclusion, median behavior, UTC-day grouping, and exposure provenance.

## Verification

Run `npm test` from `frontend/`. The tests verify per-pixel median results with invalid samples excluded and confirm that calendar-day frames preserve observation IDs, exposure time, end time, and release information. The complete suite passed with 122 tests after implementation.
