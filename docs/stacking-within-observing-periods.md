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

Choose **Deep stack** to build a second median across chronological UTC-day frames. Each day's quality-aware stack is aligned to the target's fixed sky position before the per-pixel median is calculated. **Maximum deep-stack frames** defaults to 80 and can be set from 4 to 400. When there are more available frames than the selected limit, the stack uses the earliest frames and reports how many later frames were excluded. Failed daily frames and failed source exposures are reported separately.

Exposures load through a shared four-job pool using S3 byte ranges, with serialized IRSA cutout fallback. The first completed daily frame appears immediately. Subsequent deep-stack previews include complete daily frames only and refresh at most once per second between batches. Preview progress reports days, loaded exposures, and failed exposures; PNG exports become available after the final median. Completion order does not change contributor ordering. No additional exposure cap is applied. Memory preflight may require a smaller field or a lower explicit frame limit before downloading.

This is a fixed-sky stack. SphereX does not yet propagate a moving target's ephemeris or re-center each date on an object's predicted position, so the current deep stack does not make a moving object accumulate while background stars disappear.

## Moving-target pipeline

The browser viewer uses the fixed-sky stack above. The moving-target pipeline runs separately from the command line:

```powershell
node scripts/benchmark-moving-stack.mjs --manifest manifest.json stack-products.json
node scripts/benchmark-moving-stack.mjs --compare path/to/spherex-timelapse stack-products.json
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
