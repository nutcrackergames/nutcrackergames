/* ------------------------------------------------------------
   Two Idiots - client settings
------------------------------------------------------------ */
window.GAME_CONFIG = {
  /* Address of the game server's WebSocket.
     ''  (empty)  = same site the page is served from, path "<page folder>/ws"
                    e.g. https://nutcrackergames.fun/two-idiots/  ->  wss://nutcrackergames.fun/two-idiots/ws
     or set it explicitly, e.g.  'wss://play.nutcrackergames.fun'                                    */
  SERVER_URL: '',

  /* Voice chat uses WebRTC. STUN is enough for most connections.
     Add a TURN server (see server/README.md) so voice also works on strict mobile / office networks. */
  ICE_SERVERS: [
    { urls: 'stun:stun.l.google.com:19302' }
    // { urls: 'turn:turn.nutcrackergames.fun:3478', username: 'USER', credential: 'PASSWORD' }
  ]
};
