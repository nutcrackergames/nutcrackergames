/* Level 1 - Hello, Idiots
   Teaches: running, jumping, springs, the HEAD BOOST and pressure plates. */
(function () {
  const G = 560;                       // ground height used by every level
  registerLevel({
    name: 'Hello, Idiots',
    theme: 'meadow',                   // meadow | beach | sky | candy
    width: 2800,
    top: 0,                            // highest y the camera may show (negative = higher)
    hint: 'Stand on your partner\'s head and jump to get over the door. Then stand on the far plate to open it for them!',

    solids:  [[0, G, 700, 160], [820, G, 520, 160], [1460, G, 1340, 160],      // [x, y, width, height]
              [1000, G - 100, 120, 20], [1560, G - 110, 110, 20]],
    spikes:  [[1800, G - 16, 90, 16]],
    plates:  [{ id: 'a', x: 2200, y: G - 6, w: 90 }],
    doors:   [{ ids: ['a'], x: 2100, y: G - 185, w: 36, h: 185 }],
    springs: [{ x: 250, y: G - 14, w: 44, power: 19 }],
    stars:   [[430, G - 70], [1060, G - 150], [1400, G - 130], [1615, G - 170], [2118, G - 228], [272, G - 300]],
    checkpoints: [{ x: 900, y: G - 60 }, { x: 1500, y: G - 60 }, { x: 2000, y: G - 60 }],
    exit: [2560, G - 110, 80, 110]
  });
})();
