#!/usr/bin/env node
'use strict';

/* ================================================================
   Pack a plugin into a file people can download

     node tools/package-plugin.js manufacturing
     node tools/package-plugin.js ./some/plugin-folder

   Writes dist/mindmapshare-plugin-<id>-<version>.zip. That file is the whole
   distribution: whoever downloads it runs

     node tools/install-plugin.js <the file>

   against their own copy of MindMapShare and restarts it.
================================================================ */

const fs = require('fs');
const path = require('path');
const { writeZip } = require('./zip');

const ROOT = path.join(__dirname, '..');
const BUNDLED_DIR = path.join(ROOT, 'plugin-packages');
const DIST_DIR = path.join(ROOT, 'dist');
const SKIP_DIRS = new Set(['node_modules', '.git', '.DS_Store']);

function die(message) {
  console.error('\n  ' + message + '\n');
  process.exit(1);
}

function collect(dir) {
  const files = [];
  const walk = (abs, rel) => {
    for (const e of fs.readdirSync(abs, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
      const child = path.join(abs, e.name);
      const name = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) walk(child, name);
      else if (e.isFile()) files.push({ name, data: fs.readFileSync(child) });
    }
  };
  walk(dir, '');
  return files;
}

const arg = process.argv.slice(2).filter(a => a !== '--')[0];
if (!arg) {
  const names = fs.existsSync(BUNDLED_DIR)
    ? fs.readdirSync(BUNDLED_DIR, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name)
    : [];
  die('Which plugin? node tools/package-plugin.js <name | folder>' +
      (names.length ? '\n  Bundled here: ' + names.join(', ') : ''));
}

const asBundled = path.join(BUNDLED_DIR, arg);
const dir = fs.existsSync(path.join(asBundled, 'plugin.json')) ? asBundled : arg;
if (!fs.existsSync(path.join(dir, 'plugin.json'))) die(`"${arg}" has no plugin.json in it, so it is not a plugin.`);

const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'plugin.json'), 'utf8'));
const id = String(manifest.id || '');
if (!/^[a-z0-9][a-z0-9-]{1,31}$/.test(id)) die('Its plugin.json needs an "id" of lowercase letters, numbers and dashes.');

// Everything sits under a folder named for the plugin, so unzipping by hand
// leaves exactly the folder that belongs in plugins/.
const files = collect(dir).map(f => ({ name: id + '/' + f.name, data: f.data }));
if (!files.length) die('That folder is empty.');

fs.mkdirSync(DIST_DIR, { recursive: true });
const out = path.join(DIST_DIR, `mindmapshare-plugin-${id}-${manifest.version || '0.0.0'}.zip`);
fs.writeFileSync(out, writeZip(files));

const kb = (fs.statSync(out).size / 1024).toFixed(1);
console.log(`
  Packed ${manifest.name || id} ${manifest.version || ''} — ${files.length} files, ${kb} kB
    ${path.relative(ROOT, out)}

  Install it anywhere with:
    node tools/install-plugin.js ${path.relative(ROOT, out)}
`);
