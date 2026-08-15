'use strict';

/* ================================================================
   Shopwatch add-on — server side

   Two routes under /api/plugins/manufacturing, both about one thing: the
   signed-in account's shop record and the cycle times recorded against it.

     GET  /   the whole shop record, plus the limits the client should respect
     PUT  /   whole-record replace, sanitized here before it is stored

   The record is six lists and the links between them:

     cells         an area of the floor: the machines that work together, in the
                   order the work flows through them. A machine belongs to one
                   cell or to none
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
                   is only true of that combination — how many of the tool's
                   edges are indexed through there, how many parts run between
                   one index and the next, and every cycle timed against it
     layouts       one machine and one operation: the tool layout. Because an
                   operation belongs to one part, a layout is machine-, part-
                   and operation-specific, which is exactly what a tool layout
                   is on the floor. It carries a number, because a number is
                   somebody's decision rather than anything derived; every other
                   thing about a layout is read off the assignments on it

   A tool runs on as many machines as it is assigned to, and a machine holds as
   many tools; neither owns the other. The same tool on the same machine doing
   a different operation is a different assignment with its own cycle times,
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

const MAX_CELLS = 40;             // work cells on one floor
const MAX_MACHINES = 60;          // machines on one account
const MAX_TOOLS = 200;            // tools in the crib
const MAX_PARTS = 120;            // part numbers being made
const MAX_OPERATIONS = 300;       // operations across all of those parts
const MAX_ASSIGNMENTS = 200;      // tool-on-machine-for-an-operation links
const MAX_LAYOUTS = 200;          // tool layouts: machine-and-operation pairs with tools on them
const MAX_LAYOUT_NUMBER = 9999;   // what a tool layout is called on the floor
const MAX_RUNS = 300;             // recorded cycles kept per assignment, newest first
const MAX_RUN_SEC = 86400;        // a single cycle longer than a day is a stuck timer
const MAX_EDGES = 64;             // cutting edges on one tool
const MAX_PARTS_PER_INDEX = 100000; // parts between one edge index and the next
const MAX_SEQ = 999;              // position in the op's running order
const MAX_COST = 100000;          // currency units for one tool

module.exports = function (ctx) {
  const { newId } = ctx;   // documents are the host's; nothing here answers a request

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

  // One recorded cycle: how long the part took, when it was timed, and — where
  // somebody marked the tool in and out of cut while it ran — how much of that
  // was spent cutting.
  function sanitizeRun(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const sec = num(raw.sec, MAX_RUN_SEC, false);
    if (!sec) return null; // a cycle of no length is not a measurement
    const at = Number(raw.at);
    // Time in cut is part of the cycle it was measured in, so it cannot exceed
    // it. A longer figure is a mis-click, not a measurement, and is dropped
    // rather than stored as a cycle that is more than 100% cut.
    const cut = num(raw.cut, MAX_RUN_SEC, false);
    return {
      id: text(raw.id, 24) || newId(),
      sec,
      cut: cut && cut <= sec ? cut : 0,   // 0 = nobody marked it
      at: Number.isFinite(at) && at > 0 ? Math.min(at, Date.now()) : Date.now(),
      note: text(raw.note, 80),
    };
  }

  // One cell: an area of the floor. Its seq is where it falls in the flow, so a
  // part moving cell to cell reads in the order it actually moves.
  function sanitizeCell(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const name = text(raw.name, 60);
    if (!name) return null;
    return stamp(raw, {
      id: text(raw.id, 24) || newId(),
      name,
      seq: num(raw.seq, MAX_SEQ, true),
      notes: text(raw.notes, 400),
    });
  }

  function sanitizeMachine(raw, cellIds) {
    if (!raw || typeof raw !== 'object') return null;
    const name = text(raw.name, 60);
    if (!name) return null; // a machine is known by its name; there is nothing else to call it
    const cellId = text(raw.cellId, 24);
    return stamp(raw, {
      id: text(raw.id, 24) || newId(),
      name,
      // A machine can stand on its own: not every floor is in cells, and one
      // whose cell has been deleted stays on the floor rather than going with it.
      cellId: cellIds.has(cellId) ? cellId : '',
      cellSeq: num(raw.cellSeq, MAX_SEQ, true),  // where it falls in the cell's flow
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

  // One tool layout: one machine, one operation, and the number the floor asks
  // for it by. Nothing else is stored, because nothing else about a layout is a
  // decision — its tools, its cycle and its time in cut are all read off the
  // assignments that name the same machine and the same operation.
  function sanitizeLayout(raw, machineIds, operationIds) {
    if (!raw || typeof raw !== 'object') return null;
    const machineId = text(raw.machineId, 24);
    const operationId = text(raw.operationId, 24);
    // A layout is a machine and an operation. Missing either, there is nothing
    // for it to be the layout of.
    if (!machineIds.has(machineId) || !operationIds.has(operationId)) return null;
    return stamp(raw, {
      id: text(raw.id, 24) || newId(),
      machineId,
      operationId,
      number: num(raw.number, MAX_LAYOUT_NUMBER, true), // 0 here means "give it one"
      notes: text(raw.notes, 400),
    });
  }

  const pairKey = (machineId, operationId) => machineId + '\u0000' + operationId;

  /* Every machine-and-operation pair with a tool set up on it is a tool layout,
     and every tool layout has a number no other layout in the shopwatch has.
     This is what holds both of those true, whatever arrived: pairs nobody has
     numbered are numbered, a number two layouts claim goes to the first of them
     and the second is given a free one, and a pair whose last tool has gone
     stops being a layout and hands its number back.

     It runs on the way in and on the way out, so it is also the conversion from
     every record written before layouts existed: such a record simply has no
     layouts, and comes back with one per pair, numbered machine by machine and,
     within a machine, in the order the ops run — the order somebody numbering
     them by hand would have used. */
  function fillLayouts(shop, raw) {
    const machineIds = new Set(shop.machines.map(m => m.id));
    const operationIds = new Set(shop.operations.map(o => o.id));
    const live = new Set();
    for (const a of shop.assignments) {
      if (a.operationId) live.add(pairKey(a.machineId, a.operationId));
    }

    const seen = new Set();
    const taken = new Set();
    for (const item of list(raw)) {
      const layout = sanitizeLayout(item, machineIds, operationIds);
      if (!layout) continue;
      const key = pairKey(layout.machineId, layout.operationId);
      // one pair is one layout, and a pair with no tool on it is not one at all
      if (!live.has(key) || seen.has(key)) continue;
      if (taken.has(layout.number)) layout.number = 0;
      seen.add(key);
      if (layout.number) taken.add(layout.number);
      if (shop.layouts.length < MAX_LAYOUTS) shop.layouts.push(layout);
    }

    let next = 1;
    const free = () => {
      while (taken.has(next) && next < MAX_LAYOUT_NUMBER) next++;
      taken.add(next);
      return next;
    };
    for (const layout of shop.layouts) if (!layout.number) layout.number = free();

    const machineName = new Map(shop.machines.map(m => [m.id, m.name]));
    const opById = new Map(shop.operations.map(o => [o.id, o]));
    const partNumber = new Map(shop.parts.map(p => [p.id, p.number || p.desc]));
    const address = key => {
      const [machineId, operationId] = key.split('\u0000');
      const op = opById.get(operationId);
      return [
        machineName.get(machineId) || '',
        (op && partNumber.get(op.partId)) || '',
        String(op && op.seq ? op.seq : 999).padStart(4, '0'),
        (op && op.name) || '',
      ].join(' ');
    };
    const missing = [...live].filter(key => !seen.has(key))
      .sort((x, y) => address(x).localeCompare(address(y)));
    const now = Date.now();
    for (const key of missing) {
      if (shop.layouts.length >= MAX_LAYOUTS) break;
      const [machineId, operationId] = key.split('\u0000');
      shop.layouts.push({
        id: newId(), machineId, operationId, number: free(), notes: '',
        createdAt: now, updatedAt: now,
      });
    }
  }

  function emptyShop() {
    return {
      version: 6,
      cells: [], machines: [], tools: [], parts: [], operations: [], assignments: [],
      layouts: [], activeId: '', updatedAt: 0,
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
      // Version 1 held tool life as cutting minutes per edge. In parts, that is
      // the life divided by the cycle it was measured against — so with nothing
      // timed there is no cycle to divide by, and the old figure is carried
      // into the notes rather than turned into a number nobody measured.
      const partsPerIndex = old.lifeMin && avg
        ? Math.min(Math.floor((old.lifeMin * 60) / avg), MAX_PARTS_PER_INDEX)
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
          const opKey = part.id + '\u0000' + name.toLowerCase();
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

  /* Version 3 kept a cutting time typed onto the setup, next to the time
     actually marked in and out of cut at the machine. Two answers to one
     question, and only one of them was measured — so the typed one is gone and
     the measured one stands alone.

     A number somebody typed is not this file's to throw away, though: where a
     setup carries one, it goes into that setup's notes, the way version 1's
     tool life in minutes did when there was no cycle to convert it against.
     Once carried it is not a field any more, so a second pass finds nothing
     and adds nothing. */
  function fromVersion3(s) {
    for (const raw of list(s.assignments)) {
      if (!raw || typeof raw !== 'object') continue;
      const cutSec = num(raw.cutSec, MAX_RUN_SEC, false);
      delete raw.cutSec;
      if (!cutSec) continue;
      const carried = 'cutting time was ' + (Math.round(cutSec * 100) / 100) + ' s';
      raw.notes = [text(raw.notes, 400), '(' + carried + ')'].filter(Boolean).join(' ');
    }
    return s;
  }

  // Always returns a valid record — used both to normalize what comes out of
  // storage and to validate what a client sends in.
  function sanitizeShop(input) {
    let s = input && typeof input === 'object' ? input : {};
    // Which shape this arrived in has to be read before anything converts it,
    // because every conversion below returns the current one.
    const was = num(s.version, 99, true);
    // A record without an assignments list was written before tools and
    // machines were separate things; one without an operations list, before
    // the part and the op were records rather than text on the link.
    if (!Array.isArray(s.assignments)) s = fromVersion1(s);
    if (!Array.isArray(s.operations)) s = fromVersion2(s);
    // ...and one written before this version carries a typed cutting time.
    if (was < 4) s = fromVersion3(s);

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

    for (const raw of list(s.cells)) keep(shop.cells, sanitizeCell(raw), MAX_CELLS);
    const cellIds = new Set(shop.cells.map(c => c.id));
    for (const raw of list(s.machines)) keep(shop.machines, sanitizeMachine(raw, cellIds), MAX_MACHINES);
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

    // The tool layouts, once the assignments are in: which machine-and-operation
    // pairs are real is read off them, so nothing here can name a pair that has
    // no tools on it. A record from before layouts existed has none to read, and
    // comes out of this numbered.
    fillLayouts(shop, s.layouts);

    // The stopwatch points at one assignment. An id that no longer names one
    // (it was deleted on another device) falls back to nothing selected.
    const activeId = text(s.activeId, 24);
    shop.activeId = shop.assignments.some(a => a.id === activeId) ? activeId : '';
    const updated = Number(s.updatedAt);
    shop.updatedAt = Number.isFinite(updated) ? updated : 0;
    return shop;
  }

  const limits = {
    maxCells: MAX_CELLS,
    maxMachines: MAX_MACHINES,
    maxTools: MAX_TOOLS,
    maxParts: MAX_PARTS,
    maxOperations: MAX_OPERATIONS,
    maxAssignments: MAX_ASSIGNMENTS,
    maxLayouts: MAX_LAYOUTS,
    maxLayoutNumber: MAX_LAYOUT_NUMBER,
    maxRuns: MAX_RUNS,
    maxRunSec: MAX_RUN_SEC,
    maxEdges: MAX_EDGES,
    maxPartsPerIndex: MAX_PARTS_PER_INDEX,
  };

  // One line about a shopwatch, for its card in the feed. Counts rather than
  // adjectives: somebody scrolling past should be able to tell whether there is
  // a shop in here or an empty one.
  function summary(body) {
    const shop = sanitizeShop(body);
    const timed = shop.assignments.reduce((n, a) => n + a.runs.length, 0);
    const bits = [];
    if (shop.parts.length) bits.push(shop.parts.length + (shop.parts.length === 1 ? ' part' : ' parts'));
    if (shop.cells.length) bits.push(shop.cells.length + (shop.cells.length === 1 ? ' cell' : ' cells'));
    if (shop.machines.length) bits.push(shop.machines.length + (shop.machines.length === 1 ? ' machine' : ' machines'));
    if (shop.tools.length) bits.push(shop.tools.length + (shop.tools.length === 1 ? ' tool' : ' tools'));
    if (shop.layouts.length) {
      bits.push(shop.layouts.length + (shop.layouts.length === 1 ? ' tool layout' : ' tool layouts'));
    }
    if (timed) bits.push(timed + (timed === 1 ? ' cycle timed' : ' cycles timed'));
    return bits.join(' · ') || 'nothing in it yet';
  }

  return {
    /* A shopwatch is a document the host owns the envelope of: who it belongs
       to, who may see it, who may edit it, what is said about it. All this
       side has to do is say what an empty one is and what a body may contain.

       That is the whole of this add-on's server: it mounts no routes of its
       own. Every floor lives in a document, so the private per-account store
       this add-on once used is neither read nor written here any more. */
    docs: {
      empty: emptyShop,
      sanitize: sanitizeShop,
      summary,
      limits,
    },
  };
};
