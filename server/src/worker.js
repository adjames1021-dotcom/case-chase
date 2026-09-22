/*
  Case Opening Sim — online server.

  A small Cloudflare Worker with a D1 database. It stores players, a trade
  inbox and battle lobbies, and serves the global leaderboard. It does not
  run game logic: each player's game rolls its own cases and keeps its own
  inventory. For battles the server only hands out a random seed and a start
  time, and every player's game derives the same rolls from that seed.

  Security is deliberately light. A player is identified by a random token
  issued at registration, which stops casual impersonation, but a player can
  still edit their own save. That's the intended trade-off for a game among
  friends; moving rolls and inventories onto the server is the upgrade path.

  Routes (JSON in, JSON out; send the token as "Authorization: Bearer <token>")
    POST /api/register                 { name } -> { id, name, token }
    POST /api/stats              auth  { played, opened, best_value, best_item, inv_value, inventory }
    GET  /api/leaderboard              ?sort=value|best|opened|played&limit=1..200
    GET  /api/players                  ?q=name   (search, for picking a trade partner)
    GET  /api/players/:id              public profile and inventory
    POST /api/trades             auth  { to, give:{items,coins}, want:{items,coins}, message }
    GET  /api/trades             auth  your recent trades, both directions
    POST /api/trades/:id/:action auth  accept | decline | cancel | settle
    POST /api/battles            auth  { case_id, rounds, max_players, mode, version }
    GET  /api/battles                  open lobbies
    GET  /api/battles/:id              one battle
    POST /api/battles/:id/:action auth join | leave | start
    POST /api/admin                    moderation, signed with the game's admin key
*/

const NAME_RE = /^[A-Za-z0-9_-]{3,16}$/;
const ECDSA = { name: 'ECDSA', namedCurve: 'P-256' };
const SIGN = { name: 'ECDSA', hash: 'SHA-256' };
const SORT_COLUMNS = { value: 'inv_value', best: 'best_value', opened: 'opened', played: 'played' };

const STATS_INTERVAL = 10;          // s between accepted stats updates per player
const LOBBY_TTL = 15 * 60;          // s an unfilled battle lobby stays open
const START_DELAY_MS = 4000;        // lead time so every player starts the battle together
const MAX_PENDING_TRADES = 20;      // outgoing pending offers per player
const MAX_TRADE_ITEMS = 20;
const MAX_INVENTORY = 500;
const MAX_BODY = 64 * 1024;
const MAX_COINS = 1e12;

const utf8 = new TextEncoder();
const nowS = () => Math.floor(Date.now() / 1000);

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

async function hashToken(token) {
  return b64u(new Uint8Array(await crypto.subtle.digest('SHA-256', utf8.encode('token:' + token))));
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400'
};

function json(data, status, extra) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: Object.assign({ 'Content-Type': 'application/json' }, CORS, extra || {})
  });
}

const fail = (status, error) => json({ error: error }, status);

async function body(request) {
  const text = await request.text();
  if (text.length > MAX_BODY) throw new Error('too large');
  return text ? JSON.parse(text) : {};
}

const isInt = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;

// An item as the game sends it: [uid, table index, wear 0-5, float x10000, tracker 0/1]
const validItem = (t) => Array.isArray(t) && t.length === 5 &&
  isInt(t[0], 0, 1e12) && isInt(t[1], 0, 9999) && isInt(t[2], 0, 5) && isInt(t[3], 0, 10000) && isInt(t[4], 0, 1);

function validBundle(b, maxItems) {
  if (!b || typeof b !== 'object') return { items: [], coins: 0 };
  const items = Array.isArray(b.items) ? b.items : [];
  const coins = b.coins == null ? 0 : b.coins;
  if (items.length > maxItems || !items.every(validItem) || !isInt(coins, 0, MAX_COINS)) return null;
  return { items: items, coins: coins };
}

async function authed(request, env) {
  const m = /^Bearer ([A-Za-z0-9_-]{20,64})$/.exec(request.headers.get('Authorization') || '');
  if (!m) return null;
  const p = await env.DB.prepare('SELECT id, name, banned, last_seen FROM players WHERE token_hash = ?')
    .bind(await hashToken(m[1])).first();
  if (!p) return null;
  if (p.banned) return { banned: true };
  const t = nowS();
  if (t - p.last_seen > 60) {           // one write a minute is plenty for "online" dots
    await env.DB.prepare('UPDATE players SET last_seen = ? WHERE id = ?').bind(t, p.id).run();
  }
  return p;
}

/* ---------- players ---------- */

async function register(request, env) {
  const b = await body(request);
  const name = String(b.name || '').trim();
  if (!NAME_RE.test(name)) return fail(400, 'bad name');
  const id = randomId(9), token = randomId(24), t = nowS();
  await env.DB.prepare(
    'INSERT INTO players (id, name, name_lower, token_hash, created_at, last_seen) VALUES (?, ?, ?, ?, ?, ?)'
  ).bind(id, name, name.toLowerCase(), await hashToken(token), t, t).run();
  return json({ id: id, name: name, token: token });
}

async function stats(request, env, me) {
  const b = await body(request);
  const nums = [b.played, b.opened, b.best_value, b.inv_value];
  if (!nums.every((v) => isInt(v, 0, 1e13)) || !isInt(b.best_item, -1, 9999)) return fail(400, 'bad stats');
  const inv = Array.isArray(b.inventory) ? b.inventory : [];
  if (inv.length > MAX_INVENTORY || !inv.every(validItem)) return fail(400, 'bad inventory');

  const row = await env.DB.prepare('SELECT stats_at FROM players WHERE id = ?').bind(me.id).first();
  const t = nowS();
  if (row && t - row.stats_at < STATS_INTERVAL) return fail(429, 'slow down');
  await env.DB.prepare(
    `UPDATE players SET played = ?, opened = ?, best_value = ?, best_item = ?, inv_value = ?,
       inventory = ?, stats_at = ?, last_seen = ? WHERE id = ?`
  ).bind(b.played, b.opened, b.best_value, b.best_item, b.inv_value, JSON.stringify(inv), t, t, me.id).run();
  return json({ ok: true });
}

async function leaderboard(url, env) {
  const column = SORT_COLUMNS[url.searchParams.get('sort')] || 'inv_value';   // whitelisted
  const limit = Math.min(200, Math.max(1, parseInt(url.searchParams.get('limit'), 10) || 100));
  const { results } = await env.DB.prepare(
    `SELECT id, name, played, opened, best_value, best_item, inv_value, stats_at, last_seen
       FROM players WHERE banned = 0 AND stats_at > 0
      ORDER BY ${column} DESC, stats_at DESC LIMIT ?`
  ).bind(limit).all();
  return json({ players: results, now: nowS() }, 200, { 'Cache-Control': 'public, max-age=10' });
}

async function searchPlayers(url, env) {
  const q = String(url.searchParams.get('q') || '').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 16);
  const stmt = q
    ? env.DB.prepare(`SELECT id, name, last_seen, inv_value FROM players
                       WHERE banned = 0 AND name_lower LIKE ? ORDER BY last_seen DESC LIMIT 20`).bind(q + '%')
    : env.DB.prepare(`SELECT id, name, last_seen, inv_value FROM players
                       WHERE banned = 0 ORDER BY last_seen DESC LIMIT 20`);
  const { results } = await stmt.all();
  return json({ players: results, now: nowS() });
}

async function playerProfile(id, env) {
  const p = await env.DB.prepare(
    `SELECT id, name, last_seen, inv_value, inventory FROM players WHERE id = ? AND banned = 0`
  ).bind(id).first();
  if (!p) return fail(404, 'no such player');
  return json({ id: p.id, name: p.name, last_seen: p.last_seen, inv_value: p.inv_value,
                inventory: JSON.parse(p.inventory || '[]'), now: nowS() });
}

/* ---------- trades ----------
   The sender's game removes the offered items when the offer is made; the
   server holds the description until it resolves. Each side then applies its
   own half and calls "settle", which is what stops either side applying twice. */

async function createTrade(request, env, me) {
  const b = await body(request);
  const give = validBundle(b.give, MAX_TRADE_ITEMS);
  const want = validBundle(b.want, MAX_TRADE_ITEMS);
  if (!give || !want) return fail(400, 'bad offer');
  if (!give.items.length && !give.coins && !want.items.length && !want.coins) return fail(400, 'empty offer');
  if (typeof b.to !== 'string' || b.to === me.id) return fail(400, 'bad recipient');
  const to = await env.DB.prepare('SELECT id FROM players WHERE id = ? AND banned = 0').bind(b.to).first();
  if (!to) return fail(404, 'no such player');
  const pending = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM trades WHERE from_id = ? AND status = 'pending'`).bind(me.id).first();
  if (pending.n >= MAX_PENDING_TRADES) return fail(429, 'too many open offers');

  const id = randomId(9), t = nowS();
  const message = String(b.message || '').slice(0, 120);
  await env.DB.prepare(
    `INSERT INTO trades (id, from_id, to_id, give, want, message, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`
  ).bind(id, me.id, b.to, JSON.stringify(give), JSON.stringify(want), message, t, t).run();
  return json({ ok: true, id: id });
}

async function listTrades(env, me) {
  const { results } = await env.DB.prepare(
    `SELECT t.*, f.name AS from_name, r.name AS to_name
       FROM trades t
       JOIN players f ON f.id = t.from_id
       JOIN players r ON r.id = t.to_id
      WHERE t.from_id = ? OR t.to_id = ?
      ORDER BY t.updated_at DESC LIMIT 60`
  ).bind(me.id, me.id).all();
  return json({
    now: nowS(),
    trades: results.map((r) => ({
      id: r.id, from: r.from_id, from_name: r.from_name, to: r.to_id, to_name: r.to_name,
      give: JSON.parse(r.give), want: JSON.parse(r.want), message: r.message, status: r.status,
      from_settled: !!r.from_settled, to_settled: !!r.to_settled,
      created_at: r.created_at, updated_at: r.updated_at
    }))
  });
}

async function tradeAction(id, action, env, me) {
  const t = nowS();
  const run = (sql, ...args) => env.DB.prepare(sql).bind(...args).run();
  let res;
  if (action === 'accept' || action === 'decline') {
    res = await run(`UPDATE trades SET status = ?, updated_at = ? WHERE id = ? AND to_id = ? AND status = 'pending'`,
      action === 'accept' ? 'accepted' : 'declined', t, id, me.id);
  } else if (action === 'cancel') {
    res = await run(`UPDATE trades SET status = 'cancelled', updated_at = ? WHERE id = ? AND from_id = ? AND status = 'pending'`,
      t, id, me.id);
  } else if (action === 'settle') {
    res = await run(
      `UPDATE trades SET
         from_settled = CASE WHEN from_id = ? THEN 1 ELSE from_settled END,
         to_settled   = CASE WHEN to_id   = ? THEN 1 ELSE to_settled END
       WHERE id = ? AND status != 'pending' AND (from_id = ? OR to_id = ?)`, me.id, me.id, id, me.id, me.id);
  } else {
    return fail(404, 'unknown action');
  }
  if (!res.meta || !res.meta.changes) return fail(409, 'trade is not in that state');
  return json({ ok: true });
}

/* ---------- battles ---------- */

const battleOut = (b) => ({
  id: b.id, creator: b.creator, case_id: b.case_id, rounds: b.rounds, max_players: b.max_players,
  mode: b.mode, version: b.version, players: JSON.parse(b.players), status: b.status,
  seed: b.seed, start_at: b.start_at, created_at: b.created_at, now_ms: Date.now()
});

async function expireLobbies(env) {
  await env.DB.prepare(`UPDATE battles SET status = 'cancelled', updated_at = ?
                         WHERE status = 'open' AND created_at < ?`).bind(nowS(), nowS() - LOBBY_TTL).run();
}

async function createBattle(request, env, me) {
  const b = await body(request);
  if (typeof b.case_id !== 'string' || !/^[a-z0-9_-]{1,24}$/.test(b.case_id)) return fail(400, 'bad case');
  if (!isInt(b.rounds, 1, 10) || !isInt(b.max_players, 2, 4) || !isInt(b.version, 1, 1e6)) return fail(400, 'bad settings');
  if (b.mode !== 'high' && b.mode !== 'low') return fail(400, 'bad mode');

  // One open lobby per creator.
  await env.DB.prepare(`UPDATE battles SET status = 'cancelled', updated_at = ? WHERE creator = ? AND status = 'open'`)
    .bind(nowS(), me.id).run();
  const id = randomId(9), t = nowS();
  await env.DB.prepare(
    `INSERT INTO battles (id, creator, case_id, rounds, max_players, mode, version, players, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`
  ).bind(id, me.id, b.case_id, b.rounds, b.max_players, b.mode, b.version,
         JSON.stringify([{ id: me.id, name: me.name }]), t, t).run();
  return json(battleOut(await env.DB.prepare('SELECT * FROM battles WHERE id = ?').bind(id).first()));
}

async function listBattles(env) {
  await expireLobbies(env);
  const { results } = await env.DB.prepare(
    `SELECT * FROM battles WHERE status = 'open' ORDER BY created_at DESC LIMIT 30`).all();
  return json({ battles: results.map(battleOut), now_ms: Date.now() });
}

async function getBattle(id, env) {
  await expireLobbies(env);
  const b = await env.DB.prepare('SELECT * FROM battles WHERE id = ?').bind(id).first();
  return b ? json(battleOut(b)) : fail(404, 'no such battle');
}

// Read-modify-write guarded by a revision counter, so two joins can't both take the last seat.
async function battleAction(id, action, request, env, me) {
  const req = await body(request);
  for (let attempt = 0; attempt < 3; attempt++) {
    const b = await env.DB.prepare('SELECT * FROM battles WHERE id = ?').bind(id).first();
    if (!b) return fail(404, 'no such battle');
    if (b.status !== 'open') return fail(409, 'battle already ' + b.status);
    const players = JSON.parse(b.players);
    const seated = players.some((p) => p.id === me.id);
    let status = 'open', seed = null, startAt = null;

    if (action === 'join') {
      if (seated) return json(battleOut(b));
      if (req.version !== b.version) return fail(409, 'different game version');
      if (players.length >= b.max_players) return fail(409, 'battle is full');
      players.push({ id: me.id, name: me.name });
    } else if (action === 'leave') {
      if (!seated) return fail(409, 'not in this battle');
      if (b.creator === me.id) status = 'cancelled';
      else players.splice(players.findIndex((p) => p.id === me.id), 1);
    } else if (action === 'start') {
      if (b.creator !== me.id) return fail(403, 'only the creator can start');
      for (let n = 1; players.length < b.max_players; n++) {
        players.push({ id: 'bot:' + n, name: 'Bot ' + n, bot: true });
      }
    } else {
      return fail(404, 'unknown action');
    }

    if (status === 'open' && players.length >= b.max_players) {
      status = 'running';
      seed = randomId(16);
      startAt = Date.now() + START_DELAY_MS;
    }

    const res = await env.DB.prepare(
      `UPDATE battles SET players = ?, status = ?, seed = COALESCE(?, seed), start_at = COALESCE(?, start_at),
              updated_at = ?, rev = rev + 1
        WHERE id = ? AND rev = ? AND status = 'open'`
    ).bind(JSON.stringify(players), status, seed, startAt, nowS(), id, b.rev).run();
    if (res.meta && res.meta.changes) {
      return json(battleOut(await env.DB.prepare('SELECT * FROM battles WHERE id = ?').bind(id).first()));
    }
  }
  return fail(409, 'busy, try again');
}

/* ---------- moderation ----------
   { p: '{"a":"ban"|"unban","id":"...","ts":123}', g: signature from the admin key } */

async function admin(request, env) {
  let b, p;
  try { b = await body(request); p = JSON.parse(b.p); } catch (e) { return fail(400, 'bad request'); }
  let genuine = false;
  try {
    const key = await crypto.subtle.importKey('jwk',
      { kty: 'EC', crv: 'P-256', x: env.ADMIN_X, y: env.ADMIN_Y, ext: true }, ECDSA, false, ['verify']);
    genuine = await crypto.subtle.verify(SIGN, key, unb64u(b.g), utf8.encode(b.p));
  } catch (e) { genuine = false; }
  if (!genuine) return fail(403, 'not admin');
  if (!isInt(p.ts, 0, 1e12) || Math.abs(nowS() - p.ts) > 300) return fail(400, 'expired request');
  if (typeof p.id !== 'string' || (p.a !== 'ban' && p.a !== 'unban')) return fail(400, 'bad request');
  await env.DB.prepare('UPDATE players SET banned = ? WHERE id = ?').bind(p.a === 'ban' ? 1 : 0, p.id).run();
  return json({ ok: true });
}

/* ---------- router ---------- */

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    const url = new URL(request.url);
    const parts = url.pathname.replace(/\/+$/, '').split('/').slice(1);   // ['api', ...]
    const method = request.method;
    try {
      if (!parts.length || parts[0] !== 'api') return json({ ok: true, service: 'case-sim-server' });
      const [, a, b, c] = parts;

      if (method === 'POST' && a === 'register') return await register(request, env);
      if (method === 'GET' && a === 'leaderboard') return await leaderboard(url, env);
      if (method === 'GET' && a === 'players' && !b) return await searchPlayers(url, env);
      if (method === 'GET' && a === 'players' && b) return await playerProfile(b, env);
      if (method === 'GET' && a === 'battles' && !b) return await listBattles(env);
      if (method === 'GET' && a === 'battles' && b) return await getBattle(b, env);
      if (method === 'POST' && a === 'admin') return await admin(request, env);

      const me = await authed(request, env);
      if (!me) return fail(401, 'not signed in');
      if (me.banned) return fail(403, 'banned');
      if (method === 'POST' && a === 'stats') return await stats(request, env, me);
      if (method === 'POST' && a === 'trades' && !b) return await createTrade(request, env, me);
      if (method === 'GET' && a === 'trades') return await listTrades(env, me);
      if (method === 'POST' && a === 'trades' && b && c) return await tradeAction(b, c, env, me);
      if (method === 'POST' && a === 'battles' && !b) return await createBattle(request, env, me);
      if (method === 'POST' && a === 'battles' && b && c) return await battleAction(b, c, request, env, me);
      return fail(404, 'not found');
    } catch (err) {
      return fail(500, 'server error');
    }
  }
};
