# Constellation discovery with the SphereX spacecraft

## Experience

Add a constellation layer to **Catalog Flight**. As the user steers the existing spacecraft, faint constellation lines and names help them navigate. Hovering over Monoceros reveals its unicorn illustration. Orion gets the same treatment. Clicking or tapping pins the selection, and a keyboard-accessible **Sky objects** list offers the same selection and actions. Use the screenshot as an interaction reference and source the artwork separately.

## Sky overlays

- Show all 88 constellation names and their available line figures, with illustrations for Monoceros and Orion in the first release. Add a **Constellations** toggle and a **Find Monoceros** entry that turns the ship toward the reference field. Show nearby named stars such as Betelgeuse and Procyon as individually selectable targets.
- Bundle Stellarium’s Modern line data and two illustrations with their respective credits and license notices. Resolve the Hipparcos star IDs to sky coordinates at build time. Use the supplied star anchors to align the artwork, and render it with the lines on the same distant sky sphere as the backdrop. The overlays track camera rotation and stay aligned as the ship moves. [Stellarium data and anchors](https://github.com/Stellarium/stellarium/blob/master/skycultures/modern/index.json) · [Stellarium credits and licenses](https://github.com/Stellarium/stellarium/blob/master/skycultures/modern/description.md#license)
- Prioritize a nearby star marker over a constellation when both are under the pointer. Hover previews the target, and click or tap pins it. A drag steers the ship. Pinning a constellation reveals its figure, while pinning a star or selecting a sky point enables **View SPHEREx observations**.

## Spacecraft and verification

- Reuse the existing spacecraft and steering in Catalog Flight. Keep the constellation layer tied to the Earth-referenced sky so the figures remain useful as navigation landmarks. For a matched Gaia star with a usable distance, keep the existing **Approach** action.
- **View SPHEREx observations** passes the selected RA and Dec, display name, and marker to the existing observation search. Once frames are available, **Explore in 3D → Fly to marker** uses the same spacecraft model for the guided approach. Keep the camera and marker fixed during time-lapse, blink, and difference, with the constellation layer out of the evidence view. If the archive has no coverage or the search fails, show the existing status and retry controls.

## Acceptance checks

- Steer to Monoceros, reveal its artwork on hover, and verify it stays aligned through camera rotation and resize. Check Orion, a line-only figure, and a figure that crosses RA zero.
- Pin a target with mouse, touch, and keyboard. Confirm that steering gestures and hover alone trigger no searches.
- Follow a pinned star into the SPHEREx viewer, verify that its coordinates and marker carry through, and compare two dated frames after the guided approach. Check the no-coverage path, reduced-motion behavior, and the existing 2D fallback.
