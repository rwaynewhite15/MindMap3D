'use strict';

/* ================================================================
   Manufacturing add-on — server side

   Two routes under /api/plugins/manufacturing, both about one thing: the
   signed-in account's tool list and the cycle times recorded against it.

     GET  /   the whole shop record, plus the limits the client should respect
     PUT  /   whole-record replace, sanitized here before it is stored

   Whole-record replace is the same shape the Standing Desk uses: the client
   owns the state on screen and autosaves it. Everything a client sends is
   rebuilt field by field below, so nothing reaches storage that this file did
   not put there.

   The host has already required a signed-in user before calling in, and hands
   over per-account storage, so there is no auth and no database here.
================================================================ */

const MAX_TOOLS = 200;        // tool records on one account
const MAX_RUNS = 300;         // recorded cycles kept per tool, newest first
const MAX_RUN_SEC = 86400;    // a single cycle longer than a day is a stuck timer
const MAX_INDEXES = 64;       // cutting edges on one insert
const MAX_INSERTS = 200;      // inserts mounted in one tool
const MAX_SEQ = 999;          // position in the op's running order
const MAX_LIFE_MIN = 100000;  // expected life per edge, in minutes of cut time
const MAX_COST = 100000;      // currency units for one insert

module.exports = function (ctx) {
  const { sendJSON, readBody, newId, data } = ctx;

  const text = (v, n) => String(v == null ? '' : v).trim().slice(0, n);

  // Optional numbers: anything unusable — blank, negative, not a number —
  // becomes 0, which every reader treats as "not filled in yet" rather than as
  // a real measurement of zero.
  const num = (v, max, int) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return 0;
    const capped = Math.min(n, max);
    return int ? Math.floor(capped) : Math.round(capped * 1000) / 1000;
  };

  // One recorded cycle: how long the tool took, and when it was timed.
  function sanitizeRun(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const sec = num(raw.sec, MAX_RUN_SEC, false);
    if (!sec) return null; // a cycle of no length is not a measurement
    const at = Number(raw.at);
    return {
      id: text(raw.id, 24) || newId(),
      sec,
      // Clamped to now: a cycle stamped in the future would sort above every
      // real one and never age out of "recent".
      at: Number.isFinite(at) && at > 0 ? Math.min(at, Date.now()) : Date.now(),
      note: text(raw.note, 80),
    };
  }

  // One tool: where it runs (part / machine / op / station), what is in it
  // (insert, indexes per insert, inserts in the tool), what it is expected to
  // last, and every cycle timed against it.
  function sanitizeTool(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const t = {
      id: text(raw.id, 24) || newId(),
      part: text(raw.part, 60),
      machine: text(raw.machine, 60),
      op: text(raw.op, 40),
      station: text(raw.station, 20),   // turret position / pocket, e.g. T0303
      // Where this tool falls in the op's running order — 1 is first to cut.
      // 0 means it has not been placed yet, and sorts after the ones that have.
      seq: num(raw.seq, MAX_SEQ, true),
      desc: text(raw.desc, 80),         // what the tool is: "80° CNMG rougher"
      insert: text(raw.insert, 60),     // insert designation, e.g. CNMG432-MP
      indexes: num(raw.indexes, MAX_INDEXES, true),
      insertsPerOp: num(raw.insertsPerOp, MAX_INSERTS, true),
      lifeMin: num(raw.lifeMin, MAX_LIFE_MIN, false),
      insertCost: num(raw.insertCost, MAX_COST, false),
      notes: text(raw.notes, 400),
      runs: [],
      createdAt: 0,
      updatedAt: 0,
    };
    // A record with nothing identifying on it isn't a tool; the numbers and the
    // times all hang off knowing which tool they belong to.
    if (!t.part && !t.machine && !t.op && !t.station && !t.desc) return null;
    for (const raw2 of Array.isArray(raw.runs) ? raw.runs : []) {
      const run = sanitizeRun(raw2);
      if (run) t.runs.push(run);
      if (t.runs.length >= MAX_RUNS) break;
    }
    // Newest first, so trimming to the limit above drops the oldest cycles.
    t.runs.sort((a, b) => b.at - a.at);
    const created = Number(raw.createdAt);
    const updated = Number(raw.updatedAt);
    t.createdAt = Number.isFinite(created) && created > 0 ? Math.min(created, Date.now()) : Date.now();
    t.updatedAt = Number.isFinite(updated) && updated > 0 ? Math.min(updated, Date.now()) : t.createdAt;
    return t;
  }

  function emptyShop() {
    return { tools: [], activeId: '', updatedAt: 0 };
  }

  // Always returns a valid record — used both to normalize what comes out of
  // storage and to validate what a client sends in.
  function sanitizeShop(input) {
    const s = input && typeof input === 'object' ? input : {};
    const tools = [];
    for (const raw of Array.isArray(s.tools) ? s.tools : []) {
      const tool = sanitizeTool(raw);
      if (tool) tools.push(tool);
      if (tools.length >= MAX_TOOLS) break;
    }
    // The stopwatch points at one tool. An id that no longer names a tool (it
    // was deleted on another device) falls back to nothing selected.
    const activeId = text(s.activeId, 24);
    return {
      tools,
      activeId: tools.some(t => t.id === activeId) ? activeId : '',
      updatedAt: Number.isFinite(Number(s.updatedAt)) ? Number(s.updatedAt) : 0,
    };
  }

  const limits = {
    maxTools: MAX_TOOLS,
    maxRuns: MAX_RUNS,
    maxRunSec: MAX_RUN_SEC,
    maxIndexes: MAX_INDEXES,
    maxInserts: MAX_INSERTS,
  };

  return {
    async handle(req, res, sub, user) {
      const route = req.method + ' ' + sub;

      if (route === 'GET /') {
        sendJSON(res, 200, { shop: sanitizeShop(data.get(user) || emptyShop()), limits });
        return true;
      }

      // A body without a shop object is rejected rather than read as an empty
      // one, so a malformed request can never wipe an account's tool history.
      if (route === 'PUT /') {
        const body = await readBody(req);
        if (!body || typeof body.shop !== 'object' || body.shop === null) {
          sendJSON(res, 400, { error: 'Invalid shop record.' });
          return true;
        }
        const shop = sanitizeShop(body.shop);
        shop.updatedAt = Date.now();
        await data.save(user, shop);
        sendJSON(res, 200, { ok: true, updatedAt: shop.updatedAt, tools: shop.tools.length });
        return true;
      }

      return false; // not ours: the host answers 404
    },
  };
};
