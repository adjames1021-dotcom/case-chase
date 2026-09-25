// Server tests: accounts, cases, selling, upgrades, trades, battles, gifts,
// moderation and race conditions, against a local server with an empty
// database. The deploy workflow runs these before anything goes live.
//
// Run with (from the repo root):
//   node scripts/sync-core.mjs
//   npx wrangler d1 execute case-sim --local --file server/schema.sql
//   npx wrangler pages dev --port 8787 &
//   node scripts/api-test.mjs
// Gift and admin tests need the admin key: set ADMIN_KEY=ADMK-... to include them.

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const core = await import(join(root, 'server/core.js'));
const BASE = (process.env.API_BASE || 'http://127.0.0.1:8787') + '/api';
const toml = readFileSync(join(root, 'wrangler.toml'), 'utf8');
const ADMIN = {
  x: /ADMIN_X = "([^"]+)"/.exec(toml)[1], y: /ADMIN_Y = "([^"]+)"/.exec(toml)[1],
  d: String(process.env.ADMIN_KEY || '').replace(/^ADMK-/, '') || null
};
let fails = 0;
const ok = (label, cond, extra) => { if (!cond) fails++; console.log((cond ? 'PASS ' : 'FAIL ') + label + (extra !== undefined ? '  ' + JSON.stringify(extra) : '')); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b64u = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// Each call comes from a made-up network unless `ip` is given, so the
// per-network limits only kick in where a test means them to. (Cloudflare
// sets CF-Connecting-IP itself on the live site; players can't choose it.)
const randomIp = () => '10.' + [0, 0, 0].map(() => Math.floor(Math.random() * 256)).join('.');
// Likewise each call comes from a made-up device unless `device` is given.
const randomDevice = () => 'dev' + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
async function call(method, path, body, token, ip, device) {
  const headers = { 'CF-Connecting-IP': ip || randomIp(), 'X-Device': device || randomDevice(), 'X-Device-FP': 'fp' + (device || 'x').slice(0, 20) };
  if (body) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = 'Bearer ' + token;
  if (path === '/signup' && body && body.challenge === undefined) body = Object.assign(await human(), body);
  const r = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let data = null; try { data = await r.json(); } catch (e) {}
  return { status: r.status, data, retry: r.headers.get('Retry-After') };
}

// Signing up needs a solved sign-up check that's at least 2 seconds old
// (see checkHuman in server/api.js). Solving uses the game's own SHA-256
// code, which also proves the game's answers pass the server's check.
// Checks are fetched and solved in batches, then used one per sign-up.
const page = readFileSync(join(root, 'site/index.html'), 'utf8');
const { sha256Words, zeroBits } = new Function(page.slice(page.indexOf('    const SHA_K = '),
  page.indexOf('    async function solveChallenge')) + '; return { sha256Words, zeroBits };')();
function solve(challenge, bits) {
  for (let n = 0; ; n++) if (zeroBits(sha256Words(challenge + ':' + n.toString(36)), bits)) return n.toString(36);
}
async function humans(count, wait) {
  const got = await Promise.all(Array.from({ length: count }, () => call('GET', '/challenge')));
  const out = got.map((r) => ({ challenge: r.data.challenge, nonce: solve(r.data.challenge, r.data.bits) }));
  if (wait !== false) await sleep(2100);
  return out;
}
let pool = [];
async function human() {
  if (!pool.length) pool = await humans(12);
  return pool.shift();
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
ok('bad name refused', (await call('POST', '/signup', { name: 'a!', password: 'whatever', challenge: '' })).status === 400);
ok('short password refused', (await call('POST', '/signup', { name: 'dave', password: '123', challenge: '' })).status === 400);
ok('wrong password', (await call('POST', '/login', { name: 'alice', password: 'nope-nope' })).status === 401);
ok('unknown user', (await call('POST', '/login', { name: 'nobody', password: 'nope-nope' })).status === 401);
const L = await call('POST', '/login', { name: 'Alice', password: 'alicepass' });
ok('login (name case-insensitive)', L.status === 200 && L.data.token !== A.data.token);
let a = A.data.token; const b = B.data.token, c = C.data.token;
ok('no token -> 401', (await call('GET', '/me')).status === 401);
ok('garbage token -> 401', (await call('GET', '/me', null, 'x'.repeat(43))).status === 401);
for (let i = 0; i < 5; i++) await call('POST', '/login', { name: 'carol', password: 'wrongwrong' });
ok('5 wrong passwords -> locked', (await call('POST', '/login', { name: 'carol', password: 'carolpass' })).status === 429);

/* ---- names ---- */
// (Names are checked before the sign-up check, so these skip it.)
for (const bad of ['Sh1tLord', 'xXfuuuckXx', 'Big_Dick', 'a_s_s']) {
  const rr = await call('POST', '/signup', { name: bad, password: 'whatever1', challenge: '' });
  ok('rude name refused: ' + bad, rr.status === 400 && /allowed/.test(rr.data.error), rr.data);
}
for (const fake of ['L1LBEAN', 'lilbean_fan', 'Adm1n', 'TheModerator']) {
  const rr = await call('POST', '/signup', { name: fake, password: 'whatever1', challenge: '' });
  ok('staff look-alike refused: ' + fake, rr.status === 400 && /reserved/.test(rr.data.error), rr.data);
}
for (const fine of ['classic', 'Grape', 'peacock', 'Sussex']) {
  ok('ordinary name allowed: ' + fine, (await call('POST', '/signup', { name: fine, password: 'whatever1' })).status === 200);
}

/* ---- sign-up checks (bots) ---- */
const botName = () => 'newbie' + Math.floor(Math.random() * 1e6);
const tryJoin = (extra, ip, device) => call('POST', '/signup', Object.assign({ name: botName(), password: 'botpass1' }, extra), null, ip, device);
let rr;
const [h1, h2, h3, h4] = await humans(4);
ok('no sign-up check -> refused', (await tryJoin({ challenge: '', nonce: '' })).status === 400);
ok('hidden field filled in -> refused', (await tryJoin(Object.assign({ website: 'http://spam.example' }, h1))).status === 400);
ok('wrong answer -> refused', (await tryJoin({ challenge: h2.challenge, nonce: 'notit' })).status === 400);
const forged = h3.challenge.replace(/^\d+/, (t) => String(+t - 5));
ok('edited challenge -> refused', (await tryJoin({ challenge: forged, nonce: solve(forged, 18) })).status === 400);
const [quick] = await humans(1, false);
rr = await tryJoin(quick);
ok('too quick -> refused', rr.status === 400 && /quick/.test(rr.data.error), rr.data);
ok('a good check works', (await tryJoin(h4)).status === 200);
rr = await tryJoin(h4);
ok('...once', rr.status === 400 && /already used/.test(rr.data.error), rr.data);
ok('an unused check still works after the others failed', (await tryJoin(h2)).status === 200);
const lots = await humans(21);
const school = '203.0.113.9';
const joined = [];
for (const h of lots) joined.push((await tryJoin(h, school)).status);
ok('20 new accounts an hour per network', joined.slice(0, 20).every((s) => s === 200) && joined[20] === 429, joined.slice(-3));

const noDevice = await fetch(BASE + '/signup', { method: 'POST', headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': randomIp() },
  body: JSON.stringify(Object.assign(await human(), { name: botName(), password: 'botpass1' })) });
ok('sign-up without a device id -> refused', noDevice.status === 400);
const farm = 'device-farm-zzzzzzzzzzzz', farmed = [];
for (let i = 0; i < 6; i++) farmed.push((await tryJoin({}, null, farm)).status);
ok('5 new accounts a day per device', farmed.slice(0, 5).every((s) => s === 200) && farmed[5] === 429, farmed);

/* ---- rate limits ---- */
for (let i = 0; i < 50; i++) await call('POST', '/login', { name: 'nobody' + i, password: 'wrong-pass' }, null, '198.51.100.7');
rr = await call('POST', '/login', { name: 'bob', password: 'bobpass1' }, null, '198.51.100.7');
ok('50 wrong passwords from one network -> that network waits', rr.status === 429 && +rr.retry > 0, rr);
ok('other networks unaffected', (await call('POST', '/login', { name: 'bob', password: 'bobpass1' })).status === 200);
const flood = await Promise.all(Array.from({ length: 500 }, () => call('GET', '/config', null, null, '198.51.100.8')));
ok('flood from one network gets 429s', flood.some((x) => x.status === 429 && +x.retry > 0) && flood.filter((x) => x.status === 200).length >= 300,
  flood.filter((x) => x.status === 429).length);
ok('...while everyone else carries on', (await call('GET', '/config')).status === 200);
const spammer = (await call('POST', '/signup', { name: 'spammer', password: 'spampass' })).data.token;
const burstMe = await Promise.all(Array.from({ length: 120 }, () => call('GET', '/me', null, spammer)));
ok('one account flooding gets 429s', burstMe.some((x) => x.status === 429) && burstMe.filter((x) => x.status === 200).length >= 60,
  burstMe.filter((x) => x.status === 429).length);
const gifter = (await call('POST', '/signup', { name: 'codeguesser', password: 'guesspass' })).data.token;
const guesses = [];
for (let i = 0; i < 31; i++) guesses.push((await call('POST', '/gift', { code: 'GIFT2.guess' + i + 'aaaaaaaaaa' }, gifter)).status);
ok('30 gift codes tried per 10 minutes', guesses.slice(0, 30).every((s) => s === 400) && guesses[30] === 429, guesses.slice(-2));

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
r = await call('POST', '/open', { case_id: 'scrap', count: 5 }, b);
ok('free case: no cooldown, x5 at once', r.status === 200 && r.data.items.length === 5, r.status);
ok('keyed case needs a crate and key', (await call('POST', '/open', { case_id: 'launch' }, b)).status === 409);
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

/* ---- market ---- */
const sellerT = (await call('POST', '/signup', { name: 'seller1', password: 'sellpass' })).data.token;
const buyerT = (await call('POST', '/signup', { name: 'buyer1', password: 'buypass1' })).data.token;
const buyer2T = (await call('POST', '/signup', { name: 'buyer2', password: 'buypass2' })).data.token;
r = await call('POST', '/open', { case_id: 'starter', count: 5 }, sellerT);
const wares = r.data.items;                                   // [id, idx, wear, float, tracker]
const ware = wares[0], wareName = core.ALL_ITEMS[ware[1]].name;
ok('bad price refused', (await call('POST', '/market', { item: ware[0], price: 0 }, sellerT)).status === 400);
ok('can\'t list someone else\'s item', (await call('POST', '/market', { item: ware[0], price: 50 }, buyerT)).status === 409);
r = await call('POST', '/market', { item: ware[0], price: 60 }, sellerT);
ok('list an item', r.status === 200 && r.data.id && !r.data.inventory.some((x) => x[0] === ware[0]), r.data);
const listing1 = r.data.id;
r = await call('GET', '/market?q=' + encodeURIComponent(wareName.slice(0, 5)));
ok('anyone can browse and search', r.status === 200 && r.data.listings.some((l) => l.id === listing1 && l.seller_name === 'seller1' && l.price === 60), r.data);
ok('rarity filter', (await call('GET', '/market?rarity=' + (core.ALL_ITEMS[ware[1]].rarity === 'mythic' ? 'common' : 'mythic'))).data.listings.every((l) => l.id !== listing1));
r = await call('POST', '/sell', { ids: [ware[0]] }, sellerT);
ok('listed item can\'t be sold to the game', r.status !== 200 || r.data.removed.length === 0, r.data);
ok('...or traded', (await call('POST', '/offers', { to: (await me(buyerT)).me.id, give: [ware[0]] }, sellerT)).status !== 200);
ok('can\'t buy your own', (await call('POST', '/market/' + listing1 + '/buy', null, sellerT)).status === 400);
const sellerCoins = (await me(sellerT)).me.coins, buyerCoins = (await me(buyerT)).me.coins;
r = await call('POST', '/market/' + listing1 + '/buy', null, buyerT);
ok('buy', r.status === 200 && r.data.me.coins === buyerCoins - 60 && r.data.inventory.some((x) => x[0] === ware[0]), r.data);
ok('seller gets paid', (await me(sellerT)).me.coins === sellerCoins + 60);
ok('can\'t buy it twice', (await call('POST', '/market/' + listing1 + '/buy', null, buyer2T)).status === 409);
r = await call('POST', '/ping', null, sellerT);
ok('seller is told it sold', r.data.sold.length === 1 && r.data.sold[0].price === 60 && r.data.sold[0].buyer_name === 'buyer1', r.data.sold);
ok('...once', (await call('POST', '/ping', null, sellerT)).data.sold.length === 0);
r = await call('POST', '/market', { item: wares[1][0], price: 40 }, sellerT);
const listing2 = r.data.id;
const buyRace = await Promise.all([call('POST', '/market/' + listing2 + '/buy', null, buyerT), call('POST', '/market/' + listing2 + '/buy', null, buyer2T)]);
ok('two buyers at once: exactly one gets it', buyRace.filter((x) => x.status === 200).length === 1, buyRace.map((x) => x.status));
r = await call('POST', '/market', { item: wares[2][0], price: 1000000 }, sellerT);
const listing3 = r.data.id;
ok('not enough coins', (await call('POST', '/market/' + listing3 + '/buy', null, buyerT)).status === 409);
ok('only the seller can take it down', (await call('POST', '/market/' + listing3 + '/cancel', null, buyerT)).status === 403);
r = await call('POST', '/market/' + listing3 + '/cancel', null, sellerT);
ok('take down: item comes back', r.status === 200 && r.data.inventory.some((x) => x[0] === wares[2][0]));
ok('taken down can\'t be bought', (await call('POST', '/market/' + listing3 + '/buy', null, buyerT)).status === 409);
r = await call('GET', '/market/mine', null, sellerT);
ok('your listings and history', r.data.listings.length === 3 && r.data.listings.filter((l) => l.status === 'sold').length === 2 &&
  r.data.listings.some((l) => l.status === 'cancelled'), r.data.listings.map((l) => l.status));
r = await call('GET', '/market?sort=cheap');
ok('sorts by price', r.data.listings.every((l, i, all) => !i || all[i - 1].price <= l.price));
const sumOf = async (t) => { const d = await me(t); return d.me.inv_value === sum(d.inventory); };
ok('item values add up after trading', (await sumOf(sellerT)) && (await sumOf(buyerT)) && (await sumOf(buyer2T)));

/* ---- suggestions ---- */
ok('guests can read suggestions', (await call('GET', '/suggestions')).status === 200);
ok('posting needs a login', (await call('POST', '/suggestions', { text: 'Add a knife case please' })).status === 401);
ok('too short refused', (await call('POST', '/suggestions', { text: 'hi' }, buyerT)).status === 400);
r = await call('POST', '/suggestions', { text: 'this game is shit, fix it' }, buyerT);
ok('rude suggestion refused', r.status === 400 && /clean/.test(r.data.error), r.data);
r = await call('POST', '/suggestions', { text: 'Add a knife case please' }, buyerT);
ok('post a suggestion', r.status === 200 && r.data.id);
const idea = r.data.id;
r = await call('GET', '/suggestions', null, buyerT);
let mine = r.data.suggestions.find((s) => s.id === idea);
ok('your own counts as a vote', mine && mine.votes === 1 && mine.voted === true && mine.author_name === 'buyer1', mine);
r = await call('POST', '/suggestions/' + idea + '/vote', null, sellerT);
ok('someone else votes', r.data.voted === true && r.data.votes === 2, r.data);
r = await call('POST', '/suggestions/' + idea + '/vote', null, sellerT);
ok('voting again takes it back', r.data.voted === false && r.data.votes === 1, r.data);
ok('guests see no votes as theirs', (await call('GET', '/suggestions')).data.suggestions.every((s) => s.voted === false));
ok('only the author can delete', (await call('POST', '/suggestions/' + idea + '/delete', null, sellerT)).status === 403);
const spam = [];
for (let i = 0; i < 5; i++) spam.push((await call('POST', '/suggestions', { text: 'Idea number ' + i + ' for the game' }, sellerT)).status);
ok('5 suggestions an hour', spam.slice(0, 5).every((s) => s === 200) &&
  (await call('POST', '/suggestions', { text: 'One idea too many for now' }, sellerT)).status === 429, spam);
r = await call('GET', '/suggestions?sort=new');
ok('newest first', r.data.suggestions[0].text === 'Idea number 4 for the game');
ok('author can delete', (await call('POST', '/suggestions/' + r.data.suggestions[0].id + '/delete', null, sellerT)).status === 200);

/* ---- item locks ---- */
const lockT = (await call('POST', '/signup', { name: 'locker', password: 'lockpass' })).data.token;
const pal = await call('POST', '/signup', { name: 'lockpal', password: 'palpass1' });
const palT = pal.data.token, palId = pal.data.me.id;
r = await call('POST', '/open', { case_id: 'starter', count: 5 }, lockT);
const [lk1, lk2, lk3, lk4] = r.data.items.map((row) => row[0]);
r = await call('POST', '/lock', { ids: [lk1, lk2], lock: true }, lockT);
ok('lock items', r.status === 200 && r.data.locks.length === 2 && r.data.locks.indexOf(lk1) >= 0, r.data);
ok('/me says which are locked', (await me(lockT)).locks.length === 2);
ok('can\'t lock someone else\'s', (await call('POST', '/lock', { ids: [lk3], lock: true }, palT)).data.locks.length === 0);
const lockCoins = (await me(lockT)).me.coins;
r = await call('POST', '/sell', { ids: [lk1, lk3] }, lockT);
ok('selling skips locked items', r.status === 200 && r.data.removed.length === 1 && r.data.removed[0] === lk3, r.data.removed);
ok('...and pays only for the rest', r.data.me.coins > lockCoins && (await me(lockT)).inventory.some((x) => x[0] === lk1));
ok('locked items can\'t be staked', (await call('POST', '/upgrade', { ids: [lk1], mult: 2 }, lockT)).status === 409);
ok('...or listed', (await call('POST', '/market', { item: lk1, price: 50 }, lockT)).status === 409);
ok('...or offered', (await call('POST', '/offers', { to: palId, give: [lk1] }, lockT)).status === 409);
ok('...or asked for', (await call('POST', '/offers', { to: (await me(lockT)).me.id, want: [lk2] }, palT)).status === 409);
r = await call('POST', '/lock', { ids: [lk1], lock: false }, lockT);
ok('unlock', r.data.locks.length === 1 && r.data.locks[0] === lk2);
ok('unlocked items sell again', (await call('POST', '/sell', { ids: [lk1] }, lockT)).data.removed.length === 1);
// A lock belongs to the owner: an item offered and then locked moves on without it.
r = await call('POST', '/offers', { to: palId, give: [lk4] }, lockT);
await call('POST', '/lock', { ids: [lk4], lock: true }, lockT);
ok('accepting an offer you locked items for is refused only on your side', (await call('POST', '/offers/' + r.data.id + '/accept', null, palT)).status === 200);
ok('the lock went with the old owner', (await me(lockT)).locks.indexOf(lk4) < 0 && (await me(palT)).locks.indexOf(lk4) < 0 &&
  (await me(palT)).inventory.some((x) => x[0] === lk4));

/* ---- rewards ---- */
r = await call('GET', '/rewards', null, lockT);
ok('default reward track: weekly, 7 days', r.status === 200 && r.data.period === 'week' && r.data.days.length === 7 && r.data.claimed === 0 && r.data.ready, r.data);
const rc = (await me(lockT)).me.coins;
r = await call('POST', '/rewards/claim', null, lockT);
ok('claim day 1', r.status === 200 && r.data.coins === 100 && r.data.me.coins === rc + 100 && r.data.rewards.claimed === 1 && !r.data.rewards.ready, r.data);
r = await call('POST', '/rewards/claim', null, lockT);
ok('once a day', r.status === 409 && /tomorrow/.test(r.data.error), r.data);
ok('heartbeat says nothing to claim', (await call('POST', '/ping', null, lockT)).data.reward_ready === false);
ok('rewards need a login', (await call('GET', '/rewards')).status === 401);
const twice = await Promise.all([call('POST', '/rewards/claim', null, palT), call('POST', '/rewards/claim', null, palT)]);
ok('two claims at once: one wins', twice.filter((x) => x.status === 200).length === 1, twice.map((x) => x.status));

/* ---- battle invites ---- */
const hostT = (await call('POST', '/signup', { name: 'host1', password: 'hostpass' })).data.token;
const g1T = (await call('POST', '/signup', { name: 'guest1', password: 'guestpass' })).data.token;
const g2T = (await call('POST', '/signup', { name: 'guest2', password: 'guestpass' })).data.token;
const lobSpec = (rounds) => ({ case_id: 'starter', rounds: rounds || 1, max_players: 3, mode: 'high', version: core.GAME_VERSION });
ok('invite-only needs an invite', (await call('POST', '/battles', Object.assign(lobSpec(), { private: true }), hostT)).status === 400);
ok('inviting nobody real fails', (await call('POST', '/battles', Object.assign(lobSpec(), { invite: ['nosuchplayer'] }), hostT)).status === 404);
r = await call('POST', '/battles', Object.assign(lobSpec(), { private: true, invite: ['guest1'] }), hostT);
ok('create an invite-only battle', r.status === 200 && r.data.private === true && r.data.invited[0] === 'guest1', r.data);
const pl = r.data.id;
r = await call('POST', '/ping', null, g1T);
ok('invite arrives on the heartbeat', r.data.invites.length === 1 && r.data.invites[0].id === pl && r.data.invites[0].from_name === 'host1', r.data.invites);
ok('...and in /invites', (await call('GET', '/invites', null, g1T)).data.invites.length === 1);
ok('invite-only battles aren\'t listed', !(await call('GET', '/battles')).data.battles.some((x) => x.id === pl));
ok('the battle page says invite-only', (await call('GET', '/battles/' + pl)).data.private === true);
ok('uninvited players can\'t join', (await call('POST', '/battles/' + pl + '/join', { version: core.GAME_VERSION }, g2T)).status === 403);
ok('only players in it can invite', (await call('POST', '/battles/' + pl + '/invite', { to: 'guest2' }, g1T)).status === 403);
r = await call('POST', '/battles/' + pl + '/invite', { to: 'guest2' }, hostT);
ok('invite from the lobby', r.status === 200 && r.data.invited[0] === 'guest2', r.data);
ok('invited player joins', (await call('POST', '/battles/' + pl + '/join', { version: core.GAME_VERSION }, g2T)).status === 200);
ok('joined players see no invite for it', (await call('GET', '/invites', null, g2T)).data.invites.length === 0);
await call('POST', '/battles/' + pl + '/decline', null, g1T);
ok('decline', (await call('GET', '/invites', null, g1T)).data.invites.length === 0);
await call('POST', '/battles/' + pl + '/leave', null, hostT);
r = await call('POST', '/battles', Object.assign(lobSpec(), { invite: ['guest1'] }), hostT);
ok('open battles can have invites too, and stay listed', r.status === 200 && (await call('GET', '/battles')).data.battles.some((x) => x.id === r.data.id));
await call('POST', '/battles/' + r.data.id + '/leave', null, hostT);

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
ok('rename to a rude name refused', (await admin({ a: 'rename', id: 'bob', name: 'Sh1tHead' })).status === 400);
ok('admins may use staff names', (await admin({ a: 'rename', id: 'bob', name: 'Moderator' })).status === 200);
await admin({ a: 'rename', id: 'Moderator', name: 'bob' });
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


// admin accounts: no key needed, but some limits
const acctAdmin = (t, p) => call('POST', '/admin', { p: JSON.stringify(p) }, t);
const mt = (await call('POST', '/signup', { name: 'modguy', password: 'modpass1' })).data.token;
ok('normal players can\'t use admin', (await acctAdmin(mt, { a: 'stats' })).status === 403);
ok('nor with no login at all', (await call('POST', '/admin', { p: JSON.stringify({ a: 'stats' }) })).status === 403);
await admin({ a: 'grant_admin', id: 'modguy' });
ok('/me says admin', (await me(mt)).me.admin === true);
ok('the heartbeat says admin too', (await call('POST', '/ping', null, mt)).data.me.admin === true);
ok('admin account uses tools without the key', (await acctAdmin(mt, { a: 'stats' })).status === 200);
r = await acctAdmin(mt, { a: 'coins', id: 'bob', delta: 5 });
ok('admin account can give coins', r.status === 200);
ok('admin account can\'t make admins', (await acctAdmin(mt, { a: 'grant_admin', id: 'bob' })).status === 403);
const ht = (await call('POST', '/signup', { name: 'helper2', password: 'helppass' })).data.token;
await admin({ a: 'grant_admin', id: 'helper2' });
ok('admin account can\'t ban another admin', (await acctAdmin(mt, { a: 'ban', id: 'helper2', reason: 'x' })).status === 403);
ok('admin account can\'t ban itself', (await acctAdmin(mt, { a: 'ban', id: 'modguy' })).status === 403);
r = await acctAdmin(mt, { a: 'log' });
ok('log says who did it', r.data.entries.some((e) => /^by modguy: /.test(e.detail)));
r = await acctAdmin(mt, { a: 'make_gift', coins: 300, items: [[core.ITEM_INDEX['Sticker | Paper Crane'], 0, 0, 0]], message: 'from mod', ttl: 3600 });
ok('admin account makes a server gift code', r.status === 200 && /^GIFT2\.[A-Za-z0-9_-]{16}$/.test(r.data.code), r.data);
const g2code = r.data.code;
const peek = await call('POST', '/gift', { code: g2code, peek: true }, bt);
ok('peek shows the gift without claiming', peek.status === 200 && peek.data.coins === 300 && peek.data.items.length === 1 && peek.data.claimed === false);
const bc2 = (await me(bt)).me.coins;
r = await call('POST', '/gift', { code: g2code }, bt);
ok('claim a server gift', r.status === 200 && (await me(bt)).me.coins === bc2 + 300 && r.data.items.length === 1);
ok('server gift claimed once per account', (await call('POST', '/gift', { code: g2code }, bt)).status === 409);
ok('bad server gift code refused', (await call('POST', '/gift', { code: 'GIFT2.notarealcode123' }, bt)).status === 400);
await acctAdmin(mt, { a: 'revoke_gift', gift: g2code.slice(6) });
ok('cancelled server gift refused', (await call('POST', '/gift', { code: g2code }, ht)).status === 410);
await admin({ a: 'revoke_admin', id: 'modguy' });
ok('removing admin takes the tools away', (await acctAdmin(mt, { a: 'stats' })).status === 403 && (await me(mt)).me.admin === false);
ok('the heartbeat notices it', (await call('POST', '/ping', null, mt)).data.me.admin === false);


  /* ---- holiday seasons and presents ---- */
  const offSeason = core.CASES.find((c) => c.season && c.shop && core.seasonsOn(new Date(), {}).indexOf(c.season) < 0);
  const holT = (await call('POST', '/signup', { name: 'festive', password: 'festpass' })).data.token;
  await admin({ a: 'coins', id: 'festive', set: 100000 });
  const buy = (case_id, what, count, t) => call('POST', '/shop', { case_id, what, count }, t || holT);
  ok('holiday crate not sold out of season', (await buy(offSeason.id, 'crate', 1)).status === 409);
  r = await buy(offSeason.id, 'key', 2);
  ok('keys sell all year', r.status === 200 && r.data.items.length === 2 && r.data.me.coins === 100000 - 2 * offSeason.shop.key &&
    r.data.items.every((row) => core.ALL_ITEMS[row[1]].name === offSeason.key), r.data);
  ok('shop refuses unknown things', (await buy('starter', 'crate', 1)).status === 400 && (await buy(offSeason.id, 'skin', 1)).status === 400);
  const sw = {}; sw[offSeason.season] = 'on';
  await admin({ a: 'settings', seasons: sw });
  ok('config reports the season on', (await call('GET', '/config')).data.seasons.indexOf(offSeason.season) >= 0);
  r = await buy(offSeason.id, 'crate', 3);
  ok('admin switches a season on: its crates sell', r.status === 200 && r.data.items.length === 3 &&
    r.data.me.coins === 100000 - 2 * offSeason.shop.key - 3 * offSeason.shop.crate, r.status);
  ok('keyed cases are not bought or battled directly', (await call('POST', '/open', { case_id: offSeason.id, count: 1 }, holT)).status === 200 &&
    (await call('POST', '/battles', { case_id: offSeason.id, rounds: 1, max_players: 2, mode: 'high', version: core.GAME_VERSION }, holT)).status === 400);
  sw[offSeason.season] = 'off';
  await admin({ a: 'settings', seasons: sw });
  ok('switched off: no crates sold', (await buy(offSeason.id, 'crate', 1)).status === 409);
  const coinsNow = (await me(holT)).me.coins;
  r = await call('POST', '/open', { case_id: offSeason.id, count: 5 }, holT);
  ok('held crates still open out of season, one key each', r.status === 200 && r.data.items.length === 1 && r.data.removed.length === 2 &&
    r.data.me.coins === coinsNow && r.data.items.every((row) => offSeason.items.some((it) => it.name === core.ALL_ITEMS[row[1]].name)), r.data);
  const spare = (await me(holT)).inventory.filter((x) => core.ALL_ITEMS[x[1]].name === offSeason.crate);
  ok('the spare crate stays, no key left', spare.length === 1 && (await call('POST', '/open', { case_id: offSeason.id }, holT)).status === 409);
  const F = (await call('POST', '/signup', { name: 'crateguy', password: 'cratepass' })).data, friend = F.token;
  r = await call('POST', '/offers', { to: F.me.id, give: [spare[0][0]] }, holT);
  if (r.status === 200) r = await call('POST', '/offers/' + r.data.id + '/accept', null, friend);
  ok('crates can be traded', r.status === 200 && (await me(friend)).inventory.some((x) => x[0] === spare[0][0]), r.data);
  sw[offSeason.season] = 'auto';
  await admin({ a: 'settings', seasons: sw });
  ok('back to the calendar', JSON.stringify((await call('GET', '/config')).data.season_modes) === '{}');
  r = await buy('launch', 'crate', 10);
  ok('launch crates sell all year, up to 10 at once', r.status === 200 && r.data.items.length === 10, r.data);
  ok('...and a bad count buys one', (await buy('launch', 'key', 11)).status === 200 && (await me(holT)).inventory.filter((x) => core.ALL_ITEMS[x[1]].name === 'Launch Key').length === 1);
  const broke = (await call('POST', '/signup', { name: 'brokeguy', password: 'brokepass' })).data.token;
  r = await buy('launch', 'crate', 2, broke);
  ok('no overdraw in the shop', r.status === 409 && (await me(broke)).me.coins === 500, r.data);
  ok('no present, no opening', (await call('POST', '/open', { case_id: 'present' }, holT)).status === 409);
  await admin({ a: 'give', id: 'festive', idx: core.ITEM_INDEX['Frosty Present'], wear: -1, tracker: 0, count: 2 });
  const presentBox = core.CASES.find((c) => c.id === 'present');
  r = await call('POST', '/open', { case_id: 'present', count: 2 }, holT);
  ok('presents open without a key, any time of year', r.status === 200 && r.data.items.length === 2 && r.data.removed.length === 2 &&
    r.data.items.every((row) => presentBox.items.some((it) => it.name === core.ALL_ITEMS[row[1]].name)), r.data);
  ok('...and cost nothing', r.data.me.coins === (await me(holT)).me.coins);

  /* ---- rewards and the login gift (admin) ---- */
  r = await admin({ a: 'rewards' });
  ok('admin reads the reward track', r.status === 200 && r.data.rewards.days.length === 7);
  const presentIdx = core.ITEM_INDEX['Frosty Present'];
  ok('a weekly track has at most 7 days', (await admin({ a: 'rewards', period: 'week', days: Array(8).fill({ coins: 1, items: [] }) })).status === 400);
  ok('bad reward items refused', (await admin({ a: 'rewards', days: [{ coins: 1, items: [[99999, -1, 0]] }] })).status === 400);
  r = await admin({ a: 'rewards', title: 'Winter rewards', period: 'month', days: [{ coins: 5, items: [[presentIdx, -1, 0]] }, { coins: 10, items: [] }, { coins: 15, items: [] }] });
  ok('admin sets a monthly track', r.status === 200 && r.data.rewards.period === 'month' && r.data.rewards.days.length === 3, r.data);
  const rwT = (await call('POST', '/signup', { name: 'rewardee', password: 'rewardpass' })).data.token;
  r = await call('GET', '/rewards', null, rwT);
  ok('players see the new track', r.data.title === 'Winter rewards' && r.data.period === 'month' && r.data.days.length === 3 && r.data.ready, r.data);
  r = await call('POST', '/rewards/claim', null, rwT);
  ok('claim gives coins and items', r.status === 200 && r.data.coins === 5 && r.data.items.length === 1 && r.data.items[0][1] === presentIdx, r.data);
  await admin({ a: 'rewards', on: false });
  ok('rewards switched off', (await call('POST', '/rewards/claim', null, (await call('POST', '/signup', { name: 'latecomer', password: 'latepass' })).data.token)).status === 409);
  await admin({ a: 'rewards', on: true, title: 'Weekly rewards', period: 'week', days: [100, 150, 200, 250, 300, 400, 500].map((c) => ({ coins: c, items: [] })) });

  ok('no login gift yet', (await admin({ a: 'login_gift' })).data.gift === null);
  r = await admin({ a: 'login_gift', coins: 77, items: [[core.ITEM_INDEX['Sticker | Paper Crane'], 0, 0, 0]], message: 'Happy holidays!', ttl: 86400 });
  ok('admin starts a login gift', r.status === 200 && r.data.gift.coins === 77 && r.data.gift.claims === 0, r.data);
  let lg = (await me(rwT)).login_gift;
  ok('players are offered it', lg && lg.coins === 77 && lg.items.length === 1 && lg.message === 'Happy holidays!' && /^GIFT2\./.test(lg.code), lg);
  ok('...on the heartbeat too', !!(await call('POST', '/ping', null, rwT)).data.login_gift);
  const lgc = (await me(rwT)).me.coins;
  r = await call('POST', '/gift', { code: lg.code }, rwT);
  ok('claiming it', r.status === 200 && r.data.me.coins === lgc + 77);
  ok('offered once', (await me(rwT)).login_gift === null && (await admin({ a: 'login_gift' })).data.gift.claims === 1);
  const newT = (await call('POST', '/signup', { name: 'newcomer', password: 'newpass1' })).data;
  ok('new accounts get it at sign-up', newT.login_gift && newT.login_gift.coins === 77);
  await admin({ a: 'login_gift', end: true });
  ok('ending it', (await me(newT.token)).login_gift === null);

  /* ---- locked crates (admin) ---- */
  await admin({ a: 'give', id: 'locker', idx: presentIdx, wear: -1, tracker: 0, count: 1 });
  const pid = (await me(lockT)).inventory.find((x) => x[1] === presentIdx)[0];
  await call('POST', '/lock', { ids: [pid], lock: true }, lockT);
  r = await call('POST', '/open', { case_id: 'present' }, lockT);
  ok('a locked present won\'t open', r.status === 409 && /locked/.test(r.data.error), r.data);
  await call('POST', '/lock', { ids: [pid], lock: false }, lockT);
  ok('unlocked, it opens', (await call('POST', '/open', { case_id: 'present' }, lockT)).status === 200);

  /* ---- market and suggestions (admin) ---- */
  r = await call('POST', '/open', { case_id: 'starter', count: 2 }, sellerT);
  const shelf = (await call('POST', '/market', { item: r.data.items[0][0], price: 30 }, sellerT)).data.id;
  r = await admin({ a: 'listings' });
  ok('admin sees open listings', r.data.listings.some((l) => l.id === shelf));
  await admin({ a: 'ban', id: 'seller1', reason: 'test' });
  ok('banned seller\'s listings are hidden', !(await call('GET', '/market')).data.listings.some((l) => l.id === shelf));
  ok('...and can\'t be bought', (await call('POST', '/market/' + shelf + '/buy', null, buyerT)).status === 409);
  ok('banned author\'s suggestions are hidden', !(await call('GET', '/suggestions')).data.suggestions.some((s) => s.author_name === 'seller1'));
  await admin({ a: 'unban', id: 'seller1' });
  r = await admin({ a: 'cancel_listing', listing: shelf });
  ok('admin takes a listing down', r.status === 200 && (await call('GET', '/market/mine', null, sellerT)).data.listings.find((l) => l.id === shelf).status === 'cancelled');
  r = await admin({ a: 'suggestion', id: idea, status: 'planned', reply: 'Coming soon!' });
  const edited = (await call('GET', '/suggestions')).data.suggestions.find((s) => s.id === idea);
  ok('admin sets status and replies', r.status === 200 && edited.status === 'planned' && edited.reply === 'Coming soon!', edited);
  await admin({ a: 'delete_suggestion', id: idea });
  ok('admin deletes a suggestion', !(await call('GET', '/suggestions')).data.suggestions.some((s) => s.id === idea));
  const shelf2 = (await call('POST', '/market', { item: (await me(sellerT)).inventory[0][0], price: 30 }, sellerT)).data.id;
  const vote2 = (await call('POST', '/suggestions', { text: 'Seller idea to be removed' }, (await call('POST', '/login', { name: 'buyer2', password: 'buypass2' })).data.token)).data.id;
  await call('POST', '/suggestions/' + vote2 + '/vote', null, sellerT);
  const s1 = (await me(sellerT)).me.id;
  await admin({ a: 'delete', id: 'seller1', confirm: 'seller1' });
  ok('deleting an account takes its listings down', !(await call('GET', '/market')).data.listings.some((l) => l.id === shelf2));
  ok('...and its votes', (await call('GET', '/suggestions')).data.suggestions.find((s) => s.id === vote2).votes === 1);

  /* ---- devices ---- */
  const onDevice = (dev, name, pass) => call('POST', '/signup', { name, password: pass || 'devpass1' }, null, null, dev);
  const D1 = 'device-one-aaaaaaaaaaaa', D2 = 'device-two-bbbbbbbbbbbb', D3 = 'device-three-ccccccccccc';
  const d1 = [];
  for (const n of ['botone', 'bottwo', 'botthree']) d1.push((await onDevice(D1, n)).data.me.id);
  r = await admin({ a: 'player', id: 'botone' });
  const devRow = r.data.devices.find((d) => d.kind === 'd');
  ok('player page lists devices', devRow && devRow.others === 2, r.data.devices);
  r = await admin({ a: 'devices' });
  ok('3 accounts on one device get flagged', r.data.flagged.some((g) => g.kind === 'd' && g.value === devRow.value && g.accounts === 3), r.data.flagged.length);
  r = await admin({ a: 'device', kind: 'd', value: devRow.value });
  ok('device page lists its accounts', r.data.accounts.length === 3 && d1.every((id) => r.data.accounts.some((a) => a.id === id)));
  const elsewhere = (await onDevice(D3, 'elsewhere')).data;     // not on D1 yet
  ok('logging in records a new device', (await call('POST', '/login', { name: 'elsewhere', password: 'devpass1' }, null, null, D1)).status === 200);
  r = await admin({ a: 'ban_device', kind: 'd', value: devRow.value, reason: 'bot farm', block: true });
  ok('ban all on a device', r.status === 200 && r.data.count === 4, r.data);
  r = await call('POST', '/login', { name: 'botone', password: 'devpass1' });
  ok('...they are banned', r.status === 403 && r.data.reason === 'bot farm', r.data);
  r = await onDevice(D1, 'botfour');
  ok('blocked device can\'t sign up', r.status === 403 && /blocked/.test(r.data.error), r.data);
  await admin({ a: 'unban', id: 'elsewhere' });
  r = await call('POST', '/login', { name: 'elsewhere', password: 'devpass1' }, null, null, D1);
  ok('blocked device can\'t log in', r.status === 403 && /blocked/.test(r.data.error), r.data);
  ok('same account on another device is fine', (await call('POST', '/login', { name: 'elsewhere', password: 'devpass1' }, null, null, D3)).status === 200);
  await admin({ a: 'unblock_device', kind: 'd', value: devRow.value });
  ok('unblock', (await call('POST', '/login', { name: 'elsewhere', password: 'devpass1' }, null, null, D1)).status === 200);
  // One banned account stops its device making more (ban evasion).
  await onDevice(D2, 'evader1');
  await admin({ a: 'ban', id: 'evader1', reason: 'x' });
  r = await onDevice(D2, 'evader2');
  ok('a device with a banned account can\'t make new ones', r.status === 403 && /banned/.test(r.data.error), r.data);
  // Admins are never swept up.
  const D4 = 'device-four-dddddddddddd';
  await onDevice(D4, 'modhelper'); await onDevice(D4, 'modalt');
  await admin({ a: 'grant_admin', id: 'modhelper' });
  const d4 = (await admin({ a: 'player', id: 'modalt' })).data.devices.find((d) => d.kind === 'd').value;
  r = await admin({ a: 'ban_device', kind: 'd', value: d4, reason: 'test' });
  ok('ban all skips admin accounts', r.data.count === 1 && (await call('POST', '/login', { name: 'modhelper', password: 'devpass1' })).status === 200, r.data);
  ok('delete all needs DELETE typed', (await admin({ a: 'delete_device', kind: 'd', value: d4 })).status === 400);
  r = await admin({ a: 'delete_device', kind: 'd', value: d4, confirm: 'DELETE' });
  ok('delete all on a device (not admins)', r.data.count === 1 && (await admin({ a: 'player', id: 'modalt' })).status === 404 &&
    (await admin({ a: 'player', id: 'modhelper' })).status === 200, r.data);
  r = await admin({ a: 'bad_names', mode: 'ban' });
  ok('ban all rule-breaking names runs', r.status === 200 && r.data.count === 0, r.data);
  ok('stats count rule-breaking names', (await admin({ a: 'stats' })).data.bad_names_total === 0);
  ok('delete all banned needs DELETE typed', (await admin({ a: 'delete_banned' })).status === 400);
  const bannedBefore = (await admin({ a: 'stats' })).data.totals.banned;
  r = await admin({ a: 'delete_banned', confirm: 'DELETE' });
  ok('delete all banned accounts', r.status === 200 && r.data.count === bannedBefore && bannedBefore >= 4 && r.data.left === 0, [bannedBefore, r.data]);
  ok('...they are gone', (await call('POST', '/login', { name: 'botone', password: 'devpass1' })).status === 401 &&
    (await admin({ a: 'stats' })).data.totals.banned === 0);
  ok('...and nobody else', (await call('POST', '/login', { name: 'elsewhere', password: 'devpass1' })).status === 200);
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
