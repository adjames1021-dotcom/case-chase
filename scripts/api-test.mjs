// Server tests: accounts, cases, selling, upgrades, trades, battles, gifts,
// moderation and race conditions, against a local server with an empty
// database. The deploy workflow runs these before anything goes live.
//
// Run with (from server/):
//   npm run db:init:local && npx wrangler dev --local --port 8787 &
//   node ../scripts/api-test.mjs
// Gift and admin tests need the admin key: set ADMIN_KEY=ADMK-... to include them.

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const core = await import(join(root, 'server/src/core.js'));
const BASE = (process.env.API_BASE || 'http://127.0.0.1:8787') + '/api';
const toml = readFileSync(join(root, 'server/wrangler.toml'), 'utf8');
const ADMIN = {
  x: /ADMIN_X = "([^"]+)"/.exec(toml)[1], y: /ADMIN_Y = "([^"]+)"/.exec(toml)[1],
  d: String(process.env.ADMIN_KEY || '').replace(/^ADMK-/, '') || null
};
let fails = 0;
const ok = (label, cond, extra) => { if (!cond) fails++; console.log((cond ? 'PASS ' : 'FAIL ') + label + (extra !== undefined ? '  ' + JSON.stringify(extra) : '')); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b64u = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function call(method, path, body, token) {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = 'Bearer ' + token;
  const r = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let data = null; try { data = await r.json(); } catch (e) {}
  return { status: r.status, data };
}
const valueOf = (row) => core.tupleToItem(row.slice(1)).value;
const sum = (rows) => rows.reduce((s, r) => s + valueOf(r), 0);
const me = async (t) => (await call('GET', '/me', null, t)).data;

let adminKey;
async function adminSign(text) {
  if (!adminKey) adminKey = await crypto.subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', x: ADMIN.x, y: ADMIN.y, d: ADMIN.d, ext: true },
    { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  return b64u(new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, adminKey, new TextEncoder().encode(text))));
}
async function giftCode(spec) {
  const body = b64u(Buffer.from(JSON.stringify(Object.assign({ t: 'gift', v: 1, mv: 1, c: 0, i: [], m: '', id: 'g' + Math.random(), ts: Math.floor(Date.now() / 1000), x: 0 }, spec))));
  return 'GIFT.' + body + '.' + await adminSign(body);
}
let nonce = 0;
const signed = async (p) => { const s = JSON.stringify(p); return { p: s, g: await adminSign(s) }; };
const admin = async (p) => call('POST', '/admin', await signed(Object.assign({ ts: Math.floor(Date.now() / 1000), n: 'test-' + Date.now() + '-' + (nonce++) }, p)));

/* ---- accounts ---- */
const A = await call('POST', '/signup', { name: 'alice', password: 'alicepass' });
ok('signup', A.status === 200 && A.data.token && A.data.me.coins === 500, A.status);
const B = await call('POST', '/signup', { name: 'bob', password: 'bobpass1' });
const C = await call('POST', '/signup', { name: 'carol', password: 'carolpass' });
ok('duplicate name refused (any case)', (await call('POST', '/signup', { name: 'ALICE', password: 'whatever' })).status === 409);
ok('bad name refused', (await call('POST', '/signup', { name: 'a!', password: 'whatever' })).status === 400);
ok('short password refused', (await call('POST', '/signup', { name: 'dave', password: '123' })).status === 400);
ok('wrong password', (await call('POST', '/login', { name: 'alice', password: 'nope-nope' })).status === 401);
ok('unknown user', (await call('POST', '/login', { name: 'nobody', password: 'nope-nope' })).status === 401);
const L = await call('POST', '/login', { name: 'Alice', password: 'alicepass' });
ok('login (name case-insensitive)', L.status === 200 && L.data.token !== A.data.token);
let a = A.data.token; const b = B.data.token, c = C.data.token;
ok('no token -> 401', (await call('GET', '/me')).status === 401);
ok('garbage token -> 401', (await call('GET', '/me', null, 'x'.repeat(43))).status === 401);
for (let i = 0; i < 5; i++) await call('POST', '/login', { name: 'carol', password: 'wrongwrong' });
ok('5 wrong passwords -> locked', (await call('POST', '/login', { name: 'carol', password: 'carolpass' })).status === 429);

/* ---- cases ---- */
let r = await call('POST', '/open', { case_id: 'starter', count: 5 }, a);
ok('open x5', r.status === 200 && r.data.items.length === 5 && r.data.me.coins === 375 && r.data.me.opened === 5, r.data.me);
ok('pulls come from the case', r.data.items.every((row) => core.CASES.find((c) => c.id === 'starter').items.some((it) => it.name === core.ALL_ITEMS[row[1]].name)));
ok('inventory value matches items', r.data.me.inv_value === sum(r.data.items.concat(r.data.bonus)));
ok('best drop tracked', r.data.me.best_value === Math.max(...r.data.items.map(valueOf)));
r = await call('POST', '/open', { case_id: 'pocket', count: 2 }, a);
ok('a newer case opens too', r.status === 200 && r.data.items.every((row) => core.ALL_ITEMS[row[1]].since >= 2), r.status);
ok('unknown case refused', (await call('POST', '/open', { case_id: 'nope' }, a)).status === 400);
ok('cannot afford', (await call('POST', '/open', { case_id: 'vanguard' }, a)).status === 409);
r = await call('POST', '/open', { case_id: 'scrap' }, b);
ok('free case', r.status === 200 && r.data.me.coins === 500);
ok('free case cooldown', (await call('POST', '/open', { case_id: 'scrap' }, b)).status === 429);
await sleep(3100);
ok('free case after cooldown', (await call('POST', '/open', { case_id: 'scrap', count: 5 }, b)).status === 200);
await call('POST', '/open', { case_id: 'starter', count: 5 }, b);

// Racing purchases can never overdraw.
const poor = (await call('POST', '/signup', { name: 'poor', password: 'poorpass' })).data.token;
const burst = await Promise.all(Array.from({ length: 8 }, () => call('POST', '/open', { case_id: 'neon' }, poor)));   // 420 each, 500 coins
const pm = await me(poor);
ok('parallel purchases never overdraw', burst.filter((x) => x.status === 200).length === 1 && pm.me.coins === 80,
  { ok: burst.filter((x) => x.status === 200).length, coins: pm.me.coins });

/* ---- selling ---- */
let inv = (await me(a)).inventory;
const before = (await me(a)).me.coins;
r = await call('POST', '/sell', { ids: [inv[0][0], inv[1][0]] }, a);
ok('sell pays exact value', r.data.me.coins === before + valueOf(inv[0]) + valueOf(inv[1]), [before, r.data.me.coins]);
r = await call('POST', '/sell', { ids: [inv[0][0]] }, a);
ok('selling twice pays nothing', r.data.removed.length === 0 && r.data.me.coins === before + valueOf(inv[0]) + valueOf(inv[1]));
const bInv = (await me(b)).inventory;
r = await call('POST', '/sell', { ids: [bInv[0][0]] }, a);
ok('cannot sell someone else\'s item', r.data.removed.length === 0 && (await me(b)).inventory.length === bInv.length);

/* ---- upgrader ---- */
inv = (await me(a)).inventory;
r = await call('POST', '/upgrade', { ids: [inv[0][0]], mult: 2 }, a);
const after = (await me(a)).inventory;
ok('upgrade resolves', r.status === 200 && typeof r.data.won === 'boolean' && r.data.chance > 0 && r.data.chance <= 0.9, r.data && { won: r.data.won, chance: r.data.chance });
ok('stake consumed', !after.some((x) => x[0] === inv[0][0]) && after.length === inv.length - 1 + (r.data.won ? 1 : 0));
if (r.data.won) ok('won the quoted target', core.ALL_ITEMS[r.data.item[1]].name === core.ALL_ITEMS[r.data.target].name);
ok('upgrade with a gone item refused', (await call('POST', '/upgrade', { ids: [inv[0][0]], mult: 2 }, a)).status === 409);

/* ---- trades ---- */
inv = (await me(a)).inventory;
let binv = (await me(b)).inventory;
const aCoins = (await me(a)).me.coins, bCoins = (await me(b)).me.coins;
r = await call('POST', '/offers', { to: B.data.me.id, give: [inv[0][0]], give_coins: 10, want: [binv[0][0]], want_coins: 5, message: 'deal?' }, a);
ok('offer created', r.status === 200 && r.data.me.coins === aCoins - 10, r.data);
const offerId = r.data.id;
ok('offered item is locked away', !(await me(a)).inventory.some((x) => x[0] === inv[0][0]));
ok('locked item cannot be sold', (await call('POST', '/sell', { ids: [inv[0][0]] }, a)).data.removed.length === 0);
ok('sender cannot accept', (await call('POST', '/offers/' + offerId + '/accept', null, a)).status === 403);
ok('stranger cannot see it', (await call('POST', '/offers/' + offerId + '/accept', null, c)).status === 404);
const list = (await call('GET', '/offers', null, b)).data.offers;
ok('bob sees the offer', list.length === 1 && list[0].message === 'deal?' && list[0].give[0][0] === inv[0][0]);
r = await call('POST', '/offers/' + offerId + '/accept', null, b);
ok('bob accepts', r.status === 200, r.data);
const aAfter = await me(a), bAfter = await me(b);
ok('items swapped', bAfter.inventory.some((x) => x[0] === inv[0][0]) && aAfter.inventory.some((x) => x[0] === binv[0][0]));
ok('coins settled', aAfter.me.coins === aCoins - 10 + 5 && bAfter.me.coins === bCoins + 10 - 5, [aAfter.me.coins, bAfter.me.coins]);
ok('accept is one-shot', (await call('POST', '/offers/' + offerId + '/accept', null, b)).status === 409);

inv = aAfter.inventory;
const c0 = aAfter.me.coins;
r = await call('POST', '/offers', { to: B.data.me.id, give: [inv[0][0]], give_coins: 7 }, a);
await call('POST', '/offers/' + r.data.id + '/cancel', null, a);
let m = await me(a);
ok('cancel refunds item and coins', m.me.coins === c0 && m.inventory.some((x) => x[0] === inv[0][0]));
r = await call('POST', '/offers', { to: B.data.me.id, give: [inv[0][0]], give_coins: 3 }, a);
await call('POST', '/offers/' + r.data.id + '/decline', null, b);
m = await me(a);
ok('decline refunds item and coins', m.me.coins === c0 && m.inventory.some((x) => x[0] === inv[0][0]));
ok('cancelled offer cannot be accepted', (await call('POST', '/offers/' + r.data.id + '/accept', null, b)).status === 409);
binv = (await me(b)).inventory;
r = await call('POST', '/offers', { to: B.data.me.id, want: [binv[0][0]] }, a);
await call('POST', '/sell', { ids: [binv[0][0]] }, b);
ok('accept after selling the item is refused', (await call('POST', '/offers/' + r.data.id + '/accept', null, b)).status === 409);
ok('cannot ask for items they don\'t have', (await call('POST', '/offers', { to: B.data.me.id, want: [inv[0][0]] }, a)).status === 409);
ok('cannot offer more coins than you have', (await call('POST', '/offers', { to: B.data.me.id, give_coins: 1e9 }, a)).status === 409);

/* ---- battles ---- */
const coinsA = (await me(a)).me.coins, coinsB = (await me(b)).me.coins;
const invA = (await me(a)).inventory.length, invB = (await me(b)).inventory.length;
r = await call('POST', '/battles', { case_id: 'starter', rounds: 1, max_players: 2, mode: 'high', version: core.GAME_VERSION }, a);
ok('lobby created, entry paid', r.status === 200 && r.data.status === 'open' && r.data.me.coins === coinsA - 25, r.data);
const lob = r.data.id;
ok('second open lobby refused', (await call('POST', '/battles', { case_id: 'starter', rounds: 1, max_players: 2, mode: 'high', version: core.GAME_VERSION }, a)).status === 409);
ok('listed', (await call('GET', '/battles')).data.battles.some((x) => x.id === lob));
ok('seed hidden while open', (await call('GET', '/battles/' + lob)).data.seed === null);
ok('old version cannot join', (await call('POST', '/battles/' + lob + '/join', { version: 0 }, b)).status === 409);
r = await call('POST', '/battles/' + lob + '/join', { version: core.GAME_VERSION }, b);
ok('join fills it and starts', r.status === 200 && r.data.status === 'running' && r.data.seed && r.data.start_at > Date.now(), r.data.status);
const plan = core.computeBattle(core.CASES.find((c) => c.id === 'starter'), 1, 2, 'high', core.seededRng(core.hashString(r.data.seed + '|' + lob)));
const winnerIsA = plan.winner === 0;
const ma = await me(a), mb = await me(b);
ok('winner got both pulls, loser nothing', winnerIsA ? (ma.inventory.length === invA + 2 && mb.inventory.length === invB)
  : (mb.inventory.length === invB + 2 && ma.inventory.length === invA), { winner: plan.winner });
const wonRows = (winnerIsA ? ma : mb).inventory.slice(-2).map((x) => core.ALL_ITEMS[x[1]].name + '/' + x[3]).sort();
const planRows = plan.pulls.flat().map((it) => it.name + '/' + core.itemTuple(it)[2]).sort();
ok('server paid exactly what the seed rolls', JSON.stringify(wonRows) === JSON.stringify(planRows), { wonRows, planRows });
ok('entry charged to both', ma.me.coins === coinsA - 25 && mb.me.coins === coinsB - 25);

r = await call('POST', '/battles', { case_id: 'starter', rounds: 2, max_players: 3, mode: 'low', version: core.GAME_VERSION }, a);
const l2 = r.data.id;
const cc = (await me(c)).me.coins;
const race = await Promise.all([call('POST', '/battles/' + l2 + '/join', { version: core.GAME_VERSION }, b), call('POST', '/battles/' + l2 + '/join', { version: core.GAME_VERSION }, poor)]);
ok('both joiners seated (3 seats)', race.every((x) => x.status === 200), race.map((x) => x.status));
ok('it started once full', (await call('GET', '/battles/' + l2)).data.status === 'running');

r = await call('POST', '/battles', { case_id: 'starter', rounds: 1, max_players: 4, mode: 'high', version: core.GAME_VERSION }, a);
const l3 = r.data.id, a3 = r.data.me.coins;
await call('POST', '/battles/' + l3 + '/join', { version: core.GAME_VERSION }, b);
const b3 = (await me(b)).me.coins;
await call('POST', '/battles/' + l3 + '/leave', {}, b);
ok('leaving refunds', (await me(b)).me.coins === b3 + 25);
await call('POST', '/battles/' + l3 + '/join', { version: core.GAME_VERSION }, b);
await call('POST', '/battles/' + l3 + '/leave', {}, a);
ok('creator leaving cancels and refunds everyone', (await call('GET', '/battles/' + l3)).data.status === 'cancelled' &&
  (await me(a)).me.coins === a3 + 25 && (await me(b)).me.coins === b3 + 25);
r = await call('POST', '/battles', { case_id: 'starter', rounds: 1, max_players: 4, mode: 'high', version: core.GAME_VERSION }, a);
r = await call('POST', '/battles/' + r.data.id + '/start', {}, a);
ok('start fills bots', r.data.status === 'running' && r.data.players.filter((p) => p.bot).length === 3);
r = await call('POST', '/battles', { case_id: 'starter', rounds: 2, max_players: 2, mode: 'high', version: core.GAME_VERSION, bots: true }, a);
ok('vs bots runs immediately', r.status === 200 && r.data.status === 'running' && r.data.seed, r.data.status);

if (ADMIN.d) {
/* ---- gifts ---- */
const kIdx = core.ITEM_INDEX['Vault Key'], cIdx = core.ITEM_INDEX['Vault Case'];
const code = await giftCode({ c: 1000, i: [[kIdx, 0, 0, 0], [cIdx, 0, 0, 0], [cIdx, 0, 0, 0]], m: 'hi' });
const g0 = (await me(c)).me.coins;
r = await call('POST', '/gift', { code }, c);
ok('gift claimed', r.status === 200 && r.data.me.coins === g0 + 1000 && r.data.items.length === 3 && r.data.message === 'hi', r.data);
ok('gift cannot be claimed twice', (await call('POST', '/gift', { code }, c)).status === 409);
ok('another player can claim it', (await call('POST', '/gift', { code }, b)).status === 200);
const parts = code.split('.');
const forged = 'GIFT.' + b64u(Buffer.from(Buffer.from(parts[1], 'base64').toString().replace('"c":1000', '"c":9999999'))) + '.' + parts[2];
ok('edited gift refused', (await call('POST', '/gift', { code: forged }, a)).status === 400);
ok('expired gift refused', (await call('POST', '/gift', { code: await giftCode({ c: 5, x: 1000 }) }, a)).status === 410);

/* ---- vault ---- */
r = await call('POST', '/open', { case_id: 'vault', count: 5 }, c);
ok('vault opens once per key+case pair', r.status === 200 && r.data.items.length === 1 && r.data.removed.length === 2, r.data && r.data.removed);
ok('no more keys', (await call('POST', '/open', { case_id: 'vault' }, c)).status === 409);

} else console.log('SKIP gifts and vault (no ADMIN_KEY)');

/* ---- leaderboard ---- */
let lb = (await call('GET', '/leaderboard?sort=opened')).data.players;
ok('leaderboard sorted by cases', lb.length >= 3 && lb.every((p, i) => i === 0 || lb[i - 1].opened >= p.opened), lb.map((p) => p.name + ':' + p.opened));
ok('sort cannot inject', (await call('GET', '/leaderboard?sort=' + encodeURIComponent('x; DROP TABLE accounts'))).status === 200);
r = await call('POST', '/ping', null, a);
await sleep(1100);
r = await call('POST', '/ping', null, a);
ok('ping counts played time', r.data.me.played >= 1, r.data.me.played);

if (ADMIN.d) {
/* ---- admin ---- */
ok('forged admin refused', (await call('POST', '/admin', { p: JSON.stringify({ a: 'ban', id: 'bob', ts: Math.floor(Date.now() / 1000) }), g: 'AAAA' })).status === 403);
r = await admin({ a: 'ban', id: 'bob' });
ok('admin ban by name', r.status === 200, r.data);
ok('banned session refused', (await call('GET', '/me', null, b)).status === 403);
ok('banned login refused', (await call('POST', '/login', { name: 'bob', password: 'bobpass1' })).status === 403);
lb = (await call('GET', '/leaderboard')).data.players;
ok('banned hidden from board', !lb.some((p) => p.name === 'bob'));
await admin({ a: 'unban', id: 'bob' });
ok('unban', (await call('POST', '/login', { name: 'bob', password: 'bobpass1' })).status === 200);
r = await admin({ a: 'reset', id: 'alice', password: 'newpass99' });
ok('password reset', r.status === 200 && (await call('GET', '/me', null, a)).status === 401 &&
  (await call('POST', '/login', { name: 'alice', password: 'newpass99' })).status === 200);
r = await call('POST', '/logout', null, (a = (await call('POST', '/login', { name: 'alice', password: 'newpass99' })).data.token));
ok('logout ends the session', (await call('GET', '/me', null, a)).status === 401);

/* ---- admin toolkit ---- */
const login = async (n, pw) => (await call('POST', '/login', { name: n, password: pw })).data.token;
const now = () => Math.floor(Date.now() / 1000);
const once = await signed({ a: 'stats', n: 'replay-check-1', ts: now() });
ok('a signed request works once', (await call('POST', '/admin', once)).status === 200 && (await call('POST', '/admin', once)).status === 409);
ok('request without an id refused', (await call('POST', '/admin', await signed({ a: 'stats', ts: now() }))).status === 400);
ok('old request refused', (await call('POST', '/admin', await signed({ a: 'stats', n: 'old-one-123', ts: now() - 600 }))).status === 400);
ok('unknown action refused', (await admin({ a: 'toString' })).status === 400);
r = await admin({ a: 'stats' });
ok('stats', r.status === 200 && r.data.totals.accounts >= 4 && r.data.richest.length > 0, r.data.totals);
r = await admin({ a: 'find', q: 'bo' });
ok('find players', r.data.players.some((p) => p.name === 'bob'));
let bt = await login('bob', 'bobpass1');
r = await admin({ a: 'player', id: 'bob' });
ok('inspect a player', r.data.name === 'bob' && Array.isArray(r.data.items) && r.data.sessions >= 1 && Array.isArray(r.data.offers));
const coinsOf = async (n) => (await admin({ a: 'player', id: n })).data.coins;
const c0b = await coinsOf('bob');
await admin({ a: 'coins', id: 'bob', delta: 250 });
ok('give coins', await coinsOf('bob') === c0b + 250);
await admin({ a: 'coins', id: 'bob', delta: -1e9 });
ok('taking coins stops at zero', await coinsOf('bob') === 0);
await admin({ a: 'coins', id: 'bob', set: 1234 });
ok('set coins', await coinsOf('bob') === 1234);
const akIdx = core.ITEM_INDEX['KR-74 | Bramble'], stickerIdx = core.ITEM_INDEX['Sticker | Paper Crane'];
const n0 = (await me(bt)).inventory.length;
r = await admin({ a: 'give', id: 'bob', idx: akIdx, wear: 1, tracker: 1, count: 3 });
let bobInvNow = (await me(bt)).inventory;
const given = bobInvNow.filter((x) => x[1] === akIdx && x[2] === 1 && x[4] === 1);
ok('give items with wear and tracker', r.status === 200 && bobInvNow.length === n0 + 3 && given.length >= 3);
ok('stickers get no wear', (await admin({ a: 'give', id: 'bob', idx: stickerIdx, wear: 3 })).status === 200 &&
  (await me(bt)).inventory.some((x) => x[1] === stickerIdx && x[2] === 0));
ok('bad item refused', (await admin({ a: 'give', id: 'bob', idx: 99999 })).status === 400);
r = await admin({ a: 'take', id: 'bob', ids: given.map((x) => x[0]) });
ok('remove items', r.data.removed === given.length && !(await me(bt)).inventory.some((x) => given.some((g) => g[0] === x[0])));
await admin({ a: 'rename', id: 'bob', name: 'bobby' });
ok('rename', !!(await login('bobby', 'bobpass1')));
ok('rename to a taken name refused', (await admin({ a: 'rename', id: 'bobby', name: 'alice' })).status === 409);
await admin({ a: 'rename', id: 'bobby', name: 'bob' });
await admin({ a: 'ban', id: 'bob', reason: 'spamming trades' });
r = await call('POST', '/login', { name: 'bob', password: 'bobpass1' });
ok('ban shows the reason', r.status === 403 && r.data.reason === 'spamming trades', r.data);
await admin({ a: 'unban', id: 'bob' });
bt = await login('bob', 'bobpass1');
await admin({ a: 'logout', id: 'bob' });
ok('force log out', (await call('GET', '/me', null, bt)).status === 401);
bt = await login('bob', 'bobpass1');
let at = await login('alice', 'newpass99');

await admin({ a: 'settings', maintenance: true, announcement: 'Double drops this weekend!' });
let cfg = (await call('GET', '/config')).data;
ok('announcement and maintenance published', cfg.maintenance === true && cfg.announcement === 'Double drops this weekend!', cfg);
r = await call('POST', '/open', { case_id: 'starter' }, at);
ok('maintenance pauses actions', r.status === 503, r.status);
ok('players can still log in during maintenance', !!(await login('alice', 'newpass99')));
await admin({ a: 'settings', maintenance: false, announcement: '' });
cfg = (await call('GET', '/config')).data;
ok('maintenance off, announcement cleared', cfg.maintenance === false && cfg.announcement === '');
ok('actions work again', (await call('POST', '/open', { case_id: 'starter' }, at)).status === 200);

let ainv = (await me(at)).inventory, ac0 = (await me(at)).me.coins;
r = await call('POST', '/offers', { to: (await me(bt)).me.id, give: [ainv[0][0]], give_coins: 20 }, at);
const offerId2 = r.data.id;
r = await admin({ a: 'offers' });
ok('list open offers', r.data.offers.some((o) => o.id === offerId2 && o.from_name === 'alice'));
await admin({ a: 'cancel_offer', offer: offerId2 });
let am = await me(at);
ok('admin cancels an offer and refunds it', am.me.coins === ac0 && am.inventory.some((x) => x[0] === ainv[0][0]));
r = await call('POST', '/battles', { case_id: 'starter', rounds: 1, max_players: 3, mode: 'high', version: core.GAME_VERSION }, at);
const lob3 = r.data.id;
ok('list open battles', (await admin({ a: 'lobbies' })).data.lobbies.some((l) => l.id === lob3));
await admin({ a: 'cancel_lobby', lobby: lob3 });
ok('admin cancels a battle and refunds it', (await me(at)).me.coins === ac0 && (await call('GET', '/battles/' + lob3)).data.status === 'cancelled');

const g2 = await giftCode({ c: 50, id: 'revoke-test' });
await admin({ a: 'revoke_gift', gift: 'revoke-test' });
ok('cancelled gift refused', (await call('POST', '/gift', { code: g2 }, at)).status === 410);
await admin({ a: 'revoke_gift', gift: 'revoke-test', undo: true });
ok('reinstated gift works', (await call('POST', '/gift', { code: g2 }, at)).status === 200);
r = await admin({ a: 'gifts', gifts: ['revoke-test', 'nothing'] });
ok('gift claim counts', r.data.gifts['revoke-test'].claims === 1 && r.data.gifts.nothing.claims === 0);

const tt = (await call('POST', '/signup', { name: 'tempuser', password: 'temppass' })).data.token;
await call('POST', '/open', { case_id: 'starter', count: 2 }, tt);
const bc1 = (await me(bt)).me.coins;
await call('POST', '/offers', { to: (await me(tt)).me.id, give_coins: 100 }, bt);
ok('bob\'s offer holds 100 coins', (await me(bt)).me.coins === bc1 - 100);
ok('delete needs the name typed', (await admin({ a: 'delete', id: 'tempuser', confirm: 'nope' })).status === 400);
r = await admin({ a: 'delete', id: 'tempuser', confirm: 'tempuser' });
ok('delete an account', r.status === 200 && (await call('POST', '/login', { name: 'tempuser', password: 'temppass' })).status === 401);
ok('open trades with it are refunded', (await me(bt)).me.coins === bc1);

r = await admin({ a: 'log' });
ok('admin log records changes', r.data.entries.length >= 15 && r.data.entries.some((l) => l.action === 'coins' && l.target === 'bob'), r.data.entries.length);

// players managing their own account
const at2 = await login('alice', 'newpass99');
ok('change password needs the current one', (await call('POST', '/account/password', { old: 'wrong-one', password: 'brandnew1' }, at)).status === 400);
ok('change password', (await call('POST', '/account/password', { old: 'newpass99', password: 'brandnew1' }, at)).status === 200);
ok('other devices logged out, this one kept', (await call('GET', '/me', null, at2)).status === 401 && (await call('GET', '/me', null, at)).status === 200);
ok('new password works', !!(await login('alice', 'brandnew1')));
await call('POST', '/account/logout-all', null, at);
ok('log out everywhere', (await call('GET', '/me', null, at)).status === 401);
await admin({ a: 'reset', id: 'alice', password: 'newpass99' });

} else console.log('SKIP moderation (no ADMIN_KEY)');

/* ---- consistency ---- */
const all = [];
for (const [n, p] of [['alice', ADMIN.d ? 'newpass99' : 'alicepass'], ['bob', 'bobpass1'], ['poor', 'poorpass']]) {
  const t = (await call('POST', '/login', { name: n, password: p })).data.token;
  const d = await me(t);
  all.push(d.me.inv_value === sum(d.inventory) || d.me.inv_value > sum(d.inventory));
}
ok('inv_value matches items for everyone', all.every(Boolean));
console.log(fails ? fails + ' FAILED' : 'ALL PASSED');
process.exit(fails ? 1 : 0);
