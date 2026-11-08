// PetFlip verify server — links a Roblox account by checking a phrase in the user's bio.
// No dependencies. Node 18+ (uses built-in fetch).
//
//   node server.js                 (listens on PORT, default 3000)
//
// Endpoints
//   POST /api/link/start  {username}  -> {token, phrase, user, expiresAt}
//   POST /api/link/check  {token}     -> {ok:true, session, user} | {ok:false, error}
//   GET  /api/me          (Authorization: Bearer <session>) -> {user}
//   POST /api/logout      (Authorization: Bearer <session>)

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const ALLOW_ORIGIN = process.env.ALLOW_ORIGIN || '*';       // set to your site's origin in production
const ROBLOX_USERS = process.env.ROBLOX_USERS || 'https://users.roblox.com';
const ROBLOX_THUMBS = process.env.ROBLOX_THUMBS || 'https://thumbnails.roblox.com';
const LINK_TTL_MS = 10 * 60 * 1000;                           // phrase valid for 10 minutes
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;              // sessions last 30 days
const DB_FILE = process.env.DB_FILE || path.join(__dirname, 'sessions.json');
const PUBLIC_DIR = path.join(__dirname, 'public');   // the site (index.html) is served from here

// ── word list for the bio phrase ──
const WORDS = ('amber anchor apple arrow aspen atlas autumn badge bamboo banjo barley basil beacon berry birch biscuit blaze bloom ' +
  'bolt bramble breeze brick brook bubble cactus camel candle canyon cargo carrot cedar cello cherry cinder clover cobalt ' +
  'comet copper coral cotton crater crayon cricket crystal cypress daisy delta denim dingo dolphin domino dragon drift dune ' +
  'eagle echo ember falcon feather fern fiddle fig flint forest fossil fox frost galaxy garnet gecko geyser ginger glacier ' +
  'goblin granite grape gravel harbor hazel heron hickory honey horizon husky igloo indigo iris island ivory jade jaguar ' +
  'jasper jelly jungle kayak kelp kettle kiwi koala lagoon lantern lava lemon lily lilac lime llama lotus lunar magnet ' +
  'mango maple marble meadow melon meteor mint mocha monsoon moose moss nectar nebula nickel nimbus noodle nutmeg oasis ' +
  'ocean olive onyx orbit orchid otter oyster panda papaya parrot pebble pepper petal pickle pine pixel planet plum polar ' +
  'poppy prism puffin pumpkin quartz quill quokka radar raven reef ripple river robin rocket rustic saffron salmon sapphire ' +
  'satin scarlet shadow shell sierra silver sketch sky sonic spark sparrow spruce squid static storm summit sunset swift ' +
  'tango thistle thunder tiger timber topaz tornado toucan tulip tundra turtle velvet violet volcano waffle walnut willow ' +
  'winter wombat yarrow yeti zebra zenith zephyr zinc').split(' ');

function randWord() { return WORDS[crypto.randomInt(WORDS.length)]; }
function makePhrase(n = 6) { return 'PetFlip ' + Array.from({ length: n }, randWord).join(' '); }
function token() { return crypto.randomBytes(24).toString('hex'); }

// ── storage ──
const pending = new Map();          // token -> {userId, name, displayName, avatar, phrase, expires}
let sessions = {};                   // session -> {user, expires}
try { sessions = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch { sessions = {}; }
function saveSessions() { fs.writeFile(DB_FILE, JSON.stringify(sessions), () => {}); }

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of pending) if (v.expires < now) pending.delete(k);
  let changed = false;
  for (const k of Object.keys(sessions)) if (sessions[k].expires < now) { delete sessions[k]; changed = true; }
  if (changed) saveSessions();
}, 60 * 1000).unref();

// ── simple per-IP rate limit ──
const hits = new Map();
function limited(ip, max = 20, windowMs = 60 * 1000) {
  const now = Date.now();
  const h = (hits.get(ip) || []).filter(t => now - t < windowMs);
  h.push(now); hits.set(ip, h);
  return h.length > max;
}

// ── Roblox lookups ──
async function lookupUser(username) {
  const r = await fetch(`${ROBLOX_USERS}/v1/usernames/users`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ usernames: [username], excludeBannedUsers: true }),
  });
  if (!r.ok) throw new Error('roblox_lookup_failed');
  const j = await r.json();
  const u = j.data && j.data[0];
  if (!u) return null;
  return { userId: u.id, name: u.name, displayName: u.displayName };
}
async function getDescription(userId) {
  const r = await fetch(`${ROBLOX_USERS}/v1/users/${userId}`, { headers: { 'cache-control': 'no-cache' } });
  if (!r.ok) throw new Error('roblox_profile_failed');
  const j = await r.json();
  return j.description || '';
}
async function getAvatar(userId) {
  try {
    const r = await fetch(`${ROBLOX_THUMBS}/v1/users/avatar-headshot?userIds=${userId}&size=150x150&format=Png&isCircular=false`);
    const j = await r.json();
    return (j.data && j.data[0] && j.data[0].imageUrl) || '';
  } catch { return ''; }
}
// Roblox filters some words to #### — compare words only, case-insensitive, ignoring punctuation/spacing
function norm(s) { return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }

// ── http helpers ──
function send(res, code, obj) {
  res.writeHead(code, {
    'content-type': 'application/json',
    'access-control-allow-origin': ALLOW_ORIGIN,
    'access-control-allow-headers': 'content-type, authorization',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
  });
  res.end(JSON.stringify(obj));
}
function body(req) {
  return new Promise((resolve) => {
    let d = '';
    req.on('data', c => { d += c; if (d.length > 1e4) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(d || '{}')); } catch { resolve({}); } });
  });
}
function auth(req) {
  const h = req.headers.authorization || '';
  const s = h.startsWith('Bearer ') ? h.slice(7) : '';
  const rec = sessions[s];
  return rec && rec.expires > Date.now() ? { s, rec } : null;
}

// ── routes ──
const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return send(res, 204, {});
  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress;
  const url = new URL(req.url, 'http://x');

  try {
    if (req.method === 'POST' && url.pathname === '/api/link/start') {
      if (limited(ip, 10)) return send(res, 429, { error: 'Too many attempts, wait a minute.' });
      const { username } = await body(req);
      if (!username || !/^[A-Za-z0-9_]{3,20}$/.test(username)) return send(res, 400, { error: 'Enter a valid Roblox username.' });
      const u = await lookupUser(username);
      if (!u) return send(res, 404, { error: 'No Roblox account with that username.' });
      const avatar = await getAvatar(u.userId);
      const t = token(), phrase = makePhrase();
      const expires = Date.now() + LINK_TTL_MS;
      pending.set(t, { ...u, avatar, phrase, expires });
      return send(res, 200, { token: t, phrase, expiresAt: expires, user: { id: u.userId, name: u.name, displayName: u.displayName, avatar } });
    }

    if (req.method === 'POST' && url.pathname === '/api/link/check') {
      if (limited(ip, 30)) return send(res, 429, { ok: false, error: 'Slow down — try again in a minute.' });
      const { token: t } = await body(req);
      const p = pending.get(t);
      if (!p) return send(res, 400, { ok: false, error: 'Code expired. Start again to get a new phrase.' });
      if (p.expires < Date.now()) { pending.delete(t); return send(res, 400, { ok: false, error: 'Code expired. Start again to get a new phrase.' }); }
      const desc = await getDescription(p.userId);
      if (!norm(desc).includes(norm(p.phrase))) {
        const filtered = /#{2,}/.test(desc);
        return send(res, 200, { ok: false, error: filtered
          ? 'Roblox filtered part of your bio (####). Start again for a new phrase.'
          : 'Phrase not found in your bio yet. Save your bio on Roblox, wait a few seconds, then check again.' });
      }
      pending.delete(t);
      const user = { id: p.userId, name: p.name, displayName: p.displayName, avatar: p.avatar };
      const s = token();
      sessions[s] = { user, expires: Date.now() + SESSION_TTL_MS };
      saveSessions();
      return send(res, 200, { ok: true, session: s, user });
    }

    if (req.method === 'GET' && url.pathname === '/api/me') {
      const a = auth(req);
      if (!a) return send(res, 401, { error: 'Not linked.' });
      return send(res, 200, { user: a.rec.user });
    }

    if (req.method === 'POST' && url.pathname === '/api/logout') {
      const a = auth(req);
      if (a) { delete sessions[a.s]; saveSessions(); }
      return send(res, 200, { ok: true });
    }

    if (req.method === 'GET' && url.pathname === '/api/health') return send(res, 200, { ok: true });

    // static site
    if (req.method === 'GET' && !url.pathname.startsWith('/api/')) {
      const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
      const file = path.join(PUBLIC_DIR, rel);
      if (!file.startsWith(PUBLIC_DIR)) return send(res, 403, { error: 'Forbidden' });
      return fs.readFile(file, (err, data) => {
        if (err) return fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (e2, d2) => {
          if (e2) { res.writeHead(404); return res.end('Not found'); }
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(d2);
        });
        const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.json': 'application/json' };
        res.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream' });
        res.end(data);
      });
    }

    send(res, 404, { error: 'Not found' });
  } catch (e) {
    console.error(e);
    send(res, 502, { error: 'Could not reach Roblox — try again.' });
  }
});

server.listen(PORT, () => console.log(`PetFlip verify server on :${PORT}`));
