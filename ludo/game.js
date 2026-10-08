'use strict';
/*
 * Ludo room + rules engine. The server is authoritative: clients only send
 * "roll" and "move" requests, and receive events describing what happened.
 * No network library is needed here; sockets only need send() and readyState.
 */
const crypto = require('crypto');

const START = [0, 13, 26, 39];
const SAFE = new Set([0, 13, 26, 39, 8, 21, 34, 47]);
const MAX_ROOMS = 1000;
const OPEN = 1; // WebSocket.OPEN

const rooms = new Map();

/* ---------- helpers ---------- */
const randInt = (a, b) => crypto.randomInt(a, b + 1);

function makeCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let c;
  do { c = Array.from({ length: 4 }, () => A[crypto.randomInt(A.length)]).join(''); } while (rooms.has(c));
  return c;
}
function cleanName(n, fallback) {
  const s = String(n || '').replace(/[\u0000-\u001f<>&"']/g, '').trim().slice(0, 12);
  return s || fallback;
}
function send(ws, msg) {
  if (ws && ws.readyState === OPEN) { try { ws.send(JSON.stringify(msg)); } catch (e) { /* ignore */ } }
}
function broadcast(room, msg) {
  const data = JSON.stringify(msg);
  for (const s of room.seats) {
    if (s.ws && s.ws.readyState === OPEN) { try { s.ws.send(data); } catch (e) { /* ignore */ } }
  }
}
function later(room, ms, fn) {
  const gen = room.gen;
  setTimeout(() => {
    if (rooms.get(room.code) !== room || room.gen !== gen) return;
    fn();
  }, ms);
}
function roomInfo(room) {
  return {
    type: 'room', code: room.code, phase: room.phase, host: room.host,
    seats: room.seats.map(s => ({ kind: s.kind, name: s.name, connected: s.kind === 'human' && !!s.ws }))
  };
}
function syncMsg(room, seat) {
  const g = room.g;
  return {
    type: 'sync', room: roomInfo(room),
    game: g ? {
      tokens: g.tokens, turn: g.turn, phase: g.phase, d: g.d, rank: g.rank,
      opts: g.phase === 'move' && g.turn === seat ? g.opts : []
    } : null
  };
}
const botControlled = (room, i) => { const s = room.seats[i]; return s.kind === 'bot' || !s.ws; };

/* ---------- rules ---------- */
function trackIdx(pi, p) { return p >= 0 && p <= 50 ? (START[pi] + p) % 52 : -1; }

function movable(g, pi, d) {
  const o = [];
  g.tokens[pi].forEach((p, ti) => {
    if (p === -1) { if (d === 6) o.push(ti); }
    else if (p < 56 && p + d <= 56) o.push(ti);
  });
  return o;
}
function distinctOpts(g, pi, opts) {
  const first = opts.find(t => g.tokens[pi][t] === -1);
  return opts.filter(t => g.tokens[pi][t] !== -1 || t === first);
}
function victimsAt(g, idx, pi) {
  const v = [];
  g.tokens.forEach((arr, oi) => {
    if (oi === pi) return;
    arr.forEach((q, qi) => { if (trackIdx(oi, q) === idx) v.push([oi, qi]); });
  });
  return v;
}
function danger(g, idx, pi) {
  for (let o = 0; o < 4; o++) {
    if (o === pi) continue;
    for (const q of g.tokens[o]) {
      const j = trackIdx(o, q);
      if (j < 0) continue;
      const dist = (idx - j + 52) % 52;
      if (dist >= 1 && dist <= 6) return true;
    }
  }
  return false;
}
function botPick(g, pi, opts, d) {
  let best = opts[0], bs = -1e9;
  for (const ti of opts) {
    const p = g.tokens[pi][ti], np = p === -1 ? 0 : p + d;
    let sc = 0;
    if (np === 56) sc += 90;
    if (p === -1) sc += 70;
    if (np >= 51 && np < 56 && p < 51) sc += 45;
    if (np <= 50) {
      const idx = (START[pi] + np) % 52;
      if (SAFE.has(idx)) sc += 30;
      else {
        const v = victimsAt(g, idx, pi).length;
        if (v) sc += 100 + v * 10;
        if (danger(g, idx, pi)) sc -= 25;
      }
    }
    if (p >= 0 && p <= 50) {
      const cur = (START[pi] + p) % 52;
      if (!SAFE.has(cur) && danger(g, cur, pi)) sc += 35;
    }
    sc += np * 0.4 + Math.random() * 5;
    if (sc > bs) { bs = sc; best = ti; }
  }
  return best;
}

/* ---------- game flow ---------- */
function startGame(room) {
  room.gen++;
  room.phase = 'playing';
  room.seats.forEach((s, i) => {
    if (s.kind === 'open') { s.kind = 'bot'; s.name = `Computer ${i + 1}`; }
  });
  room.g = {
    tokens: [0, 1, 2, 3].map(() => [-1, -1, -1, -1]),
    turn: 0, phase: 'roll', sixes: 0, d: 0, opts: [], rank: [0, 0, 0, 0], ranks: 0
  };
  broadcast(room, roomInfo(room));
  broadcast(room, { type: 'start' });
  advance(room);
}

function advance(room) {
  const g = room.g;
  if (!g || room.phase !== 'playing' || !botControlled(room, g.turn)) return;
  if (g.phase === 'roll') {
    later(room, 900, () => { if (g.phase === 'roll' && botControlled(room, g.turn)) doRoll(room); });
  } else if (g.phase === 'move') {
    later(room, 800, () => {
      if (g.phase === 'move' && botControlled(room, g.turn)) {
        doMove(room, botPick(g, g.turn, distinctOpts(g, g.turn, g.opts), g.d));
      }
    });
  }
}

function doRoll(room) {
  const g = room.g;
  if (!g || g.phase !== 'roll') return;
  g.phase = 'wait';
  broadcast(room, { type: 'rolling', seat: g.turn });
  later(room, 750, () => {
    const pi = g.turn, d = randInt(1, 6);
    g.d = d;
    g.sixes = d === 6 ? g.sixes + 1 : 0;

    if (g.sixes === 3) {
      g.sixes = 0;
      broadcast(room, { type: 'rolled', seat: pi, d, opts: [], three: true });
      later(room, 1400, () => endTurn(room, false, ''));
      return;
    }
    const opts = movable(g, pi, d);
    if (!opts.length) {
      broadcast(room, { type: 'rolled', seat: pi, d, opts: [] });
      later(room, 1100, () => endTurn(room, d === 6, d === 6 ? 'six' : ''));
      return;
    }
    const distinct = distinctOpts(g, pi, opts);
    if (distinct.length === 1) {
      g.phase = 'auto'; g.opts = [distinct[0]];
      broadcast(room, { type: 'rolled', seat: pi, d, opts: [], auto: true });
      later(room, 500, () => doMove(room, distinct[0]));
      return;
    }
    g.phase = 'move'; g.opts = opts;
    broadcast(room, { type: 'rolled', seat: pi, d, opts, choose: true });
    advance(room);
  });
}

function doMove(room, ti) {
  const g = room.g;
  if (!g || (g.phase !== 'move' && g.phase !== 'auto') || !g.opts.includes(ti)) return;
  const pi = g.turn, d = g.d;
  g.phase = 'wait';

  const from = g.tokens[pi][ti];
  const to = from === -1 ? 0 : from + d;
  g.tokens[pi][ti] = to;

  const captured = [];
  const home = to === 56;
  if (to <= 50) {
    const idx = (START[pi] + to) % 52;
    if (!SAFE.has(idx)) {
      victimsAt(g, idx, pi).forEach(([oi, qi]) => { g.tokens[oi][qi] = -1; captured.push([oi, qi]); });
    }
  }

  let finished = 0, over = false;
  if (g.tokens[pi].every(p => p === 56)) {
    g.rank[pi] = ++g.ranks;
    finished = g.rank[pi];
    const left = [0, 1, 2, 3].filter(i => !g.rank[i]);
    if (left.length <= 1) {
      if (left.length === 1) g.rank[left[0]] = ++g.ranks;
      over = true;
    }
  }
  const extra = d === 6 || captured.length > 0 || home;
  const why = captured.length ? 'capture' : home ? 'home' : d === 6 ? 'six' : '';

  broadcast(room, { type: 'moved', seat: pi, ti, from, to, d, captured, home, finished });

  const delay = (from === -1 ? 300 : d * 190) + (captured.length ? 800 : 0) + (home ? 800 : 0) + (finished ? 1000 : 0) + 450;
  later(room, delay, () => { if (over) gameOver(room); else endTurn(room, extra, why); });
}

function endTurn(room, extra, why) {
  const g = room.g;
  if (!g || room.phase !== 'playing') return;
  if (!extra || g.rank[g.turn]) {
    g.sixes = 0; why = '';
    do { g.turn = (g.turn + 1) % 4; } while (g.rank[g.turn]);
  }
  g.phase = 'roll'; g.d = 0; g.opts = [];
  broadcast(room, { type: 'turn', turn: g.turn, why });
  advance(room);
}

function gameOver(room) {
  room.phase = 'over';
  room.g.phase = 'over';
  broadcast(room, { type: 'over', rank: room.g.rank });
  broadcast(room, roomInfo(room));
}

/* ---------- rooms and connections ---------- */
function destroyRoom(room) {
  room.gen++;
  if (room.cleanup) clearTimeout(room.cleanup);
  rooms.delete(room.code);
}
function scheduleCleanup(room) {
  if (room.cleanup) clearTimeout(room.cleanup);
  room.cleanup = setTimeout(() => {
    if (rooms.get(room.code) === room && !room.seats.some(s => s.ws)) destroyRoom(room);
  }, 10 * 60 * 1000);
  if (room.cleanup.unref) room.cleanup.unref();
}
function attach(ws, room, i) {
  ws.room = room; ws.seat = i;
  room.seats[i].ws = ws;
  if (room.cleanup) { clearTimeout(room.cleanup); room.cleanup = null; }
}
function fixHost(room) {
  const ok = i => room.seats[i].kind === 'human' && room.seats[i].ws;
  if (ok(room.host)) return;
  const n = [0, 1, 2, 3].find(ok);
  if (n !== undefined) room.host = n;
}

function leave(ws, explicit) {
  const room = ws.room;
  if (!room) return;
  const i = ws.seat, s = room.seats[i];
  ws.room = null; ws.seat = -1;
  if (s.ws !== ws) return; // seat already taken over by a newer connection
  s.ws = null;

  if (room.phase === 'lobby') {
    s.kind = 'open'; s.name = ''; s.secret = null;
    if (!room.seats.some(x => x.kind === 'human')) return destroyRoom(room);
    if (room.host === i) room.host = room.seats.findIndex(x => x.kind === 'human');
    return broadcast(room, roomInfo(room));
  }

  if (explicit) { s.kind = 'bot'; s.secret = null; }
  if (!room.seats.some(x => x.kind === 'human')) return destroyRoom(room);
  fixHost(room);
  if (!room.seats.some(x => x.ws)) scheduleCleanup(room);
  broadcast(room, roomInfo(room));
  if (room.g && room.phase === 'playing' && room.g.turn === i) advance(room);
}

function handleClose(ws) { leave(ws, false); }

function handleMessage(ws, m) {
  switch (m.type) {
    case 'create': {
      if (ws.room) return;
      if (rooms.size >= MAX_ROOMS) return send(ws, { type: 'error', code: 'busy', message: 'The server is busy. Try again soon.' });
      const room = {
        code: makeCode(), phase: 'lobby', host: 0, g: null, gen: 0, cleanup: null,
        seats: [0, 1, 2, 3].map(() => ({ kind: 'open', name: '', secret: null, ws: null }))
      };
      rooms.set(room.code, room);
      const s = room.seats[0];
      s.kind = 'human'; s.name = cleanName(m.name, 'Player 1'); s.secret = crypto.randomBytes(12).toString('hex');
      attach(ws, room, 0);
      send(ws, { type: 'joined', code: room.code, seat: 0, secret: s.secret, room: roomInfo(room) });
      broadcast(room, roomInfo(room));
      return;
    }

    case 'join': {
      if (ws.room) return;
      const code = String(m.code || '').toUpperCase().trim();
      const room = rooms.get(code);
      if (!room) return send(ws, { type: 'error', code: 'no_room', message: 'Room not found. Check the code.' });

      if (m.secret) {
        const i = room.seats.findIndex(s => s.kind === 'human' && s.secret === m.secret);
        if (i >= 0) {
          const s = room.seats[i];
          if (s.ws && s.ws !== ws) { const old = s.ws; old.room = null; old.seat = -1; try { old.close(); } catch (e) { /* ignore */ } }
          attach(ws, room, i);
          fixHost(room);
          send(ws, { type: 'joined', code, seat: i, secret: s.secret, room: roomInfo(room) });
          broadcast(room, roomInfo(room));
          if (room.g) send(ws, syncMsg(room, i));
          if (room.g && room.phase === 'playing' && room.g.turn === i) advance(room);
          return;
        }
      }
      if (room.phase !== 'lobby') return send(ws, { type: 'error', code: 'started', message: 'That game has already started.' });
      const i = room.seats.findIndex(s => s.kind === 'open');
      if (i < 0) return send(ws, { type: 'error', code: 'full', message: 'That room is full.' });
      const s = room.seats[i];
      s.kind = 'human'; s.name = cleanName(m.name, `Player ${i + 1}`); s.secret = crypto.randomBytes(12).toString('hex');
      attach(ws, room, i);
      send(ws, { type: 'joined', code, seat: i, secret: s.secret, room: roomInfo(room) });
      broadcast(room, roomInfo(room));
      return;
    }

    case 'seat': { // host adds or removes a computer player in the lobby
      const room = ws.room;
      if (!room || room.phase !== 'lobby' || ws.seat !== room.host) return;
      const i = m.seat;
      if (!Number.isInteger(i) || i < 0 || i > 3 || room.seats[i].kind === 'human') return;
      if (m.kind === 'bot') { room.seats[i].kind = 'bot'; room.seats[i].name = `Computer ${i + 1}`; }
      else if (m.kind === 'open') { room.seats[i].kind = 'open'; room.seats[i].name = ''; }
      else return;
      broadcast(room, roomInfo(room));
      return;
    }

    case 'start': {
      const room = ws.room;
      if (!room || room.phase !== 'lobby' || ws.seat !== room.host) return;
      startGame(room);
      return;
    }

    case 'rematch': {
      const room = ws.room;
      if (!room || room.phase !== 'over' || ws.seat !== room.host) return;
      startGame(room);
      return;
    }

    case 'roll': {
      const room = ws.room;
      if (!room || room.phase !== 'playing') return;
      const g = room.g;
      if (g.phase !== 'roll' || g.turn !== ws.seat || room.seats[ws.seat].ws !== ws) return;
      doRoll(room);
      return;
    }

    case 'move': {
      const room = ws.room;
      if (!room || room.phase !== 'playing') return;
      const g = room.g;
      if (g.phase !== 'move' || g.turn !== ws.seat || room.seats[ws.seat].ws !== ws) return;
      if (!Number.isInteger(m.ti)) return;
      doMove(room, m.ti);
      return;
    }

    case 'leave':
      leave(ws, true);
      return;

    default:
  }
}

module.exports = { handleMessage, handleClose, rooms };
