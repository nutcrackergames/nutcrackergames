# PEN FIGHT: CLASSROOM WARS

Files:
- public/index.html   the game (served by the server)
- server.js           online multiplayer server
- package.json        dependencies and start command
- README.md           this file

## Run locally
    npm install
    npm start
Open http://localhost:3000

## Deploy on Render (Web Service linked to this GitHub repo)
- Build Command: npm install
- Start Command: npm start
- Instance Type: Free

Open the https://....onrender.com link on both phones. PLAY > ONLINE tab > Create room / Join with the code.
The game connects to the server it was opened from, so there is nothing to configure.

If a player disconnects mid-match, the match waits 30 seconds (env var GRACE_SECONDS) and then a CPU plays their pen.
If they come back they get control back immediately.
