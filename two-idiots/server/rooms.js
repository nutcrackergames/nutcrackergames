'use strict';
/* ------------------------------------------------------------------
   Room + matchmaking logic for Two Idiots (no network code in here,
   so it can be unit tested). A "client" is any object with:
     send(obj)   - deliver a JSON-able message to that player
     closed      - true once the socket is gone
   The lobby adds: client.room, client.slot (0 = host, 1 = guest), client.name
------------------------------------------------------------------- */

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

// game messages that clients may relay to their partner
const ALLOWED = new Set(['hi', 's', 'c', 'start', 'lvl', 'done', 'win', 'cp', 'star', 'death', 'lever', 'toss']);
// only the room owner (slot 0) is allowed to send these - it keeps the guest from skipping levels
const HOST_ONLY = new Set(['start', 'lvl', 'done', 'win', 'c']);

const isNum = v => typeof v === 'number' && Number.isFinite(v);

function cleanName(n) {
  if (typeof n !== 'string') return 'Idiot';
  n = n.replace(/[\u0000-\u001f\u007f<>&"'`]/g, '').trim().slice(0, 12);
  return n || 'Idiot';
}

/* light validation so a modified client cannot flood the partner with junk */
function validGameMsg(m) {
  if (!m || typeof m !== 'object' || !ALLOWED.has(m.t)) return false;
  switch (m.t) {
    case 's':
      return isNum(m.x) && isNum(m.y) && isNum(m.vx) && isNum(m.vy) && isNum(m.f) &&
             Math.abs(m.x) < 1e5 && Math.abs(m.y) < 1e5;
    case 'c':
      return Array.isArray(m.c) && m.c.length <= 16 && m.c.every(a => Array.isArray(a) && a.length === 2 && isNum(a[0]) && isNum(a[1]));
    case 'hi':    return typeof m.name === 'string' && m.name.length <= 40;
    case 'lvl':   return Number.isInteger(m.i) && m.i >= 0 && m.i < 200;
    case 'cp':    return Number.isInteger(m.i) && m.i >= 0 && m.i < 200;
    case 'star':  return Number.isInteger(m.i) && m.i >= 0 && m.i < 200;
    case 'lever': return Number.isInteger(m.i) && m.i >= 0 && m.i < 50;
    case 'done':  return m.time === undefined || isNum(m.time);
    default:      return true;
  }
}

class Lobby {
  constructor(opts = {}) {
    this.rooms = new Map();
    this.queue = [];
    this.maxRooms = opts.maxRooms || 2000;
    this.players = 0;
  }

  stats() { return { online: this.players, rooms: this.rooms.size, waiting: this.queue.length }; }

  makeCode() {
    for (let tries = 0; tries < 50; tries++) {
      let c = '';
      for (let i = 0; i < 5; i++) c += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
      if (!this.rooms.has(c)) return c;
    }
    return null;
  }

  other(client) {
    const r = client.room;
    if (!r) return null;
    const o = r.players[client.slot === 0 ? 1 : 0];
    return o && !o.closed ? o : null;
  }

  err(client, code) { client.send({ t: 'error', code }); }

  handle(client, msg) {
    switch (msg.t) {
      case 'create': return this.create(client, msg);
      case 'join':   return this.join(client, msg);
      case 'quick':  return this.quick(client, msg);
      case 'cancel': return this.dequeue(client);
      case 'leave':  return this.leave(client);
      case 'ping':   return client.send({ t: 'pong', ts: msg.ts, online: this.players });
      case 'g': {
        const o = this.other(client);
        if (!o || !validGameMsg(msg.m)) return;
        if (HOST_ONLY.has(msg.m.t) && client.slot !== 0) return;
        return o.send({ t: 'g', m: msg.m });
      }
      case 'rtc': {                    // WebRTC voice signalling (offer / answer / ice)
        const o = this.other(client);
        if (!o) return;
        if (!['offer', 'answer', 'ice'].includes(msg.k)) return;
        if (msg.d === null || typeof msg.d !== 'object') return;
        if (JSON.stringify(msg.d).length > 30000) return;
        return o.send({ t: 'rtc', k: msg.k, d: msg.d });
      }
    }
  }

  newRoom(host) {
    const code = this.makeCode();
    if (!code) return null;
    const room = { code, players: [host, null], created: Date.now() };
    this.rooms.set(code, room);
    host.room = room; host.slot = 0;
    return room;
  }

  create(client, msg) {
    if (client.room) return this.err(client, 'already');
    this.dequeue(client);
    if (this.rooms.size >= this.maxRooms) return this.err(client, 'busy');
    client.name = cleanName(msg.name);
    const room = this.newRoom(client);
    if (!room) return this.err(client, 'busy');
    client.send({ t: 'created', code: room.code, you: 0 });
  }

  join(client, msg) {
    if (client.room) return this.err(client, 'already');
    const code = String(msg.code || '').toUpperCase();
    if (!/^[A-Z0-9]{5}$/.test(code)) return this.err(client, 'bad_code');
    const room = this.rooms.get(code);
    if (!room || !room.players[0] || room.players[0].closed) return this.err(client, 'not_found');
    if (room.players[1]) return this.err(client, 'full');
    this.dequeue(client);
    client.name = cleanName(msg.name);
    room.players[1] = client; client.room = room; client.slot = 1;
    const host = room.players[0];
    client.send({ t: 'joined', code, you: 1, peer: { name: host.name } });
    host.send({ t: 'peerjoined', peer: { name: client.name } });
  }

  quick(client, msg) {
    if (client.room) return this.err(client, 'already');
    client.name = cleanName(msg.name);
    this.queue = this.queue.filter(c => !c.closed && c !== client);
    const partner = this.queue.shift();
    if (!partner) {
      this.queue.push(client);
      return client.send({ t: 'queued' });
    }
    if (this.rooms.size >= this.maxRooms) { this.queue.unshift(partner); return this.err(client, 'busy'); }
    const room = this.newRoom(partner);
    if (!room) return this.err(client, 'busy');
    room.players[1] = client; client.room = room; client.slot = 1;
    partner.send({ t: 'matched', code: room.code, you: 0, peer: { name: client.name } });
    client.send({ t: 'matched', code: room.code, you: 1, peer: { name: partner.name } });
  }

  dequeue(client) {
    const i = this.queue.indexOf(client);
    if (i >= 0) this.queue.splice(i, 1);
  }

  /* player left (button, closed tab or lost connection) */
  leave(client) {
    this.dequeue(client);
    const room = client.room;
    if (!room) return;
    client.room = null;
    if (client.slot === 0) {                         // host left: the room is over
      const g = room.players[1];
      if (g) { g.room = null; g.slot = -1; if (!g.closed) g.send({ t: 'peerleft', hostLeft: true }); }
      this.rooms.delete(room.code);
    } else {                                         // guest left: host keeps waiting
      room.players[1] = null;
      const h = room.players[0];
      if (h && !h.closed) h.send({ t: 'peerleft' });
    }
    client.slot = -1;
  }

  /* remove abandoned rooms (host gone but never cleaned) */
  sweep(maxAgeMs = 6 * 3600 * 1000) {
    const now = Date.now();
    for (const [code, r] of this.rooms) {
      const h = r.players[0];
      if ((!h || h.closed) || now - r.created > maxAgeMs) this.rooms.delete(code);
    }
  }
}

module.exports = { Lobby, validGameMsg, cleanName, ALLOWED, HOST_ONLY };
