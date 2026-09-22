/*
  Case Opening Sim — global leaderboard.

  POST /api/submit       a player's signed stats snapshot (the same entry the
                         game puts in trade codes)
  GET  /api/leaderboard  ?sort=value|best|opened|played&limit=1..200
  POST /api/admin        a moderation request signed with the admin key

  Every snapshot is signed by the player's own key and the player id is a
  hash of that key, so nobody can post as someone else. Players can still
  overstate their own stats by editing their save: the game runs in the
  browser, and only moving the game logic onto a server fixes that.
*/

const NAME_RE = /^[A-Za-z0-9_-]{3,16}$/;
const KEY_RE = /^[A-Za-z0-9_-]{43}$/;
const ECDSA = { name: 'ECDSA', namedCurve: 'P-256' };
const SIGN = { name: 'ECDSA', hash: 'SHA-256' };
const SORT_COLUMNS = { value: 'inv_value', best: 'best_value', opened: 'opened', played: 'played' };
const MIN_INTERVAL = 10;        // seconds between accepted updates from one player
const CLOCK_SKEW = 300;         // how far ahead of our clock a snapshot may be
const MAX_BODY = 4096;

const utf8 = new TextEncoder();

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

async function idForKey(x, y) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', utf8.encode(x + '.' + y)));
  return b64u(digest.slice(0, 8));
}

// Must match entryBody() in the game exactly, or signatures won't verify.
const entryBody = (e) => JSON.stringify([e.n, e.i, e.t, e.s, e.k]);

async function verifyEntry(e) {
  try {
    if (!e || typeof e !== 'object' || !NAME_RE.test(e.n) || typeof e.i !== 'string') return false;
    if (!Number.isInteger(e.t) || e.t <= 0) return false;
    if (!Array.isArray(e.s) || e.s.length !== 5) return false;
    if (e.s.some((v, i) => !Number.isInteger(v) || v < (i === 3 ? -1 : 0) || v > 1e13)) return false;
    if (!Array.isArray(e.k) || e.k.length !== 2 || !e.k.every((v) => KEY_RE.test(v))) return false;
    if (typeof e.g !== 'string') return false;
    if ((await idForKey(e.k[0], e.k[1])) !== e.i) return false;
    const key = await crypto.subtle.importKey('jwk',
      { kty: 'EC', crv: 'P-256', x: e.k[0], y: e.k[1], ext: true }, ECDSA, false, ['verify']);
    return await crypto.subtle.verify(SIGN, key, unb64u(e.g), utf8.encode(entryBody(e)));
  } catch (err) {
    return false;
  }
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400'
};

function json(data, status, extra) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: Object.assign({ 'Content-Type': 'application/json' }, CORS, extra || {})
  });
}

async function readJson(request) {
  const text = await request.text();
  if (text.length > MAX_BODY) throw new Error('too large');
  return JSON.parse(text);
}

async function submit(request, env) {
  let e;
  try { e = await readJson(request); } catch (err) { return json({ error: 'bad request' }, 400); }
  if (!(await verifyEntry(e))) return json({ error: 'bad signature' }, 400);

  const now = Math.floor(Date.now() / 1000);
  if (e.t > now + CLOCK_SKEW) return json({ error: 'clock ahead' }, 400);

  const row = await env.DB.prepare('SELECT t, updated_at, banned FROM players WHERE id = ?').bind(e.i).first();
  if (row) {
    if (row.banned) return json({ ok: true });                       // accepted, quietly ignored
    if (e.t <= row.t) return json({ ok: true, stale: true });        // older than what we hold
    if (now - row.updated_at < MIN_INTERVAL) return json({ error: 'slow down' }, 429);
  }

  await env.DB.prepare(
    `INSERT INTO players (id, name, t, played, opened, best_value, best_item, inv_value, entry, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name, t = excluded.t, played = excluded.played, opened = excluded.opened,
       best_value = excluded.best_value, best_item = excluded.best_item, inv_value = excluded.inv_value,
       entry = excluded.entry, updated_at = excluded.updated_at
     WHERE players.banned = 0 AND excluded.t > players.t`
  ).bind(e.i, e.n, e.t, e.s[0], e.s[1], e.s[2], e.s[3], e.s[4], JSON.stringify(e), now).run();

  return json({ ok: true });
}

async function leaderboard(url, env) {
  const column = SORT_COLUMNS[url.searchParams.get('sort')] || 'inv_value';   // whitelisted, safe to inline
  const limit = Math.min(200, Math.max(1, parseInt(url.searchParams.get('limit'), 10) || 100));
  const { results } = await env.DB.prepare(
    `SELECT id, name, t, played, opened, best_value, best_item, inv_value
       FROM players WHERE banned = 0
      ORDER BY ${column} DESC, t DESC LIMIT ?`
  ).bind(limit).all();
  return json({ players: results, now: Math.floor(Date.now() / 1000) }, 200,
    { 'Cache-Control': 'public, max-age=10' });
}

// Moderation: { p: '{"a":"remove"|"restore","id":"...","ts":123}', g: signature }
async function admin(request, env) {
  let body, payload;
  try {
    body = await readJson(request);
    payload = JSON.parse(body.p);
  } catch (err) { return json({ error: 'bad request' }, 400); }

  let genuine = false;
  try {
    const key = await crypto.subtle.importKey('jwk',
      { kty: 'EC', crv: 'P-256', x: env.ADMIN_X, y: env.ADMIN_Y, ext: true }, ECDSA, false, ['verify']);
    genuine = await crypto.subtle.verify(SIGN, key, unb64u(body.g), utf8.encode(body.p));
  } catch (err) { genuine = false; }
  if (!genuine) return json({ error: 'not admin' }, 403);

  const now = Math.floor(Date.now() / 1000);
  if (!Number.isInteger(payload.ts) || Math.abs(now - payload.ts) > CLOCK_SKEW) {
    return json({ error: 'expired request' }, 400);
  }
  if (typeof payload.id !== 'string' || payload.id.length > 32) return json({ error: 'bad id' }, 400);
  if (payload.a !== 'remove' && payload.a !== 'restore') return json({ error: 'bad action' }, 400);

  const banned = payload.a === 'remove' ? 1 : 0;
  const res = await env.DB.prepare('UPDATE players SET banned = ? WHERE id = ?').bind(banned, payload.id).run();
  if (!res.meta || !res.meta.changes) {
    // Ban ids we haven't seen yet too, so they can't appear later.
    if (banned) {
      await env.DB.prepare(
        `INSERT OR IGNORE INTO players (id, name, t, entry, updated_at, banned) VALUES (?, 'removed', 0, '{}', ?, 1)`
      ).bind(payload.id, now).run();
    }
  }
  return json({ ok: true, action: payload.a, id: payload.id });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    try {
      if (url.pathname === '/api/leaderboard' && request.method === 'GET') return await leaderboard(url, env);
      if (url.pathname === '/api/submit' && request.method === 'POST') return await submit(request, env);
      if (url.pathname === '/api/admin' && request.method === 'POST') return await admin(request, env);
      if (url.pathname === '/') return json({ ok: true, service: 'case-sim-leaderboard' });
      return json({ error: 'not found' }, 404);
    } catch (err) {
      return json({ error: 'server error' }, 500);
    }
  }
};
