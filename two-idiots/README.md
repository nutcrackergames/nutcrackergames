# Two Idiots – level files

Every level is one small JavaScript file in this folder.

## Add a new level
1. Copy `level1.js` to `level6.js` and edit the numbers.
2. Open `manifest.js` and add `'levels/level6.js'` to the list. Levels play in list order.
3. Re-upload the folder. No other file needs to change.

## Level format
All numbers are pixels. **x grows to the right, y grows DOWN.** Ground height `G = 560`.

| key | meaning |
|---|---|
| `name`, `hint` | title and the tip shown at the start |
| `theme` | `meadow`, `beach`, `sky` or `candy` |
| `width` | level length. `top`: highest y the camera may show (use a negative number for tall levels) |
| `solids` | `[x, y, w, h]` blocks. Height 24 or less is drawn as a wooden plank |
| `spikes` | `[x, y, w, h]` deadly zones (use `h: 16`) |
| `plates` | `{ id, x, y, w }` pressed by an idiot or a crate standing on it. `y` is the top of the plate (floor - 6) |
| `doors` | `{ ids:['a'], x, y, w, h }` open while **all** listed plate ids are pressed. `y` is the top of the door |
| `lifts` | `{ ids:['L'], x, w, h, y0, y1, speed }` rise from `y0` to `y1` while **any** listed plate is pressed |
| `springs` | `{ x, y, w, power }` mushroom trampolines (power 19 is about 300px high) |
| `crates` | `{ x, y?, heavy }` heavy crates need BOTH idiots pushing |
| `launchers` | `{ x, y, w, power, lever:{x,y} }` pad launches whoever stands on it when the partner pulls the lever (E) |
| `stars` | `[x, y]` collectibles |
| `checkpoints` | `{ x, y }` respawn points (y = where the idiot reappears) |
| `exit` | `[x, y, w, h]` goal. Both idiots must stand in it |

## Cheat sheet for what the idiots can do
* Run 4.6px per tick, jump about **160px** high.
* Head boost (stand on partner, jump): about **200px**.
* Toss (partner under you presses E): about **320px** from the ground.
* Haul (both hold E, one standing above): up to **340px**.
* Launcher with `power: 22`: about **400px** (hold RIGHT / LEFT while flying).
* Normal jump gap: up to about **150px** wide. Bigger gaps need a lift or bridge.
