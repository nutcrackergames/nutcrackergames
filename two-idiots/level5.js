/* Level 5 - Idiot Olympics
   Everything together: crate + door, TOSS + HAUL up a tall wall, a bridge lift,
   and a LAUNCHER + lift to reach the exit in the clouds. */
(function () {
  const G = 560;
  const W = G - 280;                    // wall / ledge top (280)
  const P = -90;                        // final pillar top
  registerLevel({
    name: 'Idiot Olympics',
    theme: 'candy',
    width: 3800,
    top: -300,
    hint: 'Crate on the plate, toss and haul up the wall, bridge the gap, then launch and lift to the exit. Talk to each other!',

    solids: [[0, G, 1700, 160],
             [1700, W, 600, 440],                // wall + ledge
             [2600, W, 570, 440],                // ledge 3
             [3170, P, 700, 810]],               // final pillar
    spikes: [[1400, G - 16, 100, 16]],
    plates: [{ id: 'a', x: 1000, y: G - 6, w: 100 },
             { id: 'L', x: 2200, y: W - 6, w: 80 },
             { id: 'L', x: 2630, y: W - 6, w: 80 },
             { id: 'F', x: 3300, y: P - 6, w: 90 }],
    doors:  [{ ids: ['a'], x: 1150, y: G - 300, w: 36, h: 300 }],
    crates: [{ x: 650, heavy: true }],
    lifts:  [{ ids: ['L'], x: 2350, w: 200, h: 20, y0: 650, y1: W, speed: 2.4 },
             { ids: ['F'], x: 3070, w: 90, h: 20, y0: W, y1: P, speed: 2.5 }],
    launchers: [{ x: 2950, y: W, w: 100, power: 22, lever: { x: 2780, y: W } }],
    stars:  [[400, G - 80], [860, G - 100], [1450, G - 110], [1850, W - 70], [2150, W - 70], [2450, W - 120], [2850, W - 70], [3140, -135]],
    checkpoints: [{ x: 1300, y: G - 60 }, { x: 1800, y: W - 60 }, { x: 2680, y: W - 60 }, { x: 3250, y: P - 60 }],
    exit: [3500, P - 110, 80, 110]
  });
})();
