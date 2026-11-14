"""Build the challenge requirements + implementation record DOCX.

Kept in the workspace so the document can be regenerated after further work.
Run with the bundled runtime:
  <python> build_docs.py
"""

from docx import Document
from docx.enum.section import WD_SECTION
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Inches, Pt, RGBColor

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "docs" / "SPHEREx_Challenge_Documentation.docx"
SHOTS = ROOT / "docs" / "screenshots"

INK = RGBColor(0x1F, 0x33, 0x30)
MUTED = RGBColor(0x5C, 0x6B, 0x64)
ACCENT = RGBColor(0x2F, 0x5E, 0x52)
WARN = RGBColor(0x8A, 0x4A, 0x1E)

doc = Document()

# ---- page setup -------------------------------------------------------------
for section in doc.sections:
    section.top_margin = Inches(0.9)
    section.bottom_margin = Inches(0.9)
    section.left_margin = Inches(1.0)
    section.right_margin = Inches(1.0)

styles = doc.styles
normal = styles["Normal"]
normal.font.name = "Calibri"
normal.font.size = Pt(10.5)
normal.font.color.rgb = INK
normal.paragraph_format.space_after = Pt(7)
normal.paragraph_format.line_spacing = 1.12

for name, size, color, before, after in [
    ("Heading 1", 15, ACCENT, 18, 7),
    ("Heading 2", 12, INK, 13, 5),
    ("Heading 3", 10.5, ACCENT, 10, 4),
]:
    style = styles[name]
    style.font.name = "Calibri"
    style.font.size = Pt(size)
    style.font.color.rgb = color
    style.font.bold = True
    style.paragraph_format.space_before = Pt(before)
    style.paragraph_format.space_after = Pt(after)
    style.paragraph_format.keep_with_next = True

for name in ("List Bullet", "List Number"):
    style = styles[name]
    style.font.name = "Calibri"
    style.font.size = Pt(10.5)
    style.paragraph_format.space_after = Pt(3)


def shade(cell, hex_fill):
    element = OxmlElement("w:shd")
    element.set(qn("w:val"), "clear")
    element.set(qn("w:fill"), hex_fill)
    cell._tc.get_or_add_tcPr().append(element)


def para(text="", style=None, bold=False, italic=False, size=None, color=None, align=None):
    p = doc.add_paragraph(style=style)
    run = p.add_run(text)
    run.bold = bold
    run.italic = italic
    if size:
        run.font.size = Pt(size)
    if color:
        run.font.color.rgb = color
    if align:
        p.alignment = align
    return p


def rich(parts, style=None):
    """parts: list of (text, bold, italic) tuples in one paragraph."""
    p = doc.add_paragraph(style=style)
    for text, bold, italic in parts:
        run = p.add_run(text)
        run.bold = bold
        run.italic = italic
    return p


def code(lines):
    for index, line in enumerate(lines):
        p = doc.add_paragraph()
        p.paragraph_format.space_after = Pt(0 if index < len(lines) - 1 else 8)
        p.paragraph_format.space_before = Pt(6 if index == 0 else 0)
        p.paragraph_format.left_indent = Inches(0.18)
        run = p.add_run(line)
        run.font.name = "Consolas"
        run.font.size = Pt(9)
        run.font.color.rgb = RGBColor(0x24, 0x3A, 0x37)


def bullets(items):
    for item in items:
        if isinstance(item, tuple):
            p = doc.add_paragraph(style="List Bullet")
            run = p.add_run(item[0])
            run.bold = True
            p.add_run(item[1])
        else:
            doc.add_paragraph(item, style="List Bullet")


def table(headers, rows, widths, header_fill="2F5E52"):
    t = doc.add_table(rows=1, cols=len(headers))
    t.style = "Table Grid"
    t.alignment = WD_TABLE_ALIGNMENT.CENTER
    t.autofit = False
    head = t.rows[0].cells
    for i, text in enumerate(headers):
        head[i].text = ""
        p = head[i].paragraphs[0]
        run = p.add_run(text)
        run.bold = True
        run.font.size = Pt(9.5)
        run.font.color.rgb = RGBColor(0xFF, 0xFF, 0xFF)
        shade(head[i], header_fill)
    for row_index, row in enumerate(rows):
        cells = t.add_row().cells
        for i, value in enumerate(row):
            cells[i].text = ""
            p = cells[i].paragraphs[0]
            p.paragraph_format.space_after = Pt(2)
            run = p.add_run(str(value))
            run.font.size = Pt(9.5)
            if i == 0:
                run.font.name = "Consolas"
                run.font.size = Pt(9)
            if row_index % 2 == 1:
                shade(cells[i], "F3F6F1")
    for row in t.rows:
        for i, width in enumerate(widths):
            row.cells[i].width = Inches(width)
    # Setting cell widths alone is not enough: Word and LibreOffice lay a fixed
    # table out from tblGrid, so the grid columns must carry the same widths or
    # the columns are distributed by content instead.
    for grid_column, width in zip(t._tbl.tblGrid.gridCol_lst, widths):
        grid_column.w = Inches(width)
    # Keep the header with its first data row so it is never orphaned at a page
    # break, repeat it when the table spans pages, and stop rows splitting.
    header_row = t.rows[0]
    header_props = header_row._tr.get_or_add_trPr()
    repeat = OxmlElement("w:tblHeader")
    repeat.set(qn("w:val"), "true")
    header_props.append(repeat)
    for cell in header_row.cells:
        for p in cell.paragraphs:
            p.paragraph_format.keep_with_next = True
    for row in t.rows:
        props = row._tr.get_or_add_trPr()
        props.append(OxmlElement("w:cantSplit"))
    doc.add_paragraph().paragraph_format.space_after = Pt(2)
    return t


def note(text, color=WARN):
    p = doc.add_paragraph()
    p.paragraph_format.left_indent = Inches(0.15)
    p.paragraph_format.space_before = Pt(4)
    run = p.add_run(text)
    run.font.size = Pt(9.5)
    run.italic = True
    run.font.color.rgb = color
    return p


def caption(text):
    p = doc.add_paragraph()
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    p.paragraph_format.space_after = Pt(10)
    run = p.add_run(text)
    run.font.size = Pt(9)
    run.italic = True
    run.font.color.rgb = MUTED


# =============================================================================
# Cover
# =============================================================================
title = doc.add_paragraph()
title.paragraph_format.space_after = Pt(2)
run = title.add_run("SPHEREx Sky Atlas")
run.font.size = Pt(26)
run.font.bold = True
run.font.color.rgb = ACCENT

subtitle = doc.add_paragraph()
subtitle.paragraph_format.space_after = Pt(14)
run = subtitle.add_run("Challenge requirements and implementation record")
run.font.size = Pt(14)
run.font.color.rgb = MUTED

table(
    ["", ""],
    [
        ["Event", "NASA Space Apps Challenge 2026"],
        ["Challenge", "Planet X and SPHEREx (slug: planet-x-and-spherex)"],
        ["Category / skills", "Advanced · Astrophysics, Planets & Moons, Software"],
        ["Hackathon", "Saturday 14 – Sunday 15 November 2026"],
        ["Submission window", "Opens Sat 14 Nov 09:00, closes Sun 15 Nov 23:59 local time"],
        ["Challenge resources", "Published Friday 13 November 2026"],
        ["Document written", "5 November 2026 (9 days before the event)"],
        ["Repository", "SphereX/ (git, branch master)"],
        ["Scope of this record", "Shareable URLs and the embeddable viewer"],
    ],
    [1.75, 4.75],
)
# The cover table has no meaningful header; blank the first row out.
cover = doc.tables[0]
for cell in cover.rows[0].cells:
    cell.text = ""
cover.rows[0]._tr.getparent().remove(cover.rows[0]._tr)

# =============================================================================
# 1. What the challenge asks for
# =============================================================================
doc.add_heading("1. What the challenge asks for", level=1)

doc.add_heading("1.1 The task in the brief's own terms", level=2)
para(
    "NASA's SPHEREx mission has been mapping the entire sky every six months since 2025 in 102 bands of "
    "near-infrared light, returning images of more than a billion objects. Comets, asteroids, stars, brown "
    "dwarfs and even new planets reveal themselves by shifting position between images, but no one person can "
    "sift through that data alone."
)
rich([
    ("The deliverable is a ", False, False),
    ("public-facing web tool", True, False),
    (" that displays images of the sky from the SPHEREx mission. A user enters the coordinates of a patch of "
     "sky (right ascension and declination). The tool displays a series of images of that patch ", False, False),
    ("like a little video", False, True),
    (", making it easy to spot moving objects.", False, False),
])

doc.add_heading("1.2 Why the problem matters", level=2)
para(
    "Asteroids and comets orbit the Sun. Nearby stars march across the sky as they orbit the Galaxy. Earth "
    "orbits the Sun too, so objects near us change their apparent positions. Watching for that motion is how "
    "Pluto was discovered and how hundreds of thousands of volunteers have since found asteroids, comets, stars "
    "and brown dwarfs through projects such as backyardworlds.org. Most known comets and brown dwarfs were "
    "found this way."
)
para(
    "SPHEREx is uniquely sensitive to objects rich in hydrogen, water, carbon dioxide, carbon monoxide and "
    "other molecules. There will be too much data for any one person, or even computer code, to fully "
    "comprehend, which is why the brief asks for creative tools that let as many people as possible pitch in."
)

doc.add_heading("1.3 Scored test targets", level=2)
para("The brief names five objects the tool must be demonstrated on. All five are already curated presets in the project.")
table(
    ["Target", "What it is", "Why it is in the brief"],
    [
        ["Barnard's Star", "Red dwarf, Ophiuchus", "Fastest proper motion of any nearby star"],
        ["Epsilon Indi B", "Brown-dwarf pair orbiting a star", "Faint substellar companions near a bright host"],
        ["WISE 0855", "Cold brown dwarf, Hydra", "Fast mover; coordinates given explicitly"],
        ["RW Aurigae", "Young stellar system, Auriga", "Variable, changes brightness between epochs"],
        ["R Draconis", "Variable star, Draco", "Long-period brightness variation"],
    ],
    [1.35, 2.45, 2.70],
)
rich([
    ("WISE 0855 is the only target with coordinates written into the brief: ", False, False),
    ("RA 08h55m10.831s, declination −7d14m42.53s", True, False),
    (" (133.795129° , −7.245147°), which is exactly what the app's preset uses.", False, False),
])

doc.add_heading("1.4 Potential considerations (optional, but they are what judges notice)", level=2)
para(
    "The brief marks these as optional. In practice they are the difference between a working demo and a strong "
    "submission, so they are listed here in full with the project's current status against each."
)
table(
    ["#", "Consideration from the brief", "Status in the project"],
    [
        ["1", "New data arrives fast; design so the tool is easy to update with the latest releases.",
         "Met. Live IRSA TAP queries plus a daily scheduled index; QR2/QR3 selectable."],
        ["2", "Display the 102 infrared bands; combine data per detector array; spectra on the fly (extra kudos).",
         "Partly. Six detector bands are selectable. Spectra are not exposed yet — but see §6.1, the data is already downloaded."],
        ["3", "Let users add together or subtract images taken at different times.",
         "Not implemented. The Difference and Deep stack buttons exist in the UI but do nothing."],
        ["4", "Let users choose the field of view; wider fields track faster sources at the cost of transfer time.",
         "Met. 5′ / 10′ / 16′ / 25′ presets."],
        ["5", "Overlay data from other telescopes such as Gaia or WISE.",
         "Not implemented."],
        ["6", "Query the tool by coordinates in the URL so it can be embedded elsewhere.",
         "Met. This document describes that work."],
        ["7", "Display metadata such as contamination flags.",
         "Met. FITS quality flags are read from the header and bad pixels can be masked."],
        ["8", "Look at public tools such as Astropy and Aladin (CDS).",
         "Partly. The app is self-contained; Aladin is not integrated."],
    ],
    [0.35, 2.85, 3.30],
)

doc.add_heading("1.5 What success has to look like on the day", level=2)
bullets([
    ("A public URL that works without a login. ", "Judges will open it on their own machine."),
    ("Five preset targets that each produce a timeline. ", "One search must not be enough; the sequence has to be visible and playable."),
    ("Motion that is actually visible. ", "Blink or subtract comparisons are the core Planet X workflow."),
    ("No dead controls. ", "Every visible button should do what its label says."),
    ("A clear provenance story. ", "Which archive, which release, what the metadata means."),
])

# =============================================================================
# 2. Where the project stood
# =============================================================================
doc.add_heading("2. Where the project stood before this work", level=1)
para(
    "The repository already contained a substantial working application, not a blank slate. This mattered for "
    "planning: the work below extends a tested codebase rather than starting over."
)
table(
    ["Area", "State before this change"],
    [
        ["Tests", "79 passing, covering observations, quality flags, caching, resource limits, FITS parsing"],
        ["Archive access", "IRSA TAP metadata queries, cached five minutes, with a daily index as outage fallback"],
        ["Images", "Target-centred FITS cutouts via IRSA IBE, WCS-reprojected to a shared north-up grid"],
        ["Playback", "Dated timeline with real-gap spacing, speed control, filmstrip, keyboard scrubbing"],
        ["Lookup", "Object name resolution through CDS Sesame with a SIMBAD mirror fallback"],
        ["Deployment", "Vercel and Railway, both with explicit asset allowlists"],
    ],
    [1.55, 4.95],
)
para(
    "Live verification before making changes confirmed the stack works end-to-end: a query for WISE 0855 "
    "returned 256 observations spanning 2025-05-05 to 2026-05-14 across all six detectors, and a real 5.4 MB "
    "FITS cutout downloaded successfully through the proxy."
)

# =============================================================================
# 3. What was requested
# =============================================================================
doc.add_heading("3. Scope requested for this iteration", level=1)
para(
    "The instruction was to build shareable URLs and an embeddable viewer that preserve the full observational "
    "context of a view:"
)
bullets([
    "Coordinates (right ascension and declination)",
    "Field of view",
    "Wavelengths (the detector band)",
    "Selected dates (the observation date range, and the frame being viewed)",
    "A marked source (a candidate object the user has identified)",
])
para(
    "This maps directly onto consideration 6 in the brief. It was chosen ahead of the other gaps because it is "
    "cheap relative to its scoring value, and because it makes every other feature demonstrable: a judge can be "
    "handed a link instead of a set of instructions."
)

# =============================================================================
# 4. What was built
# =============================================================================
doc.add_heading("4. What was built", level=1)

doc.add_heading("4.1 Architecture", level=2)
para(
    "Four new modules were added. The two that hold logic are deliberately DOM-free so they can be unit tested "
    "in Node, following the existing timelapse-core.js precedent in this repository."
)
table(
    ["File", "Responsibility", "DOM?"],
    [
        ["frontend/url-state.js",
         "The only module that decides what a link means. Encodes and decodes the view state, validates every "
         "field, and produces a change signature.",
         "No"],
        ["frontend/sky-projection.js",
         "The single canvas ↔ sky transformation. Used by both the renderer and the marker so they cannot drift.",
         "No"],
        ["frontend/share.js",
         "The state hub. Reads the URL once at import, follows the app's existing CustomEvents, and writes the "
         "address bar back through history.replaceState.",
         "Yes"],
        ["frontend/share-ui.js",
         "The controls: copy link, embed snippet, clear mark, the live summary line and the invalid-link notice.",
         "Yes"],
    ],
    [1.85, 3.90, 0.65],
)
para(
    "Placing this in a hub rather than in app.js was deliberate. The viewer already dispatches events such as "
    "sky:target-selected and sky:viewer-settings-changed; the hub listens to those rather than reaching into "
    "other modules, so no existing module had to learn about URLs."
)

doc.add_heading("4.2 URL parameters", level=2)
para(
    "Every field that describes where and when you are looking travels in the query string. Values equal to the "
    "default are omitted, so the default view produces a clean URL and a link carries only what the sender "
    "actually changed."
)
table(
    ["Parameter", "Meaning", "Format", "Omitted when"],
    [
        ["ra", "Right ascension, ICRS", "decimal degrees, 6 dp", "position is the default target"],
        ["dec", "Declination, ICRS", "decimal degrees, 6 dp", "position is the default target"],
        ["fov", "Field of view", "5 | 10 | 16 | 25 (arcmin)", "16"],
        ["band", "Detector / wavelength band", "1–6", "2"],
        ["from", "Observation range start", "YYYY-MM-DD", "unset"],
        ["to", "Observation range end", "YYYY-MM-DD", "unset"],
        ["at", "The dated frame being viewed", "YYYY-MM-DD", "no frame opened"],
        ["mra", "Marked source RA", "decimal degrees", "no source marked"],
        ["mdec", "Marked source declination", "decimal degrees", "no source marked"],
        ["target", "Curated target id, for the highlighted card", "slug", "custom or resolved position"],
        ["embed", "Compact embeddable layout", "1", "not embedded"],
    ],
    [0.85, 2.05, 1.55, 2.05],
)
para("Six decimal places is 0.0036 arcsec, far finer than a SPHEREx pixel (6.15 arcsec), so a shared link lands on the same patch of sky the sender was looking at.", italic=True, size=9.5, color=MUTED)

doc.add_heading("4.3 Validation: a bad link must not break the page", level=2)
para(
    "Hand-edited and truncated links are normal once people start sharing them. Rather than reject a link "
    "wholesale, each field is validated independently and falls back to its default, with the reason reported in "
    "a notice at the top of the page."
)
table(
    ["Input", "Behaviour"],
    [
        ["ra out of 0–360", "Wraps cyclically. RA is an angle, so 370 → 10 and −10 → 350."],
        ["dec beyond ±90", "Rejected with the whole position, since RA alone is meaningless. Default target used."],
        ["fov not in 5/10/16/25", "Rejected for that field only; default 16′ used, reason shown."],
        ["band outside 1–6", "Rejected for that field only; default D2 used, reason shown."],
        ["from = 2026-02-31", "Rejected. Impossible calendar dates are caught rather than silently rolled over."],
        ["from later than to", "Range cleared rather than inverted, with an explanation."],
        ["mra without mdec", "Mark dropped as a pair rather than half-applied."],
        ["unknown target id", "Ignored; the coordinates still apply."],
        ["garbage or empty query", "Default view."],
    ],
    [1.85, 4.65],
)

doc.add_heading("4.4 Restoring a shared view", level=2)
para("Opening a link performs this sequence:")
bullets([
    ("Decode and validate. ", "share.js decodes once at import, so every module sees the same validated state."),
    ("Seed the UI. ", "app.js sets the position, band and field of view; observations-ui.js fills the date inputs before any search runs."),
    ("Restore the destination. ", "On window load, after every module has attached its listeners, the restored target is published so the archive search fires."),
    ("Jump to the frame. ", "When observations arrive, the timeline selects the frame nearest the shared date."),
    ("Re-anchor the marker. ", "The saved source is projected into the new field of view and drawn."),
])
para(
    "A bare page deliberately keeps the old behaviour: nothing is searched until the visitor chooses a target. "
    "Only a link that carries a view restores one."
)
rich([
    ("Playback does not rewrite the URL. ", True, False),
    ("Frames reached by an autoplaying time-lapse are not recorded, so the address bar does not churn once per "
     "second. Only a frame the visitor explicitly opens updates the link. This is enforced in commitCutout, "
     "which dispatches sky:frame-shown only when the cutout was not a playback frame.", False, False),
])

doc.add_heading("4.5 The marked source", level=2)
para(
    "The brief is about spotting objects that move, so a tool that cannot record which object the user has "
    "just noticed is missing the point. Clicking the sky image drops a marker at the position under the cursor."
)
bullets([
    ("It is an absolute sky position, not a screen position. ", "It survives frame changes, band changes and new searches."),
    ("It re-anchors on every repaint. ", "As the field of view widens, the same sky position moves toward the centre, which is the visible proof the projection is correct."),
    ("It never silently disappears. ", "If the source falls outside the current field, the marker is clamped to the edge, dashed, and labelled outside field."),
    ("It clears cleanly. ", "The Clear mark button removes it from both the screen and the link."),
])
para(
    "The click handler converts the pointer position to canvas pixels, then to sky coordinates via canvasToSky. "
    "The renderer walks the same grid in the same direction with the same half-pixel convention, so a click "
    "lands exactly where the user pointed."
)
note(
    "Design note: the canvas has a fixed pixel grid (for example 156 × 156 at 16′) but a fluid CSS size. The "
    "marker is therefore positioned in percentages of the element box, which maps one-to-one onto canvas "
    "pixels and stays correct at every window size."
)

doc.add_heading("4.6 Embedding", level=2)
para(
    "Adding embed=1, or simply loading the page inside an iframe, switches to a compact layout that keeps the "
    "viewer and its timeline and hides the page chrome, the settings grid and the observation table. The "
    "is-embed class is applied by a small inline script in <head> so there is no flash of the full page before "
    "the module scripts run."
)
para(
    "The Embed this view button generates a ready-to-paste snippet for the current view, and the app sets no "
    "X-Frame-Options or frame-ancestors restriction, so the snippet works without further configuration."
)
code([
    '<iframe src="https://…/?ra=133.795129&dec=-7.245147&fov=16&band=3&mra=…&embed=1"',
    '        width="720" height="520" style="border:0;max-width:100%"',
    '        loading="lazy" title="SPHEREx sky viewer"></iframe>',
])

# =============================================================================
# 5. Files changed
# =============================================================================
doc.add_heading("5. Files changed", level=1)
table(
    ["File", "Change"],
    [
        ["frontend/url-state.js", "New. Encode, decode, validate, signature."],
        ["frontend/sky-projection.js", "New. canvasToSky, skyToCanvas, canvasSizeFor, angularSeparationArcsec."],
        ["frontend/share.js", "New. State hub, shareUrl(), embedSnippet(), isEmbedded, pending frame date."],
        ["frontend/share-ui.js", "New. Copy link, embed code, clear mark, summary, notices."],
        ["frontend/tests/url-state.test.js", "New. Round trips, defaults, invalid input, wraparound, signatures."],
        ["frontend/tests/sky-projection.test.js", "New. Round-trip over the whole canvas, handedness, scale, null safety."],
        ["frontend/app.js", "Seed position and settings from the link; publish the restored target on load; embed class."],
        ["frontend/observations-ui.js", "Fill date inputs from the link before searching; publish date edits."],
        ["frontend/fits-viewer.js", "Marker state, canvas click, positionMark, sky:frame-shown, clear handler."],
        ["frontend/timelapse.js", "Select the frame nearest the shared date once observations arrive."],
        ["frontend/index.html", "Share bar, embed panel, notice, marker element, head script, module tag."],
        ["frontend/styles.css", "Share, embed and marker styling."],
        ["frontend/server.mjs", "Register the four new modules in the asset allowlist."],
        ["scripts/build-vercel.mjs", "Register the four new modules in the build asset list."],
        ["frontend/tests/observations-ui.test.js", "Harness gains CustomEvent dispatch; two tests for URL-seeded dates."],
        ["README.md", "Feature documentation and the parameter contract."],
    ],
    [2.05, 4.45],
)
note(
    "Both server.mjs and build-vercel.mjs keep hand-maintained lists of public assets. A new frontend module "
    "must be added to both, or it will work locally and 404 in production. This is the most likely place to "
    "break a future change."
)

# =============================================================================
# 6. Verification
# =============================================================================
doc.add_heading("6. Verification", level=1)

doc.add_heading("6.1 Test suite", level=2)
para(
    "The suite grew from 79 to 107 tests, all passing. The 28 additions are 26 in the two new files plus two in "
    "the existing observations-UI harness."
)
para("The projection tests are the important ones. A round-trip test alone cannot catch a mirrored pair — both "
     "directions can be wrong in the same way and still agree. The handedness and scale assertions exist for "
     "that reason.", italic=True, size=9.5, color=MUTED)

doc.add_heading("6.2 Live browser verification", level=2)
para(
    "Testing was done against the running application in headless Chrome, driven through the DevTools protocol "
    "so real UI interactions could be exercised, not simulated."
)
table(
    ["Check", "Result"],
    [
        ["Default page", "No is-embed class; share summary populated; notice hidden."],
        ["Shared link, embed mode", "is-embed applied, WISE 0855 restored, D3 selected, 10′ selected, marked source restored."],
        ["Address bar follows UI", "Clicking D5 rewrote band=5; widening to 25′ rewrote fov=25."],
        ["Click to mark", "Wrote mra=133.784248&mdec=-7.240941; marker drawn at 62.90% / 44.98%."],
        ["Marker normalised on FOV change", "Clamped to its sky position, not its screen position."],
        ["Clear mark", "Removed both parameters from the link and hid the marker."],
        ["Frame restoration", "Link with at=2025-09-14 opened the nearest D3 frame, 10 Nov 2025."],
        ["Console", "No JavaScript errors."],
    ],
    [2.05, 4.45],
)

para("Marker position across field of view, for one fixed sky position, computed and then confirmed live:")
table(
    ["Field of view", "Canvas", "Left", "Top", "Meaning"],
    [
        ["5′", "49 px", "62.9%", "45.0%", "far from centre"],
        ["10′", "98 px", "56.4%", "47.5%", "moving in"],
        ["16′", "156 px", "54.05% (live 54.05%)", "48.42%", "matches prediction exactly"],
        ["25′", "244 px", "52.6%", "49.0%", "close to centre"],
    ],
    [1.15, 0.85, 1.75, 0.85, 1.90],
)

doc.add_heading("6.3 Date filtering", level=2)
para(
    "Because links now carry dates, the underlying filter was checked directly against the archive rather than "
    "assumed. It is precise."
)
table(
    ["Query (WISE 0855, D3)", "Count", "Returned range"],
    [
        ["no date filter", "45", "2025-05-05 → 2026-05-11"],
        ["2025-06-01 → 2026-01-31", "21", "2025-11-10 → 2025-12-13"],
        ["2025-12-01 → 2025-12-31", "3", "2025-12-12 → 2025-12-13"],
        ["2025-07-01 → 2025-07-31", "0", "none"],
        ["2026-03-01 → 2026-03-31", "0", "none"],
    ],
    [2.35, 0.75, 2.20],
)
para(
    "This also explains why some timelines look sparse: detector coverage of a given position is genuinely "
    "clustered in time, not evenly spread."
)

doc.add_heading("6.4 Screenshots", level=2)
FIGURES = [
    ("spherex-embed.png",
     "Embed mode at 16′: viewer and timeline only, marked source labelled with its sky coordinates."),
    ("spherex-share.png",
     "Full page restored from a link: WISE 0855, D3 band, marked source, 13-frame timeline."),
]
missing = []
for name, text in FIGURES:
    path = SHOTS / name
    if path.exists():
        doc.add_picture(str(path), width=Inches(5.2))
        doc.paragraphs[-1].paragraph_format.keep_with_next = True
        caption(text)
    else:
        missing.append(name)
if missing:
    para(
        "Screenshots not embedded: "
        + ", ".join(missing)
        + " missing from docs/screenshots/. Capture them and rebuild to include them.",
        italic=True, size=9.5, color=MUTED,
    )

# =============================================================================
# 7. Findings
# =============================================================================
doc.add_heading("7. Findings that are not yet fixed", level=1)
para(
    "These were observed while building and verifying the above. They are recorded here because they are the "
    "highest-value things to address next, not because they were part of this scope."
)

doc.add_heading("7.1 Every cutout already contains a spectral cube, and 91% of it is discarded", level=2)
para("Walking the HDUs of one real 16′ D3 cutout shows where the 5.4 MB actually goes:")
table(
    ["HDU", "Content", "Size"],
    [
        ["0", "Primary, empty", "2.9 KB"],
        ["1", "Science image, 156 × 156 float32", "98 KB"],
        ["2", "Uncertainty", "98 KB"],
        ["3", "Variance / flags", "98 KB"],
        ["4", "Additional plane", "98 KB"],
        ["5", "Spectral cube, 101 × 101 × 121 float32", "4.94 MB"],
        ["6", "WCS-WAVE binary table", "2.9 KB"],
    ],
    [0.55, 3.55, 1.00],
)
para(
    "HDU 5 is a full spectral cube of the central arcminute: 101 × 101 spatial pixels by 121 wavelength "
    "channels, and it is fully populated. A spectrum was extracted from it during testing and returns sensible "
    "values across the D3 band, roughly 1.03e-2 to 1.17e-2 in the archive's surface-brightness units."
)
rich([
    ("The brief awards extra kudos for generating spectra on the fly, and that capability is already in the "
     "bytes being downloaded on every single frame. ", True, False),
    ("The viewer currently reads only the science image HDU and throws the cube away. Exposing it costs no "
     "extra network transfer. Alternatively, stripping it from image-only requests would cut each frame by "
     "about 90%, which is the single biggest available speed-up.", False, False),
])

doc.add_heading("7.2 Five view modes are cosmetic", level=2)
para(
    "The settings panel offers Time-lapse, Blink, Difference, Motion trail and Deep stack, each with a "
    "description. Only Time-lapse exists. viewMode is stored and used to highlight buttons and print the "
    "description, but no rendering code reads it. The Label known asteroids checkbox behaves the same way: the "
    "setting is persisted and never used."
)
para(
    "For this challenge that is the most exposed gap, because Blink and Difference are exactly the Planet X "
    "moving-object workflow. A judge clicking Difference will see the button highlight and nothing else."
)

doc.add_heading("7.3 The projected grid puts east on the right", level=2)
para(
    "Measured on the shared grid at 16′: the left edge is RA 133.9286° and the right edge is RA 133.6617°, so "
    "right ascension decreases to the right. That places east on the right, which contradicts the "
    "north-up, east-left description in the README and the usual astronomical convention."
)
para(
    "This is pre-existing behaviour, not something introduced here, and the marker is consistent with it either "
    "way because both directions use the same transform. But an astronomer would notice a mirrored field "
    "immediately. The change is a sign in paintCanvas plus the matching sign in canvasToSky."
)

doc.add_heading("7.4 Each cutout is slow, which the demo must absorb", level=2)
para(
    "Measured from this network: 4′ took 24.9 s, 8′ took 20.3 s, and a 16′ request timed out at 120 s. Time to "
    "first byte is only 0.8 s, so this is throughput, not archive compute — roughly 200–250 KB/s for a 5.4 MB "
    "payload. During verification a first frame took 28–34 s and a cached one 2 s."
)
para(
    "A 20-frame movie is therefore around ten minutes of downloads from cold cache. The existing prefetch queue "
    "helps, but the demo needs frames warmed before anyone is watching, and the 90% payload reduction in §7.1 "
    "would help more."
)

doc.add_heading("7.5 The live archive query frequently falls back to the scheduled index", level=2)
para(
    "During testing, observation responses came back with kind: scheduled-index and fallback: true rather than "
    "a live TAP result. That is the outage path working as designed, but it means the live query was not "
    "succeeding. Re-verify on the venue network, and make sure the fallback is visibly labelled so it is never "
    "mistaken for live data."
)

doc.add_heading("7.6 Still missing from the brief's consideration list", level=2)
bullets([
    ("Image addition and subtraction. ", "Consideration 3, and the core motion-detection technique."),
    ("Gaia / WISE overlays. ", "Consideration 5."),
    ("Per-band display and combination. ", "Consideration 2, beyond the six detector groups."),
])

# =============================================================================
# 8. Next steps
# =============================================================================
doc.add_heading("8. Recommended next steps", level=1)
para("In priority order, given the nine days available:")
table(
    ["Priority", "Work", "Why"],
    [
        ["1", "Extract the HDU 5 cube and plot a spectrum for the pixel under the cursor.",
         "Explicit extra kudos, free bandwidth, strong differentiator."],
        ["2", "Make Blink and Difference real; remove or hide anything that does not work.",
         "The Planet X workflow, and it repairs a credibility gap."],
        ["3", "Cut image-only cutouts down by dropping the cube, or warm-cache the timeline before a demo.",
         "Turns a ten-minute first play into seconds."],
        ["4", "Decide on the east/west handedness and align the README with it.",
         "Judges are astronomers."],
        ["5", "URL-addressable everything else: view mode, stretch, contrast.",
         "Cheap once the hub exists."],
    ],
    [0.75, 2.85, 2.90],
)

doc.add_heading("8.1 Submission checklist", level=2)
bullets([
    "Deployed public URL that loads without a login",
    "All five scored targets demonstrably working, each with a playable timeline",
    "Embed snippet tested in a page on a different origin",
    "A short video walkthrough, since the archive latency is invisible on a pre-warmed cache",
    "Source and README in a public repository, with the asset-allowlist note intact",
])

# ---- core properties --------------------------------------------------------
core = doc.core_properties
core.title = "SPHEREx Sky Atlas — Challenge requirements and implementation record"
core.subject = "NASA Space Apps Challenge 2026 · Planet X and SPHEREx"
core.author = "Prepared for the NASA Space Apps 2026 submission"
core.keywords = "SPHEREx, NASA Space Apps, shareable URLs, embeddable viewer, IRSA"
core.comments = "Records the challenge brief, the shareable-link and embed work, verification, and open findings."

OUT.parent.mkdir(parents=True, exist_ok=True)
doc.save(str(OUT))
print("saved", OUT)
