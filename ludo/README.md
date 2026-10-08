# Indian Ludo: online and offline

Two ways to play, one board.

## Online (friends on their own phones)

Needs Node.js 18 or newer.

    npm install
    npm start

Open http://localhost:3000. One player taps **Create room** and shares the 4-letter
code (or the invite link). Others tap **Join**. Empty seats can be filled with
computer players. The host starts the game.

To play on the same Wi-Fi, open `http://<your-computer-IP>:3000` on the other phones.

### Your colour, bottom-left

When you join a room you are assigned a colour. Your board is turned so your
own colour is always in the bottom-left corner, with your dice and name there.
Other players see the board turned for their own colour.

### Voice chat

Tap **Join voice chat** in the lobby or during the game. Voice is peer to peer
(WebRTC), and the game server only passes the connection messages between
players. A microphone icon beside each name shows who is in voice, who is muted
and who is speaking.

- Browsers only allow microphones on **HTTPS** or on `localhost`. On a home
  network over plain `http://192.168...` voice will not start. Deploy with HTTPS
  (most hosts give you this) or use a tunnel such as ngrok.
- Voice uses Google's public STUN servers by default. Most connections work with
  that. If some players cannot hear each other (strict corporate or mobile
  networks), add a TURN server by setting the `ICE_SERVERS` environment variable
  to a JSON array, for example:

      ICE_SERVERS='[{"urls":"stun:stun.l.google.com:19302"},{"urls":"turn:turn.example.com:3478","username":"user","credential":"pass"}]'

- With 4 players each person sends audio to the other 3, which is fine for voice.

### Put it on the internet

Any host that runs Node and supports WebSockets works (Render, Railway, Fly.io,
a VPS). Use these settings:

- Build command: `npm install`
- Start command: `npm start`
- The server reads the `PORT` environment variable automatically.
- HTTPS is fine. The page switches to `wss://` on its own.

Health check URL: `/healthz`

Notes:
- Rooms live in memory, so a server restart ends running games.
- Run a single instance (rooms are not shared between instances).
- If a player disconnects, the computer plays for them until they come back
  (reopen the same page in the same tab and they rejoin their seat).
- The server decides every dice roll and move, so players can't cheat.

## Offline (one device, no internet)

Open `public/offline.html` (also saved as `ludo.html`) by double-clicking it.
Up to four people share the screen, or any seat can be a computer player.
When the server is running it is also available at `/offline.html`.

Fonts load from Google Fonts when online; offline the game falls back to
system fonts and works the same.

## Files

    server.js          HTTP + WebSocket server
    game.js            Rooms and Ludo rules (server side)
    public/index.html  Online client
    public/offline.html  Offline version
