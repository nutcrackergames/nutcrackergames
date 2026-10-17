/* Level 3 - Heavy Lifting
   Teaches: CRATES. Heavy crates (steel) only move when BOTH idiots push the same way.
   A crate sitting on a plate keeps the door open. A crate against a wall makes a step. */
(function () {
  const G = 560;
  registerLevel({
    name: 'Heavy Lifting',
    theme: 'candy',
    width: 3100,
    top: 0,
    hint: 'Both of you push the steel crate the same way. Park it on the plate to hold the door open!',

    solids: [[0, G, 1900, 160],
             [1900, G - 210, 1200, 370]],
    spikes: [[1250, G - 16, 100, 16]],
    plates: [{ id: 'a', x: 960, y: G - 6, w: 100 }],
    doors:  [{ ids: ['a'], x: 1100, y: G - 185, w: 36, h: 185 }],
    crates: [{ x: 640, heavy: true },            // y is optional, defaults to sitting on the ground
             { x: 1500, heavy: true }],
    stars:  [[350, G - 80], [820, G - 110], [1300, G - 100], [1650, G - 130], [1872, G - 140], [2200, G - 280], [2600, G - 280], [3000, G - 280]],
    checkpoints: [{ x: 1150, y: G - 60 }, { x: 2000, y: G - 270 }],
    exit: [2800, G - 320, 80, 110]
  });
})();
