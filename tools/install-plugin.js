#!/usr/bin/env node
'use strict';

/* ================================================================
   Install a MindMapShare plugin

     node tools/install-plugin.js manufacturing        one that ships here
     node tools/install-plugin.js ~/Downloads/x.zip    one that was downloaded
     node tools/install-plugin.js ~/Downloads/x/       one already unzipped
     node tools/install-plugin.js --list               what is installed
     node tools/install-plugin.js --remove <id>        take one back off

   Installing is only ever "put the folder in plugins/". This script does that
   with the checks worth doing first: that the package really is a plugin, that
   its manifest names files it actually ships, and that nothing in a downloaded
   archive writes outside the folder it claims. Restart the server afterwards —
   plugins are read once, at startup.

   A plugin's server.js runs inside the server process, with everything that
   process can reach. Install ones you trust, from where you meant to get them.
================================================================ */

const fs = require('fs');
const path = require('path');
const { readZip } = require('./zip');

const ROOT = path.join(__dirname, '..');
const PLUGINS_DIR = path.join(ROOT, 'plugins');
const BUNDLED_DIR = path.join(ROOT, 'plugin-packages');
const ID_RE = /^[a-z0-9][a-z0-9-]{1,31}$/;
const FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SAFE_PATH_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/;
const MAX_FILES = 200;
const MAX_BYTES = 8 * 1024 * 1024;
const SKIP_DIRS = new Set(['node_modules', '.git', '.DS_Store']);

function die(message) {
  console.error('\n  ' + message + '\n');
  process.exit(1);
}

function usage() {
  console.log(`
  Install a MindMapShare plugin.

    node tools/install-plugin.js <name | folder | zip file>
    node tools/install-plugin.js --list
    node tools/install-plugin.js --remove <id>

  Bundled with this copy of MindMapShare:${bundled().map(n => '\n    ' + n).join('') || '\n    (none)'}
`);
}

function bundled() {
  try {
    return fs.readdirSync(BUNDLED_DIR, { withFileTypes: true })
      .filter(e => e.isDirectory() && fs.existsSync(path.join(BUNDLED_DIR, e.name, 'plugin.json')))
      .map(e => e.name);
  } catch { return []; }
}

/* ---------------- reading a package ---------------- */
// Both sources end up as the same thing: a list of { name, data } with paths
// relative to the folder holding plugin.json.
function filesFromDir(dir) {
  const files = [];
  const walk = (abs, rel) => {
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
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

function filesFromZip(file) {
  const entries = readZip(fs.readFileSync(file), MAX_BYTES);
  // A downloaded archive usually wraps the plugin in a folder of its own; the
  // plugin starts wherever the shallowest plugin.json is.
  const manifests = entries
    .filter(e => path.posix.basename(e.name) === 'plugin.json')
    .sort((a, b) => a.name.split('/').length - b.name.split('/').length);
  if (!manifests.length) die('That archive has no plugin.json in it, so it is not a plugin package.');
  const prefix = path.posix.dirname(manifests[0].name);
  const base = prefix === '.' ? '' : prefix + '/';
  return entries
    .filter(e => e.name.startsWith(base))
    .map(e => ({ name: e.name.slice(base.length), data: e.data }));
}

function readPackage(source) {
  // A bare name means one of the packages that ship with this copy.
  const asBundled = path.join(BUNDLED_DIR, source);
  if (ID_RE.test(source) && fs.existsSync(path.join(asBundled, 'plugin.json'))) {
    return { files: filesFromDir(asBundled), from: path.relative(ROOT, asBundled) };
  }
  let stat;
  try { stat = fs.statSync(source); }
  catch { die(`There is nothing at "${source}", and no plugin of that name ships with MindMapShare.`); }
  if (stat.isDirectory()) {
    if (!fs.existsSync(path.join(source, 'plugin.json'))) die(`"${source}" has no plugin.json in it, so it is not a plugin package.`);
    return { files: filesFromDir(source), from: source };
  }
  if (!source.toLowerCase().endsWith('.zip')) die(`"${source}" is neither a folder nor a .zip package.`);
  try { return { files: filesFromZip(source), from: source }; }
  catch (err) { die(`That package could not be read — ${err.message}`); }
}

/* ---------------- checking it ---------------- */
function checkPackage(files) {
  if (!files.length) die('That package is empty.');
  if (files.length > MAX_FILES) die(`That package holds ${files.length} files, which is far more than a plugin needs.`);
  let bytes = 0;
  for (const f of files) {
    // Nothing writes outside the plugin's own folder: no absolute paths, no
    // "..", no backslashes, no names the server could not serve anyway.
    if (!SAFE_PATH_RE.test(f.name)) die(`"${f.name}" is not a path this installer will write.`);
    bytes += f.data.length;
  }
  if (bytes > MAX_BYTES) die('That package is larger than this installer will write.');

  const manifestFile = files.find(f => f.name === 'plugin.json');
  if (!manifestFile) die('That package has no plugin.json at its root.');
  let manifest;
  try { manifest = JSON.parse(manifestFile.data.toString('utf8')); }
  catch (err) { die('Its plugin.json is not valid JSON — ' + err.message); }

  const id = String(manifest.id || '');
  if (!ID_RE.test(id)) die('Its plugin.json needs an "id" of lowercase letters, numbers and dashes.');

  const has = name => files.some(f => f.name === name);
  const declared = (key, dir, ext) => {
    const value = manifest[key];
    if (!value) return;
    const name = String(value);
    if (!FILE_RE.test(name) || !name.endsWith(ext)) die(`Its "${key}" is "${name}", which is not a plain ${ext} file name.`);
    const full = dir ? dir + '/' + name : name;
    if (!has(full)) die(`Its plugin.json names ${full}, which the package does not contain.`);
  };
  declared('client', 'public', '.js');
  declared('styles', 'public', '.css');
  declared('server', '', '.js');

  return { manifest, id };
}

/* ---------------- installing ---------------- */
function installedManifest(id) {
  try { return JSON.parse(fs.readFileSync(path.join(PLUGINS_DIR, id, 'plugin.json'), 'utf8')); }
  catch { return null; }
}

function install(source, force) {
  const { files, from } = readPackage(source);
  const { manifest, id } = checkPackage(files);
  const target = path.join(PLUGINS_DIR, id);

  if (fs.existsSync(target)) {
    const current = installedManifest(id);
    // Replacing an installation of the same plugin is the upgrade path and is
    // expected. Replacing anything else is not, and needs to be asked for.
    if (!current || current.id !== id) {
      if (!force) {
        die(`plugins/${id} already exists but is not an installed "${id}" plugin.\n` +
            '  Move it aside, or re-run with --force to replace it.');
      }
    } else {
      console.log(`  Replacing ${current.name || id} ${current.version || ''} already installed here.`);
    }
    fs.rmSync(target, { recursive: true, force: true });
  }

  for (const f of files) {
    const dest = path.join(target, f.name);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, f.data);
  }

  console.log(`
  Installed ${manifest.name || id} ${manifest.version || ''}
    from  ${from}
    into  ${path.relative(ROOT, target)}

  Restart MindMapShare and it will be there${manifest.nav && manifest.nav.label ? ` — "${manifest.nav.label}" in the top navigation` : ''}.
`);
}

function list() {
  let entries = [];
  try { entries = fs.readdirSync(PLUGINS_DIR, { withFileTypes: true }); }
  catch { /* no plugins directory yet */ }
  const found = entries.filter(e => e.isDirectory() && installedManifest(e.name));
  if (!found.length) {
    console.log('\n  No plugins are installed.\n');
    usage();
    return;
  }
  console.log('\n  Installed plugins:');
  for (const e of found) {
    const m = installedManifest(e.name);
    console.log(`    ${m.id}  ${m.version || ''}  ${m.name || ''}`);
  }
  console.log('');
}

function remove(id) {
  if (!ID_RE.test(id)) die('That is not a plugin id.');
  const target = path.join(PLUGINS_DIR, id);
  const current = installedManifest(id);
  if (!current) die(`No plugin called "${id}" is installed.`);
  fs.rmSync(target, { recursive: true, force: true });
  console.log(`
  Removed ${current.name || id} ${current.version || ''}.

  What accounts saved with it is untouched — it stays on each account and comes
  back if the plugin is installed again. Restart MindMapShare to finish.
`);
}

/* ---------------- entry point ---------------- */
const args = process.argv.slice(2).filter(a => a !== '--');
const force = args.includes('--force');
const rest = args.filter(a => a !== '--force');

if (!rest.length || rest[0] === '--help' || rest[0] === '-h') usage();
else if (rest[0] === '--list') list();
else if (rest[0] === '--remove') {
  if (!rest[1]) die('Which one? node tools/install-plugin.js --remove <id>');
  remove(rest[1]);
} else install(rest[0], force);
