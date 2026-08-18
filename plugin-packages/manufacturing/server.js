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
     layouts       a tool layout: the tooling for one operation, and the
                   machines that run it. It carries the number the floor asks
                   for it by, because a number is somebody's decision rather
                   than anything derived. One layout can be run on several
                   machines — identical machines share an arrangement — and a
                   machine runs as many layouts as it has work
     assignments   one tool in one pocket of one layout, with what is only true
                   there: how many of the tool's edges are indexed through it,
                   how many parts run between one index and the next, and every
                   cycle timed against it. The pockets belong to the layout, not
                   to a machine, which is what lets two machines share one

   A cycle is still measured on a machine, so a recorded cycle names the machine
   it was taken on: the same layout on two machines is one arrangement with two
   sets of times, and neither is averaged into the other. An assignment whose
   layout is gone, or a layout whose operation is gone, is dropped here rather
   than stored as a dangling link.

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
const MAX_LAYOUTS = 200;          // tool layouts on one floor
const MAX_LAYOUT_MACHINES = 20;   // machines running one layout
const MAX_LAYOUT_NUMBER = 9999;   // what a tool layout is called on the floor
const MAX_RUNS = 300;             // recorded cycles kept for one pocket on one machine
const MAX_POCKET_RUNS = 900;      // and for that pocket across every machine it runs on
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

  /* How many cycles a pocket keeps, and whose drop when it is full.

     The cap is per machine. A layout run on two machines has two histories
     under the same pocket, and a busy machine must not push a quiet one's
     cycles out: each keeps its own newest MAX_RUNS, and the oldest of that
     machine are the ones that go. A pocket as a whole is still bounded, and
     when it is over that ceiling the machines with the most give up cycles
     first — down to an equal share before anybody below it loses one. Cycles
     that name no machine are a machine of their own, since that is what they
     are: measurements from a time before the layout could say. */
  function fairShare(sizes, budget) {
    const asc = [...sizes].sort((a, b) => a - b);
    let left = budget;
    for (let i = 0; i < asc.length; i++) {
      const share = Math.floor(left / (asc.length - i));
      if (asc[i] > share) return share;   // this machine and every bigger one keep `share`
      left -= asc[i];                     // it fits whole; its slack goes to the rest
    }
    return Infinity;                      // the budget covers every machine in full
  }

  function trimRuns(runs) {
    const byMachine = new Map();
    for (const r of runs) {
      const key = r.machineId || '';
      if (!byMachine.has(key)) byMachine.set(key, []);
      byMachine.get(key).push(r);
    }
    const groups = [...byMachine.values()];
    for (const g of groups) {
      g.sort((x, y) => y.at - x.at);      // newest first, so it is the oldest that drop
      if (g.length > MAX_RUNS) g.length = MAX_RUNS;
    }
    if (groups.reduce((n, g) => n + g.length, 0) > MAX_POCKET_RUNS) {
      const share = fairShare(groups.map(g => g.length), MAX_POCKET_RUNS);
      for (const g of groups) if (g.length > share) g.length = share;
    }
    const kept = [].concat(...groups);
    kept.sort((x, y) => y.at - x.at);
    return kept;
  }

  // One recorded cycle: how long the part took, when it was timed, and — where
  // somebody marked the tool in and out of cut while it ran — how much of that
  // was spent cutting.
  function sanitizeRun(raw, machineIds) {
    if (!raw || typeof raw !== 'object') return null;
    const sec = num(raw.sec, MAX_RUN_SEC, false);
    if (!sec) return null; // a cycle of no length is not a measurement
    const at = Number(raw.at);
    // Which machine it was taken on. A layout can be run on several, and their
    // cycles are not each other's, so the machine travels with the measurement.
    // Blank means nobody said — an older record, or a layout with one machine.
    const machineId = text(raw.machineId, 24);
    // Time in cut is part of the cycle it was measured in, so it cannot exceed
    // it. A longer figure is a mis-click, not a measurement, and is dropped
    // rather than stored as a cycle that is more than 100% cut.
    const cut = num(raw.cut, MAX_RUN_SEC, false);
    return {
      id: text(raw.id, 24) || newId(),
      sec,
      cut: cut && cut <= sec ? cut : 0,   // 0 = nobody marked it
      machineId: machineIds && machineIds.has(machineId) ? machineId : '',
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
  /* One tool layout: the tooling for an operation, and the machines that run
     it. The number is the only thing here somebody decides — its tools are the
     assignments hanging off it, and its cycle and time in cut are read off the
     cycles timed against those.

     Both links are optional, and for the same reason each was before: tooling
     can be laid out before anybody says which op it cuts, and an op can be
     planned before there is a machine free to run it. A layout with neither is
     nothing at all and is dropped. */
  function sanitizeLayout(raw, machineIds, operationIds) {
    if (!raw || typeof raw !== 'object') return null;
    const operationId = text(raw.operationId, 24);
    const machines = [];
    for (const item of list(raw.machineIds)) {
      const id = text(item, 24);
      // A machine that has been deleted leaves the layout rather than taking it
      if (!machineIds.has(id) || machines.includes(id)) continue;
      machines.push(id);
      if (machines.length >= MAX_LAYOUT_MACHINES) break;
    }
    const op = operationIds.has(operationId) ? operationId : '';
    if (!op && !machines.length) return null;
    return stamp(raw, {
      id: text(raw.id, 24) || newId(),
      operationId: op,
      machineIds: machines,
      number: num(raw.number, MAX_LAYOUT_NUMBER, true), // 0 here means "give it one"
      notes: text(raw.notes, 400),
    });
  }

  // One pocket of one layout: which tool is in it, where it sits, what is true
  // of the tool there, and every cycle timed against it.
  function sanitizeAssignment(raw, toolIds, layoutIds, machineIds) {
    if (!raw || typeof raw !== 'object') return null;
    const toolId = text(raw.toolId, 24);
    const layoutId = text(raw.layoutId, 24);
    // Both ends must exist. A pocket whose tool or whose layout is gone is
    // dropped rather than kept as a record that can never be read.
    if (!toolIds.has(toolId) || !layoutIds.has(layoutId)) return null;
    const a = stamp(raw, {
      id: text(raw.id, 24) || newId(),
      toolId,
      layoutId,
      station: text(raw.station, 20),  // turret position / pocket, e.g. T0303
      // Where this tool falls in the layout's running order — 1 is first to
      // cut. 0 means it has not been placed yet, and sorts after the ones that
      // have.
      seq: num(raw.seq, MAX_SEQ, true),
      indexEdges: num(raw.indexEdges, MAX_EDGES, true),
      partsPerIndex: num(raw.partsPerIndex, MAX_PARTS_PER_INDEX, true),
      notes: text(raw.notes, 400),
      runs: [],
    });
    const runs = [];
    for (const raw2 of list(raw.runs)) {
      const run = sanitizeRun(raw2, machineIds);
      if (run) runs.push(run);
    }
    // Sorted and trimmed together, so what drops is the oldest rather than
    // whatever the client happened to send last.
    a.runs = trimRuns(runs);
    return a;
  }

  /* Every tool layout has a number no other layout in this shopwatch has. That
     is the whole of the housekeeping now: layouts are records somebody makes
     rather than pairs discovered from the setups on them, so nothing here has
     to invent one. A layout that arrived without a number, or with one already
     taken, is given the first free one — a number that names two layouts names
     neither. */
  function numberLayouts(layouts) {
    const taken = new Set();
    for (const l of layouts) {
      if (l.number && !taken.has(l.number)) taken.add(l.number);
      else l.number = 0;
    }
    let next = 1;
    for (const l of layouts) {
      if (l.number) continue;
      while (taken.has(next) && next < MAX_LAYOUT_NUMBER) next++;
      l.number = next;
      taken.add(next);
    }
  }

  function emptyShop() {
    return {
      version: 7,
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
      }
      const kept = trimRuns(runs);

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
      const avg = kept.length ? kept.reduce((sum, r) => sum + r.sec, 0) / kept.length : 0;
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
        runs: kept,
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

  /* Version 6 tied a tool layout to exactly one machine: the pair (machine,
     operation) was the layout, and a setup named both. Identical machines
     therefore had a layout each and the same arrangement was typed twice.

     Here a layout is the arrangement — an operation and the machines that run
     it — so each old pair becomes a layout with one machine in its list, every
     setup moves onto the layout it was part of, and each cycle it carries keeps
     the machine it was measured on. Nothing is merged: two machines that ran the
     same op were two layouts before this and stay two layouts after it, because
     nobody has said their tooling is the same. Saying so is a decision, and it
     is one the floor makes by adding a machine to a layout.

     Setups that named a machine but no operation had no layout at all. They get
     one — that machine, no operation — which is the state they were already in,
     now with somewhere to live. */
  function fromVersion6(s) {
    const layouts = [];
    const byPair = new Map();
    for (const raw of list(s.layouts)) {
      if (!raw || typeof raw !== 'object') continue;
      const machineId = text(raw.machineId, 24);
      const layout = {
        ...raw,
        machineIds: machineId ? [machineId] : [],
        operationId: text(raw.operationId, 24),
      };
      delete layout.machineId;
      layouts.push(layout);
      byPair.set(machineId + ' ' + layout.operationId, layout);
    }

    for (const raw of list(s.assignments)) {
      if (!raw || typeof raw !== 'object') continue;
      const machineId = text(raw.machineId, 24);
      const operationId = text(raw.operationId, 24);
      const key = machineId + ' ' + operationId;
      let layout = byPair.get(key);
      if (!layout) {
        layout = {
          id: newId(),
          machineIds: machineId ? [machineId] : [],
          operationId,
          number: 0,
          notes: '',
          createdAt: raw.createdAt,
          updatedAt: raw.updatedAt,
        };
        layouts.push(layout);
        byPair.set(key, layout);
      }
      raw.layoutId = layout.id;
      // the cycles keep the machine they were taken on
      for (const run of list(raw.runs)) {
        if (run && typeof run === 'object') run.machineId = machineId;
      }
      delete raw.machineId;
      delete raw.operationId;
    }
    s.layouts = layouts;
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
    // ...one written before version 4 carries a typed cutting time...
    if (was < 4) s = fromVersion3(s);
    // ...and one written before version 7 has a layout per machine rather than
    // a layout the machines share.
    if (was < 7) s = fromVersion6(s);

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
    for (const raw of list(s.layouts)) {
      keep(shop.layouts, sanitizeLayout(raw, machineIds, operationIds), MAX_LAYOUTS);
    }
    numberLayouts(shop.layouts);
    const layoutIds = new Set(shop.layouts.map(l => l.id));
    for (const raw of list(s.assignments)) {
      keep(shop.assignments, sanitizeAssignment(raw, toolIds, layoutIds, machineIds), MAX_ASSIGNMENTS);
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
    maxCells: MAX_CELLS,
    maxMachines: MAX_MACHINES,
    maxTools: MAX_TOOLS,
    maxParts: MAX_PARTS,
    maxOperations: MAX_OPERATIONS,
    maxAssignments: MAX_ASSIGNMENTS,
    maxLayouts: MAX_LAYOUTS,
    maxLayoutMachines: MAX_LAYOUT_MACHINES,
    maxLayoutNumber: MAX_LAYOUT_NUMBER,
    maxRuns: MAX_RUNS,
    maxPocketRuns: MAX_POCKET_RUNS,
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
