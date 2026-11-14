# Six detector coverage and median views

The observation results summarize archive products separately for D1–D6. Each detector card shows the number of products currently loaded, the combined product wavelength bounds, and the first and last observation dates. These are product-level bounds and dates; they do not imply continuous coverage between endpoints or an exact wavelength at the target pixel.

When the search is filtered to one detector, other cards say **Not searched** and offer a direct search for that detector. A searched detector with zero products says **No coverage in this search**. If the archive has another result page, the cards explicitly say their counts describe loaded products so far; use **Load more observations** to update them.

For a detector with coverage, **Build Dn median view** switches the viewer to that detector and builds the existing quality-aware deep median from its aligned UTC-day frames. Detector bands remain separate: D1–D6 are not averaged together. The stack uses the configured maximum UTC-day frame count, excludes masked, missing, and uncovered pixels from each pixel's median, and reports skipped products or frames excluded by the cap in the viewer status. The contributor export retains the exposure provenance.

This view does not claim complete temporal coverage when the result list is paginated, nor does a date span imply there were observations on every date in between.
