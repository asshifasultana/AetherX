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

This is a fixed-sky stack. SphereX does not yet propagate a moving target's ephemeris or re-center each date on an object's predicted position, so the current deep stack does not make a moving object accumulate while background stars disappear.

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
