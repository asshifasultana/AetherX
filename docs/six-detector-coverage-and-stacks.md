# Six detector coverage and median views

The observation results summarize archive products separately for D1–D6. Each detector card shows the number of products currently loaded, the combined product wavelength bounds, and the first and last observation dates. These are product-level bounds and dates; they do not imply continuous coverage between endpoints or an exact wavelength at the target pixel.

When the search is filtered to one detector, other cards say **Not searched** and offer a direct search for that detector. A searched detector with zero products says **No coverage in this search**. If the archive has another result page, the cards explicitly say their counts describe loaded products so far; use **Load more observations** to update them.

For a detector with coverage, **Build Dn median view** switches the viewer to that detector and builds the existing quality-aware deep median from its aligned UTC-day frames. Detector bands remain separate: D1–D6 are not averaged together. The stack uses the configured maximum UTC-day frame count, excludes masked, missing, and uncovered pixels from each pixel's median, and reports skipped products or frames excluded by the cap in the viewer status. The contributor export retains the exposure provenance.

This view does not claim complete temporal coverage when the result list is paginated, nor does a date span imply there were observations on every date in between.

## Six-detector view and false-colour composite

**Compare all six detectors ↗** (above the detector cards), or the view mode **Six detectors · compare colours**, shows a deep median stack of every detector side by side. It also shows a false-colour composite of three of them.

**Shared sky grid.** Every aligned exposure is projected onto one north-up grid. That grid depends only on the target and the field of view (`skyGrid` in `frontend/lib/fits-engine.js`), not on the detector. Pixel (x, y) is therefore the same sky in all six panels.

**Linked cursor.** Hovering any panel puts a crosshair on the same pixel in all seven images. The readout lists RA/Dec and the stacked value in each of D1–D6.

**Building.** Stacks are built one detector at a time with the same code as the single-detector deep stack (`buildDetectorStack` in `frontend/fits-viewer.js`).
- Each panel fills in as days arrive: first one daily frame, then a restack at most once a second.
- The composite's three detectors are built first.
- Downloads never overlap between detectors, and all detectors share one frame cache, so building them in parallel would only make them evict each other.
- The **Deep stack frames** limit (Processing › Advanced) applies per detector. A panel says when it used fewer days than were available.

**Scaling.** Each panel is scaled on its own, because the sky is much brighter at 1 μm than at 5 μm. Manual scale limits fall back to noise-based limits here.

**Composite colours.** In the composite, each channel's black point sits at its sky median, so the background is neutral. Longer wavelengths are redder. The defaults are R = D6, G = D4 and B = D2, and any three detectors can be chosen. A source bright in D4–D6 but faint in D1–D2 is cold or dusty. A blue one is hot.

**What causes a repaint or a rebuild.**
- Stretch, colours, contrast and core-fill changes repaint from the stored stacks.
- Processing changes rebuild: mask, background, statistic, field of view, exposures per day and frame limit.

**Panel actions.** **Open ↗** shows that detector's deep stack in the main viewer. **PNG ↓** downloads the composite once its three detectors are finished.
