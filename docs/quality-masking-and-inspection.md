# SPHEREx quality masking and pixel inspection

This page documents the quality masking and inspection milestone in SphereX. The feature reads the image's SPHEREx `FLAGS` plane, excludes configured unreliable samples from rendering, and lets a user inspect a sky position across cutouts already loaded for the selected target and observation frame.

## What users can do

- **Hide unreliable pixels** is on by default. Masking happens before interpolation onto the north-up sky grid.
- **Reject isolated same-observation glitches** is on by default. A user can turn it off.
- **Show quality flags** displays the flag categories over the image with a legend. Hovering reports the pixel coordinates, value, and available flag names.
- **Inspect pixel quality** enables click inspection. Keyboard users can focus the image and use the arrow keys to move the inspected pixel.
- The inspection result reports the pixel state, FITS value and unit, named flag reasons, sky coordinates, and counts of valid, masked, missing, uncovered, unassessed, and rejected samples among the downloaded cutouts.

The interface distinguishes a low measured value from missing data and from a position outside the detector. Missing and uncovered samples are excluded from valid contributions, so neither is represented as a zero-valued/fading measurement.

## FITS flags and decoding

`frontend/fits-viewer.js` reads the science image and the matching `FLAGS` image. It supports an ordinary 32-bit `FLAGS` image HDU and the row-tiled `RICE_1` compressed image table layout used by the supported SPHEREx products (`ZBITPIX=32`, one row per tile). The compressed table's heap descriptors are bounds-checked before each tile is decoded.

`frontend/lib/rice.js` implements the 32-bit `RICE_1` decoder. Tests compare decoded values bit-for-bit against the expected values in `frontend/tests/fixtures/spherex-rice-astropy.json`, a fixture based on a real SPHEREx flag tile and Astropy output. Truncated and malformed tiles fail with an error instead of being treated as valid flags.

Flag names, descriptions, categories, and default masking policy live in `frontend/lib/pixel-quality.js`. Categories are transient/outlier, detector defect, correction/persistence, optical/electronic artifact, caution/informational, missing data, and outside coverage. The default mask excludes transient/error, defective, missing, persistence/correction, crosstalk, and artifact bits. Overflow, nonlinear response, known-source, and streak indicators remain visible; this avoids automatically erasing bright source cores or moving-source candidates. Unrecognized set bits are surfaced and conservatively excluded when masking is enabled.

`MISSING_DATA` is explicitly classified as missing. A non-finite science value is also missing. A sky point outside the image footprint is classified as outside coverage. If a science value exists but the FITS product has no usable flags plane, it is marked unassessed rather than assumed clean.

## Same-observation glitch check

When a user inspects a pixel and glitch rejection is enabled, the viewer loads up to 12 cutouts from the current frame for the selected detector if they are not already decoded. Cached and newly fetched cutouts are then sampled at the same sky coordinate. The browser estimates a local background-subtracted signal and noise for each sample and sends them to the API with the FITS `OBSID` as the visit identifier.

`detectSingleExposureGlitches()` only compares usable samples that share the same `OBSID`. It requires at least three samples and rejects exactly one isolated signal that exceeds both a robust median/MAD threshold and the noise floor. It does not compare different observations/dates, which helps avoid treating real long-term variability as a glitch. Rejected samples are marked in the viewer, omitted from rendered contributions, and counted separately.

The contributor counts describe **downloaded cutouts that match the active target, field of view, and detector**. They are not a count of every archive observation or all exposures in the sky. If a full same-visit group is unavailable, the result is based on the cutouts currently available after the bounded warm-up attempt.

## Backend API

The shared rules are in `frontend/lib/pixel-quality.js`; the request handler is `frontend/api/pixel-quality.js`.

- `GET /api/pixel-quality` returns `maskedFlagBits` and the named flag definitions for clients.
- `POST /api/pixel-quality` assesses one pixel and optionally checks up to 256 supplied exposure samples. The viewer currently warms at most 12 cutouts for an interactive inspection.
- The handler validates flag values as unsigned 32-bit integers, finite values/noise, coverage and availability booleans, sample count, active sample index, and request size. It returns a state/label, set flag reasons, glitch indices, exclusion state, and exposure contribution counts.
- The route is wired in `frontend/server.mjs` for local development and `frontend/vercel.json` for deployment.

Example request shape:

```json
{
  "covered": true,
  "value": 12.5,
  "flags": 0,
  "flagsAvailable": true,
  "maskEnabled": true,
  "detectGlitches": true,
  "activeSampleIndex": 0,
  "samples": [
    {
      "covered": true,
      "value": 12.5,
      "flags": 0,
      "flagsAvailable": true,
      "visitId": "SPHEREX_OBSID",
      "signal": 1.25,
      "noise": 0.04
    }
  ]
}
```

The response's `state` is one of `valid`, `masked`, `missing_data`, `outside_coverage`, `unassessed`, `flagged_included`, or `suspected_transient`.

## Files

- `frontend/lib/pixel-quality.js` — flag catalog, mask policy, status classification, glitch logic, and contribution counts.
- `frontend/lib/rice.js` — 32-bit RICE_1 tile decoder.
- `frontend/fits-viewer.js` — FITS flag extraction, masked rendering, overlay, hover, keyboard/click inspection, and sample gathering.
- `frontend/api/pixel-quality.js` — validation and server-side assessment endpoint.
- `frontend/index.html` and `frontend/styles.css` — controls, legend, and inspection presentation.
- `frontend/tests/pixel-quality.test.js`, `frontend/tests/rice.test.js`, and `frontend/tests/fixtures/spherex-rice-astropy.json` — policy, API, glitch, and Rice fixture coverage.

## Verify locally

From `frontend/`:

```sh
npm test
```

The test suite covers pixel-state distinctions, valid-contribution counts, same-OBSID outlier rejection, API validation, Rice decoding against the Astropy fixture, malformed Rice input, and server route exposure. During implementation, all 116 tests passed.

To use the interface, run `npm run dev` from `frontend/`, open the local HTTP page, retrieve a cutout, enable **Show quality flags** to see the overlay, and enable **Inspect pixel quality** to click or keyboard-inspect a pixel. The selected cutout must have a usable `FLAGS` plane to report SPHEREx flag reasons.

## Scope and limitations

- The glitch check is **interactive and per inspected sky pixel**. It is not a full-field transient scan, a background job, or a separate results list with a “Glitches” filter.
- The check only has the exposures that can be fetched for the current target/frame/detector, and it limits prefetching to 12 cutouts. A missing exposure is not inferred to be a transient.
- The current display contribution counts summarize those downloaded cutouts; they do not yet provide an archive-wide per-pixel exposure map.
- The feature exposes the FITS quality flags and a conservative display mask. It does not alter archive FITS files or replace scientific validation/calibration.
