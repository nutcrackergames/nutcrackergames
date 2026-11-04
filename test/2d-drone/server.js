'use strict';
/*
  Tandem Lift game server (no npm packages needed, Node 16+).

  Architecture (server-authoritative):

      player 1 input --\                          /--> player 1 renders
                        >--  GAME SERVER  --state-<
      player 2 input --/                          \--> player 2 renders

    1. The server receives both players' thrust input.
    2. It runs the whole simulation (sim.js) 60 times a second: positions, physics, collisions, pad rules.
    3. It sends the game state to the players about 20 times a second, plus events (toasts, crash, win).
    Clients never decide anything about the game. They send input and draw what they receive.

  - Serves the game page (index.html) and sim.js at  http://HOST:PORT/  and runs rooms over WebSocket
    at the same address (ws:// or wss://).
  - Seat 0 = left fan, seat 1 = right fan.
  - If a player drops, the game is frozen for GRACE_MS so they can come back. After that the seat is
    marked "left" and the remaining player controls both fans.
  - Voice chat audio is WebRTC between the players; this server only relays the signalling.

  Run:   node server.js
  Env:   PORT (default 8080), GRACE_MS (default 10000), GAME_FILE (default index.html)
*/
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Sim } = require('./sim.js');

const PORT = +process.env.PORT || 8080;
const GRACE_MS = +process.env.GRACE_MS || 10000;
const ROOM_TTL_MS = 5 * 60 * 1000;
const MAX_ROOMS = 500;
const GAME_FILE = process.env.GAME_FILE || path.join(__dirname, 'index.html');
const SIM_FILE = path.join(__dirname, 'sim.js');
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const STEP = 1 / 60;
const INPUT_TTL_MS = 700;   // a thrust input older than this counts as "released" (tab hidden, lag)
const REACTIONS = ['\uD83D\uDDFF', '\uD83D\uDE02', '\uD83D\uDC80', '\uD83D\uDD25', '\uD83D\uDC38'];

/* ---------- tiny WebSocket implementation (RFC 6455, text frames) ---------- */
class Conn {
  constructor(socket) {
    this.s = socket;
    this.buf = Buffer.alloc(0);
    this.alive = true;
    this.lastPong = Date.now();
    this.frag = [];
    this.fragOp = 0;
    this.onmessage = null;
    this.onclose = null;
    this.ctx = null;
    socket.setNoDelay(true);
    socket.on('data', (d) => {
      this.buf = Buffer.concat([this.buf, d]);
      this.parse();
    });
    socket.on('close', () => this.close());
    socket.on('error', () => this.close());
  }
  parse() {
    while (this.alive && this.buf.length >= 2) {
      const b0 = this.buf[0], b1 = this.buf[1];
      const fin = !!(b0 & 0x80), op = b0 & 0x0f, masked = !!(b1 & 0x80);
      let len = b1 & 0x7f, off = 2;
      if (len === 126) {
        if (this.buf.length < 4) return;
        len = this.buf.readUInt16BE(2); off = 4;
      } else if (len === 127) {
        if (this.buf.length < 10) return;
        len = Number(this.buf.readBigUInt64BE(2)); off = 10;
      }
      if (len > 1 << 20) { this.close(); return; }
      let mask = null;
      if (masked) {
        if (this.buf.length < off + 4) return;
        mask = this.buf.subarray(off, off + 4); off += 4;
      }
      if (this.buf.length < off + len) return;
      const payload = Buffer.from(this.buf.subarray(off, off + len));
      this.buf = this.buf.subarray(off + len);
      if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      this.frame(fin, op, payload);
    }
  }
  frame(fin, op, p) {
    if (op === 0x8) { this.close(); return; }
    if (op === 0x9) { this.send(p, 0xA); return; }
    if (op === 0xA) { this.lastPong = Date.now(); return; }
    if (op === 0x1 || op === 0x2 || op === 0x0) {
      if (op !== 0x0) { this.fragOp = op; this.frag = []; }
      this.frag.push(p);
      if (fin) {
        const data = Buffer.concat(this.frag);
        this.frag = [];
        if (this.fragOp === 0x1 && this.onmessage) this.onmessage(data.toString('utf8'));
      }
    }
  }
  send(data, op = 0x1) {
    if (!this.alive) return;
    const payload = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
    const n = payload.length;
    let h;
    if (n < 126) { h = Buffer.from([0x80 | op, n]); }
    else if (n < 65536) { h = Buffer.alloc(4); h[0] = 0x80 | op; h[1] = 126; h.writeUInt16BE(n, 2); }
    else { h = Buffer.alloc(10); h[0] = 0x80 | op; h[1] = 127; h.writeBigUInt64BE(BigInt(n), 2); }
    try { this.s.write(Buffer.concat([h, payload])); } catch (e) { this.close(); }
  }
  close() {
    if (!this.alive) return;
    this.alive = false;
    conns.delete(this);
    try { this.s.destroy(); } catch (e) { /* ignore */ }
    if (this.onclose) this.onclose();
  }
}
const conns = new Set();
const jsend = (c, obj) => { if (c && c.alive) c.send(JSON.stringify(obj)); };

/* ---------- rooms ---------- */
const rooms = new Map();
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function newCode() {
  for (let k = 0; k < 50; k++) {
    let c = '';
    for (let i = 0; i < 5; i++) c += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)];
    if (!rooms.has(c)) return c;
  }
  return null;
}
function mkRoom(code) {
  return {
    code,
    seats: [{ pid: null, conn: null, state: 'empty' }, { pid: null, conn: null, state: 'empty' }],
    timers: [null, null], expire: null,
    sim: new Sim({ visuals: false }),
    seedBase: 0, started: false,
    inp: [{ a: 0, b: 0, s: 0, at: 0 }, { a: 0, b: 0, s: 0, at: 0 }],
    lastResult: null, acc: 0, snapT: 0
  };
}
const online = (room, i) => room.seats[i].state === 'online' && room.seats[i].conn;
const log = (...a) => { if (process.env.QUIET !== '1') console.log(new Date().toISOString().slice(11, 19), ...a); };
function broadcast(room, obj) {
  const s = JSON.stringify(obj);
  for (let i = 0; i < 2; i++) if (online(room, i)) room.seats[i].conn.send(s);
}

function armExpiry(room) {
  clearTimeout(room.expire);
  room.expire = null;
  if (!online(room, 0) && !online(room, 1)) {
    room.expire = setTimeout(() => {
      room.timers.forEach(clearTimeout);
      rooms.delete(room.code);
      log('room expired', room.code);
    }, ROOM_TTL_MS);
  }
}

/* ---------- game control ---------- */
function lvlMessage(room) { return { t: 'lvl', level: room.sim.level, seedBase: room.seedBase, total: room.sim.total }; }
function startRoom(room) {
  room.seedBase = crypto.randomInt(1e9);
  room.sim.total = 0;
  room.sim.loadLevel(1, room.seedBase);
  room.started = true; room.lastResult = null;
  broadcast(room, lvlMessage(room));
  broadcast(room, room.sim.snapshot());
  log('start', room.code);
}
function reloadLevel(room, level) {
  room.sim.loadLevel(level, room.seedBase);
  room.lastResult = null; room.acc = 0;
  broadcast(room, lvlMessage(room));
  broadcast(room, room.sim.snapshot());
}

// who pushes which fan. Two players: each one runs their own fan (any thrust key works).
// One player left in the room: they run both fans (a = left, b = right, s = both).
function controls(room, now) {
  const live = [0, 1].filter((i) => online(room, i));
  const val = (i) => { const p = room.inp[i]; return now - p.at < INPUT_TTL_MS ? p : { a: 0, b: 0, s: 0 }; };
  if (live.length === 1) { const p = val(live[0]); return [p.a || p.s ? 1 : 0, p.b || p.s ? 1 : 0]; }
  const lv = [0, 0];
  for (const i of live) { const p = val(i); lv[i] = p.a || p.b || p.s ? 1 : 0; }
  return lv;
}

function enter(c, m) {
  if (c.ctx) return;
  const pid = String(m.pid || '').slice(0, 64) || crypto.randomUUID();
  let room, seat;
  if (m.t === 'create') {
    if (rooms.size >= MAX_ROOMS) return jsend(c, { t: 'error', code: 'busy' });
    const code = newCode();
    if (!code) return jsend(c, { t: 'error', code: 'busy' });
    room = mkRoom(code);
    rooms.set(code, room);
    seat = 0;
  } else {
    room = rooms.get(String(m.code || '').toUpperCase().trim());
    if (!room) return jsend(c, { t: 'error', code: 'nofound' });
    seat = room.seats.findIndex((s) => s.pid === pid);
    if (seat < 0) seat = room.seats.findIndex((s) => s.state === 'empty' || s.state === 'left');
    if (seat < 0) return jsend(c, { t: 'error', code: 'full' });
  }
  const s = room.seats[seat];
  if (s.conn && s.conn !== c) { const old = s.conn; old.ctx = null; old.close(); }
  clearTimeout(room.timers[seat]);
  room.timers[seat] = null;
  s.pid = pid; s.conn = c; s.state = 'online'; c.ctx = { room, seat };
  room.inp[seat] = { a: 0, b: 0, s: 0, at: 0 };
  armExpiry(room);
  jsend(c, { t: 'joined', code: room.code, seat, peers: room.seats.map((x) => x.state), started: room.started });
  const other = room.seats[1 - seat];
  if (other.state === 'online') jsend(other.conn, { t: 'peer', seat, state: 'online' });
  if (room.started) {
    jsend(c, lvlMessage(room));
    jsend(c, room.sim.snapshot());
    if (room.sim.state !== 'play' && room.lastResult) jsend(c, { t: 'ev', m: [room.lastResult] });
  } else if (other.state === 'online') startRoom(room);
  log(m.t, room.code, 'seat', seat);
}

function seatDown(room, seat, conn) {
  const s = room.seats[seat];
  if (s.conn !== conn) return;
  s.conn = null; s.state = 'waiting';
  room.inp[seat] = { a: 0, b: 0, s: 0, at: 0 };
  const other = room.seats[1 - seat];
  if (other.state === 'online') jsend(other.conn, { t: 'peer', seat, state: 'waiting', secs: GRACE_MS / 1000 });
  clearTimeout(room.timers[seat]);
  room.timers[seat] = setTimeout(() => seatLeft(room, seat), GRACE_MS);
  armExpiry(room);
  log('down', room.code, 'seat', seat);
}

function seatLeft(room, seat) {
  clearTimeout(room.timers[seat]);
  room.timers[seat] = null;
  const s = room.seats[seat];
  if (s.state === 'online') { s.state = 'left'; if (s.conn) { s.conn.ctx = null; s.conn.close(); s.conn = null; } }
  else s.state = 'left';
  room.inp[seat] = { a: 0, b: 0, s: 0, at: 0 };
  const other = room.seats[1 - seat];
  if (other.state === 'online') jsend(other.conn, { t: 'peer', seat, state: 'left' });
  armExpiry(room);
  log('left', room.code, 'seat', seat);
}

function onMsg(c, raw) {
  if (raw.length > 4096) return;
  let m;
  try { m = JSON.parse(raw); } catch (e) { return; }
  if (!m || typeof m.t !== 'string') return;
  if (m.t === 'create' || m.t === 'join') return enter(c, m);
  if (!c.ctx) return;
  const { room, seat } = c.ctx;
  switch (m.t) {
    case 'in':   // the only thing a client can tell the game: which thrust buttons are held
      room.inp[seat] = { a: m.a ? 1 : 0, b: m.b ? 1 : 0, s: m.s ? 1 : 0, at: Date.now() };
      break;
    case 'start': if (!room.started) startRoom(room); break;
    case 'next': if (room.started && room.sim.state === 'won') reloadLevel(room, room.sim.level + 1); break;
    case 'retry': if (room.started && room.sim.state === 'lost') reloadLevel(room, room.sim.level); break;
    case 'restart':
      if (room.started && room.sim.state === 'play') {
        reloadLevel(room, room.sim.level);
        broadcast(room, { t: 'ev', m: [{ e: 'toast', s: 'City restarted' }] });
      }
      break;
    case 'leave': seatLeft(room, seat); break;
    case 'react': {
      if (!REACTIONS.includes(m.em)) return;
      const other = room.seats[1 - seat];
      if (other.state === 'online') jsend(other.conn, { t: 'react', em: m.em, who: seat === 0 ? 'p1' : 'p2' });
      break;
    }
    case 'rtc': {   // voice chat signalling between the two players
      const other = room.seats[1 - seat];
      if (other.state === 'online') jsend(other.conn, m);
      break;
    }
    default: break;
  }
}

/* ---------- the game loop: the server steps every room's simulation ---------- */
let lastTick = Date.now();
setInterval(() => {
  const now = Date.now();
  const dt = Math.min((now - lastTick) / 1000, 0.25);
  lastTick = now;
  for (const room of rooms.values()) {
    if (!room.started) continue;
    const sim = room.sim;
    const frozen = room.seats.some((s) => s.state === 'waiting') || !(online(room, 0) || online(room, 1));
    const running = sim.state === 'play' && !frozen;
    if (running) {
      room.acc += dt;
      const lv = controls(room, now);
      let n = 0;
      while (room.acc >= STEP && n < 6) { sim.step(STEP, lv); room.acc -= STEP; n++; }
      if (room.acc > STEP * 6) room.acc = 0;
    } else room.acc = 0;
    if (sim.events.length) {
      const evs = sim.events.splice(0);
      for (const e of evs) if (e.e === 'win' || e.e === 'crash') room.lastResult = e;
      broadcast(room, { t: 'ev', m: evs });
    }
    room.snapT += dt;
    if (room.snapT >= (running ? 0.05 : 0.5)) { room.snapT = 0; broadcast(room, sim.snapshot()); }
  }
}, 16);

/* ---------- http + upgrade ---------- */
const server = http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];
  if (url === '/health') { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('ok'); return; }
  if (url === '/' || url === '/index.html') {
    fs.readFile(GAME_FILE, (err, data) => {
      if (err) { res.writeHead(500, { 'Content-Type': 'text/plain' }); res.end('Game file not found: ' + GAME_FILE); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(data);
    });
    return;
  }
  if (url === '/sim.js') {
    fs.readFile(SIM_FILE, (err, data) => {
      if (err) { res.writeHead(500, { 'Content-Type': 'text/plain' }); res.end('sim.js not found'); return; }
      res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(data);
    });
    return;
  }
  if (url === '/manifest.webmanifest') {
    res.writeHead(200, { 'Content-Type': 'application/manifest+json' });
    res.end(JSON.stringify({
      name: 'Tandem Lift', short_name: 'Tandem Lift', start_url: '/', display: 'fullscreen', orientation: 'landscape',
      background_color: '#11152b', theme_color: '#11152b',
      icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }]
    }));
    return;
  }
  if (url === '/icon.svg') {
    res.writeHead(200, { 'Content-Type': 'image/svg+xml' });
    res.end('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" rx="96" fill="#11152b"/>' +
      '<rect x="156" y="236" width="200" height="44" rx="14" fill="#eef2fb"/><rect x="70" y="214" width="372" height="16" fill="#2a3042"/>' +
      '<ellipse cx="96" cy="190" rx="70" ry="14" fill="#2fd1bd" opacity=".8"/><ellipse cx="416" cy="190" rx="70" ry="14" fill="#ff6b7e" opacity=".8"/></svg>');
    return;
  }
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (!key || String(req.headers.upgrade).toLowerCase() !== 'websocket') { socket.destroy(); return; }
  const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  const c = new Conn(socket);
  conns.add(c);
  c.onmessage = (raw) => onMsg(c, raw);
  c.onclose = () => { if (c.ctx) { const { room, seat } = c.ctx; c.ctx = null; seatDown(room, seat, c); } };
});

// drop dead connections quickly so a lost player is noticed within seconds
setInterval(() => {
  const now = Date.now();
  for (const c of conns) {
    if (now - c.lastPong > 20000) c.close();
    else c.send(Buffer.alloc(0), 0x9);
  }
}, 5000);

server.listen(PORT, () => {
  console.log('Tandem Lift server running on port ' + PORT);
  console.log('Open  http://localhost:' + PORT + '  (grace period ' + GRACE_MS / 1000 + ' s)');
});
