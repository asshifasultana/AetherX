# Channel spectrum

The quick-look spectrum (Observations › *Explore this source across wavelengths and time*) measures the selected position in every loaded exposure. Each measurement uses the wavelength SPHEREx saw at that exact position in that exposure.

## 102 channels

Points are binned into SPHEREx's 102 channels: 17 per detector, spaced evenly in log wavelength (`DETECTOR_CHANNELS` in `frontend/lib/detectors.js`).
- **Channel edges.** Inner edges are the geometric midpoints between neighbouring channel centres. The outer edges are the band limits, with a 0.03 μm tolerance for the slight overlap of the real filters.
- **Square markers.** Each square is the median flux and median wavelength of the exposures in one channel (`binSpectrum` in `frontend/lib/spectrum-bins.js`).
- **Error bars.** The error bar is the standard error of the median: 1.2533 × 1.4826 × MAD / √n. With fewer than three points it is the combined error of the points themselves.
- **Colours.** Points and squares are coloured by detector (D1 violet to D6 red). The time view keeps the same colours.
- **Single exposures.** Faint dots are the individual exposures. **Show individual exposures** hides them. Clicking one opens its image.
- **Export.** **Channel spectrum CSV ↓** exports the channel medians, including how many points each channel used and how many it left out as saturated.

## Saturation flags

`measureAt` (`frontend/lib/photometry.js`) now reports, for each point, the aperture pixels carrying OVERFLOW (bit 1, near saturation) or NONLINEAR (bit 15). The default mask keeps these pixels so a bright star still shows, but a flux summed over them reads low. It also reports the share of the aperture lost to masked BLOOM (bit 26) or HALO (bit 28) pixels.

A point is **likely saturated** if it has any OVERFLOW or NONLINEAR aperture pixel, or if more than 30% of the aperture is lost to BLOOM or HALO pixels (`assessSaturation`).

These points are:
- drawn as hollow dashed circles
- counted in the status line
- left out of the channel medians, so a dip they cause is not read as an absorption feature

The AI guide's `get_spectrum` also leaves them out of its hints when at least three clean points remain, and says how many it dropped.

## Feature markers

Shaded bands mark three features worth checking:
- water ice, 2.9–3.1 μm
- the 3.3 μm methane / PAH band, 3.25–3.35 μm
- CO₂, 4.23–4.29 μm

They are guides to where to look, not detections.

## Limits

This is exploratory aperture photometry, not IRSA's PSF-fit spectrophotometry. Points in one channel can come from different dates, so a variable source spreads within a channel. Use the time view to check. The saturation rule is deliberately cautious: a faint source with one flagged neighbour pixel in its aperture is flagged too.

## Fix included

The chart's `<svg>` was shown and hidden through `svg.hidden`. SVG elements have no `hidden` property, so the attribute from the markup was never removed and the chart stayed invisible. It now toggles the attribute directly.
