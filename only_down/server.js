// Drift: leaderboard + game server. No dependencies, just Node 14 or newer.
//
//   node server.js            then open  http://localhost:3000
//
// It serves drift.html and keeps the ten fastest players in leaderboard.json
// (next to this file). Everyone who opens the game through this server shares
// the same leaderboard. Set PORT=8080 to use another port.
//
// Note: times are reported by the game in the player's browser, so this is a
// friendly leaderboard, not a cheat-proof one.

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const DIR = __dirname;
const FILE = path.join(DIR, 'leaderboard.json');
const GAME = path.join(DIR, 'index.html');
const MAX_ROWS = 10;
const MIN_TIME = 15;        // seconds; anything faster is not a real run
const MAX_TIME = 86400;

function cleanName(name) {
  return String(name == null ? '' : name).replace(/[\u0000-\u001f\u007f<>&"'`]/g, '').trim().slice(0, 16) || 'Player';
}
function validRow(r) {
  return r && typeof r.name === 'string' && Number.isFinite(r.time) && r.time >= MIN_TIME && r.time <= MAX_TIME;
}
function sortRows(rows) {
  return rows.sort((a, b) => a.time - b.time || String(a.date).localeCompare(String(b.date)));
}
function readRows() {
  try {
    const rows = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return Array.isArray(rows) ? sortRows(rows.filter(validRow)).slice(0, MAX_ROWS) : [];
  } catch (e) { return []; }
}
function writeRows(rows) {                 // write to a temp file first so a crash can never leave half a file
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(rows, null, 2));
  fs.renameSync(tmp, FILE);
}

// One row per player (their fastest time), top ten overall.
function addScore(rows, entry) {
  const key = entry.name.toLowerCase();
  const old = rows.find(r => r.name.toLowerCase() === key);
  let improved = false;
  if (!old) { rows.push(entry); improved = true; }
  else if (entry.time < old.time) { Object.assign(old, entry); improved = true; }
  sortRows(rows);
  const kept = rows.slice(0, MAX_ROWS);
  const idx = kept.findIndex(r => r.name.toLowerCase() === key);
  return { rows: kept, rank: idx >= 0 ? idx + 1 : null, improved };
}

function send(res, code, body, type) {
  res.writeHead(code, {
    'Content-Type': type || 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function handler(req, res) {
  const url = (req.url || '/').split('?')[0];
  if (req.method === 'OPTIONS') return send(res, 204, '');

  if (url === '/api/leaderboard' && req.method === 'GET') return send(res, 200, readRows());

  if (url === '/api/score' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 4096) req.destroy(); });
    req.on('end', () => {
      let data;
      try { data = JSON.parse(body); } catch (e) { return send(res, 400, { error: 'bad json' }); }
      const time = Number(data && data.time);
      if (!Number.isFinite(time) || time < MIN_TIME || time > MAX_TIME) return send(res, 400, { error: 'bad time' });
      const entry = {
        name: cleanName(data.name),
        time: Math.round(time * 100) / 100,
        date: new Date().toISOString(),
        attempt: Number.isFinite(Number(data.attempt)) ? Math.max(1, Math.floor(Number(data.attempt))) : 1,
        seed: Number.isFinite(Number(data.seed)) ? Math.floor(Number(data.seed)) : 0,
      };
      const result = addScore(readRows(), entry);
      if (result.improved) writeRows(result.rows);
      send(res, 200, result);
    });
    return;
  }

  if ((url === '/' || url === '/drift.html') && req.method === 'GET') {
    fs.readFile(GAME, (err, buf) => err ? send(res, 404, 'drift.html not found next to server.js', 'text/plain') : send(res, 200, buf, 'text/html; charset=utf-8'));
    return;
  }
  send(res, 404, { error: 'not found' });
}

if (!fs.existsSync(FILE)) writeRows([]);

const server = http.createServer(handler);
module.exports = { server, addScore, cleanName, readRows, FILE };

if (require.main === module) {
  server.listen(PORT, () => {
    console.log('Drift is running:  http://localhost:' + PORT);
    console.log('Leaderboard file:  ' + FILE);
  });
}
