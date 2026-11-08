// PetFlip server — serves the site, links Roblox accounts, and runs every game server-side
// with real inventories and a house (bot) stock. No dependencies. Node 18+.
//
// ENV
//   PORT          default 3000
//   ADMIN_KEY     required for /api/admin/*  (set a long random string on Render)
//   BOT_KEY       required for /api/bot/*    (your trade bots use this)
//   DATA_DIR      where data.json lives (point at a persistent disk in production)
//   UPGRADE_EDGE  house edge on upgrader, default 0.05
//   UPGRADE_MAX   max upgrade chance, default 0.80
//   MATCH_RANGE   how close bot/opponent value must be, default 0.10 (±10%)

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || '';
const BOT_KEY = process.env.BOT_KEY || '';
const ROBLOX_USERS = process.env.ROBLOX_USERS || 'https://users.roblox.com';
const ROBLOX_THUMBS = process.env.ROBLOX_THUMBS || 'https://thumbnails.roblox.com';
const DATA_DIR = process.env.DATA_DIR || __dirname;
const DB_FILE = path.join(DATA_DIR, 'data.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
const UPGRADE_EDGE = +process.env.UPGRADE_EDGE || 0.05;
const UPGRADE_MAX = +process.env.UPGRADE_MAX || 0.80;
const MATCH_RANGE = +process.env.MATCH_RANGE || 0.10;
const LINK_TTL_MS = 10 * 60 * 1000;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const TIERS = ['huge', 'titan', 'garg'];

// ───────────────────────── storage ─────────────────────────
function freshDb() {
  return { seq: 1, pets: [], house: [], users: {}, sessions: {}, flips: [], withdraws: [], deposits: [] };
}
let db = freshDb();
try { db = { ...freshDb(), ...JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) }; } catch { /* first run */ }
let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const tmp = DB_FILE + '.tmp';
    fs.writeFile(tmp, JSON.stringify(db), err => { if (!err) fs.rename(tmp, DB_FILE, () => {}); });
  }, 100);
}
function flushSync() { try { fs.writeFileSync(DB_FILE, JSON.stringify(db)); } catch {} }
process.on('SIGTERM', () => { flushSync(); process.exit(0); });
process.on('SIGINT', () => { flushSync(); process.exit(0); });

const uid = () => db.seq++;
const petById = id => db.pets.find(p => p.id === id);
const valOf = item => (petById(item.pid) || {}).value || 0;
const sumv = items => items.reduce((s, i) => s + valOf(i), 0);
const expand = items => items.map(i => { const p = petById(i.pid) || {}; return { uid: i.uid, pid: i.pid, name: p.name || 'Unknown pet', tier: p.tier || 'huge', img: p.img || '', value: p.value || 0 }; });

function getUser(id) { return db.users[id]; }
function ensureUser(u) {
  if (!db.users[u.id]) db.users[u.id] = { id: u.id, name: u.name, displayName: u.displayName, avatar: u.avatar, inv: [], hist: [], clientSeed: crypto.randomBytes(8).toString('hex'), nonce: 0, created: Date.now() };
  const r = db.users[u.id]; r.name = u.name; r.displayName = u.displayName; r.avatar = u.avatar || r.avatar;
  return r;
}
function publicUser(u) { return { id: u.id, name: u.name, displayName: u.displayName, avatar: u.avatar }; }

// pull specific item uids out of a user's inventory; null if any missing
function takeItems(user, uids) {
  if (!Array.isArray(uids) || !uids.length) return null;
  const set = new Set(uids.map(Number));
  if (set.size !== uids.length) return null;
  const items = user.inv.filter(i => set.has(i.uid));
  if (items.length !== set.size) return null;
  user.inv = user.inv.filter(i => !set.has(i.uid));
  return items;
}

// house picks pets from its stock whose total is within ±MATCH_RANGE of target
function houseMatch(target) {
  const lo = target * (1 - MATCH_RANGE), hi = target * (1 + MATCH_RANGE);
  const stock = [...db.house].sort((a, b) => valOf(b) - valOf(a));
  // best single item first
  let best = null;
  for (const it of stock) { const v = valOf(it); if (v >= lo && v <= hi && (!best || Math.abs(v - target) < Math.abs(valOf(best[0]) - target))) best = [it]; }
  if (best) return best;
  // greedy fill, largest first
  const pick = []; let total = 0;
  for (const it of stock) {
    const v = valOf(it);
    if (v <= 0 || total + v > hi) continue;
    pick.push(it); total += v;
    if (total >= lo) return pick;
    if (pick.length >= 12) break;
  }
  return null;
}
function removeFromHouse(items) { const s = new Set(items.map(i => i.uid)); db.house = db.house.filter(i => !s.has(i.uid)); }

// ───────────────────────── provably fair ─────────────────────────
function roll(user) {
  const server = crypto.randomBytes(32).toString('hex');
  const hash = crypto.createHash('sha256').update(server).digest('hex');
  const client = user.clientSeed; const nonce = user.nonce++;
  const h = crypto.createHash('sha256').update(server + ':' + client + ':' + nonce).digest('hex');
  return { server, hash, client, nonce, r: parseInt(h.slice(0, 13), 16) / 2 ** 52 };
}
function addHist(user, game, wager, payout, win, detail, fair) {
  user.hist.unshift({ game, wager, payout, win, detail, t: Date.now(), fair });
  if (user.hist.length > 200) user.hist.length = 200;
}

// ───────────────────────── account linking ─────────────────────────
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
const makePhrase = (n = 6) => 'PetFlip ' + Array.from({ length: n }, () => WORDS[crypto.randomInt(WORDS.length)]).join(' ');
const token = () => crypto.randomBytes(24).toString('hex');
const pending = new Map();
const norm = s => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

async function lookupUser(username) {
  const r = await fetch(`${ROBLOX_USERS}/v1/usernames/users`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ usernames: [username], excludeBannedUsers: true }) });
  if (!r.ok) throw new Error('roblox_lookup_failed');
  const u = (await r.json()).data?.[0];
  return u ? { userId: u.id, name: u.name, displayName: u.displayName } : null;
}
async function getDescription(id) {
  const r = await fetch(`${ROBLOX_USERS}/v1/users/${id}`, { headers: { 'cache-control': 'no-cache' } });
  if (!r.ok) throw new Error('roblox_profile_failed');
  return (await r.json()).description || '';
}
async function getAvatar(id) {
  try { const j = await (await fetch(`${ROBLOX_THUMBS}/v1/users/avatar-headshot?userIds=${id}&size=150x150&format=Png&isCircular=false`)).json(); return j.data?.[0]?.imageUrl || ''; } catch { return ''; }
}

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of pending) if (v.expires < now) pending.delete(k);
  let ch = false; for (const k of Object.keys(db.sessions)) if (db.sessions[k].expires < now) { delete db.sessions[k]; ch = true; }
  if (ch) save();
}, 60000).unref();

const hits = new Map();
function limited(key, max, windowMs = 60000) {
  const now = Date.now(); const h = (hits.get(key) || []).filter(t => now - t < windowMs);
  h.push(now); hits.set(key, h); return h.length > max;
}

// ───────────────────────── http helpers ─────────────────────────
function send(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type, authorization, x-admin-key, x-bot-key', 'access-control-allow-methods': 'GET, POST, OPTIONS', 'cache-control': 'no-store' });
  res.end(JSON.stringify(obj));
}
const fail = (res, code, error) => send(res, code, { ok: false, error });
function body(req) {
  return new Promise(resolve => {
    let d = ''; req.on('data', c => { d += c; if (d.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(d || '{}')); } catch { resolve({}); } });
  });
}
function authUser(req) {
  const h = req.headers.authorization || ''; const s = h.startsWith('Bearer ') ? h.slice(7) : '';
  const rec = db.sessions[s]; if (!rec || rec.expires < Date.now()) return null;
  return getUser(rec.userId) || null;
}
const safeEq = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
const isAdmin = req => ADMIN_KEY && safeEq(String(req.headers['x-admin-key'] || ''), ADMIN_KEY);
const isBot = req => BOT_KEY && safeEq(String(req.headers['x-bot-key'] || ''), BOT_KEY);
function meView(u) { return { user: publicUser(u), inv: expand(u.inv), clientSeed: u.clientSeed, nonce: u.nonce, hist: u.hist.slice(0, 100), withdraws: db.withdraws.filter(w => w.userId === u.id && w.status === 'pending').map(w => ({ id: w.id, items: expand(w.items), t: w.t })) }; }
function catalog() {
  const counts = {}; for (const i of db.house) counts[i.pid] = (counts[i.pid] || 0) + 1;
  return db.pets.map(p => ({ ...p, stock: counts[p.id] || 0 }));
}
function flipView(f) { return { id: f.id, creator: f.creator, side: f.side, items: expand(f.items), value: f.value, status: f.status, t: f.t, opponent: f.opponent || null, oppItems: f.oppItems ? expand(f.oppItems) : [], result: f.result || null, winner: f.winner || null, fair: f.status === 'done' ? f.fair : { hash: f.hash } }; }
const slug = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 60);

// credit items to a user (deposits from bots or admin)
function creditUser(user, pid, qty, source) {
  const out = [];
  for (let k = 0; k < qty; k++) { const it = { uid: uid(), pid }; user.inv.push(it); out.push(it); }
  db.deposits.unshift({ id: uid(), userId: user.id, items: out.map(i => i.pid), source, t: Date.now() });
  if (db.deposits.length > 500) db.deposits.length = 500;
  return out;
}

// ───────────────────────── routes ─────────────────────────
const routes = {};
const R = (m, p, fn) => { routes[m + ' ' + p] = fn; };

R('GET', '/api/health', () => ({ ok: true }));
R('GET', '/api/catalog', () => ({ ok: true, pets: catalog() }));

// link
R('POST', '/api/link/start', async (req, b, ip) => {
  if (limited('ls' + ip, 10)) return [429, 'Too many attempts, wait a minute.'];
  const username = String(b.username || '');
  if (!/^[A-Za-z0-9_]{3,20}$/.test(username)) return [400, 'Enter a valid Roblox username.'];
  const u = await lookupUser(username);
  if (!u) return [404, 'No Roblox account with that username.'];
  const avatar = await getAvatar(u.userId);
  const t = token(), phrase = makePhrase(), expires = Date.now() + LINK_TTL_MS;
  pending.set(t, { ...u, avatar, phrase, expires });
  return { ok: true, token: t, phrase, expiresAt: expires, user: { id: u.userId, name: u.name, displayName: u.displayName, avatar } };
});
R('POST', '/api/link/check', async (req, b, ip) => {
  if (limited('lc' + ip, 30)) return [429, 'Slow down — try again in a minute.'];
  const p = pending.get(b.token);
  if (!p || p.expires < Date.now()) { pending.delete(b.token); return [400, 'Code expired. Start again to get a new phrase.']; }
  const desc = await getDescription(p.userId);
  if (!norm(desc).includes(norm(p.phrase))) {
    return { ok: false, error: /#{2,}/.test(desc) ? 'Roblox filtered part of your bio (####). Start again for a new phrase.' : 'Phrase not found in your bio yet. Save your bio on Roblox, wait a few seconds, then check again.' };
  }
  pending.delete(b.token);
  const user = ensureUser({ id: p.userId, name: p.name, displayName: p.displayName, avatar: p.avatar });
  const s = token(); db.sessions[s] = { userId: user.id, expires: Date.now() + SESSION_TTL_MS }; save();
  return { ok: true, session: s, user: publicUser(user) };
});
R('GET', '/api/me', (req) => { const u = authUser(req); if (!u) return [401, 'Not linked.']; return { ok: true, ...meView(u) }; });
R('POST', '/api/logout', (req) => { const s = (req.headers.authorization || '').slice(7); delete db.sessions[s]; save(); return { ok: true }; });
R('POST', '/api/seed', (req, b) => {
  const u = authUser(req); if (!u) return [401, 'Not linked.'];
  const seed = String(b.clientSeed || '').trim().slice(0, 64); if (!seed) return [400, 'Enter a client seed.'];
  u.clientSeed = seed; u.nonce = 0; save(); return { ok: true, clientSeed: seed, nonce: 0 };
});

// coinflip
R('GET', '/api/coinflip', () => ({ ok: true, open: db.flips.filter(f => f.status === 'open').map(flipView), recent: db.flips.filter(f => f.status === 'done').slice(0, 15).map(flipView) }));
R('POST', '/api/coinflip/create', (req, b) => {
  const u = authUser(req); if (!u) return [401, 'Link your Roblox account first.'];
  const side = b.side === 't' ? 't' : 'h';
  const items = takeItems(u, b.uids); if (!items) return [400, 'Pick items from your inventory.'];
  const server = crypto.randomBytes(32).toString('hex');
  const f = { id: uid(), creator: publicUser(u), side, items, value: sumv(items), status: 'open', t: Date.now(), server, hash: crypto.createHash('sha256').update(server).digest('hex') };
  db.flips.unshift(f); save(); return { ok: true, flip: flipView(f), ...meView(u) };
});
R('POST', '/api/coinflip/cancel', (req, b) => {
  const u = authUser(req); if (!u) return [401, 'Not linked.'];
  const f = db.flips.find(x => x.id === b.id && x.status === 'open');
  if (!f || f.creator.id !== u.id) return [404, 'Flip not found.'];
  u.inv.push(...f.items); db.flips = db.flips.filter(x => x !== f); save();
  return { ok: true, ...meView(u) };
});
function resolveFlip(f, oppUser, oppItems, oppPublic) {
  const creator = getUser(f.creator.id);
  const client = creator.clientSeed + (oppUser ? ':' + oppUser.clientSeed : ''); const nonce = creator.nonce++;
  const h = crypto.createHash('sha256').update(f.server + ':' + client + ':' + nonce).digest('hex');
  const r = parseInt(h.slice(0, 13), 16) / 2 ** 52;
  const landed = r < 0.5 ? 'h' : 't';
  const creatorWins = landed === f.side;
  const pot = [...f.items, ...oppItems]; const potV = sumv(pot);
  if (creatorWins) creator.inv.push(...pot);
  else if (oppUser) oppUser.inv.push(...pot);
  else db.house.push(...pot);                       // bot won → pets go to the house
  const fair = { server: f.server, hash: f.hash, client, nonce, r };
  Object.assign(f, { status: 'done', opponent: oppPublic, oppItems, result: landed, winner: creatorWins ? 'creator' : 'opponent', fair, doneAt: Date.now() });
  addHist(creator, 'Coinflip', f.value, creatorWins ? potV : 0, creatorWins, (f.side === 'h' ? 'Heads' : 'Tails') + ' vs ' + oppPublic.name, fair);
  if (oppUser) addHist(oppUser, 'Coinflip', sumv(oppItems), creatorWins ? 0 : potV, !creatorWins, (f.side === 'h' ? 'Tails' : 'Heads') + ' vs ' + f.creator.name, fair);
  // keep the list short
  const done = db.flips.filter(x => x.status === 'done'); if (done.length > 50) db.flips = db.flips.filter(x => x.status === 'open' || done.indexOf(x) < 50);
  save();
}
R('POST', '/api/coinflip/join', (req, b) => {
  const u = authUser(req); if (!u) return [401, 'Link your Roblox account first.'];
  const f = db.flips.find(x => x.id === b.id && x.status === 'open'); if (!f) return [404, 'That flip is gone.'];
  if (f.creator.id === u.id) return [400, "You can't join your own flip."];
  const items = takeItems(u, b.uids); if (!items) return [400, 'Pick items from your inventory.'];
  const v = sumv(items);
  if (v < f.value * (1 - MATCH_RANGE) || v > f.value * (1 + MATCH_RANGE)) { u.inv.push(...items); return [400, `Your items must be worth between ${Math.ceil(f.value * (1 - MATCH_RANGE))} and ${Math.floor(f.value * (1 + MATCH_RANGE))}.`]; }
  resolveFlip(f, u, items, publicUser(u));
  return { ok: true, flip: flipView(f), ...meView(u) };
});
R('POST', '/api/coinflip/callbot', (req, b) => {
  const u = authUser(req); if (!u) return [401, 'Not linked.'];
  const f = db.flips.find(x => x.id === b.id && x.status === 'open');
  if (!f || f.creator.id !== u.id) return [404, 'Flip not found.'];
  const botItems = houseMatch(f.value);
  if (!botItems) return [409, "The bot doesn't have pets to match this value right now. Wait for a player or try a different amount."];
  removeFromHouse(botItems);
  resolveFlip(f, null, botItems, { id: 0, name: 'PetFlip Bot', displayName: 'PetFlip Bot', avatar: '', bot: true });
  return { ok: true, flip: flipView(f), ...meView(u) };
});

// jackpot vs bot (weighted by value)
R('POST', '/api/jackpot/bot', (req, b) => {
  const u = authUser(req); if (!u) return [401, 'Link your Roblox account first.'];
  const items = takeItems(u, b.uids); if (!items) return [400, 'Pick items from your inventory.'];
  const myV = sumv(items);
  const botItems = houseMatch(myV);
  if (!botItems) { u.inv.push(...items); return [409, "The bot doesn't have pets to match this value right now."]; }
  removeFromHouse(botItems);
  const botV = sumv(botItems); const fair = roll(u);
  const won = fair.r < myV / (myV + botV);
  const pot = [...items, ...botItems];
  if (won) u.inv.push(...pot); else db.house.push(...pot);
  addHist(u, 'Jackpot', myV, won ? myV + botV : 0, won, (myV / (myV + botV) * 100).toFixed(2) + '% chance vs bot', fair);
  save();
  return { ok: true, won, fair, myValue: myV, botValue: botV, botItems: expand(botItems), ...meView(u) };
});

// upgrader
R('POST', '/api/upgrade', (req, b) => {
  const u = authUser(req); if (!u) return [401, 'Link your Roblox account first.'];
  const target = db.house.filter(i => i.pid === b.targetPid).sort((a, c) => a.uid - c.uid)[0];
  if (!target) return [409, 'That pet is out of stock.'];
  const items = takeItems(u, b.uids); if (!items) return [400, 'Pick items from your inventory.'];
  const iv = sumv(items), tv = valOf(target);
  const chance = Math.min(UPGRADE_MAX, iv / tv * (1 - UPGRADE_EDGE));
  if (tv <= iv * 1.05 || chance < 0.01) { u.inv.push(...items); return [400, 'Pick a target worth more than your items (min 1% chance).']; }
  const fair = roll(u); const won = fair.r < chance;
  db.house.push(...items);                            // inputs always go to the house
  if (won) { removeFromHouse([target]); u.inv.push(target); }
  addHist(u, 'Upgrader', iv, won ? tv : 0, won, (chance * 100).toFixed(2) + '% → ' + (petById(target.pid)?.name || ''), fair);
  save();
  return { ok: true, won, chance, fair, target: expand([target])[0], ...meView(u) };
});

// withdrawals
R('POST', '/api/withdraw', (req, b) => {
  const u = authUser(req); if (!u) return [401, 'Not linked.'];
  const items = takeItems(u, b.uids); if (!items) return [400, 'Pick items to withdraw.'];
  db.withdraws.unshift({ id: uid(), userId: u.id, username: u.name, items, status: 'pending', t: Date.now() }); save();
  return { ok: true, ...meView(u) };
});
R('POST', '/api/withdraw/cancel', (req, b) => {
  const u = authUser(req); if (!u) return [401, 'Not linked.'];
  const w = db.withdraws.find(x => x.id === b.id && x.userId === u.id && x.status === 'pending'); if (!w) return [404, 'Withdrawal not found.'];
  u.inv.push(...w.items); w.status = 'cancelled'; save(); return { ok: true, ...meView(u) };
});

// ── trade bots (x-bot-key) ──
// deposit: bot received a trade from a Roblox user → credit them
R('POST', '/api/bot/deposit', (req, b) => {
  if (!isBot(req) && !isAdmin(req)) return [403, 'Bad bot key.'];
  const user = getUser(Number(b.robloxUserId)); if (!user) return [404, 'That Roblox user has not linked an account on the site.'];
  const pids = Array.isArray(b.pets) ? b.pets : []; const bad = pids.filter(p => !petById(p));
  if (!pids.length || bad.length) return [400, 'Unknown pet ids: ' + bad.join(', ')];
  for (const p of pids) creditUser(user, p, 1, 'bot:' + (b.bot || '?'));
  save(); return { ok: true, credited: pids.length };
});
// list pending withdrawals for the bots to send
R('GET', '/api/bot/withdraws', (req) => {
  if (!isBot(req) && !isAdmin(req)) return [403, 'Bad bot key.'];
  return { ok: true, withdraws: db.withdraws.filter(w => w.status === 'pending').map(w => ({ id: w.id, robloxUserId: w.userId, username: w.username, pets: w.items.map(i => i.pid), t: w.t })) };
});
R('POST', '/api/bot/withdraw/complete', (req, b) => {
  if (!isBot(req) && !isAdmin(req)) return [403, 'Bad bot key.'];
  const w = db.withdraws.find(x => x.id === b.id && x.status === 'pending'); if (!w) return [404, 'Withdrawal not found.'];
  w.status = 'completed'; w.doneAt = Date.now(); save(); return { ok: true };
});

// ── admin (x-admin-key) ──
R('GET', '/api/admin/state', (req) => {
  if (!isAdmin(req)) return [403, 'Wrong admin key.'];
  const users = Object.values(db.users).map(u => ({ ...publicUser(u), items: u.inv.length, value: sumv(u.inv) })).sort((a, b) => b.value - a.value).slice(0, 100);
  return { ok: true, pets: catalog(), houseValue: sumv(db.house), houseItems: db.house.length, users, withdraws: db.withdraws.filter(w => w.status === 'pending').map(w => ({ id: w.id, username: w.username, userId: w.userId, items: expand(w.items), t: w.t })) };
});
R('POST', '/api/admin/pet', (req, b) => {
  if (!isAdmin(req)) return [403, 'Wrong admin key.'];
  const name = String(b.name || '').trim(); const tier = String(b.tier || ''); const value = Math.round(Number(b.value));
  if (!name) return [400, 'Name is required.'];
  if (!TIERS.includes(tier)) return [400, 'Tier must be huge, titan or garg.'];
  if (!(value > 0)) return [400, 'Value must be a positive number.'];
  const id = b.id || slug(name); const ex = petById(id);
  const rec = { id, name, tier, value, img: String(b.img || '').trim() };
  if (ex) Object.assign(ex, rec); else db.pets.push(rec);
  save(); return { ok: true, pets: catalog() };
});
R('POST', '/api/admin/pet/delete', (req, b) => {
  if (!isAdmin(req)) return [403, 'Wrong admin key.'];
  const used = db.house.some(i => i.pid === b.id) || Object.values(db.users).some(u => u.inv.some(i => i.pid === b.id));
  if (used) return [400, 'This pet is still in stock or in a player inventory — remove those first.'];
  db.pets = db.pets.filter(p => p.id !== b.id); save(); return { ok: true, pets: catalog() };
});
R('POST', '/api/admin/stock', (req, b) => {
  if (!isAdmin(req)) return [403, 'Wrong admin key.'];
  const p = petById(b.pid); if (!p) return [404, 'Unknown pet.'];
  const qty = Math.trunc(Number(b.qty));
  if (qty > 0) for (let k = 0; k < Math.min(qty, 500); k++) db.house.push({ uid: uid(), pid: p.id });
  else if (qty < 0) { let n = -qty; db.house = db.house.filter(i => !(i.pid === p.id && n-- > 0)); }
  save(); return { ok: true, pets: catalog() };
});
R('POST', '/api/admin/credit', async (req, b) => {
  if (!isAdmin(req)) return [403, 'Wrong admin key.'];
  let user = Object.values(db.users).find(u => u.name.toLowerCase() === String(b.username || '').toLowerCase());
  if (!user) return [404, 'That player has not linked their account yet.'];
  if (!petById(b.pid)) return [404, 'Unknown pet.'];
  const qty = Math.max(1, Math.min(100, Math.trunc(Number(b.qty) || 1)));
  creditUser(user, b.pid, qty, 'admin'); save(); return { ok: true };
});
R('POST', '/api/admin/withdraw/complete', (req, b) => {
  if (!isAdmin(req)) return [403, 'Wrong admin key.'];
  const w = db.withdraws.find(x => x.id === b.id && x.status === 'pending'); if (!w) return [404, 'Withdrawal not found.'];
  w.status = 'completed'; w.doneAt = Date.now(); save(); return { ok: true };
});

// ───────────────────────── server ─────────────────────────
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.json': 'application/json', '.webp': 'image/webp' };
const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return send(res, 204, {});
  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress;
  const url = new URL(req.url, 'http://x');
  const fn = routes[req.method + ' ' + url.pathname];
  if (fn) {
    try {
      const b = req.method === 'POST' ? await body(req) : {};
      if (req.method === 'POST' && limited('all' + ip, 120)) return fail(res, 429, 'Too many requests.');
      const out = await fn(req, b, ip);
      if (Array.isArray(out)) return fail(res, out[0], out[1]);
      return send(res, 200, out);
    } catch (e) { console.error(e); return fail(res, 502, 'Could not reach Roblox — try again.'); }
  }
  if (url.pathname.startsWith('/api/')) return fail(res, 404, 'Not found');
  if (req.method !== 'GET') return fail(res, 405, 'Method not allowed');
  const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
  const file = path.join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR)) return fail(res, 403, 'Forbidden');
  fs.readFile(file, (err, data) => {
    if (err) return fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (e2, d2) => { if (e2) { res.writeHead(404); return res.end('Not found'); } res.writeHead(200, { 'content-type': TYPES['.html'] }); res.end(d2); });
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' }); res.end(data);
  });
});
server.listen(PORT, () => console.log(`PetFlip server on :${PORT}${ADMIN_KEY ? '' : ' (ADMIN_KEY not set — admin disabled)'}`));
