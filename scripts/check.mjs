// Pre-deploy checks. Run with: node scripts/check.mjs
// The deploy workflow runs this first and stops if anything fails, so a
// broken update never reaches the live site.

import { readFileSync, writeFileSync, mkdtempSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildCore } from './sync-core.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const tmp = mkdtempSync(join(tmpdir(), 'case-sim-check-'));
const problems = [];
const fail = (msg) => problems.push(msg);
const pass = (msg) => console.log('ok   ' + msg);

function syntax(label, code, ext) {
  const file = join(tmp, label.replace(/\W+/g, '_') + ext);
  writeFileSync(file, code);
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
    pass(label + ' has no syntax errors');
  } catch (e) {
    fail(label + ' has a syntax error:\n' + String(e.stderr || e.message).trim());
  }
}

/* ---------- the game ---------- */

const html = readFileSync(join(root, 'site/index.html'), 'utf8');
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
if (!scripts.length) fail('site/index.html has no inline script');
scripts.forEach((code, i) => syntax('site/index.html script ' + (i + 1), code, '.js'));

const server = /const SERVER_URL = '([^']*)';/.exec(html);
if (!server) fail('SERVER_URL is missing from site/index.html');
else if (!/^https:\/\/[^\s']+$/.test(server[1])) fail('SERVER_URL must be your https:// server address, not "' + server[1] + '"');
else pass('SERVER_URL points at ' + server[1]);

if (!/const GAME_VERSION = \d+;/.test(html)) fail('GAME_VERSION is missing or not a whole number');
else pass('GAME_VERSION is set');

// Players' saves live under this key. Changing it would wipe every save.
if (!html.includes("const SAVE_KEY = 'case-opening-sim-v2';")) fail("SAVE_KEY changed: that would wipe every player's save");
else pass('SAVE_KEY unchanged, saves are safe');

const size = statSync(join(root, 'site/index.html')).size;
if (size > 20 * 1024 * 1024) fail('site/index.html is over 20 MB');

/* ---------- the shared rules (CORE block) ---------- */

let core = null;
try {
  const coreText = buildCore(html);
  const body = coreText.slice(0, coreText.lastIndexOf('export {'));
  const dom = /\b(document|window|localStorage|state\.|\$\(|\$\$\()/.exec(body);
  if (dom) fail('The CORE block uses page code ("' + dom[1] + '"); the server can\'t run that');
  const file = join(tmp, 'core.mjs');
  writeFileSync(file, coreText);
  core = await import(pathToFileURL(file).href);
  pass('CORE block builds for the server');
} catch (e) {
  fail('CORE block does not build: ' + e.message);
}

if (core) {
  // Saved items point at their position in ALL_ITEMS, so the list may only grow.
  const orderFile = join(root, 'scripts/item-order.json');
  const order = JSON.parse(readFileSync(orderFile, 'utf8'));
  const names = core.ALL_ITEMS.map((it) => it.name), cases = core.CASES.map((c) => c.id);
  if (process.argv.includes('--update-order')) {
    writeFileSync(orderFile, JSON.stringify(Object.assign(order, { items: names, cases: cases }), null, 1) + '\n');
    pass('item order updated');
  }
  const moved = order.items.findIndex((n, i) => names[i] !== n);
  if (moved >= 0) fail('Item #' + moved + ' was "' + order.items[moved] + '" and is now "' + (names[moved] || 'missing') +
    '". Existing items must keep their place, or everyone\'s saved items change. Mark new items with the GAME_VERSION that adds them (fifth value of I(...)) so they go after all older ones.');
  else pass(names.length + ' items in their saved order' + (names.length > order.items.length ? ' (' + (names.length - order.items.length) + ' new at the end)' : ''));
  const gone = order.cases.filter((id) => !cases.includes(id));
  if (gone.length) fail('Case ids removed or renamed: ' + gone.join(', '));
  const worker = readFileSync(join(root, 'server/src/worker.js'), 'utf8');
  const wanted = (/import \{([^}]+)\} from '\.\/core\.js'/.exec(worker) || ['', ''])[1].split(',').map((x) => x.trim()).filter(Boolean);
  const missing = wanted.filter((n) => !(n in core));
  if (missing.length) fail('The server needs these from the CORE block: ' + missing.join(', '));
  const roll = () => JSON.stringify(core.computeBattle(core.CASES[1], 3, 4, 'high', core.seededRng(core.hashString('check'))));
  if (roll() !== roll()) fail('Battles are not repeatable from a seed');
  else pass('battles repeat exactly from a seed');
}

/* ---------- the server ---------- */

syntax('server/src/worker.js', readFileSync(join(root, 'server/src/worker.js'), 'utf8'), '.mjs');

const toml = readFileSync(join(root, 'server/wrangler.toml'), 'utf8');
if (/REPLACE_WITH/.test(toml)) fail('server/wrangler.toml still has a REPLACE_WITH placeholder');

// Bans only work if the server knows the same admin public key as the game.
const gx = /x: '([A-Za-z0-9_-]{43})'/.exec(html), gy = /y: '([A-Za-z0-9_-]{43})'/.exec(html);
const sx = /ADMIN_X = "([^"]+)"/.exec(toml), sy = /ADMIN_Y = "([^"]+)"/.exec(toml);
if (!gx || !gy || !sx || !sy || gx[1] !== sx[1] || gy[1] !== sy[1]) fail('Admin public key in the game and server/wrangler.toml do not match');
else pass('admin public key matches between game and server');

/* ---------- secrets ---------- */

// The admin private key must never be committed.
function walk(dir, out) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git' || name === '.wrangler') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
}
const leaks = walk(root, []).filter((p) => {
  const text = readFileSync(p, 'latin1');
  return /ADMK-[A-Za-z0-9_-]{43}/.test(text) || /"d"\s*:\s*"[A-Za-z0-9_-]{43}"/.test(text);
});
if (leaks.length) fail('Possible admin private key in: ' + leaks.map((p) => p.slice(root.length + 1)).join(', '));
else pass('no admin private key in the repo');

/* ---------- result ---------- */

if (problems.length) {
  console.error('\nFAILED\n- ' + problems.join('\n- '));
  process.exit(1);
}
console.log('\nAll checks passed.');
