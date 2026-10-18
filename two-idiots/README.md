# Two Idiots

3D side-view co-op ragdoll parkour for two players, with voice chat.
Players connect through a small Node server (rooms, quick match, message relay, voice set-up).

## Folder layout (what goes on GitHub)

```
two-idiots/                 <- repo root
├─ index.html               lobby page (create / join / quick match) + HUD
├─ engine.js                the game: 3D renderer, physics, networking, voice, sound
├─ config.js                server address + voice (TURN) settings
├─ package.json             tells Render how to start the server
├─ render.yaml              optional one-click Render setup
├─ .gitignore
├─ README.md                this file
├─ levels/
│  ├─ manifest.js           ordered list of level files
│  ├─ level1.js … level5.js one file per level
│  └─ README.md             level format + cheat sheet
└─ server/
   ├─ server.js             HTTP (game files, /health) + WebSocket server
   └─ rooms.js              room codes, quick match, relay rules
```

## Add a level
Copy `levels/level5.js` to `levels/level6.js`, edit it, add `'levels/level6.js'` to `levels/manifest.js`, commit. (Format: `levels/README.md`.)

## Run locally
```bash
npm install
npm start            # http://localhost:8080  (open it in two tabs)
```
Node 18 or newer. The microphone needs https or localhost.

## Host on GitHub + Render
1. **GitHub**: create an empty repo, then in this folder
   ```bash
   git init
   git add .
   git commit -m "Two Idiots"
   git branch -M main
   git remote add origin https://github.com/YOUR-USERNAME/two-idiots.git
   git push -u origin main
   ```
   (or **Add file → Upload files** and drop everything in; keep the layout above, with `package.json` at the top level)
2. **Render**: New + → **Web Service** → choose the repo, then
   * Build Command `npm install`
   * Start Command `npm start`
   * Health Check Path `/health`
   * Environment variable `TRUST_PROXY` = `1`
   * Instance type: Free (or Starter so it never sleeps)

   Or New + → **Blueprint**, pick the repo, and Render reads `render.yaml`.
3. Open `https://<name>.onrender.com/`. Each `git push` redeploys automatically.

Free instances sleep after ~15 minutes without visitors (first visit then takes ~30-60 s). A free pinger on `/health` keeps it awake.

### Custom domain
* Whole game on Render: Settings → Custom Domains → add e.g. `play.nutcrackergames.fun` and create the DNS record Render shows.
* Game files on your own host, server on Render: set `SERVER_URL: 'wss://<name>.onrender.com'` in `config.js`, and in Render set `ALLOWED_ORIGINS` = `https://nutcrackergames.fun`.

## Server settings (environment variables, all optional)
| variable | default | meaning |
|---|---|---|
| `PORT` | 8080 | Render sets this itself |
| `STATIC` | on | `STATIC=0` = websocket only (game files hosted elsewhere) |
| `TRUST_PROXY` | off | set to `1` on Render / behind a proxy |
| `ALLOWED_ORIGINS` | any | comma list, e.g. `https://nutcrackergames.fun` |
| `MAX_CONN_PER_IP` | 8 | connections per IP |
| `MSG_PER_SEC` | 120 | messages per second per connection |
| `MAX_ROOMS` | 2000 | rooms at once |

`GET /health` returns `{"ok":true,"online":N,"rooms":N,"waiting":N}`.

## Voice chat on strict networks
Voice goes directly between the two phones (WebRTC). Most networks work with the default STUN. If a mobile carrier or office Wi-Fi blocks it
the top bar says "Voice failed". Add a TURN server (e.g. coturn) in `config.js`:
```js
ICE_SERVERS: [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'turn:turn.example.com:3478', username: 'USER', credential: 'PASSWORD' }
]
```

## Notes
* Physics run on the players' devices; the server relays and validates messages (only the room owner can change levels / send crate positions). It is not an anti-cheat server.
* Rooms are kept in memory; a server restart clears them.
