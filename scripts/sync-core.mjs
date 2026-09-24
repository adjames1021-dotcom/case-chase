// Builds server/core.js from the CORE block in site/index.html, so the
// server rolls cases, battles and upgrades with exactly the game's rules.
// Run it before `npx wrangler pages dev`; the deploy workflow runs it too.
// The output is generated: edit site/index.html.
//
// Run with: node scripts/sync-core.mjs

import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

export function buildCore(html) {
  const begin = html.indexOf('/* ===== CORE:BEGIN');
  const end = html.indexOf('/* ===== CORE:END');
  if (begin < 0 || end < 0 || end < begin) throw new Error('CORE block not found in site/index.html');
  const body = html.slice(html.indexOf('\n', begin) + 1, html.lastIndexOf('\n', end))
    .replace(/^.*?={10,} \*\/\n/s, '')                  // drop the rest of the opening comment
    .split('\n').map((line) => line.replace(/^  /, '')).join('\n');
  const names = [...body.matchAll(/^(?:const|let|function)\s+([A-Za-z_$][\w$]*)/gm)].map((m) => m[1]);
  if (!names.includes('GAME_VERSION') || !names.includes('computeBattle')) throw new Error('CORE block looks incomplete');
  return '// GENERATED from the CORE block in site/index.html by scripts/sync-core.mjs.\n' +
    '// Do not edit: change the game file and this is rebuilt on the next deploy.\n\n' +
    body.trim() + '\n\nexport {\n  ' + names.join(',\n  ') + '\n};\n';
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const out = buildCore(readFileSync(join(root, 'site/index.html'), 'utf8'));
  writeFileSync(join(root, 'server/core.js'), out);
  console.log('server/core.js rebuilt from site/index.html');
}
