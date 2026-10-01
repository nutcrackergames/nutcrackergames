# Mudline

Low-poly war field shooter. Up to 5 players, free-for-all, unlimited respawn.
First player to the kill target wins the round, then a new round starts automatically.

## Run it

```
npm install
npm start
```

Open http://localhost:3000 in up to 5 browser tabs or devices.

Settings (environment variables):

| Variable     | Default | Meaning                    |
|--------------|---------|----------------------------|
| `PORT`       | 3000    | HTTP + WebSocket port      |
| `KILL_LIMIT` | 20      | Kills needed to win a round |

Example: `KILL_LIMIT=30 PORT=8080 npm start`

Other constants (max players, respawn time, damage, spawn protection) are at the top of `server.js`.

## Hosting for other people

Multiplayer needs a running Node server, so static-only hosts (GitHub Pages, Netlify drop) can't run the game by themselves.

- **All-in-one (easiest):** deploy this folder to any Node host (Render, Railway, Fly.io, a VPS). It serves the page and the game from one URL. Use `wss://` automatically when the page is on https.
- **Page and server on different hosts:** put `public/index.html` on your site and open it with `?server=wss://your-game-server.example.com`, for example `https://mysite.com/game.html?server=wss://mudline.onrender.com`.

## Controls

W A S D move, Shift sprint, Space jump (sandbags and crates are climbable), mouse aim, click fire (hold for auto), R reload, Tab scoreboard. Desktop browser with a mouse is required.

## How it works

- Server is authoritative for hits, damage, kills, respawns and scoring. Movement is client-reported.
- Map layout lives in `server.js` (`BOXES`) and is sent to clients, so both sides use the same obstacles.
- Three.js is loaded from a CDN, so players need internet access.
