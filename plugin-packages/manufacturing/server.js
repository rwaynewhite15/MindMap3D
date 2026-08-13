'use strict';

/* ================================================================
   Shopwatch add-on — server side

   Two routes under /api/plugins/manufacturing, both about one thing: the
   signed-in account's shop record and the cycle times recorded against it.

     GET  /   the whole shop record, plus the limits the client should respect
     PUT  /   whole-record replace, sanitized here before it is stored

   The record is five lists and the links between them:

     machines      one per machine on the floor
     tools         the crib: a tool's own part number, what it is, and how many
                   cutting edges it has — true wherever the tool is used
     parts         the part numbers being made
     operations    the ops of one part — Op 10, Op 20. An operation belongs to
                   exactly one part, because that is what an op is: a step in
                   making that part, not a name that means the same thing
                   everywhere
     assignments   one tool, on one machine, doing one operation. This is the
                   many-to-many between tools and machines, and it carries what
                   is only true of that combination — the cutting time, how
                   many of the tool's edges are indexed through there, how many
                   parts run between one index and the next, and every cycle
                   timed against it

   A tool runs on as many machines as it is assigned to, and a machine holds as
   many tools; neither owns the other. The same tool on the same machine doing
   a different operation is a different assignment with its own cutting time,
   because the time a tool spends in cut is a fact about the operation it is
   doing and not about the tool. An assignment whose tool, machine or operation
   is gone is dropped or unlinked here rather than stored as a dangling link.

   Whole-record replace is the same shape the Standing Desk uses: the client
   owns the state on screen and autosaves it. Everything a client sends is
   rebuilt field by field below, so nothing reaches storage that this file did
   not put there.

   The host has already required a signed-in user before calling in, and hands
   over per-account storage, so there is no auth and no database here.
================================================================ */

const MAX_MACHINES = 60;          // machines on one account
const MAX_TOOLS = 200;            // tools in the crib
const MAX_PARTS = 120;            // part numbers being made
const MAX_OPERATIONS = 300;       // operations across all of those parts
const MAX_ASSIGNMENTS = 200;      // tool-on-machine-for-an-operation links
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

  // One part number being made.
  function sanitizePart(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const p = stamp(raw, {
      id: text(raw.id, 24) || newId(),
      number: text(raw.number, 60),
      desc: text(raw.desc, 80),
      notes: text(raw.notes, 400),
    });
    if (!p.number && !p.desc) return null;
    return p;
  }

  // One operation of one part. "Op 20" on its own means nothing — it is Op 20
  // of a particular part — so an operation that names no part it belongs to is
  // dropped rather than left floating.
  function sanitizeOperation(raw, partIds) {
    if (!raw || typeof raw !== 'object') return null;
    const partId = text(raw.partId, 24);
    if (!partIds.has(partId)) return null;
    const name = text(raw.name, 40);
    if (!name) return null;
    return stamp(raw, {
      id: text(raw.id, 24) || newId(),
      partId,
      name,
      seq: num(raw.seq, MAX_SEQ, true), // where the op falls in making the part
      notes: text(raw.notes, 400),
    });
  }

  // One tool, on one machine, doing one operation. The numbers here belong to
  // that combination and to nothing else.
  function sanitizeAssignment(raw, toolIds, machineIds, operationIds) {
    if (!raw || typeof raw !== 'object') return null;
    const toolId = text(raw.toolId, 24);
    const machineId = text(raw.machineId, 24);
    // Both ends must exist. A link to a deleted tool or machine is dropped
    // rather than kept as a record that can never be read.
    if (!toolIds.has(toolId) || !machineIds.has(machineId)) return null;
    const operationId = text(raw.operationId, 24);
    const a = stamp(raw, {
      id: text(raw.id, 24) || newId(),
      toolId,
      machineId,
      // A tool can be set up on a machine before anybody has said which op it
      // is for; the cycle times only mean something once one is named, and the
      // screen says so. An operation that has been deleted leaves the tool on
      // the machine rather than taking it off.
      operationId: operationIds.has(operationId) ? operationId : '',
      station: text(raw.station, 20),  // turret position / pocket, e.g. T0303
      // Where this tool falls in the operation's running order — 1 is first to
      // cut. 0 means it has not been placed yet, and sorts after the ones that
      // have.
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
    return {
      version: 3,
      machines: [], tools: [], parts: [], operations: [], assignments: [],
      activeId: '', updatedAt: 0,
    };
  }

  /* ---------------- the record as it was before ----------------
     Two conversions, each undoing one shape the record used to have. They run
     in order, so a record written by the very first version passes through
     both, and the result of either goes on to be sanitized like anything else.

     Version 1 kept one flat record per tool, with the machine as a field on it
     — so the same tool running on two machines was two unrelated records, and
     nothing linked them. Each of those records becomes a machine, a tool, and
     the link between the two, which is what it always described; tools met
     twice under the same number and description collapse into one crib entry
     with an assignment on each machine.

     Version 2 kept the part and the op as text on that link, repeated on every
     tool of the job. Below they become records: a part, and the operations
     belonging to it, with each assignment naming the operation it is for.
  ---------------------------------------------------------------- */
  function fromVersion1(s) {
    // Deliberately not emptyShop(): this returns the shape version 2 stored,
    // which the next conversion then reads.
    const shop = { machines: [], tools: [], assignments: [], activeId: '', updatedAt: 0 };
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

      // The insert designation was the nearest thing version 1 had to the
      // tool's own part number, and the description was already the description.
      const toolKey = (old.insert + ' ' + old.desc).toLowerCase();
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
      // Version 1 held tool life as cutting minutes per edge. In parts, that is
      // the life divided by the cycle it was measured against — so with nothing
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

  function fromVersion2(s) {
    const shop = emptyShop();
    shop.machines = list(s.machines);
    shop.tools = list(s.tools);
    shop.activeId = s.activeId;
    shop.updatedAt = s.updatedAt;

    const partByKey = new Map();
    const opByKey = new Map();

    for (const raw of list(s.assignments)) {
      if (!raw || typeof raw !== 'object') continue;
      const partNumber = text(raw.part, 60);
      const opName = text(raw.op, 40);
      let operationId = '';

      // A link that named neither a part nor an op described no operation, and
      // one is not invented for it: the tool stays on its machine with no
      // operation set, which is a state the screen can show and fix.
      if (partNumber || opName) {
        // An op named without a part still belongs to something; they are
        // gathered under one clearly named part rather than each inventing one.
        const number = partNumber || 'Unassigned';
        const partKey = number.toLowerCase();
        let part = partByKey.get(partKey);
        if (!part && shop.parts.length < MAX_PARTS) {
          part = stamp(raw, { id: newId(), number, desc: '', notes: '' });
          partByKey.set(partKey, part);
          shop.parts.push(part);
        }
        if (part) {
          const name = opName || 'Op';
          const opKey = part.id + ' ' + name.toLowerCase();
          let operation = opByKey.get(opKey);
          if (!operation && shop.operations.length < MAX_OPERATIONS) {
            operation = stamp(raw, { id: newId(), partId: part.id, name, seq: 0, notes: '' });
            opByKey.set(opKey, operation);
            shop.operations.push(operation);
          }
          if (operation) operationId = operation.id;
        }
      }

      const assignment = { ...raw, operationId };
      delete assignment.part;
      delete assignment.op;
      shop.assignments.push(assignment);
    }

    // The operations of a part are numbered in the order they were met, which
    // is the order the job runs when the record came from a spreadsheet or a
    // screen that kept them in it.
    const seen = new Map();
    for (const op of shop.operations) {
      const n = (seen.get(op.partId) || 0) + 1;
      seen.set(op.partId, n);
      op.seq = n;
    }
    return shop;
  }

  // Always returns a valid record — used both to normalize what comes out of
  // storage and to validate what a client sends in.
  function sanitizeShop(input) {
    let s = input && typeof input === 'object' ? input : {};
    // A record without an assignments list was written before tools and
    // machines were separate things; one without an operations list, before
    // the part and the op were records rather than text on the link.
    if (!Array.isArray(s.assignments)) s = fromVersion1(s);
    if (!Array.isArray(s.operations)) s = fromVersion2(s);

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
    for (const raw of list(s.parts)) keep(shop.parts, sanitizePart(raw), MAX_PARTS);
    const partIds = new Set(shop.parts.map(p => p.id));
    for (const raw of list(s.operations)) {
      keep(shop.operations, sanitizeOperation(raw, partIds), MAX_OPERATIONS);
    }
    const machineIds = new Set(shop.machines.map(m => m.id));
    const toolIds = new Set(shop.tools.map(t => t.id));
    const operationIds = new Set(shop.operations.map(o => o.id));
    for (const raw of list(s.assignments)) {
      keep(shop.assignments, sanitizeAssignment(raw, toolIds, machineIds, operationIds), MAX_ASSIGNMENTS);
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
    maxParts: MAX_PARTS,
    maxOperations: MAX_OPERATIONS,
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
          parts: shop.parts.length,
          operations: shop.operations.length,
          assignments: shop.assignments.length,
        });
        return true;
      }

      return false; // not ours: the host answers 404
    },
  };
};
