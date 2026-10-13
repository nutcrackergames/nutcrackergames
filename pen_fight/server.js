'use strict';
/* =====================================================================
   PEN FIGHT server: rooms + authoritative physics + CPU stand-in.
   - Serves public/index.html (the game, from public/index.html) and a WebSocket endpoint on the same port.
   - Runs the Matter.js simulation itself; clients only send flicks and draw snapshots.
   - If a player drops mid-match the match waits GRACE_SECONDS, then a CPU takes
     their pen. If they reconnect (same token) they get control back instantly.
   ===================================================================== */
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
let WebSocketServer;
try { ({ WebSocketServer } = require('ws')); } catch (e) { console.error('Missing dependency. Run: npm install'); process.exit(1); }
const Matter = require('matter-js');
const { Engine, Bodies, Body, Composite, Events } = Matter;

const PORT = +process.env.PORT || 3000;
const gs = parseFloat(process.env.GRACE_SECONDS);
const GRACE_MS = (Number.isFinite(gs) && gs >= 0 ? gs : 30) * 1000;   // wait before CPU takes over
const LOBBY_GRACE_MS = 20000, ROOM_TTL_MS = 180000;

/* ---------------- constants shared with the client ---------------- */
const STEP = 1000 / 240, VMAX = 26, VCAP = 36;
const CAT = { PEN: 1, WALL: 2, ERASER: 4 };
const D = { x: 60, y: 85, w: 880, h: 470 }; D.r = D.x + D.w; D.b = D.y + D.h; D.cx = D.x + D.w / 2; D.cy = D.y + D.h / 2;
const PENS = {
  basic: { len: 120, w: 16, mass: 1.0, fa: 0.040, rest: 0.55, speed: 1.0, style: 'ball' },
  gel: { len: 124, w: 20, mass: 1.6, fa: 0.036, rest: 0.50, speed: 0.82, style: 'gel' },
  slim: { len: 132, w: 11, mass: 0.7, fa: 0.042, rest: 0.60, speed: 1.15, style: 'slim' },
  marker: { len: 150, w: 28, mass: 2.1, fa: 0.040, rest: 0.45, speed: 0.70, style: 'marker' },
  gold: { len: 122, w: 15, mass: 1.15, fa: 0.040, rest: 0.62, speed: 1.0, style: 'gold' },
  principal: { len: 128, w: 17, mass: 1.3, fa: 0.038, rest: 0.58, speed: 0.96, style: 'principal' },
  broken: { len: 98, w: 17, mass: 0.85, fa: 0.040, rest: 0.92, speed: 1.0, style: 'broken' }
};
const CPU_AI = { cands: 8, err: 0.10, perr: 0.10, powMin: 0.45, powMax: 0.80, aggr: 1, safe: 1, think: 1.0, powerLove: 0 };
const LINES = {
  start: ['Aaj tera pen gaya! 💀', 'Chal, aukat dikha!', 'Match shuru, pen ready?'],
  heavy: ['YEH BIK GAYI HAI GORMINT!', 'Ye classroom hai ya WWE?', 'Ouch! Pen ki haddi toot gayi!'],
  perfect: ['Bhai, kya aim hai!', 'Sniper bhi sharma jaye!'],
  both: ['Dono gaye, dono barbaad!'],
  plot: ['Plot armour activated.', 'Bach gaya, kismat hai!'],
  win: ['Class ka asli gangster!'],
  random: ['Teacher detected!', 'Last bench supremacy!', 'Pen fight ke liye paida hua tha tu!', 'Padhai later, pen fight first.']
};
const IMPACT_WORDS = ['POW!', 'BAM!', 'THAK!', 'CRACK!', 'DHAAK!'];

const rand = (a, b) => a + Math.random() * (b - a);
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const pick = a => a[Math.floor(Math.random() * a.length)];
const gauss = () => { let u = 0, v = 0; while (!u) u = Math.random(); while (!v) v = Math.random(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(6.283185 * v); };
const num = v => Number.isFinite(+v) ? +v : 0;
const cleanName = v => String(v || '').replace(/[^\p{L}\p{N} _.\-]/gu, '').trim().slice(0, 12);
const getV = b => Body.getVelocity(b), getAV = b => Body.getAngularVelocity(b);
const outside = (x, y) => x < D.x || x > D.r || y < D.y || y > D.b;
const edgeDist = (x, y) => Math.min(x - D.x, D.r - x, y - D.y, D.b - y);
const rd = (v, k) => Math.round(v * k) / k;

/* ---------------- networking helpers ---------------- */
const rooms = new Map();
const sendWs = (ws, o) => { if (ws && ws.readyState === 1) { try { ws.send(JSON.stringify(o)); } catch (e) {} } };
const humans = room => room.players.filter(p => p && p.connected);
function bc(room, o, exceptSlot) { room.players.forEach((p, i) => { if (p && p.connected && i !== exceptSlot) sendWs(p.ws, o); }); }
const lobbyInfo = room => room.players.map(p => p ? { name: p.name, pen: p.pen, connected: p.connected, cpu: p.cpu } : null);
function genCode() { const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; let c; do { c = ''; for (let i = 0; i < 5; i++) c += A[Math.floor(Math.random() * A.length)]; } while (rooms.has(c)); return c; }
const newPlayer = (name, pen) => ({ name: cleanName(name) || 'PLAYER', pen: PENS[pen] ? pen : 'basic', ws: null, token: crypto.randomBytes(12).toString('hex'), connected: false, cpu: false, left: false, timer: null, until: 0, wantRe: false });
function touchEmpty(room) { room.emptySince = humans(room).length ? 0 : (room.emptySince || Date.now()); }
function rtcCheck(room) {
  const a = room.players[0], b = room.players[1];
  if (a && b && a.connected && b.connected && !a.cpu && !b.cpu) bc(room, { t: 'rtc', cmd: 'start' });
}

/* =====================================================================
   GAME SIMULATION (canonical landscape frame: player 0 left, player 1 right)
   ===================================================================== */
function makeEngine(pi, vi) { const e = Engine.create({ positionIterations: pi || 8, velocityIterations: vi || 6 }); e.gravity.x = 0; e.gravity.y = 0; e.gravity.scale = 0; return e; }
function makePenBody(def, x, y, a) {
  const b = Bodies.rectangle(x, y, def.len, def.w, { chamfer: { radius: Math.min(def.w * 0.42, 8) }, frictionAir: def.fa, restitution: def.rest, friction: 0.04, frictionStatic: 0, slop: 0.03,
    collisionFilter: { category: CAT.PEN, mask: CAT.PEN | CAT.ERASER } });
  Body.setMass(b, def.mass * 3); Body.setAngle(b, a || 0); return b;
}
function newGame(room) {
  const g = { room, eng: makeEngine(), pens: [], eraser: null, walls: [], acc: 0, state: 'INTRO', turn: 0, turnNo: 0, starter: Math.random() < 0.5 ? 0 : 1,
    shotTaken: false, moveT: 0, quietT: 0, shotInfo: null, stats: { shots: [0, 0], hits: 0, maxImpact: 0, t0: 0 }, timers: [], clock: 0, ev: null, sinceEvent: 0,
    exam: 0, freeze: 0, shake: 0, slowT: 0, ai: null, closeCall: false, resolving: false, lastRandom: 0, sendAcc: 0, aimAcc: 0, overT: 0, dlgUntil: 0, dlgPri: 0, dlgAt: {}, lastLine: {}, sim: null };
  const t = 200, f = { isStatic: true, collisionFilter: { category: CAT.WALL, mask: CAT.ERASER }, restitution: 0.9 };
  g.walls = [Bodies.rectangle(D.cx, D.y - t / 2, D.w + 2 * t, t, f), Bodies.rectangle(D.cx, D.b + t / 2, D.w + 2 * t, t, f),
    Bodies.rectangle(D.x - t / 2, D.cy, t, D.h + 2 * t, f), Bodies.rectangle(D.r + t / 2, D.cy, t, D.h + 2 * t, f)];
  Composite.add(g.eng.world, g.walls);
  const P = room.players, jit = () => rand(-50, 50);
  const pos = [{ x: D.x + 140, y: D.cy + jit(), a: rand(-0.5, 0.5) }, { x: D.r - 140, y: D.cy + jit(), a: Math.PI + rand(-0.5, 0.5) }];
  g.pens = [0, 1].map(i => {
    const def = PENS[P[i].pen] || PENS.basic, b = makePenBody(def, pos[i].x, pos[i].y, pos[i].a); b.plugin = { pen: i };
    return { i, def, body: b, fallen: false, fall: null };
  });
  Composite.add(g.eng.world, g.pens.map(p => p.body));
  Engine.update(g.eng, STEP);
  Events.on(g.eng, 'collisionStart', e => onCollision(g, e));
  return g;
}
const after = (g, sec, fn) => g.timers.push({ t: sec, fn });
function runTimers(g, dt) {
  for (let i = 0; i < g.timers.length; i++) {
    const t = g.timers[i]; t.t -= dt;
    if (t.t <= 0) { g.timers.splice(i, 1); i--; try { t.fn(); } catch (e) { console.error(e); } }
  }
}
const sfx = (g, n, a) => bc(g.room, { t: 'sfx', n, a });
const fx = (g, x, y, n, o) => bc(g.room, { t: 'fx', x, y, n, o });
const fxt = (g, x, y, text, c, s) => bc(g.room, { t: 'fxt', x, y, w: text, c, s });
const banner = (g, x, s, c) => bc(g.room, { t: 'banner', x, s, c: c || '' });
function say(g, cat, anchor, pri, custom) {
  pri = pri || 1;
  if (g.clock < g.dlgUntil && pri <= g.dlgPri) return;
  if (pri < 3 && g.dlgAt[cat] !== undefined && g.clock - g.dlgAt[cat] < 7) return;
  const arr = LINES[cat]; if (!arr && !custom) return;
  let text = custom; if (!text) { do { text = pick(arr); } while (arr.length > 1 && text === g.lastLine[cat]); g.lastLine[cat] = text; }
  g.dlgAt[cat] = g.clock; const dur = clamp(1.2 + text.length * 0.035, 1.5, 2.5); g.dlgUntil = g.clock + dur; g.dlgPri = pri;
  bc(g.room, { t: 'dlg', x: text, a: anchor, p: pri, d: dur });
}

function onCollision(g, e) {
  for (const pr of e.pairs) {
    const a = pr.bodyA, b = pr.bodyB, pa = a.plugin && a.plugin.pen !== undefined, pb = b.plugin && b.plugin.pen !== undefined;
    const va = getV(a), vb = getV(b), imp = Math.hypot(va.x - vb.x, va.y - vb.y);
    const sp = pr.collision.supports && pr.collision.supports[0]; const cx = sp ? sp.x : (a.position.x + b.position.x) / 2, cy = sp ? sp.y : (a.position.y + b.position.y) / 2;
    if (pa && pb) {
      if (imp < 1.2) continue;
      if (g.shotInfo) { g.shotInfo.hit = true; g.shotInfo.maxImpact = Math.max(g.shotInfo.maxImpact, imp); }
      g.stats.hits++; g.stats.maxImpact = Math.max(g.stats.maxImpact, imp);
      const k = clamp(imp / 22, 0.1, 1);
      fx(g, rd(cx, 10), rd(cy, 10), Math.round(4 + k * 10), { cs: ['#ffd93b', '#fff', '#ff9f1c'], smin: 60, smax: 120 + k * 200, lmin: 0.25, lmax: 0.6 });
      if (imp > 14) { sfx(g, 'heavy'); g.shake = Math.max(g.shake, Math.min(imp * 0.5, 9)); fxt(g, rd(cx, 10), rd(cy - 30, 10), pick(IMPACT_WORDS), '#ffd93b', Math.round(26 + k * 20)); say(g, 'heavy', { pen: g.shotInfo ? g.shotInfo.by : 0 }, 2); }
      else if (imp > 6) { sfx(g, 'hit', rd(k, 100)); fxt(g, rd(cx, 10), rd(cy - 24, 10), pick(IMPACT_WORDS), '#fff', 22); }
      else sfx(g, 'hit', rd(k, 100));
    } else if ((pa || pb) && imp > 2) sfx(g, 'eraser');
  }
}
function fallPen(g, i) {
  const P = g.pens[i]; if (P.fallen) return;
  const b = P.body, v = getV(b); P.fallen = true;
  P.fall = { x: b.position.x, y: b.position.y, vx: v.x * 45, vy: v.y * 45, a: b.angle, spin: getAV(b) * 50 + rand(-3, 3) };
  Composite.remove(g.eng.world, b);
  bc(g.room, { t: 'fall', i, x: rd(P.fall.x, 10), y: rd(P.fall.y, 10), vx: rd(P.fall.vx, 10), vy: rd(P.fall.vy, 10), a: rd(P.fall.a, 1000), sp: rd(P.fall.spin, 100) });
  sfx(g, 'fall'); fx(g, rd(P.fall.x, 10), rd(P.fall.y, 10), 12, { c: '#fff', smin: 40, smax: 140, lmin: 0.3, lmax: 0.6 });
  g.slowT = 0.9; g.shake = Math.max(g.shake, 4);
  if (g.shotInfo) g.shotInfo.fellBy.push(i);
}
function postStep(g) {
  for (let i = 0; i < 2; i++) {
    const P = g.pens[i]; if (P.fallen) continue;
    const b = P.body; const v = getV(b); let sp = Math.hypot(v.x, v.y);
    if (sp > VCAP) { Body.setVelocity(b, { x: v.x / sp * VCAP, y: v.y / sp * VCAP }); sp = VCAP; }
    else if (sp < 0.04 && sp > 0) Body.setVelocity(b, { x: 0, y: 0 });
    const av = getAV(b); if (Math.abs(av) < 0.002) Body.setAngularVelocity(b, 0); else Body.setAngularVelocity(b, av * 0.996);
    const x = b.position.x, y = b.position.y;
    if (g.shotInfo && g.state === 'MOVING') g.shotInfo.minEdge[i] = Math.min(g.shotInfo.minEdge[i], edgeDist(x, y));
    if (outside(x, y)) {
      if (g.ev && g.ev.safe) { Body.setPosition(b, { x: clamp(x, D.x + 6, D.r - 6), y: clamp(y, D.y + 6, D.b - 6) }); Body.setVelocity(b, { x: 0, y: 0 }); }
      else fallPen(g, i);
    }
  }
}
function physStep(g, dt) {
  g.acc += dt * 1000; let n = 0;
  while (g.acc >= STEP && n < 60) { Engine.update(g.eng, STEP); postStep(g); g.acc -= STEP; n++; }
  if (n >= 60) g.acc = 0;
}
function pensQuiet(g) {
  for (const P of g.pens) { if (P.fallen) continue; const v = getV(P.body); if (Math.hypot(v.x, v.y) > 0.12 || Math.abs(getAV(P.body)) > 0.01) return false; }
  return !g.eraser;
}
function stopAll(g) { for (const P of g.pens) if (!P.fallen) { Body.setVelocity(P.body, { x: 0, y: 0 }); Body.setAngularVelocity(P.body, 0); } }

/* ---------------- turn flow ---------------- */
function beginTurn(g, i) {
  g.turn = i; g.shotTaken = false; g.turnNo++; g.resolving = false; g.state = 'AIM'; g.ai = null;
  if (g.exam > 0) g.exam--;
  if (maybeEvent(g)) return;
  startAim(g);
}
function startAim(g) {
  g.state = 'AIM'; g.ev = null;
  if (g.clock - g.lastRandom > 14 && Math.random() < 0.4) { g.lastRandom = g.clock; say(g, 'random', { pen: g.turn }, 1); }
}
function fire(g, idx, ang, pow, gx, gy) {
  if (g.state !== 'AIM' || g.shotTaken || g.turn !== idx || g.freeze > 0) return false;
  g.shotTaken = true; g.state = 'MOVING'; g.moveT = 0; g.quietT = 0; g.ai = null;
  bc(g.room, { t: 'aim', off: 1 });
  const P = g.pens[idx], def = P.def; let a = ang;
  if (def.style === 'broken') a += rand(-0.07, 0.07);
  let v = pow * VMAX * def.speed, spin = (def.style === 'broken' ? rand(-0.3, 0.3) : rand(-0.03, 0.03)) * (0.5 + pow);
  if (Number.isFinite(gx) && Number.isFinite(gy)) {
    const bp = P.body.position, k = clamp(((gx - bp.x) * Math.sin(a) - (gy - bp.y) * Math.cos(a)) / (def.len / 2), -1, 1);
    spin += k * v * 0.008; v *= 1 - 0.2 * Math.abs(k);
  }
  Body.setVelocity(P.body, { x: Math.cos(a) * v, y: Math.sin(a) * v }); Body.setAngularVelocity(P.body, spin);
  g.shotInfo = { by: idx, power: pow, hit: false, minEdge: [999, 999], maxImpact: 0, fellBy: [] }; g.stats.shots[idx]++;
  sfx(g, 'flick'); fx(g, rd(P.body.position.x, 10), rd(P.body.position.y, 10), 6, { c: '#fff', smin: 30, smax: 110, lmin: 0.2, lmax: 0.4 });
  return true;
}
function resolveShot(g) {
  if (g.resolving) return; g.resolving = true; stopAll(g);
  const f = [g.pens[0].fallen, g.pens[1].fallen], s = g.shotInfo;
  if (f[0] && f[1]) return endMatch(g, 'draw');
  if (f[0] || f[1]) return endMatch(g, f[0] ? 1 : 0);
  if (s.minEdge[0] < 24 && s.minEdge[1] < 24) g.closeCall = true;
  if (s.hit) { const surv = s.minEdge[0] < 20 ? 0 : (s.minEdge[1] < 20 ? 1 : -1); if (surv >= 0) say(g, 'plot', { pen: surv }, 2); }
  const op = 1 - s.by;
  after(g, 0.5, () => { if (g.state === 'MOVING') beginTurn(g, op); });
}
function endMatch(g, res) {
  g.state = 'OVER'; g.overT = 0; g.ai = null;
  const room = g.room; room.phase = 'RESULT';
  bc(room, { t: 'aim', off: 1 });
  if (res === 'draw') { banner(g, 'DOUBLE KO!', 1.8, 'red'); say(g, 'both', { x: D.cx, y: D.cy }, 4); g.shake = 8; }
  else {
    sfx(g, 'start');
    if (g.shotInfo && g.shotInfo.by === res && g.shotInfo.hit) say(g, 'perfect', { pen: res }, 3);
    after(g, 1.4, () => say(g, 'win', { pen: res }, 4));
    for (let k = 0; k < 7; k++) after(g, k * 0.18, () => { const P = g.pens[res]; if (!P.fallen) fx(g, rd(P.body.position.x, 10), rd(P.body.position.y, 10), 16, { cs: ['#ffd93b', '#ff5a4f', '#2f9bff', '#2fbf71', '#fff'], k: 1, smin: 100, smax: 380, lmin: 0.8, lmax: 1.6, g: 300, smn: 3, smx: 5 }); });
  }
  bc(room, { t: 'over', res, sh: g.stats.shots, h: g.stats.hits, mi: rd(g.stats.maxImpact, 100), tm: rd(g.clock - g.stats.t0, 10) });
}

/* ---------------- classroom events ---------------- */
function maybeEvent(g) {
  g.sinceEvent++; if (g.turnNo < 3 || g.sinceEvent < 3 || Math.random() > 0.3) return false;
  g.sinceEvent = 0; runEvent(g, pick(['teacher', 'shake', 'eraser', 'bell'])); return true;
}
function runEvent(g, kind) {
  g.state = 'EVENT'; g.ev = { kind, phase: 'intro', safe: true };
  if (kind === 'teacher') {
    banner(g, '🚨 TEACHER AA RAHE HAIN!', 1.5, 'red'); sfx(g, 'teacher');
    after(g, 1.6, () => { banner(g, 'CHUP! SIR AA GAYE!', 1.6, 'blue'); g.freeze = 1.6; });
    after(g, 3.4, () => endEvent(g));
  } else if (kind === 'shake') {
    banner(g, 'Bhai, earthquake!', 1.3, 'red'); sfx(g, 'thud'); g.shake = 14;
    after(g, 0.9, () => {
      for (const P of g.pens) {
        if (P.fallen) continue; const b = P.body; let a = rand(0, 6.283); const v = rand(2.2, 3.2), stop = v / P.def.fa * 0.9;
        if (edgeDist(b.position.x + Math.cos(a) * stop, b.position.y + Math.sin(a) * stop) < 30) a = Math.atan2(D.cy - b.position.y, D.cx - b.position.x) + rand(-0.5, 0.5);
        Body.setVelocity(b, { x: Math.cos(a) * v, y: Math.sin(a) * v }); Body.setAngularVelocity(b, rand(-0.08, 0.08));
      }
      g.ev.phase = 'settle'; g.quietT = 0; g.moveT = 0;
    });
  } else if (kind === 'eraser') {
    banner(g, 'FLYING ERASER!', 1.3, ''); sfx(g, 'eraser');
    after(g, 0.9, () => {
      const eb = Bodies.rectangle(0, 0, 52, 30, { chamfer: { radius: 6 }, frictionAir: 0.012, restitution: 0.9, friction: 0.02, collisionFilter: { category: CAT.ERASER, mask: CAT.PEN | CAT.WALL } });
      Body.setMass(eb, 0.6); const side = Math.floor(Math.random() * 2);
      const x = side ? D.x + 36 : D.r - 36, y = rand(D.y + 80, D.b - 80), a = (side ? 0 : Math.PI) + rand(-0.5, 0.5);
      Body.setPosition(eb, { x, y }); Body.setVelocity(eb, { x: Math.cos(a) * 8, y: Math.sin(a) * 8 }); Body.setAngularVelocity(eb, rand(-0.1, 0.1));
      Composite.add(g.eng.world, eb); g.eraser = { body: eb, alpha: 1 };
    });
    after(g, 4.8, () => { if (g.eraser) g.eraser.fade = true; });
  } else if (kind === 'bell') {
    banner(g, 'EXAM START!', 1.8, 'blue'); sfx(g, 'bell'); g.exam = 3; g.shake = 3;
    after(g, 2.0, () => endEvent(g));
  }
}
function endEvent(g) {
  if (g.state !== 'EVENT') return;
  if (g.eraser) { Composite.remove(g.eng.world, g.eraser.body); g.eraser = null; }
  g.ev = null; startAim(g);
}

/* ---------------- CPU stand-in (look-ahead on a scratch physics engine) ---------------- */
function simInit(g) {
  const eng = makeEngine(6, 4), b = [0, 1].map(i => makePenBody(g.pens[i].def, 0, 0, 0));
  Composite.add(eng.world, b); Engine.update(eng, STEP); g.sim = { eng, b };
}
function simulate(g, me, ang, pow) {
  const e = g.sim.eng, sb = g.sim.b; if (Engine.clear) Engine.clear(e);
  const fell = [false, false]; let hit = false;
  for (let k = 0; k < 2; k++) { const L = g.pens[k].body; Body.setPosition(sb[k], { x: L.position.x, y: L.position.y }); Body.setAngle(sb[k], L.angle); Body.setVelocity(sb[k], { x: 0, y: 0 }); Body.setAngularVelocity(sb[k], 0); }
  const def = g.pens[me].def, v = pow * VMAX * def.speed;
  Body.setVelocity(sb[me], { x: Math.cos(ang) * v, y: Math.sin(ang) * v });
  let calm = 0; const SS = 1000 / 120;
  for (let f = 0; f < 170; f++) {
    for (let s = 0; s < 2; s++) { Engine.update(e, SS); if (!hit) for (const p of e.pairs.list) if (p.isActive) { hit = true; break; } }
    let moving = false;
    for (let k = 0; k < 2; k++) {
      if (fell[k]) continue; const b = sb[k];
      if (outside(b.position.x, b.position.y)) { fell[k] = true; Body.setPosition(b, { x: 1e5 + k * 500, y: 1e5 }); Body.setVelocity(b, { x: 0, y: 0 }); continue; }
      const sp = getV(b); if (Math.hypot(sp.x, sp.y) > 0.12) moving = true;
    }
    if (fell[0] && fell[1]) break;
    calm = moving ? 0 : calm + 1; if (calm > 6) break;
  }
  return { fell, edge: [0, 1].map(k => fell[k] ? -60 : edgeDist(sb[k].position.x, sb[k].position.y)), hit };
}
function scoreResult(r, me, prof, pow) {
  const op = 1 - me; let s = 0;
  if (r.fell[op] && r.fell[me]) s = -250; else if (r.fell[op]) s = 1000; else if (r.fell[me]) s = -1500;
  else { const opD = Math.max(0, 140 - r.edge[op]), meD = Math.max(0, 140 - r.edge[me]); s = prof.aggr * opD - prof.safe * meD * 1.1 + (r.hit ? 25 : -10); }
  return s + (prof.powerLove || 0) * pow;
}
function aiStart(g) {
  if (!g.sim) simInit(g);
  g.ai = { phase: 'think', t: 0, think: CPU_AI.think * rand(0.8, 1.2), cands: null, i: 0, best: null, bestScore: -1e9, aimT: 0, plan: null };
}
function aiUpdate(g, dt) {
  const a = g.ai, me = g.turn; if (!a || g.state !== 'AIM' || g.freeze > 0) return;
  if (a.phase === 'think') {
    a.t += dt;
    if (a.t >= a.think) {
      const A = g.pens[me].body.position, B = g.pens[1 - me].body.position, base = Math.atan2(B.y - A.y, B.x - A.x), out = [];
      for (let i = 0; i < CPU_AI.cands; i++) { let ang = base; if (i > 0) ang += Math.random() < 0.8 ? gauss() * 0.3 : rand(-1.2, 1.2); out.push({ ang, pow: i === 0 ? (CPU_AI.powMin + CPU_AI.powMax) / 2 : rand(CPU_AI.powMin, CPU_AI.powMax) }); }
      a.cands = out; a.phase = 'plan';
    }
    return;
  }
  if (a.phase === 'plan') {
    let n = 0;
    while (a.i < a.cands.length && n < 3) { const c = a.cands[a.i++]; c.score = scoreResult(simulate(g, me, c.ang, c.pow), me, CPU_AI, c.pow); if (c.score > a.bestScore) { a.bestScore = c.score; a.best = c; } n++; }
    if (a.i >= a.cands.length) { a.plan = { ang: a.best.ang + gauss() * CPU_AI.err, pow: clamp(a.best.pow * (1 + gauss() * CPU_AI.perr), 0.2, 1) }; a.phase = 'aim'; a.aimT = 0; }
    return;
  }
  if (a.phase === 'aim') {
    a.aimT += dt; const k = clamp(a.aimT / 0.8, 0, 1), pw = a.plan.pow * (1 - Math.pow(1 - k, 3));
    g.aimAcc += dt;
    if (g.aimAcc > 0.066) {
      g.aimAcc = 0; const P = g.pens[me].body.position;
      bc(g.room, { t: 'aim', i: me, a: rd(a.plan.ang, 1000), p: rd(pw, 1000), v: 1, x: rd(P.x, 10), y: rd(P.y, 10) });
    }
    if (a.aimT > 1.0) { const p = a.plan; g.ai = null; fire(g, me, p.ang, p.pow); }
  }
}

/* ---------------- per-tick update ---------------- */
function stepGame(g, dt) {
  const room = g.room; let d = dt;
  if (g.slowT > 0) { g.slowT -= dt; d *= 0.35; if (g.slowT < 0) g.slowT = 0; }
  g.clock += d; g.shake = g.shake > 0.2 ? g.shake * Math.pow(0.02, dt) : 0;
  runTimers(g, d);
  if (g.freeze > 0) { g.freeze -= dt; if (g.freeze < 0) g.freeze = 0; } else physStep(g, d);
  if (g.eraser && g.eraser.fade) {
    g.eraser.alpha -= dt * 1.6;
    if (g.eraser.alpha <= 0) { Composite.remove(g.eng.world, g.eraser.body); g.eraser = null; if (g.ev) { g.ev.phase = 'settle'; g.quietT = 0; g.moveT = 0; } }
  }
  // CPU takes the turn of a player flagged as CPU; a returning human cancels it
  if (g.state === 'AIM' && !g.shotTaken) {
    const pl = room.players[g.turn];
    if (pl.cpu && !g.ai) aiStart(g);
    else if (!pl.cpu && g.ai) { g.ai = null; bc(room, { t: 'aim', off: 1 }); }
  }
  if (g.ai) aiUpdate(g, d);
  if (g.state === 'MOVING') {
    g.moveT += d; if (pensQuiet(g)) g.quietT += d; else g.quietT = 0;
    if (g.quietT >= 0.3 || g.moveT > 9) resolveShot(g);
  }
  if (g.state === 'EVENT' && g.ev && g.ev.phase === 'settle' && !g.freeze) {
    g.moveT += d; if (pensQuiet(g)) g.quietT += d; else g.quietT = 0;
    if (g.quietT >= 0.4 || g.moveT > 6) { stopAll(g); endEvent(g); }
  }
  if (g.state === 'OVER') g.overT += dt;
  g.sendAcc += dt;
  if (g.sendAcc >= 0.033) { g.sendAcc = 0; sendSnapshot(g); }
}
function sendSnapshot(g) {
  const p = g.pens.map(P => P.fallen ? 0 : (() => { const b = P.body, v = getV(b); return [rd(b.position.x, 10), rd(b.position.y, 10), rd(b.angle, 1000), rd(v.x, 100), rd(v.y, 100)]; })());
  const e = g.eraser ? [rd(g.eraser.body.position.x, 10), rd(g.eraser.body.position.y, 10), rd(g.eraser.body.angle, 1000), rd(g.eraser.alpha, 100)] : 0;
  bc(g.room, { t: 's', st: g.state, tu: g.turn, tn: g.turnNo, fr: g.freeze > 0 ? 1 : 0, ex: g.exam, sh: rd(g.shake, 10), p, e });
}

/* ---------------- rooms: start, rejoin, grace period ---------------- */
function startGame(room) {
  if (room.game) { try { Events.off && Events.off(room.game.eng); } catch (e) {} }
  room.players.forEach(p => { p.wantRe = false; });
  const g = newGame(room); room.game = g; room.phase = 'MATCH';
  const names = room.players.map(p => p.name);
  room.players.forEach((p, i) => { if (p.connected) sendWs(p.ws, { t: 'start', me: i, p0: room.players[0].pen, p1: room.players[1].pen, names }); });
  sfx(g, 'start');
  banner(g, names[0].toUpperCase() + '  VS  ' + names[1].toUpperCase(), 1.5, '');
  after(g, 1.7, () => { if (g.state !== 'INTRO') return; banner(g, names[g.starter].toUpperCase() + ' PEHLE!', 1.0, ''); say(g, 'start', { pen: 1 - g.starter }, 2); beginTurn(g, g.starter); });
  room.players.forEach((p, i) => { if (p.cpu) bc(room, { t: 'peer', i, st: 'cpu' }); });
}
function sendResume(room, slot) {
  const p = room.players[slot], g = room.game; if (!g) return;
  const names = room.players.map(q => q.name);
  sendWs(p.ws, { t: 'start', me: slot, p0: room.players[0].pen, p1: room.players[1].pen, names, resume: 1 });
  g.pens.forEach((P, i) => { if (P.fallen && P.fall) sendWs(p.ws, { t: 'fall', i, x: rd(P.fall.x, 10), y: rd(P.fall.y, 10), vx: 0, vy: 0, a: rd(P.fall.a, 1000), sp: 0 }); });
  if (g.state === 'OVER') sendWs(p.ws, { t: 'over', res: g.pens[0].fallen && g.pens[1].fallen ? 'draw' : (g.pens[0].fallen ? 1 : 0), sh: g.stats.shots, h: g.stats.hits, mi: rd(g.stats.maxImpact, 100), tm: rd(g.clock - g.stats.t0, 10) });
  const o = room.players[1 - slot];
  if (o) sendWs(p.ws, { t: 'peer', i: 1 - slot, st: o.cpu ? 'cpu' : (o.connected ? 'ok' : 'away'), ms: o.connected ? 0 : Math.max(0, o.until - Date.now()) });
}
function toCpu(room, slot) {
  const p = room.players[slot]; if (!p || p.connected) return;
  clearTimeout(p.timer); p.timer = null; p.cpu = true; p.until = 0;
  bc(room, { t: 'peer', i: slot, st: 'cpu' });
}
function startGrace(room, slot, immediate) {
  const p = room.players[slot]; if (!p) return;
  clearTimeout(p.timer);
  if (room.phase === 'LOBBY') { p.timer = setTimeout(() => removeFromLobby(room, slot), LOBBY_GRACE_MS); return; }
  if (immediate || GRACE_MS === 0) { toCpu(room, slot); return; }
  p.until = Date.now() + GRACE_MS; bc(room, { t: 'peer', i: slot, st: 'away', ms: GRACE_MS });
  p.timer = setTimeout(() => toCpu(room, slot), GRACE_MS);
}
function removeFromLobby(room, slot) {
  const p = room.players[slot]; if (!p || p.connected) return;
  if (slot === 0) { bc(room, { t: 'err', code: 'closed', msg: 'Host ne room band kar diya.' }); room.players.forEach(q => { if (q && q.ws && q.ws.ctx) q.ws.ctx = null; }); rooms.delete(room.code); return; }
  room.players[1] = null; bc(room, { t: 'lobby', players: lobbyInfo(room) }); touchEmpty(room);
}
function leaveRoom(ws, explicit) {
  const ctx = ws.ctx; if (!ctx) return; ws.ctx = null;
  const { room, slot } = ctx, p = room.players[slot]; if (!p || p.ws !== ws) return;
  p.ws = null; p.connected = false;
  if (explicit) { p.left = true; p.token = ''; }
  if (room.phase === 'LOBBY' && explicit) { clearTimeout(p.timer); removeFromLobby(room, slot); }
  else startGrace(room, slot, explicit);
  touchEmpty(room);
}
function attach(ws, room, slot) {
  const p = room.players[slot];
  if (p.ws && p.ws !== ws) { try { p.ws.ctx = null; p.ws.close(); } catch (e) {} }
  ws.ctx = { room, slot }; p.ws = ws; p.connected = true; clearTimeout(p.timer); p.timer = null; room.emptySince = 0;
}

function resumeSlot(ws, room, slot) {
  const p = room.players[slot];
  attach(ws, room, slot); p.cpu = false;
  sendWs(ws, { t: 'room', code: room.code, slot, token: p.token, phase: room.phase, players: lobbyInfo(room) });
  if (room.game && room.phase !== 'LOBBY') {
    sendResume(room, slot); bc(room, { t: 'peer', i: slot, st: 'back' }, slot);
    const g = room.game; if (g.ai && g.turn === slot) { g.ai = null; bc(room, { t: 'aim', off: 1 }); }
  } else bc(room, { t: 'lobby', players: lobbyInfo(room) });
  rtcCheck(room);
}

const wss = new WebSocketServer({ noServer: true, maxPayload: 8192 });
function onMessage(ws, m) {
  const ctx = ws.ctx;
  switch (m.t) {
    case 'ping': sendWs(ws, { t: 'pong' }); return;
    case 'create': {
      if (ctx) leaveRoom(ws, true);
      const room = { code: genCode(), players: [newPlayer(m.name, m.pen), null], phase: 'LOBBY', game: null, emptySince: 0 };
      rooms.set(room.code, room); attach(ws, room, 0);
      sendWs(ws, { t: 'room', code: room.code, slot: 0, token: room.players[0].token, phase: room.phase, players: lobbyInfo(room) });
      return;
    }
    case 'join': {
      if (ctx) leaveRoom(ws, true);
      const room = rooms.get(String(m.code || '').toUpperCase());
      if (!room) return sendWs(ws, { t: 'err', code: 'noroom', msg: 'Room nahi mila. Code check karo.' });
      // same name as a player who is away / replaced by CPU = coming back to that seat
      const nm = cleanName(m.name).toLowerCase();
      const back = nm ? room.players.findIndex(p => p && !p.connected && p.name.toLowerCase() === nm) : -1;
      if (back >= 0) { const q = room.players[back]; q.token = crypto.randomBytes(12).toString('hex'); q.left = false; resumeSlot(ws, room, back); return; }
      if (room.phase !== 'LOBBY' || room.players[1]) return sendWs(ws, { t: 'err', code: 'full', msg: 'Room full hai ya match chal raha hai. Wapas judne ke liye wahi naam daalo jo pehle tha.' });
      room.players[1] = newPlayer(m.name, m.pen); attach(ws, room, 1);
      sendWs(ws, { t: 'room', code: room.code, slot: 1, token: room.players[1].token, phase: room.phase, players: lobbyInfo(room) });
      bc(room, { t: 'lobby', players: lobbyInfo(room) }); rtcCheck(room); return;
    }
    case 'rejoin': {
      const room = rooms.get(String(m.code || '').toUpperCase());
      const slot = room ? room.players.findIndex(p => p && p.token && p.token === m.token && !p.left) : -1;
      if (!room || slot < 0) return sendWs(ws, { t: 'err', code: 'norejoin', msg: 'Room khatam ho gaya.' });
      resumeSlot(ws, room, slot); return;
    }
    default: break;
  }
  if (!ctx) return;
  const { room, slot } = ctx, p = room.players[slot], g = room.game;
  switch (m.t) {
    case 'hello': if (room.phase === 'LOBBY') { p.name = cleanName(m.name) || p.name; if (PENS[m.pen]) p.pen = m.pen; bc(room, { t: 'lobby', players: lobbyInfo(room) }); } return;
    case 'start': if (room.phase === 'LOBBY' && slot === 0 && room.players[1] && humans(room).length === 2) startGame(room); return;
    case 'shot': if (g && g.state === 'AIM' && g.turn === slot && !g.shotTaken && !p.cpu && Number.isFinite(+m.ang) && Number.isFinite(+m.pow)) fire(g, slot, +m.ang, clamp(+m.pow, 0.05, 1), num(m.gx), num(m.gy)); return;
    case 'aim': {
      if (!g || g.state !== 'AIM' || g.turn !== slot || p.cpu) return;
      if (m.off) bc(room, { t: 'aim', off: 1 }, slot);
      else bc(room, { t: 'aim', i: slot, a: num(m.a), p: clamp(num(m.p), 0, 1), v: m.v ? 1 : 0, x: num(m.x), y: num(m.y) }, slot);
      return;
    }
    case 'rematch': {
      if (room.phase !== 'RESULT') return; p.wantRe = true;
      bc(room, { t: 're', i: slot }, slot);
      if (room.players.every(q => q.cpu || q.wantRe)) startGame(room);
      return;
    }
    case 'rtc': { const o = room.players[1 - slot]; if (o && o.connected && !o.cpu && !p.cpu && (m.k === 'desc' || m.k === 'ice')) sendWs(o.ws, { t: 'rtc', k: m.k, d: m.d }); return; }
    case 'leave': leaveRoom(ws, true); return;
  }
}

/* ---------------- HTTP + WebSocket plumbing ---------------- */
const INDEX = [path.join(__dirname, 'public', 'index.html'), path.join(__dirname, 'index.html')].find(f => fs.existsSync(f));
const server = http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];
  if (url === '/health' || url === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('ok'); return; }
  if (url === '/' || url === '/index.html') {
    if (!INDEX) { res.writeHead(404); res.end('index.html not found next to the server'); return; }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' }); fs.createReadStream(INDEX).pipe(res); return;
  }
  res.writeHead(404); res.end('Not found');
});
server.on('upgrade', (req, socket, head) => wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req)));
wss.on('connection', ws => {
  ws.isAlive = true; ws.ctx = null; ws.cnt = 0;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', raw => {
    ws.isAlive = true; if (++ws.cnt > 200) return;               // ~200 msgs/sec cap
    let m; try { m = JSON.parse(raw.toString()); } catch (e) { return; }
    if (!m || typeof m.t !== 'string') return;
    try { onMessage(ws, m); } catch (e) { console.error('msg error', e); }
  });
  ws.on('close', () => leaveRoom(ws, false));
  ws.on('error', () => {});
});
setInterval(() => { wss.clients.forEach(ws => { ws.cnt = 0; }); }, 1000);
setInterval(() => { wss.clients.forEach(ws => { if (!ws.isAlive) { try { ws.terminate(); } catch (e) {} return; } ws.isAlive = false; try { ws.ping(); } catch (e) {} }); }, 20000);
setInterval(() => { const now = Date.now(); for (const [code, room] of rooms) if (room.emptySince && now - room.emptySince > ROOM_TTL_MS) rooms.delete(code); }, 30000);

let last = Date.now();
setInterval(() => {
  const now = Date.now(), dt = Math.min(0.05, (now - last) / 1000); last = now;
  for (const room of rooms.values()) {
    const g = room.game; if (!g || room.phase === 'LOBBY') continue;
    if (!humans(room).length) continue;                         // nobody watching: freeze the match
    if (g.state === 'OVER' && g.overT > 4) continue;
    try { stepGame(g, dt); } catch (e) { console.error('game error', e); }
  }
}, 16);

server.listen(PORT, () => console.log('PEN FIGHT server on :' + PORT + ' (grace ' + GRACE_MS / 1000 + 's)'));
