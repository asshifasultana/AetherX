# SphereX

## Object-name lookup

Choose **Object name**, enter one common name (such as `Sirius`) or catalog identifier (such as `M31`), and choose **Resolve**. Review the returned identifier, full-precision RA/Dec, ICRS frame, catalog resolver, and retrieval time. **Use this target** applies that position and starts the existing IRSA observation search with the current filters. Resolving alone does not change your target or results.

The backend uses [CDS Sesame](https://tapvizier.cds.unistra.fr/vizier/doc/sesame.htx), querying SIMBAD, then NED, then VizieR until a position is found. If Sesame fails or takes longer than two seconds, lookup falls back to the independently hosted [SIMBAD Harvard mirror](https://simbad.cfa.harvard.edu/simbad/). Both requests share a 10-second overall deadline, within the 15-second Vercel function limit. The interface names the service that actually supplied the coordinates. The mirror's ICRS sexagesimal coordinates are converted to degrees without display rounding. An authoritative Sesame miss remains a 404; a mirror-only miss while Sesame is unavailable is a service error, since NED/VizieR coverage could not be checked. Successful responses are cached for 24 hours in a bounded, 200-entry process-local cache. Cache reuse depends on the server or function instance remaining warm. Failures are not cached.

`GET /api/resolve-object?name=…` returns `submittedName`, optional `resolvedName` (null when unavailable), `raDeg`, `decDeg`, `frame`, `source`, and `retrievedAt`. Errors distinguish invalid input (400), unrecognized names (404), upstream failures (502), and timeouts (504). Enter a single name of at most 200 characters; control characters, ampersands, semicolons, and repeated name parameters are rejected. The supplied local server and Vercel deployment both serve this endpoint.

For unrecognized names, the interface offers up to three spelling suggestions from a name-only list of 20 familiar objects and aliases, including the five presets. Matching ignores case and punctuation, requires at least four normalized characters, and allows one edit for four–seven characters or two edits for longer names. Swapping adjacent letters counts as one edit (for example, `Siruis` suggests Sirius). Suggestions are limited to that list; the live resolver supports other identifiers. Choosing a suggestion performs another live lookup and still requires confirmation. A resolver outage is reported separately from an unrecognized name; presets and manual coordinates remain available.

Successful name resolution establishes a catalog position, not SPHEREx coverage or a source detection. IRSA searches determine available observations separately. Catalog-derived positions retain their returned precision and provenance; preset coordinates and their scheduled index are unchanged.

### Future consideration: tracking stellar motion

This release uses fixed catalog positions interpreted in ICRS. It does not propagate positions to observation dates or provide Solar System ephemerides. A catalog coordinate system or J2000 label does not by itself establish the position's reference epoch.

For stars with substantial proper motion, such as Barnard’s Star and WISE 0855, future work should retrieve proper-motion measurements, their conventions and uncertainties, and the position's reference epoch. Calculate positions for each observation date, incorporating parallax and radial velocity where available and appropriate. Adapt archive searches to cover the object's changing position, center cutouts at the calculated locations, and update markers and time-lapse alignment. Missing motion or epoch data must be shown explicitly rather than treated as zero motion. This would improve small-cutout centering and tracking across dates, but requires separate scientific validation.

## FITS cutouts and aligned display

Open an observation's **Details** row in the search results and choose **View aligned cutout**. The app asks IRSA's IBE for a target-centered SPHEREx MEF cutout, keeps successful cutouts in the server's temporary cache for up to seven days, and leaves failed requests uncached so they can be retried.

The browser reads the science image HDU and reprojects each observation from its FITS celestial WCS onto a common north-up, east-left grid centered on the selected target. The selected square field of view is therefore consistent when switching observations. Rendering uses the image data and display stretch controls; the delivered cutout retains the other FITS HDUs for later processing.

Run the app locally with `npm run dev` from this repository. The local cache lives in the operating system temporary directory and may be cleared by the OS. Vercel function instances also have ephemeral storage, so their cache is reused while an instance remains warm.uuuuu
