# Mudline

Low-poly war field shooter. The menu lists several rooms (default 4), each with up to 4 players, free-for-all, unlimited respawn.
Players pick a room (or tap Quick join). First player to the kill target wins the round in that room, then a new round starts automatically.

## Run it

```
npm install
npm start
```

Open http://localhost:3000 in several browser tabs or devices.

Settings (environment variables):

| Variable     | Default | Meaning                    |
|--------------|---------|----------------------------|
| `PORT`       | 3000    | HTTP + WebSocket port      |
| `KILL_LIMIT` | 20      | Kills needed to win a round |
| `ROOMS`      | 4       | Number of rooms (1 to 12)  |
| `MAX_PLAYERS`| 4       | Players per room (2 to 5)  |

Example: `KILL_LIMIT=30 ROOMS=6 PORT=8080 npm start`

Other constants (max players, respawn time, damage, spawn protection) are at the top of `server.js`.

## Hosting for other people

Multiplayer needs a running Node server, so static-only hosts (GitHub Pages, Netlify drop) can't run the game by themselves.

- **All-in-one (easiest):** deploy this folder to any Node host (Render, Railway, Fly.io, a VPS). It serves the page and the game from one URL. Use `wss://` automatically when the page is on https.
- **Page and server on different hosts:** put `public/index.html` on your site and open it with `?server=wss://your-game-server.example.com`, for example `https://mysite.com/game.html?server=wss://mudline.onrender.com`.

## Controls

W A S D move, Shift sprint, Space jump (sandbags and crates are climbable), C crouch (or slide while running), right mouse button or Z to scope (red dot sight), Q to switch between rifle and knife, mouse aim, click fire (hold for auto), R reload, Tab scoreboard, V mic. Every key can be changed under **Customize controls** on the menu.

On phones the touch controls appear automatically: left thumb moves (push to the edge to sprint), right thumb aims, and buttons fire, jump, crouch/slide, scope, switch weapon (Knife / Rifle) and reload. Play in landscape. Scope can be hold-to-scope or tap-to-toggle (your choice in **Customize controls**). There you can also drag and resize every button, change opacity, and set look sensitivity. Everything is saved in the player's own browser (localStorage).

## How it works

- Server is authoritative for hits, damage, kills, respawns and scoring. Movement is client-reported.
- Map layout lives in `server.js` (`BOXES`) and is sent to clients, so both sides use the same obstacles.
- Three.js is loaded from a CDN, so players need internet access.

## Voice chat

Built in. Each player picks "Mic on", "Listen only" or "Voice off" on the menu. Press V (or tap Mic on phones) to mute and unmute. Audio goes directly between players (WebRTC); the game server only passes the connection setup messages.

- Browsers only allow microphone access on **https** pages or on `localhost`. On Render (https) everyone can talk. When friends join a Termux server over `http://192.168.x.x:3000`, they can hear but not talk, unless they enable the Chrome flag `chrome://flags/#unsafely-treat-insecure-origin-as-secure` for that address.
- Use headphones, otherwise game sound leaks into your mic.
- If two players cannot hear each other (strict networks, mobile data), add a TURN server. Set the `ICE_SERVERS` environment variable to a JSON array, for example:
  `[{"urls":"stun:stun.l.google.com:19302"},{"urls":"turn:your-turn-host:3478","username":"USER","credential":"PASS"}]`

## Weapons

- **Rifle:** auto fire, 30 rounds. Scoping looks through a red dot sight (small zoom, no crosshair, no muzzle flash, own tracers hidden so nothing blocks your aim).
- **Knife:** switch with Q (or the Knife button on phones). You run about 20% faster than with the rifle. Fire attacks with a swing: 55 damage, so two hits kill, reach is about 2 metres in front of you, and cover blocks it. You can't shoot or scope with the knife out. You spawn with the rifle.
