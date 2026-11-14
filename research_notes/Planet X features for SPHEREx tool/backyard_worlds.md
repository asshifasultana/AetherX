# Backyard Worlds: Planet 9: workflow, volunteer tools, and lessons for a SPHEREx "Planet X" tool

Researched 2026-11-12. Newest sources: the NASA release of 5 May 2026 and the Schneider et al. 2026 AJ paper. Items from 2017 to 2019 are marked as older. The project blog (blog.backyardworlds.org) has had no posts since June 2023, so news since then comes from NASA and arXiv.

## 1. How the classification interface works (flipbooks, marking, tutorial and field guide, artifacts)

### Takeaway
Volunteers watch a short, looping 4-frame "flipbook" of unWISE difference images, roughly 10 arcmin across. They click a crosshair on anything that moves in all four frames, then tag it in Talk. Most of the teaching is about telling real "movers" and "dipoles" apart from badly subtracted stars, ghosts, pointing jitter, diffraction spikes and noise.

### Cited Findings
- Launched 15 Feb 2017 on Zooniverse. PI is Marc Kuchner (NASA Goddard). The first grant, from the NASA Astrophysics Data Analysis Program, initially ran to 2020 — [Wikipedia](https://en.wikipedia.org/wiki/Backyard_Worlds)
- Flipbook construction, from the 2017 design: the unWISE coadds were cut into 18,240 tiles of 1.56°×1.56°, each split into 64 subtiles of 256×256 px. Each of the four frames is one epoch minus the median of other epochs, which removes static sources. Each frame is clipped to −0.5σ…9.5σ, smoothed with a 12×12 tophat and self-subtracted, then given an arcsinh stretch. Colour mapping: W1 (3.4 µm) difference = blue, W2 (4.6 µm) = red, mean of the two = green. Built with the Zooniverse Project Builder — [Kuchner et al. 2017, ApJL 841 L19, arXiv:1705.02919](https://arxiv.org/html/1705.02919.pdf)
- What volunteers do: put a green crosshair on each candidate in all four frames, then press "Done". There are two classes of candidate. A "mover" shifts more than one PSF FWHM over the ~4.5-yr baseline. A "dipole" shifts less than one FWHM and shows as a black/white (negative next to positive) pair. The interface offers zoom and a colour-inversion button, the latter added for colour-blind users — [Kuchner et al. 2017](https://arxiv.org/html/1705.02919.pdf)
- Artifacts named in the 2017 paper: partly subtracted stars and galaxies (from variability or small misalignments, the most common), cosmic rays, optical ghosts, latent images, Poisson noise, and electronic crosshatching or striping — [Kuchner et al. 2017](https://arxiv.org/html/1705.02919.pdf)
- FAQ and field-guide rules of thumb:
  - A real mover appears in all four frames. In only three, it may be noise, so leave the call to the scientists. In only two, it is most likely a ghost.
  - Dipoles look like "black-and-white cookies" in every frame.
  - Stellar artifacts all "dance". Look for the one that moves differently from the rest.
  - Many dipoles in a single frame means the telescope's pointing shifted, not the stars.
  - Long stripes are diffraction spikes from a bright star just outside the subtile.
  - Black patches are data gaps.
  - Very large artifacts are usually Mira variables.
  - Brown dwarfs look red or white, because they are brighter in W2.
  - Users typically need about 60 classifications before they spot a known high-proper-motion object. Anyone past 100 with no finds should slow down.
  - [Zooniverse BYW FAQ](https://www.zooniverse.org/projects/marckuchner/backyard-worlds-planet-9/about/faq)
- Speed heuristics given to volunteers:
  - Total proper motion above ~100 mas/yr usually shows as a dipole; above ~1000 mas/yr it usually shows as a mover — [BYW blog, "Getting Started with SIMBAD" (2017)](https://blog.backyardworlds.org/2017/03/01/getting-started-with-simbad/)
  - An object that moves more than ~0.01° (16 px) between the first and last frames may be too fast for a star, so it could be a Solar System object — [BYW blog "How to use" category](https://blog.backyardworlds.org/category/how-to-use-backyardworlds-org/)
- The FAQ's description of what Planet 9 would look like:
  - A fast, faint mover, probably moving more horizontally than brown dwarfs do, possibly with a second copy up to ~12′ away.
  - With atmospheric methane it would look red (W2-bright). If the methane has frozen out, which is likely at ~10 Earth masses, it would look blue (W1-bright).
  - It may simply be too faint to see.
  - [BYW FAQ](https://www.zooniverse.org/projects/marckuchner/backyard-worlds-planet-9/about/faq)
- Community-written tutorials. Michaela Allen's 2017 beginner's guide covers fast movers, ghosts, South Atlantic Anomaly noise, "petal" misalignment artifacts and the #badimage tag. It was translated into Spanish in Apr 2023 — [BYW blog index](https://blog.backyardworlds.org/)
- Nov 2018 "reboot" (older): new subjects added 2 more years of WISE data with lower noise. Planets were no longer made to "hop and jump" between frames, and dipoles were expected to flip between frames 1 and 2 — [BYW blog](https://blog.backyardworlds.org/); [Wikipedia](https://en.wikipedia.org/wiki/Backyard_Worlds)
- Patch geometry per the 2024 CSTP paper: 1.16 million patches, each 11.7′ on a side, shown at random sky positions. The large patches were chosen for slow-moving Planet 9, not for nearby brown dwarfs — [Meisner et al. 2024, Citizen Science: Theory & Practice](https://theoryandpractice.citizenscienceassociation.org/articles/10.5334/cstp.737)
- Current status: when fetched in Nov 2026, the Zooniverse project page said the project is "finished", out of data, and that a new batch is in preparation. The date of that banner is unknown — [BYW FAQ page banner](https://www.zooniverse.org/projects/marckuchner/backyard-worlds-planet-9/about/faq)

### Inferences
- The core interaction (loop a few epochs, click what moves, tag it) is simple. What makes it hard is recognising artifacts, so the field guide's "how artifacts dance" content matters as much as the viewer itself.
- Difference imaging plus a colour code that encodes physics (red = methane-bearing cold object) lets beginners reason about candidates without understanding photometry.
- The colour-inversion option for colour-blind users was a small accessibility choice the team thought worth putting in the paper.

### Gaps
- I could not retrieve the full text of the current in-app Tutorial or Field Guide; Zooniverse pages render with JavaScript. The details above come from the FAQ and the 2017 paper.
- Latents are named in the 2017 paper but not in the FAQ text I retrieved. Halos are not covered in either.

## 2. External tools used by advanced volunteers ("super-users")

### Takeaway
Advanced volunteers move off Zooniverse quickly. They use WiseView, a volunteer-built blinker with speed, zoom, stretch, band and field-of-view controls plus a Pan-STARRS comparison panel. They check candidates against SIMBAD and VizieR, compare old and new surveys in IRSA Finder Chart, see wider context in the Legacy Survey viewer, and use AstroToolBox (an all-in-one Java tool). The project's ML candidate ranker, SMDET, was also built by a volunteer.

### Cited Findings
- **WiseView** (2017; built by volunteers Dan Caselden and Paul Westin, both computer-security researchers; hosted at byw.tools/wiseview):
  - Blinks unWISE coadds (AllWISE, NEOWISE-R1, R2 …).
  - Band choice: W1, W2 or both.
  - Field of view set in arcseconds.
  - Zoom slider and blink "Speed" slider.
  - Asinh stretch parameter ("Linear"), plus "Trim Bright" clipping in fixed, percent and experimental "adapt" modes.
  - A second panel with a Pan-STARRS-1 colour composite for contamination checks.
  - Built with astropy and matplotlib.
  - Volunteers use it to check proper motion on faint candidates that are hard to judge in 2MASS.
  - [BYW blog guest post, 13 Sep 2017](https://blog.backyardworlds.org/2017/09/13/wiseview/)
- The FAQ recommends WiseView for animating any coordinate with an adjustable FOV. This is especially useful for fast movers that leave the 4-frame cutout — [BYW FAQ](https://www.zooniverse.org/projects/marckuchner/backyard-worlds-planet-9/about/faq)
- **SIMBAD**: query with a 1′ radius and check the object-type codes (PM* = high proper motion star, BD* = brown dwarf) and the references. A volunteer should fill out the "Think You've Got One?" form only if the object is not in SIMBAD — [BYW FAQ](https://www.zooniverse.org/projects/marckuchner/backyard-worlds-planet-9/about/faq); [SIMBAD blog post](https://blog.backyardworlds.org/2017/03/01/getting-started-with-simbad/)
- **VizieR**: search with a 1′ radius and look for pmRA or pmDE above ~100 mas/yr. The FAQ warns that AllWISE proper motions are systematically high. An object that is in VizieR but not SIMBAD should still be reported — [BYW FAQ](https://www.zooniverse.org/projects/marckuchner/backyard-worlds-planet-9/about/faq)
- **IRSA Finder Chart**: compares DSS, SDSS, 2MASS and WISE images taken at different times. Volunteers note the dates and the displacement to estimate tangential speed — [BYW FAQ](https://www.zooniverse.org/projects/marckuchner/backyard-worlds-planet-9/about/faq)
- **Legacy Survey Sky Viewer** (legacysurvey.org): wider field of view with DECaLS and SDSS imagery, recommended next to WiseView — [WiseView blog post](https://blog.backyardworlds.org/2017/09/13/wiseview/). The 2020 project blog called for more searches of the Legacy Surveys data — [BYW blog](https://blog.backyardworlds.org/)
- **AstroToolBox** (Frank Kiwy, Java): an image viewer with a WISE blinker, catalog search and overlays, and photometric spectral-type estimates. It was highlighted on the blog in Mar 2022 — [BYW FAQ](https://www.zooniverse.org/projects/marckuchner/backyard-worlds-planet-9/about/faq); [BYW blog](https://blog.backyardworlds.org/)
- The first discovery used this same chain of checks. Volunteers found an AllWISE entry in VizieR with no spectral type, then checked DSS and 2MASS. The Pan-STARRS y band and the 2MASS "Reject" table provided extra detections. The team then took an IRTF/SpeX spectrum (T5.5) and ran BANYAN II for moving-group membership — [Kuchner et al. 2017](https://arxiv.org/html/1705.02919.pdf)
- **SMDET** (volunteer Dan Caselden): a convolutional recurrent neural network trained on synthetic movers injected into unWISE time series. Its input is about 13 epochs per band over roughly 6–7 years. Its top ~70k candidates became the Cool Neighbors subject set. It throws up many false positives (noise, bright-star artifacts, persistence), so human vetting is still needed — [Meisner et al. 2024 CSTP](https://theoryandpractice.citizenscienceassociation.org/articles/10.5334/cstp.737)
- Caselden found "The Accident" (WISEA J153429.75−104303.3) with his own custom software sifting NEOWISE data. Accounts put the find around 2018; Keck follow-up came in 2020 and the paper (Kirkpatrick et al., ApJL 915) in June 2021. It may be the first Y subdwarf, 10–13 Gyr old — [Space.com](https://www.space.com/the-accident-brown-dwarf-discovery-citizen-scientist); [Daily Beast](https://www.thedailybeast.com/this-very-weird-accidental-star-could-help-reveal-the-secrets-of-the-cosmos)
- NASA's 2026 release says some volunteers "built their own search tools and analysis software" — [NASA, 5 May 2026](https://science.nasa.gov/get-involved/citizen-science/nasa-volunteers-double-known-population-of-brown-dwarfs/)
- Advanced participants coordinate in a Google Group (email plus forum). Candidates go in through Google Forms: "Think You've Got One?" for Planet 9 and the "Move-In Form" for Cool Neighbors — [Meisner et al. 2024 CSTP](https://theoryandpractice.citizenscienceassociation.org/articles/10.5334/cstp.737)

### Inferences
- Super-users want what the Zooniverse flipbook cannot give them: any coordinate, a larger or adjustable FOV, blink-speed and stretch control, band separation, more epochs, a side-by-side panel from another survey, and one-click catalog lookups. WiseView became the standard tool largely because it bundled those things.
- The vetting pipeline volunteers themselves were taught runs: see motion → check SIMBAD/VizieR → compare multi-survey epochs (Finder Chart / Legacy) → estimate proper motion → submit a form. A tool that wraps those steps saves real time.

### Gaps
- I could not find a public GitHub repo for WiseView (github.com/dcaselden/wiseview returned 404). I did not confirm whether byw.tools is still online in 2026.
- No source found that describes "Byw-tools" beyond WiseView, CatWISE as a volunteer-facing tool, Aladin use, or standalone proper-motion calculators. Volunteers do seem to use catalog proper motions (CatWISE/Gaia) via VizieR, but I could not source this specifically.

## 3. What volunteers and scientists say about engagement, frustrations, retention, credit and vetting

### Takeaway
Credit is the project's strongest retention tool. Volunteers who find objects are routinely made co-authors (61 of 75 authors on the 2026 paper), and they speak about it with emotion. The main design weakness the team admits to is efficiency: random, large, mostly empty patches. Smaller, ML-targeted subjects tripled classification speed and raised per-user output.

### Cited Findings
- 2026: 61 of the 75 authors on the 3,000-candidate paper are volunteers, and two other authors went from volunteering into astronomy careers. About 200,000 people took part over 10 years. Quotes from volunteer co-authors:
  - Mayahuel Torres Guerrero: "Yes, dreams do come true."
  - Walter Ruben Robledo was grateful for "the recognition for all of us who collaborated".
  - [NASA, 5 May 2026](https://science.nasa.gov/get-involved/citizen-science/nasa-volunteers-double-known-population-of-brown-dwarfs/)
- 2023 tally (older): 20 refereed papers with more than 40 volunteer co-authors, 11 research notes and 25 AAS presentations. Some volunteers joined IRTF observing runs and won JWST time. The combined projects had reached 10 million classifications — [NASA, 16 Nov 2023](https://science.nasa.gov/get-involved/citizen-science/backyard-worlds-volunteers-complete-ten-million-classifications-in-an-epic-search-for-new-objects-among-the-nearest-stars)
- A few hundred "super users" do ambitious self-directed research. One, Frank Kiwy, led a team publishing findings from NOIRLab's catalog — [NASA via search summary](https://science.nasa.gov/get-involved/citizen-science/NASA-volunteers-double-known-population-of-brown-dwarfs/)
- Earlier papers credit the "Backyard Worlds: Planet 9 Collaboration" as a group author, with named citizen-scientist co-authors:
  - Meisner et al. 2020 Spitzer paper: 41 authors, about 20 of them volunteers, per the blog — [arXiv:2008.06396](https://arxiv.org/abs/2008.06396); [BYW blog](https://blog.backyardworlds.org/)
  - 2021 extreme T subdwarf paper: 7 volunteer co-authors — [BYW blog](https://blog.backyardworlds.org/)
- Vetting and follow-up chain:
  1. Volunteers mark the object and tag it #mover or #dipole in Talk.
  2. Advanced users check SIMBAD and VizieR, then submit "Think You've Got One?".
  3. The science team obtains spectroscopy or photometry (IRTF/SpeX, Keck, Spitzer, later JWST).
  - The FAQ notes the scientists would eventually find unreported objects from the marks anyway; reporting just speeds things up — [Kuchner et al. 2017](https://arxiv.org/html/1705.02919.pdf); [BYW FAQ](https://www.zooniverse.org/projects/marckuchner/backyard-worlds-planet-9/about/faq)
- Throughput of the pipeline (older): by Jul 2018 there were 879 candidates and 42 confirmed brown dwarfs. By Jul 2019 there were more than 6M classifications, 32,810 submitted sources and 131 spectroscopically confirmed brown dwarfs — [BYW blog](https://blog.backyardworlds.org/)
- Engagement statistics, Planet 9 vs Cool Neighbors:

  | Metric | Planet 9 | Cool Neighbors |
  |---|---|---|
  | Total classifications | 8.8M | 1.8M (to Jan 2024) |
  | Mean / median time per classification | 38.3 s / 22.0 s | 13.7 s / 6.0 s |
  | Mean / median classifications per registered user | 87.6 / 15 | 423.2 / 31 |
  | Registered users | 79,970 | 4,087 |

  About 1,000 users overlap between the two projects. Both have Gini coefficients above 0.8, so a small minority does most of the work — [Meisner et al. 2024 CSTP](https://theoryandpractice.citizenscienceassociation.org/articles/10.5334/cstp.737)
- Attitudes to AI: 53 of 359 advanced participants answered the survey. 39.6% said ML made Cool Neighbors more exciting, 49.1% said it made no strong difference and 11.3% said less exciting. 77.4% were positive about ML/AI in general. The team framed ML as something that runs before human vetting, not as a competitor. Volunteer-facing text says "machine learning", not "AI", and two-thirds of ML mentions stress its limits and the need for human classifiers — [Meisner et al. 2024 CSTP](https://theoryandpractice.citizenscienceassociation.org/articles/10.5334/cstp.737)
- Data policy: the subject data are not public because they contain unpublished discoveries. Releasing them early would hurt the volunteers who found them — [Meisner et al. 2024 CSTP](https://theoryandpractice.citizenscienceassociation.org/articles/10.5334/cstp.737)
- Early momentum (older): about 76,000 participants (by unique IP) and more than 3.4M classifications within roughly 3 months of launch. The first new object was flagged 6 days after launch — [Kuchner et al. 2017](https://arxiv.org/html/1705.02919.pdf)

### Inferences
- Credit drives the most valuable 1% of users. A visible credit path (discoverer named → co-author → observing time) is something to copy, even on a small scale: a public "first flagged by" field on each candidate.
- The FAQ tells new users to expect about 60 classifications before a find. That implies long stretches of empty skies. Seeding known movers or synthetic injections early probably helps beginners stay motivated (an inference, not tested here).
- Forms and Google Groups are clunky but worked. A built-in "report candidate" flow with automatic catalog checks would replace three separate tools.

### Gaps
- I could not access Zooniverse Talk threads directly (JavaScript-rendered), so there are no first-hand volunteer complaints in these notes. The only frustration the team states in writing is that random large patches are inefficient.
- The papers report no direct retention or churn curves.

## 4. Discoveries, how volunteers are credited, and the Planet 9 result

### Takeaway
Ten years of work produced 3,006 motion-confirmed L/T candidates (2026), several Y dwarfs including The Accident, a white dwarf with a long-lived dust disk, extreme T subdwarfs, and dozens of wide co-moving companions. No Planet 9 has been found. WISE-based searches rule out a Planet 9 brighter than about W1 ≈ 16.7 over most of the sky.

### Cited Findings
- **Schneider et al. 2026, AJ** (arXiv:2604.01323): 3,006 new motion-confirmed L/T candidates (2,357 L, 649 T). Also 80 likely L/T dwarfs without significant motion, 28 new co-moving companions to stars, and 9 candidate ultracool binaries. If confirmed, the known L/T count would more than double. Spectroscopy is still needed — [arXiv:2604.01323](https://arxiv.org/abs/2604.01323); [NASA 2026](https://science.nasa.gov/get-involved/citizen-science/nasa-volunteers-double-known-population-of-brown-dwarfs/). Wikipedia says 65 citizen scientists discovered the catalog objects — [Wikipedia](https://en.wikipedia.org/wiki/Backyard_Worlds)
- NASA's 2026 highlights: extreme T subdwarfs, the reddest free-floating brown dwarf, and one brown dwarf with apparent aurorae. The team is still sifting more than 2 billion WISE/NEOWISE-R sources from a 16-year span — [NASA 2026](https://science.nasa.gov/get-involved/citizen-science/nasa-volunteers-double-known-population-of-brown-dwarfs/)
- Other notable discoveries:
  - First discovery: WISEA J1101+5400, a T5.5 dwarf at ~34 pc (2017) — [Kuchner et al. 2017](https://arxiv.org/abs/1705.02919)
  - First volunteer-found Y dwarf: WISE J0830+2837 (Bardalez Gagliuffi et al. 2020) — [Wikipedia](https://en.wikipedia.org/wiki/Backyard_Worlds)
  - Spitzer follow-up of 95 candidates: 75 had confirmed motion, 5 have Y-like colours, and a T8 companion to a white dwarf was found — [Meisner et al. 2020](https://arxiv.org/abs/2008.06396)
  - "The Accident": a probable Y subdwarf. It was selected for JWST — [Space.com](https://www.space.com/the-accident-brown-dwarf-discovery-citizen-scientist); [BYW blog](https://blog.backyardworlds.org/)
  - LSPM J0207+3331, a ~3-Gyr white dwarf with a dusty disk, found by volunteer Melina Thévenot (2018–19) — [BYW blog](https://blog.backyardworlds.org/); [Wikipedia](https://en.wikipedia.org/wiki/Backyard_Worlds)
  - Co-moving systems: W2150AB, an L1+T8 pair at 341 au (Faherty 2020). CWISE J0146−0508AB, the widest known field brown dwarf binary as of 2022 (Softich 2022). 89 new ultracool companions (Rothermich et al. 2024, AJ) — [Wikipedia](https://en.wikipedia.org/wiki/Backyard_Worlds)
- **Planet 9 result**:
  - Jul 2019: no Planet Nine yet, though superusers were searching for it — [BYW blog](https://blog.backyardworlds.org/)
  - No source up to 2026 reports a detection — [Wikipedia](https://en.wikipedia.org/wiki/Backyard_Worlds); [NASA 2026](https://science.nasa.gov/get-involved/citizen-science/nasa-volunteers-double-known-population-of-brown-dwarfs/)
  - The related professional unWISE search found no detection, with a 90%-completeness limit of W1 < 16.7 over more than ¾ of the sky. That search used four years of WISE observations spanning seven years — [Meisner et al. 2018 AJ, arXiv:1712.04950](https://web3.arxiv.org/abs/1712.04950)
  - The 2017 paper cites models in which Planet 9 could be W1 ≈ 16.1 and W2 ≈ 17.2. It estimates the BYW W1 sensitivity at ~16.2 and puts the coadd limits at W1 16.5 / W2 15.5 — [Kuchner et al. 2017](https://arxiv.org/html/1705.02919.pdf)
  - The FAQ admits Planet 9 "may be too faint" for WISE — [BYW FAQ](https://www.zooniverse.org/projects/marckuchner/backyard-worlds-planet-9/about/faq)

### Inferences
- The project's lasting science came from a by-catch (brown dwarfs), not from its headline target. A SPHEREx Planet X tool should be designed so that "nearby cool objects, high-proper-motion stars and asteroids" are valid and celebrated results, not failures.

### Gaps
- I did not find a quantitative statement from BYW itself (as opposed to Meisner 2018) giving Planet 9 exclusion as a distance or mass limit.

## 5. Spin-offs and related projects

### Takeaway
Cool Neighbors (2023) is the clearest evolution of the design. It uses ML-preselected candidates in small 2′×2′ un-differenced cutouts on an inverted (white-sky) colour scale and a single yes/no question, and it was about 3× faster per classification. A "Backyard Worlds: Binaries" project ran around 2025 and is now closed.

### Cited Findings
- **Backyard Worlds: Cool Neighbors**:
  - Launched 27 Jun 2023 by NSF NOIRLab, with NASA Citizen Science Seed Funding.
  - Targets Y dwarfs, using nine years of WISE data.
  - Subjects are centred on SMDET candidates and are 2×2′, about 35× less sky than a Planet 9 subject.
  - No difference imaging; inverted greyscale with white sky.
  - About 10× fewer subjects are needed.
  - Volunteers answer whether they see a mover, and may say "yes" for off-centre movers.
  - The team expected several hundred to 1,000 new brown dwarfs.
  - [Meisner et al. 2024 CSTP](https://theoryandpractice.citizenscienceassociation.org/articles/10.5334/cstp.737); [BYW blog launch post](https://blog.backyardworlds.org/2023/06/27/backyard-worlds-cool-neighbors-explore-the-mysteries-of-extreme-brown-dwarfs/); [Zooniverse Cool Neighbors about](https://www.zooniverse.org/projects/coolneighbors/backyard-worlds-cool-neighbors/about); [Gemini/NOIRLab announcement](https://gemini.edu/news/announcements/ann23020)
- The Cool Neighbors FAQ says the Planet 9 interface was "not ideal in finding faint brown dwarfs" — [Wikipedia citing CN FAQ](https://en.wikipedia.org/wiki/Backyard_Worlds)
- **Backyard Worlds: Binaries**: a Zooniverse project with roughly the same team (Meisner, Hartman, Rothermich, Schneider, Faherty, Kirkpatrick, Caselden, Dey, Gizis). An intern joined in summer 2025. It is now marked "Finished … out of data" — [Zooniverse Binaries team page](https://www.zooniverse.org/projects/coolneighbors/backyard-worlds-binaries/about/team)

### Inferences
- The Planet 9 → Cool Neighbors move is a tested result: pre-ranking candidates and showing small, centred cutouts with a binary question raises speed and depth of engagement. The trade-off is that targeting can miss truly unexpected objects. The Accident was found off the beaten path, by custom software.

### Gaps
- I did not research Active Asteroids, Kilonova Seekers or "Planet 9 in other surveys" in this pass, so there is nothing here on which of their interfaces were praised.

## 6. Feature lessons for a SPHEREx-based "Planet X" tool

### Takeaway
Copy WiseView's controls, Backyard Worlds' artifact field guide and colour-encodes-physics idea, Cool Neighbors' centred-candidate quick mode, and the credit-and-vetting pipeline. Each lesson below is linked to the evidence above.

### Cited Findings (each lesson tied to evidence)
- **Multi-epoch blink with speed control and frame stepping.** WiseView's Speed slider, and the FAQ's rule that a mover must appear in all frames, imply users need to step frame by frame as well as loop — [WiseView post](https://blog.backyardworlds.org/2017/09/13/wiseview/); [FAQ](https://www.zooniverse.org/projects/marckuchner/backyard-worlds-planet-9/about/faq)
- **Stretch and contrast controls.** WiseView offers an asinh stretch parameter, Trim Bright and fixed/percent clipping, and the BYW flipbooks themselves use an arcsinh stretch — [WiseView post](https://blog.backyardworlds.org/2017/09/13/wiseview/); [Kuchner 2017](https://arxiv.org/html/1705.02919.pdf)
- **Difference-image mode alongside raw mode.** Planet 9 used difference images; Cool Neighbors used raw, inverted images and ran faster. Offer both, plus colour inversion for accessibility — [CSTP 2024](https://theoryandpractice.citizenscienceassociation.org/articles/10.5334/cstp.737); [Kuchner 2017](https://arxiv.org/html/1705.02919.pdf)
- **Physically meaningful band colouring.** In BYW, W2-bright (methane) objects show red, and the FAQ teaches colour as a clue to Planet 9's methane state. SPHEREx's spectral channels could be mapped to an RGB "methane / CO band" composite in the same way — [FAQ](https://www.zooniverse.org/projects/marckuchner/backyard-worlds-planet-9/about/faq)
- **Adjustable FOV, any coordinate, shareable links.** Users want to follow fast movers out of the cutout — [FAQ](https://www.zooniverse.org/projects/marckuchner/backyard-worlds-planet-9/about/faq)
- **Cross-survey side panel and overlays.** WiseView's Pan-STARRS panel, the Legacy viewer, IRSA Finder Chart (DSS/2MASS/WISE epochs), and AstroToolBox's catalog overlays — [WiseView post](https://blog.backyardworlds.org/2017/09/13/wiseview/); [FAQ](https://www.zooniverse.org/projects/marckuchner/backyard-worlds-planet-9/about/faq); [blog](https://blog.backyardworlds.org/)
- **One-click catalog checks** (SIMBAD 1′ cone, VizieR proper motions above 100 mas/yr, Gaia). Automate the "is it already known?" step before a user submits — [FAQ](https://www.zooniverse.org/projects/marckuchner/backyard-worlds-planet-9/about/faq)
- **Marking tool, hashtags and discussion per subject.** Crosshairs in every frame, #mover/#dipole tags and a Talk page — [Kuchner 2017](https://arxiv.org/html/1705.02919.pdf)
- **Artifact field guide with examples:** ghosts (appear in only 2 frames), pointing-jitter dipoles, diffraction spikes, latents/persistence, partly subtracted variables, data gaps, SAA noise — [FAQ](https://www.zooniverse.org/projects/marckuchner/backyard-worlds-planet-9/about/faq); [Kuchner 2017](https://arxiv.org/html/1705.02919.pdf); [blog](https://blog.backyardworlds.org/)
- **Speed heuristics built in.** For example, a pixel-shift to mas/yr readout, and a hint like "too fast for a star → Solar System object?" — [SIMBAD post](https://blog.backyardworlds.org/2017/03/01/getting-started-with-simbad/); [how-to category](https://blog.backyardworlds.org/category/how-to-use-backyardworlds-org/)
- **Candidate report form plus a vetting queue with credit.** "Think You've Got One?" → team review → follow-up, and discoverers become co-authors — [CSTP 2024](https://theoryandpractice.citizenscienceassociation.org/articles/10.5334/cstp.737); [NASA 2026](https://science.nasa.gov/get-involved/citizen-science/nasa-volunteers-double-known-population-of-brown-dwarfs/)
- **ML pre-ranking framed as "the machine shortlists, humans decide".** Advanced volunteers mostly accept this — [CSTP 2024](https://theoryandpractice.citizenscienceassociation.org/articles/10.5334/cstp.737)
- **Power-user path.** Gini above 0.8 means a few users do most of the work, so give them APIs, batch tools, larger FOVs and a forum. The best BYW tools (WiseView, SMDET, AstroToolBox) were built by volunteers — [CSTP 2024](https://theoryandpractice.citizenscienceassociation.org/articles/10.5334/cstp.737); [WiseView post](https://blog.backyardworlds.org/2017/09/13/wiseview/)

### Inferences
- **Two-tier UX.** Offer a quick "is something moving here? yes/no" mode on centred, pre-ranked cutouts for the public (the Cool Neighbors model), and a full "WiseView-style" explorer for amateurs and serious users.
- **Seeded known movers or synthetic injections** in the beginner queue could shorten the "about 60 classifications before a find" stretch and train artifact recognition. SMDET was itself trained on injections.
- **Celebrate by-catch.** BYW's real yield was brown dwarfs, so a SPHEREx tool should credit finds of high-proper-motion stars, cool dwarfs, variables and asteroids, not only "Planet X".
- **SPHEREx caveat to verify separately:** SPHEREx has coarser pixels than WISE and fewer revisits per sky position over its mission. This means far fewer epochs than unWISE's ~13+. Expect slow "dipole-like" motion rather than clean movers, and plan to blink SPHEREx against WISE/unWISE epochs for long baselines. These SPHEREx specifics are not sourced in these notes.

### Gaps
- No direct volunteer feedback (Talk threads) about specific UI pain points, such as blink speed defaults or mobile use, was retrievable.
- I found no information on gamification (badges, leaderboards) in BYW. Zooniverse generally avoids leaderboards, but I did not source this.
