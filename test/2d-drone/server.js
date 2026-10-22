'use strict';
/*
  Tandem Lift: the game simulation. It runs ONLY on the server.
  Clients send fan inputs; this module updates positions and physics, checks collisions and
  rules, and produces the state that the server sends back to the players for rendering.
  No browser APIs, no dependencies.
*/
const G = 320, GROUND = 900, HXD = 95, HT = 44, HB = 42;
const STEP = 1 / 60;

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const r2 = (x) => Math.round(x * 100) / 100;
const r3 = (x) => Math.round(x * 1000) / 1000;
function mulberry32(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

/* ---------- content used by the rules (toasts and passenger chatter) ---------- */
const MEME_TEXTS = ['SUCH CITY', 'MUCH ALTITUDE', 'VERY DRONE', 'TOUCH GRASS', 'NO CAP', 'BUY HIGH SELL LOW', 'WIFI: PASSWORD123', 'STONKS', 'THIS IS FINE', 'PILOT ERROR', 'NOT A HELIPAD', 'SKILL ISSUE', 'MORE FAN', 'TWO FANS ONE BRAIN'];
const PASS = [
  { e: '\u{1F415}', lines: ['wow. such altitude.', 'much fly. very drone.', 'such pilots. much skill.', 'so rooftop. wow.'] },
  { e: '\u{1F438}', lines: ['it is wednesday, my dudes', 'rare pilots. much wow.', 'ribbit. i mean mayday.', 'this is a lily pad now'] },
  { e: '\u{1F5FF}', lines: ['no thoughts. head empty.', '...', 'stone cold. unbothered.', 'i am the cargo and i am calm'] },
  { e: '\u{1F431}', lines: ['i can haz altitude?', 'meow means mayday', 'pushing the pad off the roof in 3, 2...', 'cat-itude: 100%'] },
  { e: '\u{1F986}', lines: ['quack. mayday. quack.', 'this is a duck air force', 'we made it? quack.', 'not a goose. calm.'] },
  { e: '\u{1F984}', lines: ['sparkle protocol engaged', 'is this unicorn certified?', 'neigh. i mean hello.', 'rainbow landing gear?'] }
];
const COMMON = ['Does this thing have Wi-Fi?', 'Why are we sideways?', 'I left the stove on.', 'Left fan, more power!', 'Right fan, you are slacking!', 'I trust you both. Mostly.', 'Are we there yet?', 'Hold my coffee.', 'Is it normal to hear that noise?'];
const HURT_LINES = ['Bruh.', 'Oof. \u{1F5FF}', 'Insurance does not cover this', 'Skill issue?', 'Was that the building or the ground?'];

/* ---------- world ---------- */
function genWorld(lvl, seed) {
  const r = mulberry32(seed);
  const specs = []; let total = 200; const worldW = 2600 + lvl * 450;
  while (total < worldW) {
    const gap = r() < 0.3 ? 50 + r() * 110 : 0;
    const w = 170 + r() * 230;
    const h = 150 + r() * (280 + Math.min(lvl, 6) * 45);
    specs.push({ gap, w, h }); total += gap + w;
  }
  const n = specs.length, span = Math.max(1, Math.floor(n * 0.2));
  let ia = clamp(1 + Math.floor(r() * span), 0, n - 1), ib = clamp(n - 2 - Math.floor(r() * span), 0, n - 1);
  if (ia === ib) ib = n - 1;
  if (lvl % 2 === 0) { const t = ia; ia = ib; ib = t; }
  [ia, ib].forEach((k) => { specs[k].w = 320; specs[k].gap = Math.max(specs[k].gap, 60); specs[k].h = clamp(specs[k].h, 200, 420); });
  specs[ia].gap = Math.max(specs[ia].gap, 300);
  let x = 200; const blds = [];
  specs.forEach((sp) => {
    x += sp.gap;
    blds.push({ minX: x, maxX: x + sp.w, minY: GROUND - sp.h, maxY: GROUND, w: sp.w, h: sp.h, tint: Math.floor(r() * 6), seed: Math.floor(r() * 1e6), pad: null });
    x += sp.w;
  });
  const Wd = x + 200;
  const mkPad = (bi, name) => { const b = blds[bi]; const p = { b, bi, cx: (b.minX + b.maxX) / 2, top: b.minY, half: 140, name }; b.pad = p; return p; };
  const pickup = mkPad(ia, 'pickup'), dest = mkPad(ib, 'deliver');
  const ledges = []; const nL = 2 + Math.min(lvl, 5);
  for (let k = 0; k < nL * 6 && ledges.length < nL; k++) {
    const w = 110 + r() * 100, lx = 300 + r() * (Wd - 600), ly = GROUND - (220 + r() * 480);
    const box = { minX: lx, maxX: lx + w, minY: ly, maxY: ly + 20, ledge: true, pad: null };
    const bad = blds.some((b) => box.maxX + 60 > b.minX && box.minX - 60 < b.maxX && box.maxY + 70 > b.minY) || [pickup, dest].some((p) => box.maxX > p.cx - 260 && box.minX < p.cx + 260);
    if (!bad) ledges.push(box);
  }
  const signs = [];
  blds.forEach((b) => { if (!b.pad && r() < 0.3) signs.push({ x: (b.minX + b.maxX) / 2, y: b.minY, text: MEME_TEXTS[Math.floor(r() * MEME_TEXTS.length)] }); });
  const boxes = [];
  blds.forEach((b) => boxes.push(b)); ledges.forEach((b) => boxes.push(b));
  boxes.push({ minX: -6000, maxX: Wd + 6000, minY: GROUND, maxY: GROUND + 900, pad: null, ground: true });
  boxes.push({ minX: -1200, maxX: 0, minY: -3000, maxY: GROUND + 900, pad: null, wall: true });
  boxes.push({ minX: Wd, maxX: Wd + 1200, minY: -3000, maxY: GROUND + 900, pad: null, wall: true });
  return { W: Wd, blds, ledges, boxes, pickup, dest, signs };
}

// what the clients need to draw the level (they never simulate it)
function publicWorld(w) {
  return {
    W: r2(w.W),
    blds: w.blds.map((b) => ({ minX: r2(b.minX), maxX: r2(b.maxX), minY: r2(b.minY), w: r2(b.w), h: r2(b.h), tint: b.tint, seed: b.seed })),
    ledges: w.ledges.map((l) => ({ minX: r2(l.minX), maxX: r2(l.maxX), minY: r2(l.minY), maxY: r2(l.maxY) })),
    signs: w.signs.map((s) => ({ x: r2(s.x), y: r2(s.y), text: s.text })),
    pickup: { bi: w.pickup.bi, cx: r2(w.pickup.cx), top: r2(w.pickup.top), half: w.pickup.half },
    dest: { bi: w.dest.bi, cx: r2(w.dest.cx), top: r2(w.dest.top), half: w.dest.half }
  };
}

/* ---------- game state ---------- */
function newGame() {
  return {
    state: 'lobby', level: 1, total: 0, seedBase: (Math.random() * 1e9) | 0, world: null, pi: 0,
    d: { x: 0, y: 0, vx: 0, vy: 0, th: 0, w: 0, pr: [0, 0], grounded: false, surf: null },
    phase: 'pickup', loaded: false, settle: 0, windS: 0, windNow: 0, clock: 0, time: 0, mf: {}, sayTimer: 10, wallT: -9, events: []
  };
}
const levelSeed = (g, lvl) => g.seedBase + lvl * 7919;
function loadLevel(g, lvl) {
  g.level = lvl; g.pi = (lvl - 1) % PASS.length;
  g.world = genWorld(lvl, levelSeed(g, lvl));
  g.windS = Math.min(lvl - 1, 5) * 18;
  const d = g.d;
  d.x = g.world.pickup.b.minX - 150; d.y = GROUND - HB; d.vx = d.vy = 0; d.th = d.w = 0; d.pr = [0, 0]; d.grounded = true; d.surf = null;
  g.phase = 'pickup'; g.loaded = false; g.settle = 0; g.time = 0; g.clock = 0; g.mf = { grass: 1 }; g.sayTimer = 10; g.events = [];
}
function startGame(g) { loadLevel(g, g.level); g.state = 'play'; }
function nextLevel(g) { loadLevel(g, g.level + 1); g.state = 'play'; }
function retryLevel(g) { loadLevel(g, g.level); g.state = 'play'; }
const emit = (g, e) => g.events.push(e);

/* ---------- rules and physics ---------- */
function hurt(g) {
  if (g.state !== 'play') return;
  g.state = 'lost';
  emit(g, { e: 'hurt', a: 30, m: pick(HURT_LINES) });
  emit(g, { e: 'crash' });
}

function collide(g) {
  const d = g.d;
  let grounded = false, surf = null;
  for (const b of g.world.boxes) {
    const L = d.x - HXD, R = d.x + HXD, T = d.y - HT, B = d.y + HB;
    if (R <= b.minX || L >= b.maxX || T >= b.maxY || B + 0.5 <= b.minY) continue;
    const ox = Math.min(R - b.minX, b.maxX - L), oyTop = B - b.minY, oyBot = b.maxY - T;
    if (oyTop <= ox && oyTop <= oyBot) {
      if (d.vy > 0) {
        const bad = d.vy > 170 || Math.abs(d.vx) > 130 || Math.abs(d.th) > 0.4;
        if (bad && d.vy > 60) { hurt(g); d.y = b.minY - HB; d.vy = -d.vy * 0.3; continue; }
        d.vy = 0;
      }
      d.y = b.minY - HB;
      if (d.vy >= 0) { grounded = true; surf = b; }
    } else if (oyBot <= ox) {
      d.y = b.maxY + HT;
      if (d.vy < 0) { if (-d.vy > 60) hurt(g); d.vy = -d.vy * 0.2; }
    } else {
      const dir = d.x < (b.minX + b.maxX) / 2 ? -1 : 1; d.x += dir * ox;
      const vn = d.vx * dir;
      if (vn < 0) {
        if (-vn > 55 && !b.wall) hurt(g);
        d.vx -= 1.3 * vn * dir;
        if (b.wall && g.clock - g.wallT > 1.5) { g.wallT = g.clock; emit(g, { e: 'toast', s: 'Stay inside the city' }); }
      }
    }
  }
  d.grounded = grounded; d.surf = surf;
}

function memes(g, dt, speed) {
  const d = g.d, pass = PASS[g.pi], w = g.world;
  const once = (k, fn) => { if (!g.mf[k]) { g.mf[k] = 1; fn(); } };
  const toast = (s) => emit(g, { e: 'toast', s });
  if (d.grounded && d.surf && !d.surf.pad && !d.surf.ground) once('roof', () => toast('Sir, this is not a helipad \u{1F5FF}'));
  if (d.grounded && d.surf && d.surf.ground) once('grass', () => toast('Touch grass \u{1F331}'));
  if (d.y < GROUND - 1100) once('high', () => toast('Why are we this high? \u{1F633}'));
  if (speed > 340) once('fast', () => toast('Zoom zoom \u{1F680}'));
  if (Math.abs(d.w) > 3) once('spin', () => toast('Ragdoll spin cycle activated \u{1F300}'));
  if (Math.abs(d.th) > 0.8) once('side', () => toast('We are basically sideways. This is fine.'));
  if (d.pr[0] > 0.97 && d.pr[1] > 0.97) once('max', () => toast('MAX FANS. Hold on to your propeller hats \u{1F3A9}'));
  if (g.phase === 'pickup' && Math.hypot(d.x - w.pickup.cx, d.y - w.pickup.top) < 500) once('near', () => emit(g, { e: 'say', em: pass.e, s: 'Over here!! Pick me up!' }));
  if (g.loaded) { g.sayTimer -= dt; if (g.sayTimer <= 0) { g.sayTimer = 9 + Math.random() * 7; emit(g, { e: 'say', em: pass.e, s: pick(pass.lines.concat(COMMON)) }); } }
}

function completeStop(g) {
  g.settle = 0;
  if (g.phase === 'pickup') {
    g.phase = 'deliver'; g.loaded = true; g.sayTimer = 6;
    emit(g, { e: 'chime' });
    emit(g, { e: 'toast', s: 'Passengers aboard! Take off and land on the gold pad.' });
  } else {
    const w = g.world;
    const pts = Math.round(Math.max(150, 1200 + g.level * 100 - g.time * 6));
    g.total += pts; g.state = 'won';
    emit(g, { e: 'win', pts, total: g.total, time: r2(g.time), dist: Math.round(Math.abs(w.pickup.cx - w.dest.cx) / 10), level: g.level });
  }
}

// fans = [left, right], each 0 (off) or 1 (thrust)
function step(g, dt, fans) {
  if (g.state !== 'play') return;
  const d = g.d, w = g.world;
  g.time += dt; g.clock += dt;
  for (let i = 0; i < 2; i++) { const tgt = fans[i] ? 1 : 0; d.pr[i] += (tgt - d.pr[i]) * (1 - Math.exp(-(tgt > d.pr[i] ? 9 : 4) * dt)); }
  const fl = d.pr[0], fr = d.pr[1];
  g.windNow = g.windS * (Math.sin(g.clock * 0.5) * 0.6 + Math.sin(g.clock * 1.3 + 1) * 0.4);
  // each fan pushes along the body's up direction; the speed difference tilts the drone
  const A = (fl + fr) * G * 0.8;
  const ax = A * Math.sin(d.th) + (d.grounded ? 0 : g.windNow);
  const ay = G - A * Math.cos(d.th);
  d.vx += ax * dt; d.vy += ay * dt;
  const drag = Math.exp(-1.1 * dt); d.vx *= drag; d.vy *= drag;
  if (d.grounded) {
    d.vx *= Math.exp(-6 * dt);
    d.th += (0 - d.th) * (1 - Math.exp(-12 * dt)); d.w = 0;
  } else {
    d.w += (4.2 * (fl - fr) - 6 * d.th - 4.2 * d.w) * dt; d.th += d.w * dt;
    if (Math.abs(d.th) > 0.9) { d.th = Math.sign(d.th) * 0.9; d.w *= -0.3; }
  }
  d.x += d.vx * dt; d.y += d.vy * dt;
  collide(g);
  if (g.state !== 'play') return;
  if (d.y < GROUND - 1700) { d.y = GROUND - 1700; if (d.vy < 0) d.vy = 0; }
  // landing settled on the right pad picks the passengers up, or drops them off
  const speed = Math.hypot(d.vx, d.vy);
  const target = g.phase === 'pickup' ? w.pickup : w.dest;
  const onPad = d.grounded && d.surf && d.surf.pad === target && Math.abs(d.x - target.cx) < target.half;
  if (onPad && speed < 25) { g.settle += dt / 0.6; if (g.settle >= 1) completeStop(g); } else g.settle = 0;
  if (g.state === 'play') memes(g, dt, speed);
}

function snapshot(g, frozen, peers) {
  const d = g.d;
  return {
    t: 's', x: r2(d.x), y: r2(d.y), vx: r2(d.vx), vy: r2(d.vy), th: r3(d.th), w: r3(d.w), pr: [r3(d.pr[0]), r3(d.pr[1])],
    g: d.grounded ? 1 : 0, ph: g.phase, ld: g.loaded ? 1 : 0, tm: r2(g.time), sc: g.total, wm: r2(g.windNow),
    st: g.state, lv: g.level, fz: frozen ? 1 : 0, pe: peers
  };
}

module.exports = { STEP, GROUND, HB, newGame, loadLevel, startGame, nextLevel, retryLevel, step, snapshot, publicWorld, levelSeed, PASS };
