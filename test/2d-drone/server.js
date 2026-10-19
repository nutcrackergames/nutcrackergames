'use strict';
/*
  Tandem Lift server (no npm packages needed, Node 16+).

  - Serves the game page at  http://HOST:PORT/
  - Runs rooms over WebSocket at the same address (ws:// or wss://)
  - Seat 0 = left fan, seat 1 = right fan
  - One player is the "host" (runs the simulation). The server relays messages between the two
    seats, remembers the last level and snapshot, and watches presence.
  - If a player drops, the other one is frozen for GRACE_MS. If the player is not back by then,
    the seat is marked "left" and the remaining player gets full control. If the host is the one
    who left, the remaining player is promoted to host and continues from the last snapshot.
  - Voice chat audio is WebRTC between the players; this server only relays the signalling.

  Run:   node server.js
  Env:   PORT (default 8080), GRACE_MS (default 10000), GAME_FILE (default tandem-lift-2d-server.html)
*/
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = +process.env.PORT || 8080;
const GRACE_MS = +process.env.GRACE_MS || 10000;
const ROOM_TTL_MS = 5 * 60 * 1000;
const MAX_ROOMS = 500;
const GAME_FILE = process.env.GAME_FILE || path.join(__dirname, 'tandem-lift-2d-server.html');
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const RELAY = new Set(['in', 's', 'ev', 'lvl', 'react', 'rtc']);

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
    host: null, snap: null, lvl: null, timers: [null, null], expire: null
  };
}
const online = (room, i) => room.seats[i].state === 'online' && room.seats[i].conn;
const log = (...a) => { if (process.env.QUIET !== '1') console.log(new Date().toISOString().slice(11, 19), ...a); };

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
  let hostChanged = false;
  if (room.host === null || (room.seats[room.host].state === 'left' && room.host !== seat)) {
    room.host = seat; hostChanged = true;
  }
  armExpiry(room);
  const resume = room.lvl ? { lvl: room.lvl, snap: room.snap } : null;
  jsend(c, { t: 'joined', code: room.code, seat, host: room.host === seat, peers: room.seats.map((x) => x.state), resume });
  const other = room.seats[1 - seat];
  if (other.state === 'online') {
    jsend(other.conn, { t: 'peer', seat, state: 'online' });
    if (hostChanged) jsend(other.conn, { t: 'host', seat: room.host });
  }
  log(m.t, room.code, 'seat', seat, room.host === seat ? '(host)' : '');
}

function seatDown(room, seat, conn) {
  const s = room.seats[seat];
  if (s.conn !== conn) return;
  s.conn = null; s.state = 'waiting';
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
  const other = room.seats[1 - seat];
  if (other.state === 'online') jsend(other.conn, { t: 'peer', seat, state: 'left' });
  if (room.host === seat) {
    if (other.state === 'online') {
      room.host = 1 - seat;
      jsend(other.conn, { t: 'host', seat: room.host });
    } else room.host = null;
  }
  armExpiry(room);
  log('left', room.code, 'seat', seat, 'host now', room.host);
}

function onMsg(c, raw) {
  if (raw.length > 65536) return;
  let m;
  try { m = JSON.parse(raw); } catch (e) { return; }
  if (!m || typeof m.t !== 'string') return;
  if (m.t === 'create' || m.t === 'join') return enter(c, m);
  if (!c.ctx) return;
  const { room, seat } = c.ctx;
  if (m.t === 'leave') { seatLeft(room, seat); return; }
  if (!RELAY.has(m.t)) return;
  const fromHost = room.host === seat;
  if ((m.t === 's' || m.t === 'lvl' || m.t === 'ev') && !fromHost) return;
  if (m.t === 's') room.snap = m;
  if (m.t === 'lvl') room.lvl = m;
  const other = room.seats[1 - seat];
  if (other.state === 'online') jsend(other.conn, m);
}

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
