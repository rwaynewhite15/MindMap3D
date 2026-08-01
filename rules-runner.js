'use strict';
/*
 * MindMapShare — sandboxed evaluator for author-written game rules.
 *
 * Ranked games are decided by the SERVER, not by the players' browsers, which
 * means running code an untrusted author wrote. This file is the only place
 * that happens, and it never runs inside the web server: server.js spawns it as
 * a privilege-stripped child process (see startRulesRunner) with
 *
 *   --permission        no filesystem, no child processes, no worker threads,
 *                       no native addons  (enforced by Node itself)
 *   env: {}             no DATABASE_URL, no API keys, nothing to steal
 *   stdio: pipes only   its whole world is newline-delimited JSON on stdin
 *   --max-old-space-size  a hard memory ceiling; blowing it kills only this
 *                       process, which the parent then restarts
 *
 * Inside that, each game's rules get their own `vm` context. `vm` on its own is
 * NOT a security boundary — the documented escape is to grab a host object that
 * was handed into the sandbox and walk up its prototype chain to the host
 * realm. So nothing is ever handed in: every value crossing the boundary is a
 * JSON *string* (a primitive), parsed and stringified by the context's own JSON.
 * An escape from the vm therefore lands in a process that has no files, no
 * environment, and no way to spawn anything.
 *
 * Rules must be synchronous: no timers or I/O exist in the context, and each
 * call is capped by a CPU timeout, so an infinite loop fails that one call
 * instead of hanging a match.
 */
const vm = require('vm');

const CALL_TIMEOUT = 200;        // ms of synchronous CPU per rules call
const MAX_CONTEXTS = 60;         // loaded games; least-recently-used is evicted
const MAX_PAYLOAD = 256 * 1024;  // JSON in/out per call

// gameId → { ctx, script, rev, used }
const loaded = new Map();

// The harness that lives INSIDE each context. It receives the author's code as
// a string, evaluates it, and exposes a single string→string entry point.
// Everything it touches (JSON, Math, Array…) belongs to the context's realm.
const HARNESS = `
var __rules = null, __loadError = null;
var module = { exports: {} }, exports = module.exports;
// Run after the author's code, which is evaluated at this context's top level
// so its \`const Rules = …\` lands in the global lexical scope where we can see it.
function __capture() {
  try {
    if (typeof Rules !== 'undefined' && Rules) __rules = Rules;
    else if (module.exports && (module.exports.setup || module.exports.move)) __rules = module.exports;
  } catch (e) {
    __loadError = (e && e.message) || String(e);
    return;
  }
  if (!__rules || typeof __rules.setup !== 'function' || typeof __rules.move !== 'function') {
    __loadError = 'Your rules must define both setup(players) and move(state, seat, data) — ' +
      'e.g. const Rules = { setup(players) {…}, move(state, seat, data) {…} };';
    __rules = null;
  }
}
// The only way in: a JSON string, and a JSON string back.
function __call(input) {
  var req;
  try { req = JSON.parse(input); } catch (e) { return '{"ok":false,"error":"bad request"}'; }
  if (__loadError) return JSON.stringify({ ok: false, error: __loadError });
  try {
    var out;
    if (req.op === 'setup') {
      out = { state: __rules.setup(req.players) };
    } else if (req.op === 'move') {
      var r = __rules.move(req.state, req.seat, req.data);
      if (r && typeof r === 'object' && r.error) {
        out = { reject: String(r.error).slice(0, 200) };
      } else if (!r || typeof r !== 'object' || r.state === undefined) {
        out = { reject: 'The rules rejected this move.' };
      } else {
        out = {
          state: r.state,
          next: typeof r.next === 'number' ? r.next : null,
          done: !!r.done,
          winner: r.winner === null || r.winner === undefined ? null : r.winner,
          scores: r.scores && typeof r.scores === 'object' ? r.scores : null,
        };
      }
    } else if (req.op === 'seats') {
      var n = Number(__rules.seats);
      out = { seats: n >= 2 && n <= 8 ? Math.floor(n) : 2 };
    } else {
      return '{"ok":false,"error":"unknown op"}';
    }
    // Round-tripping here also proves the result is plain JSON data — no
    // functions, no getters, nothing that could execute later on the server.
    return JSON.stringify({ ok: true, result: JSON.parse(JSON.stringify(out)) });
  } catch (e) {
    return JSON.stringify({ ok: false, error: 'Rules threw: ' + ((e && e.message) || String(e)) });
  }
}
`;

function evict() {
  if (loaded.size <= MAX_CONTEXTS) return;
  let oldestId = null, oldest = Infinity;
  for (const [id, entry] of loaded) {
    if (entry.used < oldest) { oldest = entry.used; oldestId = id; }
  }
  if (oldestId) loaded.delete(oldestId);
}

function loadGame(gameId, rev, code) {
  // A bare object with a null prototype: the context starts with only the
  // realm's own built-ins, and no reference to anything of ours. Dynamic code
  // generation is off, so rules can't reach for eval() or new Function() either.
  const ctx = vm.createContext(Object.create(null), {
    codeGeneration: { strings: false, wasm: false },
  });
  vm.runInContext(HARNESS, ctx, { timeout: CALL_TIMEOUT, filename: 'harness.js' });
  // The author's code is compiled as its own script in the context — a syntax
  // error surfaces here, with a line number, instead of as a mystery failure.
  vm.runInContext(String(code), ctx, { timeout: CALL_TIMEOUT * 5, filename: 'rules.js' });
  vm.runInContext('__capture();', ctx, { timeout: CALL_TIMEOUT, filename: 'capture.js' });
  const entry = {
    ctx, rev, used: Date.now(),
    // Compiled once; re-running it per call is what lets us apply a CPU timeout
    // (calling a context function directly from here would bypass it).
    script: new vm.Script('__out = __call(__in); __in = null;', { filename: 'call.js' }),
  };
  loaded.set(gameId, entry);
  evict();
  return entry;
}

function callGame(entry, payload) {
  const input = JSON.stringify(payload);
  if (input.length > MAX_PAYLOAD) return { ok: false, error: 'Game state is too large.' };
  entry.used = Date.now();
  entry.ctx.__in = input;
  entry.ctx.__out = null;
  try {
    entry.script.runInContext(entry.ctx, { timeout: CALL_TIMEOUT });
  } catch (err) {
    // A timeout here means the author's rules ran away; the context is left in
    // an unknown state, so drop it and let the next call rebuild it.
    return { ok: false, error: /timed out|Script execution/i.test(String(err && err.message))
      ? 'The rules took too long to decide this move.'
      : 'Rules error: ' + ((err && err.message) || 'unknown'), reload: true };
  }
  const out = entry.ctx.__out;
  entry.ctx.__out = null;
  if (typeof out !== 'string') return { ok: false, error: 'Rules returned nothing.' };
  if (out.length > MAX_PAYLOAD) return { ok: false, error: 'Game state is too large.' };
  try { return JSON.parse(out); } catch { return { ok: false, error: 'Rules returned invalid data.' }; }
}

function handle(msg) {
  const { op, gameId, rev, code } = msg;
  let entry = loaded.get(gameId);
  if (op === 'load' || !entry || entry.rev !== rev) {
    if (typeof code !== 'string') return { ok: false, error: 'not-loaded', needCode: true };
    try { entry = loadGame(gameId, rev, code); }
    catch (err) { return { ok: false, error: 'Rules failed to load: ' + ((err && err.message) || 'unknown') }; }
  }
  if (op === 'load') {
    // A load is only "ok" if the rules also survive a real setup call.
    const probe = callGame(entry, { op: 'setup', players: [{ seat: 0 }, { seat: 1 }] });
    if (!probe.ok) { loaded.delete(gameId); return probe; }
    const seats = callGame(entry, { op: 'seats' });
    return { ok: true, seats: seats.ok ? seats.result.seats : 2 };
  }
  const res = callGame(entry, msg);
  if (res.reload) loaded.delete(gameId);
  return res;
}

/* ---- newline-delimited JSON on stdin/stdout ---- */
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    let reply;
    try { reply = handle(msg); }
    catch (err) { reply = { ok: false, error: 'runner error: ' + ((err && err.message) || 'unknown') }; }
    reply.id = msg.id;
    process.stdout.write(JSON.stringify(reply) + '\n');
  }
});
process.stdin.on('end', () => process.exit(0));
process.stdout.write(JSON.stringify({ ready: true }) + '\n');
