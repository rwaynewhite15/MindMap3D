'use strict';

/* ================================================================
   Manufacturing add-on — server side

   Two routes under /api/plugins/manufacturing, both about one thing: the
   signed-in account's shop record and the cycle times recorded against it.

     GET  /   the whole shop record, plus the limits the client should respect
     PUT  /   whole-record replace, sanitized here before it is stored

   The record is three lists and the links between them:

     machines      one per machine on the floor
     tools         the crib: a tool's own part number, what it is, and how many
                   cutting edges it has — true wherever the tool is used
     assignments   one tool on one machine: the many-to-many between the two,
                   carrying what is only true of that pairing — the cutting
                   time, how many of the tool's edges are indexed through
                   there, how many parts run between one index and the next,
                   and every cycle timed against it

   A tool runs on as many machines as it is assigned to, and a machine holds as
   many tools; neither owns the other. An assignment whose tool or machine is
   gone is dropped here rather than stored as a dangling link.

   Whole-record replace is the same shape the Standing Desk uses: the client
   owns the state on screen and autosaves it. Everything a client sends is
   rebuilt field by field below, so nothing reaches storage that this file did
   not put there.

   The host has already required a signed-in user before calling in, and hands
   over per-account storage, so there is no auth and no database here.
================================================================ */

const MAX_MACHINES = 60;          // machines on one account
const MAX_TOOLS = 200;            // tools in the crib
const MAX_ASSIGNMENTS = 200;      // tool-on-machine links
const MAX_RUNS = 300;             // recorded cycles kept per assignment, newest first
const MAX_RUN_SEC = 86400;        // a single cycle longer than a day is a stuck timer
const MAX_CUT_SEC = 86400;        // cutting time for one part
const MAX_EDGES = 64;             // cutting edges on one tool
const MAX_PARTS_PER_INDEX = 100000; // parts between one edge index and the next
const MAX_SEQ = 999;              // position in the op's running order
const MAX_COST = 100000;          // currency units for one tool

module.exports = function (ctx) {
  const { sendJSON, readBody, newId, data } = ctx;

  const text = (v, n) => String(v == null ? '' : v).trim().slice(0, n);
  const list = v => (Array.isArray(v) ? v : []);

  // Optional numbers: anything unusable — blank, negative, not a number —
  // becomes 0, which every reader treats as "not filled in yet" rather than as
  // a real measurement of zero.
  const num = (v, max, int) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return 0;
    const capped = Math.min(n, max);
    return int ? Math.floor(capped) : Math.round(capped * 1000) / 1000;
  };

  // Created and last-touched, never in the future — a stamp ahead of now would
  // sort above every real one and never age.
  function stamp(raw, out) {
    const created = Number(raw.createdAt);
    const updated = Number(raw.updatedAt);
    out.createdAt = Number.isFinite(created) && created > 0 ? Math.min(created, Date.now()) : Date.now();
    out.updatedAt = Number.isFinite(updated) && updated > 0 ? Math.min(updated, Date.now()) : out.createdAt;
    return out;
  }

  // One recorded cycle: how long the part took, and when it was timed.
  function sanitizeRun(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const sec = num(raw.sec, MAX_RUN_SEC, false);
    if (!sec) return null; // a cycle of no length is not a measurement
    const at = Number(raw.at);
    return {
      id: text(raw.id, 24) || newId(),
      sec,
      at: Number.isFinite(at) && at > 0 ? Math.min(at, Date.now()) : Date.now(),
      note: text(raw.note, 80),
    };
  }

  function sanitizeMachine(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const name = text(raw.name, 60);
    if (!name) return null; // a machine is known by its name; there is nothing else to call it
    return stamp(raw, {
      id: text(raw.id, 24) || newId(),
      name,
      notes: text(raw.notes, 400),
    });
  }

  // One tool in the crib. Everything here is true of the tool itself, wherever
  // it happens to be running.
  function sanitizeTool(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const t = stamp(raw, {
      id: text(raw.id, 24) || newId(),
      partNumber: text(raw.partNumber, 60),  // what the tool is ordered by
      desc: text(raw.desc, 80),              // what it is: "80° CNMG rougher"
      cuttingEdges: num(raw.cuttingEdges, MAX_EDGES, true),
      cost: num(raw.cost, MAX_COST, false),
      notes: text(raw.notes, 400),
    });
    // A tool with neither a number nor a description cannot be told from any
    // other, and nothing can be assigned to it meaningfully.
    if (!t.partNumber && !t.desc) return null;
    return t;
  }

  // One tool on one machine. The link carries the job it is doing there and
  // the numbers that change from machine to machine.
  function sanitizeAssignment(raw, toolIds, machineIds) {
    if (!raw || typeof raw !== 'object') return null;
    const toolId = text(raw.toolId, 24);
    const machineId = text(raw.machineId, 24);
    // Both ends must exist. A link to a deleted tool or machine is dropped
    // rather than kept as a record that can never be read.
    if (!toolIds.has(toolId) || !machineIds.has(machineId)) return null;
    const a = stamp(raw, {
      id: text(raw.id, 24) || newId(),
      toolId,
      machineId,
      part: text(raw.part, 60),        // the part number of the job it is cutting
      op: text(raw.op, 40),
      station: text(raw.station, 20),  // turret position / pocket, e.g. T0303
      // Where this tool falls in the op's running order — 1 is first to cut.
      // 0 means it has not been placed yet, and sorts after the ones that have.
      seq: num(raw.seq, MAX_SEQ, true),
      cutSec: num(raw.cutSec, MAX_CUT_SEC, false),
      indexEdges: num(raw.indexEdges, MAX_EDGES, true),
      partsPerIndex: num(raw.partsPerIndex, MAX_PARTS_PER_INDEX, true),
      notes: text(raw.notes, 400),
      runs: [],
    });
    for (const raw2 of list(raw.runs)) {
      const run = sanitizeRun(raw2);
      if (run) a.runs.push(run);
      if (a.runs.length >= MAX_RUNS) break;
    }
    // Newest first, so trimming to the limit above drops the oldest cycles.
    a.runs.sort((x, y) => y.at - x.at);
    return a;
  }

  function emptyShop() {
    return { version: 2, machines: [], tools: [], assignments: [], activeId: '', updatedAt: 0 };
  }

  /* ---------------- the record as it was before ----------------
     Version 1 kept one flat record per tool, with the machine as a field on it
     — so the same tool running on two machines was two unrelated records, and
     nothing linked them. Below, each of those records becomes a machine, a
     tool, and the link between the two, which is what it always described.

     Tools met twice under the same number and description collapse into one
     crib entry with an assignment on each machine: exactly the tools-to-
     machines relation the flat shape could not hold.
  ---------------------------------------------------------------- */
  function migrate(s) {
    const shop = emptyShop();
    const machineByName = new Map();
    const toolByKey = new Map();
    const assignmentFor = new Map(); // old tool id → new assignment id, so activeId survives

    for (const raw of list(s.tools)) {
      if (!raw || typeof raw !== 'object') continue;
      const old = {
        part: text(raw.part, 60),
        machine: text(raw.machine, 60),
        op: text(raw.op, 40),
        station: text(raw.station, 20),
        desc: text(raw.desc, 80),
        insert: text(raw.insert, 60),
        seq: num(raw.seq, MAX_SEQ, true),
        indexes: num(raw.indexes, MAX_EDGES, true),
        insertsPerOp: num(raw.insertsPerOp, 200, true),
        lifeMin: num(raw.lifeMin, 100000, false),
        insertCost: num(raw.insertCost, MAX_COST, false),
        notes: text(raw.notes, 400),
      };
      if (!old.part && !old.machine && !old.op && !old.station && !old.desc) continue;

      const runs = [];
      for (const raw2 of list(raw.runs)) {
        const run = sanitizeRun(raw2);
        if (run) runs.push(run);
        if (runs.length >= MAX_RUNS) break;
      }
      runs.sort((x, y) => y.at - x.at);

      // A record with no machine on it still ran somewhere; it is put on one
      // machine named for that, rather than dropped or left dangling.
      const machineName = old.machine || 'Unassigned';
      const machineKey = machineName.toLowerCase();
      let machine = machineByName.get(machineKey);
      if (!machine) {
        if (shop.machines.length >= MAX_MACHINES) continue;
        machine = stamp(raw, { id: newId(), name: machineName, notes: '' });
        machineByName.set(machineKey, machine);
        shop.machines.push(machine);
      }

      // The insert designation was the nearest thing v1 had to the tool's own
      // part number, and the description was already the description.
      const toolKey = (old.insert + '\u0000' + old.desc).toLowerCase();
      let tool = toolByKey.get(toolKey);
      if (!tool) {
        if (shop.tools.length >= MAX_TOOLS) continue;
        tool = stamp(raw, {
          id: newId(),
          partNumber: old.insert,
          desc: old.desc,
          cuttingEdges: old.indexes,
          cost: old.insertCost,
          notes: '',
        });
        toolByKey.set(toolKey, tool);
        shop.tools.push(tool);
      } else {
        // the same tool met again fills in what the first record left blank
        if (!tool.cuttingEdges) tool.cuttingEdges = old.indexes;
        if (!tool.cost) tool.cost = old.insertCost;
      }

      if (shop.assignments.length >= MAX_ASSIGNMENTS) continue;
      const avg = runs.length ? runs.reduce((sum, r) => sum + r.sec, 0) / runs.length : 0;
      const cutSec = avg ? Math.round(avg * 1000) / 1000 : 0;
      // v1 held tool life as cutting minutes per edge. In parts, that is the
      // life divided by the cycle it was measured against — so with nothing
      // timed there is no cycle to divide by, and the old figure is carried
      // into the notes rather than turned into a number nobody measured.
      const partsPerIndex = old.lifeMin && cutSec
        ? Math.min(Math.floor((old.lifeMin * 60) / cutSec), MAX_PARTS_PER_INDEX)
        : 0;
      const carried = [];
      if (old.insertsPerOp > 1) carried.push(old.insertsPerOp + ' inserts mounted');
      if (old.lifeMin && !partsPerIndex) carried.push(old.lifeMin + ' min of cut per edge');
      const notes = [old.notes, carried.length ? '(' + carried.join(', ') + ')' : '']
        .filter(Boolean).join(' ').slice(0, 400);

      const assignment = stamp(raw, {
        id: newId(),
        toolId: tool.id,
        machineId: machine.id,
        part: old.part,
        op: old.op,
        station: old.station,
        seq: old.seq,
        cutSec,
        indexEdges: old.indexes,
        partsPerIndex,
        notes,
        runs,
      });
      shop.assignments.push(assignment);
      const wasId = text(raw.id, 24);
      if (wasId) assignmentFor.set(wasId, assignment.id);
    }

    shop.activeId = assignmentFor.get(text(s.activeId, 24)) || '';
    const updated = Number(s.updatedAt);
    shop.updatedAt = Number.isFinite(updated) ? updated : 0;
    return shop;
  }

  // Always returns a valid record — used both to normalize what comes out of
  // storage and to validate what a client sends in.
  function sanitizeShop(input) {
    const s = input && typeof input === 'object' ? input : {};
    // A record without an assignments list is one written before tools and
    // machines were separate things, and is converted on the way past.
    if (!Array.isArray(s.assignments)) return migrate(s);

    const shop = emptyShop();
    // Two records claiming the same id would make one of them unreachable, so
    // the second one to claim it is given a fresh one instead.
    const taken = new Set();
    const keep = (out, item, max) => {
      if (!item || out.length >= max) return false;
      if (taken.has(item.id)) item.id = newId();
      taken.add(item.id);
      out.push(item);
      return true;
    };

    for (const raw of list(s.machines)) keep(shop.machines, sanitizeMachine(raw), MAX_MACHINES);
    for (const raw of list(s.tools)) keep(shop.tools, sanitizeTool(raw), MAX_TOOLS);
    const machineIds = new Set(shop.machines.map(m => m.id));
    const toolIds = new Set(shop.tools.map(t => t.id));
    for (const raw of list(s.assignments)) {
      keep(shop.assignments, sanitizeAssignment(raw, toolIds, machineIds), MAX_ASSIGNMENTS);
    }

    // The stopwatch points at one assignment. An id that no longer names one
    // (it was deleted on another device) falls back to nothing selected.
    const activeId = text(s.activeId, 24);
    shop.activeId = shop.assignments.some(a => a.id === activeId) ? activeId : '';
    const updated = Number(s.updatedAt);
    shop.updatedAt = Number.isFinite(updated) ? updated : 0;
    return shop;
  }

  const limits = {
    maxMachines: MAX_MACHINES,
    maxTools: MAX_TOOLS,
    maxAssignments: MAX_ASSIGNMENTS,
    maxRuns: MAX_RUNS,
    maxRunSec: MAX_RUN_SEC,
    maxEdges: MAX_EDGES,
    maxPartsPerIndex: MAX_PARTS_PER_INDEX,
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
        try {
          await data.save(user, shop);
        } catch (err) {
          // The host caps what one add-on keeps per account. Say so plainly:
          // the client retries a failed save forever, and this one will never
          // succeed until something is taken out of the record.
          if (err && err.code === 'PLUGIN_DATA_TOO_LARGE') {
            sendJSON(res, 413, {
              error: 'This shop record is larger than one account may keep. Export it, then delete some recorded cycles.',
            });
            return true;
          }
          throw err;
        }
        sendJSON(res, 200, {
          ok: true,
          updatedAt: shop.updatedAt,
          machines: shop.machines.length,
          tools: shop.tools.length,
          assignments: shop.assignments.length,
        });
        return true;
      }

      return false; // not ours: the host answers 404
    },
  };
};
