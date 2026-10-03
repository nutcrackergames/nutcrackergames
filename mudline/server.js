'use strict';
/*
 * Mudline - authoritative game server
 * - Serves /public over HTTP
 * - WebSocket game room, max 5 players, unlimited respawn, first to KILL_LIMIT wins
 * - Server decides hits, damage, kills, respawns and round resets
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

// ---------- config ----------
const PORT = parseInt(process.env.PORT || '3000', 10);
const MAX_PLAYERS = 5;
const KILL_LIMIT = parseInt(process.env.KILL_LIMIT || '20', 10);
const RESPAWN_MS = 3000;
const PROTECT_MS = 2000;      // spawn protection
const ROUND_RESET_MS = 10000; // pause after a win before the next round
const FIRE_INTERVAL = 85;     // server-side fire rate limit (ms)
const MAX_HP = 100;
const BODY_DMG = 20;
const HEAD_DMG = 50;
const ARENA = 50;
const EYE = 1.6;
const MAX_RANGE = 160;
const BODY_R = 0.5, BODY_H = 1.5, HEAD_Y = 1.68, HEAD_R = 0.28;
const SL_BODY_H = 0.85, SL_HEAD_Y = 0.98, SL_EYE = 0.9; // smaller hitbox while sliding

// ---------- map ----------
// Every solid: {t:type, x, z, w, d, h}. Rendered by the client, used here for bullet blocking.
const BOXES = [];
const add = (t, x, z, w, d, h, extra) => BOXES.push(Object.assign({ t, x, z, w, d, h }, extra || {}));
const stack = (x, z) => {
  add('crate', x, z, 1.6, 1.6, 1.1);
  add('crate', x, z, 1.0, 1.0, 2.2, { y0: 1.1 });
};

// tanks (hull top at 1.9)
add('tank', -12, 8, 6.4, 3.2, 1.9, { burn: 1 });
add('tank', 15, -11, 3.2, 6.4, 1.9, { burn: 1, f: -1 });
add('tank', 7, 28, 6.4, 3.2, 1.9, { f: -1 });
add('tank', -22, -18, 3.2, 6.4, 1.9);
add('tank', -30, 18, 6.4, 3.2, 1.9, { f: -1 });
add('tank', 38, 14, 3.2, 6.4, 1.9);
// sandbag lines (1.0 high - jumpable)
add('sandbag', 0, -12, 9, 1, 1.0);
add('sandbag', 0, 12, 9, 1, 1.0);
add('sandbag', -20, 0, 1, 9, 1.0);
add('sandbag', 20, 0, 1, 9, 1.0);
add('sandbag', -36, -12, 7, 1, 1.0);
add('sandbag', 32, 22, 7, 1, 1.0);
add('sandbag', -14, -38, 1, 7, 1.0);
add('sandbag', 14, 38, 1, 7, 1.0);
add('sandbag', 10, -30, 7, 1, 1.0);
add('sandbag', -10, 32, 7, 1, 1.0);
// ruined concrete walls (3 high)
add('wall', -30, -26, 10, 1.2, 3);
add('wall', -35.6, -21.4, 1.2, 8, 3);
add('wall', 30, 26, 10, 1.2, 3);
add('wall', 35.6, 21.4, 1.2, 8, 3);
add('wall', 30, -26, 10, 1.2, 3);
add('wall', 24.4, -21.4, 1.2, 8, 3);
add('wall', -30, 26, 10, 1.2, 3);
add('wall', -24.4, 21.4, 1.2, 8, 3);
// bunkers
add('bunker', -40, 2, 7, 7, 2.6);
add('bunker', 40, -2, 7, 7, 2.6);
add('bunker', 0, -42, 8, 6, 2.6);
add('bunker', 0, 42, 8, 6, 2.6);
// crate stacks (climb them to reach tanks)
[[-5, -4], [6, 4], [-9, 12], [11, -6], [2, 26], [-18, -13], [-25, 14.5], [34, 10]].forEach(([x, z]) => stack(x, z));
// single crates
[[-14, -3], [14, 4], [22, 14], [-22, 24], [28, -6], [-30, -8], [8, -24], [-6, 20], [34, 28], [-36, 34], [40, -14], [-40, -30]]
  .forEach(([x, z]) => add('crate', x, z, 1.3, 1.3, 1.1));

const SPAWNS = [
  [-44, -44], [44, -44], [-44, 44], [44, 44],
  [-25, 0], [25, 0], [0, -25], [0, 25],
  [-44, 20], [44, -20], [-20, -44], [20, 44]
];

// ---------- state ----------
const players = new Map();
let nextId = 1;
let gameOver = false;
let resetAt = 0;
let lastGameOver = null;

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const r2 = (v) => Math.round(v * 100) / 100;
const cleanName = (n) => String(n || 'Soldier').replace(/[<>&"'`\u0000-\u001f]/g, '').trim().slice(0, 14) || 'Soldier';

function send(ws, obj) { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); }
function broadcast(obj) {
  const s = JSON.stringify(obj);
  for (const p of players.values()) if (p.ws.readyState === 1) p.ws.send(s);
}
const rosterList = () => [...players.values()].map((p) => ({ id: p.id, name: p.name, c: p.c }));

// ---------- ray helpers ----------
function rayBox(ox, oy, oz, dx, dy, dz, b) {
  const min = [b.x - b.w / 2, 0, b.z - b.d / 2];
  const max = [b.x + b.w / 2, b.h, b.z + b.d / 2];
  const o = [ox, oy, oz], d = [dx, dy, dz];
  let tmin = 0, tmax = Infinity;
  for (let i = 0; i < 3; i++) {
    if (Math.abs(d[i]) < 1e-9) {
      if (o[i] < min[i] || o[i] > max[i]) return null;
    } else {
      let t1 = (min[i] - o[i]) / d[i], t2 = (max[i] - o[i]) / d[i];
      if (t1 > t2) { const s = t1; t1 = t2; t2 = s; }
      tmin = Math.max(tmin, t1); tmax = Math.min(tmax, t2);
      if (tmin > tmax) return null;
    }
  }
  return tmin > 0.001 ? tmin : null; // shooter already inside -> ignore
}

function rayPlayer(ox, oy, oz, dx, dy, dz, q) {
  let best = null;
  const px = ox - q.x, pz = oz - q.z;
  const a = dx * dx + dz * dz;
  if (a > 1e-8) {
    const b = 2 * (px * dx + pz * dz);
    const c = px * px + pz * pz - BODY_R * BODY_R;
    const disc = b * b - 4 * a * c;
    if (disc >= 0) {
      const s = Math.sqrt(disc);
      let t = (-b - s) / (2 * a);
      if (t < 0) t = (-b + s) / (2 * a);
      if (t >= 0) {
        const y = oy + dy * t;
        if (y >= q.y && y <= q.y + (q.sl ? SL_BODY_H : BODY_H)) best = { t, head: false };
      }
    }
  }
  const lx = ox - q.x, ly = oy - (q.y + (q.sl ? SL_HEAD_Y : HEAD_Y)), lz = oz - q.z;
  const bq = lx * dx + ly * dy + lz * dz;
  const cq = lx * lx + ly * ly + lz * lz - HEAD_R * HEAD_R;
  const dsc = bq * bq - cq;
  if (dsc >= 0) {
    const t = -bq - Math.sqrt(dsc);
    if (t >= 0 && (!best || t < best.t + 0.05)) best = { t, head: true };
  }
  return best;
}

// ---------- game logic ----------
function spawn(p) {
  const others = [...players.values()].filter((q) => q !== p && q.alive);
  const scored = SPAWNS.map((s) => {
    let md = 1e9;
    for (const q of others) md = Math.min(md, Math.hypot(q.x - s[0], q.z - s[1]));
    return { s, md: Math.min(md, 80) + Math.random() * 6 };
  }).sort((a, b) => b.md - a.md);
  const pick = scored[Math.floor(Math.random() * Math.min(3, scored.length))].s;
  p.x = pick[0]; p.z = pick[1]; p.y = 0;
  p.r = Math.atan2(pick[0], pick[1]); // face the centre
  p.pt = 0;
  p.sl = 0;
  p.hp = MAX_HP;
  p.alive = true;
  p.inv = Date.now() + PROTECT_MS;
  send(p.ws, { t: 'spawn', x: p.x, y: 0, z: p.z, r: p.r, hp: p.hp });
}

function endRound(winner) {
  gameOver = true;
  resetAt = Date.now() + ROUND_RESET_MS;
  const scores = [...players.values()]
    .map((p) => ({ id: p.id, n: p.name, c: p.c, k: p.kills, d: p.deaths }))
    .sort((a, b) => b.k - a.k);
  lastGameOver = { w: winner.id, wn: winner.name, wc: winner.c, scores };
  broadcast(Object.assign({ t: 'gameover', in: ROUND_RESET_MS }, lastGameOver));
  setTimeout(resetRound, ROUND_RESET_MS);
}

function resetRound() {
  gameOver = false;
  lastGameOver = null;
  for (const p of players.values()) { p.kills = 0; p.deaths = 0; p.alive = false; }
  broadcast({ t: 'newround' });
  for (const p of players.values()) spawn(p);
}

function handleShoot(p, m) {
  if (!p.alive || gameOver) return;
  const now = Date.now();
  if (now - p.lastShot < FIRE_INTERVAL * 0.8) return;
  p.lastShot = now;
  applyState(p, m);

  let dx = +m.dx, dy = +m.dy, dz = +m.dz;
  if (![dx, dy, dz].every(Number.isFinite)) return;
  const len = Math.hypot(dx, dy, dz);
  if (len < 1e-6) return;
  dx /= len; dy /= len; dz /= len;

  const ox = p.x, oy = p.y + (p.sl ? SL_EYE : EYE), oz = p.z;
  let best = { t: MAX_RANGE, type: 'none' };
  if (dy < -1e-6) {
    const tg = -oy / dy;
    if (tg > 0 && tg < best.t) best = { t: tg, type: 'ground' };
  }
  for (const b of BOXES) {
    const t = rayBox(ox, oy, oz, dx, dy, dz, b);
    if (t !== null && t < best.t) best = { t, type: 'box' };
  }
  for (const q of players.values()) {
    if (q === p || !q.alive) continue;
    const h = rayPlayer(ox, oy, oz, dx, dy, dz, q);
    if (h && h.t < best.t) best = { t: h.t, type: 'player', target: q, head: h.head };
  }

  broadcast({
    t: 'shot', id: p.id,
    o: [r2(ox), r2(oy), r2(oz)],
    e: [r2(ox + dx * best.t), r2(oy + dy * best.t), r2(oz + dz * best.t)],
    k: best.type
  });

  if (best.type === 'player') {
    const q = best.target;
    if (q.inv > now) return; // spawn protection
    const dmg = best.head ? HEAD_DMG : BODY_DMG;
    q.hp -= dmg;
    if (q.hp <= 0) {
      q.hp = 0; q.alive = false; q.deaths++;
      q.respawnAt = now + RESPAWN_MS;
      p.kills++;
      send(p.ws, { t: 'hit', h: best.head ? 1 : 0, kill: 1 });
      broadcast({ t: 'kill', k: p.id, v: q.id, kn: p.name, vn: q.name, kc: p.c, vc: q.c, head: best.head ? 1 : 0 });
      if (p.kills >= KILL_LIMIT) endRound(p);
    } else {
      send(p.ws, { t: 'hit', h: best.head ? 1 : 0, kill: 0 });
      send(q.ws, { t: 'hurt', hp: q.hp, ax: r2(p.x), az: r2(p.z) });
    }
  }
}

function applyState(p, m) {
  const x = +m.x, y = +m.y, z = +m.z;
  if (![x, y, z].every(Number.isFinite)) return;
  p.x = clamp(x, -ARENA, ARENA);
  p.z = clamp(z, -ARENA, ARENA);
  p.y = clamp(y, 0, 12);
  if (Number.isFinite(+m.r)) p.r = +m.r;
  if (Number.isFinite(+m.p)) p.pt = clamp(+m.p, -1.6, 1.6);
  p.sl = m.sl ? 1 : 0;
}

function onJoin(ws, m) {
  if (ws.pid) return;
  if (players.size >= MAX_PLAYERS) {
    send(ws, { t: 'full' });
    ws.close();
    return;
  }
  const id = nextId++;
  const used = new Set([...players.values()].map((q) => q.c));
  let c = 0; while (used.has(c)) c++;
  const p = {
    id, ws, name: cleanName(m.name), c,
    x: 0, y: 0, z: 0, r: 0, pt: 0, sl: 0,
    hp: MAX_HP, alive: false, kills: 0, deaths: 0,
    lastShot: 0, inv: 0, respawnAt: 0
  };
  ws.pid = id;
  players.set(id, p);
  send(ws, { t: 'welcome', id, roster: rosterList() });
  broadcast({ t: 'roster', roster: rosterList() });
  if (gameOver && lastGameOver) {
    send(ws, Object.assign({ t: 'gameover', in: Math.max(0, resetAt - Date.now()) }, lastGameOver));
  } else {
    spawn(p);
  }
}

// ---------- tick ----------
setInterval(() => {
  if (!players.size) return;
  const now = Date.now();
  if (!gameOver) {
    for (const p of players.values()) if (!p.alive && now >= p.respawnAt) spawn(p);
  }
  broadcast({
    t: 'snap',
    p: [...players.values()].map((p) => ({
      id: p.id, x: r2(p.x), y: r2(p.y), z: r2(p.z), r: r2(p.r), pt: r2(p.pt),
      hp: p.hp, a: p.alive ? 1 : 0, k: p.kills, d: p.deaths, inv: p.inv > now ? 1 : 0, sl: p.sl ? 1 : 0
    }))
  });
}, 50);

// ---------- voice chat signalling (audio itself is peer-to-peer) ----------
function relayRtc(p, m) {
  const q = players.get(Number(m.to));
  if (!q || q === p || !m.data || typeof m.data !== 'object') return;
  send(q.ws, { t: 'rtc', from: p.id, data: m.data });
}

// ---------- http ----------
const PUBLIC = path.join(__dirname, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon', '.svg': 'image/svg+xml'
};
// Voice chat: ICE servers handed to clients. Add a TURN server via env var ICE_SERVERS (JSON array) if players can't connect.
let ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }];
try { if (process.env.ICE_SERVERS) ICE_SERVERS = JSON.parse(process.env.ICE_SERVERS); }
catch (e) { console.warn('ICE_SERVERS is not valid JSON, using defaults'); }
const CFG = { killLimit: KILL_LIMIT, maxHp: MAX_HP, arena: ARENA, respawnMs: RESPAWN_MS, maxPlayers: MAX_PLAYERS, ice: ICE_SERVERS };

function json(res, obj) {
  res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

const server = http.createServer((req, res) => {
  let pathname;
  try { pathname = new URL(req.url, 'http://localhost').pathname; } catch (e) { res.writeHead(400); return res.end(); }
  if (pathname === '/status') return json(res, { players: players.size, max: MAX_PLAYERS, killLimit: KILL_LIMIT });
  if (pathname === '/map') return json(res, { boxes: BOXES, cfg: CFG });

  const rel = pathname === '/' ? '/index.html' : pathname;
  const fp = path.join(PUBLIC, path.normalize(rel));
  if (!fp.startsWith(PUBLIC)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(fp, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream' });
    res.end(data);
  });
});

// ---------- websocket ----------
const wss = new WebSocketServer({ server, maxPayload: 16384 });

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.msgCount = 0;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', (raw) => {
    if (++ws.msgCount > 150) return; // crude flood guard (reset every second)
    let m;
    try { m = JSON.parse(raw); } catch (e) { return; }
    if (!m || typeof m.t !== 'string') return;
    if (m.t === 'join') return onJoin(ws, m);
    const p = players.get(ws.pid);
    if (!p) return;
    if (m.t === 's') { if (p.alive) applyState(p, m); }
    else if (m.t === 'shoot') handleShoot(p, m);
    else if (m.t === 'rtc') relayRtc(p, m);
  });
  ws.on('close', () => {
    if (ws.pid && players.delete(ws.pid)) broadcast({ t: 'roster', roster: rosterList() });
  });
  ws.on('error', () => {});
});

setInterval(() => { for (const ws of wss.clients) ws.msgCount = 0; }, 1000);

setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 10000);

server.listen(PORT, () => {
  console.log(`Mudline running on http://localhost:${PORT}  (max ${MAX_PLAYERS} players, first to ${KILL_LIMIT} kills)`);
});
