'use strict';
/* ------------------------------------------------------------------
   Two Idiots game server
   - serves the game files (index.html, engine.js, levels/...)  [optional]
   - WebSocket endpoint: room codes, quick match, message relay,
     WebRTC voice signalling
   Run (from the repo root):  npm install && npm start
------------------------------------------------------------------- */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const { Lobby } = require('./rooms');

const PORT          = parseInt(process.env.PORT || '8080', 10);
const STATIC_DIR    = process.env.STATIC_DIR || path.join(__dirname, '..');
const SERVE_STATIC  = process.env.STATIC !== '0';                       // STATIC=0 -> websocket only
const TRUST_PROXY   = process.env.TRUST_PROXY === '1';                   // behind nginx / Cloudflare
const ORIGINS       = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
const MAX_PER_IP    = parseInt(process.env.MAX_CONN_PER_IP || '8', 10);
const MSG_PER_SEC   = parseInt(process.env.MSG_PER_SEC || '120', 10);    // sustained rate limit per socket
const MAX_ROOMS     = parseInt(process.env.MAX_ROOMS || '2000', 10);

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.md': 'text/plain; charset=utf-8'
};

const lobby = new Lobby({ maxRooms: MAX_ROOMS });

/* ---------------- HTTP (static files + /health) ---------------- */
const server = http.createServer((req, res) => {
  let urlPath;
  try { urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname); }
  catch (e) { res.writeHead(400); return res.end('Bad request'); }

  if (urlPath === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify(Object.assign({ ok: true }, lobby.stats())));
  }
  if (!SERVE_STATIC) { res.writeHead(404); return res.end('Not found'); }

  if (urlPath.endsWith('/')) urlPath += 'index.html';
  // never expose the server source or hidden files
  const parts = urlPath.split('/').filter(Boolean);
  const hidden = ['package.json', 'package-lock.json', 'render.yaml', 'README.md'];
  if (parts[0] === 'server' || parts[0] === 'node_modules' || parts.some(p => p.startsWith('.')) || hidden.includes(parts[parts.length - 1])) { res.writeHead(404); return res.end('Not found'); }

  const file = path.normalize(path.join(STATIC_DIR, urlPath));
  if (!file.startsWith(path.normalize(STATIC_DIR))) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.html' || ext === '.js' ? 'no-cache' : 'public, max-age=3600'
    });
    res.end(data);
  });
});

/* ---------------- WebSocket ---------------- */
const wss = new WebSocketServer({ server, maxPayload: 64 * 1024, perMessageDeflate: false });
const perIp = new Map();
let nextId = 1;

function clientIp(req) {
  if (TRUST_PROXY) {
    const xf = req.headers['x-forwarded-for'];
    if (xf) return String(xf).split(',')[0].trim();
  }
  return req.socket.remoteAddress || 'unknown';
}

wss.on('connection', (ws, req) => {
  const origin = req.headers.origin;
  if (ORIGINS.length && (!origin || !ORIGINS.includes(origin))) { ws.close(1008, 'origin'); return; }

  const ip = clientIp(req);
  const n = (perIp.get(ip) || 0) + 1;
  if (n > MAX_PER_IP) { ws.close(1013, 'too many connections'); return; }
  perIp.set(ip, n);

  const client = {
    id: nextId++, ip, closed: false, room: null, slot: -1, name: 'Idiot',
    send(obj) { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); }
  };
  lobby.players++;
  ws.isAlive = true;
  let tokens = MSG_PER_SEC * 2, lastRefill = Date.now();

  client.send({ t: 'hello', online: lobby.players });

  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', raw => {
    const now = Date.now();                                    // token bucket rate limiter
    tokens = Math.min(MSG_PER_SEC * 2, tokens + (now - lastRefill) / 1000 * MSG_PER_SEC);
    lastRefill = now;
    if (--tokens < 0) { client.send({ t: 'error', code: 'rate' }); if (tokens < -200) ws.close(1008, 'flood'); return; }

    let msg;
    try { msg = JSON.parse(raw.toString()); } catch (e) { return; }
    if (!msg || typeof msg.t !== 'string') return;
    try { lobby.handle(client, msg); } catch (e) { console.error('handler error', e); }
  });
  ws.on('close', () => {
    client.closed = true;
    lobby.players = Math.max(0, lobby.players - 1);
    lobby.leave(client);
    const left = (perIp.get(ip) || 1) - 1;
    if (left <= 0) perIp.delete(ip); else perIp.set(ip, left);
  });
  ws.on('error', () => {});
});

// heartbeat: drop dead sockets (also keeps proxies from closing idle connections)
const beat = setInterval(() => {
  wss.clients.forEach(ws => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    try { ws.ping(); } catch (e) {}
  });
}, 20000);
const sweeper = setInterval(() => lobby.sweep(), 10 * 60 * 1000);

server.listen(PORT, () => {
  console.log('Two Idiots server listening on port ' + PORT + (SERVE_STATIC ? ' (serving ' + path.normalize(STATIC_DIR) + ')' : ' (websocket only)'));
});

function shutdown() {
  clearInterval(beat); clearInterval(sweeper);
  wss.clients.forEach(ws => ws.close(1001, 'server restarting'));
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

module.exports = { server, wss, lobby };
