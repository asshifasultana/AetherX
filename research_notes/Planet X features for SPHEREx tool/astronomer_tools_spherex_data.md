# Astronomer tools and techniques for faint moving-object searches, and SPHEREx data facts (as of 12 Nov 2026)

Notes on sourcing: items marked (†) come from the researcher's background knowledge of widely used tools. The URL given is the tool's canonical documentation page, but it was **not re-fetched in this session**. The report writer should treat (†) items as lower confidence than the others. Everything without (†) was read in a fetched page or search result during this session.

## 1. Moving-object detection techniques: which can run in a browser, and which work better as explanations

### Takeaway
The standard toolkit has six parts: blink comparison, difference imaging, shift-and-stack (digital tracking), tracklet linking (HelioLinC/THOR), orbit fitting (Find_Orb, OpenOrb, Bernstein–Khushalani) and injection-recovery tests. Blink, difference images, a small user-guided shift-and-stack and parallax/motion fitting are practical in a browser on cutouts. Full-sky KBMOD/THOR-style searches need GPUs or clusters and work better as explained concepts. SPHEREx's geometry has a useful property: a distant object is nearly stationary within one ~2-week visit, then jumps by a large parallax between visits 6 months apart. That makes "stack within a visit, blink across visits" the natural design.

### Cited Findings
- **Shift-and-stack / KBMOD.** KBMOD finds objects too faint to see in any single frame. It does not detect sources per image first. It shift-and-stacks over a grid of velocities without resampling the images — [Whidden et al. 2019, arXiv:1901.02492](https://arxiv.org/pdf/1901.02492).
- KBMOD searches about 10^10 candidate trajectories in a stack of 10–15 4K×4K images in under a minute on a consumer GPU. Instead of shifting pixels, it sums precomputed per-pixel likelihoods using pointer arithmetic. The 2019 paper reported 39 new KBOs — [Whidden et al. 2019](https://arxiv.org/pdf/1901.02492).
- Later KBMOD work replaced the Kalman filter with a quantile-based filter (Smotherman et al. 2021). The v1.0 release added CNN filtering of false positives and reported 105 new TNOs from DEEP data. The code is at github.com/dirac-institute/kbmod — [LINCC Frameworks KBMOD AAS abstract](https://ui.adsabs.harvard.edu/abs/2023AAS...24110507B/abstract); [DEEP VI](https://arxiv.org/pdf/2310.03678).
- The New Horizons Subaru TNO survey used KBMOD's GPU approach and cut stacking time from days per chip to hours — [arXiv:2407.21142](https://arxiv.org/pdf/2407.21142).
- **Nonlinear shift-and-stack.** "heliostack" (2026 preprint) enables nonlinear shift-and-stack by borrowing HelioLinC's heliocentric-frame idea — [arXiv:2604.16731](https://arxiv.org/pdf/2604.16731).
- **Tracklet linking.** HelioLinC moves detections into a heliocentric frame for an assumed distance. It propagates tracklets (pairs of detections) to a common epoch and clusters them, which brings linking down to O(N log N). Its tracklets can come from different observatories and from nights days to weeks apart — [Rubin/LSST linking docs](https://dp1.lsst.io/processing/moving/ss_linking.html); [arXiv:2309.15344](https://arxiv.org/pdf/2309.15344).
- THOR drops the need for intra-night tracklets. It transforms detections into frames that co-move with dynamically chosen heliocentric "test orbits". On ZTF it recovered 20,840 of 21,401 findable known objects (97.4%), but it is resource-intensive — [THOR, Moeyens et al. 2021](https://ar5iv.org/html/2105.01056).
- **Blink comparison at scale.** Backyard Worlds: Planet 9 volunteers inspect animated WISE/NEOWISE image sequences (flipbooks). The project describes itself as the most sensitive all-sky mid-IR search for a planet beyond Pluto. Its planning paper assumes W1 sensitivity of about 16.2 (Vega) — [Kuchner et al. 2017, arXiv:1705.02919](https://arxiv.org/pdf/1705.02919); [Zooniverse project](https://www.zooniverse.org/projects/marckuchner/backyard-worlds-planet-9).
- **Co-addition plus motion search for Planet Nine.** Meisner et al. searched about 3π sr at W1 (3.4 µm) using 4 years of WISE/NEOWISE data spanning 7 years. They rule out Planet Nine brighter than W1 = 16.7 (Vega, 90% completeness) at high Galactic latitude. The earlier 2,000 deg² search reached W1 = 16.66 — [Meisner et al. 2018, arXiv:1712.04950](https://ar5iv.arxiv.org/html/1712.04950).
- **Injection-recovery.** The Pan-STARRS1 Planet Nine search injected synthetic objects drawn from the Brown & Batygin orbit distribution. It quotes a 50% completeness depth of V = 21.5 and says that, combined with ZTF and DES, about 78% of the predicted parameter space is excluded. ZTF+DES alone excluded 61.2% and DES alone 10.2% — [Brown, Holman & Batygin 2024, arXiv:2401.17977](https://arxiv.org/abs/2401.17977).
- The remaining parameter space is mostly at V > 21, concentrated where the northern Galactic plane crosses the ecliptic — [arXiv:2401.17977](https://arxiv.org/abs/2401.17977).
- (†) Synthetic tracking (Shao et al. 2014, ApJ 782, 1) uses many short exposures, shifted and added along trial velocities. It is the short-exposure, fast-mover cousin of digital tracking — [ADS](https://ui.adsabs.harvard.edu/abs/2014ApJ...782....1S).
- (†) Bernstein & Khushalani (2000, AJ 120, 3323) give an orbit parametrization suited to short arcs of distant objects, where motion is dominated by parallax. Their `fit_radec` code is widely used for TNOs — [ADS](https://ui.adsabs.harvard.edu/abs/2000AJ....120.3323B).
- (†) Find_Orb (Bill Gray) fits orbits to MPC-format or ADES astrometry, with an online version at projectpluto.com/fo.htm. OpenOrb (Granvik et al. 2009) offers statistical ranging for very short arcs — [Find_Orb](https://www.projectpluto.com/find_orb.htm); [OpenOrb](https://github.com/oorb/oorb).

### Inferences
- **Feasible in browser (on cutouts):**
  - Blink/flipbook across epochs with locked WCS and stretch.
  - Difference images (epoch B minus epoch A, after aligning on the WCS).
  - Per-visit channel co-add to reach deeper.
  - A small user-driven shift-and-stack: the user picks a distance or rate grid, and the tool stacks N cutouts along the predicted parallax+orbit path. That is a few thousand trajectories on 100×100 px stamps, fine in WebGL/WASM.
  - A parallax-plus-linear-motion fit for 2–4 epochs.
  - Injection-recovery: plant a fake PSF using the file's own PSF HDU and see whether the user or algorithm recovers it. This makes a strong teaching and credibility feature.
- **Better as explanation or animation:**
  - Full-sky KBMOD-style search, which needs a GPU, all data and a large trajectory grid.
  - HelioLinC/THOR linking across the whole catalog.
  - Full orbit determination. Hand off to Find_Orb or an MPC-format export instead.
- **SPHEREx-specific geometry** (derived from orbit facts in Section 4):
  - SPHEREx looks roughly 90° from the Sun, so each sky position is seen near quadrature, once in the "morning" and once in the "evening" sky, about 6 months apart.
  - Near quadrature a distant object is close to its stationary point. Its reflex motion within a ±7-day visit is second order: ≈ 1,500″/d[AU], or about 3″ (0.5 px) at 500 AU.
  - Between the two quadratures the baseline is the full Earth-orbit diameter (2 AU, perpendicular to the line of sight). The displacement is therefore about 412,530″/d[AU] (worked out in Section 6).
  - So the core loop is: co-add channels within a visit, then blink or shift-and-stack across visits, using a distance hypothesis.

### Gaps
- I found no published moving-object or Planet-Nine search that uses SPHEREx data (as of Nov 2026).
- I did not verify Holman et al.'s specific digital-tracking papers (e.g., the 2004 Neptune irregular moons) in this session.

## 2. Existing web and desktop tools: features worth copying and cross-checks for a candidate

### Takeaway
Users will expect four things:
- A WiseView-style blink.
- An Aladin-Lite/HiPS sky with catalog overlays.
- One-click cross-matches against Gaia, CatWISE/AllWISE/unWISE, 2MASS and known solar-system objects (MPChecker, Horizons, JPL SB-Ident).
- Exports to DS9 regions or MPC format.

IRSA already offers SPHEREx-specific services a web app can call or link to: SIA, TAP, a cutout service, a spectrophotometry tool, a mosaic tool, a source discovery notebook, and MOST for precovery of known moving objects in SPHEREx images.

### Cited Findings
- **IRSA SPHEREx Data Explorer** offers:
  - Spectrophotometry Tool (forced-photometry spectra from spectral images)
  - Mosaic Tool
  - Cutout Tool
  - Source Discovery Tool (notebook)
  - Moving Object Search Tool (MOST)

  Sources: [IRSA SPHEREx mission page](https://irsa.ipac.caltech.edu/Missions/spherex.html); [Source Discovery Tool demo](https://caltech-ipac.github.io/irsa-tutorials/spherex-source-discovery-tool-demo/).
- The Mosaic Tool displays a HiPS image across most of the browser. Its output pixel size can go down to 6.15″ (native SPHEREx), with a 9″ default — [IRSA Mosaic help](https://irsa.ipac.caltech.edu/onlinehelp/spherex/spherex/mosaic.html).
- **IRSA MOST** computes an orbit-based ephemeris and returns the images that cover a solar-system object's predicted positions. It works as a "precovery" tool.
  - Datasets: SPHEREx, 2MASS, Spitzer, PTF, SOFIA, ZTF, WISE/NEOWISE (including yearly NEOWISE releases yr1–yr11).
  - Inputs: object name or NAIF ID, MPC one-line elements, or manual elements (epoch MJD, e, i, ω, Ω, plus a and M, or q and Tp). Also a time window and step size.
  - Outputs: Regular, Full, Brief, VOTable or Gator tables, plus optional FITS and DS9 region tarballs.

  Source: [IRSA MOST](https://irsa.ipac.caltech.edu/applications/MOST).
- **JPL Horizons API:** `https://ssd.jpl.nasa.gov/api/horizons.api` (v1.3, June 2025), GET with `COMMAND`, `EPHEM_TYPE` (OBSERVER/VECTORS/ELEMENTS/SPK/APPROACH), `CENTER` (site name, IAU code, `coord`, `geo`), `START_TIME`, `STOP_TIME`, `STEP_SIZE`, `QUANTITIES` and `format=json`. Semicolons must be encoded as `%3B` (e.g., `1%3B` for Ceres). The doc does not mention CORS — [Horizons API doc](https://ssd-api.jpl.nasa.gov/doc/horizons.html).
- **CDS HiPS:** CDS lists SPHEREx HiPS collections (e.g., `https://alasky.cds.unistra.fr/SPHEREx/D1`, plus D2 and D3) under ODbL by Unistra/CNRS. These can be loaded directly in Aladin Lite — [b2find D1](https://b2find.eudat.eu/dataset/c4555b63-9303-5fb9-b115-5a83e04ef04e); [D2](https://b2find.eudat.eu/dataset/2509d333-b10f-56bb-9709-1272d2fc71c0); [D3](https://b2find.eudat.eu/dataset/2c4bc2a8-e045-5485-84db-fb8e1a42ae02).
- **WiseView** is a community-built, web-based animation tool used by Backyard Worlds volunteers to blink WISE epochs — [Wikipedia: Backyard Worlds](https://en.wikipedia.org/wiki/Backyard_Worlds).
- (†) **WiseView** (byw.tools/wiseview) features to copy:
  - Blinks unWISE time-resolved coadds in W1, W2 or W1+W2.
  - Sliders for speed, zoom and min/max stretch.
  - Epoch selection and a difference mode.
  - Links out to Legacy Survey and SIMBAD.
  - A permalink URL encodes RA/Dec and settings, which makes candidates easy to share.

  Source: [WiseView](http://byw.tools/wiseview).
- (†) **Aladin Lite v3** (CDS) features:
  - WebGL HiPS rendering with HiPS FITS tiles and user-set stretch/colormap.
  - Overlay of VizieR/SIMBAD catalogs, MOCs and footprints.
  - Display of FITS images.
  - JS API: `A.init`, `A.aladin(...)`, `A.catalogFromVizieR`, `aladin.setImageSurvey`/`newImageSurvey`.

  Source: [Aladin Lite](https://aladin.cds.unistra.fr/AladinLite/). The doc URL tried in this session returned 404.
- (†) **ESASky** (sky.esa.int) has multi-mission image and catalog access plus a solar-system-object mode. That mode overlays an SSO's track and finds observations covering it — [ESASky](https://sky.esa.int).
- (†) **Legacy Survey Viewer** (legacysurvey.org/viewer) has layers for DECaLS/DR10 and unWISE (including time-resolved "neo" epochs). It also overlays catalogs such as Gaia and Tractor sources, with a shareable URL state — [Legacy Survey Viewer](https://www.legacysurvey.org/viewer).
- (†) **IRSA Finder Chart** returns multi-survey cutouts at one position: DSS, SDSS, 2MASS, WISE and PS1, with epochs and catalog overlays. It is a standard way to see a field across ~70 years — [Finder Chart](https://irsa.ipac.caltech.edu/applications/finderchart/).
- (†) **SAOImage DS9** can blink and tile frames, lock frames by WCS, use region files and catalog tools, and set scale/colormap. **JS9** (js9.si.edu) is a browser DS9-like viewer: it reads FITS through WebAssembly cfitsio and supports regions, blink, WCS and plugins — [DS9](https://sites.google.com/cfa.harvard.edu/saoimageds9); [JS9](https://js9.si.edu).
- (†) **Astrometry.net** does blind plate solving and has a web API (nova.astrometry.net). It matters mainly for amateur images; SPHEREx files already carry WCS+SIP — [Astrometry.net](https://nova.astrometry.net).
- (†) **Minor Planet Center:** MPChecker identifies known objects near a given RA/Dec/time/observatory code. NEOCP lists unconfirmed NEO candidates. MPES provides ephemerides. Submissions use the 80-column or ADES format with an observatory code. The MPChecker page could not be fetched this session (connection refused) — [MPC](https://www.minorplanetcenter.net).
- (†) **JPL SB-Ident API** lists known small bodies in a field at a given time and observer location — [SB-Ident](https://ssd-api.jpl.nasa.gov/doc/sb_ident.html).
- (†) **Stellarium** is planetarium software (desktop and web). It is useful for context and outreach, not for measurement — [Stellarium](https://stellarium.org).

### Inferences
- Minimum "astronomer-grade" cross-check panel for a candidate position and epoch:
  1. Gaia DR3: stationary star? proper motion and parallax?
  2. CatWISE2020/AllWISE/unWISE (unTimely): W1/W2 detection and W1−W2 color.
  3. 2MASS J/H/Ks.
  4. Legacy Survey (optical) for background galaxies.
  5. SIMBAD/VizieR for known variables and objects.
  6. Known SSOs via Horizons or SB-Ident for the image's epoch. SPHEREx is in low Earth orbit, so a geocentric ephemeris (`CENTER=500`) is accurate to well under a pixel for distant objects. The parallax from SPHEREx's 7,037-km orbit is about 0.02″ at 500 AU.
  7. IRSA MOST to check whether a known object crossed the field in SPHEREx data.
- Feature borrowing:
  - From WiseView: URL permalinks and fast blink controls.
  - From Aladin Lite: HiPS context and catalog overlays.
  - From DS9: region export.
  - From Find_Orb and the MPC: an 80-column/ADES export.

### Gaps
- Whether IRSA SIA/TAP/cutout and CDS HiPS endpoints send CORS headers that allow direct browser fetches was not confirmed. Plan for a small proxy.
- I could not confirm whether SPHEREx has an MPC observatory code, which matters for formatting MPC reports.
- I could not confirm the exact current feature list of WiseView or ESASky's SSO mode in this session.

## 3. Candidate vetting checklist and what a credible report contains

### Takeaway
Most "movers" in SPHEREx single exposures will be artifacts or known objects, so vetting has to be built into the tool:
- **Artifacts**, identified from the per-pixel FLAGS bitmask: transients/cosmic rays, hot pixels, persistence, crosstalk ghosts, nonlinearity, outliers.
- **Known sources and backgrounds:** SPHEREx-specific foregrounds (shuttle glow at 3 and 4.5 µm, stray-light halos, SAA particle hits) and known asteroids/comets.

A credible report gives:
- Positions with uncertainties at ≥2–3 epochs.
- Motion rate and direction consistent with parallax at some distance.
- Photometry or a spectrum with errors.
- Cutouts and flags, plus the cross-match results.

### Cited Findings
- **SPHEREx FLAGS bits** (int32 bitmap, header keywords `MP_*`):
  - 0 TRANSIENT (transient detected during sample-up-the-ramp)
  - 1 OVERFLOW
  - 2 SUR_ERROR
  - 4 PHANTOM
  - 5 REFERENCE
  - 6 NONFUNC (permanently unusable)
  - 7 DICHROIC (low efficiency)
  - 9 MISSING_DATA
  - 10 HOT
  - 11 COLD
  - 12 FULLSAMPLE
  - 14 PHANMISS (phantom correction not applied)
  - 15 NONLINEAR (correction not reliable)
  - 17 PERSIST (persistent charge above threshold)
  - 19 OUTLIER (flagged by Detect Outliers)
  - 21 SOURCE (mapped to a known source)

  Source: [IRSA SPHEREx intro tutorial](https://caltech-ipac.github.io/irsa-tutorials/spherex-intro/).
- Crosstalk artifacts come in three classes: type 1 (vertically displaced ghosts), type 2 (horizontally displaced ghosts) and type 3 (streaks). QR3 provides ECSV masking parameters per class and detector (`xtalk_class[N]_D[det]...ecsv`) — [SPHEREx Archive data products](https://caltech-ipac.github.io/spherex-archive-documentation/spherex-data-products/).
- QR3 adds per-detector templates for auroral lines (band 1), He emission (bands 1–2) and shuttle glow (band 5). It also adds nonfunctional-pixel maps and nonlinearity, read-noise and dark calibrations — [SPHEREx Archive data products](https://caltech-ipac.github.io/spherex-archive-documentation/spherex-data-products/).
- Mission-level systematics listed by Bock et al.:
  - Stray-light halos around bright sources.
  - Residual dark-current pattern.
  - Shuttle glow at 3 and 4.5 µm when pointing in the ram direction.
  - Energetic-particle transients, elevated in the South Atlantic Anomaly. Flagged images may be re-observed (1–3% on average).
  - PSF up to 6″ in band-3 corners and 5.5″ in the MWIR.
  - Distortion up to 0.5%.
  - Photometric accuracy targets of 3% overall and 2% channel-to-channel.

  Source: [Bock et al., arXiv:2511.02985](https://arxiv.org/html/2511.02985v2).
- The IMAGE HDU is **not** zodi-subtracted. A modeled ZODI HDU is supplied (Kelsall et al. 1998 model, with QR3 per-detector scaling factors) — [SPHEREx Archive data products](https://caltech-ipac.github.io/spherex-archive-documentation/spherex-data-products/).
- Products released before 31 Mar 2026 had a PSF-extension header error, corrected in QR2 headers in April 2026 — [IRSA SPHEREx page](https://irsa.ipac.caltech.edu/Missions/spherex.html); [psfhdrerr](https://irsatest.ipac.caltech.edu/data/SPHEREx/docs/psfhdrerr.html).
- Bock et al. expect about 100,000 asteroids with meaningful SPHEREx fluxes, about 10,000 of them with high-quality spectra. Known asteroids will therefore be common "movers", especially near the ecliptic — [Bock et al.](https://arxiv.org/html/2511.02985v2).
- SPHEREx observed interstellar comet 3I/ATLAS, and IRSA hosts dedicated spectral images of it — [IRSA SPHEREx page](https://irsa.ipac.caltech.edu/Missions/spherex.html).

### Inferences
- **Suggested vetting checklist for the UI** (one row per epoch detection):
  1. Any FLAGS bits 0/1/2/6/9/10/11/15/17/19 set within ~2 px? If so, mark the detection as an artifact.
  2. Seen in at least two independent exposures/channels within the same visit (rules out a cosmic ray)?
  3. Not at a crosstalk-ghost offset from a bright star? (Use the xtalk ECSV.)
  4. Not inside a stray-light halo or diffraction/saturation region of a bright star?
  5. No Gaia/CatWISE/2MASS source at that position (rules out a stationary star or galaxy). Check variable-star catalogs if flux changes but position doesn't.
  6. No known SSO there at that epoch (Horizons/SB-Ident/MPChecker; IRSA MOST).
  7. Positions across visits fit parallax plus slow orbital motion for a single distance d. The direction must match the ecliptic parallax ellipse; random directions are a red flag.
  8. Flux consistent across epochs within errors.
  9. Recovered by a co-add in at least one band; for spectra, check shuttle-glow and zodi residuals at 3.3 and 4.5 µm.
  10. Injection test at the same location shows a similar object would be detectable.
- **Report contents** (aligned with MPC practice and Backyard Worlds-style vetting):
  - Candidate ID.
  - RA/Dec (ICRS) per epoch with uncertainty and mid-exposure UTC/MJD.
  - SPHEREx OBSID, detector and channel/wavelength.
  - Motion rate (″/day) and position angle; implied distance range from the parallax fit.
  - Photometry (µJy/AB) per band with errors.
  - Cutout PNGs plus FITS stamps, and the flag summary.
  - Cross-match results with links.
  - Software version and data release (QR2/QR3 plus DOI).

### Gaps
- I did not obtain the full Explanatory Supplement (the PDF exceeded the fetch size limit), so ghost geometry, persistence timescales and saturation levels are not detailed here.

## 4. SPHEREx data specifics (dated, as of Nov 2026)

### Takeaway
- **Mission:** launched 11 Mar 2025 into a dawn–dusk Sun-synchronous orbit; looks about 90° from the Sun; maps the full sky about every 6 months (four surveys planned in two years).
- **Spectral sampling:** 102 channels from 0.75–5.0 µm (6 bands × 17 channels, R≈35–130) on ~6.15–6.2″ pixels.
- **Main products:** weekly Level-2 Quick Release spectral images (70 MB, 6-HDU MEF FITS: IMAGE/FLAGS/VARIANCE/ZODI/PSF/WCS-WAVE) from IRSA, via SIA, TAP, a cutout service, AWS S3 and CDS HiPS.
- **Releases:** QR3 began Sept 2026 and QR1 was retired Feb 2026.
- **For a web app:** use cutouts and HiPS, not full MEFs.

### Cited Findings
**Mission and survey**
- Launch: 11 March 2025. The orbit is Sun-synchronous at 97.951° inclination with a 6:00 AM mean local time of ascending node and a 7,037.4 km semi-major axis — [Bock et al. 2026 (ApJ 999, 139), arXiv:2511.02985](https://arxiv.org/html/2511.02985v2).
- The Sun is kept more than 93.5° from the photon-shield axis, and the boresight is tipped 8° toward the solar panels. The Moon must be more than 32° from the boresight during observing. Earth zenith angle must be below 45° — [Bock et al.](https://arxiv.org/html/2511.02985v2).
- The plan is four full-sky surveys over the 2-year baseline. Each sky position gets all channels within about two weeks per survey, and the full sky is covered about every 6 months — [Bock et al.](https://arxiv.org/html/2511.02985v2).
- Complete sky coverage was first reached in late 2025, per a map-making paper quoted in a search result (secondary) — [search result citing SPHEREx papers](https://arxiv.org/html/2603.25790v1).
- Deep fields: two ~100 deg² fields near the north and south ecliptic poles. The southern one sits at ecliptic latitude −82°, longitude −44.8°. They are observed nearly every orbit, with more than 400 observations per channel at center — [Bock et al.](https://arxiv.org/html/2511.02985v2).
- Exposures are 116.9 s. A typical pointing has 1–4 exposures, and each exposure yields 6 spectral images (one per detector). The field of view is 3.5° × 11.5° with a 20 cm effective aperture — [Bock et al.](https://arxiv.org/html/2511.02985v2).
- Observation IDs encode planning period plus large- and small-slew counters (e.g., `2025W18_2B_0001_1`). Planning periods last about 3.5 days, with up to 4 small slews per large slew — [SPHEREx Archive data products](https://caltech-ipac.github.io/spherex-archive-documentation/spherex-data-products/).

**Spectral and spatial sampling**
- There are 102 channels from 0.75–5.0 µm, R = 35–130, on 6.2″ pixels (Bock Table 1) — [Bock et al.](https://arxiv.org/html/2511.02985v2).
- The IRSA Mosaic Tool gives the native pixel as 6.15″ — [Mosaic help](https://irsa.ipac.caltech.edu/onlinehelp/spherex/spherex/mosaic.html).
- **Conflict:** IRSA tutorials and archive docs write "0.615 arcsec per spectral image pixel" in the PSF section — [intro tutorial](https://caltech-ipac.github.io/irsa-tutorials/spherex-intro/); [archive docs](https://caltech-ipac.github.io/spherex-archive-documentation/spherex-data-products/). This is almost certainly the scale of the **10×-oversampled PSF** pixel. 6.15″ is correct for image pixels.
- Band layout and resolving power:

  | Band | Range (µm) | R |
  |---|---|---|
  | 1 | 0.75–1.09 | 39 |
  | 2 | 1.10–1.62 | 41 |
  | 3 | 1.63–2.41 | 41 |
  | 4 | 2.42–3.82 | 35 |
  | 5 | 3.83–4.41 | 112 |
  | 6 | 4.42–5.00 | 128 |

  Each band corresponds to one detector, 2K×2K H2RG behind a linear variable filter. A dichroic splits light between two focal planes — [archive docs](https://caltech-ipac.github.io/spherex-archive-documentation/spherex-data-products/); [IRSA SPHEREx](https://irsa.ipac.caltech.edu/Missions/spherex.html).
- Wavelength varies across each detector, decreasing from bottom to top in the example. The per-pixel wavelength comes from an alternate WCS: `WCS(header=hdul["IMAGE"].header, fobj=hdul, key="W")` with `sip=None`. The WCS-WAVE table is accurate to about 1 nm with bilinear interpolation and is intended for visualization; the spectral-WCS calibration file's CWAVE/CBAND are for science — [intro tutorial](https://caltech-ipac.github.io/irsa-tutorials/spherex-intro/); [archive docs](https://caltech-ipac.github.io/spherex-archive-documentation/spherex-data-products/).

**Sensitivity**
- All-sky 5σ point-source depth after two years, per channel (AB):
  - 19.5–19.9 for 0.75–3.8 µm (R≈40)
  - 17.8–18.8 for 3.8–5.0 µm (R≈120)
  - In-flight median 19.7
  - Requirement: 18.4 for bands 1–4

  Source: [Bock et al.](https://arxiv.org/html/2511.02985v2).
- The pre-launch simulation estimate was m_AB ≈ 18.5–19 (secondary snippet) — [search result](https://arxiv.org/html/2603.25790v1).

**Data products and releases (IRSA)**
- Release timeline:
  - QR1: weekly from July 2025; **retired February 2026**.
  - QR2: from October 2025 (all QR1 reprocessed).
  - QR2 headers fixed April 10, 2026.
  - **QR3: began September 2026**, with substantially improved PSF and calibrations.
  - New QR spectral images arrive weekly. Higher-level products are planned "over the next three years".

  DOIs: QR2 10.26131/IRSA652; QR3 10.26131/IRSA662 — [QR overview](https://irsa.ipac.caltech.edu/data/SPHEREx/docs/overview_qr.html); [IRSA SPHEREx](https://irsa.ipac.caltech.edu/Missions/spherex.html).
- The mission schedule lists reprocessed calibrated spectral images and all-sky data cubes for November 2026. These are schedule targets, not confirmed releases (search summary) — [SPHEREx data products page](https://spherex.caltech.edu/page/data-products).
- **Level-2 MEF** (one per detector per pointing, about 70 MB; filename `level2_[OBSID]D[det]_spx_l2b-v[ver]-[date].fits`):

  | HDU | Name | Contents |
  |---|---|---|
  | 0 | PRIMARY | header only |
  | 1 | IMAGE | 2040×2040 float32, MJy/sr, not zodi-subtracted |
  | 2 | FLAGS | 2040×2040 int32 bitmap |
  | 3 | VARIANCE | (MJy/sr)² |
  | 4 | ZODI | modeled zodiacal light, MJy/sr |
  | 5 | PSF | 101×101×121 cube, 10× oversampled, 11×11 grid of detector zones; header `XCTR_i`/`YCTR_i` locate zones |
  | 6 | WCS-WAVE | binary table |

  Sources: [archive docs](https://caltech-ipac.github.io/spherex-archive-documentation/spherex-data-products/); [intro tutorial](https://caltech-ipac.github.io/irsa-tutorials/spherex-intro/).
- QR3 adds a recommended ePSF calibration product: 33×33 px, 5× oversampled, 21×21 zones (11×41 for detector 3). It also adds Level-3 flux-correction maps for combining QR2 and QR3 — [archive docs](https://caltech-ipac.github.io/spherex-archive-documentation/spherex-data-products/).
- Header keywords include `DETECTOR`, `OBSID`, `PSF_FWHM` (example 5.15, units not stated), `DATE`, and `WCSNAMEA`/`WCSNAMEW`. SIA results include `t_min`, `t_max`, `t_exptime` and `t_resolution` — [intro tutorial](https://caltech-ipac.github.io/irsa-tutorials/spherex-intro/).

**APIs a web app can use**
- **SIA** (astroquery `Irsa.query_sia`): collections `spherex_qr3`, `spherex_qr3_deep`, `spherex_qr2`, `spherex_qr2_deep`. The `access_url` points to `https://irsa.ipac.caltech.edu/ibe/data/spherex/qr2/level2/...`. SIA lags about a day behind the weekly ingestion — [intro tutorial](https://caltech-ipac.github.io/irsa-tutorials/spherex-intro/).
- **TAP** tables `spherex.artifact` (column `uri`) and `spherex.plane` (`planeid`, `poly`, `energy_bandpassname` e.g. `'SPHEREx-D2'`, `time_bounds_lower`). TAP gives immediate access to new data. Example ADQL:
  ```
  SELECT 'https://irsa.ipac.caltech.edu/' || a.uri || '?center={ra},{dec}d&size={deg}' AS uri, p.time_bounds_lower
  FROM spherex.artifact a JOIN spherex.plane p ON a.planeid = p.planeid
  WHERE 1 = CONTAINS(POINT('ICRS', {ra}, {dec}), p.poly) AND p.energy_bandpassname = 'SPHEREx-D2'
  ORDER BY p.time_bounds_lower
  ```
  Source: [cutouts tutorial](https://caltech-ipac.github.io/irsa-tutorials/spherex-cutouts/).
- **Cutout service:** append `?center=RA,DECd&size=S` (S in degrees, e.g. `size=0.1`) to the image URL. Cutouts keep all HDUs: IMAGE/FLAGS/VARIANCE/ZODI are trimmed, but **the PSF HDU is left unmodified**. Extension names get the cutout index appended (e.g., `IMAGE1`). The tutorial fetched about 700 cutouts in 5–7 min serially and recommends about 10 threads — [cutouts tutorial](https://caltech-ipac.github.io/irsa-tutorials/spherex-cutouts/); [archive docs](https://caltech-ipac.github.io/spherex-archive-documentation/spherex-data-products/).
- Browsable directories are at `/ibe/data/spherex/` — [QR overview](https://irsa.ipac.caltech.edu/data/SPHEREx/docs/overview_qr.html).
- AWS S3 open data: [Registry of Open Data: SPHEREx QR](https://registry.opendata.aws/spherex-qr/); [IRSA cloud access](https://irsa.ipac.caltech.edu/cloud_access/#spherex).
- IRSA VO API index: [voapi](https://irsa.ipac.caltech.edu/voapi.html).
- **HiPS:** CDS SPHEREx HiPS collections D1/D2/D3 (Section 2). The IRSA Mosaic Tool also uses HiPS for display — [Mosaic help](https://irsa.ipac.caltech.edu/onlinehelp/spherex/spherex/mosaic.html).
- Canonical papers: Bock et al. 2026 (mission), Akeson et al. 2026 (pipeline, arXiv:2511.15823), Crill et al. 2025 (sky simulator), Korngut et al. 2026 (instrument and calibration, arXiv:2603.29835) — [IRSA SPHEREx](https://irsa.ipac.caltech.edu/Missions/spherex.html); [pipeline paper](https://arxiv.org/pdf/2511.15823); [Korngut et al.](https://arxiv.org/abs/2603.29835).

### Inferences
- **Bandwidth trap:** a cutout still carries the full PSF HDU. 101×101×121 float32 is about 4.9 MB, versus about 13 KB of image for a 0.1° (≈58×58 px) stamp. Two mitigations:
  - Use a backend that strips the PSF HDU and serves IMAGE+FLAGS as compact binary or PNG.
  - Fetch the PSF once per detector zone.
- **Data volume in hand:** surveys began in spring 2025 and repeat every ~6 months. By Nov 2026 most of the sky should have about 3 survey visits (2025 H1–H2, 2026 H1, and possibly 2026 H2 partially released). That is 2–3 epochs per position. This is the researcher's inference; no official coverage-count map was found.
- The channels for a given sky position are acquired at different times over ~2 weeks, not simultaneously. A "spectrum" of a moving object is therefore time-mixed. For distant objects near quadrature this is acceptable (Section 6). For asteroids the spectrum is spatially smeared.
- In a browser: parse FITS cutouts with a JS FITS reader (fitsjs or JS9/astroem), and render HiPS context with Aladin Lite. Avoid downloading 70 MB MEFs client-side.

### Gaps
- Astrometric accuracy of SPHEREx WCS was not found.
- The exact number of surveys completed and released by Nov 2026 was not confirmed.
- Whether a SPHEREx survey-coverage/epoch-count map exists was not found.
- The full Explanatory Supplement was not read (too large to fetch).
- CORS policy on IRSA endpoints is unknown.
- Whether IRSA (vs. CDS) serves official SPHEREx HiPS for QR3 is unclear.
- What the CDS D1/D2/D3 HiPS contain (single channel or band co-add, which QR version) was not verified; the CDS server refused the connection.

## 5. Infrared signatures of a cold giant planet or brown dwarf vs. stars and galaxies, and how SPHEREx helps

### Takeaway
Cold (T ≲ 500 K) atmospheres have three key signatures:
- Strong CH4 absorption at 3.3 µm.
- A flux peak through the 4–5 µm window.
- Very red W1−W2 / [3.6]−[4.5] colors.

SPHEREx samples both features with R≈35 at 3.3 µm and R≈120 at 4–5 µm. It has already measured CH4, H2O, CO and CO2 in 37 L0–Y4 brown dwarfs and built a 6,003-object ultracool-dwarf library. Spectral shape can therefore separate a cold object from stars (Rayleigh–Jeans blue) and galaxies. A reflected-light planet is a different case: it would be very faint and dark in methane bands.

### Cited Findings
- WISE W1 (3.4 µm) sits inside the strong fundamental CH4 band near 3.3 µm, while W2 (4.6 µm) sees the transparent 4.5 µm window into deeper, hotter layers. Cold brown dwarfs therefore have very red W1−W2, and WISE was designed to find Y dwarfs this way — [arXiv:1205.2122](https://arxiv.org/pdf/1205.2122); [arXiv:1209.6123](https://arxiv.org/pdf/1209.6123); [Atmospheres of brown dwarfs review, arXiv:1410.6029](https://arxiv.org/pdf/1410.6029).
- The 4.5 µm flux peak lies in a window between CH4 absorption near 3 µm and H2O absorption near 5 µm. About one-third of a Y dwarf's energy emerges between about 3.7 and 5.9 µm — [arXiv:2411.03549](https://arxiv.org/html/2411.03549v2) (via search summary).
- **SPHEREx brown dwarf results:**
  - Rustamkulov et al. analyzed SPHEREx spectra of 37 field brown dwarfs (L0–Y4; arXiv July 2026, later ApJ). They detected H2O, CO2, CO and CH4.
  - No leading model fully matched; models struggle at the cloudy L/T transition.
  - Same-temperature objects differ noticeably.

  Sources: [arXiv:2607.00543](https://arxiv.org/abs/2607.00543); [NASA](https://nasa.gov/missions/spherex/nasas-spherex-telescope-sees-menagerie-of-brown-dwarfs); [Space.com](https://www.space.com/astronomy/stars/theyre-kind-of-goth-nasa-spacecraft-gives-mysterious-brown-dwarfs-a-close-up).
- A companion paper presents a SPHEREx pipeline and spectral library of 6,003 ultracool dwarfs — [arXiv:2604.22012](https://arxiv.org/abs/2604.22012v1).
- Bock et al. planned a spectral atlas of about 10,000 low-mass stars, including all accessible brown dwarfs down to Y — [Bock et al.](https://arxiv.org/html/2511.02985v2).
- Thermal model predictions for Planet Nine reach as bright as W1 = 16.1 and W2 = 17.2 (Vega) — [Meisner et al. 2018](https://ar5iv.arxiv.org/html/1712.04950) (via search summary).
- Reflected-light estimates for Planet Nine: 22 < V < 25 (2016 estimate) — [Brown & Batygin 2016](https://resolver.caltech.edu/CaltechAUTHORS:20160715-140146687).
- The 2021 orbit fit gives M = 6.2 (+2.2/−1.3) M⊕, a = 380 (+140/−80) AU, i = 16 ± 5°, q = 300 (+85/−60) AU, with Planet Nine "closer and brighter than initially expected" — [Brown & Batygin 2021, arXiv:2108.09868](https://arxiv.org/abs/2108.09868).

### Inferences
- **Spectral classifier widget:** compare the user's SPHEREx forced-photometry spectrum (IRSA Spectrophotometry Tool) with templates:
  - Stellar blackbody: falling toward 5 µm.
  - Galaxy: 1.6 µm stellar bump, PAH 3.3 µm *emission* in star-forming galaxies.
  - T/Y dwarf: deep 3.3 µm trough plus a 4–4.6 µm peak; CO2 at 4.3 µm and CO at 4.6 µm modulate the peak.
  - Ice giant reflected light: solar spectrum times a methane-darkened albedo.

  A simple index such as F(4.5 µm)/F(3.3 µm) from SPHEREx band 4/6 channels gives a WISE-like "W1−W2" with finer sampling.
- Caution: the PAH 3.3 µm feature in galaxies is emission while the methane feature is absorption, but at R≈35 a noisy spectrum can confuse the two. Shuttle glow also contaminates 3 and 4.5 µm (Section 3).
- (Background, not verified this session) Uranus/Neptune-like atmospheres also show strong CH4 absorption at ~0.89, 1.15, 1.4, 1.7 and 2.3 µm in reflected light. A cold reflected-light planet would be red-optical and dark in H/K.

### Gaps
- I found no published model SPHEREx spectrum or SPHEREx-band magnitudes for a Planet Nine–like object.
- I found no explicit statement of how SPHEREx spectra discriminate PAH emission from CH4 absorption at low S/N.

## 6. Quantitative widgets: motion vs. distance, pixel scale, limiting magnitude vs. planet brightness

### Takeaway
Between the two quadrature visits ~6 months apart, a distant object shifts by about 412,530″/d[AU]. That is ~134 SPHEREx pixels at 500 AU and ~67 px at 1,000 AU. Motion is detectable (more than 1 px per 6 months) out to about 67,000 AU, but stars essentially never move a pixel. Brightness is the hard limit:
- SPHEREx per-channel all-sky depth is about 19.5–19.9 AB.
- Planet Nine is constrained to V > 21–21.5 in reflected light and W1 > 16.7 Vega (≈19.4 AB) in the thermal infrared at high latitude.

So a direct SPHEREx detection of a Brown–Batygin Planet Nine is unlikely, unless the tool co-adds channels and epochs and the planet is at the bright end of thermal models. Bright hypothetical objects (larger, closer, or self-luminous) remain in reach. The tool should say this honestly and quantify it.

### Cited Findings
- SPHEREx native pixel is 6.15″ (6.2″ rounded) — [Mosaic help](https://irsa.ipac.caltech.edu/onlinehelp/spherex/spherex/mosaic.html); [Bock et al.](https://arxiv.org/html/2511.02985v2).
- The PSF FWHM extends to about 5.5–6″ in places — [Bock et al.](https://arxiv.org/html/2511.02985v2).
- SPHEREx looks about 90° from the Sun (Sun more than 93.5° off the shield axis). The orbit semi-major axis is 7,037.4 km — [Bock et al.](https://arxiv.org/html/2511.02985v2).
- Depth: 19.5–19.9 AB (0.75–3.8 µm) and 17.8–18.8 AB (3.8–5 µm), 5σ per channel after 2 years — [Bock et al.](https://arxiv.org/html/2511.02985v2).
- Planet Nine constraints:
  - Pan-STARRS1: V = 21.5 at 50% completeness, with about 78% of parameter space excluded (with ZTF+DES) — [arXiv:2401.17977](https://arxiv.org/abs/2401.17977).
  - WISE: W1 < 16.7 (Vega) excluded at high Galactic latitude — [arXiv:1712.04950](https://ar5iv.arxiv.org/html/1712.04950).
  - Models: up to W1 = 16.1 and W2 = 17.2 Vega — [Meisner et al. 2018](https://ar5iv.arxiv.org/html/1712.04950).
- (†) WISE Vega→AB offsets: W1 +2.699, W2 +3.339 — [WISE Explanatory Supplement §4.4h](https://wise2.ipac.caltech.edu/docs/release/allsky/expsup/sec4_4h.html).

### Inferences (researcher's calculations; formulas the team can implement)
- **Parallax shift between east and west quadrature visits** (6 months apart; Earth displacement 2 AU perpendicular to the line of sight):
  - Δθ ≈ 2 AU/d rad = 412,530″/d[AU].
  - In SPHEREx pixels: ≈ 67,080/d[AU].

  | d (AU) | Shift (″) | Shift (SPHEREx px) |
  |---|---|---|
  | 100 | ~4,125 (1.15°) | ~670 |
  | 250 | ~1,650 | ~268 |
  | 380 | ~1,086 | ~177 |
  | 500 | ~825 | ~134 |
  | 700 | ~589 | ~96 |
  | 1,000 | ~413 | ~67 |
  | 5,000 | ~83 | ~13 |
  | 67,000 (~0.33 pc) | ~6 | ~1 |

  - Exact value depends on ecliptic latitude β: the parallax ellipse has semi-major axis 1 AU/d and semi-minor axis (1 AU/d)·sin β.
- **Orbital (heliocentric) motion**, circular approximation: μ ≈ 1,296,000″/a^1.5 per year. That gives ~175″/yr at 380 AU and ~116″/yr at 500 AU, or about 9–14 px per 6 months, slower near aphelion. The fit must include it alongside parallax.
- **Within one ~2-week visit near quadrature:**
  - Reflex motion ≈ (1 AU/d)(ωt)²/2 ≈ 1,500″/d for t = ±7 days (ω = 2π/yr). That is about 3″ (0.5 px) at 500 AU.
  - Orbital drift ≈ 4–7″.
  - So for d ≳ 300–500 AU, channels within a visit can be co-added with ≲ 1–2 px smear. Closer objects need motion-compensated stacking.
- **Spacecraft (LEO) parallax:** 7,037 km / d is about 0.02″ at 500 AU, negligible. A geocentric ephemeris is fine.
- **Stars and brown dwarfs:** a 10 pc star has 0.1″ parallax; even Barnard's Star (~10″/yr proper motion) moves less than 1 px in 6 months. SPHEREx motion searches are therefore effectively limited to solar-system distances, and real "movers" are solar-system objects or artifacts.
- **Depth gain from stacking** (assumes white noise; real gains are smaller due to confusion and systematics):
  - Co-adding n channels or epochs improves the limit by 1.25·log10(n) mag: 17 channels of one band gives about +1.5 mag; 4 surveys about +0.75 mag (already included in Bock's 2-year numbers).
  - Single-survey per-channel depth ≈ 2-year depth − 0.75 ≈ 18.8–19.2 AB (0.75–3.8 µm).
  - A full band-4 co-add over 2 years could approach about 21 AB.
- **Planet Nine brightness vs. SPHEREx:**
  - Thermal model W1 = 16.1 Vega ≈ 18.8 AB at 3.4 µm, comparable to single-survey band-4 per-channel depth. W1 = 16.7 Vega ≈ 19.4 AB is already excluded by WISE at high latitude.
  - W2 = 17.2 Vega ≈ 20.5 AB at 4.6 µm, which is fainter than SPHEREx band-6 depth (17.8–18.8 AB per channel).
  - Reflected light: V > 21.5 and methane-darkened in the near-IR, so below the per-channel limit.
  - Conclusion: SPHEREx alone is marginal for the nominal Planet Nine. It could add value in the Galactic-plane regions where optical surveys are weakest, if users co-add.
- **Brightness scaling widget:**
  - Reflected light scales as m = H + 5·log10(r·Δ) (≈ H + 10·log10 d for d ≫ 1 AU), i.e. 2.5 mag fainter per doubling of distance.
  - Thermal emission scales as roughly 5·log10 d at fixed temperature; it is in fact stronger, because internal-heat objects keep their temperature with distance while equilibrium temperature falls.
  - A slider for d, radius, albedo and T_int, with SPHEREx depth lines per band, would answer "could SPHEREx see it?"

### Gaps
- I found no published SPHEREx single-visit (per-survey) depth figure; the single-survey number above is extrapolated.
- I found no model of Planet Nine magnitudes in SPHEREx channels.
- Astrometric precision needed for parallax fitting is unknown (SPHEREx astrometric accuracy not found).
