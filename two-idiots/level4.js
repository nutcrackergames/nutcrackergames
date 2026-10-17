/* Level 4 - Launch Control
   Teaches: the LAUNCHER. Stand on the orange pad (hold right while flying!) while your partner
   pulls the far LEVER with E. Then hold the plate up top so the lift can bring them up. */
(function () {
  const G = 560;
  const T = 230;                        // cliff top
  registerLevel({
    name: 'Launch Control',
    theme: 'sky',
    width: 2900,
    top: 0,
    hint: 'One of you stands on the orange pad. The other runs to the lever and presses E. Hold RIGHT while you fly!',

    solids: [[0, G, 900, 160],
             [900, T, 700, 490],
             [1900, T, 900, 490]],
    spikes: [[1250, T - 16, 100, 16]],
    plates: [{ id: 'U', x: 1000, y: T - 6, w: 80 },       // holds the lift up
             { id: 'B', x: 1500, y: T - 6, w: 80 },       // bridge plates
             { id: 'B', x: 1960, y: T - 6, w: 80 }],
    lifts:  [{ ids: ['U'], x: 760, w: 120, h: 20, y0: G, y1: T, speed: 2.5 },
             { ids: ['B'], x: 1650, w: 200, h: 20, y0: 620, y1: T, speed: 2.4 }],
    launchers: [{ x: 640, y: G, w: 100, power: 22, lever: { x: 250, y: G } }],
    stars:  [[300, G - 80], [790, 230], [1000, T - 70], [1300, T - 80], [1750, T - 110], [2100, T - 70], [2400, T - 70]],
    checkpoints: [{ x: 960, y: T - 60 }, { x: 1950, y: T - 60 }],
    exit: [2650, T - 110, 80, 110]
  });
})();
