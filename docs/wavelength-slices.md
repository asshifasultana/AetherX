# Wavelength slices and line maps

SPHEREx sees a given sky position at a different wavelength on each visit, because the position lands at a different place on the detector's linear-variable filters. Once each exposure's wavelength at the target is known, the viewer can do three things:
- order the time-lapse by wavelength instead of date
- stack any wavelength window
- subtract the continuum around a spectral feature

## Finding the wavelengths

Choose **Order › by wavelength** in the time-lapse heading. For every loaded exposure, `frontend/lib/target-wavelengths.js` makes two small S3 range reads and downloads no pixels:
- the IMAGE header, for its WCS (about 35 KB)
- the WCS-WAVE table at the end of the file (about 11.5 KB)

The WCS puts the target on a detector pixel, and the table gives the wavelength there. Results are cached per exposure and position for the session. A proper-motion target uses its position at each exposure's date.

**Measured speed.** These are distinct exposures from the Barnard's Star preset, timed with `node scripts/benchmark-wavelength-lookup.mjs barnard 120`:

| Concurrency | 120 exposures | Rate |
|---|---|---|
| 4 | 21.6 s | 5.5 /s |
| 8 | 11.3 s | 10.6 /s |
| 16 | 8.2 s (1 failure) | 14.6 /s |

The browser opens about six connections to S3 at a time, so the viewer runs six lookups in parallel. In the browser, all 363 Barnard's Star exposures were resolved in under 30 s.

## Wavelength slices

Each slice holds the exposures that saw the target inside one of the 102 channels (`buildWavelengthFrames` in `frontend/timelapse-core.js`). It is stacked exactly like a daily frame.

- **Controls.** The slider, play, step and filmstrip work as before. The slider is spaced by wavelength, so the gaps between detectors show.
- **Labels.** Labels read like *3.305 μm · D4 ch 12 · 3 exposures · at field centre*.
- **Detectors.** Slices cross detectors. Showing one syncs the detector band without rebuilding the sequence. Masked-core fill uses the PSF of the frame's own detector.
- **Reset.** A new search or target returns to date order.

**Field-centre caveat.** The wavelength is the one at the target, i.e. the field centre. Across a 10′ field it shifts by roughly one channel, so a slice is exact only at the centre. Labels and captions say "at field centre".

## Window stack

**Stack a window** combines every exposure that saw the target between two wavelengths, for example 3.20–3.40 μm. A window that spans two detectors uses both, since they share the sky grid. **Exposures per day** (Processing › Advanced) caps how many exposures one stack downloads, and the caption says when a stack was sampled.

## Line maps

**Line map** builds two things:
- a stack inside the feature window
- the mean of two equal-width continuum windows touching it on either side (`lineMapWindows` in `frontend/wavelength-slices.js`)

It then shows *feature − continuum* as a difference image in units of the noise, with no large-scale flattening (`showLineMap` in `frontend/fits-viewer.js`). Orange is brighter at the feature, as in emission; blue is fainter, as in absorption. Presets cover H₂O ice 3.0 μm, CH₄/PAH 3.3 μm and CO₂ 4.26 μm.

**What to read into it.**
- Stars leave orange and blue residuals wherever their brightness changes across the windows.
- Diffuse glow that is orange throughout is the signal to look for.
- Per-exposure background subtraction can remove diffuse emission. The caption says when it is on.
