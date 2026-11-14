# Background and release calibration handling

This note records what the current SphereX viewer does when comparing cutouts, what its release labels mean, and which calibration-dependent comparisons are still out of scope.

## Per-frame background estimate

`frontend/fits-viewer.js` estimates a separate display background for each FITS cutout. `frontend/lib/background.js` computes a median, estimates scatter with the median absolute deviation (MAD), and iteratively clips values more than 3 robust sigma from the median. The returned background level is subtracted from valid pixel values before display stretching. FITS values remain unchanged; pixel inspection still reads the delivered image values.

The estimate uses the valid pixels in the retrieved cutout, excluding masked pixels when the quality mask is on. Sigma clipping limits the influence of isolated bright pixels. It is not a spatial background model: crowded stars, extended emission, or a gradient across a small cutout can bias the baseline. The UI states this limitation.

## Shared display scale

With **Consistent brightness** on, SphereX uses one low/high display range for frame comparisons. The first frame rendered after the target, detector, field size, or consistency setting changes establishes that range; subsequent frames use it. This prevents automatic per-frame rescaling from making a steady source appear to vary. The selected stretch (asinh, linear, log, or square root), colour map, contrast, and inversion are display transforms, not flux calibration.

This scale is a visualization aid, not a calibrated photometric comparison. Frames from different releases may have processing or calibration offsets; the app warns about mixed releases but does not apply a release-to-release correction.

## Release provenance and warning

Archive products already carry `release`, `collection`, and `processingVersion`. Timeline frames preserve this provenance. The current frame metadata and image caption show the release and processing version. Same-day combined frames summarize all releases represented in that group. If the search spans more than one release, a notice names them and says that cross-release calibration offsets are not corrected. This notice deliberately avoids asserting that QR2 and QR3 are photometrically interchangeable.

For a release-controlled comparison, use the archive **release** filter (QR2 only or QR3 only) before searching. The metadata table also shows the archive release and processing version for each product.

## Important limits of this milestone

- The viewer's **Difference** mode control is not yet a calibrated per-date-minus-median product. Do not interpret it as a computed difference image until that implementation is added.
- **Correct for filter colour** is not currently implemented. A defensible correction needs the wavelength at the inspected detector pixel and a source-specific spectrum or an explicit spectral assumption. Applying a universal correction to whole images would manufacture brightness changes for sources with different spectra.
- Observation-table wavelength bounds describe the detector image. They are not a per-pixel wavelength measurement. `WCS-WAVE` lookup-table decoding and per-pixel wavelengths are not yet integrated into this FITS cutout viewer; no spectrum is generated from those cutouts.
- The robust cutout median removes a scalar pedestal, not zodiacal-light gradients or extended astrophysical structure. It is for display stabilization only and does not alter source photometry.

## Verification

`frontend/tests/background.test.js` checks bright-source resistance and empty-data behavior. `frontend/tests/timelapse.test.js` checks release provenance in individual and combined frames. Run `npm test` from `frontend/`; all 119 tests passed after these changes.
