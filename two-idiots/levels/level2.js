/* Level 2 - Hold My Hand
   Teaches: HAULING (both hold E to pull a partner up), TOSS (partner under you presses E),
   and bridge lifts powered by plates. */
(function () {
  const G = 560;
  const A = G - 190;                   // ledge A + B height
  const C = G - 440;                   // tall ledge C height
  registerLevel({
    name: 'Hold My Hand',
    theme: 'beach',
    width: 3000,
    top: -80,
    hint: 'Boost one idiot onto the ledge, then BOTH hold E next to each other to pull the other one up. For the tall wall: stand on a head and your partner taps E to TOSS you!',

    solids: [[0, G, 900, 160],
             [900, A, 500, 350],        // ledge A
             [1700, A, 600, 350],       // ledge B
             [2300, C, 600, 600]],      // tall ledge C
    spikes: [[1950, A - 16, 100, 16]],
    plates: [{ id: 'L', x: 1290, y: A - 6, w: 80 },
             { id: 'L', x: 1730, y: A - 6, w: 80 }],
    lifts:  [{ ids: ['L'], x: 1450, w: 200, h: 20, y0: 620, y1: A, speed: 2.4 }],
    stars:  [[500, G - 80], [1000, A - 80], [1550, A - 60], [1950, A - 90], [2200, A - 80], [2500, C - 70], [2700, C - 70]],
    checkpoints: [{ x: 1000, y: A - 60 }, { x: 1760, y: A - 60 }, { x: 2350, y: C - 60 }],
    exit: [2750, C - 110, 80, 110]
  });
})();
