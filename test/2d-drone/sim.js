'use strict';
/*
  Tandem Lift simulation (shared by the game server and the browser).

  - Online rooms: the SERVER owns one Sim per room. It steps the physics, checks collisions and
    rules, and sends snapshots. Clients only send their thrust input and render what they receive.
  - One-keyboard play: the browser runs its own Sim locally with the same code.

  No DOM, no network, no timers in here. Time only advances when step(dt, lv) is called.
*/
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TandemSim = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const G = 320, GROUND = 900, HXD = 95, HT = 44, HB = 42;
  const TINT_COUNT = 6;
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  const pick = (a) => a[Math.floor(Math.random() * a.length)];
  function mulberry32(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

  const PASS = [
    { e: '\uD83D\uDC15', lines: ['wow. such altitude.', 'much fly. very drone.', 'such pilots. much skill.', 'so rooftop. wow.'] },
    { e: '\uD83D\uDC38', lines: ['it is wednesday, my dudes', 'rare pilots. much wow.', 'ribbit. i mean mayday.', 'this is a lily pad now'] },
    { e: '\uD83D\uDDFF', lines: ['no thoughts. head empty.', '...', 'stone cold. unbothered.', 'i am the cargo and i am calm'] },
    { e: '\uD83D\uDC31', lines: ['i can haz altitude?', 'meow means mayday', 'pushing the pad off the roof in 3, 2...', 'cat-itude: 100%'] },
    { e: '\uD83E\uDD86', lines: ['quack. mayday. quack.', 'this is a duck air force', 'we made it? quack.', 'not a goose. calm.'] },
    { e: '\uD83E\uDD84', lines: ['sparkle protocol engaged', 'is this unicorn certified?', 'neigh. i mean hello.', 'rainbow landing gear?'] }
  ];
  const COMMON = ['Does this thing have Wi-Fi?', 'Why are we sideways?', 'I left the stove on.', 'Left fan, more power!', 'Right fan, you are slacking!',
    'I trust you both. Mostly.', 'Are we there yet?', 'Hold my coffee.', 'Is it normal to hear that noise?'];
  const MEME_TEXTS = ['SUCH CITY', 'MUCH ALTITUDE', 'VERY DRONE', 'TOUCH GRASS', 'NO CAP', 'BUY HIGH SELL LOW', 'WIFI: PASSWORD123', 'STONKS',
    'THIS IS FINE', 'PILOT ERROR', 'NOT A HELIPAD', 'SKILL ISSUE', 'MORE FAN', 'TWO FANS ONE BRAIN'];
  const HURT_LINES = ['Bruh.', 'Oof. \uD83D\uDDFF', 'Insurance does not cover this', 'Skill issue?', 'Was that the building or the ground?'];

  /* ---------- world generation (deterministic from the seed) ---------- */
  // visuals=false skips decoration (signs, skyline, clouds, stars) that only the renderer needs.
  function genWorld(lvl, seed, visuals) {
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
      blds.push({ minX: x, maxX: x + sp.w, minY: GROUND - sp.h, maxY: GROUND, w: sp.w, h: sp.h, tint: Math.floor(r() * TINT_COUNT), seed: Math.floor(r() * 1e6), pad: null });
      x += sp.w;
    });
    const Wd = x + 200;
    const mkPad = (b, color, name) => { const p = { b, cx: (b.minX + b.maxX) / 2, top: b.minY, half: 140, color, name }; b.pad = p; return p; };
    const pickup = mkPad(blds[ia], '#a6e35a', 'pickup'), dest = mkPad(blds[ib], '#ffc857', 'deliver');
    const ledges = []; const nL = 2 + Math.min(lvl, 5);
    for (let k = 0; k < nL * 6 && ledges.length < nL; k++) {
      const w = 110 + r() * 100, lx = 300 + r() * (Wd - 600), ly = GROUND - (220 + r() * 480);
      const box = { minX: lx, maxX: lx + w, minY: ly, maxY: ly + 20, ledge: true, pad: null };
      const bad = blds.some((b) => box.maxX + 60 > b.minX && box.minX - 60 < b.maxX && box.maxY + 70 > b.minY) ||
        [pickup, dest].some((p) => box.maxX > p.cx - 260 && box.minX < p.cx + 260);
      if (!bad) ledges.push(box);
    }
    const signs = [], far = [], mid = [], clouds = [], stars = [];
    if (visuals) {
      blds.forEach((b) => { if (!b.pad && r() < 0.3) signs.push({ x: (b.minX + b.maxX) / 2, y: b.minY, text: MEME_TEXTS[Math.floor(r() * MEME_TEXTS.length)] }); });
      for (let fx = -600; fx < Wd + 900; fx += 50 + r() * 80) far.push({ x: fx, w: 50 + r() * 80, h: 140 + r() * 320 });
      for (let fx = -600; fx < Wd + 900; fx += 80 + r() * 110) mid.push({ x: fx, w: 70 + r() * 110, h: 100 + r() * 260 });
      for (let i = 0; i < 14; i++) clouds.push({ x: r() * Wd, y: GROUND - (500 + r() * 520), w: 120 + r() * 160 });
      for (let i = 0; i < 80; i++) stars.push({ x: r(), y: r() * 0.5, s: r() * 1.6 + 0.4 });
    }
    const boxes = [];
    blds.forEach((b) => boxes.push(b)); ledges.forEach((b) => boxes.push(b));
    boxes.push({ minX: -6000, maxX: Wd + 6000, minY: GROUND, maxY: GROUND + 900, pad: null, ground: true });
    boxes.push({ minX: -1200, maxX: 0, minY: -3000, maxY: GROUND + 900, pad: null, wall: true });
    boxes.push({ minX: Wd, maxX: Wd + 1200, minY: -3000, maxY: GROUND + 900, pad: null, wall: true });
    return { W: Wd, blds, ledges, boxes, pads: [pickup, dest], pickup, dest, signs, far, mid, clouds, stars };
  }

  /* ---------- the simulation ---------- */
  class Sim {
    constructor(opts) {
      this.visuals = !!(opts && opts.visuals);
      this.total = 0;
      this.level = 1;
      this.passIdx = 0;
      this.state = 'play';        // 'play' | 'won' | 'lost'
      this.phase = 'pickup';      // 'pickup' | 'deliver'
      this.loaded = false;
      this.loadProg = 0;
      this.windS = 0; this.windNow = 0;
      this.clock = 0;
      this.mf = {};
      this.sayTimer = 10;
      this.lastWall = -10;
      this.events = [];
      this.world = null; this.pickup = null; this.dest = null;
      this.d = { x: 0, y: 0, vx: 0, vy: 0, th: 0, w: 0, pr: [0, 0], lv: [0, 0], ph: [0, 0], hp: 100, time: 0, grounded: false, surf: null };
    }
    get pass() { return PASS[this.passIdx]; }
    emit(e) { this.events.push(e); }

    loadLevel(lvl, seedBase) {
      this.level = lvl; this.passIdx = (lvl - 1) % PASS.length;
      this.world = genWorld(lvl, seedBase + lvl * 7919, this.visuals);
      this.pickup = this.world.pickup; this.dest = this.world.dest;
      this.windS = Math.min(lvl - 1, 5) * 18; this.windNow = 0;
      const d = this.d;
      d.x = this.pickup.b.minX - 150; d.y = GROUND - HB; d.vx = d.vy = 0; d.th = d.w = 0;
      d.pr = [0, 0]; d.lv = [0, 0]; d.hp = 100; d.time = 0; d.grounded = true; d.surf = null;
      this.state = 'play'; this.phase = 'pickup'; this.loaded = false; this.loadProg = 0;
      this.mf = { grass: 1 }; this.sayTimer = 10; this.clock = 0; this.lastWall = -10;
      this.events.length = 0;
    }

    supportBelow() {
      const d = this.d; let y = Infinity, b0 = null;
      for (const b of this.world.boxes) {
        if (d.x + HXD <= b.minX || d.x - HXD >= b.maxX || b.wall) continue;
        if (b.minY >= d.y + HB - 2 && b.minY < y) { y = b.minY; b0 = b; }
      }
      return { y, b: b0 };
    }

    // one hit and the drone is gone
    hurt() {
      if (this.state !== 'play') return;
      this.d.hp = 0; this.state = 'lost';
      this.emit({ e: 'hurt', a: 30, m: pick(HURT_LINES) });
      this.emit({ e: 'crash' });
    }

    collide() {
      const d = this.d; let grounded = false, surf = null;
      for (const b of this.world.boxes) {
        if (this.state !== 'play') break;
        const L = d.x - HXD, R = d.x + HXD, T = d.y - HT, B = d.y + HB;
        if (R <= b.minX || L >= b.maxX || T >= b.maxY || B + 0.5 <= b.minY) continue;
        const ox = Math.min(R - b.minX, b.maxX - L), oyTop = B - b.minY, oyBot = b.maxY - T;
        if (oyTop <= ox && oyTop <= oyBot) {
          if (d.vy > 0) {
            const bad = d.vy > 170 || Math.abs(d.vx) > 130 || Math.abs(d.th) > 0.4;
            if (bad && d.vy > 60) { this.hurt(); d.y = b.minY - HB; d.vy = -d.vy * 0.3; d.w += (Math.random() - 0.5) * 3; continue; }
            d.vy = 0;
          }
          d.y = b.minY - HB;
          if (d.vy >= 0) { grounded = true; surf = b; }
        } else if (oyBot <= ox) {
          d.y = b.maxY + HT;
          if (d.vy < 0) { if (-d.vy > 60) this.hurt(); d.vy = -d.vy * 0.2; }
        } else {
          const dir = d.x < (b.minX + b.maxX) / 2 ? -1 : 1; d.x += dir * ox;
          const vn = d.vx * dir;
          if (vn < 0) {
            if (-vn > 55 && !b.wall) this.hurt();
            d.vx -= 1.3 * vn * dir;
            if (b.wall && this.clock - this.lastWall > 2) { this.lastWall = this.clock; this.emit({ e: 'toast', s: 'Stay inside the city' }); }
          }
        }
      }
      d.grounded = grounded; d.surf = surf;
    }

    // lv = [leftFan, rightFan], each 0 or 1 (thrust held or not)
    step(dt, lv) {
      if (this.state !== 'play') return;
      const d = this.d;
      this.clock += dt; d.time += dt;
      d.lv[0] = lv && lv[0] ? 1 : 0; d.lv[1] = lv && lv[1] ? 1 : 0;
      for (let i = 0; i < 2; i++) { const tgt = d.lv[i]; d.pr[i] += (tgt - d.pr[i]) * (1 - Math.exp(-(tgt > d.pr[i] ? 9 : 4) * dt)); }
      const fl = d.pr[0], fr = d.pr[1];
      this.windNow = this.windS * (Math.sin(this.clock * 0.5) * 0.6 + Math.sin(this.clock * 1.3 + 1) * 0.4);
      // each fan pushes along the body's up direction; the speed difference tilts the drone
      const A = (fl + fr) * G * 0.8;
      const ax = A * Math.sin(d.th) + (d.grounded ? 0 : this.windNow);
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
      this.collide();
      if (this.state !== 'play') return;
      if (d.y < GROUND - 1700) { d.y = GROUND - 1700; if (d.vy < 0) d.vy = 0; }
      // landing settled on the right pad picks the passengers up, or drops them off
      const speed = Math.hypot(d.vx, d.vy);
      const target = this.phase === 'pickup' ? this.pickup : this.dest;
      const onPad = d.grounded && d.surf && d.surf.pad === target && Math.abs(d.x - target.cx) < target.half;
      if (onPad && speed < 25) { this.loadProg += dt / 0.6; if (this.loadProg >= 1) this.completeStop(); } else this.loadProg = 0;
      this.memes(dt, speed);
    }

    memes(dt, speed) {
      const d = this.d, pass = this.pass, mf = this.mf;
      const once = (k, fn) => { if (!mf[k]) { mf[k] = 1; fn(); } };
      const toast = (s) => this.emit({ e: 'toast', s });
      if (d.grounded && d.surf && !d.surf.pad && !d.surf.ground) once('roof', () => toast('Sir, this is not a helipad \uD83D\uDDFF'));
      if (d.grounded && d.surf && d.surf.ground) once('grass', () => toast('Touch grass \uD83C\uDF31'));
      if (d.y < GROUND - 1100) once('high', () => toast('Why are we this high? \uD83D\uDE33'));
      if (speed > 340) once('fast', () => toast('Zoom zoom \uD83D\uDE80'));
      if (Math.abs(d.w) > 3) once('spin', () => toast('Ragdoll spin cycle activated \uD83C\uDF00'));
      if (Math.abs(d.th) > 0.8) once('side', () => toast('We are basically sideways. This is fine.'));
      if (d.pr[0] > 0.97 && d.pr[1] > 0.97) once('max', () => toast('MAX FANS. Hold on to your propeller hats \uD83C\uDFA9'));
      if (this.phase === 'pickup' && Math.hypot(d.x - this.pickup.cx, d.y - this.pickup.top) < 500) once('near', () => this.emit({ e: 'say', em: pass.e, s: 'Over here!! Pick me up!' }));
      if (this.loaded) {
        this.sayTimer -= dt;
        if (this.sayTimer <= 0) { this.sayTimer = 9 + Math.random() * 7; this.emit({ e: 'say', em: pass.e, s: pick(pass.lines.concat(COMMON)) }); }
      }
    }

    completeStop() {
      this.loadProg = 0;
      if (this.phase === 'pickup') {
        this.phase = 'deliver'; this.loaded = true; this.sayTimer = 6;
        this.emit({ e: 'chime' });
        this.emit({ e: 'toast', s: 'Passengers aboard! Take off and land on the gold pad.' });
      } else this.finish();
    }

    finish() {
      const d = this.d;
      const dist = Math.abs(this.pickup.cx - this.dest.cx);
      const pts = Math.round(Math.max(150, 1200 + this.level * 100 - d.time * 6 - (100 - d.hp) * 6));
      this.total += pts; this.state = 'won';
      this.emit({ e: 'win', pts, total: this.total, time: d.time, hp: d.hp, dist: dist / 10, level: this.level });
    }

    // what the server sends to clients about 20 times a second
    snapshot() {
      const d = this.d, r2 = (x) => Math.round(x * 100) / 100, r3 = (x) => Math.round(x * 1000) / 1000;
      return {
        t: 's', x: r2(d.x), y: r2(d.y), vx: r2(d.vx), vy: r2(d.vy), th: r3(d.th), w: r3(d.w), pr: [r3(d.pr[0]), r3(d.pr[1])],
        ph: this.phase, ld: this.loaded ? 1 : 0, tm: r2(d.time), sc: this.total, wm: r2(this.windNow), g: d.grounded ? 1 : 0, st: this.state, lvl: this.level
      };
    }
  }

  return { C: { G, GROUND, HXD, HT, HB }, PASS, COMMON, MEME_TEXTS, HURT_LINES, genWorld, Sim };
});
