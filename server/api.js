/*
  Case Sim — cloud server.

  Runs on the game's own site as a Cloudflare Pages Function
  (functions/api/[[path]].js), with a D1 database. Accounts log in with a username and
  password, and the server owns every account's coins and items: it rolls
  cases, runs the upgrader, settles trades and pays out battles. The game
  only shows what the server says, so editing a save can't create anything.

  The game's rules come from server/core.js, which scripts/sync-core.mjs
  builds from the CORE block in site/index.html. The server and the game
  therefore always agree on items, odds and battle rolls.

  Every change to coins or items runs as one D1 batch, which is a single
  transaction: it all happens or none of it does. Checks inside a batch use
  the one-row `guards` table (a failed check breaks its CHECK constraint and
  rolls the batch back), and accounts.coins can never go below zero.

  Routes (JSON in and out; send the session token as "Authorization: Bearer <token>")
    GET  /api/challenge              sign-up check        -> { challenge, bits }
    POST /api/signup                 { name, password, challenge, nonce } -> { token, me, inventory }
    POST /api/login                  { name, password }   -> { token, me, inventory }
    POST /api/logout           auth
    GET  /api/me               auth                       -> { me, inventory }
    POST /api/ping             auth  counts time played   -> { me, pending }
    POST /api/open             auth  { case_id, count }
    POST /api/sell             auth  { ids }
    POST /api/shop             auth  { case_id, what: 'crate' | 'key', count }
    POST /api/upgrade          auth  { ids, mult }
    POST /api/gift             auth  { code }
    GET  /api/leaderboard            ?sort=value|best|opened|played&limit=1..200
    GET  /api/players                ?q=name
    GET  /api/players/:id            public profile and inventory
    POST /api/offers           auth  { to, give, give_coins, want, want_coins, message }   (item ids)
    GET  /api/offers           auth
    POST /api/offers/:id/:action auth accept | decline | cancel
    POST /api/battles          auth  { case_id, rounds, max_players, mode, version, bots }
    GET  /api/battles                open lobbies
    GET  /api/battles/:id
    POST /api/battles/:id/:action auth join | leave | start
    GET  /api/config                 announcement and maintenance flag
    GET  /api/market                 ?q=&rarity=&idx=&sort=new|cheap|dear|deal&offset= open listings
    GET  /api/market/mine      auth  your listings, open and past
    POST /api/market           auth  { item, price }      list an item
    POST /api/market/:id/buy|cancel  auth
    GET  /api/suggestions            ?sort=top|new         (with a login, says which you voted for)
    POST /api/lock             auth  { ids, lock }        lock or unlock items -> { locks }
    GET  /api/rewards          auth  the reward track and your progress
    POST /api/rewards/claim    auth  today's reward
    GET  /api/invites          auth  battles you've been invited to
    POST /api/battles/:id/invite|decline  auth  { to }  invite someone (you must be in it) / turn an invite down
    POST /api/suggestions      auth  { text }
    POST /api/suggestions/:id/vote|delete  auth
    POST /api/account/password auth  { old, password }
    POST /api/account/logout-all auth ends every session for the account
    POST /api/admin                  signed with the admin key; see the moderation section
*/

import {
  CASES, ALL_ITEMS, ITEM_INDEX, GAME_VERSION, VAULT_KEY, VAULT_CRATE, WEARS, NO_WEAR, NO_TRACKER,
  rollItem, rollWear, instantiate, bonusChance, itemTuple, tupleToItem,
  pickTarget, upgradeChance, computeBattle, seededRng, hashString, nameProblem, isRude, textProblem, RARITIES,
  FREE_COOLDOWN, SEASONS, seasonsOn, onSale, caseBonus
} from './core.js';

const NAME_RE = /^[A-Za-z0-9_-]{3,16}$/;
const PASS_MIN = 6, PASS_MAX = 72;
const PBKDF2_ROUNDS = 20000;            // fits Cloudflare's free-plan CPU budget
const SESSION_TTL = 60 * 86400;         // s of inactivity before a login expires
const LOGIN_FAILS = 5, LOGIN_LOCK = 60; // 5 wrong passwords -> wait a minute
const SIGNUPS_PER_HOUR = 20, SIGNUPS_PER_DAY = 60;   // per IP; schools share one IP, so keep them roomy
const SIGNUPS_ALL_PER_HOUR = 300;       // across everyone, so a botnet can't flood the game
const POW_BITS = 18;                    // sign-up proof of work: about a second of a browser's time
const POW_MIN_AGE = 2, POW_MAX_AGE = 15 * 60;   // s from getting a sign-up challenge to using it
const MAX_ITEMS = 3000;
const MAX_OFFER_ITEMS = 20, MAX_PENDING = 20;
const MAX_LISTINGS = 20;                // open market listings per account
const MAX_PRICE = 1e9;
const SUGGESTION_MIN = 10, SUGGESTION_MAX = 300;
const LOBBY_TTL = 15 * 60, START_DELAY = 4000;
const SORT = { value: 'inv_value', best: 'best_value', opened: 'opened', played: 'played' };
const MAX_BODY = 64 * 1024;

const ECDSA = { name: 'ECDSA', namedCurve: 'P-256' };
const SIGN = { name: 'ECDSA', hash: 'SHA-256' };
const utf8 = new TextEncoder();
const nowS = () => Math.floor(Date.now() / 1000);
const rand = () => crypto.getRandomValues(new Uint32Array(1))[0] / 4294967296;

// Accounts that are always admins: ADMIN_ACCOUNTS in wrangler.toml (account
// ids, so a renamed or re-registered name can never inherit it). The admin
// key can also make other accounts admins (the admin_accounts table).
let permanentAdmins = new Set();
const isPermanentAdmin = (id) => permanentAdmins.has(id);
async function isAdminAccount(db, id) {
  return isPermanentAdmin(id) || !!(await db.prepare('SELECT 1 FROM admin_accounts WHERE account = ?').bind(id).first());
}

/* ---------- helpers ---------- */

function b64u(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function unb64u(str) {
  if (!/^[A-Za-z0-9_-]*$/.test(str)) throw new Error('bad base64');
  let t = str.replace(/-/g, '+').replace(/_/g, '/');
  while (t.length % 4) t += '=';
  const bin = atob(t);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const randomId = (bytes) => b64u(crypto.getRandomValues(new Uint8Array(bytes || 9)));
const sha = async (text) => b64u(new Uint8Array(await crypto.subtle.digest('SHA-256', utf8.encode(text))));

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Device, X-Device-FP',
  'Access-Control-Max-Age': '86400'
};

function json(data, status, headers) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: Object.assign({ 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, CORS, headers || {})
  });
}

class HttpError extends Error {
  constructor(status, message, extra) { super(message); this.status = status; this.extra = extra; }
}
const fail = (status, message, extra) => { throw new HttpError(status, message, extra); };

async function body(request) {
  const text = await request.text();
  if (text.length > MAX_BODY) fail(413, 'Request too large');
  try { return text ? JSON.parse(text) : {}; } catch (e) { return fail(400, 'Bad request'); }
}

const isInt = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;

function idList(v, max) {
  if (!Array.isArray(v) || v.length > max || !v.every((n) => isInt(n, 1, 1e15))) fail(400, 'Bad item list');
  return Array.from(new Set(v));
}

// A statement that rolls its batch back unless the SQL condition holds.
const check = (db, cond, ...args) =>
  db.prepare(`INSERT OR REPLACE INTO guards (k, ok) VALUES (1, CASE WHEN (${cond}) THEN 1 ELSE 0 END)`).bind(...args);

async function transact(db, stmts) {
  try {
    return await db.batch(stmts.filter(Boolean));
  } catch (e) {
    if (/constraint/i.test(String(e && e.message))) fail(409, 'Something changed. Try again.');
    throw e;
  }
}

/* ---------- items ---------- */

// Game item -> [idx, wear, float, tracker, value]; value always from the rules.
function itemRow(it) {
  const t = itemTuple(it);
  const again = t && tupleToItem(t);
  if (!again) throw new Error('unknown item ' + (it && it.name));
  return t.concat([again.value]);
}

const rowOut = (r) => [r.id, r.idx, r.wear, r.float, r.tracker];

// One INSERT for many items; returns the new rows.
const insertItems = (db, owner, rows, t) => db.prepare(
  `INSERT INTO items (owner, idx, wear, float, tracker, value, created_at)
   SELECT ?, json_extract(value, '$[0]'), json_extract(value, '$[1]'), json_extract(value, '$[2]'),
          json_extract(value, '$[3]'), json_extract(value, '$[4]'), ?
     FROM json_each(?) ORDER BY key
   RETURNING id, idx, wear, float, tracker`
).bind(owner, t, JSON.stringify(rows));

const bestUpdate = (db, owner, rows) => {
  const top = rows.reduce((a, r) => (!a || r[4] > a[4] ? r : a), null);
  return top && db.prepare('UPDATE accounts SET best_value = ?, best_item = ? WHERE id = ? AND best_value < ?')
    .bind(top[4], top[0], owner, top[4]);
};

const sorted = (res) => ((res && res.results) || []).slice().sort((a, b) => a.id - b.id).map(rowOut);

/* ---------- accounts ---------- */

async function hashPassword(password, salt, rounds) {
  const key = await crypto.subtle.importKey('raw', utf8.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: unb64u(salt), iterations: rounds }, key, 256);
  return 'pbkdf2$' + rounds + '$' + salt + '$' + b64u(new Uint8Array(bits));
}

async function passwordMatches(password, stored) {
  const [kind, rounds, salt] = String(stored).split('$');
  if (kind !== 'pbkdf2') return false;
  const again = await hashPassword(password, salt, +rounds);
  if (again.length !== stored.length) return false;
  let diff = 0;
  for (let i = 0; i < again.length; i++) diff |= again.charCodeAt(i) ^ stored.charCodeAt(i);
  return diff === 0;
}

const banReason = async (db, id) => {
  const r = await db.prepare('SELECT reason FROM ban_reasons WHERE account = ?').bind(id).first();
  return r ? r.reason : '';
};

const meOut = (a) => ({
  id: a.id, name: a.name, coins: a.coins, opened: a.opened, best_value: a.best_value, best_item: a.best_item,
  played: a.played, inv_value: a.inv_value, inv_count: a.inv_count, rev: a.rev, created_at: a.created_at
});

// The account as its owner sees it, including whether it has admin tools.
const meFull = async (db, a) => Object.assign(meOut(a), { admin: await isAdminAccount(db, a.id) });

async function inventory(db, id) {
  const { results } = await db.prepare(
    'SELECT id, idx, wear, float, tracker FROM items WHERE owner = ? AND locked IS NULL ORDER BY id').bind(id).all();
  return results.map(rowOut);
}

const account = (db, id) => db.prepare('SELECT * FROM accounts WHERE id = ?').bind(id).first();

/* ---------- rate limits ---------- */

// Two layers:
// 1. Every request passes a quick check kept in memory, per network and,
//    once logged in, per account. It costs nothing, but each Cloudflare
//    server counts on its own, so it's there to stop floods.
// 2. Actions worth abusing (sign-ups, logins, trades, battles, gifts and
//    password changes) are also counted in the database, so those limits
//    hold across every server.
// Networks get far more room than accounts, because a whole school can
// share one IP address.
const QUICK_LIMITS = {                    // requests a minute, and how many can come at once
  auth:    { rate: 120,  burst: 80 },     // sign-up, login and sign-up checks, per network
  read:    { rate: 1500, burst: 400 },
  write:   { rate: 1500, burst: 400 },
  admin:   { rate: 600,  burst: 200 },
  account: { rate: 240,  burst: 80 }      // anything logged in, per account
};
let buckets = new Map();
function quickLimit(key, rule) {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b) {
    if (buckets.size > 20000) buckets = new Map();      // under attack from many addresses: start over
    b = { left: rule.burst, at: now };
    buckets.set(key, b);
  }
  b.left = Math.min(rule.burst, b.left + (now - b.at) * rule.rate / 60000);
  b.at = now;
  if (b.left < 1) fail(429, 'Slow down a little and try again.', { retry: Math.ceil((1 - b.left) * 60 / rule.rate) });
  b.left -= 1;
}

const LIMITS = {                          // [how many, in how many seconds]
  signup_try: [60, 600],                  // sign-up attempts per network
  login_fail: [50, 600],                  // wrong passwords per network
  password:   [10, 3600],                 // password changes per account, right or wrong
  offer:      [40, 600],                  // trade offers made per account
  battle:     [40, 600],                  // battles made per account
  gift:       [30, 600],                  // gift codes tried per account
  listing:    [60, 600],                  // market listings made per account
  invite:     [60, 600],                  // battle invites sent per account
  suggest:    [5, 3600],                  // suggestions posted per account
  rude_name:  [3, 86400]                  // rude names sent per device or browser (the game never sends one)
};
const ipOf = (request) => request.headers.get('CF-Connecting-IP') || 'local';
const hitRow = (db, name, who) => db.prepare('INSERT INTO hits (k, at) VALUES (?, ?)').bind(name + ':' + who, nowS());

// Seconds until `who` may do `name` again, or 0 if they can now.
async function waitFor(db, name, who) {
  const [max, per] = LIMITS[name], t = nowS();
  const r = await db.prepare('SELECT COUNT(*) AS n, MIN(at) AS first FROM hits WHERE k = ? AND at > ?')
    .bind(name + ':' + who, t - per).first();
  return r.n >= max ? Math.max(1, r.first + per - t) : 0;
}

// Counts one more `name` for `who`, or refuses it when they're over the limit.
async function limit(db, name, who, message) {
  const wait = await waitFor(db, name, who);
  if (wait) fail(429, message || 'Too many tries. Wait a few minutes and try again.', { retry: wait });
  await hitRow(db, name, who).run();
  if (Math.random() < 0.02) await db.prepare('DELETE FROM hits WHERE at < ?').bind(nowS() - 86400).run();
}

/* ---------- sign-up checks (against bots) ---------- */

// Before signing up, the game fetches a challenge and finds a nonce that
// makes SHA-256(challenge + ':' + nonce) start with POW_BITS zero bits. A
// browser does this in about a second while the player types; a bot has to
// spend that on every account. Challenges are signed by the server (so it
// doesn't store them), expire, and work for one account only. Signing up
// also fails if the form's hidden "website" field is filled in, which only
// bots do, or if it comes back quicker than a person could type.
let serverKey = null;
async function serverSig(db, text) {
  if (!serverKey) {
    let row = await db.prepare("SELECT v FROM server_keys WHERE k = 'pow'").first();
    if (!row) {
      await db.prepare("INSERT OR IGNORE INTO server_keys (k, v) VALUES ('pow', ?)").bind(randomId(32)).run();
      row = await db.prepare("SELECT v FROM server_keys WHERE k = 'pow'").first();
    }
    serverKey = await crypto.subtle.importKey('raw', utf8.encode(row.v), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  }
  return b64u(new Uint8Array(await crypto.subtle.sign('HMAC', serverKey, utf8.encode(text)))).slice(0, 22);
}

async function challenge(env) {
  const text = nowS() + '.' + randomId(9);
  return json({ challenge: text + '.' + await serverSig(env.DB, text), bits: POW_BITS });
}

function leadingZeroBits(bytes, bits) {
  for (let i = 0; i < bits; i++) if (bytes[i >> 3] & (0x80 >> (i & 7))) return false;
  return true;
}

// Checks the sign-up form came from a person. Returns the challenge id to mark as used.
async function checkHuman(db, b) {
  const again = 'Sign-up check failed. Reload the page and try again.';
  if (b.website) fail(400, again);                                   // the hidden field
  const m = /^(\d{10})\.([A-Za-z0-9_-]{12})\.([A-Za-z0-9_-]{22})$/.exec(String(b.challenge || ''));
  const nonce = String(b.nonce || '');
  if (!m || !/^[0-9a-z]{1,12}$/.test(nonce)) fail(400, again);
  if (await serverSig(db, m[1] + '.' + m[2]) !== m[3]) fail(400, again);
  const age = nowS() - Number(m[1]);
  if (age < POW_MIN_AGE) fail(400, 'That was quick! Wait a second and try again.');
  if (age > POW_MAX_AGE) fail(400, 'The sign-up check expired. Try again.', { expired: true });
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', utf8.encode(m[0] + ':' + nonce)));
  if (!leadingZeroBits(digest, POW_BITS)) fail(400, again);
  if (await db.prepare('SELECT 1 FROM used_challenges WHERE id = ?').bind(m[2]).first()) {
    fail(400, 'That sign-up check was already used. Try again.', { expired: true });
  }
  return m[2];
}

/* ---------- devices ----------
   The game sends a random id it keeps on the device (X-Device) and a hash of
   the browser's traits (X-Device-FP). With the network the request came
   from, they're recorded for each account as keyed hashes (never raw
   addresses), so the admin panel can see which accounts were made on the
   same device and ban or block them together.
   Device ids are the strong signal. Browser fingerprints and networks are
   weak ones: a class of identical school laptops shares both. */

const DEVICE_KINDS = { d: 'Device', f: 'Browser', n: 'Network' };
const DEVICE_FLAG = { d: 3, f: 6, n: 10 };      // accounts on one before it's flagged
const DEVICE_SIGNUPS_PER_DAY = 5;
const BROWSER_SIGNUPS_PER_DAY = 10;       // roomier: a class of identical school laptops shares one

function deviceLabel(ua) {
  ua = String(ua || '');
  const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\/|Opera/.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox'
    : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : ua ? 'Unknown browser' : 'No browser (a script?)';
  const os = /CrOS/.test(ua) ? 'ChromeOS' : /iPhone|iPad|iPod/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android'
    : /Windows/.test(ua) ? 'Windows' : /Mac OS X|Macintosh/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : '';
  return browser + (os ? ' on ' + os : '');
}

// The device, browser and network a request came from, as [kind, key] pairs.
async function deviceKeys(request, db) {
  const dev = request.headers.get('X-Device') || '', fp = request.headers.get('X-Device-FP') || '';
  const keys = [];
  if (/^[A-Za-z0-9_-]{16,64}$/.test(dev)) keys.push(['d', await serverSig(db, 'device:' + dev)]);
  if (/^[A-Za-z0-9_-]{8,64}$/.test(fp)) keys.push(['f', await serverSig(db, 'browser:' + fp)]);
  keys.push(['n', await serverSig(db, 'network:' + ipOf(request))]);
  return keys;
}

// Remembers what an account was used on. Only writes when something is new
// or an hour has passed, so the heartbeat can call it freely.
const recordDevices = (db, account, keys, request) => keys.map(([kind, value]) => db.prepare(
  `INSERT INTO account_devices (account, kind, value, label, first_at, last_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (account, kind, value) DO UPDATE SET last_at = excluded.last_at, label = excluded.label
     WHERE account_devices.last_at < excluded.last_at - 3600`)
  .bind(account, kind, value, kind === 'n' ? '' : deviceLabel(request.headers.get('User-Agent')), nowS(), nowS()));

// Refuses a request from a blocked device, browser or network.
async function checkBlocked(db, keys) {
  const row = await db.prepare(`SELECT reason FROM device_bans WHERE (kind || ':' || value) IN (SELECT value FROM json_each(?)) LIMIT 1`)
    .bind(JSON.stringify(keys.map((k) => k.join(':')))).first();
  if (row) fail(403, 'This device is blocked from making or using accounts.' + (row.reason ? ' Reason: ' + row.reason : ''));
}

async function newSession(db, id) {
  const token = randomId(32);
  const t = nowS();
  return { token, stmt: db.prepare('INSERT INTO sessions (token_hash, account, created_at, last_used) VALUES (?, ?, ?, ?)')
    .bind(await sha('session:' + token), id, t, t) };
}

function readCredentials(b) {
  const name = String(b.name || '').trim();
  const password = String(b.password || '');
  if (!NAME_RE.test(name)) fail(400, 'Usernames are 3-16 letters, numbers, _ or -');
  if (password.length < PASS_MIN || password.length > PASS_MAX) fail(400, 'Passwords are ' + PASS_MIN + '-' + PASS_MAX + ' characters');
  return { name, password };
}

async function signup(request, env) {
  const db = env.DB;
  const b = await body(request);
  const { name, password } = readCredentials(b);
  const ip = ipOf(request);
  await limit(db, 'signup_try', ip, 'Too many sign-up attempts from this network. Try again in a few minutes.');
  const keys = await deviceKeys(request, db);
  const device = keys.find((k) => k[0] === 'd'), browser = keys.find((k) => k[0] === 'f');
  if (!device || !browser) fail(400, 'Reload the page and try again.');          // the game always sends both
  // The game checks names before sending them, so a rude one here comes from a
  // bot or an edited game: three in a day and that device and browser can't
  // make accounts until the day is up.
  const who = [device.join(':'), browser.join(':')];
  for (const w of who) {
    const wait = await waitFor(db, 'rude_name', w);
    if (wait) fail(429, 'This device can\'t make new accounts right now. Try again tomorrow.', { retry: wait });
  }
  const problem = nameProblem(name);
  if (problem) {
    if (isRude(name)) await db.batch(who.map((w) => hitRow(db, 'rude_name', w)));
    fail(400, problem);
  }
  const challengeId = await checkHuman(db, b);
  const t = nowS();
  await checkBlocked(db, keys);
  const onDevice = await db.prepare(
    `SELECT COALESCE(SUM(a.banned), 0) AS banned, COALESCE(SUM(d.first_at > ?), 0) AS today
       FROM account_devices d JOIN accounts a ON a.id = d.account WHERE d.kind = 'd' AND d.value = ?`).bind(t - 86400, device[1]).first();
  if (onDevice.banned) fail(403, 'An account on this device is banned, so it can\'t make new ones.');
  if (onDevice.today >= DEVICE_SIGNUPS_PER_DAY) fail(429, 'This device has made a lot of accounts today. Try again tomorrow.');
  const onBrowser = await db.prepare(`SELECT COUNT(*) AS n FROM account_devices WHERE kind = 'f' AND value = ? AND first_at > ?`)
    .bind(browser[1], t - 86400).first();
  if (onBrowser.n >= BROWSER_SIGNUPS_PER_DAY) fail(429, 'This browser has made a lot of accounts today. Try again tomorrow.');
  const [hour, day, everyone, taken] = (await db.batch([
    db.prepare('SELECT COUNT(*) AS n FROM signups WHERE ip = ? AND at > ?').bind(ip, t - 3600),
    db.prepare('SELECT COUNT(*) AS n FROM signups WHERE ip = ? AND at > ?').bind(ip, t - 86400),
    db.prepare('SELECT COUNT(*) AS n FROM signups WHERE at > ?').bind(t - 3600),
    db.prepare('SELECT COUNT(*) AS n FROM accounts WHERE name_lower = ?').bind(name.toLowerCase())
  ])).map((r) => r.results[0].n);
  if (hour >= SIGNUPS_PER_HOUR || day >= SIGNUPS_PER_DAY) fail(429, 'Too many new accounts from this network. Try again later.');
  if (everyone >= SIGNUPS_ALL_PER_HOUR) fail(429, 'Lots of people are signing up right now. Try again in a few minutes.');
  if (taken) fail(409, 'That username is taken');

  const id = randomId(9);
  const pass = await hashPassword(password, randomId(16), PBKDF2_ROUNDS);
  const session = await newSession(db, id);
  await transact(db, [
    db.prepare('INSERT INTO accounts (id, name, name_lower, pass, created_at, last_seen, last_ping) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(id, name, name.toLowerCase(), pass, t, t, t),
    session.stmt,
    db.prepare('INSERT INTO signups (ip, at) VALUES (?, ?)').bind(ip, t),
    db.prepare('DELETE FROM signups WHERE at < ?').bind(t - 86400),
    db.prepare('INSERT INTO used_challenges (id, at) VALUES (?, ?)').bind(challengeId, t),
    db.prepare('DELETE FROM used_challenges WHERE at < ?').bind(t - POW_MAX_AGE - 60),
    ...recordDevices(db, id, keys, request)
  ]).catch((e) => { if (e.status === 409) fail(409, 'That username is taken'); throw e; });
  return json(Object.assign({ token: session.token, me: meOut(await account(db, id)), inventory: [], locks: [] }, await perks(db, { id: id })));
}

async function login(request, env) {
  const db = env.DB;
  const { name, password } = readCredentials(await body(request));
  const ip = ipOf(request);
  const wait = await waitFor(db, 'login_fail', ip);
  if (wait) fail(429, 'Too many wrong passwords from this network. Try again in a few minutes.', { retry: wait });
  const a = await db.prepare('SELECT * FROM accounts WHERE name_lower = ?').bind(name.toLowerCase()).first();
  if (!a) {
    await hitRow(db, 'login_fail', ip).run();
    fail(401, 'Wrong username or password');
  }
  const t = nowS();
  if (a.fail_count >= LOGIN_FAILS && t - a.fail_at < LOGIN_LOCK) fail(429, 'Too many wrong passwords. Wait a minute and try again.');
  if (!(await passwordMatches(password, a.pass))) {
    await db.batch([
      db.prepare('UPDATE accounts SET fail_count = CASE WHEN ? - fail_at > ? THEN 1 ELSE fail_count + 1 END, fail_at = ? WHERE id = ?')
        .bind(t, LOGIN_LOCK * 10, t, a.id),
      hitRow(db, 'login_fail', ip)
    ]);
    fail(401, 'Wrong username or password');
  }
  if (a.banned) fail(403, 'banned', { reason: await banReason(db, a.id) });
  const keys = await deviceKeys(request, db);
  await checkBlocked(db, keys);
  const session = await newSession(db, a.id);
  await db.batch([session.stmt,
    db.prepare('UPDATE accounts SET fail_count = 0, last_seen = ?, last_ping = ? WHERE id = ?').bind(t, t, a.id),
    ...recordDevices(db, a.id, keys, request)]);
  return json(Object.assign({ token: session.token, me: await meFull(db, await account(db, a.id)), inventory: await inventory(db, a.id),
    locks: await lockList(db, a.id) }, await perks(db, a)));
}

async function authed(request, env) {
  const m = /^Bearer ([A-Za-z0-9_-]{40,64})$/.exec(request.headers.get('Authorization') || '');
  if (!m) return null;
  const hash = await sha('session:' + m[1]);
  const row = await env.DB.prepare(
    `SELECT a.*, s.last_used AS s_used, s.token_hash AS s_hash FROM sessions s JOIN accounts a ON a.id = s.account
      WHERE s.token_hash = ?`).bind(hash).first();
  if (!row) return null;
  const t = nowS();
  if (t - row.s_used > SESSION_TTL) {
    await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(hash).run();
    return null;
  }
  if (row.banned) fail(403, 'banned', { reason: await banReason(env.DB, row.id) });
  if (t - row.s_used > 600 || t - row.last_seen > 60) {
    await env.DB.batch([
      env.DB.prepare('UPDATE sessions SET last_used = ? WHERE token_hash = ?').bind(t, hash),
      env.DB.prepare('UPDATE accounts SET last_seen = ? WHERE id = ?').bind(t, row.id)
    ]);
  }
  return row;
}

// What the game shows next to your account: rewards ready to claim, and the login gift.
const perks = async (db, me) => ({ reward_ready: (await rewardState(db, me)).ready, login_gift: await pendingLoginGift(db, me) });

async function ping(request, env, me) {
  const t = nowS();
  await env.DB.batch(recordDevices(env.DB, me.id, await deviceKeys(request, env.DB), request));
  // Adds the time since the last ping, as long as the game has been pinging steadily.
  await env.DB.prepare(
    `UPDATE accounts SET played = played + CASE WHEN ? - last_ping BETWEEN 1 AND 120 THEN ? - last_ping ELSE 0 END,
            last_ping = ?, last_seen = ? WHERE id = ?`).bind(t, t, t, t, me.id).run();
  const pending = await env.DB.prepare(`SELECT COUNT(*) AS n FROM offers WHERE to_id = ? AND status = 'pending'`).bind(me.id).first();
  return json(Object.assign({ me: await meFull(env.DB, await account(env.DB, me.id)), pending: pending.n, sold: await newSales(env.DB, me),
    invites: await myInvites(env.DB, me) }, await perks(env.DB, me)));
}

/* ---------- item locks ----------
   Players lock items they want to keep; locked items can't be sold,
   upgraded, traded, listed or used up opening a case until unlocked. */

const UNLOCKED = 'id NOT IN (SELECT item FROM item_locks)';
const anyLocked = async (db, ids) =>
  !!(await db.prepare('SELECT 1 FROM item_locks WHERE item IN (SELECT value FROM json_each(?)) LIMIT 1').bind(ids).first());
const noneLocked = (db, ids) => check(db, 'NOT EXISTS (SELECT 1 FROM item_locks WHERE item IN (SELECT value FROM json_each(?)))', ids);
const lockList = async (db, id) => (await db.prepare('SELECT item FROM item_locks WHERE account = ?').bind(id).all()).results.map((r) => r.item);

async function lockItems(request, env, me) {
  const db = env.DB;
  const b = await body(request);
  const ids = JSON.stringify(idList(b.ids, 500));
  if (b.lock) {
    await db.prepare(`INSERT OR IGNORE INTO item_locks (item, account, at)
                      SELECT id, owner, ? FROM items WHERE owner = ? AND id IN (SELECT value FROM json_each(?))`).bind(nowS(), me.id, ids).run();
  } else {
    await db.prepare('DELETE FROM item_locks WHERE account = ? AND item IN (SELECT value FROM json_each(?))').bind(me.id, ids).run();
  }
  return json({ locks: await lockList(db, me.id) });
}

/* ---------- rewards ----------
   A reward track the admin sets up, weekly or monthly: each day a player
   logs in they can claim the next reward on it, once a day. Progress starts
   over when the week (from Monday, UTC) or the month begins. */

const DEFAULT_REWARDS = {
  on: true, title: 'Weekly rewards', period: 'week',
  days: [100, 150, 200, 250, 300, 400].map((c) => ({ coins: c, items: [] }))
    .concat([{ coins: 500, items: [[ITEM_INDEX['Vault Key'], -1, 0], [ITEM_INDEX['Vault Case'], -1, 0]] }])
};
function rewardConfig(s) {
  try { const r = JSON.parse(s.rewards || 'null'); if (r && Array.isArray(r.days) && r.days.length) return r; } catch (e) { /* default */ }
  return DEFAULT_REWARDS;
}

// The current week or month: a key for it and when it ends (s).
function rewardPeriod(period, t) {
  if (period === 'month') {
    const d = new Date(t * 1000), y = d.getUTCFullYear(), m = d.getUTCMonth();
    return { key: 'M' + y + '-' + (m + 1), ends: Date.UTC(y, m + 1, 1) / 1000 };
  }
  const day = Math.floor(t / 86400), monday = day - (new Date(day * 86400000).getUTCDay() + 6) % 7;
  return { key: 'W' + monday, ends: (monday + 7) * 86400 };
}

async function rewardState(db, me) {
  const cfg = rewardConfig(await settings(db)), t = nowS(), per = rewardPeriod(cfg.period, t);
  const rows = (await db.prepare('SELECT slot, at FROM reward_claims WHERE account = ? AND period = ?').bind(me.id, per.key).all()).results;
  const today = Math.floor(t / 86400);
  const claimedToday = rows.some((r) => Math.floor(r.at / 86400) === today);
  return {
    cfg: cfg, per: per, t: t, claimed: rows.length, claimedToday: claimedToday, nextAt: (today + 1) * 86400,
    ready: cfg.on !== false && !claimedToday && rows.length < cfg.days.length
  };
}

const rewardsOut = (st) => ({
  on: st.cfg.on !== false, title: st.cfg.title, period: st.cfg.period, days: st.cfg.days, claimed: st.claimed,
  ready: st.ready, claimed_today: st.claimedToday, next_at: st.nextAt, ends: st.per.ends, now: st.t
});

async function claimReward(env, me) {
  const db = env.DB;
  const st = await rewardState(db, me);
  if (st.cfg.on === false) fail(409, 'Rewards are switched off right now');
  if (st.claimed >= st.cfg.days.length) fail(409, 'You\'ve claimed every reward this ' + (st.cfg.period === 'month' ? 'month' : 'week'));
  if (st.claimedToday) fail(409, 'Come back tomorrow for your next reward');
  const day = st.cfg.days[st.claimed];
  const rows = [];
  (day.items || []).forEach((it) => rows.push(...makeItems(it[0], it[1], it[2], 1)));
  if (me.inv_count + rows.length > MAX_ITEMS) fail(409, 'Your inventory is full. Sell something first.');
  const today = Math.floor(st.t / 86400) * 86400;
  const stmts = [
    db.prepare('INSERT INTO reward_claims (account, period, slot, at) VALUES (?, ?, ?, ?)').bind(me.id, st.per.key, st.claimed, st.t),
    check(db, '(SELECT COUNT(*) FROM reward_claims WHERE account = ? AND period = ? AND at >= ?) = 1', me.id, st.per.key, today),
    db.prepare('UPDATE accounts SET coins = coins + ? WHERE id = ?').bind(day.coins || 0, me.id)
  ];
  const itemsAt = rows.length ? stmts.push(insertItems(db, me.id, rows, st.t)) - 1 : -1;
  const res = await transact(db, stmts);
  return json({
    me: meOut(await account(db, me.id)), coins: day.coins || 0, items: itemsAt >= 0 ? sorted(res[itemsAt]) : [],
    rewards: rewardsOut(await rewardState(db, me))
  });
}

// The admin's login gift, if this account hasn't claimed it yet: offered on login.
async function pendingLoginGift(db, me) {
  const id = (await settings(db)).login_gift;
  if (!id) return null;
  const g = await db.prepare(
    `SELECT g.* FROM server_gifts g WHERE g.id = ? AND (g.expires = 0 OR g.expires > ?)
        AND NOT EXISTS (SELECT 1 FROM revoked_gifts r WHERE r.gift_id = g.id)
        AND NOT EXISTS (SELECT 1 FROM gift_claims c WHERE c.gift_id = g.id AND c.account = ?)`).bind(id, nowS(), me.id).first();
  return g ? { code: 'GIFT2.' + g.id, coins: g.coins, items: JSON.parse(g.items).map((r) => r.slice(0, 4)), message: g.message, expires: g.expires } : null;
}

/* ---------- cases, selling, upgrades ---------- */

async function openCase(request, env, me) {
  const db = env.DB;
  const b = await body(request);
  const box = CASES.find((c) => c.id === b.case_id);
  if (!box) fail(400, 'Unknown case. Update your game.');
  if (!box.locked && !onSale(box, await activeSeasons(env))) fail(409, box.name + ' is only sold around ' + SEASONS[box.season].name);
  const free = box.price === 0 && !box.locked;
  let count = isInt(b.count, 1, 5) ? b.count : 1;
  if (me.inv_count + count * 3 > MAX_ITEMS) fail(409, 'Your inventory is full. Sell something first.');
  const t = Date.now(), ts = nowS();
  const stmts = [];
  let removed = [];

  if (box.locked) {
    // Opened with a crate item (and a key, if the case needs one) instead of coins.
    const crateIdx = ITEM_INDEX[box.crate], keyIdx = box.key ? ITEM_INDEX[box.key] : -1;
    const held = await db.prepare(
      `SELECT SUM(idx = ? AND ${UNLOCKED}) AS c, SUM(idx = ? AND ${UNLOCKED}) AS k, SUM(idx = ?) AS all_c
         FROM items WHERE owner = ? AND locked IS NULL`).bind(crateIdx, keyIdx, crateIdx, me.id).first();
    count = Math.min(count, held.c || 0, box.key ? held.k || 0 : count);
    if (!count) {
      fail(409, (held.c || 0) ? 'You need a ' + box.key : (held.all_c || 0) ? 'Your ' + box.crate + ' is locked. Unlock it to open it.' : 'You need a ' + box.crate);
    }
    const pick = async (idx) => (await db.prepare(`SELECT id FROM items WHERE owner = ? AND locked IS NULL AND ${UNLOCKED} AND idx = ? LIMIT ?`)
      .bind(me.id, idx, count).all()).results.map((r) => r.id);
    removed = (await pick(crateIdx)).concat(box.key ? await pick(keyIdx) : []);
    stmts.push(
      check(db, '(SELECT COUNT(*) FROM items WHERE owner = ? AND locked IS NULL AND id IN (SELECT value FROM json_each(?))) = ?',
        me.id, JSON.stringify(removed), removed.length),
      db.prepare('DELETE FROM items WHERE owner = ? AND id IN (SELECT value FROM json_each(?))').bind(me.id, JSON.stringify(removed)));
  } else if (free) {
    if (FREE_COOLDOWN && me.last_free > t - FREE_COOLDOWN) {
      const wait = Math.ceil((me.last_free + FREE_COOLDOWN - t) / 1000);
      fail(429, 'The free case is ready in ' + wait + 's', { retry: wait });
    }
    stmts.push(check(db, '(SELECT last_free FROM accounts WHERE id = ?) <= ?', me.id, t - FREE_COOLDOWN));
  } else if (me.coins < box.price * count) {
    fail(409, 'Not enough coins');
  }

  const cost = box.locked ? 0 : box.price * count;
  const pulls = [], bonus = [];
  for (let i = 0; i < count; i++) pulls.push(itemRow(rollItem(box, rand)));
  const chance = bonusChance(box), extra = caseBonus(box);
  for (let i = 0; i < count; i++) {
    if (rand() < chance) bonus.push(itemRow(instantiate(VAULT_KEY, rand)));
    if (rand() < chance) bonus.push(itemRow(instantiate(VAULT_CRATE, rand)));
    if (extra && rand() < box.bonusChance) bonus.push(itemRow(instantiate(extra, rand)));
  }

  stmts.push(db.prepare(
    `UPDATE accounts SET coins = coins - ?, opened = opened + ?, last_free = CASE WHEN ? THEN ? ELSE last_free END,
            last_seen = ? WHERE id = ?`).bind(cost, count, free ? 1 : 0, t, ts, me.id));
  const pullAt = stmts.push(insertItems(db, me.id, pulls, ts)) - 1;
  const bonusAt = bonus.length ? stmts.push(insertItems(db, me.id, bonus, ts)) - 1 : -1;
  stmts.push(bestUpdate(db, me.id, pulls));

  const res = await transact(db, stmts);
  return json({
    me: meOut(await account(db, me.id)),
    items: sorted(res[pullAt]), bonus: bonusAt >= 0 ? sorted(res[bonusAt]) : [], removed: removed
  });
}

// The Shop: crates and keys go into the inventory like any item, so they can
// be traded, listed or opened later. Holiday crates and keys only sell in their season.
async function buyShop(request, env, me) {
  const db = env.DB;
  const b = await body(request);
  const box = CASES.find((c) => c.id === b.case_id && c.shop);
  if (!box || (b.what !== 'crate' && b.what !== 'key')) fail(400, 'Unknown shop item. Update your game.');
  if (box.season && (await activeSeasons(env)).indexOf(box.season) < 0) {
    fail(409, (b.what === 'crate' ? box.crate + ' crates' : box.key + 's') + ' are only sold around ' + SEASONS[box.season].name);
  }
  const count = isInt(b.count, 1, 10) ? b.count : 1;
  if (me.inv_count + count > MAX_ITEMS) fail(409, 'Your inventory is full. Sell something first.');
  const base = ALL_ITEMS[ITEM_INDEX[b.what === 'crate' ? box.crate : box.key]];
  const cost = box.shop[b.what] * count;
  if (me.coins < cost) fail(409, 'Not enough coins');
  const rows = [];
  for (let i = 0; i < count; i++) rows.push(itemRow(instantiate(base, rand)));
  const ts = nowS();
  const stmts = [db.prepare('UPDATE accounts SET coins = coins - ?, last_seen = ? WHERE id = ?').bind(cost, ts, me.id)];
  const at = stmts.push(insertItems(db, me.id, rows, ts)) - 1;
  const res = await transact(db, stmts);
  return json({ me: meOut(await account(db, me.id)), items: sorted(res[at]) });
}

async function sell(request, env, me) {
  const db = env.DB;
  const ids = JSON.stringify(idList((await body(request)).ids, MAX_ITEMS));
  const res = await transact(db, [
    db.prepare(`UPDATE accounts SET coins = coins + COALESCE((SELECT SUM(value) FROM items WHERE owner = ? AND locked IS NULL
                  AND ${UNLOCKED} AND id IN (SELECT value FROM json_each(?))), 0) WHERE id = ?`).bind(me.id, ids, me.id),
    db.prepare(`DELETE FROM items WHERE owner = ? AND locked IS NULL AND ${UNLOCKED} AND id IN (SELECT value FROM json_each(?)) RETURNING id`)
      .bind(me.id, ids)
  ]);
  return json({ me: meOut(await account(db, me.id)), removed: res[1].results.map((r) => r.id) });
}

async function upgrade(request, env, me) {
  const db = env.DB;
  const b = await body(request);
  const list = idList(b.ids, 30);
  if (!list.length) fail(400, 'Pick items to stake');
  const mult = Number(b.mult);
  if (!(mult >= 1.1 && mult <= 100)) fail(400, 'Bad multiplier');
  const ids = JSON.stringify(list);
  if (await anyLocked(db, ids)) fail(409, 'Some of those items are locked. Unlock them to stake them.');
  const stake = await db.prepare(
    'SELECT COUNT(*) AS n, SUM(value) AS v FROM items WHERE owner = ? AND locked IS NULL AND id IN (SELECT value FROM json_each(?))')
    .bind(me.id, ids).first();
  if (stake.n !== list.length) fail(409, 'Some of those items are gone');
  const target = pickTarget(stake.v, mult);
  if (!target) fail(409, 'Nothing to upgrade into');
  const chance = upgradeChance(stake.v, target);
  const won = rand() < chance;
  const stmts = [
    check(db, '(SELECT COUNT(*) FROM items WHERE owner = ? AND locked IS NULL AND id IN (SELECT value FROM json_each(?))) = ?',
      me.id, ids, list.length),
    noneLocked(db, ids),
    db.prepare('DELETE FROM items WHERE owner = ? AND id IN (SELECT value FROM json_each(?))').bind(me.id, ids)
  ];
  if (won) {
    const row = itemRow(instantiate(target, rand));
    stmts.push(insertItems(db, me.id, [row], nowS()), bestUpdate(db, me.id, [row]));
  }
  const res = await transact(db, stmts);
  return json({
    me: meOut(await account(db, me.id)), won: won, chance: chance, target: ITEM_INDEX[target.name],
    item: won ? sorted(res[3])[0] : null, removed: list
  });
}

/* ---------- gifts ---------- */

let adminKey = null;
async function signedByAdmin(env, text, sig) {
  try {
    if (!adminKey) {
      adminKey = await crypto.subtle.importKey('jwk',
        { kty: 'EC', crv: 'P-256', x: env.ADMIN_X, y: env.ADMIN_Y, ext: true }, ECDSA, false, ['verify']);
    }
    return await crypto.subtle.verify(SIGN, adminKey, unb64u(sig), utf8.encode(text));
  } catch (e) { return false; }
}

// Gift codes made on the server (by admins without the key): GIFT2.<id>,
// with the contents stored in server_gifts.
async function serverGift(db, me, code, peek) {
  const id = code.slice(6);
  const g = /^[A-Za-z0-9_-]{12,40}$/.test(id) && await db.prepare('SELECT * FROM server_gifts WHERE id = ?').bind(id).first();
  if (!g) fail(400, 'Invalid gift code');
  if (g.expires && nowS() > g.expires) fail(410, 'This gift has expired');
  if (await db.prepare('SELECT 1 FROM revoked_gifts WHERE gift_id = ?').bind(id).first()) fail(410, 'This gift was cancelled');
  const rows = JSON.parse(g.items);
  if (peek) {
    const claimed = !!(await db.prepare('SELECT 1 FROM gift_claims WHERE gift_id = ? AND account = ?').bind(id, me.id).first());
    return json({ coins: g.coins, items: rows.map((r) => r.slice(0, 4)), message: g.message, expires: g.expires, claimed: claimed });
  }
  if (me.inv_count + rows.length > MAX_ITEMS) fail(409, 'Your inventory is full. Sell something first.');
  const ts = nowS();
  const stmts = [
    db.prepare('INSERT INTO gift_claims (gift_id, account, at) VALUES (?, ?, ?)').bind(id, me.id, ts),
    check(db, 'NOT EXISTS (SELECT 1 FROM revoked_gifts WHERE gift_id = ?)', id),
    db.prepare('UPDATE accounts SET coins = coins + ? WHERE id = ?').bind(g.coins, me.id)
  ];
  const itemsAt = rows.length ? stmts.push(insertItems(db, me.id, rows, ts)) - 1 : -1;
  let res;
  try { res = await db.batch(stmts); }
  catch (e) {
    if (/UNIQUE|constraint/i.test(String(e && e.message))) fail(409, 'You already claimed this gift');
    throw e;
  }
  return json({ me: meOut(await account(db, me.id)), coins: g.coins, items: itemsAt >= 0 ? sorted(res[itemsAt]) : [], message: g.message });
}

async function gift(request, env, me) {
  const db = env.DB;
  const req = await body(request);
  const code = String(req.code || '').trim().replace(/\s+/g, '');
  await limit(db, 'gift', me.id, 'Too many gift codes tried. Wait a few minutes.');
  if (code.indexOf('GIFT2.') === 0) return serverGift(db, me, code, !!req.peek);
  const parts = code.split('.');
  if (parts.length !== 3 || parts[0] !== 'GIFT') fail(400, 'That isn\'t a gift code');
  if (!(await signedByAdmin(env, parts[1], parts[2]))) fail(400, 'Invalid gift code');
  let p = null;
  try { p = JSON.parse(new TextDecoder().decode(unb64u(parts[1]))); } catch (e) { p = null; }
  if (!p || p.t !== 'gift' || typeof p.id !== 'string' || !isInt(p.c, 0, 1e12) || !Array.isArray(p.i) || p.i.length > 50) {
    fail(400, 'Invalid gift code');
  }
  if (p.x && nowS() > p.x) fail(410, 'This gift has expired');
  if (await db.prepare('SELECT 1 FROM revoked_gifts WHERE gift_id = ?').bind(p.id).first()) fail(410, 'This gift was cancelled');
  const items = p.i.map(tupleToItem);
  if (items.some((it) => !it)) fail(400, Number(p.mv) > GAME_VERSION ? 'This gift is for a newer version' : 'Invalid gift code');
  const rows = items.map(itemRow);
  if (me.inv_count + rows.length > MAX_ITEMS) fail(409, 'Your inventory is full. Sell something first.');
  const ts = nowS();
  const stmts = [
    db.prepare('INSERT INTO gift_claims (gift_id, account, at) VALUES (?, ?, ?)').bind(p.id, me.id, ts),
    check(db, 'NOT EXISTS (SELECT 1 FROM revoked_gifts WHERE gift_id = ?)', p.id),
    db.prepare('UPDATE accounts SET coins = coins + ? WHERE id = ?').bind(p.c, me.id)
  ];
  const itemsAt = rows.length ? stmts.push(insertItems(db, me.id, rows, ts)) - 1 : -1;
  let res;
  try { res = await db.batch(stmts); }
  catch (e) {
    if (/UNIQUE|constraint/i.test(String(e && e.message))) fail(409, 'You already claimed this gift');
    throw e;
  }
  return json({ me: meOut(await account(db, me.id)), coins: p.c, items: itemsAt >= 0 ? sorted(res[itemsAt]) : [],
                message: String(p.m || '').slice(0, 120) });
}

/* ---------- leaderboard and players ---------- */

async function leaderboard(url, env) {
  const column = SORT[url.searchParams.get('sort')] || 'inv_value';       // whitelisted
  const limit = Math.min(200, Math.max(1, parseInt(url.searchParams.get('limit'), 10) || 100));
  const { results } = await env.DB.prepare(
    `SELECT id, name, played, opened, best_value, best_item, inv_value, last_seen FROM accounts
      WHERE banned = 0 AND (opened > 0 OR inv_count > 0) ORDER BY ${column} DESC, last_seen DESC LIMIT ?`).bind(limit).all();
  return json({ players: results, now: nowS() });
}

async function searchPlayers(url, env) {
  const q = String(url.searchParams.get('q') || '').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 16);
  const stmt = q
    ? env.DB.prepare(`SELECT id, name, last_seen, inv_value FROM accounts WHERE banned = 0 AND name_lower LIKE ?
                       ORDER BY last_seen DESC LIMIT 20`).bind(q + '%')
    : env.DB.prepare('SELECT id, name, last_seen, inv_value FROM accounts WHERE banned = 0 ORDER BY last_seen DESC LIMIT 20');
  return json({ players: (await stmt.all()).results, now: nowS() });
}

async function playerProfile(id, env) {
  const p = await env.DB.prepare('SELECT id, name, last_seen, inv_value FROM accounts WHERE id = ? AND banned = 0').bind(id).first();
  if (!p) fail(404, 'No such player');
  const { results } = await env.DB.prepare(
    'SELECT id, idx, wear, float, tracker FROM items WHERE owner = ? AND locked IS NULL ORDER BY value DESC LIMIT 500').bind(id).all();
  return json(Object.assign(p, { inventory: results.map(rowOut), now: nowS() }));
}

/* ---------- trades ----------
   Offered items are locked to the offer and the offered coins are taken
   when it's made. Accepting swaps everything in one transaction; declining
   or cancelling unlocks the items and refunds the coins. */

const ownedCheck = '(SELECT COUNT(*) FROM items WHERE owner = ? AND locked IS NULL AND id IN (SELECT value FROM json_each(?))) = ?';

async function createOffer(request, env, me) {
  const db = env.DB;
  const b = await body(request);
  await limit(db, 'offer', me.id, 'You\'ve sent a lot of offers. Wait a few minutes.');
  const give = idList(b.give || [], MAX_OFFER_ITEMS), want = idList(b.want || [], MAX_OFFER_ITEMS);
  const giveCoins = b.give_coins || 0, wantCoins = b.want_coins || 0;
  if (!isInt(giveCoins, 0, 1e12) || !isInt(wantCoins, 0, 1e12)) fail(400, 'Bad coin amount');
  if (!give.length && !want.length && !giveCoins && !wantCoins) fail(400, 'The offer is empty');
  if (typeof b.to !== 'string' || b.to === me.id) fail(400, 'Pick someone else to trade with');
  const to = await db.prepare('SELECT id FROM accounts WHERE id = ? AND banned = 0').bind(b.to).first();
  if (!to) fail(404, 'No such player');
  if (giveCoins > me.coins) fail(409, 'Not enough coins');
  const pending = await db.prepare(`SELECT COUNT(*) AS n FROM offers WHERE from_id = ? AND status = 'pending'`).bind(me.id).first();
  if (pending.n >= MAX_PENDING) fail(429, 'You have too many open offers');

  const rowsOf = async (owner, ids) => (await db.prepare(
    'SELECT id, idx, wear, float, tracker FROM items WHERE owner = ? AND locked IS NULL AND id IN (SELECT value FROM json_each(?))')
    .bind(owner, JSON.stringify(ids)).all()).results.map(rowOut);
  if (await anyLocked(db, JSON.stringify(give))) fail(409, 'Some of your items are locked. Unlock them to trade them.');
  if (await anyLocked(db, JSON.stringify(want))) fail(409, 'They\'ve locked some of those items');
  const giveRows = await rowsOf(me.id, give), wantRows = await rowsOf(to.id, want);
  if (giveRows.length !== give.length) fail(409, 'Some of your items are gone');
  if (wantRows.length !== want.length) fail(409, 'They no longer have some of those items');

  const id = randomId(9), t = nowS();
  await transact(db, [
    check(db, ownedCheck, me.id, JSON.stringify(give), give.length),
    check(db, ownedCheck, to.id, JSON.stringify(want), want.length),
    noneLocked(db, JSON.stringify(give.concat(want))),
    db.prepare('UPDATE accounts SET coins = coins - ? WHERE id = ?').bind(giveCoins, me.id),
    db.prepare('UPDATE items SET locked = ? WHERE owner = ? AND locked IS NULL AND id IN (SELECT value FROM json_each(?))')
      .bind('o:' + id, me.id, JSON.stringify(give)),
    db.prepare(`INSERT INTO offers (id, from_id, to_id, give, give_coins, want, want_coins, message, status, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`)
      .bind(id, me.id, to.id, JSON.stringify(giveRows), giveCoins, JSON.stringify(wantRows), wantCoins,
            String(b.message || '').slice(0, 120), t, t)
  ]);
  return json({ me: meOut(await account(db, me.id)), inventory: await inventory(db, me.id), id: id });
}

async function listOffers(env, me) {
  const { results } = await env.DB.prepare(
    `SELECT o.*, f.name AS from_name, r.name AS to_name FROM offers o
       JOIN accounts f ON f.id = o.from_id JOIN accounts r ON r.id = o.to_id
      WHERE o.from_id = ? OR o.to_id = ?
      ORDER BY (o.status = 'pending') DESC, o.updated_at DESC LIMIT 50`).bind(me.id, me.id).all();
  return json({
    now: nowS(),
    offers: results.map((o) => ({
      id: o.id, from: o.from_id, from_name: o.from_name, to: o.to_id, to_name: o.to_name,
      give: JSON.parse(o.give), give_coins: o.give_coins, want: JSON.parse(o.want), want_coins: o.want_coins,
      message: o.message, status: o.status, created_at: o.created_at, updated_at: o.updated_at
    }))
  });
}

async function offerAction(id, action, env, me) {
  const db = env.DB;
  const o = await db.prepare('SELECT * FROM offers WHERE id = ?').bind(id).first();
  if (!o || (o.from_id !== me.id && o.to_id !== me.id)) fail(404, 'No such offer');
  if (o.status !== 'pending') fail(409, 'That offer was already ' + o.status);
  const tag = 'o:' + id, t = nowS();
  const give = JSON.parse(o.give), want = JSON.parse(o.want);
  const wantIds = JSON.stringify(want.map((r) => r[0]));
  const isPending = check(db, `(SELECT status FROM offers WHERE id = ?) = 'pending'`, id);

  if (action === 'accept') {
    if (o.to_id !== me.id) fail(403, 'Only the other player can accept');
    if (me.coins < o.want_coins) fail(409, 'Not enough coins');
    const have = await db.prepare(
      'SELECT COUNT(*) AS n FROM items WHERE owner = ? AND locked IS NULL AND id IN (SELECT value FROM json_each(?))')
      .bind(me.id, wantIds).first();
    if (have.n !== want.length) fail(409, 'You no longer have everything they asked for');
    if (await anyLocked(db, wantIds)) fail(409, 'You\'ve locked some of the items they asked for. Unlock them to accept.');
    await transact(db, [
      isPending,
      noneLocked(db, wantIds),
      check(db, '(SELECT COUNT(*) FROM items WHERE locked = ? AND owner = ?) = ?', tag, o.from_id, give.length),
      check(db, ownedCheck, me.id, wantIds, want.length),
      db.prepare('UPDATE accounts SET coins = coins - ? WHERE id = ?').bind(o.want_coins, me.id),
      db.prepare('UPDATE items SET owner = ? WHERE owner = ? AND locked IS NULL AND id IN (SELECT value FROM json_each(?))')
        .bind(o.from_id, me.id, wantIds),
      db.prepare('UPDATE items SET owner = ?, locked = NULL WHERE locked = ?').bind(me.id, tag),
      db.prepare('UPDATE accounts SET coins = coins + ? WHERE id = ?').bind(o.give_coins, me.id),
      db.prepare('UPDATE accounts SET coins = coins + ? WHERE id = ?').bind(o.want_coins, o.from_id),
      db.prepare(`UPDATE offers SET status = 'accepted', updated_at = ? WHERE id = ?`).bind(t, id)
    ]);
  } else if (action === 'decline' || action === 'cancel') {
    if (action === 'decline' && o.to_id !== me.id) fail(403, 'Only the other player can decline');
    if (action === 'cancel' && o.from_id !== me.id) fail(403, 'Only the sender can cancel');
    await transact(db, [
      isPending,
      db.prepare('UPDATE items SET locked = NULL WHERE locked = ?').bind(tag),
      db.prepare('UPDATE accounts SET coins = coins + ? WHERE id = ?').bind(o.give_coins, o.from_id),
      db.prepare('UPDATE offers SET status = ?, updated_at = ? WHERE id = ?').bind(action === 'decline' ? 'declined' : 'cancelled', t, id)
    ]);
  } else {
    fail(404, 'Unknown action');
  }
  return json({ me: meOut(await account(db, me.id)), inventory: await inventory(db, me.id) });
}

/* ---------- battles ----------
   Entry is paid on joining. When the last seat fills (or the creator starts
   early and bots take the empty seats) the server picks a seed, rolls the
   whole battle with the game's own rules and pays the winner, all in one
   transaction. Every game then replays the same rolls from the seed. */

const battleOut = (l) => ({
  id: l.id, creator: l.creator, case_id: l.case_id, rounds: l.rounds, max_players: l.max_players, mode: l.mode,
  version: l.version, cost: l.cost, players: JSON.parse(l.players), status: l.status,
  seed: l.status === 'running' ? l.seed : null, start_at: l.start_at, created_at: l.created_at, now_ms: Date.now()
});

// Statements that roll the battle and pay out; the caller marks it running.
function startBattle(db, l, players, ts) {
  const box = CASES.find((c) => c.id === l.case_id);
  const seed = randomId(16);
  const plan = computeBattle(box, l.rounds, players.length, l.mode, seededRng(hashString(seed + '|' + l.id)));
  const stmts = players.filter((p) => !p.bot)
    .map((p) => db.prepare('UPDATE accounts SET opened = opened + ? WHERE id = ?').bind(l.rounds, p.id));
  const winner = players[plan.winner];
  if (!winner.bot) {
    const pool = plan.pulls.reduce((acc, list) => acc.concat(list), []).map(itemRow);
    stmts.push(insertItems(db, winner.id, pool, ts), bestUpdate(db, winner.id, pool));
  }
  return { seed, winner: plan.winner, startAt: Date.now() + START_DELAY, stmts };
}

const refunds = (db, l, players) => players.filter((p) => !p.bot)
  .map((p) => db.prepare('UPDATE accounts SET coins = coins + ? WHERE id = ?').bind(l.cost, p.id));

const lobbyIs = (db, l) => check(db,
  `(SELECT rev FROM lobbies WHERE id = ?) = ? AND (SELECT status FROM lobbies WHERE id = ?) = 'open'`, l.id, l.rev, l.id);

async function expireLobbies(env) {
  const db = env.DB;
  const old = await db.prepare(`SELECT * FROM lobbies WHERE status = 'open' AND created_at < ?`).bind(nowS() - LOBBY_TTL).all();
  for (const l of old.results) {
    await db.batch([
      lobbyIs(db, l),
      db.prepare(`UPDATE lobbies SET status = 'cancelled', rev = rev + 1, updated_at = ? WHERE id = ?`).bind(nowS(), l.id)
    ].concat(refunds(db, l, JSON.parse(l.players)))).catch(() => {});
  }
}

async function createBattle(request, env, me) {
  const db = env.DB;
  const b = await body(request);
  if (b.version !== GAME_VERSION) fail(409, 'Update your game to play battles');
  await limit(db, 'battle', me.id, 'You\'ve made a lot of battles. Wait a few minutes.');
  const box = CASES.find((c) => c.id === b.case_id && !c.locked);
  if (!box) fail(400, 'Unknown case');
  if (!onSale(box, await activeSeasons(env))) fail(409, box.name + ' is only around at ' + SEASONS[box.season].name);
  if (!isInt(b.rounds, 1, 10) || !isInt(b.max_players, 2, 4)) fail(400, 'Bad settings');
  if (b.mode !== 'high' && b.mode !== 'low') fail(400, 'Bad mode');
  const cost = box.price * b.rounds;
  if (me.coins < cost) fail(409, 'Not enough coins');
  if (me.inv_count + b.rounds * b.max_players > MAX_ITEMS) fail(409, 'Your inventory is full. Sell something first.');
  if (!b.bots && await db.prepare(`SELECT 1 FROM lobbies WHERE creator = ? AND status = 'open'`).bind(me.id).first()) {
    fail(409, 'You already have an open battle');
  }
  const targets = !b.bots && b.invite ? await inviteTargets(db, me, b.invite, []) : [];
  if (!b.bots && b.private && !targets.length) fail(400, 'Invite someone to an invite-only battle');

  const id = randomId(9), ts = nowS();
  const l = { id, case_id: box.id, rounds: b.rounds, mode: b.mode, cost };
  const players = [{ id: me.id, name: me.name }];
  let start = null;
  if (b.bots) {                                      // against bots, straight away
    for (let n = 1; players.length < b.max_players; n++) players.push({ id: 'bot:' + n, name: 'Bot ' + n, bot: true });
    start = startBattle(db, l, players, ts);
  }
  await transact(db, [
    b.bots ? null : check(db, `NOT EXISTS (SELECT 1 FROM lobbies WHERE creator = ? AND status = 'open')`, me.id),
    db.prepare('UPDATE accounts SET coins = coins - ? WHERE id = ?').bind(cost, me.id),
    db.prepare(`INSERT INTO lobbies (id, creator, case_id, rounds, max_players, mode, version, cost, players, status,
                                     seed, start_at, winner, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(id, me.id, box.id, b.rounds, b.max_players, b.mode, GAME_VERSION, cost, JSON.stringify(players),
            start ? 'running' : 'open', start && start.seed, start && start.startAt, start && start.winner, ts, ts),
    !b.bots && b.private ? db.prepare('INSERT INTO private_lobbies (lobby) VALUES (?)').bind(id) : null
  ].concat(start ? start.stmts : [], inviteRows(db, id, me, targets)));
  if (Math.random() < 0.05) {
    await db.prepare(`DELETE FROM lobby_invites WHERE lobby IN (SELECT id FROM lobbies WHERE status <> 'open')`).run();
  }
  return json(Object.assign(battleOut(await db.prepare('SELECT * FROM lobbies WHERE id = ?').bind(id).first()),
    { me: meOut(await account(db, me.id)), private: !b.bots && !!b.private, invited: targets.map((a) => a.name) }));
}

// Open lobbies you've been invited to (and aren't in yet).
async function myInvites(db, me) {
  const { results } = await db.prepare(
    `SELECT l.*, a.name AS from_name FROM lobby_invites i JOIN lobbies l ON l.id = i.lobby JOIN accounts a ON a.id = i.from_id
      WHERE i.account = ? AND l.status = 'open' ORDER BY i.at DESC LIMIT 10`).bind(me.id).all();
  return results.filter((l) => !JSON.parse(l.players).some((p) => p.id === me.id))
    .map((l) => Object.assign(battleOut(l), { from_name: l.from_name }));
}

// The players (ids or names, up to 3) someone wants to invite to a battle.
async function inviteTargets(db, me, who, seated) {
  const out = [];
  for (const w of (Array.isArray(who) ? who : [who]).slice(0, 3)) {
    const a = await db.prepare('SELECT id, name FROM accounts WHERE (id = ? OR name_lower = ?) AND banned = 0')
      .bind(String(w || ''), String(w || '').toLowerCase()).first();
    if (!a) fail(404, 'No player called ' + String(w || '').slice(0, 20));
    if (a.id === me.id) fail(400, 'You can\'t invite yourself');
    if ((seated || []).some((p) => p.id === a.id) || out.some((x) => x.id === a.id)) continue;
    await limit(db, 'invite', me.id, 'You\'ve sent a lot of invites. Wait a few minutes.');
    out.push(a);
  }
  return out;
}
const inviteRows = (db, lobby, me, targets) => targets.map((a) =>
  db.prepare('INSERT OR REPLACE INTO lobby_invites (lobby, account, from_id, at) VALUES (?, ?, ?, ?)').bind(lobby, a.id, me.id, nowS()));
const isPrivate = async (db, id) => !!(await db.prepare('SELECT 1 FROM private_lobbies WHERE lobby = ?').bind(id).first());

async function listBattles(env) {
  await expireLobbies(env);
  const { results } = await env.DB.prepare(
    `SELECT * FROM lobbies WHERE status = 'open' AND id NOT IN (SELECT lobby FROM private_lobbies) ORDER BY created_at DESC LIMIT 30`).all();
  return json({ battles: results.map(battleOut), now_ms: Date.now() });
}

async function getBattle(id, env) {
  await expireLobbies(env);
  const l = await env.DB.prepare('SELECT * FROM lobbies WHERE id = ?').bind(id).first();
  if (!l) fail(404, 'No such battle');
  return json(Object.assign(battleOut(l), { private: await isPrivate(env.DB, id) }));
}

async function battleAction(id, action, request, env, me) {
  const db = env.DB;
  const b = await body(request);
  if (action === 'invite' || action === 'decline') {
    const l = await db.prepare('SELECT * FROM lobbies WHERE id = ?').bind(id).first();
    if (!l || l.status !== 'open') fail(409, 'That battle isn\'t open any more');
    if (action === 'decline') {
      await db.prepare('DELETE FROM lobby_invites WHERE lobby = ? AND account = ?').bind(id, me.id).run();
      return json({ ok: true });
    }
    const players = JSON.parse(l.players);
    if (!players.some((p) => p.id === me.id)) fail(403, 'Join the battle to invite people');
    const sent = await db.prepare('SELECT COUNT(*) AS n FROM lobby_invites WHERE lobby = ?').bind(id).first();
    if (sent.n >= 10) fail(429, 'That battle has plenty of invites already');
    const targets = await inviteTargets(db, me, b.to, players);
    if (targets.length) await db.batch(inviteRows(db, id, me, targets));
    return json({ invited: targets.map((a) => a.name) });
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    const l = await db.prepare('SELECT * FROM lobbies WHERE id = ?').bind(id).first();
    if (!l) fail(404, 'No such battle');
    if (l.status !== 'open') fail(409, 'That battle already ' + (l.status === 'running' ? 'started' : 'ended'));
    const players = JSON.parse(l.players);
    const seated = players.some((p) => p.id === me.id);
    const ts = nowS();
    const stmts = [lobbyIs(db, l)];
    let status = 'open', start = null;

    if (action === 'join') {
      if (seated) return json(Object.assign(battleOut(l), { me: meOut(me) }));
      if (b.version !== l.version || l.version !== GAME_VERSION) fail(409, 'Update your game to join this battle');
      if (players.length >= l.max_players) fail(409, 'That battle is full');
      if (me.coins < l.cost) fail(409, 'Not enough coins');
      if (await isPrivate(db, id) && !(await db.prepare('SELECT 1 FROM lobby_invites WHERE lobby = ? AND account = ?').bind(id, me.id).first())) {
        fail(403, 'That battle is invite-only');
      }
      players.push({ id: me.id, name: me.name });
      stmts.push(db.prepare('UPDATE accounts SET coins = coins - ? WHERE id = ?').bind(l.cost, me.id));
    } else if (action === 'leave') {
      if (!seated) fail(409, 'You aren\'t in that battle');
      if (l.creator === me.id) {
        status = 'cancelled';
        stmts.push(...refunds(db, l, players));
      } else {
        players.splice(players.findIndex((p) => p.id === me.id), 1);
        stmts.push(db.prepare('UPDATE accounts SET coins = coins + ? WHERE id = ?').bind(l.cost, me.id));
      }
    } else if (action === 'start') {
      if (l.creator !== me.id) fail(403, 'Only the creator can start');
      for (let n = 1; players.length < l.max_players; n++) players.push({ id: 'bot:' + n, name: 'Bot ' + n, bot: true });
    } else {
      fail(404, 'Unknown action');
    }

    if (status === 'open' && players.length >= l.max_players) {
      status = 'running';
      start = startBattle(db, l, players, ts);
    }
    stmts.push(db.prepare(
      'UPDATE lobbies SET players = ?, status = ?, seed = ?, start_at = ?, winner = ?, rev = rev + 1, updated_at = ? WHERE id = ?')
      .bind(JSON.stringify(players), status, start && start.seed, start && start.startAt, start && start.winner, ts, id));
    if (start) stmts.push(...start.stmts);

    try {
      await transact(db, stmts);
    } catch (e) {
      if (e.status === 409 && attempt < 2) continue;   // the lobby changed under us; look again
      throw e;
    }
    return json(Object.assign(battleOut(await db.prepare('SELECT * FROM lobbies WHERE id = ?').bind(id).first()),
      { me: meOut(await account(db, me.id)) }));
  }
  return fail(409, 'Busy, try again');
}

/* ---------- settings: announcement and maintenance ---------- */

let settingsCache = { at: 0, v: {} };
async function settings(db) {
  if (Date.now() - settingsCache.at > 10000) {
    const { results } = await db.prepare('SELECT k, v FROM settings').all();
    const v = {};
    results.forEach((r) => { v[r.k] = r.v; });
    settingsCache = { at: Date.now(), v: v };
  }
  return settingsCache.v;
}

/* ---------- market ----------
   Players list items for a price in coins. A listed item is set aside
   (locked 'm:<listing id>') so it can't be sold, upgraded or traded, and
   comes back if the listing is cancelled. Buying moves the coins and the
   item in one transaction. Listings by banned players are hidden and can't
   be bought. */

const listingOut = (l) => ({
  id: l.id, seller: l.seller, seller_name: l.seller_name, item: [l.item, l.idx, l.wear, l.float, l.tracker],
  value: l.value, price: l.price, status: l.status, buyer_name: l.buyer_name || null,
  created_at: l.created_at, updated_at: l.updated_at
});

async function browseMarket(url, env) {
  const q = (url.searchParams.get('q') || '').trim().toLowerCase().slice(0, 40);
  const rarity = url.searchParams.get('rarity') || '';
  const idx = url.searchParams.get('idx');
  const sort = { new: 'l.created_at DESC', cheap: 'l.price ASC', dear: 'l.price DESC', deal: 'CAST(l.price AS REAL) / MAX(l.value, 1) ASC' }[url.searchParams.get('sort')] || 'l.created_at DESC';
  const offset = Math.max(0, Math.min(5000, Math.floor(Number(url.searchParams.get('offset')) || 0)));
  let where = `l.status = 'open' AND a.banned = 0`;
  const args = [];
  if (q || RARITIES.indexOf(rarity) >= 0 || idx != null) {
    // Search by item name and rarity: turn them into the matching item indexes.
    const want = ALL_ITEMS.map((it, i) => i).filter((i) => (!q || ALL_ITEMS[i].name.toLowerCase().indexOf(q) >= 0) &&
      (!rarity || ALL_ITEMS[i].rarity === rarity) && (idx == null || String(i) === idx));
    where += ' AND l.idx IN (SELECT value FROM json_each(?))';
    args.push(JSON.stringify(want));
  }
  const { results } = await env.DB.prepare(
    `SELECT l.*, a.name AS seller_name FROM listings l JOIN accounts a ON a.id = l.seller
      WHERE ${where} ORDER BY ${sort}, l.id LIMIT 61 OFFSET ?`).bind(...args, offset).all();
  return json({ listings: results.slice(0, 60).map(listingOut), more: results.length > 60 });
}

async function myListings(env, me) {
  const { results } = await env.DB.prepare(
    `SELECT l.*, b.name AS buyer_name FROM listings l LEFT JOIN accounts b ON b.id = l.buyer
      WHERE l.seller = ? ORDER BY (l.status = 'open') DESC, l.updated_at DESC LIMIT 60`).bind(me.id).all();
  return json({ listings: results.map((l) => listingOut(Object.assign(l, { seller_name: me.name }))) });
}

async function createListing(request, env, me) {
  const db = env.DB;
  const b = await body(request);
  if (!isInt(b.item, 1, 1e15)) fail(400, 'Pick an item');
  if (!isInt(b.price, 1, MAX_PRICE)) fail(400, 'Prices are 1 to ' + MAX_PRICE.toLocaleString('en-US') + ' coins');
  await limit(db, 'listing', me.id, 'You\'ve listed a lot of items. Wait a few minutes.');
  const it = await db.prepare('SELECT * FROM items WHERE id = ? AND owner = ? AND locked IS NULL').bind(b.item, me.id).first();
  if (!it) fail(409, 'You don\'t have that item any more');
  if (await anyLocked(db, JSON.stringify([it.id]))) fail(409, 'That item is locked. Unlock it to sell it.');
  const open = await db.prepare(`SELECT COUNT(*) AS n FROM listings WHERE seller = ? AND status = 'open'`).bind(me.id).first();
  if (open.n >= MAX_LISTINGS) fail(429, 'You can have ' + MAX_LISTINGS + ' items listed at once');
  const id = randomId(9), t = nowS(), tag = 'm:' + id;
  await transact(db, [
    db.prepare('UPDATE items SET locked = ? WHERE id = ? AND owner = ? AND locked IS NULL').bind(tag, it.id, me.id),
    check(db, '(SELECT locked FROM items WHERE id = ?) = ?', it.id, tag),
    noneLocked(db, JSON.stringify([it.id])),
    db.prepare(`INSERT INTO listings (id, seller, item, idx, wear, float, tracker, value, price, status, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`)
      .bind(id, me.id, it.id, it.idx, it.wear, it.float, it.tracker, it.value, b.price, t, t)
  ]);
  return json({ me: meOut(await account(db, me.id)), inventory: await inventory(db, me.id), id: id });
}

async function listingAction(id, action, env, me) {
  const db = env.DB;
  const l = await db.prepare('SELECT * FROM listings WHERE id = ?').bind(id).first();
  if (!l) fail(404, 'No such listing');
  if (l.status !== 'open') fail(409, l.status === 'sold' ? 'Someone already bought that' : 'That listing was taken down');
  const tag = 'm:' + id, t = nowS();
  const isOpen = check(db, `(SELECT status FROM listings WHERE id = ?) = 'open'`, id);
  if (action === 'buy') {
    if (l.seller === me.id) fail(400, 'That\'s your own listing');
    if (me.coins < l.price) fail(409, 'Not enough coins');
    if (me.inv_count >= MAX_ITEMS) fail(409, 'Your inventory is full');
    await transact(db, [
      isOpen,
      check(db, '(SELECT banned FROM accounts WHERE id = ?) = 0', l.seller),
      check(db, '(SELECT COUNT(*) FROM items WHERE id = ? AND owner = ? AND locked = ?) = 1', l.item, l.seller, tag),
      db.prepare('UPDATE accounts SET coins = coins - ? WHERE id = ?').bind(l.price, me.id),
      db.prepare('UPDATE accounts SET coins = coins + ? WHERE id = ?').bind(l.price, l.seller),
      db.prepare('UPDATE items SET owner = ?, locked = NULL WHERE id = ? AND locked = ?').bind(me.id, l.item, tag),
      db.prepare(`UPDATE listings SET status = 'sold', buyer = ?, updated_at = ? WHERE id = ?`).bind(me.id, t, id)
    ]).catch((e) => { if (e.status === 409) fail(409, 'Someone else just bought that'); throw e; });
  } else if (action === 'cancel') {
    if (l.seller !== me.id) fail(403, 'Only the seller can take it down');
    await transact(db, [
      isOpen,
      db.prepare('UPDATE items SET locked = NULL WHERE locked = ?').bind(tag),
      db.prepare(`UPDATE listings SET status = 'cancelled', updated_at = ? WHERE id = ?`).bind(t, id)
    ]);
  } else {
    fail(404, 'Unknown action');
  }
  return json({ me: meOut(await account(db, me.id)), inventory: await inventory(db, me.id) });
}

// Listings of yours that sold since you were last told, for the heartbeat.
async function newSales(db, me) {
  const { results } = await db.prepare(
    `SELECT l.id, l.idx, l.wear, l.float, l.tracker, l.price, b.name AS buyer_name FROM listings l LEFT JOIN accounts b ON b.id = l.buyer
      WHERE l.seller = ? AND l.status = 'sold' AND l.seen = 0 LIMIT 10`).bind(me.id).all();
  if (results.length) {
    await db.prepare('UPDATE listings SET seen = 1 WHERE id IN (SELECT value FROM json_each(?))').bind(JSON.stringify(results.map((r) => r.id))).run();
  }
  return results.map((r) => ({ item: [0, r.idx, r.wear, r.float, r.tracker], price: r.price, buyer_name: r.buyer_name }));
}

// Takes down listings (admin, bans, deleted accounts): the items go back to their owners.
const listingCancel = (db, l, t) => [
  check(db, `(SELECT status FROM listings WHERE id = ?) = 'open'`, l.id),
  db.prepare('UPDATE items SET locked = NULL WHERE locked = ?').bind('m:' + l.id),
  db.prepare(`UPDATE listings SET status = 'cancelled', updated_at = ? WHERE id = ?`).bind(t, l.id)
];

/* ---------- suggestions ---------- */

const SUGGESTION_STATUS = ['open', 'planned', 'done', 'declined'];

async function listSuggestions(request, url, env) {
  const db = env.DB;
  const me = await authed(request, env).catch(() => null);
  const sort = url.searchParams.get('sort') === 'new' ? 's.created_at DESC, s.rowid DESC' : 's.votes DESC, s.created_at DESC, s.rowid DESC';
  const { results } = await db.prepare(
    `SELECT s.*, a.name AS author_name, ${me ? 'EXISTS (SELECT 1 FROM suggestion_votes v WHERE v.suggestion = s.id AND v.account = ?)' : '0'} AS mine
       FROM suggestions s JOIN accounts a ON a.id = s.author WHERE a.banned = 0 ORDER BY ${sort} LIMIT 100`)
    .bind(...(me ? [me.id] : [])).all();
  return json({
    suggestions: results.map((s) => ({
      id: s.id, author: s.author, author_name: s.author_name, text: s.text, status: s.status, reply: s.reply,
      votes: s.votes, voted: !!s.mine, created_at: s.created_at, updated_at: s.updated_at
    }))
  });
}

async function createSuggestion(request, env, me) {
  const db = env.DB;
  const b = await body(request);
  const text = String(b.text || '').replace(/\s+/g, ' ').trim();
  if (text.length < SUGGESTION_MIN || text.length > SUGGESTION_MAX) fail(400, 'Suggestions are ' + SUGGESTION_MIN + '-' + SUGGESTION_MAX + ' characters');
  const problem = textProblem(text);
  if (problem) fail(400, problem);
  await limit(db, 'suggest', me.id, 'You\'ve posted a lot of suggestions. Try again later.');
  const id = randomId(9), t = nowS();
  await db.batch([
    db.prepare(`INSERT INTO suggestions (id, author, text, status, reply, votes, created_at, updated_at) VALUES (?, ?, ?, 'open', '', 1, ?, ?)`)
      .bind(id, me.id, text, t, t),
    db.prepare('INSERT INTO suggestion_votes (suggestion, account) VALUES (?, ?)').bind(id, me.id)    // you vote for your own
  ]);
  return json({ id: id });
}

async function suggestionAction(id, action, env, me) {
  const db = env.DB;
  const s = await db.prepare('SELECT * FROM suggestions WHERE id = ?').bind(id).first();
  if (!s) fail(404, 'No such suggestion');
  if (action === 'vote') {
    const had = await db.prepare('SELECT 1 FROM suggestion_votes WHERE suggestion = ? AND account = ?').bind(id, me.id).first();
    await db.batch([
      had ? db.prepare('DELETE FROM suggestion_votes WHERE suggestion = ? AND account = ?').bind(id, me.id)
          : db.prepare('INSERT OR IGNORE INTO suggestion_votes (suggestion, account) VALUES (?, ?)').bind(id, me.id),
      db.prepare('UPDATE suggestions SET votes = (SELECT COUNT(*) FROM suggestion_votes WHERE suggestion = ?) WHERE id = ?').bind(id, id)
    ]);
    const now = await db.prepare('SELECT votes FROM suggestions WHERE id = ?').bind(id).first();
    return json({ voted: !had, votes: now.votes });
  }
  if (action === 'delete') {
    if (s.author !== me.id) fail(403, 'Only the person who posted it can delete it');
    await deleteSuggestion(db, id);
    return json({ ok: true });
  }
  fail(404, 'Unknown action');
}

const deleteSuggestion = (db, id) => db.batch([
  db.prepare('DELETE FROM suggestion_votes WHERE suggestion = ?').bind(id),
  db.prepare('DELETE FROM suggestions WHERE id = ?').bind(id)
]);

// Admin overrides for the holiday seasons: { halloween: 'on' | 'off' | 'auto', ... }.
const seasonOverrides = (s) => { try { return JSON.parse(s.seasons || '{}') || {}; } catch (e) { return {}; } };
const activeSeasons = async (env) => seasonsOn(new Date(), seasonOverrides(await settings(env.DB)));

async function config(env) {
  const s = await settings(env.DB);
  return json({
    announcement: s.announcement || '', maintenance: s.maintenance === '1', version: GAME_VERSION,
    seasons: seasonsOn(new Date(), seasonOverrides(s)), season_modes: seasonOverrides(s)
  });
}

// Blocks changes to coins and items while the admin has maintenance on.
async function openForBusiness(env) {
  if ((await settings(env.DB)).maintenance === '1') fail(503, 'The game is down for maintenance. Try again soon.');
}

/* ---------- account management (for players) ---------- */

async function changePassword(request, env, me) {
  const db = env.DB;
  await limit(db, 'password', me.id, 'Too many password changes. Try again later.');
  const b = await body(request);
  const password = String(b.password || '');
  if (password.length < PASS_MIN || password.length > PASS_MAX) fail(400, 'Passwords are ' + PASS_MIN + '-' + PASS_MAX + ' characters');
  if (!(await passwordMatches(String(b.old || ''), me.pass))) fail(400, 'Your current password is wrong');   // not 401: that means "log in again"
  await db.batch([
    db.prepare('UPDATE accounts SET pass = ? WHERE id = ?').bind(await hashPassword(password, randomId(16), PBKDF2_ROUNDS), me.id),
    db.prepare('DELETE FROM sessions WHERE account = ? AND token_hash != ?').bind(me.id, me.s_hash)   // other devices log out
  ]);
  return json({ ok: true });
}

/* ---------- moderation ----------
   Admin requests are { p, g }: p is a JSON string { a: action, n: nonce, ts, ...fields }
   and g is its signature from the admin key. The server checks the signature
   against ADMIN_X / ADMIN_Y, refuses anything older than five minutes and
   never accepts the same nonce twice, then runs the action. Every change is
   written to the admin log. */

const offerRefund = (db, o, status, t) => [
  check(db, `(SELECT status FROM offers WHERE id = ?) = 'pending'`, o.id),
  db.prepare('UPDATE items SET locked = NULL WHERE locked = ?').bind('o:' + o.id),
  db.prepare('UPDATE accounts SET coins = coins + ? WHERE id = ?').bind(o.give_coins, o.from_id),
  db.prepare('UPDATE offers SET status = ?, updated_at = ? WHERE id = ?').bind(status, t, o.id)
];

const lobbyCancel = (db, l, t) => [
  lobbyIs(db, l),
  db.prepare(`UPDATE lobbies SET status = 'cancelled', rev = rev + 1, updated_at = ? WHERE id = ?`).bind(t, l.id)
].concat(refunds(db, l, JSON.parse(l.players)));

async function findAccount(db, who) {
  who = String(who || '').trim();
  const a = who && await db.prepare('SELECT * FROM accounts WHERE id = ? OR name_lower = ?').bind(who, who.toLowerCase()).first();
  if (!a) fail(404, 'No such player');
  return a;
}

// Deletes accounts and everything in them; their open trades and battles are
// cancelled and refunded. Works on many at once in a handful of queries,
// because Cloudflare's free plan allows 50 database calls per request.
async function deleteAccounts(db, ids) {
  if (!ids.length) return;
  const list = JSON.stringify(ids), t = nowS();
  const offers = (await db.prepare(`SELECT * FROM offers WHERE status = 'pending'
      AND (from_id IN (SELECT value FROM json_each(?)) OR to_id IN (SELECT value FROM json_each(?)))`).bind(list, list).all()).results;
  const lobbies = (await db.prepare(`SELECT * FROM lobbies WHERE status = 'open'`).all()).results
    .filter((l) => ids.some((id) => l.players.indexOf('"' + id + '"') >= 0));
  const refundsDue = offers.map((o) => offerRefund(db, o, 'cancelled', t)).concat(lobbies.map((l) => lobbyCancel(db, l, t)));
  // Their open listings come down (their items are deleted below); others' votes on their suggestions go too.
  for (const stmts of refundsDue.slice(0, 20)) await db.batch(stmts).catch(() => {});
  await db.batch([`UPDATE listings SET status = 'cancelled', updated_at = ${t} WHERE status = 'open' AND seller IN`,
    'DELETE FROM suggestion_votes WHERE suggestion IN (SELECT id FROM suggestions WHERE author IN (SELECT value FROM json_each(?))) OR account IN',
    'DELETE FROM suggestions WHERE author IN',
    'DELETE FROM items WHERE owner IN', 'DELETE FROM sessions WHERE account IN', 'DELETE FROM ban_reasons WHERE account IN',
    'DELETE FROM account_devices WHERE account IN', 'DELETE FROM admin_accounts WHERE account IN', 'DELETE FROM accounts WHERE id IN']
    .map((sql) => db.prepare(sql + ' (SELECT value FROM json_each(?))').bind(...(sql.indexOf('json_each') >= 0 ? [list, list] : [list]))));
  await db.batch([db.prepare(`UPDATE suggestions SET votes = (SELECT COUNT(*) FROM suggestion_votes v WHERE v.suggestion = suggestions.id)
    WHERE id IN (SELECT DISTINCT suggestion FROM suggestion_votes) OR votes > 0`)]);
}
const deleteAccount = (db, a) => deleteAccounts(db, [a.id]);

// Stores a gift on the server (coins, items as [idx, wear, float, tracker], message, ttl in s).
async function createServerGift(db, p, actor) {
  const coins = p.coins || 0;
  if (!isInt(coins, 0, 1e12)) fail(400, 'Bad coin amount');
  const list = Array.isArray(p.items) ? p.items : [];
  if (list.length > 50) fail(400, 'At most 50 items');
  const rows = list.map((t) => {
    const it = tupleToItem(t);
    if (!it) fail(400, 'One of those items isn\'t valid');
    return t.concat([it.value]);
  });
  if (!coins && !rows.length) fail(400, 'Add coins or items first');
  const ttl = isInt(p.ttl, 0, 365 * 86400) ? p.ttl : 0;
  const id = randomId(12);
  await db.prepare('INSERT INTO server_gifts (id, coins, items, message, expires, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(id, coins, JSON.stringify(rows), String(p.message || '').slice(0, 120), ttl ? nowS() + ttl : 0, nowS(),
          actor ? actor.name : 'admin key').run();
  return { id: id, summary: (coins ? coins + ' coins' : '') + (coins && rows.length ? ' + ' : '') + (rows.length ? rows.length + ' item(s)' : '') };
}

async function loginGiftInfo(db, id) {
  const g = await db.prepare('SELECT * FROM server_gifts WHERE id = ?').bind(id).first();
  if (!g) return null;
  const claims = await db.prepare('SELECT COUNT(*) AS n FROM gift_claims WHERE gift_id = ?').bind(id).first();
  return { id: g.id, coins: g.coins, items: JSON.parse(g.items).map((r) => r.slice(0, 4)), message: g.message, expires: g.expires,
           created_at: g.created_at, claims: claims.n, expired: !!(g.expires && g.expires < nowS()) };
}

// Account ids from `ids` that aren't admins (bulk actions never touch admins).
async function withoutAdmins(db, ids) {
  const admins = new Set((await db.prepare('SELECT account FROM admin_accounts').all()).results.map((r) => r.account));
  return ids.filter((id) => !admins.has(id) && !isPermanentAdmin(id));
}

// Bans or deletes a list of accounts (at most 500 at a time). Returns how many.
async function banOrDelete(db, ids, mode, reason) {
  ids = (await withoutAdmins(db, ids)).slice(0, 500);
  if (!ids.length) return 0;
  if (mode === 'delete') {
    await deleteAccounts(db, ids);
  } else {
    const list = JSON.stringify(ids), t = nowS();
    await db.batch([
      db.prepare('UPDATE accounts SET banned = 1 WHERE id IN (SELECT value FROM json_each(?))').bind(list),
      db.prepare('INSERT OR REPLACE INTO ban_reasons (account, reason, at) SELECT value, ?, ? FROM json_each(?)').bind(reason, t, list)
    ]);
  }
  return ids.length;
}

function deviceArg(p) {
  const kind = String(p.kind || ''), value = String(p.value || '');
  if (!DEVICE_KINDS[kind] || !/^[A-Za-z0-9_-]{10,40}$/.test(value)) fail(400, 'Unknown device');
  return { kind, value, label: DEVICE_KINDS[kind] + ' ' + value.slice(0, 6) };
}
const accountsOn = async (db, kind, value) => (await db.prepare(
  'SELECT account FROM account_devices WHERE kind = ? AND value = ?').bind(kind, value).all()).results.map((r) => r.account);

const adminRow = (a) => ({
  id: a.id, name: a.name, coins: a.coins, inv_value: a.inv_value, inv_count: a.inv_count, opened: a.opened,
  best_value: a.best_value, best_item: a.best_item, played: a.played, banned: !!a.banned,
  created_at: a.created_at, last_seen: a.last_seen
});

// Makes `count` copies of an item. wear: 1-5 for a grade, -1 to roll it.
function makeItems(idx, wear, tracker, count) {
  const base = ALL_ITEMS[idx];
  if (!base) fail(400, 'Unknown item');
  if (!isInt(count, 1, 100)) fail(400, 'Give 1-100 at a time');
  const rows = [];
  for (let i = 0; i < count; i++) {
    let w = 0, f = 0;
    if (!NO_WEAR[base.kind]) {
      const grade = isInt(wear, 1, 5) ? WEARS[wear - 1] : rollWear(rand);
      w = WEARS.indexOf(grade) + 1;
      f = Math.round((grade.lo + rand() * (grade.hi - grade.lo)) * 10000);
      f = Math.min(Math.round(grade.hi * 10000), Math.max(Math.round(grade.lo * 10000), f));
    }
    const t = tracker && !NO_TRACKER[base.kind] ? 1 : 0;
    const it = tupleToItem([idx, w, f, t]);
    if (!it) fail(400, 'That item can\'t have that wear');
    rows.push([idx, w, f, t, it.value]);
  }
  return rows;
}

const ADMIN = {
  async stats(db) {
    const t = nowS();
    const totals = await db.prepare(
      `SELECT COUNT(*) AS accounts, COALESCE(SUM(banned), 0) AS banned, COALESCE(SUM(last_seen > ?), 0) AS online,
              COALESCE(SUM(last_seen > ?), 0) AS active_day, COALESCE(SUM(created_at > ?), 0) AS new_day,
              COALESCE(SUM(coins), 0) AS coins, COALESCE(SUM(inv_value), 0) AS item_value, COALESCE(SUM(inv_count), 0) AS items,
              COALESCE(SUM(opened), 0) AS opened, COALESCE(SUM(played), 0) AS played FROM accounts`)
      .bind(t - 300, t - 86400, t - 86400).first();
    const counts = await db.prepare(
      `SELECT (SELECT COUNT(*) FROM offers WHERE status = 'pending') AS offers,
              (SELECT COUNT(*) FROM offers WHERE status = 'accepted' AND updated_at > ?) AS trades_day,
              (SELECT COUNT(*) FROM lobbies WHERE status = 'open') AS lobbies,
              (SELECT COUNT(*) FROM lobbies WHERE status = 'running' AND updated_at > ?) AS battles_day,
              (SELECT COUNT(*) FROM gift_claims) AS gift_claims`).bind(t - 86400, t - 86400).first();
    const list = async (sql) => (await db.prepare(sql).all()).results.map(adminRow);
    // Accounts made before the name rules (or renamed around them) that break them now.
    const names = (await db.prepare('SELECT id, name, banned FROM accounts LIMIT 20000').all()).results;
    const allBad = names.filter((a) => nameProblem(a.name, true)).sort((x, y) => x.banned - y.banned);   // not yet banned first
    const badIds = allBad.slice(0, 20).map((a) => a.id);
    const badNames = badIds.length ? (await db.prepare('SELECT * FROM accounts WHERE id IN (SELECT value FROM json_each(?))')
      .bind(JSON.stringify(badIds)).all()).results.map(adminRow) : [];
    return {
      totals: Object.assign(totals, counts),
      bad_names: badNames,
      bad_names_total: allBad.length,
      richest: await list('SELECT * FROM accounts ORDER BY coins DESC LIMIT 5'),
      top_items: await list('SELECT * FROM accounts ORDER BY inv_value DESC LIMIT 5'),
      newest: await list('SELECT * FROM accounts ORDER BY created_at DESC LIMIT 5'),
      recent: await list('SELECT * FROM accounts ORDER BY last_seen DESC LIMIT 8')
    };
  },

  async find(db, p) {
    const q = String(p.q || '').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 16);
    const { results } = await db.prepare(
      `SELECT * FROM accounts WHERE name_lower LIKE ? OR id = ? ORDER BY last_seen DESC LIMIT 40`).bind(q + '%', String(p.q || '')).all();
    return { players: results.map(adminRow) };
  },

  async player(db, p) {
    const a = await findAccount(db, p.id);
    const items = (await db.prepare('SELECT id, idx, wear, float, tracker, locked FROM items WHERE owner = ? ORDER BY value DESC')
      .bind(a.id).all()).results.map((r) => [r.id, r.idx, r.wear, r.float, r.tracker, r.locked ? (r.locked[0] === 'm' ? 2 : 1) : 0]);   // 1 in a trade, 2 on the market
    const offers = (await db.prepare(
      `SELECT o.id, o.status, o.give_coins, o.want_coins, o.updated_at, f.name AS from_name, r.name AS to_name,
              json_array_length(o.give) AS give_n, json_array_length(o.want) AS want_n
         FROM offers o JOIN accounts f ON f.id = o.from_id JOIN accounts r ON r.id = o.to_id
        WHERE o.from_id = ? OR o.to_id = ? ORDER BY o.updated_at DESC LIMIT 20`).bind(a.id, a.id).all()).results;
    const sessions = await db.prepare('SELECT COUNT(*) AS n, MAX(last_used) AS last FROM sessions WHERE account = ?').bind(a.id).first();
    const devices = (await db.prepare(
      `SELECT d.kind, d.value, d.label, d.first_at, d.last_at,
              (SELECT COUNT(*) FROM account_devices o WHERE o.kind = d.kind AND o.value = d.value) - 1 AS others,
              EXISTS (SELECT 1 FROM device_bans b WHERE b.kind = d.kind AND b.value = d.value) AS blocked
         FROM account_devices d WHERE d.account = ? ORDER BY d.kind, d.last_at DESC LIMIT 30`).bind(a.id).all()).results;
    return Object.assign(adminRow(a), {
      ban_reason: await banReason(db, a.id), fail_count: a.fail_count, sessions: sessions.n, items: items, offers: offers, devices: devices,
      admin: await isAdminAccount(db, a.id), permanent_admin: isPermanentAdmin(a.id)
    });
  },

  async grant_admin(db, p) {
    const a = await findAccount(db, p.id);
    await db.prepare('INSERT OR IGNORE INTO admin_accounts (account, at) VALUES (?, ?)').bind(a.id, nowS()).run();
    return { log: [a.name, 'made an admin'] };
  },

  async revoke_admin(db, p) {
    const a = await findAccount(db, p.id);
    if (isPermanentAdmin(a.id)) fail(409, a.name + ' is always an admin (set in wrangler.toml)');
    await db.prepare('DELETE FROM admin_accounts WHERE account = ?').bind(a.id).run();
    return { log: [a.name, 'no longer an admin'] };
  },

  // A gift code stored on the server, for admins without the key.
  async make_gift(db, p, actor) {
    const g = await createServerGift(db, p, actor);
    return { code: 'GIFT2.' + g.id, log: ['gift ' + g.id, 'created: ' + g.summary] };
  },

  // The login gift: offered once to every account when it logs in (or plays).
  // With no fields it reports the current one; `end` stops it.
  async login_gift(db, p, actor) {
    const s = await settings(db);
    if (p.end) {
      await db.prepare("DELETE FROM settings WHERE k = 'login_gift'").run();
      settingsCache.at = 0;
      return { gift: null, log: ['login gift', 'ended'] };
    }
    if (p.coins != null || p.items != null) {
      const g = await createServerGift(db, p, actor);
      await db.prepare("INSERT OR REPLACE INTO settings (k, v) VALUES ('login_gift', ?)").bind(g.id).run();
      settingsCache.at = 0;
      return { gift: await loginGiftInfo(db, g.id), log: ['login gift', 'started: ' + g.summary] };
    }
    return { gift: s.login_gift ? await loginGiftInfo(db, s.login_gift) : null };
  },

  async coins(db, p) {
    const a = await findAccount(db, p.id);
    if (p.set != null) {
      if (!isInt(p.set, 0, 1e12)) fail(400, 'Bad amount');
      await db.prepare('UPDATE accounts SET coins = ? WHERE id = ?').bind(p.set, a.id).run();
      return { log: [a.name, 'set coins to ' + p.set + ' (was ' + a.coins + ')'] };
    }
    if (!isInt(p.delta, -1e12, 1e12) || !p.delta) fail(400, 'Bad amount');
    await db.prepare('UPDATE accounts SET coins = MAX(0, coins + ?) WHERE id = ?').bind(p.delta, a.id).run();
    return { log: [a.name, (p.delta > 0 ? 'gave ' : 'took ') + Math.abs(p.delta) + ' coins'] };
  },

  async give(db, p) {
    const a = await findAccount(db, p.id);
    const rows = makeItems(p.idx, p.wear, p.tracker ? 1 : 0, p.count || 1);
    if (a.inv_count + rows.length > MAX_ITEMS) fail(409, 'Their inventory is full');
    await db.batch([insertItems(db, a.id, rows, nowS())]);
    return { log: [a.name, 'gave ' + rows.length + ' x ' + ALL_ITEMS[p.idx].name] };
  },

  async take(db, p) {
    const a = await findAccount(db, p.id);
    const ids = JSON.stringify(idList(p.ids, MAX_ITEMS));
    const res = await db.prepare(
      'DELETE FROM items WHERE owner = ? AND locked IS NULL AND id IN (SELECT value FROM json_each(?)) RETURNING idx').bind(a.id, ids).all();
    if (!res.results.length) fail(409, 'Nothing removed (items in an open trade offer can\'t be removed; cancel the offer first)');
    return { removed: res.results.length, log: [a.name, 'removed ' + res.results.length + ' item(s): ' +
      res.results.slice(0, 5).map((r) => ALL_ITEMS[r.idx].name).join(', ') + (res.results.length > 5 ? '…' : '')] };
  },

  // Makes an account for someone, skipping the sign-up check and the device
  // limits. The name rules still apply; the password never goes in the log.
  async create_account(db, p) {
    const { name, password } = readCredentials(p);
    const problem = nameProblem(name);
    if (problem) fail(400, problem);
    if (await db.prepare('SELECT 1 FROM accounts WHERE name_lower = ?').bind(name.toLowerCase()).first()) fail(409, 'That username is taken');
    const id = randomId(9), t = nowS();
    const pass = await hashPassword(password, randomId(16), PBKDF2_ROUNDS);
    await db.prepare('INSERT INTO accounts (id, name, name_lower, pass, created_at, last_seen, last_ping) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(id, name, name.toLowerCase(), pass, t, t, t).run()
      .catch((e) => { if (/UNIQUE/i.test(String(e && e.message))) fail(409, 'That username is taken'); throw e; });
    return { id: id, name: name, log: [name, 'account created'] };
  },

  async rename(db, p) {
    const a = await findAccount(db, p.id);
    const name = String(p.name || '').trim();
    const problem = nameProblem(name, true);
    if (problem) fail(400, problem);
    const taken = await db.prepare('SELECT id FROM accounts WHERE name_lower = ?').bind(name.toLowerCase()).first();
    if (taken && taken.id !== a.id) fail(409, 'That username is taken');
    await db.prepare('UPDATE accounts SET name = ?, name_lower = ? WHERE id = ?').bind(name, name.toLowerCase(), a.id).run();
    return { log: [a.name, 'renamed to ' + name] };
  },

  async ban(db, p) {
    const a = await findAccount(db, p.id);
    const reason = String(p.reason || '').trim().slice(0, 200);
    await db.batch([
      db.prepare('UPDATE accounts SET banned = 1 WHERE id = ?').bind(a.id),
      db.prepare('INSERT OR REPLACE INTO ban_reasons (account, reason, at) VALUES (?, ?, ?)').bind(a.id, reason, nowS())
    ]);
    return { log: [a.name, 'banned' + (reason ? ': ' + reason : '')] };
  },

  async unban(db, p) {
    const a = await findAccount(db, p.id);
    await db.batch([
      db.prepare('UPDATE accounts SET banned = 0 WHERE id = ?').bind(a.id),
      db.prepare('DELETE FROM ban_reasons WHERE account = ?').bind(a.id)
    ]);
    return { log: [a.name, 'unbanned'] };
  },

  async reset(db, p) {
    const a = await findAccount(db, p.id);
    const password = String(p.password || '');
    if (password.length < PASS_MIN || password.length > PASS_MAX) fail(400, 'Passwords are ' + PASS_MIN + '-' + PASS_MAX + ' characters');
    await db.batch([
      db.prepare('UPDATE accounts SET pass = ?, fail_count = 0 WHERE id = ?')
        .bind(await hashPassword(password, randomId(16), PBKDF2_ROUNDS), a.id),
      db.prepare('DELETE FROM sessions WHERE account = ?').bind(a.id)
    ]);
    return { log: [a.name, 'password reset'] };
  },

  async logout(db, p) {
    const a = await findAccount(db, p.id);
    const r = await db.prepare('DELETE FROM sessions WHERE account = ?').bind(a.id).run();
    return { log: [a.name, 'logged out of ' + (r.meta ? r.meta.changes : 0) + ' device(s)'] };
  },

  // Removes an account for good. Open trades involving it are cancelled and
  // refunded, and open battles it sits in are cancelled and refunded.
  async delete(db, p) {
    const a = await findAccount(db, p.id);
    if (p.confirm !== a.name) fail(400, 'Type the username exactly to confirm');
    await deleteAccount(db, a);
    return { log: [a.name, 'account deleted (' + a.coins + ' coins, ' + a.inv_count + ' items)'] };
  },

  async offers(db) {
    const { results } = await db.prepare(
      `SELECT o.id, o.give, o.give_coins, o.want, o.want_coins, o.message, o.created_at, f.name AS from_name, r.name AS to_name
         FROM offers o JOIN accounts f ON f.id = o.from_id JOIN accounts r ON r.id = o.to_id
        WHERE o.status = 'pending' ORDER BY o.created_at DESC LIMIT 60`).all();
    return { offers: results.map((o) => Object.assign(o, { give: JSON.parse(o.give), want: JSON.parse(o.want) })) };
  },

  async cancel_offer(db, p) {
    const o = await db.prepare('SELECT * FROM offers WHERE id = ?').bind(String(p.offer || '')).first();
    if (!o || o.status !== 'pending') fail(409, 'That offer isn\'t open');
    await transact(db, offerRefund(db, o, 'cancelled', nowS()));
    return { log: ['offer ' + o.id, 'cancelled and refunded'] };
  },

  async listings(db) {
    const { results } = await db.prepare(
      `SELECT l.*, a.name AS seller_name FROM listings l JOIN accounts a ON a.id = l.seller
        WHERE l.status = 'open' ORDER BY l.created_at DESC LIMIT 80`).all();
    return { listings: results.map(listingOut) };
  },

  async cancel_listing(db, p) {
    const l = await db.prepare('SELECT * FROM listings WHERE id = ?').bind(String(p.listing || '')).first();
    if (!l || l.status !== 'open') fail(409, 'That listing isn\'t open');
    await transact(db, listingCancel(db, l, nowS()));
    return { log: ['listing ' + l.id, 'taken down (' + ALL_ITEMS[l.idx].name + ' for ' + l.price + ')'] };
  },

  async suggestion(db, p) {
    const s = await db.prepare('SELECT * FROM suggestions WHERE id = ?').bind(String(p.id || '')).first();
    if (!s) fail(404, 'No such suggestion');
    const status = SUGGESTION_STATUS.indexOf(p.status) >= 0 ? p.status : s.status;
    const reply = p.reply != null ? String(p.reply).replace(/\s+/g, ' ').trim().slice(0, 300) : s.reply;
    await db.prepare('UPDATE suggestions SET status = ?, reply = ?, updated_at = ? WHERE id = ?').bind(status, reply, nowS(), s.id).run();
    return { log: ['suggestion ' + s.id, status + (reply ? ': ' + reply : '')] };
  },

  async delete_suggestion(db, p) {
    const s = await db.prepare('SELECT * FROM suggestions WHERE id = ?').bind(String(p.id || '')).first();
    if (!s) fail(404, 'No such suggestion');
    await deleteSuggestion(db, s.id);
    return { log: ['suggestion ' + s.id, 'deleted: ' + s.text.slice(0, 80)] };
  },

  async lobbies(db) {
    const { results } = await db.prepare(`SELECT * FROM lobbies WHERE status = 'open' ORDER BY created_at DESC LIMIT 60`).all();
    return { lobbies: results.map(battleOut) };
  },

  async cancel_lobby(db, p) {
    const l = await db.prepare('SELECT * FROM lobbies WHERE id = ?').bind(String(p.lobby || '')).first();
    if (!l || l.status !== 'open') fail(409, 'That battle isn\'t open');
    await transact(db, lobbyCancel(db, l, nowS()));
    return { log: ['battle ' + l.id, 'cancelled and refunded'] };
  },

  // Devices, browsers and networks shared by several accounts or used by an
  // account with a rude name, most suspicious first; plus blocked ones.
  async devices(db) {
    const rows = (await db.prepare(
      `SELECT d.kind, d.value, d.label, d.last_at, a.id, a.name, a.banned FROM account_devices d
         JOIN accounts a ON a.id = d.account ORDER BY d.last_at DESC LIMIT 50000`).all()).results;
    const groups = new Map();
    for (const r of rows) {
      const key = r.kind + ':' + r.value;
      let g = groups.get(key);
      if (!g) groups.set(key, g = { kind: r.kind, value: r.value, label: '', last_at: 0, accounts: 0, banned: 0, rude: 0, names: [] });
      g.label = g.label || r.label;
      g.last_at = Math.max(g.last_at, r.last_at);
      g.accounts++;
      g.banned += r.banned ? 1 : 0;
      if (nameProblem(r.name, true)) g.rude++;
      if (g.names.length < 6) g.names.push(r.name);
    }
    const blocked = (await db.prepare('SELECT kind, value, reason, at FROM device_bans ORDER BY at DESC LIMIT 100').all()).results;
    const isBlocked = new Set(blocked.map((b) => b.kind + ':' + b.value));
    const flagged = [...groups.values()]
      .filter((g) => (g.rude && (g.kind === 'd' || g.accounts > 1)) || g.accounts >= DEVICE_FLAG[g.kind])
      .map((g) => Object.assign(g, { blocked: isBlocked.has(g.kind + ':' + g.value) }))
      .sort((x, y) => (y.rude - y.banned > 0) - (x.rude - x.banned > 0) || y.accounts - x.accounts)
      .slice(0, 40);
    return { flagged, blocked, limits: DEVICE_FLAG };
  },

  async device(db, p) {
    const { kind, value } = deviceArg(p);
    const rows = (await db.prepare(
      `SELECT a.*, d.label AS dev_label, d.first_at AS dev_first, d.last_at AS dev_last FROM account_devices d
         JOIN accounts a ON a.id = d.account WHERE d.kind = ? AND d.value = ? ORDER BY a.created_at DESC LIMIT 500`).bind(kind, value).all()).results;
    const admins = new Set(await withoutAdmins(db, rows.map((r) => r.id)));
    const ban = await db.prepare('SELECT reason, at FROM device_bans WHERE kind = ? AND value = ?').bind(kind, value).first();
    return {
      kind, value, label: (rows.find((r) => r.dev_label) || {}).dev_label || '', blocked: ban || null,
      accounts: rows.map((r) => Object.assign(adminRow(r), {
        rude: !!nameProblem(r.name, true), admin: !admins.has(r.id), seen_first: r.dev_first, seen_last: r.dev_last
      }))
    };
  },

  // Bans every account seen on it (never admins) and, with `block`, stops it making or using accounts.
  async ban_device(db, p) {
    const d = deviceArg(p);
    const reason = String(p.reason || '').trim().slice(0, 200);
    const n = await banOrDelete(db, await accountsOn(db, d.kind, d.value), 'ban', reason);
    if (p.block) await db.prepare('INSERT OR REPLACE INTO device_bans (kind, value, reason, at) VALUES (?, ?, ?, ?)').bind(d.kind, d.value, reason, nowS()).run();
    return { count: n, log: [d.label, 'banned ' + n + ' account(s)' + (p.block ? ' and blocked it' : '') + (reason ? ': ' + reason : '')] };
  },

  async block_device(db, p) {
    const d = deviceArg(p);
    const reason = String(p.reason || '').trim().slice(0, 200);
    await db.prepare('INSERT OR REPLACE INTO device_bans (kind, value, reason, at) VALUES (?, ?, ?, ?)').bind(d.kind, d.value, reason, nowS()).run();
    return { log: [d.label, 'blocked' + (reason ? ': ' + reason : '')] };
  },

  async unblock_device(db, p) {
    const d = deviceArg(p);
    await db.prepare('DELETE FROM device_bans WHERE kind = ? AND value = ?').bind(d.kind, d.value).run();
    return { log: [d.label, 'unblocked'] };
  },

  async delete_device(db, p) {
    const d = deviceArg(p);
    if (p.confirm !== 'DELETE') fail(400, 'Type DELETE to confirm');
    const n = await banOrDelete(db, await accountsOn(db, d.kind, d.value), 'delete');
    return { count: n, log: [d.label, 'deleted ' + n + ' account(s)'] };
  },

  // Deletes every banned account (never admins), 500 at a time.
  async delete_banned(db, p) {
    if (p.confirm !== 'DELETE') fail(400, 'Type DELETE to confirm');
    const ids = (await db.prepare('SELECT id FROM accounts WHERE banned = 1 LIMIT 600').all()).results.map((r) => r.id);
    const n = await banOrDelete(db, ids, 'delete');
    const left = (await db.prepare('SELECT COUNT(*) AS n FROM accounts WHERE banned = 1').first()).n;
    return { count: n, left: left, log: ['banned accounts', 'deleted ' + n + ' banned account(s)'] };
  },

  // Bans or deletes every account whose name breaks the name rules (never admins).
  async bad_names(db, p) {
    const mode = p.mode === 'delete' ? 'delete' : 'ban';
    if (mode === 'delete' && p.confirm !== 'DELETE') fail(400, 'Type DELETE to confirm');
    const names = (await db.prepare('SELECT id, name FROM accounts WHERE banned = 0 OR ? LIMIT 20000').bind(mode === 'delete' ? 1 : 0).all()).results;
    const ids = names.filter((a) => nameProblem(a.name, true)).map((a) => a.id);
    const n = await banOrDelete(db, ids, mode, String(p.reason || 'Username breaks the rules').slice(0, 200));
    return { count: n, log: ['rule-breaking names', (mode === 'delete' ? 'deleted ' : 'banned ') + n + ' account(s)'] };
  },

  async settings(db, p) {
    const stmts = [], changes = [];
    if (p.announcement != null) {
      const text = String(p.announcement).trim().slice(0, 300);
      stmts.push(db.prepare('INSERT OR REPLACE INTO settings (k, v) VALUES (?, ?)').bind('announcement', text));
      changes.push(text ? 'announcement: ' + text : 'announcement cleared');
    }
    if (p.maintenance != null) {
      stmts.push(db.prepare('INSERT OR REPLACE INTO settings (k, v) VALUES (?, ?)').bind('maintenance', p.maintenance ? '1' : '0'));
      changes.push('maintenance ' + (p.maintenance ? 'on' : 'off'));
    }
    if (p.seasons && typeof p.seasons === 'object') {
      // Holiday cases: 'on' or 'off' by hand, or 'auto' to follow the calendar.
      const modes = seasonOverrides(await settings(db));
      Object.keys(SEASONS).forEach((k) => {
        const v = p.seasons[k];
        if (v !== 'on' && v !== 'off' && v !== 'auto') return;
        if (v === 'auto') delete modes[k]; else modes[k] = v;
        changes.push(SEASONS[k].name + ' cases ' + (v === 'auto' ? 'follow the calendar' : v));
      });
      stmts.push(db.prepare('INSERT OR REPLACE INTO settings (k, v) VALUES (?, ?)').bind('seasons', JSON.stringify(modes)));
    }
    if (!stmts.length) fail(400, 'Nothing to change');
    await db.batch(stmts);
    settingsCache.at = 0;
    return { log: ['game', changes.join('; ')] };
  },

  // The reward track. With no `days` it reports the current one.
  async rewards(db, p) {
    if (p.days == null && p.on == null) return { rewards: rewardConfig(await settings(db)) };
    const cur = rewardConfig(await settings(db));
    const period = p.period === 'month' ? 'month' : p.period === 'week' ? 'week' : cur.period;
    const days = p.days == null ? cur.days : p.days;
    if (!Array.isArray(days) || !days.length || days.length > (period === 'month' ? 31 : 7)) {
      fail(400, period === 'month' ? 'A monthly track has 1-31 days' : 'A weekly track has 1-7 days');
    }
    const clean = days.map((d, i) => {
      const coins = d && d.coins != null ? d.coins : 0;
      if (!isInt(coins, 0, 1e9)) fail(400, 'Day ' + (i + 1) + ': bad coin amount');
      const items = Array.isArray(d.items) ? d.items : [];
      if (items.length > 10) fail(400, 'Day ' + (i + 1) + ': at most 10 items');
      items.forEach((it) => {
        if (!Array.isArray(it) || it.length !== 3 || !isInt(it[0], 0, ALL_ITEMS.length - 1) || !isInt(it[1], -1, 5) || !isInt(it[2], 0, 1)) {
          fail(400, 'Day ' + (i + 1) + ': one of the items isn\'t valid');
        }
        makeItems(it[0], it[1], it[2], 1);                // throws if that wear or tracker can't exist
      });
      return { coins: coins, items: items.map((it) => it.slice()) };
    });
    const out = { on: p.on == null ? cur.on !== false : !!p.on, title: String(p.title == null ? cur.title : p.title).trim().slice(0, 40) || 'Rewards',
                  period: period, days: clean };
    await db.prepare("INSERT OR REPLACE INTO settings (k, v) VALUES ('rewards', ?)").bind(JSON.stringify(out)).run();
    settingsCache.at = 0;
    return { rewards: out, log: ['rewards', (out.on ? '' : 'off; ') + out.title + ': ' + out.period + 'ly, ' + out.days.length + ' days'] };
  },

  async gifts(db, p) {
    const ids = Array.isArray(p.gifts) ? p.gifts.map(String).slice(0, 100) : [];
    const out = {};
    for (const id of ids) {
      const c = await db.prepare(
        'SELECT (SELECT COUNT(*) FROM gift_claims WHERE gift_id = ?) AS claims, (SELECT COUNT(*) FROM revoked_gifts WHERE gift_id = ?) AS revoked')
        .bind(id, id).first();
      out[id] = { claims: c.claims, revoked: !!c.revoked };
    }
    return { gifts: out };
  },

  async revoke_gift(db, p) {
    const id = String(p.gift || '');
    if (!id) fail(400, 'Which gift?');
    if (p.undo) await db.prepare('DELETE FROM revoked_gifts WHERE gift_id = ?').bind(id).run();
    else await db.prepare('INSERT OR IGNORE INTO revoked_gifts (gift_id, at) VALUES (?, ?)').bind(id, nowS()).run();
    return { log: ['gift ' + id, p.undo ? 'reinstated' : 'cancelled'] };
  },

  async log(db) {
    const { results } = await db.prepare('SELECT * FROM admin_log ORDER BY id DESC LIMIT 150').all();
    return { entries: results };
  }
};

// Actions only the admin key can do, and actions that can't touch an admin
// account unless the key is used.
const KEY_ONLY = { grant_admin: 1, revoke_admin: 1 };
const PROTECTS_ADMINS = { ban: 1, delete: 1, reset: 1, rename: 1, logout: 1, coins: 1, take: 1 };

// Two ways in: a request signed with the admin key, or the session of an
// admin account (like LILBEAN), which needs no key.
async function admin(request, env) {
  const db = env.DB;
  const b = await body(request);
  let p = null;
  try { p = JSON.parse(b.p); } catch (e) { p = null; }
  if (!p || typeof p.a !== 'string') fail(400, 'Bad request');
  let actor = null;
  if (typeof b.g === 'string') {
    if (!(await signedByAdmin(env, b.p, b.g))) fail(403, 'Not admin');
    if (!isInt(p.ts, 0, 1e12) || Math.abs(nowS() - p.ts) > 300) fail(400, 'Request expired. Check your device clock.');
    if (typeof p.n !== 'string' || !/^[A-Za-z0-9_-]{8,40}$/.test(p.n)) fail(400, 'Missing request id');
    // A signed request works once: a copied request can't be replayed.
    try {
      await db.batch([
        db.prepare('DELETE FROM admin_nonces WHERE at < ?').bind(nowS() - 86400),
        db.prepare('INSERT INTO admin_nonces (n, at) VALUES (?, ?)').bind(p.n, nowS())
      ]);
    } catch (e) { fail(409, 'That request was already used'); }
  } else {
    const me = await authed(request, env).catch(() => null);
    if (!me || !(await isAdminAccount(db, me.id))) fail(403, 'Not admin');
    actor = me;
  }
  const run = Object.prototype.hasOwnProperty.call(ADMIN, p.a) && ADMIN[p.a];
  if (!run) fail(400, 'Unknown action');
  if (actor && KEY_ONLY[p.a]) fail(403, 'Only the admin key can do that');
  if (actor && PROTECTS_ADMINS[p.a]) {
    const target = await findAccount(db, p.id);
    if (target.id !== actor.id && await isAdminAccount(db, target.id)) fail(403, 'Admin accounts can only be changed with the admin key');
    if (target.id === actor.id && (p.a === 'ban' || p.a === 'delete')) fail(403, 'You can\'t do that to your own account');
  }
  const out = (await run(db, p, actor)) || {};
  if (Array.isArray(out.log)) {
    await db.prepare('INSERT INTO admin_log (at, action, target, detail) VALUES (?, ?, ?, ?)')
      .bind(nowS(), p.a, String(out.log[0]).slice(0, 80), ((actor ? 'by ' + actor.name + ': ' : '') + String(out.log[1])).slice(0, 300)).run();
    delete out.log;
  }
  return json(Object.assign({ ok: true }, out));
}

/* ---------- router ---------- */

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    const url = new URL(request.url);
    const [root, a, b, c] = url.pathname.replace(/\/+$/, '').split('/').slice(1);
    permanentAdmins = new Set(String(env.ADMIN_ACCOUNTS || '').split(',').map((x) => x.trim()).filter(Boolean));
    const method = request.method;
    try {
      if (root !== 'api') return json({ ok: true, service: 'case-sim', version: GAME_VERSION });
      const kind = a === 'signup' || a === 'login' || a === 'challenge' ? 'auth' : a === 'admin' ? 'admin' : method === 'GET' ? 'read' : 'write';
      quickLimit(kind + ':' + ipOf(request), QUICK_LIMITS[kind]);

      if (method === 'GET' && a === 'challenge') return await challenge(env);
      if (method === 'POST' && a === 'signup') return await signup(request, env);
      if (method === 'POST' && a === 'login') return await login(request, env);
      if (method === 'GET' && a === 'leaderboard') return await leaderboard(url, env);
      if (method === 'GET' && a === 'config') return await config(env);
      if (method === 'GET' && a === 'players' && !b) return await searchPlayers(url, env);
      if (method === 'GET' && a === 'players' && b) return await playerProfile(b, env);
      if (method === 'GET' && a === 'battles' && !b) return await listBattles(env);
      if (method === 'GET' && a === 'battles' && b) return await getBattle(b, env);
      if (method === 'GET' && a === 'market' && !b) return await browseMarket(url, env);
      if (method === 'GET' && a === 'suggestions') return await listSuggestions(request, url, env);
      if (method === 'POST' && a === 'admin') return await admin(request, env);

      const me = await authed(request, env);
      if (!me) fail(401, 'Please log in again');
      quickLimit('account:' + me.id, QUICK_LIMITS.account);
      if (method === 'POST' && a === 'logout') {
        await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(me.s_hash).run();
        return json({ ok: true });
      }
      if (method === 'GET' && a === 'me') {
        return json(Object.assign({ me: await meFull(env.DB, me), inventory: await inventory(env.DB, me.id), locks: await lockList(env.DB, me.id),
          invites: await myInvites(env.DB, me) }, await perks(env.DB, me)));
      }
      if (method === 'POST' && a === 'lock') return await lockItems(request, env, me);
      if (method === 'GET' && a === 'rewards') return json(rewardsOut(await rewardState(env.DB, me)));
      if (method === 'GET' && a === 'invites') return json({ invites: await myInvites(env.DB, me) });
      if (method === 'POST' && a === 'ping') return await ping(request, env, me);
      if (method === 'POST' && a === 'account' && b === 'password') return await changePassword(request, env, me);
      if (method === 'POST' && a === 'account' && b === 'logout-all') {
        await env.DB.prepare('DELETE FROM sessions WHERE account = ?').bind(me.id).run();
        return json({ ok: true });
      }
      if (method === 'GET' && a === 'market' && b === 'mine') return await myListings(env, me);
      if (method === 'POST' && a === 'suggestions' && !b) return await createSuggestion(request, env, me);
      if (method === 'POST' && a === 'suggestions' && b && c) return await suggestionAction(b, c, env, me);
      // Everything below changes coins or items, which maintenance mode pauses.
      if (method === 'POST') await openForBusiness(env);
      if (method === 'POST' && a === 'open') return await openCase(request, env, me);
      if (method === 'POST' && a === 'sell') return await sell(request, env, me);
      if (method === 'POST' && a === 'shop') return await buyShop(request, env, me);
      if (method === 'POST' && a === 'upgrade') return await upgrade(request, env, me);
      if (method === 'POST' && a === 'gift') return await gift(request, env, me);
      if (method === 'POST' && a === 'offers' && !b) return await createOffer(request, env, me);
      if (method === 'GET' && a === 'offers') return await listOffers(env, me);
      if (method === 'POST' && a === 'offers' && b && c) return await offerAction(b, c, env, me);
      if (method === 'POST' && a === 'battles' && !b) return await createBattle(request, env, me);
      if (method === 'POST' && a === 'battles' && b && c) return await battleAction(b, c, request, env, me);
      if (method === 'POST' && a === 'rewards' && b === 'claim') return await claimReward(env, me);
      if (method === 'POST' && a === 'market' && !b) return await createListing(request, env, me);
      if (method === 'POST' && a === 'market' && b && c) return await listingAction(b, c, env, me);
      fail(404, 'Not found');
    } catch (err) {
      if (err instanceof HttpError) {
        const retry = err.extra && err.extra.retry;
        return json(Object.assign({ error: err.message }, err.extra || {}), err.status, retry ? { 'Retry-After': String(retry) } : null);
      }
      console.error(err && err.stack || err);
      return json({ error: 'Server error' }, 500);
    }
  }
};
