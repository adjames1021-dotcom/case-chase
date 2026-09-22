// Pre-deploy checks. Run with: node scripts/check.mjs
// The deploy workflow runs this first and stops if anything fails, so a
// broken update never reaches the live site.

import { readFileSync, writeFileSync, mkdtempSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

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
