'use strict';
/*
 * Mudline - authoritative game server
 * - Serves /public over HTTP
 * - Rooms are created on demand (public or private, join by code), each max 4 players by default, unlimited respawn, first to KILL_LIMIT wins
 * - Server decides hits, damage, kills, respawns and round resets
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

// ---------- config ----------
const PORT = parseInt(process.env.PORT || '3000', 10);
const MAX_PLAYERS = Math.max(2, Math.min(5, parseInt(process.env.MAX_PLAYERS || '4', 10) || 4)); // players per room (2 to 5)
const MAX_ROOMS = Math.max(1, Math.min(200, parseInt(process.env.MAX_ROOMS || '20', 10) || 20)); // most rooms open at once
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
const CR_BODY_H = 1.05, CR_HEAD_Y = 1.32, CR_EYE = 1.15; // crouching
const MELEE_RANGE = 2.6, MELEE_DMG = 55, MELEE_INTERVAL = 420, MELEE_COS = 0.5; // knife: two hits kill
// Health regeneration: after REGEN_DELAY seconds without taking damage, heal REGEN_RATE hp per second
const REGEN_DELAY_MS = Math.max(0, parseFloat(process.env.REGEN_DELAY || '10')) * 1000;
const REGEN_RATE = Math.max(0, parseFloat(process.env.REGEN_RATE || '4'));

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

// ---------- rooms ----------
class Room {
  constructor(code, name, priv) {
    this.id = code;
    this.code = code;
    this.name = name;
    this.priv = !!priv;
    this.players = new Map();
    this.nextId = 1;
    this.gameOver = false;
    this.resetAt = 0;
    this.lastGameOver = null;
    this.resetTimer = null;
    this.saved = new Map(); // player token -> score kept while that player is disconnected
    this.closeAt = 0;       // when an empty room closes
    this.bot = null;       // bot that keeps a lone player company
    this.soloSince = 0;    // when the only human started waiting alone
  }
}
const rooms = new Map(); // code -> Room. Rooms exist only while someone is inside.
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no look-alike characters
function makeCode() {
  for (;;) {
    let c = '';
    for (let i = 0; i < 5; i++) c += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
    if (!rooms.has(c)) return c;
  }
}
function createRoom(name, priv) {
  const room = new Room(makeCode(), name, priv);
  rooms.set(room.code, room);
  return room;
}
function dropRoom(room) {
  if (room.resetTimer) { clearTimeout(room.resetTimer); room.resetTimer = null; }
  rooms.delete(room.code);
}
const cleanRoomName = (n, fallback) => String(n || '').replace(/[<>&"'`\u0000-\u001f]/g, '').trim().slice(0, 20) || fallback;

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const r2 = (v) => Math.round(v * 100) / 100;
const cleanName = (n) => String(n || 'Soldier').replace(/[<>&"'`\u0000-\u001f]/g, '').trim().slice(0, 14) || 'Soldier';

function send(ws, obj) { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); }
function broadcast(room, obj) {
  const s = JSON.stringify(obj);
  for (const p of room.players.values()) if (p.ws.readyState === 1) p.ws.send(s);
}
const rosterList = (room) => [...room.players.values()].map((p) => ({ id: p.id, name: p.name, c: p.c, bot: p.bot ? 1 : 0 }));

function roomInfo(room) {
  let leader = null;
  for (const p of room.players.values()) if (!leader || p.kills > leader.kills) leader = p;
  return {
    id: room.id, name: room.name, players: humanCount(room), max: MAX_PLAYERS, over: room.gameOver,
    leader: leader && leader.kills > 0 ? { name: leader.name, kills: leader.kills } : null
  };
}

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
        if (y >= q.y && y <= q.y + (q.sl ? SL_BODY_H : q.cr ? CR_BODY_H : BODY_H)) best = { t, head: false };
      }
    }
  }
  const lx = ox - q.x, ly = oy - (q.y + (q.sl ? SL_HEAD_Y : q.cr ? CR_HEAD_Y : HEAD_Y)), lz = oz - q.z;
  const bq = lx * dx + ly * dy + lz * dz;
  const cq = lx * lx + ly * ly + lz * lz - HEAD_R * HEAD_R;
  const dsc = bq * bq - cq;
  if (dsc >= 0) {
    const t = -bq - Math.sqrt(dsc);
    if (t >= 0 && (!best || t < best.t + 0.05)) best = { t, head: true };
  }
  return best;
}

// ---------- game logic (per room) ----------
function spawn(room, p) {
  const others = [...room.players.values()].filter((q) => q !== p && q.alive);
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
  p.cr = 0;
  p.w = 0;
  p.hp = MAX_HP;
  p.alive = true;
  p.inv = Date.now() + PROTECT_MS;
  send(p.ws, { t: 'spawn', x: p.x, y: 0, z: p.z, r: p.r, hp: p.hp });
}

function endRound(room, winner) {
  room.gameOver = true;
  room.resetAt = Date.now() + ROUND_RESET_MS;
  const scores = [...room.players.values()]
    .map((p) => ({ id: p.id, n: p.name, c: p.c, k: p.kills, d: p.deaths }))
    .sort((a, b) => b.k - a.k);
  room.lastGameOver = { w: winner.id, wn: winner.name, wc: winner.c, scores };
  broadcast(room, Object.assign({ t: 'gameover', in: ROUND_RESET_MS }, room.lastGameOver));
  room.resetTimer = setTimeout(() => resetRound(room), ROUND_RESET_MS);
}

function resetRound(room) {
  room.resetTimer = null;
  room.gameOver = false;
  room.lastGameOver = null;
  room.saved.clear();
  for (const p of room.players.values()) { p.kills = 0; p.deaths = 0; p.alive = false; }
  broadcast(room, { t: 'newround' });
  for (const p of room.players.values()) spawn(room, p);
}

function handleShoot(room, p, m) {
  if (!p.alive || room.gameOver) return;
  const now = Date.now();
  if (now - p.lastShot < FIRE_INTERVAL * 0.8) return;
  p.lastShot = now;
  applyState(p, m);
  if (p.w) return; // knife equipped, cannot shoot

  let dx = +m.dx, dy = +m.dy, dz = +m.dz;
  if (![dx, dy, dz].every(Number.isFinite)) return;
  const len = Math.hypot(dx, dy, dz);
  if (len < 1e-6) return;
  dx /= len; dy /= len; dz /= len;
  fireShot(room, p, dx, dy, dz);
}

// resolves one rifle shot from player p along a unit direction (used for humans and bots)
function fireShot(room, p, dx, dy, dz) {
  const now = Date.now();
  const ox = p.x, oy = p.y + (p.sl ? SL_EYE : p.cr ? CR_EYE : EYE), oz = p.z;
  let best = { t: MAX_RANGE, type: 'none' };
  if (dy < -1e-6) {
    const tg = -oy / dy;
    if (tg > 0 && tg < best.t) best = { t: tg, type: 'ground' };
  }
  for (const b of BOXES) {
    const t = rayBox(ox, oy, oz, dx, dy, dz, b);
    if (t !== null && t < best.t) best = { t, type: 'box' };
  }
  for (const q of room.players.values()) {
    if (q === p || !q.alive) continue;
    const h = rayPlayer(ox, oy, oz, dx, dy, dz, q);
    if (h && h.t < best.t) best = { t: h.t, type: 'player', target: q, head: h.head };
  }

  broadcast(room, {
    t: 'shot', id: p.id,
    o: [r2(ox), r2(oy), r2(oz)],
    e: [r2(ox + dx * best.t), r2(oy + dy * best.t), r2(oz + dz * best.t)],
    k: best.type
  });

  if (best.type === 'player') {
    const q = best.target;
    if (q.inv > now) return; // spawn protection
    const dmg = best.head ? HEAD_DMG : BODY_DMG;
    q.hp -= dmg; q.lastHurt = now;
    if (q.hp <= 0) {
      q.hp = 0; q.alive = false; q.deaths++;
      q.respawnAt = now + RESPAWN_MS;
      p.kills++;
      send(p.ws, { t: 'hit', h: best.head ? 1 : 0, kill: 1 });
      broadcast(room, { t: 'kill', k: p.id, v: q.id, kn: p.name, vn: q.name, kc: p.c, vc: q.c, head: best.head ? 1 : 0 });
      if (p.kills >= KILL_LIMIT) endRound(room, p);
    } else {
      send(p.ws, { t: 'hit', h: best.head ? 1 : 0, kill: 0 });
      send(q.ws, { t: 'hurt', hp: Math.ceil(q.hp), ax: r2(p.x), az: r2(p.z) });
    }
  }
}

// ---------- melee (knife) ----------
function handleMelee(room, p, m) {
  if (!p.alive || room.gameOver) return;
  const now = Date.now();
  if (now - p.lastMelee < MELEE_INTERVAL * 0.8) return;
  p.lastMelee = now;
  applyState(p, m);
  if (!p.w) return; // knife must be equipped

  let dx = +m.dx, dy = +m.dy, dz = +m.dz;
  if (![dx, dy, dz].every(Number.isFinite)) return;
  const len = Math.hypot(dx, dy, dz);
  if (len < 1e-6) return;
  dx /= len; dy /= len; dz /= len;

  const ox = p.x, oy = p.y + (p.sl ? SL_EYE : p.cr ? CR_EYE : EYE), oz = p.z;
  let best = null;
  for (const q of room.players.values()) {
    if (q === p || !q.alive) continue;
    const ch = q.sl ? 0.45 : q.cr ? 0.6 : 0.95; // body centre height
    const tx = q.x - ox, ty = (q.y + ch) - oy, tz = q.z - oz;
    const dist = Math.hypot(tx, ty, tz);
    if (dist > MELEE_RANGE || dist < 1e-6) continue;
    if ((tx * dx + ty * dy + tz * dz) / dist < MELEE_COS) continue; // not in front of the blade
    let blocked = false;
    for (const b of BOXES) {
      const t = rayBox(ox, oy, oz, tx / dist, ty / dist, tz / dist, b);
      if (t !== null && t < dist) { blocked = true; break; }
    }
    if (blocked) continue;
    if (!best || dist < best.dist) best = { q, dist, ch };
  }

  broadcast(room, {
    t: 'melee', id: p.id, k: best ? 'player' : 'none',
    e: best ? [r2(best.q.x), r2(best.q.y + best.ch), r2(best.q.z)] : null
  });
  if (!best) return;

  const q = best.q;
  if (q.inv > now) return; // spawn protection
  q.hp -= MELEE_DMG; q.lastHurt = now;
  if (q.hp <= 0) {
    q.hp = 0; q.alive = false; q.deaths++;
    q.respawnAt = now + RESPAWN_MS;
    p.kills++;
    send(p.ws, { t: 'hit', h: 0, kill: 1, mel: 1 });
    broadcast(room, { t: 'kill', k: p.id, v: q.id, kn: p.name, vn: q.name, kc: p.c, vc: q.c, head: 0, mel: 1 });
    if (p.kills >= KILL_LIMIT) endRound(room, p);
  } else {
    send(p.ws, { t: 'hit', h: 0, kill: 0, mel: 1 });
    send(q.ws, { t: 'hurt', hp: Math.ceil(q.hp), ax: r2(p.x), az: r2(p.z) });
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
  p.cr = m.cr ? 1 : 0;
  p.w = m.w ? 1 : 0;
}

// quick join: the fullest public room that still has space (or null)
function pickQuick() {
  let best = null;
  for (const r of rooms.values()) {
    if (r.priv || humanCount(r) === 0 || humanCount(r) >= MAX_PLAYERS) continue;
    if (!best || humanCount(r) > humanCount(best)) best = r;
  }
  return best;
}

// when the server is at its room limit, an empty room waiting for a dropped player is closed to make space
function evictGhost() {
  for (const r of rooms.values()) if (humanCount(r) === 0) { dropRoom(r); return true; }
  return false;
}

function onJoin(ws, m) {
  if (ws.pid) return;
  const pname = cleanName(m.name);
  const token = cleanToken(m.id);
  const fail = (msg, code) => { send(ws, { t: 'error', msg, code }); ws.close(); };
  let room = null;
  if (m.create && typeof m.create === 'object') {
    if (rooms.size >= MAX_ROOMS && !evictGhost()) return fail('The server has too many rooms open right now. Join an existing room.');
    room = createRoom(cleanRoomName(m.create.name, pname + "'s room"), !!m.create.priv);
  } else if (typeof m.room === 'string' && m.room.trim()) {
    room = rooms.get(m.room.trim().toUpperCase());
    if (!room) return fail('No room with that code. Check the code and try again.', 'no_room');
  } else {
    room = pickQuick();
    if (!room) {
      if (rooms.size >= MAX_ROOMS && !evictGhost()) return fail('All rooms are busy. Try again in a moment.');
      room = createRoom(pname + "'s room", false);
    }
  }
  // same player coming back? take over their old connection and restore their score
  let restore = null;
  if (token) {
    for (const q of room.players.values()) {
      if (!q.bot && q.token === token) {
        restore = { kills: q.kills, deaths: q.deaths, c: q.c };
        room.players.delete(q.id);
        try { q.ws.terminate(); } catch (e) { /* already closed */ }
        break;
      }
    }
    const sv = room.saved.get(token);
    if (!restore && sv && Date.now() - sv.t < SAVE_TTL_MS) restore = sv;
    room.saved.delete(token);
  }
  if (humanCount(room) >= MAX_PLAYERS) {
    send(ws, { t: 'full', name: room.name });
    ws.close();
    return;
  }
  if (room.bot) removeBot(room); // a real player arrived: the bot leaves
  room.soloSince = 0; room.closeAt = 0;
  const id = room.nextId++;
  const used = new Set([...room.players.values()].map((q) => q.c));
  let c = 0; while (used.has(c)) c++;
  if (restore && !used.has(restore.c)) c = restore.c;
  const p = {
    id, ws, token, name: pname, c,
    x: 0, y: 0, z: 0, r: 0, pt: 0, sl: 0, cr: 0, w: 0,
    hp: MAX_HP, alive: false, kills: 0, deaths: 0,
    lastShot: 0, lastMelee: 0, lastHurt: 0, inv: 0, respawnAt: 0
  };
  if (restore) { p.kills = restore.kills; p.deaths = restore.deaths; }
  ws.pid = id;
  ws.room = room;
  room.players.set(id, p);
  send(ws, { t: 'welcome', id, room: room.code, roomName: room.name, priv: room.priv, roster: rosterList(room) });
  broadcast(room, { t: 'roster', roster: rosterList(room) });
  if (restore && (restore.kills || restore.deaths)) send(ws, { t: 'notice', msg: 'Welcome back. Your score was restored: ' + restore.kills + ' kills.' });
  if (room.gameOver && room.lastGameOver) {
    send(ws, Object.assign({ t: 'gameover', in: Math.max(0, room.resetAt - Date.now()) }, room.lastGameOver));
  } else {
    spawn(room, p);
  }
}

// ---------- bots: keep a lone player company ----------
const BOTS_ON = parseInt(process.env.BOTS || '1', 10) > 0;
const BOT_DELAY_MS = Math.max(0, parseFloat(process.env.BOT_DELAY || '10')) * 1000;
const ROOM_GRACE_MS = Math.max(0, parseFloat(process.env.ROOM_GRACE || '90')) * 1000; // empty rooms stay open this long so a dropped player can rejoin
const SAVE_TTL_MS = 10 * 60 * 1000;   // how long a disconnected player's score is remembered
const cleanToken = (t) => (typeof t === 'string' && /^[A-Za-z0-9_-]{16,64}$/.test(t) ? t : '');
const BOT_NAMES = [
  'Kaal', 'Ghost', 'Viper', 'DeadShot',
  'SherX', 'Rudra', 'Phantom', 'Havoc',
  'RajaOP', 'Reaper', 'Toofan', 'Rogue',
  'Zoro', 'Razor', 'Ronin', 'Venom'
];
// pick a name no one in the room is already using, so the bot reads like any other player
function pickBotName(room) {
  const taken = new Set([...room.players.values()].map((q) => q.name.toLowerCase()));
  const free = BOT_NAMES.filter((n) => !taken.has(n.toLowerCase()));
  const list = free.length ? free : BOT_NAMES;
  return list[Math.floor(Math.random() * list.length)];
}
const BOT_SIGHT = 70, BOT_R = 0.5, BOT_WALK = 4.2, BOT_RUN = 6;
const DEAD_WS = { readyState: 3, send() {}, close() {} }; // bots have no connection
const wrapAng = (a) => Math.atan2(Math.sin(a), Math.cos(a));

function humanCount(room) {
  let n = 0;
  for (const p of room.players.values()) if (!p.bot) n++;
  return n;
}
function addBot(room) {
  const id = room.nextId++;
  const used = new Set([...room.players.values()].map((q) => q.c));
  let c = 0; while (used.has(c)) c++;
  const bot = {
    id, ws: DEAD_WS, bot: true, name: pickBotName(room), c,
    x: 0, y: 0, z: 0, r: 0, pt: 0, sl: 0, cr: 0, w: 0,
    hp: MAX_HP, alive: false, kills: 0, deaths: 0,
    lastShot: 0, lastMelee: 0, lastHurt: 0, inv: 0, respawnAt: 0,
    ai: { seeT: 0, nextShot: 0, burst: 3, strafe: 1, strafeT: 0, goal: null, lastSeen: null, lastSeenT: 0, avoidT: 0, avoidDir: 1, px: 0, pz: 0, chkT: 0 }
  };
  room.players.set(id, bot);
  room.bot = bot;
  broadcast(room, { t: 'roster', roster: rosterList(room) });
  broadcast(room, { t: 'notice', msg: bot.name + ' has entered the battlefield!' });
  if (!room.gameOver) spawn(room, bot);
}
function removeBot(room, quiet) {
  if (!room.bot) return;
  const name = room.bot.name;
  room.players.delete(room.bot.id);
  room.bot = null;
  if (!quiet) {
    broadcast(room, { t: 'roster', roster: rosterList(room) });
    broadcast(room, { t: 'notice', msg: name + ' has left the battlefield.' });
  }
}
// a bot appears after BOT_DELAY seconds alone, and goes away as soon as a second human is in the room
function manageBot(room, now) {
  if (!BOTS_ON) return;
  if (humanCount(room) === 1) {
    if (!room.soloSince) room.soloSince = now;
    if (!room.bot && now - room.soloSince >= BOT_DELAY_MS) addBot(room);
  } else {
    room.soloSince = 0;
    if (room.bot) removeBot(room);
  }
}
function botBlocked(ox, oy, oz, tx, ty, tz) { // true if cover is in the way
  const dx = tx - ox, dy = ty - oy, dz = tz - oz, d = Math.hypot(dx, dy, dz);
  if (d < 1e-6) return false;
  for (const b of BOXES) {
    const t = rayBox(ox, oy, oz, dx / d, dy / d, dz / d, b);
    if (t !== null && t < d) return true;
  }
  return false;
}
function botStep(p, dx, dz, speed, dt) { // bots walk around cover, they do not climb it
  p.x += dx * speed * dt; p.z += dz * speed * dt;
  for (const b of BOXES) {
    const minx = b.x - b.w / 2, maxx = b.x + b.w / 2, minz = b.z - b.d / 2, maxz = b.z + b.d / 2;
    const cx = clamp(p.x, minx, maxx), cz = clamp(p.z, minz, maxz);
    const ex = p.x - cx, ez = p.z - cz, d2 = ex * ex + ez * ez;
    if (d2 < BOT_R * BOT_R) {
      if (d2 > 1e-8) { const d = Math.sqrt(d2); p.x = cx + ex / d * BOT_R; p.z = cz + ez / d * BOT_R; }
      else {
        const l = p.x - minx, r = maxx - p.x, t = p.z - minz, bt = maxz - p.z, m = Math.min(l, r, t, bt);
        if (m === l) p.x = minx - BOT_R; else if (m === r) p.x = maxx + BOT_R; else if (m === t) p.z = minz - BOT_R; else p.z = maxz + BOT_R;
      }
    }
  }
  const lim = ARENA - 0.8;
  p.x = clamp(p.x, -lim, lim); p.z = clamp(p.z, -lim, lim);
}
function botThink(room, p, dt, now) {
  const a = p.ai, eyeY = p.y + EYE;
  let tgt = null; // nearest human we can see
  for (const q of room.players.values()) {
    if (q.bot || !q.alive) continue;
    const ch = q.sl ? 0.45 : q.cr ? 0.65 : 0.95;
    const tx = q.x - p.x, ty = q.y + ch - eyeY, tz = q.z - p.z;
    const d3 = Math.hypot(tx, ty, tz);
    if (d3 > BOT_SIGHT || botBlocked(p.x, eyeY, p.z, q.x, q.y + ch, q.z)) continue;
    if (!tgt || d3 < tgt.d3) tgt = { q, tx, ty, tz, d3, dh: Math.hypot(tx, tz) };
  }
  let wantYaw = p.r, wantPitch = 0, mx = 0, mz = 0, speed = 0;
  if (tgt) {
    a.seeT += dt; a.lastSeen = { x: tgt.q.x, z: tgt.q.z }; a.lastSeenT = now;
    wantYaw = Math.atan2(-tgt.tx, -tgt.tz); wantPitch = Math.atan2(tgt.ty, tgt.dh);
    const fx = tgt.tx / (tgt.dh || 1), fz = tgt.tz / (tgt.dh || 1); // unit vector towards the target
    a.strafeT -= dt;
    if (a.strafeT <= 0) { a.strafe = Math.random() < 0.5 ? -1 : 1; a.strafeT = 1 + Math.random() * 1.4; }
    if (tgt.dh > 22) { mx = fx; mz = fz; speed = BOT_RUN; }                                        // close the distance
    else if (tgt.dh < 8) { mx = -fx * 0.7 - fz * a.strafe * 0.7; mz = -fz * 0.7 + fx * a.strafe * 0.7; speed = BOT_WALK; } // back off
    else { mx = -fz * a.strafe; mz = fx * a.strafe; speed = BOT_WALK * 0.9; }                      // strafe
  } else {
    a.seeT = 0;
    let goal = a.lastSeen && now - a.lastSeenT < 4000 ? a.lastSeen : a.goal; // chase the last known spot, else wander
    if (!goal || Math.hypot(goal.x - p.x, goal.z - p.z) < 2.5) {
      const sp = SPAWNS[Math.floor(Math.random() * SPAWNS.length)];
      a.goal = goal = { x: sp[0] * 0.8 + (Math.random() - 0.5) * 10, z: sp[1] * 0.8 + (Math.random() - 0.5) * 10 };
      a.lastSeen = null;
    }
    const gx = goal.x - p.x, gz = goal.z - p.z, gd = Math.hypot(gx, gz) || 1;
    mx = gx / gd; mz = gz / gd; speed = BOT_WALK;
    wantYaw = Math.atan2(-mx, -mz);
  }
  if (a.avoidT > 0) { a.avoidT -= dt; const ox = mx, oz = mz; mx = -oz * a.avoidDir; mz = ox * a.avoidDir; } // sidestep when stuck on cover
  const ml = Math.hypot(mx, mz);
  if (ml > 0 && speed > 0) botStep(p, mx / ml, mz / ml, speed, dt);
  a.chkT += dt;
  if (a.chkT >= 0.5) {
    if (speed > 0 && Math.hypot(p.x - a.px, p.z - a.pz) < speed * 0.5 * 0.35) { a.avoidT = 0.8; a.avoidDir = Math.random() < 0.5 ? -1 : 1; a.goal = null; }
    a.px = p.x; a.pz = p.z; a.chkT = 0;
  }
  const turn = 7 * dt; // aim swings towards the target, it does not snap
  p.r = wrapAng(p.r + clamp(wrapAng(wantYaw - p.r), -turn, turn));
  p.pt = p.pt + clamp(wantPitch - p.pt, -turn, turn);
  if (tgt && a.seeT > 0.45 && now >= a.nextShot && Math.abs(wrapAng(wantYaw - p.r)) < 0.2) {
    const err = 0.035 + tgt.d3 * 0.0012; // gets less accurate with distance
    const yaw = p.r + (Math.random() + Math.random() - 1) * err, pit = p.pt + (Math.random() + Math.random() - 1) * err;
    fireShot(room, p, -Math.sin(yaw) * Math.cos(pit), Math.sin(pit), -Math.cos(yaw) * Math.cos(pit));
    if (--a.burst <= 0) { a.burst = 3 + Math.floor(Math.random() * 4); a.nextShot = now + 700 + Math.random() * 600; }
    else a.nextShot = now + 210;
  }
}

// ---------- tick ----------
let lastTick = Date.now();
setInterval(() => {
  const now = Date.now();
  const dt = Math.min(0.25, (now - lastTick) / 1000); lastTick = now;
  for (const room of rooms.values()) {
    if (humanCount(room) === 0) { // nobody here: keep the room for a while so a dropped player can rejoin
      if (!room.closeAt) room.closeAt = now + ROOM_GRACE_MS;
      if (now >= room.closeAt) dropRoom(room);
      continue;
    }
    if (!room.gameOver) {
      for (const p of room.players.values()) if (!p.alive && now >= p.respawnAt) spawn(room, p);
    }
    manageBot(room, now);
    if (room.bot && room.bot.alive && !room.gameOver) botThink(room, room.bot, dt, now);
    for (const p of room.players.values()) { // slow healing when not hurt for a while
      if (p.alive && p.hp < MAX_HP && now - p.lastHurt > REGEN_DELAY_MS) p.hp = Math.min(MAX_HP, p.hp + REGEN_RATE * dt);
    }
    broadcast(room, {
      t: 'snap',
      p: [...room.players.values()].map((p) => ({
        id: p.id, x: r2(p.x), y: r2(p.y), z: r2(p.z), r: r2(p.r), pt: r2(p.pt),
        hp: Math.ceil(p.hp), a: p.alive ? 1 : 0, k: p.kills, d: p.deaths, inv: p.inv > now ? 1 : 0, sl: p.sl ? 1 : 0, cr: p.cr ? 1 : 0, w: p.w ? 1 : 0
      }))
    });
  }
}, 50);

// ---------- voice chat signalling (audio itself is peer-to-peer, same room only) ----------
function relayRtc(room, p, m) {
  const q = room.players.get(Number(m.to));
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
const CFG = { killLimit: KILL_LIMIT, maxHp: MAX_HP, arena: ARENA, respawnMs: RESPAWN_MS, maxPlayers: MAX_PLAYERS, maxRooms: MAX_ROOMS, ice: ICE_SERVERS };

function json(res, obj) {
  res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}
const totalPlayers = () => [...rooms.values()].reduce((n, r) => n + humanCount(r), 0);

const server = http.createServer((req, res) => {
  let pathname;
  try { pathname = new URL(req.url, 'http://localhost').pathname; } catch (e) { res.writeHead(400); return res.end(); }
  if (pathname === '/ping') {res.writeHead(200, {'Content-Type': 'text/plain; charset=utf-8','Cache-Control': 'no-store'});return res.end('OK');}
  if (pathname === '/rooms') return json(res, { killLimit: KILL_LIMIT, max: MAX_PLAYERS, maxRooms: MAX_ROOMS, open: rooms.size,
    rooms: [...rooms.values()].filter((r) => !r.priv && humanCount(r) > 0).map(roomInfo).sort((a, b) => b.players - a.players) }); // private rooms are never listed
  if (pathname === '/status') return json(res, { players: totalPlayers(), rooms: rooms.size, maxRooms: MAX_ROOMS, killLimit: KILL_LIMIT });
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
    const room = ws.room;
    if (!room) return;
    const p = room.players.get(ws.pid);
    if (!p) return;
    if (m.t === 's') { if (p.alive) applyState(p, m); }
    else if (m.t === 'shoot') handleShoot(room, p, m);
    else if (m.t === 'melee') handleMelee(room, p, m);
    else if (m.t === 'rtc') relayRtc(room, p, m);
  });
  ws.on('close', () => {
    const room = ws.room;
    if (!room || !ws.pid) return;
    const gone = room.players.get(ws.pid);
    if (room.players.delete(ws.pid)) {
      if (gone && gone.token && (gone.kills || gone.deaths)) room.saved.set(gone.token, { kills: gone.kills, deaths: gone.deaths, c: gone.c, t: Date.now() });
      broadcast(room, { t: 'roster', roster: rosterList(room) });
      if (humanCount(room) === 0) { removeBot(room, true); room.closeAt = Date.now() + ROOM_GRACE_MS; } // closes after the grace period
    }
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
  console.log(`Mudline running on http://localhost:${PORT}  (rooms are created on demand, up to ${MAX_ROOMS}; max ${MAX_PLAYERS} players each, first to ${KILL_LIMIT} kills)`);
});
