// Scripted autopilot tours: fixed tool steps with fixed captions, played
// through the same viewer controller the AI guide uses. No model is involved,
// so a tour cannot stall or say something unmeasured on stage. Pure data.

export const TOURS = Object.freeze({
  highlights: {
    title: 'One-minute tour',
    steps: [
      { caption: 'Barnard’s Star: the fastest-moving star in our sky. I am holding the sky still so you can see it jump.', tool: 'go_to_target', args: { preset: 'barnard' } },
      { caption: 'Blinking the first and last SPHEREx photos — the star hops north while the background stays put.', tool: 'set_view_mode', args: { changes: { viewMode: 'blink', followProperMotion: false } } },
      { caption: 'Here is the jump, measured as a difference: orange is where it is now, blue where it was.', tool: 'compare_frames', args: { reference: 'first', view: 'difference' } },
      { caption: 'WISE 0855: one of the coldest objects known outside the Solar System, and a close neighbour.', tool: 'go_to_target', args: { preset: 'wise' } },
      { caption: 'It drifts about 2 arcminutes west of its 2013 discovery position. Blink to watch it.', tool: 'set_view_mode', args: { changes: { viewMode: 'blink', followProperMotion: false } } },
      { caption: 'Now the most probable patch of the predicted Planet Nine region (Brown & Batygin 2021).', tool: 'planet_nine_region', args: { top: 1, go: true } },
      { caption: 'Searching it for anything that changed between dates months apart.', tool: 'compare_frames', args: { reference: 'first', view: 'difference' } },
      { caption: 'Listing every compact change I can measure here.', tool: 'find_changes', args: { limit: 3 } }
    ],
    outro: 'That’s the tour. Ask me to investigate any spot, or try “Be Barnard”.'
  }
});

export const TOUR_IDS = Object.keys(TOURS);
