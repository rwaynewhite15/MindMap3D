'use strict';

/* ================================================================
   Shopwatch — the shop-floor screen

   Six things, and the relations between them:

     a tool        its own part number, what it is, how many cutting edges
     a machine     what it is called on the floor
     a part        a part number being made
     an operation  one step in making that part — Op 10, Op 20. An operation
                   belongs to one part, because that is what an op is: a step
                   in making that part, not a name that means the same thing
                   everywhere.
     an assignment one tool, on one machine, doing one operation. This is the
                   many-to-many between tools and machines, and it carries what
                   is only true of that combination: the cycles timed against
                   it, how many of the tool's edges are indexed through there,
                   and how many parts run between one index and the next.
     a tool layout one machine and one operation — and since an operation
                   belongs to one part, that is machine-, part- and
                   operation-specific, which is what a tool layout is on the
                   floor: the tools set up together to cut it, in the order
                   they cut. It carries a number of its own, because that is
                   how it is asked for at the machine — run TL 12.

   The screen is arranged around the tool layout. The stopwatch times one
   assignment on it, because a cycle time is only ever true of one tool on one
   machine doing one op; the charts, the running order, the PDF and every total
   are per layout, and the same tool in the same machine cutting a different
   operation belongs to a different layout with its own cutting time — the time
   a tool spends in cut is a fact about the operation, not about the tool.

   Everything here lives inside the section the shell hands to mount(). The
   only way out of it is ctx: ctx.api for this add-on's own routes, ctx.me for
   who is signed in, ctx.go to move around inside this screen.
================================================================ */
(function () {
  const ID = 'manufacturing';

  /* ---------------- state ---------------- */
  let ctx = null;
  let host = null;          // the <section> the shell gave us
  let shop = null;          // { machines, tools, parts, operations, assignments, activeId }
  let limits = {
    maxMachines: 60, maxTools: 200, maxParts: 120,
    maxOperations: 300, maxAssignments: 200, maxRuns: 300,
  };
  let dirty = false;
  let saveTimer = null;
  let saveNote = '';        // what the next save did, for the document's chat
  let flashTimer = null;
  let filter = '';
  let form = null;          // { kind: 'machine' | 'tool' | 'part' | 'operation' | 'assignment', draft }
  let formError = '';
  let pendingPick = '';     // a record named by the URL, waiting on the shop to load
  let pendingImport = null; // a read CSV and what importing it would do, awaiting a yes
  let docs = { mine: [], shared: [] }; // every shopwatch this account can open
  let docsIn = false;       // the list has been fetched at least once
  let doc = null;           // the one open: title, visibility, owner, canEdit
  let wantDoc = '';         // a shopwatch named by the URL, before the list is in
  let live = null;          // EventSource for the open shopwatch
  let here = [];            // who else has it open
  let chat = [];            // what has been said about it
  let chatOpen = false;
  let tick = null;          // display interval while the watch runs
  const els = {};           // the panels render() refills

  // The stopwatch. Elapsed time is derived from wall-clock stamps rather than
  // counted up by the interval, so a phone that sleeps mid-cycle, a throttled
  // background tab, and a page reload all come back with the right time.
  // inCut / cutAccum / cutSince measure how much of the cycle the tool spends
  // actually cutting: the accumulated in-cut time this cycle, plus the stretch
  // running now. Marked by hand at the machine, because only the person
  // watching the spindle knows when the tool is in the material.
  let watch = { running: false, since: 0, accum: 0, lastLap: 0, laps: 0,
                inCut: false, cutAccum: 0, cutSince: 0 };

  // Two accounts sharing a phone at the bench do not share a stopwatch or each
  // other's folded lists, so what is kept on the device is kept under whoever
  // is signed in.
  const whoAmI = () => (ctx && ctx.me() ? ctx.me().username : '');
  const watchKey = () => 'mf.watch.' + whoAmI();

  function saveWatch() {
    try { localStorage.setItem(watchKey(), JSON.stringify(watch)); } catch { /* private mode */ }
  }
  function restoreWatch() {
    try {
      const raw = JSON.parse(localStorage.getItem(watchKey()) || 'null');
      if (raw && typeof raw === 'object' && Number.isFinite(raw.accum)) {
        watch = {
          running: !!raw.running,
          since: Number(raw.since) || 0,
          accum: Math.max(0, Number(raw.accum) || 0),
          lastLap: Math.max(0, Number(raw.lastLap) || 0),
          laps: Math.max(0, Number(raw.laps) || 0),
          inCut: !!raw.inCut,
          cutAccum: Math.max(0, Number(raw.cutAccum) || 0),
          cutSince: Number(raw.cutSince) || 0,
        };
        if (watch.inCut && watch.cutSince > Date.now()) watch.cutSince = Date.now();
        // a stamp from the future (clock change) would read as negative elapsed
        if (watch.running && watch.since > Date.now()) watch.since = Date.now();
      }
    } catch { /* nothing saved, or unreadable: start fresh */ }
  }

  const elapsed = () => watch.accum + (watch.running ? Date.now() - watch.since : 0);
  // Time in cut so far this cycle. Only accrues while the watch runs: a paused
  // watch is a paused cycle, and nothing is cutting through the pause.
  const cutElapsed = () =>
    watch.cutAccum + (watch.inCut && watch.running ? Date.now() - watch.cutSince : 0);

  /* ---------------- what is open ----------------
     Which headings are open is a view preference, not a shop record: it is
     about this screen on this device, so it lives beside the watch in local
     storage rather than being saved to the account and pushed onto every other
     device signed into it. It is held in memory too, because the lists are
     rebuilt from scratch on every save and a fold kept only in the DOM would
     spring open.

     What is stored is what has been *opened*, not what has been closed, so
     closed is the default and the screen opens as a page of headings — the
     floor at a glance, opened where you are working rather than everything at
     once. It also means a machine or a part added later arrives closed like
     everything else, instead of a list that quietly gets longer every week.
  ---------------------------------------------------------------- */
  let opened = new Set();

  const viewKey = () => 'mf.open.' + whoAmI();
  function saveOpened() {
    try { localStorage.setItem(viewKey(), JSON.stringify([...opened])); } catch { /* private mode */ }
  }
  function restoreOpened() {
    try {
      const raw = JSON.parse(localStorage.getItem(viewKey()) || '[]');
      opened = new Set(Array.isArray(raw) ? raw.filter(k => typeof k === 'string').slice(0, 400) : []);
    } catch { /* nothing saved, or unreadable: everything closed */ }
  }

  // A filter outranks a fold. Searching for something and being shown a closed
  // heading that contains it would be the screen hiding the answer it was just
  // asked for, so while a filter is on, everything is open.
  const isFolded = key => !filter && !opened.has(key);

  // The stopwatch folds through the same store and the same rule: closed until
  // somebody opens it, and it stays open from then on. The one difference is
  // that a filter does not open it — a running stopwatch is never the answer to
  // a search, and the clock is the tallest thing on the screen.
  const WATCH_OPEN = 'watch:open';
  const minimized = () => !opened.has(WATCH_OPEN);

  /* ---------------- whose device state this is ----------------
     Both of the above are kept under the signed-in name, and the shell hands
     that name over a moment after it opens the screen — so anything read at
     mount is read before there is a name to read it under, and a watch left
     running on this device would come back to a screen that had looked for it
     in the wrong place. This re-reads both the moment the name lands, and
     never again after that.

     What is already on this screen outranks what is in storage: if the watch
     has been started in that first moment, it stays started. A measurement
     somebody is taking is not something a key changing underneath it is
     allowed to throw away.
  ---------------------------------------------------------------- */
  let localFor = null;

  function restoreLocal() {
    const who = whoAmI();
    if (localFor === who) return;
    localFor = who;
    if (!watch.running && !watch.accum && !watch.laps) restoreWatch();
    restoreOpened();
    if (watch.running) startTick();   // a watch read back running has to tick
  }

  function toggleFold(key, redraw) {
    if (opened.has(key)) opened.delete(key);
    else opened.add(key);
    saveOpened();
    redraw();
  }

  /* ---------------- small helpers ---------------- */
  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function button(cls, text, onClick, title) {
    const b = el('button', cls, text);
    b.type = 'button';
    if (title) b.title = title;
    b.addEventListener('click', onClick);
    return b;
  }

  // Options may carry a group; consecutive options sharing one go inside an
  // <optgroup>, which is how a list of operations stays readable — the ops of
  // one part under that part's number.
  function dropdown(cls, options, value, onChange, label) {
    const s = el('select', cls);
    if (label) s.setAttribute('aria-label', label);
    let group = null;
    for (const o of options) {
      const opt = el('option', null, o.label);
      opt.value = o.value;
      if (o.value === value) opt.selected = true;
      if (o.group) {
        if (!group || group.label !== o.group) {
          group = el('optgroup');
          group.label = o.group;
          s.appendChild(group);
        }
        group.appendChild(opt);
      } else {
        group = null;
        s.appendChild(opt);
      }
    }
    s.addEventListener('change', () => onChange(s.value));
    return s;
  }

  // A heading that opens and closes what is under it. The mark and the title
  // are one button so the whole heading is the hit target, which leaves the
  // buttons beside it — + Tool here, Clone, Edit — doing their own jobs.
  function foldToggle(key, title, titleClass, redraw) {
    const open = !isFolded(key);
    const b = button('mf-fold', '', () => toggleFold(key, redraw),
      (open ? 'Hide ' : 'Show ') + title);
    b.setAttribute('aria-expanded', String(open));
    b.appendChild(el('span', 'mf-fold-mark', open ? '▾' : '▸'));
    b.appendChild(el('span', 'mf-fold-title ' + (titleClass || ''), title));
    return b;
  }

  // mm:ss.t — the shape a stopwatch reads in, at the tenth a hand can react to
  function fmtClock(ms) {
    const t = Math.max(0, Math.round(ms));
    const m = Math.floor(t / 60000);
    const s = Math.floor((t % 60000) / 1000);
    const d = Math.floor((t % 1000) / 100);
    return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0') + '.' + d;
  }
  const fmtSec = sec => fmtClock(sec * 1000);

  function fmtAgo(ts) {
    const mins = Math.floor((Date.now() - ts) / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return mins + ' min ago';
    const hours = Math.floor(mins / 60);
    if (hours < 24) return hours + ' h ago';
    const days = Math.floor(hours / 24);
    if (days < 30) return days + ' d ago';
    return new Date(ts).toLocaleDateString();
  }

  // Accepts "42.6", "1:23.4" or "1:23" — how a time gets read off a machine
  // or a wristwatch. Anything else is 0, which the caller rejects.
  function parseTime(str) {
    const m = String(str || '').trim().match(/^(?:(\d{1,3}):)?(\d{1,5}(?:\.\d{1,3})?)$/);
    if (!m) return 0;
    const sec = Number(m[2]);
    if (m[1] && sec >= 60) return 0; // 1:75 is a typo, not 2:15
    return (Number(m[1] || 0) * 60) + sec;
  }

  const round = (n, places) => {
    const f = Math.pow(10, places);
    return Math.round(n * f) / f;
  };

  const newId = prefix => prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

  /* ---------------- the record ----------------
     Five lists that only mean anything together. An assignment names a tool, a
     machine and an operation; an operation names the part it is a step of.
     Every reader below goes through these to get from one to another.
  ---------------------------------------------------------------- */
  const cellById = id => (shop && Array.isArray(shop.cells) ? shop.cells.find(c => c.id === id) || null : null);
  const toolById = id => (shop ? shop.tools.find(t => t.id === id) || null : null);
  const machineById = id => (shop ? shop.machines.find(m => m.id === id) || null : null);
  const partById = id => (shop ? shop.parts.find(p => p.id === id) || null : null);
  const operationById = id => (shop ? shop.operations.find(o => o.id === id) || null : null);
  const jobById = id => (shop ? shop.assignments.find(a => a.id === id) || null : null);
  const activeJob = () => (shop ? jobById(shop.activeId) : null);

  const toolName = t => (t ? t.desc || t.partNumber || 'Tool' : 'Tool');
  const machineName = id => {
    const m = machineById(id);
    return m ? m.name : 'No machine';
  };
  const partName = p => (p ? p.number || p.desc || 'Part' : 'Part');

  const jobTool = a => (a ? toolById(a.toolId) : null);
  const jobName = a => toolName(jobTool(a));
  const jobOperation = a => (a ? operationById(a.operationId) : null);
  const jobPart = a => {
    const op = jobOperation(a);
    return op ? partById(op.partId) : null;
  };

  // Every assignment of one tool, every assignment on one machine, and every
  // assignment doing one operation — the relations read from each end.
  /* ---------------- cells ----------------
     An area of the floor: the machines that work together, in the order the work
     flows through them. A machine belongs to one cell or to none — not every
     floor is laid out in cells, and one that is has machines standing outside
     them. The cell is where the value stream starts: a part crosses cells in the
     order its operations run, and that crossing is the map.
  ---------------------------------------------------------------- */
  const cellList = () => (shop && Array.isArray(shop.cells) ? shop.cells : []);
  const cellName = c => (c ? c.name : 'No cell');
  const byFlow = (a, b) => {
    const as = a.seq || Infinity, bs = b.seq || Infinity;
    if (as !== bs) return as - bs;
    return (a.name || '').localeCompare(b.name || '');
  };
  const allCells = () => [...cellList()].sort(byFlow);
  const cellOfMachine = id => {
    const m = machineById(id);
    return m && m.cellId ? cellById(m.cellId) : null;
  };
  const cellOfLayout = l => (l ? cellOfMachine(l.machineId) : null);
  // The machines of one cell, in the order the work moves through them.
  const machinesOfCell = id => (shop
    ? shop.machines.filter(m => m.cellId === id).sort((a, b) => {
      const as = a.cellSeq || Infinity, bs = b.cellSeq || Infinity;
      if (as !== bs) return as - bs;
      return a.name.localeCompare(b.name);
    })
    : []);
  const jobsOfCell = id => (shop
    ? shop.assignments.filter(a => { const c = cellOfMachine(a.machineId); return c && c.id === id; })
    : []);

  const jobsOfTool = id => (shop ? shop.assignments.filter(a => a.toolId === id) : []);
  const jobsOnMachine = id => (shop ? shop.assignments.filter(a => a.machineId === id) : []);
  const jobsOfOperation = id => (shop ? shop.assignments.filter(a => a.operationId === id) : []);
  const machinesOfTool = id => {
    const seen = new Set();
    return jobsOfTool(id).map(a => a.machineId).filter(m => (seen.has(m) ? false : seen.add(m)));
  };
  // How a machine is tooled: one tool in one station, however many operations
  // it cuts there. What a clone carries across.
  const distinctTools = id =>
    new Set(jobsOnMachine(id).map(a => a.toolId + ' ' + a.station.toLowerCase())).size;

  // The operations of one part, in the order they are run.
  const opsOfPart = id => (shop ? shop.operations.filter(o => o.partId === id).sort(byStep) : []);
  function byStep(a, b) {
    const as = a.seq || Infinity, bs = b.seq || Infinity;
    if (as !== bs) return as - bs;
    return (a.name || '').localeCompare(b.name || '');
  }

  // What a setup is for, as one line, and the whole address including the
  // machine it runs on.
  const operationLabel = op => {
    if (!op) return 'No operation set';
    return [partName(partById(op.partId)), op.name].filter(Boolean).join(' · ');
  };
  const jobLabel = a => operationLabel(jobOperation(a));
  const opLabel = a => [machineName(a.machineId), jobLabel(a)].join(' · ');

  /* ---------------- the tool layout ----------------
     The tools that run together: one machine, one operation. Since an
     operation belongs to one part, that pair is machine-, part- and
     operation-specific — a tool layout. It is the grouping the running order,
     both charts, the PDF and every total below are per, and it is why the
     cycle times live on the assignment: the same tool in the same machine on
     another op is on another layout, with another time.

     The pair is what a layout *is*, so it is derived. What is stored is the one
     thing about a layout that is a decision rather than a reading — the number
     the floor asks for it by — which lives in a record of its own, made and kept
     in step by ensureLayouts() below.
  ---------------------------------------------------------------- */
  const pairKey = (machineId, operationId) => machineId + '\u0000' + (operationId || '');
  const layoutKey = a => pairKey(a.machineId, a.operationId);
  const layoutJobs = a => (a && shop ? shop.assignments.filter(x => layoutKey(x) === layoutKey(a)).sort(bySeq) : []);

  const byNumber = (a, b) => (a.number || Infinity) - (b.number || Infinity);
  const layoutList = () => (shop && Array.isArray(shop.layouts) ? shop.layouts : []);
  const allLayouts = () => [...layoutList()].sort(byNumber);
  const layoutById = id => layoutList().find(l => l.id === id) || null;
  const layoutByKey = key => layoutList().find(l => pairKey(l.machineId, l.operationId) === key) || null;
  // A tool on a machine but on no operation is not on a layout: that is half a
  // pair, and half a pair has nothing to be the layout of.
  const layoutOf = a => (a && a.operationId ? layoutByKey(layoutKey(a)) : null);
  const layoutsOfOperation = id => layoutList().filter(l => l.operationId === id).sort(byNumber);
  const layoutJobsOf = l =>
    (l && shop ? shop.assignments.filter(a => layoutKey(a) === pairKey(l.machineId, l.operationId)).sort(bySeq) : []);
  // What it is called, and what it is: the number is the name it is asked for by
  // on the floor, and the machine, the part and the op are the address behind it.
  const tlName = l => 'TL ' + (l && l.number ? l.number : '–');
  const layoutWhere = l => {
    if (!l) return '';
    const cell = cellOfMachine(l.machineId);
    return [cell && cell.name, machineName(l.machineId),
      operationLabel(operationById(l.operationId))].filter(Boolean).join(' · ');
  };

  // Running order within a layout. An assignment with no sequence yet sorts
  // after the ones that have one, oldest first, so an unplaced tool lands at the
  // end of the list rather than jumping to the front of the job.
  function bySeq(a, b) {
    const as = a.seq || Infinity, bs = b.seq || Infinity;
    if (as !== bs) return as - bs;
    return (a.createdAt || 0) - (b.createdAt || 0);
  }

  // Close up the numbering of a layout after a move or a deletion, so the
  // sequence is always 1..n with no gaps and no ties.
  function renumberLayout(key) {
    shop.assignments.filter(x => layoutKey(x) === key).sort(bySeq).forEach((a, i) => {
      if (a.seq !== i + 1) { a.seq = i + 1; touch(a); }
    });
  }

  /* Every machine-and-operation pair with a tool on it is a tool layout, and
     every tool layout has a number no other layout in this shopwatch has. This
     is what holds both of those true after anything that can make or unmake a
     pair: a setup added, moved to another machine or another op, or deleted; a
     machine or a part cloned; a spreadsheet imported. The server does the same
     fill when it reads a record, so a floor saved before layouts existed opens
     already numbered and this only has to keep up with what happens on screen. */
  function ensureLayouts() {
    if (!shop) return;
    if (!Array.isArray(shop.layouts)) shop.layouts = [];
    const live = new Set();
    for (const a of shop.assignments) if (a.operationId) live.add(layoutKey(a));

    const seen = new Set();
    const taken = new Set();
    // A pair whose last tool has gone is not a tool layout any more, and its
    // number goes back in the pot.
    shop.layouts = shop.layouts.filter(l => {
      const key = pairKey(l.machineId, l.operationId);
      if (!live.has(key) || seen.has(key)) return false;
      seen.add(key);
      if (l.number && !taken.has(l.number)) taken.add(l.number);
      else l.number = 0;   // a number two layouts claim is nobody's; renumbered below
      return true;
    });

    let next = 1;
    const free = () => {
      while (taken.has(next)) next++;
      taken.add(next);
      return next;
    };
    for (const l of shop.layouts) if (!l.number) { l.number = free(); touch(l); }
    // New pairs are numbered machine by machine, and within a machine in the
    // order the ops run — the order somebody numbering them by hand would use.
    const now = Date.now();
    for (const key of [...live].filter(k => !seen.has(k)).sort(byAddress)) {
      const [machineId, operationId] = key.split('\u0000');
      shop.layouts.push({
        id: newId('l'), machineId, operationId, number: free(), notes: '',
        createdAt: now, updatedAt: now,
      });
    }
  }

  // Two layout keys in the order they would be read off the floor: by machine,
  // then by part, then by where the op falls in making it.
  function byAddress(x, y) {
    const [mx, ox] = x.split('\u0000');
    const [my, oy] = y.split('\u0000');
    const byMachine = machineName(mx).localeCompare(machineName(my));
    if (byMachine) return byMachine;
    const a = operationById(ox) || {}, b = operationById(oy) || {};
    const byPart = partName(partById(a.partId)).localeCompare(partName(partById(b.partId)));
    return byPart || byStep(a, b);
  }

  function statsFor(a) {
    const runs = (a && a.runs) || [];
    if (!runs.length) return null;
    let sum = 0, best = Infinity, worst = 0;
    let cutSum = 0, cutCount = 0, cutCycleSum = 0;
    for (const r of runs) {
      sum += r.sec;
      if (r.sec < best) best = r.sec;
      if (r.sec > worst) worst = r.sec;
      // Only cycles somebody actually marked in and out of cut count towards
      // the average: an unmarked cycle is no information, not zero seconds.
      // Their own cycle times are summed alongside, because time in cut only
      // means anything against the cycle it was measured in — averaged over
      // every cycle instead, an op mostly left unmarked can come out more than
      // 100% cut, which is arithmetic, not a measurement.
      if (r.cut > 0) { cutSum += r.cut; cutCount += 1; cutCycleSum += r.sec; }
    }
    return {
      count: runs.length,
      avg: sum / runs.length,
      best,
      worst,
      spread: worst - best,
      last: runs[0].sec, // runs are kept newest first
      cutCount,
      avgCut: cutCount ? cutSum / cutCount : 0,
      // The cycle the time in cut is a share of: the same cycles, averaged the
      // same way, so the share can never come out above one.
      avgCutCycle: cutCount ? cutCycleSum / cutCount : 0,
    };
  }

  // What one tool on one machine is expected to do on one operation, from the
  // two numbers that belong to that setup: the parts it runs between edge
  // indexes, and how many of the tool's edges get indexed through there. A
  // setup that leaves the edges blank falls back to the tool's own count — the
  // whole tool gets used up unless somebody says otherwise. Returns null until
  // there is a tool life to work from; `cut` is what was marked in and out
  // where anybody marked it, so the minutes are honest about where they came
  // from.
  function lifeFor(a, avgSec, avgCut) {
    const parts = a.partsPerIndex || 0;
    if (!parts) return null;
    const tool = jobTool(a);
    const edges = a.indexEdges || (tool ? tool.cuttingEdges : 0) || 0;
    const partsPerTool = edges ? parts * edges : 0;
    // Best available answer to "how long is this tool in cut on one part":
    // what was marked in and out at the machine, and failing that the whole
    // measured cycle — which is an overestimate, and says so.
    const cut = avgCut || avgSec || 0;
    const from = avgCut ? 'incut' : (avgSec ? 'cycle' : '');
    return {
      parts,
      edges,
      edgesFromTool: !a.indexEdges && !!edges,
      partsPerTool,
      edgeMin: cut ? (parts * cut) / 60 : 0,   // cutting minutes one edge lasts
      from,
      measured: from === 'cycle',              // the minutes came off the whole cycle
      per100: partsPerTool ? 100 / partsPerTool : 0,
      costPart: partsPerTool && tool && tool.cost ? tool.cost / partsPerTool : 0,
    };
  }

  /* ---------------- loading & saving ---------------- */
  const emptyShop = () =>
    ({ machines: [], tools: [], parts: [], operations: [], assignments: [], activeId: '' });
  const canEdit = () => !!(doc && doc.canEdit);
  // Somebody following a shared link with no account at all. The host serves
  // them one public shopwatch and nothing else, so the screen asks for nothing
  // else: no list, no live channel, no chat, and nothing that writes.
  const signedIn = () => !!(ctx && ctx.me());
  // A control that changes the floor. On a read-only screen it is not drawn at
  // all rather than drawn dead: a button that looks live and does nothing reads
  // as a broken app, not as a permission.
  const wBtn = (...args) => (canEdit() ? button(...args) : null);
  const put = (parent, node) => { if (node) parent.appendChild(node); };

  /* ---------------- the shopwatches ----------------
     A shopwatch is a document the app owns the sharing of: it belongs to an
     account, has a name, a privacy setting, people invited to edit it, a chat
     and a live channel. Everything below this line still works on one shop
     record — that record is now the document's body.
  ---------------------------------------------------------------- */
  async function loadDocs() {
    // With no account there is no list to fetch — only the one shopwatch the
    // address names, which the host will serve if it is public.
    if (!signedIn()) {
      docs = { mine: [], shared: [] };
      docsIn = true;
      const id = wantDoc;
      wantDoc = '';
      if (id) return openDoc(id);
      doc = null;
      shop = null;
      render();
      return;
    }
    try {
      const data = await ctx.api('/docs');
      docs = { mine: data.docs || [], shared: data.shared || [] };
    } catch (err) {
      flash('Your shopwatches could not be listed (' + err.message + ').');
      docs = { mine: [], shared: [] };
    }
    docsIn = true;
    const all = docs.mine.concat(docs.shared);
    // A shopwatch named in the address is opened whether or not it is in the
    // list: the list is what this account owns or was invited into, and a
    // public one is neither. The host answers 404 if it may not be seen, and
    // openDoc says so, rather than the screen quietly showing something else.
    if (wantDoc) {
      const id = wantDoc;
      wantDoc = '';
      return openDoc(id);
    }
    if (doc && all.some(d => d.id === doc.id)) return openDoc(doc.id);
    if (all.length) return openDoc(all[0].id);
    doc = null;
    shop = null;
    render();
  }

  async function openDoc(id) {
    if (dirty) flush();          // never leave a measured time behind
    stopLive();
    try {
      const data = await ctx.api('/docs/' + id);
      doc = data.doc;
      shop = data.body && data.body.assignments ? data.body : emptyShop();
      limits = (data.limits || limits);
      ensureLayouts();  // the host fills these in too; this covers an older one
    } catch (err) {
      doc = null;
      shop = null;
      flash('That shopwatch could not be opened (' + err.message + ').');
      render();
      return;
    }
    chat = [];
    here = [];
    try { ctx.go('d/' + doc.id); } catch { /* the shell owns the address bar */ }
    startLive();
    loadChat();
    if (pendingPick) {
      const id2 = pendingPick;
      pendingPick = '';
      const first = jobById(id2) || jobsOfTool(id2)[0];
      if (first) { selectJob(first.id); return; }
    }
    render();
  }

  function save() {
    if (!shop || !doc) return;
    if (!canEdit()) return;   // a viewer's screen never writes
    dirty = true;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(doSave, 700);
  }

  // A timed cycle is the one thing here that cannot be retyped from memory, so
  // it goes out at once rather than waiting on the debounce.
  function saveNow() {
    if (!shop) return;
    dirty = true;
    clearTimeout(saveTimer);
    doSave();
  }

  async function doSave() {
    if (!shop || !dirty || !doc || !canEdit()) return;
    try {
      await ctx.api('/docs/' + doc.id, 'PUT', { body: shop, note: saveNote });
      saveNote = '';
      dirty = false;
    } catch (err) {
      // keep the edit in memory and keep trying — on the floor this may be the
      // only copy of a time somebody just stood and measured
      flash('Not saved yet (' + err.message + '). Retrying.');
      clearTimeout(saveTimer);
      saveTimer = setTimeout(doSave, 4000);
    }
  }

  // Leaving the screen, or the page. keepalive lets the request outlive an
  // unload the way a queued beacon would.
  function flush() {
    clearTimeout(saveTimer);
    if (!shop || !dirty || !doc || !canEdit()) return;
    dirty = false;
    fetch('/api/plugins/' + ID + '/docs/' + doc.id, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: shop, note: saveNote }),
      keepalive: true,
    }).catch(() => { dirty = true; saveTimer = setTimeout(doSave, 4000); });
    saveNote = '';
  }

  /* ---------------- the live channel ----------------
     The same stream a shared map runs on: everyone with this shopwatch open
     gets each saved change, each message and the list of who is here. A
     measured cycle appears on the other phone as it is measured.
  ---------------------------------------------------------------- */
  function startLive() {
    stopLive();
    if (!doc || !signedIn()) return;
    try {
      live = new EventSource('/api/plugins/' + ID + '/docs/' + doc.id + '/live');
    } catch { return; } // no stream is a working screen, just not a live one
    live.addEventListener('hello', e => {
      try { here = (JSON.parse(e.data).users || []); } catch { here = []; }
      renderDocBar();
    });
    live.addEventListener('presence', e => {
      try { here = (JSON.parse(e.data).users || []); } catch { here = []; }
      renderDocBar();
    });
    live.addEventListener('doc', e => {
      let payload;
      try { payload = JSON.parse(e.data); } catch { return; }
      // An unsaved edit here outranks the one arriving: ours is going out in a
      // moment and will be broadcast in its turn. Whole-record replace is what
      // a shared map does too, so the last save wins either way.
      if (dirty || !payload.body) return;
      shop = payload.body;
      ensureLayouts();  // in memory only: whoever saved this has already saved theirs
      render();
    });
    live.addEventListener('chat', e => {
      try { chat.push(JSON.parse(e.data)); } catch { return; }
      if (chat.length > 400) chat.splice(0, chat.length - 400);
      renderChat();
      renderDocBar();
    });
    live.addEventListener('meta', e => {
      try {
        const m = JSON.parse(e.data);
        if (doc) { doc.title = m.title; doc.visibility = m.visibility; }
      } catch { /* leave what we have */ }
      renderDocBar();
    });
  }

  function stopLive() {
    if (live) { try { live.close(); } catch { /* already gone */ } }
    live = null;
    here = [];
  }

  async function loadChat() {
    if (!doc || !signedIn()) return;
    try {
      const data = await ctx.api('/docs/' + doc.id + '/chat');
      chat = data.chat || [];
    } catch { chat = []; }
    renderChat();
  }

  async function sendChat(text) {
    if (!doc || !text.trim()) return;
    try {
      await ctx.api('/docs/' + doc.id + '/chat', 'POST', { text });
      // our own message arrives back over the stream, so nothing is added here
    } catch (err) { flash('Not sent (' + err.message + ').'); }
  }

  // Most of these are corrections — something could not be done, or wants
  // doing first — and are coloured as such. A few are the opposite: the thing
  // asked for happened. Saying so in the same alarmed red would be a lie.
  function flash(message, done) {
    if (!els.flash) return;
    els.flash.textContent = message;
    els.flash.classList.toggle('mf-flash-done', !!done);
    els.flash.hidden = false;
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => { els.flash.hidden = true; }, 6000);
  }

  function touch(record) {
    record.updatedAt = Date.now();
  }

  /* ---------------- stopwatch ---------------- */
  function startStop() {
    if (!activeJob()) { flash('Pick a tool at a machine first — a cycle time belongs to one.'); return; }
    if (watch.running) {
      // bank whatever was cutting when the watch stopped, so the pause is not
      // counted as cutting time
      if (watch.inCut) { watch.cutAccum = cutElapsed(); watch.cutSince = 0; }
      watch.accum = elapsed();
      watch.running = false;
    } else {
      watch.since = Date.now();
      watch.running = true;
      if (watch.inCut) watch.cutSince = Date.now();   // still in cut: carry on counting
    }
    saveWatch();
    renderWatch();
    startTick();
  }

  // One part done: record the split since the last cycle and keep running.
  /* ---------------- in the cut, out of the cut ----------------
     The cycle a stopwatch measures is everything: rapids, the tool change,
     the bar feed, and the part of it that is actually cutting metal. Only the
     last one is the cutting time the tool life is worked out from, and nobody
     can read it off a cycle time afterwards — so it is marked as it happens,
     by whoever is watching the spindle.

     Marked in and out as many times as the tool enters and leaves within one
     cycle; the stretches add up. What accumulates goes onto the cycle when it
     is recorded, and the count starts again for the next one.
  ---------------------------------------------------------------- */
  function toggleCut() {
    if (!canEdit()) return;
    if (!activeJob()) { flash('Pick a tool at a machine first — time in cut belongs to one.'); return; }
    if (!watch.running) {
      flash('Start the watch first — time in cut is measured inside a cycle.');
      return;
    }
    if (watch.inCut) {
      watch.cutAccum = cutElapsed();
      watch.cutSince = 0;
      watch.inCut = false;
    } else {
      watch.cutSince = Date.now();
      watch.inCut = true;
    }
    saveWatch();
    renderWatch();
  }

  // Records the split since the last press. Says whether it recorded, because
  // the caller below only moves on when something was actually timed.
  function lap() {
    const a = activeJob();
    if (!a) { flash('Pick a tool at a machine first — a cycle time belongs to one.'); return false; }
    if (!watch.running && !watch.accum) { flash('Start the watch, then mark each cycle as it finishes.'); return false; }
    const now = elapsed();
    const cycle = (now - watch.lastLap) / 1000;
    if (cycle < 0.2) return false; // a double-tap is not a cycle
    const cut = cutElapsed() / 1000;
    watch.lastLap = now;
    watch.laps += 1;
    // This cycle's cut is spent; the next one starts from nothing. A tool still
    // in the cut as the cycle turns over keeps counting into the new one.
    watch.cutAccum = 0;
    if (watch.inCut) watch.cutSince = Date.now();
    saveWatch();
    addRun(a, round(cycle, 2), 0, round(Math.min(cut, cycle), 2));
    renderWatch();
    return true;
  }

  /* ---------------- down the op, tool by tool ----------------
     An operation is a run of tools cutting one after another, and what you
     want at the machine is each one's share of the cycle. This is the press
     for that: it records the split against the tool that has just finished
     cutting and moves the watch to the next tool in the running order,
     without stopping — so the next split begins the moment the last one ends,
     which is what actually happens at the spindle.

     Past the last tool it comes back to the first, because that is what the
     machine does: down the op is one part, and the next part starts again at
     tool 1. Nothing is recorded by the move itself; a press that times
     nothing (the watch not running, or a double tap) moves nothing either.
  ---------------------------------------------------------------- */
  function lapNext() {
    const a = activeJob();
    if (!a) { flash('Pick a tool at a machine first — a cycle time belongs to one.'); return; }
    const order = layoutJobs(a);
    // one tool in the op: there is nowhere to move on to, so this is a cycle
    if (order.length < 2) { lap(); return; }
    if (!lap()) return;
    const i = order.findIndex(x => x.id === a.id);
    selectJob(order[(i + 1) % order.length].id, true);   // the watch runs on
  }

  function reset() {
    watch = { running: false, since: 0, accum: 0, lastLap: 0, laps: 0,
      inCut: false, cutAccum: 0, cutSince: 0 };
    saveWatch();
    stopTick();
    renderWatch();
  }

  function addRun(a, sec, at, cut) {
    if (!sec) return;
    // Time in cut is part of the cycle, so it can never be more than one.
    const inCut = cut && cut > 0 ? Math.min(cut, sec) : 0;
    a.runs.unshift({ id: newId('r'), sec, cut: inCut, at: at || Date.now(), note: '' });
    if (a.runs.length > limits.maxRuns) a.runs.length = limits.maxRuns;
    touch(a);
    // what the others in this shopwatch see happen, in their chat
    saveNote = 'timed ' + jobName(a) + ' at ' + fmtSec(sec) + ' on ' + machineName(a.machineId);
    saveNow();
    renderStats();
    renderRuns();
    renderChart();    // this tool's share of the layout just moved
    renderCutChart(); // and so did how much of its cycle was cutting
    renderStream();   // and the step that layout is in the part's route
    renderParts();    // as did the operation's measured cycle
    renderMachines(); // and its average, on its card
  }

  function startTick() {
    stopTick();
    if (!watch.running) return;
    // A tenth on the display; the interval only reads the clock, so a slow or
    // throttled tick shows a stale number rather than a wrong one.
    tick = setInterval(() => {
      if (els.time) els.time.textContent = fmtClock(elapsed());
      if (els.cutline) {
        els.cutline.textContent =
          (watch.inCut ? 'In cut · ' : 'Out of cut · ') + fmtClock(cutElapsed()) + ' this cycle';
      }
    }, 100);
  }
  function stopTick() {
    clearInterval(tick);
    tick = null;
  }

  /* ---------------- the shopwatch bar ----------------
     Which shopwatch is open, who else is in it, and — for whoever owns it —
     who may see it and who may type in it.
  ---------------------------------------------------------------- */
  const VISIBILITIES = [
    ['private', 'Private', 'Only you, and anyone you invite to edit'],
    ['friends', 'Friends', 'Your friends can open it, and it goes to their feed'],
    ['public', 'Everyone', 'Anyone can open it, and it can be discovered'],
  ];

  function renderDocBar() {
    const box = els.docbar;
    box.innerHTML = '';
    // With nothing open there is no bar to draw.
    if (!shop && !doc) { box.hidden = true; return; }
    box.hidden = false;

    const row = el('div', 'mf-docbar-row');
    const all = docs.mine.concat(docs.shared);
    // whatever is open belongs in the switcher, including one opened from a
    // link that this account neither owns nor was invited into
    if (doc && !all.some(d => d.id === doc.id)) all.push(doc);
    if (all.length > 1) {
      row.appendChild(dropdown('mf-docpick', all.map(d => ({
        value: d.id,
        label: d.title + (d.mine ? '' : ' — ' + (d.owner ? '@' + d.owner.username : 'shared')),
      })), doc ? doc.id : '', id => openDoc(id), 'Shopwatch'));
    } else if (doc) {
      row.appendChild(el('div', 'mf-doctitle', doc.title));
    }

    if (doc) {
      const tag = el('span', 'mf-doctag', doc.mine
        ? VISIBILITIES.find(v => v[0] === doc.visibility)[1]
        : 'from @' + doc.owner.username + (doc.canEdit ? ' · you can edit' : ' · read only'));
      tag.title = doc.mine
        ? VISIBILITIES.find(v => v[0] === doc.visibility)[2]
        : (doc.canEdit ? 'You were invited to edit this' : 'You can watch, but not change it');
      row.appendChild(tag);
    }

    const btns = el('div', 'mf-docbar-btns');
    if (!signedIn()) {
      // Shared by a link, read by somebody with no account: say whose floor it
      // is and what could be done with one of their own, and stop there.
      const join = el('a', 'mf-link');
      join.href = '#/signin';
      join.textContent = 'Sign in to keep your own';
      btns.appendChild(join);
      row.appendChild(btns);
      box.appendChild(row);
      return;
    }
    btns.appendChild(button('mf-btn mf-btn-sm', '+ Shopwatch', newDoc, 'Start another one, empty'));
    if (doc && doc.mine) {
      btns.appendChild(button('mf-btn mf-btn-sm', 'Share', () => openShare(),
        'Who can see this shopwatch, and who can change it'));
    }
    // The same move under two names: taking somebody else's floor into your
    // own shopwatches, and standing a second one up beside your own — a new
    // bay, a what-if, a copy to hand over. The second used to need a round
    // trip through a spreadsheet for want of a button.
    if (doc) {
      btns.appendChild(doc.mine
        ? button('mf-btn mf-btn-sm', 'Duplicate', copyDoc,
          'A second shopwatch holding everything this one holds, private to you')
        : button('mf-btn mf-btn-sm', 'Save a copy', copyDoc,
          'Take a copy of this into your own shopwatches'));
    }
    if (doc) {
      const label = '💬' + (chat.length ? ' ' + chat.length : '') +
        (here.length > 1 ? ' · ' + here.length + ' here' : '');
      btns.appendChild(button('mf-btn mf-btn-sm' + (chatOpen ? ' mf-btn-lap' : ''), label,
        () => { chatOpen = !chatOpen; renderChat(); renderDocBar(); },
        'Chat with whoever else is in this shopwatch'));
    }
    row.appendChild(btns);
    box.appendChild(row);

  }

  // Made and opened without asking anything: the caller already has the name.
  async function createDoc(title, seedBody) {
    try {
      const made = await ctx.api('/docs', 'POST',
        seedBody ? { title, body: seedBody } : { title });
      docs.mine.push(made.doc);
      await openDoc(made.doc.id);
      return doc;
    } catch (err) { flash('Not created (' + err.message + ').'); return null; }
  }

  async function newDoc(seedBody, seedTitle) {
    const title = prompt('What is this shopwatch called?',
      seedTitle || (docs.mine.length ? 'Shop floor ' + (docs.mine.length + 1) : 'Shop floor'));
    if (title === null) return null;
    const made = await createDoc(title.trim() || 'Shop floor', seedBody);
    if (made) flash(made.title + ' is yours and private. Share sets who else can see it.', true);
    return made;
  }

  // The buttons along the top act on the open shopwatch. With none open they
  // make one first and then do what was asked, rather than doing nothing.
  function withDoc(fn) {
    return async (...args) => {
      if (!signedIn()) return;          // a reader with no account writes nothing
      if (!doc) {
        if (!docsIn) return;            // still listing; this wakes up in a moment
        if (!await newDoc()) return;    // they cancelled the name
      }
      fn(...args);
    };
  }

  async function copyDoc() {
    if (!doc) return;
    // openDoc replaces `doc`, so what it was has to be read first
    const wasMine = doc.mine, from = doc.title;
    try {
      const made = await ctx.api('/docs/' + doc.id + '/copy', 'POST');
      docs.mine.push(made.doc);
      await openDoc(made.doc.id);
      flash(wasMine
        ? made.doc.title + ' holds everything ' + from + ' holds — the parts, the machines, ' +
          'the tool crib and every cycle timed. Changing one leaves the other alone.'
        : 'Copied into your own shopwatches, private to you.', true);
    } catch (err) { flash('Not copied (' + err.message + ').'); }
  }

  /* ---------------- sharing ----------------
     Two separate questions, asked separately because they have different
     answers: who may open this, and who may change it. A privacy tier is a
     broadcast; an editor is an invitation, and it overrides the tier — that is
     how you share a private shopwatch with the one person setting the job.
  ---------------------------------------------------------------- */
  let sharePanel = false;
  let shareEditors = null;   // names, once fetched

  async function openShare() {
    sharePanel = !sharePanel;
    if (sharePanel && doc && shareEditors === null) {
      try {
        const data = await ctx.api('/docs/' + doc.id + '/editors');
        shareEditors = (data.editors || []).map(e => e.username);
      } catch { shareEditors = []; }
    }
    renderShare();
  }

  function renderShare() {
    const box = els.share;
    box.innerHTML = '';
    box.hidden = !(sharePanel && doc && doc.mine);
    if (box.hidden) return;

    box.appendChild(el('div', 'mf-section-title', 'Share ' + doc.title));

    const name = el('label', 'mf-field mf-field-wide');
    name.appendChild(el('span', 'mf-field-k', 'Name'));
    const input = el('input', 'mf-input');
    input.value = doc.title;
    input.addEventListener('change', () => saveMeta({ title: input.value }));
    name.appendChild(input);
    box.appendChild(name);

    box.appendChild(el('div', 'mf-field-k', 'Who can open it'));
    for (const [value, label, blurb] of VISIBILITIES) {
      const opt = el('label', 'mf-check');
      const radio = el('input');
      radio.type = 'radio';
      radio.name = 'mf-vis';
      radio.checked = doc.visibility === value;
      radio.addEventListener('change', () => saveMeta({ visibility: value }));
      opt.appendChild(radio);
      const text = el('span');
      text.appendChild(el('b', null, label));
      text.appendChild(document.createTextNode(' — ' + blurb));
      opt.appendChild(text);
      box.appendChild(opt);
    }
    if (doc.visibility !== 'private') {
      box.appendChild(el('div', 'mf-note',
        'It carries everything in it: the parts and their operations, the machines, ' +
        'the crib, every setup and every cycle timed against them.'));
    }

    box.appendChild(el('div', 'mf-field-k mf-share-gap', 'Who can change it'));
    const who = el('label', 'mf-field mf-field-wide');
    const editors = el('input', 'mf-input');
    editors.placeholder = 'usernames, separated by commas';
    editors.value = (shareEditors || []).join(', ');
    who.appendChild(editors);
    who.appendChild(el('span', 'mf-field-hint',
      'They can open it however it is set, time cycles in it and chat here — even when it is private.'));
    box.appendChild(who);

    const btns = el('div', 'mf-form-btns');
    btns.appendChild(button('mf-btn mf-btn-go', 'Save editors', async () => {
      const usernames = editors.value.split(',').map(x => x.trim().replace(/^@/, '')).filter(Boolean);
      try {
        const data = await ctx.api('/docs/' + doc.id + '/editors', 'PUT', { usernames });
        shareEditors = (data.editors || []).map(e => e.username);
        renderShare();
        const missing = (data.missing || []).length;
        flash(missing
          ? 'Saved. No account called ' + data.missing.join(', ') + '.'
          : 'Saved — ' + shareEditors.length + (shareEditors.length === 1 ? ' person' : ' people') + ' can change this.',
        !missing);
      } catch (err) { flash('Not saved (' + err.message + ').'); }
    }));
    btns.appendChild(button('mf-btn mf-btn-quiet', 'Copy link', () => {
      const url = location.origin + '/#/p/' + ID + '/d/' + doc.id;
      navigator.clipboard.writeText(url)
        .then(() => flash('Link copied. Whoever opens it still has to be allowed to see it.', true))
        .catch(() => flash(url));
    }));
    btns.appendChild(button('mf-btn mf-btn-quiet', 'Close', () => { sharePanel = false; renderShare(); }));
    btns.appendChild(button('mf-btn mf-btn-danger', 'Delete shopwatch', deleteDoc));
    box.appendChild(btns);
    box.scrollIntoView({ block: 'nearest' });
  }

  async function saveMeta(patch) {
    if (!doc) return;
    try {
      const data = await ctx.api('/docs/' + doc.id + '/meta', 'PUT', patch);
      doc = data.doc;
      const i = docs.mine.findIndex(d => d.id === doc.id);
      if (i >= 0) docs.mine[i] = doc;
      renderDocBar();
      renderShare();
    } catch (err) { flash('Not saved (' + err.message + ').'); }
  }

  async function deleteDoc() {
    if (!doc) return;
    const cycles = shop ? shop.assignments.reduce((n, a) => n + a.runs.length, 0) : 0;
    if (!confirm('Delete ' + doc.title + ' and everything in it' +
      (cycles ? ', including the ' + cycles + (cycles === 1 ? ' cycle' : ' cycles') + ' timed in it' : '') +
      '? Anyone you shared it with loses it too.')) return;
    try {
      await ctx.api('/docs/' + doc.id, 'DELETE');
      docs.mine = docs.mine.filter(d => d.id !== doc.id);
      sharePanel = false;
      doc = null;
      shop = null;
      stopLive();
      await loadDocs();
      flash('Deleted.', true);
    } catch (err) { flash('Not deleted (' + err.message + ').'); }
  }

  /* ---------------- the chat ---------------- */
  function renderChat() {
    const box = els.chat;
    box.innerHTML = '';
    box.hidden = !(chatOpen && doc);
    if (box.hidden) return;

    const head = el('div', 'mf-section-head');
    head.appendChild(el('div', 'mf-section-title', 'Chat'));
    if (here.length) {
      head.appendChild(el('span', 'mf-fold-count',
        here.length + (here.length === 1 ? ' here' : ' here')));
    }
    box.appendChild(head);

    const list = el('div', 'mf-chat-list');
    if (!chat.length) {
      list.appendChild(el('div', 'mf-note',
        'Nothing said yet. Whoever else has this shopwatch open sees what is typed here, ' +
        'and what anybody changes is logged alongside it.'));
    }
    for (const entry of chat) {
      const line = el('div', 'mf-chat-line' + (entry.kind === 'activity' ? ' mf-chat-act' : ''));
      const who = (entry.actor && (entry.actor.name || '@' + entry.actor.username)) || 'someone';
      line.appendChild(el('span', 'mf-chat-who', who));
      line.appendChild(el('span', 'mf-chat-text', entry.text));
      line.appendChild(el('span', 'mf-chat-at', fmtAgo(entry.ts)));
      list.appendChild(line);
    }
    box.appendChild(list);
    list.scrollTop = list.scrollHeight;

    if (!canEdit()) {
      box.appendChild(el('div', 'mf-note', 'Only people who can change this shopwatch can chat in it.'));
      return;
    }
    const row = el('div', 'mf-addtime mf-chat-say');
    const input = el('input', 'mf-input');
    input.placeholder = 'Say something to whoever else is in here';
    input.setAttribute('aria-label', 'Message');
    const send = () => {
      const text = input.value.trim();
      if (!text) return;
      input.value = '';
      sendChat(text);
    };
    input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); send(); } });
    row.appendChild(input);
    row.appendChild(button('mf-btn mf-btn-sm', 'Send', send));
    box.appendChild(row);
  }

  /* ---------------- rendering ---------------- */
  function render() {
    restoreLocal();   // the signed-in name may only just have arrived
    renderDocBar();
    renderShare();
    renderChat();
    renderImport();
    renderWatch();
    renderStats();
    renderRuns();
    renderForm();
    renderChart();
    renderCutChart();
    renderStream();
    renderSearch();
    renderParts();
    renderMachines();
    renderTools();
  }

  function renderWatch() {
    const box = els.watch;
    box.innerHTML = '';
    if (!shop && !doc) {
      const empty = el('div', 'mf-empty');
      // What it is and what to do, in two lines. An empty screen is not the
      // place to make a case for the thing the operator has already opened.
      empty.appendChild(el('div', 'mf-empty-title', 'No shopwatch open'));
      empty.appendChild(el('div', 'mf-empty-text',
        'A shopwatch holds one floor: its parts and their operations, its machines, its tool crib ' +
        'and every cycle timed against them. New ones are private until shared.'));
      empty.appendChild(button('mf-btn mf-btn-go', '+ New shopwatch', () => newDoc()));
      box.appendChild(empty);
      return;
    }
    if (!shop) { box.appendChild(el('div', 'mf-loading', 'Loading your shop…')); return; }
    const a = activeJob();

    if (!a) {
      const empty = el('div', 'mf-empty');
      const started = shop.tools.length || shop.machines.length || shop.parts.length;
      empty.appendChild(el('div', 'mf-empty-title', shop.assignments.length
        ? 'Pick a tool to time'
        : (started ? 'Set a tool up on a machine' : 'Start with a part, a machine and a tool')));
      empty.appendChild(el('div', 'mf-empty-text', shop.assignments.length
        ? 'A cycle time is recorded against one tool, on one machine, on one operation. Choose the one at the spindle before starting the watch.'
        : 'A tool set up on a machine for one operation is what the watch records against, and what carries the edges indexed there and the parts run between indexes.'));
      const row = el('div', 'mf-form-btns');
      if (!shop.parts.length) row.appendChild(button('mf-btn mf-btn-go', '+ Add a part', () => openForm('part')));
      if (!shop.machines.length) row.appendChild(button('mf-btn', '+ Add a machine', () => openForm('machine')));
      if (!shop.tools.length) row.appendChild(button('mf-btn', '+ Add a tool', () => openForm('tool')));
      if (shop.operations.length && shop.machines.length && shop.tools.length && !shop.assignments.length) {
        row.appendChild(button('mf-btn mf-btn-go', '+ Set up a tool', () => openForm('assignment')));
      }
      if (row.childNodes.length) empty.appendChild(row);
      box.appendChild(empty);
      return;
    }

    const small = canEdit() && minimized();
    box.classList.toggle('mf-running', watch.running);
    box.classList.toggle('mf-watch-small', small);

    // which tool layout, which tool, at which machine, on which operation
    const layout = layoutOf(a);
    const head = el('div', 'mf-watch-head');
    const who = el('div', 'mf-watch-who');
    const title = el('div', 'mf-watch-title');
    if (layout) title.appendChild(tlChip(layout));
    if (a.seq) title.appendChild(el('span', 'mf-seq', String(a.seq)));
    if (a.station) title.appendChild(el('span', 'mf-chip', a.station));
    title.appendChild(el('span', 'mf-watch-name', jobName(a)));
    const tool = jobTool(a);
    if (tool && tool.partNumber && tool.desc) title.appendChild(el('span', 'mf-watch-pn', tool.partNumber));
    who.appendChild(title);
    const where = el('div', 'mf-watch-op', opLabel(a));
    // where in the layout's running order this tool sits
    const order = layoutJobs(a);
    if (a.seq && order.length > 1) where.textContent += ' · tool ' + a.seq + ' of ' + order.length;
    who.appendChild(where);
    head.appendChild(who);
    if (canEdit()) {
      head.appendChild(button('mf-btn mf-btn-sm', 'Edit setup', () => openForm('assignment', a.id),
        'The operation, edges and tool life of this tool on this machine'));
      // Folding the watch away is only offered to whoever has one. It keeps
      // running either way — see minimized() for where the state lives.
      head.appendChild(button('mf-min', small ? '▸' : '▾', () => toggleFold(WATCH_OPEN, renderWatch),
        small ? 'Open the stopwatch' : 'Fold the stopwatch down to a bar — it keeps running'));
    }
    box.appendChild(head);

    // A reader has no watch. The clock would sit at zero and never move, which
    // reads as a broken app rather than as a permission — the same reason none
    // of the controls are drawn. What the panel is for them is which setup they
    // are looking at; the numbers below it are the point.
    if (!canEdit()) {
      stopTick();
      els.time = null;
      els.cutline = null;
      box.classList.remove('mf-running');
      if (shop.assignments.length > 1) {
        box.appendChild(dropdown('mf-pick', jobOptions(), a.id, selectJob, 'Setup being shown'));
      }
      return;
    }

    /* ---------------- folded down to a bar ----------------
       The clock is 84 pixels tall because it has to be read from an arm's
       length at the machine. Sitting at the bench with the layout open below
       it, that is most of a phone screen spent on a number you are not looking
       at — so the watch folds down to one line: the time, and the presses a
       cycle actually needs. It is not stopped, paused or reset by folding; the
       stopwatch is measuring something, and hiding the display is not a reason
       to throw the measurement away. The keys still work, and the panel still
       goes amber while it runs.
    ---------------------------------------------------------------- */
    if (small) {
      els.cutline = null;
      els.time = el('div', 'mf-time-sm', fmtClock(elapsed()));
      const row = el('div', 'mf-watch-min');
      row.appendChild(els.time);
      const btns = el('div', 'mf-watch-min-btns');
      btns.appendChild(button('mf-btn mf-btn-sm mf-btn-cut' + (watch.inCut ? ' mf-btn-cutting' : ''),
        watch.inCut ? '◼ In cut' : '◻ Cut', toggleCut,
        watch.inCut
          ? 'The tool is in the material — press as it comes out (C)'
          : 'Press as the tool enters the material (C)'));
      btns.appendChild(button('mf-btn mf-btn-sm mf-btn-go' + (watch.running ? ' mf-btn-stop' : ''),
        watch.running ? 'Stop' : (watch.accum ? 'Resume' : 'Start'), startStop,
        'Space starts and stops the watch'));
      if (order.length > 1) {
        btns.appendChild(button('mf-btn mf-btn-sm mf-btn-lap', 'Tool done →', lapNext,
          'Records this tool\'s time and moves the watch to the next one, without stopping (N)'));
      }
      btns.appendChild(button('mf-btn mf-btn-sm mf-btn-lap', 'Cycle done', lap,
        'Records the time since the last cycle and keeps the watch running (L)'));
      row.appendChild(btns);
      box.appendChild(row);
      return;
    }

    els.time = el('div', 'mf-time', fmtClock(elapsed()));
    box.appendChild(els.time);

    const line = el('div', 'mf-lapline');
    const last = a.runs.length ? a.runs[0] : null;
    line.textContent = watch.laps
      ? watch.laps + (watch.laps === 1 ? ' cycle this run' : ' cycles this run') +
        (last ? ' · last ' + fmtSec(last.sec) : '')
      : (last ? 'Last recorded cycle ' + fmtSec(last.sec) : 'No cycles recorded yet');
    box.appendChild(line);

    // What has been marked as cutting so far in the cycle running now. Its own
    // line, updating with the clock, so the person at the machine can see the
    // toggle is doing something without waiting for the cycle to end.
    if (watch.inCut || watch.cutAccum) {
      els.cutline = el('div', 'mf-cutline' + (watch.inCut ? ' mf-cutting' : ''),
        (watch.inCut ? 'In cut · ' : 'Out of cut · ') + fmtClock(cutElapsed()) + ' this cycle');
      box.appendChild(els.cutline);
    } else {
      els.cutline = null;
    }

    // The watch records against this setup, so it is only drawn for somebody
    // who may record. A reader gets the numbers without controls that would
    // look live and do nothing.
    if (canEdit()) {
      // Its own row, full width, above the rest: inside one cycle this is the
      // press that happens most, it is a state rather than an action, and at
      // the machine it has to be hit without looking.
      const cutRow = el('div', 'mf-cut-row');
      cutRow.appendChild(button('mf-btn mf-btn-cut' + (watch.inCut ? ' mf-btn-cutting' : ''),
        watch.inCut ? '◼ In cut — press when it comes out' : '◻ Mark in cut', toggleCut,
        watch.inCut
          ? 'The tool is in the material — press as it comes out (C)'
          : 'Press as the tool enters the material; the stretches add up over the cycle (C)'));
      box.appendChild(cutRow);

      const btns = el('div', 'mf-watch-btns');
      btns.appendChild(button('mf-btn mf-btn-go' + (watch.running ? ' mf-btn-stop' : ''),
        watch.running ? 'Stop' : (watch.accum ? 'Resume' : 'Start'), startStop,
        'Space starts and stops the watch'));
      // Only where there is a next tool to move to. On a one-tool op it would
      // be the same press as Cycle done under a name that promises more.
      if (order.length > 1) {
        const next = order[(order.findIndex(x => x.id === a.id) + 1) % order.length];
        btns.appendChild(button('mf-btn mf-btn-lap', 'Tool done →', lapNext,
          'Records this tool\'s time and moves the watch to ' + jobName(next) +
          ', without stopping (N)'));
      }
      btns.appendChild(button('mf-btn mf-btn-lap', 'Cycle done', lap,
        'Records the time since the last cycle and keeps the watch running (L)'));
      btns.appendChild(button('mf-btn mf-btn-quiet', 'Reset', reset, 'Back to zero, keeping every recorded cycle (R)'));
      box.appendChild(btns);
    }

    if (shop.assignments.length > 1) {
      box.appendChild(dropdown('mf-pick', jobOptions(), a.id, selectJob, 'Tool being timed'));
    }
  }

  /* Every setup there is, under the tool layout it is on. A list of tools is
     unreadable without saying which layout each is part of — the same insert
     runs on three of them — so the layouts are the headings and the tools sit
     under theirs in the order they cut. */
  function jobOptions() {
    const groups = new Map();
    for (const a of shop.assignments) {
      const key = layoutKey(a);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(a);
    }
    const opts = [];
    const heading = (key, jobs) => {
      const l = layoutByKey(key);
      return l ? tlName(l) + ' — ' + layoutWhere(l)
        : machineName(jobs[0].machineId) + ' — no operation set';
    };
    // Numbered layouts first and in number order; the tools that are on a
    // machine but on no operation are not a layout, and go last.
    const keys = [...groups.keys()].sort((x, y) => {
      const lx = layoutByKey(x), ly = layoutByKey(y);
      if (lx && ly) return byNumber(lx, ly);
      if (lx || ly) return lx ? -1 : 1;
      return heading(x, groups.get(x)).localeCompare(heading(y, groups.get(y)));
    });
    for (const key of keys) {
      const jobs = groups.get(key).sort(bySeq);
      const group = heading(key, jobs);
      for (const a of jobs) {
        opts.push({ value: a.id, label: (a.seq ? a.seq + '. ' : '') + jobName(a), group });
      }
    }
    return opts;
  }

  // The number a layout is asked for by, and the way in to changing it: the
  // number is the first thing anybody wants to change about a layout, and there
  // is nowhere else it would go.
  function tlChip(l, cls) {
    const extra = cls ? ' ' + cls : '';
    if (!canEdit()) {
      const chip = el('span', 'mf-tl' + extra, tlName(l));
      chip.title = layoutWhere(l);
      return chip;
    }
    return button('mf-tl mf-tl-btn' + extra, tlName(l), e => {
      if (e && e.stopPropagation) e.stopPropagation();
      openForm('layout', l.id);
    }, 'Number this tool layout — ' + layoutWhere(l));
  }

  function tile(label, value, hint) {
    const d = el('div', 'mf-tile');
    d.appendChild(el('div', 'mf-tile-v', value));
    d.appendChild(el('div', 'mf-tile-k', label));
    if (hint) d.title = hint;
    return d;
  }

  function renderStats() {
    const box = els.stats;
    box.innerHTML = '';
    const a = activeJob();
    if (!a) return;
    const s = statsFor(a);

    if (!a.operationId) {
      const note = el('div', 'mf-note');
      note.appendChild(document.createTextNode(
        'This tool is on the machine but not on an operation, so it is on no tool layout. The cycle ' +
        'times and the tool life belong to the op it is cutting, so name it. '));
      note.appendChild(button('mf-link', 'Edit setup', () => openForm('assignment', a.id)));
      box.appendChild(note);
    }

    if (s) {
      const timing = el('div', 'mf-tiles');
      timing.appendChild(tile('cycles timed', String(s.count)));
      timing.appendChild(tile('average', fmtSec(s.avg)));
      timing.appendChild(tile('best', fmtSec(s.best)));
      timing.appendChild(tile('spread', fmtSec(s.spread), 'Slowest cycle minus fastest — how repeatable this tool is here'));
      if (s.avgCut) {
        timing.appendChild(tile('time in cut', fmtSec(s.avgCut),
          'Measured at the machine, averaged over the ' + s.cutCount +
          (s.cutCount === 1 ? ' cycle' : ' cycles') + ' marked in and out of cut'));
      }
      box.appendChild(timing);
      // What was marked in cut, against the cycles it was marked in — and so
      // what the rest of those cycles went on, which is the number worth
      // knowing.
      if (s.avgCut && s.avgCutCycle) {
        const share = Math.round((s.avgCut / s.avgCutCycle) * 100);
        box.appendChild(el('div', 'mf-note',
          'Measured in cut for ' + fmtSec(s.avgCut) + ' of a ' + fmtSec(s.avgCutCycle) +
          ' cycle — ' + share + '% of it is cut, over ' + s.cutCount +
          (s.cutCount === 1 ? ' marked cycle' : ' marked cycles') + '. The other ' +
          fmtSec(s.avgCutCycle - s.avgCut) + ' is rapids, the tool change and the bar feed.'));
      } else if (s.count) {
        box.appendChild(el('div', 'mf-note',
          'Nothing marked in cut on this tool yet. Mark it in and out as it cuts and the ' +
          'part of the cycle actually making chips separates from the part that is not.'));
      }
    } else {
      box.appendChild(el('div', 'mf-note',
        'Time a few cycles and the averages, and how much of the cycle is cut, fall out of them.'));
    }

    const life = lifeFor(a, s ? s.avg : 0, s ? s.avgCut : 0);
    if (!life) {
      const note = el('div', 'mf-note');
      note.appendChild(document.createTextNode(
        'Add the parts this tool runs between edge indexes and the tool-life numbers appear here. '));
      note.appendChild(button('mf-link', 'Edit setup', () => openForm('assignment', a.id)));
      box.appendChild(note);
      return;
    }

    const derived = el('div', 'mf-tiles mf-tiles-life');
    derived.appendChild(tile('parts / index', String(life.parts),
      'Parts run between one edge index and the next, on this tool layout'));
    if (life.partsPerTool) {
      derived.appendChild(tile('parts / tool', String(life.partsPerTool),
        life.edges + ' indexable edge' + (life.edges === 1 ? '' : 's') + ' × ' + life.parts + ' parts per index' +
        (life.edgesFromTool ? ' (every edge the tool has)' : '')));
    }
    if (life.edgeMin) {
      derived.appendChild(tile('min / edge', String(round(life.edgeMin, 1)),
        'Cutting minutes one edge lasts, at ' +
        fmtSec((s ? s.avgCut : 0) || (s ? s.avg : 0)) +
        (life.from === 'incut' ? ' measured in cut'
          : ' measured cycle — mark the tool in and out of cut for a truer figure')));
    }
    if (life.per100) {
      derived.appendChild(tile('tools / 100 parts', String(round(life.per100, 2)),
        'One tool covers ' + life.partsPerTool + ' parts'));
    }
    if (life.costPart) {
      derived.appendChild(tile('cost / part', round(life.costPart, 3).toFixed(3),
        'One tool at ' + (jobTool(a) || {}).cost + ', spread over ' + life.partsPerTool + ' parts'));
    }
    box.appendChild(derived);

    box.appendChild(el('div', 'mf-note',
      'Index this tool every ' + life.parts + ' parts' +
      (life.partsPerTool ? ', and change it at ' + life.partsPerTool : '') + '.' +
      (life.edgesFromTool
        ? ' The edge count is the tool\'s own; set indexable edges on this setup if fewer are used here.'
        : '')));
  }

  /* ---------------- the op cycle chart ---------------- */
  // The tools of an operation are an ordered set — tool 1 cuts before tool 2 —
  // so the segments take a one-hue ramp stepped light→dark along the running
  // order, not eight unrelated colors. Reading left to right you see the order
  // in the color itself. The steps are interpolated in OKLab between the app's
  // palest and deepest cyan and checked against the dark chart surface
  // (#141926): monotone lightness, every adjacent gap ≥ 0.06 L, one hue, and
  // the darkest step still clearing the surface at 2.55:1.
  // `ink` is the label color that clears contrast inside that fill.
  const RAMP = [
    { fill: '#EBFBFD', ink: '#10141D' },
    { fill: '#CDE4E8', ink: '#10141D' },
    { fill: '#B0CED3', ink: '#10141D' },
    { fill: '#93B7BE', ink: '#10141D' },
    { fill: '#76A2AA', ink: '#10141D' },
    { fill: '#598C96', ink: '#10141D' },
    { fill: '#3B7782', ink: '#EDEFF4' },
    { fill: '#17636F', ink: '#EDEFF4' },
  ];
  // Spread n tools across the ramp so the first is palest and the last deepest.
  // Past eight tools neighbours start sharing a step; they stay apart because
  // every segment is separated by a gap and numbered, and the table below the
  // bar carries all of it — a ninth invented hue would not survive CVD anyway.
  const rampStep = (i, n) => (n < 2 ? RAMP[4] : RAMP[Math.round((i * (RAMP.length - 1)) / (n - 1))]);

  function renderChart() {
    const box = els.chart;
    box.innerHTML = '';
    const active = activeJob();
    if (!active) { box.hidden = true; return; }

    const jobs = layoutJobs(active);
    const rows = jobs.map((a, i) => {
      const s = statsFor(a);
      return { a, i, avg: s ? s.avg : 0, count: s ? s.count : 0, step: rampStep(i, jobs.length) };
    });
    const timed = rows.filter(r => r.avg > 0);
    const total = timed.reduce((sum, r) => sum + r.avg, 0);
    box.hidden = false;

    const layout = layoutOf(active);
    const head = el('div', 'mf-chart-head');
    const heading = el('div', 'mf-chart-heading');
    const titleRow = el('div', 'mf-tl-row');
    titleRow.appendChild(foldToggle('sec:chart', 'Tool layout', 'mf-section-title', renderChart));
    if (layout) titleRow.appendChild(tlChip(layout));
    heading.appendChild(titleRow);
    heading.appendChild(el('div', 'mf-chart-op', layout ? layoutWhere(layout) : opLabel(active)));
    if (layout) {
      const acts = el('div', 'mf-tl-acts');
      // Reading a layout and printing it are the same permission, so this is
      // there for a shared shopwatch somebody may only look at.
      acts.appendChild(button('mf-link', '🖨 PDF', () => exportPdf(layout.id),
        'This tool layout on a page of its own — every tool on it, ready to print or save as PDF'));
      put(acts, wBtn('mf-link', 'Number', () => openForm('layout', layout.id),
        'What this layout is called on the floor'));
      heading.appendChild(acts);
    }
    head.appendChild(heading);
    const figure = el('div', 'mf-chart-figure');
    figure.appendChild(el('div', 'mf-chart-total', total ? fmtSec(total) : '—'));
    figure.appendChild(el('div', 'mf-chart-sub', timed.length
      ? 'measured across ' + timed.length + (timed.length === 1 ? ' tool' : ' tools')
      : 'nothing timed yet'));
    head.appendChild(figure);
    box.appendChild(head);
    // Closed, the heading still carries the layout's number and its measured
    // cycle: a fold hides the working, not the answer.
    if (isFolded('sec:chart')) return;

    // A tool in a machine with no operation named is half of a pair, and half a
    // pair is not a layout: there is nothing for the number to be the number of.
    if (!layout) {
      box.appendChild(el('div', 'mf-note',
        'This tool is on the machine but not on an operation, so it is not on a tool layout yet — ' +
        'and a cycle time needs one to be true of. Name the op on the setup and this becomes a ' +
        'numbered layout with the tools that run alongside it.'));
    }

    if (!timed.length) {
      box.appendChild(el('div', 'mf-note',
        'Time a cycle against a tool on this layout and its share of the total appears here.'));
      return;
    }

    // One timed tool is not a part-to-whole story — the figure above already is
    // the whole of it, and a single-segment bar would say nothing more.
    if (timed.length > 1) {
      const bar = el('div', 'mf-bar');
      bar.setAttribute('role', 'img');
      bar.setAttribute('aria-label',
        'The tool layout cycle, ' + fmtSec(total) + ', divided between ' + timed.length +
        ' tools. The same numbers are in the table below.');
      timed.forEach((r, n) => {
        const share = r.avg / total;
        const seg = el('div', 'mf-seg');
        seg.style.flexGrow = String(share);
        seg.style.background = r.step.fill;
        seg.style.color = r.step.ink;
        seg.dataset.tool = r.a.id;
        seg.tabIndex = 0;
        if (n === timed.length - 1) seg.classList.add('mf-seg-end');
        seg.title = (r.a.seq ? r.a.seq + '. ' : '') + jobName(r.a) +
          ' — ' + fmtSec(r.avg) + ', ' + Math.round(share * 100) + '% of the cycle';
        // A number only goes inside a segment wide enough to hold it; the rest
        // are read off the table, which lists every one of them.
        if (share >= 0.07 && r.a.seq) seg.appendChild(el('span', 'mf-seg-n', String(r.a.seq)));
        bar.appendChild(seg);
      });
      box.appendChild(bar);
    }

    // The table is the legend and the accessible twin of the bar in one: every
    // segment's identity, its measured average, and its share, as text.
    const table = el('div', 'mf-legend');
    for (const r of rows) {
      const row = el('div', 'mf-legend-row' + (r.avg ? '' : ' mf-legend-off'));
      row.dataset.tool = r.a.id;
      const swatch = el('span', 'mf-swatch');
      if (r.avg) swatch.style.background = r.step.fill;
      row.appendChild(swatch);
      row.appendChild(el('span', 'mf-legend-n', r.a.seq ? String(r.a.seq) : '–'));
      const name = el('span', 'mf-legend-name');
      if (r.a.station) name.appendChild(el('span', 'mf-chip mf-chip-sm', r.a.station));
      name.appendChild(document.createTextNode(jobName(r.a)));
      row.appendChild(name);
      row.appendChild(el('span', 'mf-legend-v', r.avg ? fmtSec(r.avg) : '—'));
      row.appendChild(el('span', 'mf-legend-p', r.avg ? Math.round((r.avg / total) * 100) + '%' : 'not timed'));
      row.addEventListener('click', () => selectJob(r.a.id));
      table.appendChild(row);
    }
    box.appendChild(table);

    const untimed = rows.length - timed.length;
    if (untimed) {
      box.appendChild(el('div', 'mf-note', untimed + ' of ' + rows.length +
        ' tools on this layout ' + (untimed === 1 ? 'has' : 'have') +
        ' no cycles timed yet, so the total is what has been measured so far, not the whole layout.'));
    }

    // Hovering or focusing either half lights up the other, so a two-pixel
    // segment is still reachable — through its row.
    const link = (id, on) => {
      for (const n of box.querySelectorAll('[data-tool="' + id + '"]')) n.classList.toggle('mf-on', on);
    };
    for (const type of ['mouseover', 'focusin']) {
      box.addEventListener(type, e => {
        const n = e.target.closest('[data-tool]');
        if (n) link(n.dataset.tool, true);
      });
    }
    for (const type of ['mouseout', 'focusout']) {
      box.addEventListener(type, e => {
        const n = e.target.closest('[data-tool]');
        if (n) link(n.dataset.tool, false);
      });
    }
  }

  /* ---------------- in the cut, and the waste around it ----------------
     The tool layout panel above says which tool owns the cycle. This one says
     how much of each tool's cycle is cutting metal, which is a different
     question and usually the more useful one: a column is a tool's measured
     cycle, and only the part of it marked in the cut is filled in. What is left
     empty at the top of the column is the waste — the rapids, the tool change,
     the bar feed — and because every column is drawn to one scale across the
     layout, the one with the most air over its fill is the one worth attacking.

     A tool's column and its fill are averaged over the same cycles: the ones
     somebody marked in and out of cut. Averaging the fill over the marked
     cycles and the column over all of them would let a mostly-unmarked layout
     draw a fill taller than the column it sits in, which is arithmetic rather
     than anything that happened at the machine.
  ---------------------------------------------------------------- */
  function renderCutChart() {
    const box = els.cutchart;
    box.innerHTML = '';
    const active = activeJob();
    if (!active) { box.hidden = true; return; }

    const rows = layoutJobs(active).map(a => {
      const s = statsFor(a);
      return {
        a,
        // The cycle this tool's time in cut is a share of, and the share
        // itself. Unmarked, there is a cycle but no reading inside it.
        cycle: s ? (s.avgCutCycle || s.avg) : 0,
        cut: s ? s.avgCut : 0,
        marked: s ? s.cutCount : 0,
      };
    });
    const drawn = rows.filter(r => r.cycle > 0);
    const withCut = drawn.filter(r => r.cut > 0);
    box.hidden = false;

    const layout = layoutOf(active);
    const head = el('div', 'mf-chart-head');
    const heading = el('div');
    heading.appendChild(foldToggle('sec:cut', 'In cut, and the waste', 'mf-section-title', renderCutChart));
    heading.appendChild(el('div', 'mf-chart-op',
      layout ? tlName(layout) + ' · ' + layoutWhere(layout) : opLabel(active)));
    head.appendChild(heading);

    // The layout's own share, over the tools that were marked — one sum of cut
    // over one sum of the cycles it was measured in.
    const cutTotal = withCut.reduce((sum, r) => sum + r.cut, 0);
    const cycleTotal = withCut.reduce((sum, r) => sum + r.cycle, 0);
    const opShare = cycleTotal ? cutTotal / cycleTotal : 0;
    const figure = el('div', 'mf-cutchart-figure');
    figure.appendChild(el('div', 'mf-cutchart-pct', opShare ? Math.round(opShare * 100) + '%' : '—'));
    figure.appendChild(el('div', 'mf-chart-sub', opShare
      ? 'of the marked cycle is cutting'
      : 'nothing marked in cut yet'));
    head.appendChild(figure);
    box.appendChild(head);
    if (isFolded('sec:cut')) return;

    if (!drawn.length) {
      box.appendChild(el('div', 'mf-note',
        'Time a cycle against a tool on this layout, mark it in and out of cut as it runs, and ' +
        'the cutting and the waste separate here.'));
      return;
    }

    // One scale across the layout: every column is a share of the longest cycle
    // on it, so the columns are comparable to each other and not only to
    // themselves.
    const longest = Math.max(...drawn.map(r => r.cycle));
    // Direct labels go on the extremes only — the best and the worst share —
    // and only when there are enough columns for "extreme" to mean anything.
    // Every other number is in the table underneath.
    const shares = withCut.map(r => r.cut / r.cycle);
    const call = new Set();
    if (withCut.length > 2 && Math.min(...shares) < Math.max(...shares)) {
      call.add(withCut[shares.indexOf(Math.min(...shares))].a.id);
      call.add(withCut[shares.indexOf(Math.max(...shares))].a.id);
    }

    const plot = el('div', 'mf-plot');
    plot.setAttribute('role', 'img');
    plot.setAttribute('aria-label',
      'One column per tool on this tool layout, each the tool\'s measured cycle, filled with the ' +
      'time it was marked in cut; the empty part of a column is the waste. ' +
      (opShare ? Math.round(opShare * 100) + '% of the marked cycle across the layout is cutting. ' : '') +
      'The same numbers are in the table below.');
    const axis = el('div', 'mf-plot-axis');

    for (const r of drawn) {
      const slot = el('div', 'mf-plot-slot');
      const col = el('div', 'mf-col');
      col.dataset.tool = r.a.id;
      col.tabIndex = 0;
      col.style.height = (r.cycle / longest) * 100 + '%';

      const name = (r.a.seq ? r.a.seq + '. ' : '') + jobName(r.a);
      if (r.cut > 0) {
        const share = r.cut / r.cycle;
        const waste = r.cycle - r.cut;
        col.title = name + ' — ' + fmtSec(r.cycle) + ' cycle, ' + fmtSec(r.cut) + ' in cut (' +
          Math.round(share * 100) + '%), ' + fmtSec(waste) + ' waste, over ' + r.marked +
          (r.marked === 1 ? ' marked cycle' : ' marked cycles');
        // Waste sits above the cut, so the column fills from the baseline up.
        // A cycle that is all cut has no waste segment to draw at all.
        if (waste > 0) {
          const top = el('div', 'mf-col-waste');
          top.style.flexGrow = String(waste);
          col.appendChild(top);
        }
        const fill = el('div', 'mf-col-cut' + (waste > 0 ? '' : ' mf-col-top'));
        fill.style.flexGrow = String(r.cut);
        col.appendChild(fill);
      } else {
        col.title = name + ' — ' + fmtSec(r.cycle) + ' cycle, nothing marked in cut';
        col.appendChild(el('div', 'mf-col-empty'));
      }
      slot.appendChild(col);
      plot.appendChild(slot);

      const label = el('div', 'mf-axis-slot');
      label.dataset.tool = r.a.id;
      label.appendChild(el('div', 'mf-axis-n', r.a.seq ? String(r.a.seq) : '–'));
      if (call.has(r.a.id)) {
        label.appendChild(el('div', 'mf-axis-call', Math.round((r.cut / r.cycle) * 100) + '% cut'));
      }
      axis.appendChild(label);
    }
    box.appendChild(plot);
    box.appendChild(axis);

    const key = el('div', 'mf-cutkey');
    const keyBit = (cls, text) => {
      const s = el('span');
      s.appendChild(el('i', cls));
      s.appendChild(document.createTextNode(text));
      return s;
    };
    key.appendChild(keyBit('mf-key-cut', 'in cut'));
    key.appendChild(keyBit('mf-key-waste', 'everything else'));
    if (drawn.some(r => !r.cut)) key.appendChild(keyBit('mf-key-unmarked', 'not marked'));
    box.appendChild(key);

    // The table is the accessible twin of the plot: every column's identity and
    // all three of its numbers, as text, for every tool including the ones with
    // no column to draw.
    const table = el('div', 'mf-legend');
    for (const r of rows) {
      const row = el('div', 'mf-legend-row' + (r.cut ? '' : ' mf-legend-off'));
      row.dataset.tool = r.a.id;
      const swatch = el('span', 'mf-swatch');
      if (r.cut) swatch.style.background = 'var(--mf-cut)';
      row.appendChild(swatch);
      row.appendChild(el('span', 'mf-legend-n', r.a.seq ? String(r.a.seq) : '–'));
      const name = el('span', 'mf-legend-name');
      if (r.a.station) name.appendChild(el('span', 'mf-chip mf-chip-sm', r.a.station));
      name.appendChild(document.createTextNode(jobName(r.a)));
      row.appendChild(name);
      row.appendChild(el('span', 'mf-legend-v', r.cut ? fmtSec(r.cut) : '—'));
      row.appendChild(el('span', 'mf-legend-w',
        r.cut ? fmtSec(r.cycle - r.cut) + ' wasted' : (r.cycle ? 'not marked' : 'not timed')));
      row.appendChild(el('span', 'mf-legend-p',
        r.cut ? Math.round((r.cut / r.cycle) * 100) + '% cut' : ''));
      row.addEventListener('click', () => selectJob(r.a.id));
      table.appendChild(row);
    }
    box.appendChild(table);

    const unmarked = drawn.filter(r => !r.cut).length;
    if (unmarked) {
      box.appendChild(el('div', 'mf-note', unmarked + ' of ' + drawn.length +
        ' timed tools on this layout ' + (unmarked === 1 ? 'has' : 'have') +
        ' no cycle marked in and out of cut, so ' + (unmarked === 1 ? 'it is' : 'they are') +
        ' drawn empty rather than counted as waste — nobody has said yet which it is.'));
    } else if (withCut.length) {
      box.appendChild(el('div', 'mf-note',
        'Across the layout that is ' + fmtSec(cycleTotal - cutTotal) + ' a part not cutting, out of ' +
        fmtSec(cycleTotal) + '.'));
    }

    // Either half lights the other, so a narrow column is still reachable
    // through its row in the table.
    const link = (id, on) => {
      for (const n of box.querySelectorAll('[data-tool="' + id + '"]')) n.classList.toggle('mf-on', on);
    };
    for (const type of ['mouseover', 'focusin']) {
      box.addEventListener(type, e => {
        const n = e.target.closest('[data-tool]');
        if (n) link(n.dataset.tool, true);
      });
    }
    for (const type of ['mouseout', 'focusout']) {
      box.addEventListener(type, e => {
        const n = e.target.closest('[data-tool]');
        if (n) link(n.dataset.tool, false);
      });
    }
  }


  /* ---------------- the value stream ----------------
     A part is made by its operations in order; each of those runs on a machine,
     which stands in a cell; and every one of those steps has a measured cycle
     underneath it, because the tools on it have been timed. Put end to end,
     that is the value stream: where the part goes, in what order, and how long
     each step takes.

     What is drawn is only what has been measured. A value stream map normally
     carries inventory between the boxes, changeover, uptime and a lead-time
     ladder, and none of that is in this record — so none of it is drawn.
     Inventing it would make the map look finished and be wrong, which is worse
     than a map that says plainly which steps have been timed and which have
     not. What this shows is the process time: step by step, cell by cell, and
     what share of the part's total each one is.

     Where an operation runs on more than one machine those are alternative
     routings rather than two steps, so they are drawn side by side in one step
     and the total takes the fastest measured of them — and says so.
  ---------------------------------------------------------------- */
  let streamPartId = '';   // the part the map is of, on this screen only

  // The part the map opens on: whatever was last chosen, else the one being
  // timed, else the first part with operations on it.
  function streamPart() {
    if (!shop) return null;
    const chosen = partById(streamPartId);
    if (chosen) return chosen;
    const timing = jobPart(activeJob());
    if (timing) return timing;
    return [...shop.parts].sort((a, b) => partName(a).localeCompare(partName(b)))
      .find(p => opsOfPart(p.id).length) || null;
  }

  /* One part's route, as steps. A step is an operation; under it are the tool
     layouts that can run it, each with its cell, its machine and its measured
     cycle — the sum of its tools' averages, which is what the tool layout panel
     shows for that layout. */
  function streamSteps(part) {
    if (!part) return [];
    return opsOfPart(part.id).map(op => {
      const routes = layoutsOfOperation(op.id).map(l => {
        const jobs = layoutJobsOf(l);
        let cycle = 0, timed = 0, cut = 0, cutCycle = 0;
        for (const a of jobs) {
          const st = statsFor(a);
          if (!st) continue;
          cycle += st.avg;
          timed++;
          if (st.avgCut) { cut += st.avgCut; cutCycle += st.avgCutCycle; }
        }
        return {
          layout: l,
          cell: cellOfMachine(l.machineId),
          machineId: l.machineId,
          tools: jobs.length,
          timed,
          cycle,
          // the share of the measured cycle that was marked in cut, over the
          // cycles it was marked in
          cutShare: cutCycle ? cut / cutCycle : 0,
        };
      });
      const measured = routes.filter(r => r.cycle > 0);
      // alternatives, not steps: the quickest measured one is what the part
      // takes when it goes that way
      const best = measured.length
        ? measured.reduce((a, b) => (b.cycle < a.cycle ? b : a))
        : null;
      return { op, routes, best, cycle: best ? best.cycle : 0 };
    });
  }

  function renderStream() {
    const box = els.stream;
    box.innerHTML = '';
    if (!shop || !shop.parts.length) { box.hidden = true; return; }
    box.hidden = false;

    const part = streamPart();
    const steps = streamSteps(part);
    const measured = steps.filter(st => st.cycle > 0);
    const total = measured.reduce((sum, st) => sum + st.cycle, 0);

    const head = el('div', 'mf-chart-head');
    const heading = el('div', 'mf-chart-heading');
    heading.appendChild(foldToggle('sec:stream', 'Value stream', 'mf-section-title', renderStream));
    heading.appendChild(el('div', 'mf-chart-op', part
      ? partName(part) + (part.desc && part.number ? ' · ' + part.desc : '')
      : 'no parts yet'));
    if (part && steps.length) {
      const acts = el('div', 'mf-tl-acts');
      acts.appendChild(button('mf-link', '🖨 PDF', () => exportStreamPdf(part.id),
        'This value stream on a page of its own, ready to print or save as PDF'));
      heading.appendChild(acts);
    }
    head.appendChild(heading);
    const figure = el('div', 'mf-chart-figure');
    figure.appendChild(el('div', 'mf-chart-total', total ? fmtSec(total) : '—'));
    figure.appendChild(el('div', 'mf-chart-sub', measured.length
      ? 'process time over ' + measured.length + (measured.length === 1 ? ' step' : ' steps')
      : 'nothing measured yet'));
    head.appendChild(figure);
    box.appendChild(head);
    if (isFolded('sec:stream')) return;

    // Which part the map is of. Only worth a control where there is more than
    // one part to be of.
    if (shop.parts.length > 1) {
      box.appendChild(dropdown('mf-pick',
        [...shop.parts].sort((a, b) => partName(a).localeCompare(partName(b)))
          .map(p => ({ value: p.id, label: partName(p) + ' — ' +
            opsOfPart(p.id).length + (opsOfPart(p.id).length === 1 ? ' op' : ' ops') })),
        part ? part.id : '', v => { streamPartId = v; renderStream(); }, 'Part the value stream is of'));
    }

    if (!steps.length) {
      box.appendChild(el('div', 'mf-note', part
        ? partName(part) + ' has no operations yet, so there is no route to map.'
        : 'Add a part and its operations, and the route they run appears here.'));
      return;
    }

    /* The map itself: a box per step in the order the operations run, banded by
       the cell each step happens in, with an arrow between boxes. A step whose
       cell changes starts a new band, because that is the handover — the point
       where the part is carried from one area of the floor to the next. */
    const flow = el('div', 'mf-flow');
    let bandCell = undefined, band = null;
    steps.forEach((st, i) => {
      const route = st.best || st.routes[0] || null;
      const cell = route ? route.cell : null;
      const cellId = cell ? cell.id : '';
      if (bandCell === undefined || cellId !== bandCell) {
        bandCell = cellId;
        band = el('div', 'mf-band');
        const label = el('div', 'mf-band-k', cell ? cell.name : (route ? 'Not in a cell' : 'No machine yet'));
        band.appendChild(label);
        const lane = el('div', 'mf-band-lane');
        band.appendChild(lane);
        band.lane = lane;
        flow.appendChild(band);
      }
      band.lane.appendChild(streamBox(st, i, total));
    });
    box.appendChild(flow);

    // Where the process time goes, across the steps that have been measured —
    // the same ramp the tool layout bar uses, so a step reads the same way here
    // as a tool does there.
    if (measured.length > 1) {
      const bar = el('div', 'mf-bar');
      bar.setAttribute('role', 'img');
      bar.setAttribute('aria-label', 'The part’s measured process time, ' + fmtSec(total) +
        ', divided between ' + measured.length + ' steps. The same numbers are in the table below.');
      measured.forEach((st, n) => {
        const share = st.cycle / total;
        const step = rampStep(n, measured.length);
        const seg = el('div', 'mf-seg');
        seg.style.flexGrow = String(share);
        seg.style.background = step.fill;
        seg.style.color = step.ink;
        if (n === measured.length - 1) seg.classList.add('mf-seg-end');
        seg.title = st.op.name + ' — ' + fmtSec(st.cycle) + ', ' + Math.round(share * 100) + '% of the process time';
        if (share >= 0.08) seg.appendChild(el('span', 'mf-seg-n', st.op.name));
        bar.appendChild(seg);
      });
      box.appendChild(bar);
    }

    // The table under it: every step as text, including the ones with nothing
    // measured and the ones with nowhere to run yet.
    const table = el('div', 'mf-legend');
    steps.forEach((st, i) => {
      const route = st.best || st.routes[0] || null;
      const row = el('div', 'mf-legend-row' + (st.cycle ? '' : ' mf-legend-off'));
      row.appendChild(el('span', 'mf-legend-n', String(i + 1)));
      const name = el('span', 'mf-legend-name');
      if (route && route.layout) name.appendChild(tlChip(route.layout, 'mf-tl-sm'));
      name.appendChild(document.createTextNode(st.op.name +
        (route ? ' · ' + machineName(route.machineId) : '')));
      row.appendChild(name);
      row.appendChild(el('span', 'mf-legend-v', st.cycle ? fmtSec(st.cycle) : '—'));
      row.appendChild(el('span', 'mf-legend-p', st.cycle
        ? Math.round((st.cycle / total) * 100) + '%'
        : (route ? 'not timed' : 'no machine')));
      if (route && route.layout) row.addEventListener('click', () => {
        const first = layoutJobsOf(route.layout)[0];
        if (first) selectJob(first.id);
      });
      table.appendChild(row);
    });
    box.appendChild(table);

    const untimed = steps.length - measured.length;
    const unrouted = steps.filter(st => !st.routes.length).length;
    if (untimed) {
      box.appendChild(el('div', 'mf-note', untimed + ' of ' + steps.length +
        (steps.length === 1 ? ' step ' : ' steps ') + (untimed === 1 ? 'has' : 'have') +
        ' nothing measured against ' + (untimed === 1 ? 'it' : 'them') +
        (unrouted ? ' — ' + unrouted + ' of those ' + (unrouted === 1 ? 'has' : 'have') +
          ' no machine set up yet' : '') +
        ', so the total is the process time measured so far rather than the whole part.'));
    }
    if (steps.some(st => st.routes.length > 1)) {
      box.appendChild(el('div', 'mf-note',
        'Where an operation runs on more than one machine, those are alternative routings rather ' +
        'than two steps: they are drawn side by side and the total takes the fastest measured.'));
    }
    box.appendChild(el('div', 'mf-note',
      'This is process time — what the part spends being cut and handled at each step. ' +
      'Waiting between steps, batch sizes and changeovers are not in this record, so they are ' +
      'not drawn.'));
  }

  // One process box: the step, where it happens, and what it measures.
  function streamBox(st, i, total) {
    const wrap = el('div', 'mf-step');
    if (i) wrap.appendChild(el('div', 'mf-step-arrow', '→'));
    const boxes = el('div', 'mf-step-boxes');
    const routes = st.routes.length ? st.routes : [null];
    for (const route of routes) {
      const b = el('div', 'mf-box' + (route && st.best === route && st.routes.length > 1 ? ' mf-box-best' : ''));
      const top = el('div', 'mf-box-top');
      top.appendChild(el('span', 'mf-box-n', String(i + 1)));
      top.appendChild(el('span', 'mf-box-op', st.op.name));
      if (route && route.layout) top.appendChild(el('span', 'mf-tl mf-tl-sm', tlName(route.layout)));
      b.appendChild(top);
      b.appendChild(el('div', 'mf-box-machine', route ? machineName(route.machineId) : 'No machine set up'));
      const time = el('div', 'mf-box-time', route && route.cycle ? fmtSec(route.cycle) : '—');
      b.appendChild(time);
      const meta = [];
      if (route) meta.push(route.tools + (route.tools === 1 ? ' tool' : ' tools'));
      if (route && route.cutShare) meta.push(Math.round(route.cutShare * 100) + '% in cut');
      if (route && route.cycle && total) meta.push(Math.round((route.cycle / total) * 100) + '% of total');
      b.appendChild(el('div', 'mf-box-meta', meta.join(' · ') || 'nothing measured'));
      boxes.appendChild(b);
    }
    wrap.appendChild(boxes);
    return wrap;
  }

  function renderRuns() {
    const box = els.runs;
    box.innerHTML = '';
    const a = activeJob();
    if (!a) return;

    const head = el('div', 'mf-section-head');
    head.appendChild(foldToggle('sec:runs', 'Recorded cycles', 'mf-section-title', renderRuns));
    head.appendChild(el('span', 'mf-fold-count', String(a.runs.length)));
    const add = el('div', 'mf-addtime');
    const input = el('input', 'mf-input mf-input-time');
    input.placeholder = 'mm:ss.t';
    input.setAttribute('aria-label', 'Add a cycle time by hand');
    const commit = () => {
      const sec = parseTime(input.value);
      if (!sec) { flash('Type a time like 42.6 or 1:23.4.'); return; }
      input.value = '';
      addRun(a, round(sec, 2));
    };
    input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); commit(); } });
    add.appendChild(input);
    add.appendChild(button('mf-btn mf-btn-sm', 'Add', commit, 'Record a time measured somewhere else'));
    if (canEdit()) head.appendChild(add);
    box.appendChild(head);
    if (isFolded('sec:runs')) return;

    if (!a.runs.length) {
      box.appendChild(el('div', 'mf-note', 'Nothing timed against this setup yet.'));
      return;
    }

    const list = el('div', 'mf-runs-list');
    a.runs.forEach((r, i) => {
      const row = el('div', 'mf-run');
      row.appendChild(el('div', 'mf-run-n', '#' + (a.runs.length - i)));
      row.appendChild(el('div', 'mf-run-t', fmtSec(r.sec)));
      if (r.cut > 0) {
        const cutCell = el('div', 'mf-run-cut', fmtSec(r.cut) + ' cut');
        cutCell.title = Math.round((r.cut / r.sec) * 100) + '% of this cycle was in cut';
        row.appendChild(cutCell);
      }
      row.appendChild(el('div', 'mf-run-at', fmtAgo(r.at)));
      if (canEdit()) row.appendChild(button('mf-x', '✕', () => {
        a.runs = a.runs.filter(x => x.id !== r.id);
        touch(a);
        save();
        renderStats();
        renderRuns();
        renderChart();
        renderCutChart();
        renderParts();
        renderMachines();
      }, 'Delete this cycle'));
      list.appendChild(row);
    });
    box.appendChild(list);
  }

  /* ---------------- the forms ----------------
     One form panel, five things it can be editing. They are kept apart because
     the fields belong to different places: a tool's cutting edges are true
     wherever it runs, an operation belongs to one part, and the tool life is
     true only of one tool, on one machine, on one op.
  ---------------------------------------------------------------- */
  const MACHINE_FIELDS = [
    { key: 'name', label: 'Machine', placeholder: 'Haas ST-20', wide: true, hint: 'What it is called on the floor' },
    { key: 'cellSeq', label: 'Position in cell', placeholder: '1', num: true,
      hint: 'Where the work reaches this machine in its cell — 1 is first' },
  ];

  const CELL_FIELDS = [
    { key: 'name', label: 'Cell', placeholder: 'Cell 1 — turning', wide: true,
      hint: 'What this area of the floor is called' },
    { key: 'seq', label: 'Flow order', placeholder: '1', num: true,
      hint: 'Where the cell falls in the flow across the floor — 1 is first' },
  ];

  const TOOL_FIELDS = [
    { key: 'partNumber', label: 'Part number', placeholder: 'CNMG432-MP', wide: true, hint: 'The tool\'s own number — what it is ordered by' },
    { key: 'desc', label: 'Description', placeholder: '80° CNMG rougher', wide: true },
    { key: 'cuttingEdges', label: 'Cutting edges', placeholder: '4', num: true, hint: 'Usable cutting edges the tool has — 4 on a CNMG insert' },
    { key: 'cost', label: 'Cost', placeholder: '9.40', num: true, hint: 'Optional — what one costs, for cost per part' },
  ];

  const PART_FIELDS = [
    { key: 'number', label: 'Part number', placeholder: '12345-A', wide: true, hint: 'The part being made, not the tool' },
    { key: 'desc', label: 'Description', placeholder: 'pump housing', wide: true },
  ];

  const OPERATION_FIELDS = [
    { key: 'name', label: 'Operation', placeholder: 'Op 20', wide: true, hint: 'What the traveller calls this step' },
    { key: 'seq', label: 'Step', placeholder: '1', num: true, hint: 'Where it falls in making the part' },
  ];

  const JOB_FIELDS = [
    { key: 'station', label: 'Pocket', placeholder: 'T0303', hint: 'Turret station or pocket this tool sits in' },
    { key: 'seq', label: 'Seq', placeholder: '1', num: true, hint: 'Where it falls in the layout — 1 cuts first' },
    { key: 'indexEdges', label: 'Indexable edges', placeholder: '4', num: true, hint: 'How many of the tool\'s edges get indexed through here' },
    { key: 'partsPerIndex', label: 'Parts per index', placeholder: '250', num: true, hint: 'Parts run between one edge index and the next' },
  ];

  const LAYOUT_FIELDS = [
    { key: 'number', label: 'Tool layout number', placeholder: '1', num: true, wide: true,
      hint: 'What this layout is called on the floor — its own number in this shopwatch' },
  ];

  const FORM_FIELDS = {
    cell: CELL_FIELDS, machine: MACHINE_FIELDS, tool: TOOL_FIELDS, part: PART_FIELDS,
    operation: OPERATION_FIELDS, assignment: JOB_FIELDS, layout: LAYOUT_FIELDS,
  };
  const FORM_TITLES = {
    cell: ['New cell', 'Edit cell'],
    machine: ['New machine', 'Edit machine'],
    tool: ['New tool', 'Edit tool'],
    part: ['New part', 'Edit part'],
    operation: ['New operation', 'Edit operation'],
    assignment: ['Set a tool up on a machine', 'Edit this setup'],
    layout: ['Tool layout', 'Number this tool layout'],
  };
  const FINDER = {
    cell: cellById, machine: machineById, tool: toolById, part: partById,
    operation: operationById, assignment: jobById, layout: layoutById,
  };

  // The operations of every part, grouped by the part they belong to — which
  // is the only way a list of "Op 20"s can be read.
  function operationOptions() {
    const opts = [];
    for (const p of [...shop.parts].sort((x, y) => partName(x).localeCompare(partName(y)))) {
      for (const o of opsOfPart(p.id)) opts.push({ value: o.id, label: o.name, group: partName(p) });
    }
    return opts;
  }

  // preset carries what the caller already knows: which machine a tool is
  // being set up on, which tool is being set up, which operation it is for.
  function openForm(kind, id, preset) {
    if (!shop) return; // still loading; there is nothing to add to yet
    if (kind === 'assignment' && !id) {
      if (!shop.tools.length) { flash('Add a tool first — a setup puts one on a machine.'); openForm('tool'); return; }
      if (!shop.machines.length) { flash('Add a machine first — a setup puts a tool on one.'); openForm('machine'); return; }
      if (!shop.operations.length) {
        flash('Add the part and its operation first — the cycle times belong to an op.');
        openForm(shop.parts.length ? 'operation' : 'part');
        return;
      }
    }
    if (kind === 'operation' && !id && !shop.parts.length) {
      flash('Add the part first — an operation is a step in making one.');
      openForm('part');
      return;
    }
    // A tool layout is never made here: it comes into being, already numbered,
    // the moment a tool is set up on a machine for an operation. This form only
    // ever changes the number on one that exists.
    if (kind === 'layout' && !layoutById(id)) {
      flash('That tool layout is not there any more.');
      return;
    }
    const found = id ? FINDER[kind](id) : null;
    let draft;
    if (found) {
      draft = { ...found, runs: undefined };
    } else if (kind === 'cell') {
      draft = { id: '', name: '', seq: '', notes: '', ...(preset || {}) };
      draft.seq = String(cellList().reduce((max, c) => Math.max(max, c.seq || 0), 0) + 1);
    } else if (kind === 'machine') {
      draft = { id: '', name: '', cellId: '', cellSeq: '', notes: '', ...(preset || {}) };
      // A floor with one cell has no question to ask; with more, the machine
      // being added is usually going where the last one went.
      if (!draft.cellId && cellList().length === 1) draft.cellId = cellList()[0].id;
      if (draft.cellId) {
        draft.cellSeq = String(machinesOfCell(draft.cellId)
          .reduce((max, m) => Math.max(max, m.cellSeq || 0), 0) + 1);
      }
    } else if (kind === 'tool') {
      draft = { id: '', partNumber: '', desc: '', cuttingEdges: '', cost: '', notes: '' };
    } else if (kind === 'part') {
      draft = { id: '', number: '', desc: '', notes: '', ...(preset || {}) };
    } else if (kind === 'operation') {
      draft = { id: '', partId: '', name: '', seq: '', notes: '', ...(preset || {}) };
      if (!draft.partId) {
        const from = jobPart(activeJob());
        draft.partId = (from && from.id) || (shop.parts.length === 1 ? shop.parts[0].id : '');
      }
      draft.seq = String(opsOfPart(draft.partId).reduce((max, o) => Math.max(max, o.seq || 0), 0) + 1);
    } else {
      draft = {
        id: '', toolId: '', machineId: '', operationId: '', station: '', seq: '',
        indexEdges: '', partsPerIndex: '', notes: '', ...(preset || {}),
      };
      // Carry over from what is already on screen: the machine's last setup, or
      // the one being timed. Tools are set up a few at a time for the same op,
      // and choosing it again each time is noise.
      const from = (draft.machineId ? jobsOnMachine(draft.machineId) : []).slice(-1)[0] ||
        (draft.operationId ? jobsOfOperation(draft.operationId).slice(-1)[0] : null) ||
        activeJob();
      if (from) {
        draft.machineId = draft.machineId || from.machineId;
        draft.operationId = draft.operationId || from.operationId;
      }
      if (!draft.machineId && shop.machines.length === 1) draft.machineId = shop.machines[0].id;
      if (!draft.toolId && shop.tools.length === 1) draft.toolId = shop.tools[0].id;
      if (!draft.operationId && shop.operations.length === 1) draft.operationId = shop.operations[0].id;
      draft.seq = String(nextSeq(draft));
      const tool = toolById(draft.toolId);
      if (tool && tool.cuttingEdges) draft.indexEdges = String(tool.cuttingEdges);
    }
    form = { kind, draft };
    formError = '';
    renderForm();
    const first = els.form.querySelector('select, input, textarea');
    if (first) first.focus();
    els.form.scrollIntoView({ block: 'nearest' });
  }

  // The next free place in the running order of the setup a draft names.
  function nextSeq(draft) {
    const key = pairKey(draft.machineId, draft.operationId);
    return shop.assignments
      .filter(x => layoutKey(x) === key && x.id !== draft.id)
      .reduce((max, x) => Math.max(max, x.seq || 0), 0) + 1;
  }

  function closeForm() {
    form = null;
    formError = '';
    renderForm();
  }

  const cleanText = v => String(v == null ? '' : v).trim();
  const cleanNum = v => {
    const n = Number(cleanText(v));
    return Number.isFinite(n) && n > 0 ? n : 0;
  };

  function saveForm() {
    const { kind, draft } = form;
    if (kind === 'cell') return saveCell(draft);
    if (kind === 'machine') return saveMachine(draft);
    if (kind === 'tool') return saveTool(draft);
    if (kind === 'part') return savePart(draft);
    if (kind === 'operation') return saveOperation(draft);
    if (kind === 'layout') return saveLayout(draft);
    return saveAssignment(draft);
  }

  function fail(message) {
    formError = message;
    renderForm();
  }

  // Every save below ends the same way: the form closes, the tool layouts are
  // brought back in step with what is now set up, the record is queued for
  // saving, and the screen is redrawn.
  function done() {
    form = null;
    formError = '';
    ensureLayouts();
    save();
    render();
  }

  /* ---------------- a cell ----------------
     The machines that work together, and where the cell falls in the flow. A
     cell holds nothing of its own beyond that: which machines are in it is a
     field on the machine, and what runs through it is read off the operations
     those machines cut.
  ---------------------------------------------------------------- */
  function saveCell(draft) {
    const name = cleanText(draft.name);
    if (!name) return fail('A cell needs a name — whatever that area of the floor is called.');
    const clash = cellList().find(c => c.id !== draft.id && c.name.toLowerCase() === name.toLowerCase());
    if (clash) return fail('There is already a cell called ' + clash.name + '.');
    const cell = { name, seq: Math.floor(cleanNum(draft.seq)), notes: cleanText(draft.notes).slice(0, 400) };
    const existing = cellById(draft.id);
    let created = null;
    if (existing) {
      Object.assign(existing, cell);
      touch(existing);
    } else {
      if (!Array.isArray(shop.cells)) shop.cells = [];
      if (shop.cells.length >= (limits.maxCells || 40)) {
        return fail('That is as many cells as one floor keeps (' + (limits.maxCells || 40) + ').');
      }
      created = { id: newId('c'), ...cell, createdAt: Date.now(), updatedAt: Date.now() };
      shop.cells.push(created);
    }
    done();
    // A cell with no machines in it is an empty area of the floor; the next
    // thing to do is put a machine in it.
    if (created && !machinesOfCell(created.id).length) {
      openForm('machine', '', { cellId: created.id });
    }
  }

  function saveMachine(draft) {
    const name = cleanText(draft.name);
    if (!name) return fail('A machine needs a name — whatever it is called on the floor.');
    const clash = shop.machines.find(m => m.id !== draft.id && m.name.toLowerCase() === name.toLowerCase());
    if (clash) return fail('There is already a machine called ' + clash.name + '.');
    const notes = cleanText(draft.notes).slice(0, 400);
    const cellId = cellById(draft.cellId) ? draft.cellId : '';
    const cellSeq = cellId ? Math.floor(cleanNum(draft.cellSeq)) : 0;
    const existing = machineById(draft.id);
    let created = null;
    if (existing) {
      existing.name = name;
      existing.notes = notes;
      existing.cellId = cellId;
      existing.cellSeq = cellSeq;
      touch(existing);
    } else {
      if (shop.machines.length >= limits.maxMachines) {
        return fail('That is as many machines as one account keeps (' + limits.maxMachines + ').');
      }
      created = { id: newId('m'), name, cellId, cellSeq, notes,
        createdAt: Date.now(), updatedAt: Date.now() };
      shop.machines.push(created);
    }
    const from = created && draft.cloneOf ? machineById(draft.cloneOf) : null;
    const copy = from ? copyTools(draft.cloneOf, created.id, !!draft.withOps) : null;
    done();
    if (copy) {
      const tail = copy.skipped ? ', ' + copy.skipped + ' left out for want of room' : '';
      flash(!copy.copied
        ? name + ' was added, but the machine it was copied from has no tools on it.'
        : draft.withOps
          ? name + ' is set up like ' + from.name + ' — ' + copy.copied +
            (copy.copied === 1 ? ' setup' : ' setups') + ' copied' + tail +
            '. Nothing has been timed on it yet.'
          : name + ' is tooled like ' + from.name + ' — ' + copy.copied +
            (copy.copied === 1 ? ' tool' : ' tools') + ' copied' + tail +
            '. Put each one on an operation before timing it.',
      !!copy.copied);
    }
    // A machine with nothing on it does nothing, so go straight on to setting a
    // tool up on it — with the machine already filled in. A clone that already
    // came with tools needs no such prompt.
    if (created && !(copy && copy.copied) && shop.tools.length && shop.operations.length) {
      openForm('assignment', '', { machineId: created.id });
    }
  }

  /* ---------------- cloning a machine ----------------
     A second machine of the same kind is tooled the same way, and typing that
     list in again is the work the record exists to avoid. Cloning copies the
     tools, in the stations they sit in — one entry per tool per station,
     however many operations it happens to cut there — and leaves what each is
     cutting to whoever sets the machine up. Which ops a machine runs is a
     decision, not a property of the machine, and the edges indexed and the
     parts between indexes are facts about the op being cut.

     A second machine standing in for the first runs the same work, though, so
     the clone can be told to bring the operations too: each setup then arrives
     whole, on the same op, with the tool life worked out for it. That is a
     claim about the new machine — that it cuts the same op the same way — so
     it is asked for rather than assumed. The cycles stay behind either way:
     they were measured on the machine they were measured on.

     The recorded cycles are never copied either way. A cycle time is a
     measurement taken on one machine, and carrying it onto another would be
     inventing data about a machine nobody has stood in front of.
  ---------------------------------------------------------------- */
  function copyTools(fromId, toId, withOps) {
    const now = Date.now();
    let copied = 0, skipped = 0, seq = 0;
    const seen = new Set();
    for (const a of jobsOnMachine(fromId).sort(bySeq)) {
      // Without the operations, a tool cutting three ops from one pocket is one
      // tool in one pocket and comes across once. With them, each op it is set
      // up for is its own setup, and each one comes.
      if (!withOps) {
        const key = a.toolId + ' ' + a.station.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
      }
      if (shop.assignments.length >= limits.maxAssignments) { skipped++; continue; }
      shop.assignments.push({
        id: newId('a'),
        toolId: a.toolId,
        machineId: toId,
        operationId: withOps ? a.operationId : '',
        station: a.station,
        seq: withOps ? a.seq : ++seq,
        indexEdges: withOps ? a.indexEdges : 0,
        partsPerIndex: withOps ? a.partsPerIndex : 0,
        notes: withOps ? a.notes : '',
        runs: [],
        createdAt: now,
        updatedAt: now,
      });
      copied++;
    }
    for (const key of new Set(jobsOnMachine(toId).map(layoutKey))) renumberLayout(key);
    return { copied, skipped };
  }

  // The number a cloned machine starts on. A name ending in a number takes the
  // next free one after it — MC-101 becomes MC-102, Lathe 3 becomes Lathe 4 —
  // and one that ends in anything else has a number put on the end. It is only
  // a suggestion: the form opens on it so it can be typed over.
  function nextMachineName(name) {
    const taken = new Set(shop.machines.map(m => m.name.toLowerCase()));
    const free = candidate => candidate.length <= 60 && !taken.has(candidate.toLowerCase());
    const digits = String(name).match(/^(.*?)(\d+)(\D*)$/);
    if (digits) {
      const [, head, num, tail] = digits;
      for (let n = Number(num) + 1; n <= Number(num) + 999; n++) {
        const next = head + String(n).padStart(num.length, '0') + tail;
        if (free(next)) return next;
      }
    }
    for (let n = 2; n <= 999; n++) {
      const next = name + ' ' + n;
      if (free(next)) return next;
    }
    return '';
  }

  function cloneMachine(id) {
    const m = machineById(id);
    if (!m) return;
    if (shop.machines.length >= limits.maxMachines) {
      flash('That is as many machines as one account keeps (' + limits.maxMachines + ').');
      return;
    }
    openForm('machine', '', { name: nextMachineName(m.name), notes: m.notes, cloneOf: m.id });
  }

  /* ---------------- cloning a part number ----------------
     A revision of a part, or a second number made the same way, runs the same
     route: the same operations, on the same machines, with the same tools in
     the same stations. That whole route is what a clone carries — every
     operation of the part, and every setup on each of them, with the cutting
     time, the indexable edges and the parts between indexes worked out for it.

     Unlike a cloned machine, none of that is optional. Which operations a
     machine runs is a decision about the machine; the operations that make a
     part are what the part *is*, and a part number cloned without them would
     be a new part number and nothing else — which the New part button already
     does.

     The recorded cycles stay with the original, for the same reason they stay
     with a cloned machine: a cycle time is a measurement of parts that were
     actually made, and carrying it onto a number nobody has run yet would be
     inventing it.
  ---------------------------------------------------------------- */
  function copyRoute(fromId, toId) {
    const now = Date.now();
    let ops = 0, setups = 0, skipped = 0;
    const keys = new Set();
    for (const o of opsOfPart(fromId)) {
      const jobs = jobsOfOperation(o.id).sort(bySeq);
      if (shop.operations.length >= limits.maxOperations) {
        // its setups cannot come across without it, so they count as left out too
        skipped += 1 + jobs.length;
        continue;
      }
      const op = {
        id: newId('o'),
        partId: toId,
        name: o.name,
        seq: o.seq,
        notes: o.notes,
        createdAt: now,
        updatedAt: now,
      };
      shop.operations.push(op);
      ops++;
      for (const a of jobs) {
        if (shop.assignments.length >= limits.maxAssignments) { skipped++; continue; }
        shop.assignments.push({
          id: newId('a'),
          toolId: a.toolId,
          machineId: a.machineId,
          operationId: op.id,
          station: a.station,
          seq: a.seq,
          indexEdges: a.indexEdges,
          partsPerIndex: a.partsPerIndex,
          notes: a.notes,
          runs: [],
          createdAt: now,
          updatedAt: now,
        });
        keys.add(pairKey(a.machineId, op.id));
        setups++;
      }
    }
    // The copies keep the numbering they came with; these close up any gap an
    // operation or a setup left out for want of room would otherwise leave.
    renumberPart(toId);
    for (const key of keys) renumberLayout(key);
    return { ops, setups, skipped };
  }

  // The number a cloned part starts on. Parts are revised more often than they
  // are replaced, so a trailing revision letter takes the next letter —
  // 12345-A becomes 12345-B — a number ending in digits takes the next number
  // the way a machine does, and anything else gets a number put on the end.
  // Only a suggestion: the form opens on it so it can be typed over.
  function nextPartNumber(number) {
    const taken = new Set(shop.parts.map(p => (p.number || '').toLowerCase()).filter(Boolean));
    const free = candidate => candidate.length <= 60 && !taken.has(candidate.toLowerCase());
    const onTheEnd = () => {
      for (let n = 2; n <= 999; n++) {
        const next = number + ' ' + n;
        if (free(next)) return next;
      }
      return '';
    };
    if (!number) return '';

    // A revision is one letter after something that is not a letter: 12345-A,
    // 778 C. A number simply ending in a word — "Housing" — is not a revision.
    const rev = number.match(/^(.*[^A-Za-z])([A-Za-z])$/);
    if (rev) {
      const [, head, letter] = rev;
      const upper = letter === letter.toUpperCase();
      const last = upper ? 'Z' : 'z';
      for (let c = letter.charCodeAt(0) + 1; c <= last.charCodeAt(0); c++) {
        const next = head + String.fromCharCode(c);
        if (free(next)) return next;
      }
      return onTheEnd();   // past Z: a suffix says less than a wrong revision
    }

    const digits = number.match(/^(.*?)(\d+)(\D*)$/);
    if (digits) {
      const [, head, num, tail] = digits;
      for (let n = Number(num) + 1; n <= Number(num) + 999; n++) {
        const next = head + String(n).padStart(num.length, '0') + tail;
        if (free(next)) return next;
      }
    }
    return onTheEnd();
  }

  function clonePart(id) {
    const p = partById(id);
    if (!p) return;
    if (shop.parts.length >= limits.maxParts) {
      flash('That is as many parts as one account keeps (' + limits.maxParts + ').');
      return;
    }
    openForm('part', '', { number: nextPartNumber(p.number), desc: p.desc, notes: p.notes, cloneOf: p.id });
  }

  function saveTool(draft) {
    const partNumber = cleanText(draft.partNumber);
    const desc = cleanText(draft.desc);
    if (!partNumber && !desc) return fail('Give the tool a part number or a description — something to know it by.');
    const tool = {
      partNumber,
      desc,
      cuttingEdges: Math.floor(cleanNum(draft.cuttingEdges)),
      cost: cleanNum(draft.cost),
      notes: cleanText(draft.notes).slice(0, 400),
    };
    const existing = toolById(draft.id);
    let created = null;
    if (existing) {
      Object.assign(existing, tool);
      touch(existing);
    } else {
      if (shop.tools.length >= limits.maxTools) {
        return fail('That is as many tools as one account keeps (' + limits.maxTools + ').');
      }
      created = { id: newId('t'), ...tool, createdAt: Date.now(), updatedAt: Date.now() };
      shop.tools.push(created);
    }
    done();
    // A tool in the crib is not yet cutting anything, and the numbers that
    // matter are the ones it gets on a machine.
    if (created) {
      if (shop.machines.length && shop.operations.length) openForm('assignment', '', { toolId: created.id });
      else flash('Added to the crib. Set it up on a machine to time it and give it a tool life.', true);
    }
  }

  function savePart(draft) {
    const number = cleanText(draft.number);
    const desc = cleanText(draft.desc);
    if (!number && !desc) return fail('Give the part a number or a description — something to know it by.');
    const clash = shop.parts.find(p => p.id !== draft.id && p.number && p.number.toLowerCase() === number.toLowerCase());
    if (number && clash) return fail('There is already a part numbered ' + clash.number + '.');
    const part = { number, desc, notes: cleanText(draft.notes).slice(0, 400) };
    const existing = partById(draft.id);
    let created = null;
    if (existing) {
      Object.assign(existing, part);
      touch(existing);
    } else {
      if (shop.parts.length >= limits.maxParts) {
        return fail('That is as many parts as one account keeps (' + limits.maxParts + ').');
      }
      created = { id: newId('p'), ...part, createdAt: Date.now(), updatedAt: Date.now() };
      shop.parts.push(created);
    }
    const from = created && draft.cloneOf ? partById(draft.cloneOf) : null;
    const copy = from ? copyRoute(draft.cloneOf, created.id) : null;
    done();
    if (copy) {
      const tail = copy.skipped ? ', ' + copy.skipped + ' left out for want of room' : '';
      flash(!copy.ops
        ? partName(created) + ' was added, but the part it was copied from has no operations on it.'
        : partName(created) + ' runs like ' + partName(from) + ' — ' + copy.ops +
          (copy.ops === 1 ? ' operation' : ' operations') + ' and ' + copy.setups +
          (copy.setups === 1 ? ' setup' : ' setups') + ' copied' + tail +
          '. Nothing has been timed on it yet.',
      !!copy.ops);
    }
    // A part is made by its operations; without one there is nothing to set a
    // tool up for. A clone that arrived with them needs no such prompt.
    if (created && !(copy && copy.ops)) openForm('operation', '', { partId: created.id });
  }

  function saveOperation(draft) {
    const part = partById(draft.partId);
    if (!part) return fail('Choose the part this operation is a step of.');
    const name = cleanText(draft.name);
    if (!name) return fail('An operation needs a name — Op 20, or whatever the traveller calls it.');
    const clash = shop.operations.find(o =>
      o.id !== draft.id && o.partId === part.id && o.name.toLowerCase() === name.toLowerCase());
    if (clash) return fail(partName(part) + ' already has an operation called ' + clash.name + '.');
    const operation = {
      partId: part.id,
      name,
      seq: Math.floor(cleanNum(draft.seq)),
      notes: cleanText(draft.notes).slice(0, 400),
    };
    const existing = operationById(draft.id);
    let created = null;
    if (existing) {
      Object.assign(existing, operation);
      touch(existing);
    } else {
      if (shop.operations.length >= limits.maxOperations) {
        return fail('That is as many operations as one account keeps (' + limits.maxOperations + ').');
      }
      created = { id: newId('o'), ...operation, createdAt: Date.now(), updatedAt: Date.now() };
      shop.operations.push(created);
    }
    renumberPart(part.id);
    done();
    if (created && shop.tools.length && shop.machines.length) {
      openForm('assignment', '', { operationId: created.id });
    }
  }

  // The steps of a part, numbered 1..n in the order they run.
  function renumberPart(partId) {
    opsOfPart(partId).forEach((o, i) => {
      if (o.seq !== i + 1) { o.seq = i + 1; touch(o); }
    });
  }

  function saveAssignment(draft) {
    if (!toolById(draft.toolId)) return fail('Choose the tool this is.');
    if (!machineById(draft.machineId)) return fail('Choose the machine it runs on.');
    if (!operationById(draft.operationId)) {
      return fail('Choose the operation it is cutting — the cycle times and the tool life belong to one.');
    }
    const assignment = {
      toolId: draft.toolId,
      machineId: draft.machineId,
      operationId: draft.operationId,
      station: cleanText(draft.station),
      seq: Math.floor(cleanNum(draft.seq)),
      indexEdges: Math.floor(cleanNum(draft.indexEdges)),
      partsPerIndex: Math.floor(cleanNum(draft.partsPerIndex)),
      notes: cleanText(draft.notes).slice(0, 400),
    };
    const existing = jobById(draft.id);
    if (existing) {
      const wasLayout = layoutKey(existing);
      Object.assign(existing, assignment);
      touch(existing);
      // Editing can move a tool to another machine or another operation, or
      // renumber it; close up the gap it left behind as well as the order it
      // joined.
      renumberLayout(wasLayout);
      if (layoutKey(existing) !== wasLayout) renumberLayout(layoutKey(existing));
    } else {
      if (shop.assignments.length >= limits.maxAssignments) {
        return fail('That is as many setups as one account keeps (' + limits.maxAssignments + ').');
      }
      const created = {
        id: newId('a'), ...assignment, runs: [], createdAt: Date.now(), updatedAt: Date.now(),
      };
      shop.assignments.push(created);
      renumberLayout(layoutKey(created));
      setActive(created.id); // a tool set up mid-shift is the one being timed next
    }
    done();
  }

  /* ---------------- numbering a tool layout ----------------
     The one thing about a layout somebody decides. A layout comes into being
     with a number already on it — the next free one — because a layout with no
     number could not be asked for, and this is where that number is changed to
     whatever the floor actually calls it.

     Two layouts cannot share a number: the number is how one is asked for, and
     a number that names two of them names neither.
  ---------------------------------------------------------------- */
  function saveLayout(draft) {
    const layout = layoutById(draft.id);
    if (!layout) return fail('That tool layout is not there any more.');
    const number = Math.floor(cleanNum(draft.number));
    if (!number) return fail('A tool layout needs a number — it is what it is asked for by on the floor.');
    if (number > (limits.maxLayoutNumber || 9999)) {
      return fail('Tool layout numbers go up to ' + (limits.maxLayoutNumber || 9999) + '.');
    }
    const clash = layoutList().find(l => l.id !== layout.id && l.number === number);
    if (clash) return fail('TL ' + number + ' is already ' + layoutWhere(clash) + '.');
    layout.number = number;
    layout.notes = cleanText(draft.notes).slice(0, 400);
    touch(layout);
    saveNote = 'numbered ' + layoutWhere(layout) + ' as TL ' + number;
    done();
  }

  // What a deletion would take with it, said in full before it happens: what
  // the setups are called from where the reader is standing, and how many timed
  // cycles go with them.
  function tally(jobs, one, many) {
    const runs = jobs.reduce((sum, a) => sum + a.runs.length, 0);
    return jobs.length + ' ' + (jobs.length === 1 ? one : many) +
      (runs ? ' and the ' + runs + (runs === 1 ? ' cycle' : ' cycles') + ' timed there' : '');
  }

  // A cell is a name for a group of machines, so deleting it takes the grouping
  // and nothing else: the machines stay on the floor, out of any cell.
  function deleteCell(id) {
    const c = cellById(id);
    if (!c) return;
    const machines = machinesOfCell(id);
    if (!confirm(machines.length
      ? 'Delete ' + c.name + '? The ' + machines.length +
        (machines.length === 1 ? ' machine in it stays' : ' machines in it stay') +
        ' on the floor, out of any cell.'
      : 'Delete ' + c.name + '?')) return;
    for (const m of machines) { m.cellId = ''; m.cellSeq = 0; touch(m); }
    shop.cells = cellList().filter(x => x.id !== id);
    afterDelete();
  }

  function deleteMachine(id) {
    const m = machineById(id);
    if (!m) return;
    const jobs = jobsOnMachine(id);
    if (!confirm(jobs.length
      ? 'Delete ' + m.name + ', the ' + tally(jobs, 'tool set up on it', 'tools set up on it') +
        '? The tools stay in the crib.'
      : 'Delete ' + m.name + '?')) return;
    shop.assignments = shop.assignments.filter(a => a.machineId !== id);
    shop.machines = shop.machines.filter(x => x.id !== id);
    afterDelete();
  }

  function deleteTool(id) {
    const t = toolById(id);
    if (!t) return;
    const jobs = jobsOfTool(id);
    if (!confirm(jobs.length
      ? 'Delete ' + toolName(t) + ', the ' + tally(jobs, 'setup it is in', 'setups it is in') + '?'
      : 'Delete ' + toolName(t) + '?')) return;
    shop.assignments = shop.assignments.filter(a => a.toolId !== id);
    shop.tools = shop.tools.filter(x => x.id !== id);
    afterDelete();
  }

  function deletePart(id) {
    const p = partById(id);
    if (!p) return;
    const ops = opsOfPart(id);
    const jobs = shop.assignments.filter(a => ops.some(o => o.id === a.operationId));
    if (!confirm(ops.length
      ? 'Delete ' + partName(p) + ', its ' + ops.length + (ops.length === 1 ? ' operation' : ' operations') +
        (jobs.length ? ', the ' + tally(jobs, 'tool set up for it', 'tools set up for them') : '') +
        '? The tools stay in the crib.'
      : 'Delete ' + partName(p) + '?')) return;
    const gone = new Set(ops.map(o => o.id));
    shop.assignments = shop.assignments.filter(a => !gone.has(a.operationId));
    shop.operations = shop.operations.filter(o => o.partId !== id);
    shop.parts = shop.parts.filter(x => x.id !== id);
    afterDelete();
  }

  function deleteOperation(id) {
    const o = operationById(id);
    if (!o) return;
    const jobs = jobsOfOperation(id);
    if (!confirm(jobs.length
      ? 'Delete ' + operationLabel(o) + ', the ' + tally(jobs, 'tool set up for it', 'tools set up for it') +
        '? The cycles timed on it belong to this op, so they go with it; the tools stay in the crib.'
      : 'Delete ' + operationLabel(o) + '?')) return;
    const partId = o.partId;
    shop.assignments = shop.assignments.filter(a => a.operationId !== id);
    shop.operations = shop.operations.filter(x => x.id !== id);
    renumberPart(partId);
    afterDelete();
  }

  function deleteAssignment(id) {
    const a = jobById(id);
    if (!a) return;
    const runs = a.runs.length;
    if (!confirm('Take ' + jobName(a) + ' off ' + machineName(a.machineId) +
      (runs ? ', with the ' + runs + (runs === 1 ? ' cycle' : ' cycles') + ' timed there' : '') +
      '? The tool stays in the crib.')) return;
    shop.assignments = shop.assignments.filter(x => x.id !== id);
    afterDelete();
  }

  // Every deletion above can leave the watch pointed at something that is gone,
  // and the setups it touched a tool short.
  function afterDelete() {
    for (const key of new Set(shop.assignments.map(layoutKey))) renumberLayout(key);
    if (!jobById(shop.activeId)) setActive(shop.assignments.length ? shop.assignments[0].id : '');
    done();
  }

  const DELETERS = {
    cell: deleteCell, machine: deleteMachine, tool: deleteTool, part: deletePart,
    operation: deleteOperation, assignment: deleteAssignment,
  };
  const DELETE_LABELS = {
    cell: 'Delete cell', machine: 'Delete machine', tool: 'Delete tool', part: 'Delete part',
    operation: 'Delete operation', assignment: 'Take off this machine',
  };

  function pickField(label, options, value, onChange) {
    const wrap = el('label', 'mf-field mf-field-wide');
    wrap.appendChild(el('span', 'mf-field-k', label));
    wrap.appendChild(dropdown('mf-input', options, value, onChange, label));
    return wrap;
  }

  function renderForm() {
    const box = els.form;
    box.innerHTML = '';
    box.hidden = !form;
    if (!form) return;
    const { kind, draft } = form;

    // A clone is the same form as a new one, opened on what it is copying.
    const clonePartOf = kind === 'part' && draft.cloneOf ? partById(draft.cloneOf) : null;
    const cloneOf = kind === 'machine' && draft.cloneOf ? machineById(draft.cloneOf) : null;
    box.appendChild(el('div', 'mf-section-title',
      clonePartOf ? 'Clone ' + partName(clonePartOf)
        : cloneOf ? 'Clone ' + cloneOf.name
          : FORM_TITLES[kind][draft.id ? 1 : 0]));
    if (clonePartOf) {
      const ops = opsOfPart(clonePartOf.id);
      const setups = ops.reduce((n, o) => n + jobsOfOperation(o.id).length, 0);
      box.appendChild(el('div', 'mf-note', !ops.length
        ? 'There are no operations on ' + partName(clonePartOf) +
          ' yet, so this is a new part number and nothing more.'
        : 'Saving this makes a part number that runs like ' + partName(clonePartOf) + ': all ' +
          ops.length + (ops.length === 1 ? ' operation' : ' operations') +
          (setups
            ? ' copied, and the ' + setups + (setups === 1 ? ' setup' : ' setups') +
              ' on them — the same tools, on the same machines, in the same stations, with the ' +
              'indexable edges and tool life worked out for them'
            : ' copied — no tools are set up for them yet') +
          '. The cycles timed on ' + partName(clonePartOf) + ' stay with it: they were measured ' +
          'making that part.'));
    }
    if (cloneOf) {
      const tools = distinctTools(cloneOf.id);
      const setups = jobsOnMachine(cloneOf.id).length;
      box.appendChild(el('div', 'mf-note', !tools
        ? 'There are no tools on ' + cloneOf.name + ' yet, so this is a new machine and nothing more.'
        : draft.withOps
          ? 'Saving this makes a second machine set up like ' + cloneOf.name + ': all ' + setups +
            (setups === 1 ? ' setup' : ' setups') + ' copied — the same tools, in the same stations, ' +
            'on the same operations, with the indexable edges and tool life worked out ' +
            'for them. The cycles timed on ' + cloneOf.name + ' stay with it: they were measured on ' +
            'that machine.'
          : 'Saving this makes a second machine with the ' + tools +
            (tools === 1 ? ' tool' : ' tools') + ' on ' + cloneOf.name +
            ' copied onto it, in the same stations — the tools and nothing else. Which operations they ' +
            'cut, and the tool life that goes with them, belong to the op, and the ' +
            'cycles timed on ' + cloneOf.name + ' were measured on that machine.'));
      if (tools) {
        const opt = el('label', 'mf-check');
        const box2 = el('input');
        box2.type = 'checkbox';
        box2.checked = !!draft.withOps;
        box2.addEventListener('change', () => { draft.withOps = box2.checked; renderForm(); });
        opt.appendChild(box2);
        opt.appendChild(el('span', null,
          'Bring the operations too — each tool on the op it cuts on ' + cloneOf.name +
          ', with that op\'s tool life'));
        box.appendChild(opt);
      }
    }
    // A layout is not chosen or made here — the machine, the part and the op
    // are what it is, and they are already settled by the tools set up on it.
    // What this form is for is the number, so what the number names is said
    // above it.
    if (kind === 'layout') {
      const layout = layoutById(draft.id);
      const jobs = layout ? layoutJobsOf(layout) : [];
      box.appendChild(el('div', 'mf-note', layoutWhere(layout) + ' — ' + jobs.length +
        (jobs.length === 1 ? ' tool set up on it' : ' tools set up on it') +
        '. The machine, the part and the op are what this layout is; the number is what it is ' +
        'called on the floor, and no two layouts here can share one.'));
    }
    const grid = el('div', 'mf-grid');

    // A setup is a link before it is anything else, so the three things it
    // joins are chosen first and the fields under them read as belonging to
    // that combination rather than to any one of them.
    if (kind === 'assignment') {
      grid.appendChild(pickField('Tool',
        [{ value: '', label: 'Choose a tool…' }].concat(shop.tools.map(t => ({
          value: t.id,
          label: toolName(t) + (t.partNumber && t.desc ? ' — ' + t.partNumber : '') +
            (t.cuttingEdges ? ' (' + t.cuttingEdges + ' edges)' : ''),
        }))),
        draft.toolId, v => {
          draft.toolId = v;
          const tool = toolById(v);
          // the tool's own edge count is the sensible default for how many get
          // indexed through here; it stays editable
          if (tool && tool.cuttingEdges && !cleanNum(draft.indexEdges)) {
            draft.indexEdges = String(tool.cuttingEdges);
            renderForm();
          }
        }));
      grid.appendChild(pickField('Machine',
        [{ value: '', label: 'Choose a machine…' }].concat(shop.machines.map(m => ({ value: m.id, label: m.name }))),
        draft.machineId, v => { draft.machineId = v; }));
      grid.appendChild(pickField('Operation',
        [{ value: '', label: 'Choose an operation…' }].concat(operationOptions()),
        draft.operationId, v => { draft.operationId = v; }));
    }
    // Which cell a machine stands in — the one relation a machine has, and what
    // the value stream is drawn from.
    if (kind === 'machine') {
      grid.appendChild(pickField('Cell',
        [{ value: '', label: cellList().length ? 'No cell' : 'No cells yet' }]
          .concat(allCells().map(c => ({ value: c.id, label: c.name }))),
        draft.cellId, v => {
          draft.cellId = v;
          // taking the next free place in the cell it has just joined
          if (v && !cleanNum(draft.cellSeq)) {
            draft.cellSeq = String(machinesOfCell(v)
              .filter(m => m.id !== draft.id)
              .reduce((max, m) => Math.max(max, m.cellSeq || 0), 0) + 1);
          }
          renderForm();
        }));
    }
    if (kind === 'operation') {
      grid.appendChild(pickField('Part',
        [{ value: '', label: 'Choose a part…' }].concat(
          [...shop.parts].sort((x, y) => partName(x).localeCompare(partName(y)))
            .map(p => ({ value: p.id, label: partName(p) }))),
        draft.partId, v => { draft.partId = v; }));
    }

    for (const f of FORM_FIELDS[kind]) {
      // A position in a cell says nothing about a machine that is in none
      if (f.key === 'cellSeq' && !draft.cellId) continue;
      const wrap = el('label', 'mf-field' + (f.wide ? ' mf-field-wide' : ''));
      wrap.appendChild(el('span', 'mf-field-k', f.label));
      const input = el('input', 'mf-input');
      input.value = draft[f.key] == null ? '' : String(draft[f.key]);
      input.placeholder = f.placeholder || '';
      if (f.num) { input.inputMode = 'decimal'; input.autocomplete = 'off'; }
      if (f.hint) input.title = f.hint;
      input.addEventListener('input', () => { draft[f.key] = input.value; });
      wrap.appendChild(input);
      if (f.hint) wrap.appendChild(el('span', 'mf-field-hint', f.hint));
      grid.appendChild(wrap);
    }

    const notes = el('label', 'mf-field mf-field-wide');
    notes.appendChild(el('span', 'mf-field-k', 'Notes'));
    const area = el('textarea', 'mf-input mf-area');
    area.value = draft.notes || '';
    area.rows = 2;
    area.placeholder = {
      assignment: 'Speeds and feeds, what it sounds like when it is dull, anything worth the next setup knowing',
      tool: 'Grade, chipbreaker, where it is kept',
      machine: 'Control, spindle, anything the next setup should know',
      part: 'Material, stock size, anything the whole job depends on',
      operation: 'Fixture, orientation, what this op leaves for the next',
      cell: 'What runs in this cell, how it is manned, what feeds it',
      layout: 'Fixture, offsets, work stops — anything the next person setting this layout should know',
    }[kind];
    area.addEventListener('input', () => { draft.notes = area.value; });
    notes.appendChild(area);
    grid.appendChild(notes);
    box.appendChild(grid);

    if (kind === 'assignment') {
      const tool = toolById(draft.toolId);
      const edges = Math.floor(cleanNum(draft.indexEdges));
      if (tool && tool.cuttingEdges && edges > tool.cuttingEdges) {
        box.appendChild(el('div', 'mf-note', 'That is more edges than ' + toolName(tool) + ' has (' +
          tool.cuttingEdges + '). Either the tool\'s edge count is low or this one is high.'));
      }
    }
    if (formError) box.appendChild(el('div', 'mf-error', formError));

    const row = el('div', 'mf-form-btns');
    row.appendChild(button('mf-btn mf-btn-go', 'Save', saveForm));
    row.appendChild(button('mf-btn mf-btn-quiet', 'Cancel', closeForm));
    // A tool layout has no delete of its own: it exists exactly as long as
    // there are tools set up on it, so taking the last one off is what ends it.
    if (draft.id && DELETERS[kind]) {
      row.appendChild(button('mf-btn mf-btn-danger', DELETE_LABELS[kind], () => DELETERS[kind](draft.id)));
    }
    box.appendChild(row);
  }

  /* ---------------- choosing what to time ---------------- */
  // Pointing the watch at a different setup. The time on the display belonged
  // to the one that just left, and its cycles are already recorded against it,
  // so the watch starts the new one from zero. Returns false if nothing moved.
  // Picking a tool by hand starts a fresh measurement, so the watch goes back
  // to zero with it. Moving down the op mid-run is the opposite: the watch has
  // to carry on, because the next tool starts cutting the moment the last one
  // stops, and a reset there would throw away the split that is already
  // running. Only lapNext asks for that.
  function setActive(id, keepWatch) {
    if (!shop || shop.activeId === id) return false;
    shop.activeId = id;
    if (!keepWatch) reset();
    return true;
  }

  function selectJob(id, keepWatch) {
    if (!setActive(id, keepWatch)) return;
    save();
    render();
  }

  /* ---------------- the three lists ----------------
     The same records read from three ends: the parts with the operations that
     make them, the machines with the tools set up on them, and the crib with
     the machines each tool runs on. Which one you want depends on whether you
     are holding a traveller, standing at a machine, or holding a tool.
  ---------------------------------------------------------------- */
  const hay = (...parts) => parts.filter(Boolean).join(' ').toLowerCase();

  function matchesMachine(m) {
    const cell = m.cellId ? cellById(m.cellId) : null;
    return !filter || hay(m.name, m.notes, cell && cell.name, cell && cell.notes).includes(filter);
  }
  function matchesTool(t) {
    return !filter || hay(t.partNumber, t.desc, t.notes).includes(filter);
  }
  function matchesPart(p) {
    return !filter || hay(p.number, p.desc, p.notes).includes(filter);
  }
  function matchesJob(a) {
    if (!filter) return true;
    const tool = jobTool(a);
    const part = jobPart(a);
    const op = jobOperation(a);
    const layout = layoutOf(a);
    const cell = cellOfMachine(a.machineId);
    // A layout is asked for by its number on the floor, so typing TL 12 — or
    // just 12 — is a way of asking for everything on it; typing a cell's name
    // is a way of asking for every layout in that cell.
    return hay(a.station, a.notes, machineName(a.machineId), op && op.name,
      part && part.number, part && part.desc,
      layout && tlName(layout), layout && layout.notes, cell && cell.name,
      tool && tool.partNumber, tool && tool.desc).includes(filter);
  }

  // The filter narrows all three lists, so it sits above them rather than
  // inside one of them — where folding that list away would take it with it.
  // It is built once and then left alone: typing in it redraws the lists under
  // it, and rebuilding the box you are typing in would lose the caret.
  function renderSearch() {
    const box = els.search;
    const worth = shop && (shop.parts.length > 3 || shop.machines.length > 3 ||
      shop.tools.length > 3 || shop.assignments.length > 3);
    box.hidden = !worth;
    if (!worth) { box.innerHTML = ''; return; }
    if (box.firstChild) {
      if (box.firstChild.value !== filter) box.firstChild.value = filter;
      return;
    }
    const search = el('input', 'mf-input mf-search');
    search.type = 'search';
    search.placeholder = 'Filter by cell, tool layout, part, op, machine, tool…';
    search.value = filter;
    search.addEventListener('input', () => {
      filter = search.value.trim().toLowerCase();
      renderParts();
      renderMachines();
      renderTools();
    });
    box.appendChild(search);
  }

  // Every list heading is a section head with a count and a fold on it, so the
  // three of them read and behave alike.
  function sectionHead(key, title, count, redraw, action) {
    const head = el('div', 'mf-section-head');
    head.appendChild(foldToggle(key, title, 'mf-section-title', redraw));
    head.appendChild(el('span', 'mf-fold-count', String(count)));
    if (action) head.appendChild(action);
    return head;
  }

  function renderParts() {
    const box = els.parts;
    box.innerHTML = '';
    if (!shop) return;

    box.appendChild(sectionHead('sec:parts', 'Parts and operations', shop.parts.length, renderParts,
      wBtn('mf-btn mf-btn-sm', '+ Part', () => openForm('part'))));
    if (isFolded('sec:parts')) return;

    if (!shop.parts.length) {
      box.appendChild(el('div', 'mf-note',
        'No parts yet. A part has operations, and an operation is what a tool is set up for — which is what gives a cycle time something to be true of.'));
      return;
    }

    let shownAny = false;
    for (const p of [...shop.parts].sort((x, y) => partName(x).localeCompare(partName(y)))) {
      const ops = opsOfPart(p.id);
      const shown = matchesPart(p) ? ops : ops.filter(o => jobsOfOperation(o.id).some(matchesJob) ||
        (filter && o.name.toLowerCase().includes(filter)));
      if (filter && !shown.length && !matchesPart(p)) continue;
      shownAny = true;

      const fold = 'part:' + p.id;
      const block = el('div', 'mf-machine');
      const ph = el('div', 'mf-machine-head');
      ph.appendChild(foldToggle(fold, partName(p), 'mf-machine-k', renderParts));
      // folded, the heading is all there is, so it carries the count as well
      ph.appendChild(el('div', 'mf-machine-v', [
        p.number && p.desc ? p.desc : '',
        ops.length ? ops.length + (ops.length === 1 ? ' op' : ' ops') : 'no ops yet',
      ].filter(Boolean).join(' · ')));
      const pb = el('div', 'mf-machine-btns');
      put(pb, wBtn('mf-btn mf-btn-sm', '+ Operation', () => openForm('operation', '', { partId: p.id }),
        'Another step in making this part'));
      const routed = ops.reduce((n, o) => n + jobsOfOperation(o.id).length, 0);
      put(pb, wBtn('mf-link', 'Clone', () => clonePart(p.id),
        ops.length
          ? 'A second part number running the same route: these ' + ops.length +
            (ops.length === 1 ? ' operation' : ' operations') +
            (routed ? ' and the ' + routed + (routed === 1 ? ' setup' : ' setups') + ' on them' : '')
          : 'A second part number like this one'));
      put(pb, wBtn('mf-link', 'Edit', () => openForm('part', p.id)));
      ph.appendChild(pb);
      block.appendChild(ph);

      if (isFolded(fold)) { box.appendChild(block); continue; }

      if (!shown.length) {
        block.appendChild(el('div', 'mf-note', ops.length
          ? 'Nothing on this part matches that.'
          : 'No operations yet — a part is made by its ops, and a tool is set up for one of them.'));
        box.appendChild(block);
        continue;
      }

      for (const o of shown) {
        const jobs = jobsOfOperation(o.id).sort(bySeq);
        const row = el('div', 'mf-op' + (jobs.some(a => a.id === shop.activeId) ? ' mf-op-on' : ''));
        const name = el('div', 'mf-op-k');
        name.appendChild(el('span', 'mf-seq', o.seq ? String(o.seq) : '–'));
        name.appendChild(el('span', 'mf-op-name', o.name));
        row.appendChild(name);

        // An op run on two machines is two tool layouts, so the machines are
        // named by the layout each is: that is what would be asked for.
        const tls = layoutsOfOperation(o.id);
        const bits = [];
        bits.push(tls.length
          ? tls.map(l => tlName(l) + ' ' + machineName(l.machineId)).join(', ')
          : 'no machine yet');
        bits.push(jobs.length ? jobs.length + (jobs.length === 1 ? ' tool' : ' tools') : 'no tools set up');
        let total = 0, timed = 0;
        for (const a of jobs) {
          const s = statsFor(a);
          if (s) { total += s.avg; timed++; }
        }
        if (timed) bits.push(fmtSec(total) + ' measured');
        row.appendChild(el('div', 'mf-op-v', bits.join(' · ')));

        const acts = el('div', 'mf-op-btns');
        if (jobs.length) {
          acts.appendChild(button('mf-link', canEdit() ? 'Time it' : 'Show',
            () => selectJob(jobs[0].id),
            canEdit() ? 'Point the watch at the first tool of this op'
              : 'Show this op\'s first tool and its numbers'));
        } else {
          put(acts, wBtn('mf-link', 'Set up a tool', () => openForm('assignment', '', { operationId: o.id })));
        }
        put(acts, wBtn('mf-link', 'Edit', () => openForm('operation', o.id)));
        row.appendChild(acts);
        block.appendChild(row);
      }
      box.appendChild(block);
    }
    if (!shownAny) box.appendChild(el('div', 'mf-note', 'No part matches that.'));
  }

  /* ---------------- the machines, cell by cell ----------------
     A floor is read by area before it is read by machine: which cell, then
     which machine in it, then what is set up on that machine. Cells come in
     flow order and their machines in the order the work reaches them, so the
     list reads the way the part moves. Machines in no cell are a group of their
     own at the end rather than being hidden or invented a cell for.
  ---------------------------------------------------------------- */
  function renderMachines() {
    const box = els.machines;
    box.innerHTML = '';
    if (!shop) return;

    const head = el('div', 'mf-section-head');
    head.appendChild(foldToggle('sec:machines', 'Cells and machines', 'mf-section-title', renderMachines));
    head.appendChild(el('span', 'mf-fold-count', String(shop.machines.length)));
    const acts = el('div', 'mf-section-acts');
    put(acts, wBtn('mf-btn mf-btn-sm', '+ Cell', () => openForm('cell'),
      'An area of the floor, holding the machines that work together'));
    put(acts, wBtn('mf-btn mf-btn-sm', '+ Machine', () => openForm('machine')));
    head.appendChild(acts);
    box.appendChild(head);
    if (isFolded('sec:machines')) return;

    if (!shop.machines.length) {
      box.appendChild(el('div', 'mf-note', 'No machines yet. A machine is what a tool gets set up on.'));
      return;
    }

    // every cell in flow order, then whatever stands outside them
    const groups = allCells().map(c => ({ cell: c, machines: machinesOfCell(c.id) }));
    const loose = shop.machines.filter(m => !m.cellId || !cellById(m.cellId))
      .sort((a, b) => a.name.localeCompare(b.name));
    if (loose.length) groups.push({ cell: null, machines: loose });

    let shownAnyCell = false;
    for (const group of groups) {
      const drawn = group.machines.filter(m => matchesMachine(m) || jobsOnMachine(m.id).some(matchesJob));
      const cell = group.cell;
      // A cell whose own name matches shows everything in it
      const cellMatches = cell && !!filter && hay(cell.name, cell.notes).includes(filter);
      const shown = cellMatches ? group.machines : drawn;
      if (filter && !shown.length) continue;
      shownAnyCell = true;
      if (cell) box.appendChild(cellHead(cell));
      else if (groups.length > 1) box.appendChild(cellHead(null));
      renderMachineBlocks(box, shown);
    }
    if (!shownAnyCell) box.appendChild(el('div', 'mf-note', 'Nothing on the floor matches that.'));
  }

  /* The heading of one cell: what it is called, what is in it, and — because a
     cell is only worth naming for what runs through it — the routes it carries,
     each part's operations in the order they run. */
  function cellHead(cell) {
    const wrap = el('div', 'mf-cell');
    const head = el('div', 'mf-cell-head');
    head.appendChild(el('div', 'mf-cell-k', cell ? cell.name : 'Not in a cell'));
    const machines = cell ? machinesOfCell(cell.id) : shop.machines.filter(m => !m.cellId);
    const jobs = cell ? jobsOfCell(cell.id) : [];
    const bits = [machines.length + (machines.length === 1 ? ' machine' : ' machines')];
    if (cell && jobs.length) bits.push(jobs.length + (jobs.length === 1 ? ' tool' : ' tools'));
    head.appendChild(el('div', 'mf-cell-v', bits.join(' · ')));
    if (cell) {
      const acts = el('div', 'mf-cell-btns');
      put(acts, wBtn('mf-link', 'Edit', () => openForm('cell', cell.id)));
      head.appendChild(acts);
    }
    wrap.appendChild(head);

    if (cell) {
      const routes = routesThroughCell(cell.id);
      if (routes.length) {
        for (const route of routes) {
          const line = el('div', 'mf-route');
          line.appendChild(el('span', 'mf-route-k', partName(route.part)));
          line.appendChild(el('span', 'mf-route-v',
            route.steps.map(st => st.op.name + ' · ' + st.machineIds.map(machineName).join(' / '))
              .join('  →  ')));
          wrap.appendChild(line);
        }
      } else {
        wrap.appendChild(el('div', 'mf-note', machines.length
          ? 'Nothing is set up in this cell yet, so nothing runs through it.'
          : 'No machines in this cell yet.'));
      }
    }
    return wrap;
  }

  /* What runs through a cell, and in what order: for each part with operations
     cut in this cell, those operations in the order they are run — which is the
     order of operations for that cell, and one lane of the value stream. */
  function routesThroughCell(cellId) {
    if (!shop) return [];
    const byPart = new Map();
    for (const l of layoutList()) {
      const c = cellOfMachine(l.machineId);
      if (!c || c.id !== cellId) continue;
      const op = operationById(l.operationId);
      if (!op) continue;
      if (!byPart.has(op.partId)) byPart.set(op.partId, new Map());
      // One step per operation, however many machines in the cell can run it —
      // two machines cutting the same op are a choice, not two steps, so both
      // are named on the one step.
      const steps = byPart.get(op.partId);
      if (!steps.has(op.id)) steps.set(op.id, { op, machineIds: [] });
      steps.get(op.id).machineIds.push(l.machineId);
    }
    const flowOf = id => {
      const m = machineById(id);
      return m && m.cellSeq ? m.cellSeq : Infinity;
    };
    return [...byPart.entries()]
      .map(([partId, steps]) => ({
        part: partById(partId),
        steps: [...steps.values()]
          .map(st => ({ ...st, machineIds: st.machineIds.sort((x, y) => flowOf(x) - flowOf(y)) }))
          .sort((x, y) => byStep(x.op, y.op)),
      }))
      .filter(r => r.part)
      .sort((a, b) => partName(a.part).localeCompare(partName(b.part)));
  }

  function renderMachineBlocks(box, machines) {
    for (const m of machines) {
      const all = jobsOnMachine(m.id);
      // a machine whose own name matches shows everything on it; otherwise only
      // the tools that match are listed under it
      const jobs = matchesMachine(m) ? all : all.filter(matchesJob);
      if (filter && !jobs.length && !matchesMachine(m)) continue;

      const fold = 'machine:' + m.id;
      const block = el('div', 'mf-machine');
      const mh = el('div', 'mf-machine-head');
      mh.appendChild(foldToggle(fold, m.name, 'mf-machine-k', renderMachines));
      let total = 0, timed = 0;
      for (const a of all) {
        const s = statsFor(a);
        if (s) { total += s.avg; timed++; }
      }
      mh.appendChild(el('div', 'mf-machine-v', all.length
        ? all.length + (all.length === 1 ? ' tool' : ' tools') + (timed ? ' · ' + fmtSec(total) + ' timed' : '')
        : 'no tools yet'));
      const mb = el('div', 'mf-machine-btns');
      put(mb, wBtn('mf-btn mf-btn-sm', '+ Tool here', () => openForm('assignment', '', { machineId: m.id }),
        'Set a tool from the crib up on this machine'));
      const tooled = distinctTools(m.id);
      put(mb, wBtn('mf-link', 'Clone', () => cloneMachine(m.id),
        tooled
          ? 'A second machine of the same kind, carrying these ' + tooled +
            (tooled === 1 ? ' tool' : ' tools') + ' in the same stations'
          : 'A second machine of the same kind'));
      put(mb, wBtn('mf-link', 'Edit', () => openForm('machine', m.id)));
      mh.appendChild(mb);
      block.appendChild(mh);

      if (isFolded(fold)) { box.appendChild(block); continue; }

      if (!jobs.length) {
        block.appendChild(el('div', 'mf-note', all.length
          ? 'Nothing on this machine matches that.'
          : 'No tools set up on this machine yet.'));
        box.appendChild(block);
        continue;
      }

      // within a machine, the tools are grouped by the tool layout they are on
      // — the operation they are set up for — and run in the order they cut
      const groups = new Map();
      for (const a of jobs) {
        const key = layoutKey(a);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(a);
      }
      for (const group of groups.values()) group.sort(bySeq);
      for (const group of groups.values()) {
        const gh = el('div', 'mf-group');
        const layout = layoutOf(group[0]);
        if (layout) gh.appendChild(tlChip(layout, 'mf-tl-sm'));
        gh.appendChild(el('div', 'mf-group-k', jobLabel(group[0])));
        let gTotal = 0, gTimed = 0;
        for (const a of group) {
          const s = statsFor(a);
          if (s) { gTotal += s.avg; gTimed++; }
        }
        if (gTimed) {
          gh.appendChild(el('div', 'mf-group-v', fmtSec(gTotal) + ' over ' + gTimed +
            (gTimed === 1 ? ' timed tool' : ' timed tools')));
        }
        block.appendChild(gh);
        // Reordering is only offered on the unfiltered list: moving a tool past
        // a neighbour that a filter is hiding would not do what it looks like.
        group.forEach((a, pos) => block.appendChild(jobCard(a, group, pos, !filter)));
      }
      box.appendChild(block);
    }
  }

  function jobCard(a, group, pos, canMove) {
    const card = el('div', 'mf-card' + (a.id === shop.activeId ? ' mf-card-on' : ''));
    card.tabIndex = 0;
    card.setAttribute('role', 'button');

    const top = el('div', 'mf-card-top');
    top.appendChild(el('span', 'mf-seq', a.seq ? String(a.seq) : '–'));
    if (a.station) top.appendChild(el('span', 'mf-chip', a.station));
    top.appendChild(el('span', 'mf-card-name', jobName(a)));
    const s = statsFor(a);
    if (s) top.appendChild(el('span', 'mf-card-avg', fmtSec(s.avg)));
    if (canMove && group.length > 1 && canEdit()) {
      const moves = el('span', 'mf-moves');
      const move = (label, to, enabled, title) => {
        const b = button('mf-move', label, e => { e.stopPropagation(); moveJob(a.id, to); }, title);
        b.disabled = !enabled;
        moves.appendChild(b);
      };
      move('↑', pos - 1, pos > 0, 'Run this tool earlier in the op');
      move('↓', pos + 1, pos < group.length - 1, 'Run this tool later in the op');
      top.appendChild(moves);
    }
    card.appendChild(top);

    const tool = jobTool(a);
    const meta = [];
    if (tool && tool.partNumber) meta.push(tool.partNumber);
    if (s && s.avgCut) meta.push(fmtSec(s.avgCut) + ' in cut');
    if (a.indexEdges) meta.push(a.indexEdges + ' edges');
    if (a.partsPerIndex) meta.push(a.partsPerIndex + ' parts/index');
    if (meta.length) card.appendChild(el('div', 'mf-card-meta', meta.join(' · ')));

    const foot = el('div', 'mf-card-foot');
    const life = lifeFor(a, s ? s.avg : 0, s ? s.avgCut : 0);
    foot.appendChild(el('span', null,
      (s ? s.count + (s.count === 1 ? ' cycle' : ' cycles') : 'not timed yet') +
      (life ? ' · index every ' + life.parts + ' parts' : '')));
    foot.appendChild(button('mf-link', 'Setup', e => { e.stopPropagation(); openForm('assignment', a.id); },
      'The operation, edges and tool life of this tool here'));
    card.appendChild(foot);

    const choose = () => selectJob(a.id);
    card.addEventListener('click', choose);
    card.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); choose(); }
    });
    return card;
  }

  // Move a tool one place earlier or later in its operation, and renumber so
  // the sequence stays 1..n.
  function moveJob(id, to) {
    const a = jobById(id);
    if (!a) return;
    const order = layoutJobs(a);
    const from = order.indexOf(a);
    if (to < 0 || to >= order.length || to === from) return;
    order.splice(to, 0, ...order.splice(from, 1));
    order.forEach((x, i) => { x.seq = i + 1; touch(x); });
    save();
    renderChart();
    renderCutChart();
    renderMachines();
  }

  function renderTools() {
    const box = els.tools;
    box.innerHTML = '';
    if (!shop) return;

    box.appendChild(sectionHead('sec:tools', 'Tools', shop.tools.length, renderTools,
      wBtn('mf-btn mf-btn-sm', '+ Tool', () => openForm('tool'))));
    if (isFolded('sec:tools')) return;

    if (!shop.tools.length) {
      box.appendChild(el('div', 'mf-note',
        'The crib is empty. A tool is a part number, what it is, and how many cutting edges it has — the same wherever it runs.'));
      return;
    }

    // a tool shows if it matches, or if any setup it is in does
    const shown = shop.tools.filter(t => matchesTool(t) || jobsOfTool(t.id).some(matchesJob));
    if (!shown.length) {
      box.appendChild(el('div', 'mf-note', 'No tool matches that.'));
      return;
    }

    for (const t of [...shown].sort((x, y) => toolName(x).localeCompare(toolName(y)))) {
      const card = el('div', 'mf-card mf-card-crib');
      const top = el('div', 'mf-card-top');
      if (t.partNumber) top.appendChild(el('span', 'mf-chip', t.partNumber));
      top.appendChild(el('span', 'mf-card-name', t.desc || t.partNumber));
      if (t.cuttingEdges) {
        top.appendChild(el('span', 'mf-card-num', t.cuttingEdges + (t.cuttingEdges === 1 ? ' edge' : ' edges')));
      }
      card.appendChild(top);

      const jobs = jobsOfTool(t.id);
      const tags = el('div', 'mf-tags');
      if (jobs.length) {
        // the other direction of the relation: every machine this one tool is
        // set up on, and what it is cutting there
        for (const a of jobs.sort((x, y) => machineName(x.machineId).localeCompare(machineName(y.machineId)))) {
          // Which layout, then where in it: a tool on three layouts is asked
          // for by the number of the one you mean.
          const layout = layoutOf(a);
          const label = (layout ? tlName(layout) + ' · ' : '') + machineName(a.machineId) +
            (a.station ? ' · ' + a.station : '');
          const st = statsFor(a);
          tags.appendChild(button('mf-tag' + (a.id === shop.activeId ? ' mf-tag-on' : ''), label,
            () => selectJob(a.id),
            [jobLabel(a), st && st.avgCut ? fmtSec(st.avgCut) + ' in cut' : '',
              a.partsPerIndex ? a.partsPerIndex + ' parts per index' : 'no tool life set yet'].filter(Boolean).join(' · ')));
        }
      } else {
        tags.appendChild(el('span', 'mf-tag mf-tag-off', 'Not set up anywhere yet'));
      }
      card.appendChild(tags);

      const foot = el('div', 'mf-card-foot');
      const bits = [];
      if (t.cost) bits.push('costs ' + t.cost);
      const machines = machinesOfTool(t.id).length;
      bits.push(machines ? 'on ' + machines + (machines === 1 ? ' machine' : ' machines') : 'unassigned');
      foot.appendChild(el('span', null, bits.join(' · ')));
      foot.appendChild(button('mf-link', 'Set up', () => openForm('assignment', '', { toolId: t.id }),
        'Put this tool on a machine, for an operation'));
      put(foot, wBtn('mf-link', 'Edit', () => openForm('tool', t.id)));
      card.appendChild(foot);
      box.appendChild(card);
    }
  }

  /* ---------------- import ----------------
     A spreadsheet of tooling goes back in the way it came out. The columns are
     the ones the export writes, read by name rather than by position, so a file
     with them reordered, renamed to a common alternative, or missing the ones
     that do not apply still reads. The worked-out columns the export adds
     (cycles timed, average, parts per tool) are ignored on the way in — they
     are derived, and taking them as given would let a stale figure in a
     spreadsheet contradict the times it was supposed to summarize.

     One row can name a part, an operation of it, a machine, a tool, the setup
     joining them and a cycle timed against it; whichever of those it names are
     the ones it makes. An import never deletes anything. A part is matched by
     number, an operation by its name within that part, a machine by name, a
     tool by its part number and description, and a setup by the machine, tool
     and operation it joins plus the pocket it sits in. Re-importing the same
     file changes nothing, because a cycle is recognized by when it was recorded
     and how long it took.

     The tool layout number is the one column that is neither a record's own
     field nor derived: it belongs to the machine-and-op pair the row names. It
     is taken where it is free, so a file exported from here goes back in with
     its layouts still called what they were called.
  ---------------------------------------------------------------- */
  // Each record that can carry notes has its own notes column, so none can
  // swallow another's and a file that came out of here goes back in whole.
  const IMPORT_COLUMNS = [
    'cell', 'tool_layout',
    'machine', 'machine_notes',
    'part', 'part_description', 'part_notes', 'op', 'op_notes',
    'seq', 'station',
    'tool_part_number', 'tool_description', 'cutting_edges', 'tool_cost', 'tool_notes',
    'indexable_edges', 'parts_per_index',
    'notes', 'cycle_seconds', 'cycle_cut_seconds', 'recorded_at',
  ];
  const DERIVED_COLUMNS = ['cycles_timed', 'average_seconds', 'parts_per_tool'];
  // header name (normalized) → the field it fills. The export's own names, the
  // shorter ones a person is likely to type, and the ones earlier versions of
  // this add-on wrote, so a file exported before any of this still reads.
  const COLUMN_ALIASES = {
    tool_layout: 'layout', tool_layout_number: 'layout', layout: 'layout',
    layout_number: 'layout', tl: 'layout',
    cell: 'cell', work_cell: 'cell', cell_name: 'cell', area: 'cell',
    machine: 'machine', machine_name: 'machine', machine_no: 'machine',
    machine_notes: 'machineNotes', machine_note: 'machineNotes',
    tool_notes: 'toolNotes', tool_note: 'toolNotes',
    part: 'part', part_number: 'part', partno: 'part', job: 'part',
    part_description: 'partDesc', part_desc: 'partDesc', part_name: 'partDesc',
    part_notes: 'partNotes', part_note: 'partNotes',
    op: 'op', operation: 'op', op_name: 'op',
    op_notes: 'opNotes', op_note: 'opNotes', operation_notes: 'opNotes',
    seq: 'seq', sequence: 'seq', order: 'seq',
    station: 'station', turret: 'station', pocket: 'station',
    tool_part_number: 'toolPartNumber', tool_part: 'toolPartNumber', tool_pn: 'toolPartNumber',
    tool_number: 'toolPartNumber', tool_no: 'toolPartNumber',
    insert: 'toolPartNumber', // what version 1 called the tool's own number
    tool_description: 'desc', tool: 'desc', description: 'desc',
    cutting_edges: 'cuttingEdges', edges: 'cuttingEdges',
    indexes_per_insert: 'cuttingEdges', indexes: 'cuttingEdges', // version 1
    indexable_edges: 'indexEdges', index_edges: 'indexEdges', indexable: 'indexEdges',
    parts_per_index: 'partsPerIndex', parts_between_indexes: 'partsPerIndex',
    tool_life_parts: 'partsPerIndex', parts_per_edge: 'partsPerIndex',
    tool_life_min_per_edge: 'lifeMin', tool_life: 'lifeMin', tool_life_min: 'lifeMin', life_min: 'lifeMin',
    tool_cost: 'cost', insert_cost: 'cost', cost: 'cost',
    notes: 'notes', note: 'notes',
    cycle_seconds: 'sec', cycle_sec: 'sec', seconds: 'sec', cycle_time: 'sec',
    cycle_cut_seconds: 'cut', cut_seconds: 'cut', in_cut_seconds: 'cut', time_in_cut: 'cut',
    recorded_at: 'at', at: 'at', date: 'at', timestamp: 'at',
  };
  const TOOL_NUMERIC = ['cuttingEdges', 'cost'];
  const JOB_NUMERIC = ['seq', 'indexEdges', 'partsPerIndex'];
  const MAX_IMPORT_BYTES = 5 * 1024 * 1024;

  const normHeader = h => String(h || '')
    .replace(/^﻿/, '')       // Excel writes a byte-order mark on the first cell
    .trim().toLowerCase()
    .replace(/[\s-]+/g, '_')
    .replace(/[^a-z0-9_]/g, '');

  const lower = v => String(v || '').trim().toLowerCase();
  const toolKeyOf = (partNumber, desc) => ((partNumber || '') + ' ' + (desc || '')).trim().toLowerCase();
  const opKeyOf = (partKey, name) => partKey + '\u0000' + lower(name);
  const jobKeyOf = (machineKey, toolKey, operationKey, station) =>
    [machineKey, toolKey, operationKey, lower(station)].join('\u0000');

  // A CSV reader that handles what a spreadsheet actually writes: quoted fields,
  // "" for a quote inside one, commas and newlines inside quotes, and CRLF.
  function parseCsv(text, sep) {
    const rows = [];
    let row = [], field = '', quoted = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (quoted) {
        if (c !== '"') { field += c; continue; }
        if (text[i + 1] === '"') { field += '"'; i++; continue; } // an escaped quote
        quoted = false;
      } else if (c === '"' && field === '') {
        quoted = true;
      } else if (c === sep) {
        row.push(field); field = '';
      } else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(field); field = '';
        rows.push(row); row = [];
      } else {
        field += c;
      }
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    return rows.filter(r => r.some(cell => cell.trim() !== '')); // drop blank lines
  }

  // Spreadsheets in some locales save with semicolons, and a pasted table with
  // tabs. Whichever separator the header line holds most of is the one in use;
  // a header with none of them is a single column, where the choice is moot.
  function sniffSeparator(text) {
    const line = text.split(/\r?\n/, 1)[0] || '';
    const best = [',', ';', '\t']
      .map(ch => [ch, line.split(ch).length - 1])
      .sort((a, b) => b[1] - a[1])[0];
    return best[1] > 0 ? best[0] : ',';
  }

  // "9,40" from a comma-decimal locale, and a currency symbol, both read
  const readNumber = v => {
    const n = Number(String(v).replace(/[^0-9.,-]/g, '').replace(',', '.'));
    return Number.isFinite(n) && n > 0 ? n : 0;
  };

  // Read a file into the parts, operations, machines, tools, setups and cycles
  // it describes, with a note of anything that could not be used. Nothing is
  // changed here — this only reads.
  function readImport(text) {
    const rows = parseCsv(text, sniffSeparator(text));
    if (!rows.length) return { error: 'That file has nothing in it.' };
    const header = rows[0].map(normHeader).map(h => COLUMN_ALIASES[h] || '');
    const names = ['machine', 'toolPartNumber', 'desc', 'part'];
    if (!header.some(f => names.includes(f))) {
      return { error: 'That file has no column naming a part, a machine or a tool. It needs at least one of ' +
        'part, machine, tool part number or tool description — the columns the ⤓ Export button writes.' };
    }
    const parts = new Map();
    const operations = new Map();
    const machines = new Map();
    const tools = new Map();
    const links = new Map();
    let dataRows = 0, skipped = 0, badTimes = 0, badSecs = 0, converted = 0, unconverted = 0;

    for (const raw of rows.slice(1)) {
      dataRows++;
      const cell = {};
      header.forEach((field, i) => { if (field) cell[field] = String(raw[i] == null ? '' : raw[i]).trim(); });

      // Each record has its own notes column, so none can swallow another's.
      const machineName = cell.machine || '';
      const machineKey = lower(machineName);
      const toolKey = toolKeyOf(cell.toolPartNumber, cell.desc);

      if (machineName) {
        if (!machines.has(machineKey)) machines.set(machineKey, { name: machineName, notes: '', cell: '' });
        if (cell.machineNotes) machines.get(machineKey).notes = cell.machineNotes;
        if (cell.cell) machines.get(machineKey).cell = cell.cell;
      }
      if (toolKey) {
        if (!tools.has(toolKey)) tools.set(toolKey, { key: toolKey, fields: {} });
        const tool = tools.get(toolKey);
        if (cell.toolPartNumber) tool.fields.partNumber = cell.toolPartNumber;
        if (cell.desc) tool.fields.desc = cell.desc;
        if (cell.toolNotes) tool.fields.notes = cell.toolNotes;
        for (const f of TOOL_NUMERIC) {
          if (!cell[f]) continue;
          const n = readNumber(cell[f]);
          if (n) tool.fields[f] = f === 'cost' ? n : Math.floor(n);
        }
      }

      // An op named without a part still belongs to something; they gather
      // under one clearly named part rather than each inventing one.
      const partNumber = cell.part || (cell.op ? 'Unassigned' : '');
      const partKey = lower(partNumber);
      let operationKey = '';
      if (partNumber) {
        if (!parts.has(partKey)) parts.set(partKey, { key: partKey, number: partNumber, desc: '', notes: '' });
        const part = parts.get(partKey);
        if (cell.partDesc) part.desc = cell.partDesc;
        if (cell.partNotes) part.notes = cell.partNotes;
        if (cell.op) {
          operationKey = opKeyOf(partKey, cell.op);
          if (!operations.has(operationKey)) {
            operations.set(operationKey, { key: operationKey, partKey, name: cell.op, notes: '' });
          }
          if (cell.opNotes) operations.get(operationKey).notes = cell.opNotes;
        }
      }

      if (!machineName && !toolKey && !partNumber) { skipped++; continue; }
      // A row naming only some of them makes those and nothing else: a part
      // waiting for its ops, a machine with no tools, a tool in the crib.
      if (!machineName || !toolKey) continue;

      const key = jobKeyOf(machineKey, toolKey, operationKey, cell.station);
      if (!links.has(key)) {
        links.set(key, { key, machineKey, toolKey, operationKey, fields: {}, runs: [], lifeMin: 0, layout: 0 });
      }
      const link = links.get(key);
      for (const f of ['station', 'notes']) {
        if (cell[f]) link.fields[f] = cell[f];
      }
      // The tool layout number in the file belongs to the machine-and-op pair
      // this row names, not to the setup — every row of one layout carries the
      // same number, and the last one to say anything is as good as the first.
      if (cell.layout) link.layout = Math.floor(readNumber(cell.layout)) || link.layout;
      for (const f of JOB_NUMERIC) {
        if (!cell[f]) continue;
        const n = readNumber(cell[f]);
        if (n) link.fields[f] = Math.floor(n);
      }
      if (cell.lifeMin) link.lifeMin = readNumber(cell.lifeMin) || link.lifeMin;

      if (cell.sec) {
        const sec = parseTime(cell.sec) || readNumber(cell.sec);
        if (sec > 0) {
          let at = cell.at ? Date.parse(cell.at) : NaN;
          if (!Number.isFinite(at)) { if (cell.at) badTimes++; at = Date.now(); }
          // Time in cut is optional, and part of the cycle it belongs to: a
          // figure longer than the cycle is a bad column, not a measurement.
          const rawCut = cell.cut ? (parseTime(cell.cut) || readNumber(cell.cut)) : 0;
          const cut = rawCut > 0 && rawCut <= sec ? round(rawCut, 2) : 0;
          link.runs.push({ sec: round(sec, 2), cut, at: Math.min(at, Date.now()) });
        } else badSecs++;
      }
    }

    // Version 1 files carry tool life as cutting minutes per edge. In parts,
    // that is the life divided by the time one part takes — the cycles in the
    // file itself, which is the same division version 1 did on screen. With no
    // cycles there is nothing to divide by, and the figure is left out rather
    // than guessed at.
    for (const link of links.values()) {
      if (link.fields.partsPerIndex || !link.lifeMin) continue;
      const base = link.runs.length
        ? link.runs.reduce((sum, r) => sum + r.sec, 0) / link.runs.length
        : 0;
      if (base > 0) {
        link.fields.partsPerIndex = Math.floor((link.lifeMin * 60) / base);
        converted++;
      } else {
        unconverted++;
      }
    }

    return {
      parts: [...parts.values()],
      operations: [...operations.values()],
      machines: [...machines.entries()].map(([key, m]) => ({ key, name: m.name, notes: m.notes, cell: m.cell })),
      tools: [...tools.values()],
      links: [...links.values()],
      layoutNumbers: [...links.values()].filter(l => l.layout).length,
      dataRows, skipped, badTimes, badSecs, converted, unconverted,
    };
  }

  // Work out exactly what an import would do, before it does any of it. The
  // preview and the import itself both read this, so what is shown is what runs.
  function planImport(read) {
    const plan = {
      parts: [], operations: [], machines: [], tools: [], cells: [], add: [], update: [],
      newRuns: 0, dupeRuns: 0,
      overflowParts: 0, overflowOperations: 0, overflowMachines: 0, overflowTools: 0,
      overflowJobs: 0, overflowRuns: 0,
    };
    const partByKey = new Map(shop.parts.map(p => [lower(p.number || p.desc), p]));
    const machineByKey = new Map(shop.machines.map(m => [lower(m.name), m]));
    const toolByKey = new Map(shop.tools.map(t => [toolKeyOf(t.partNumber, t.desc), t]));
    const opByKey = new Map(shop.operations.map(o => {
      const p = partById(o.partId);
      return [opKeyOf(lower(p && (p.number || p.desc)), o.name), o];
    }));
    const jobByKey = new Map(shop.assignments.map(a => {
      const tool = jobTool(a);
      const op = jobOperation(a);
      const part = jobPart(a);
      return [jobKeyOf(lower(machineName(a.machineId)),
        toolKeyOf(tool && tool.partNumber, tool && tool.desc),
        op ? opKeyOf(lower(part && (part.number || part.desc)), op.name) : '',
        a.station), a];
    }));
    let partRoom = Math.max(0, limits.maxParts - shop.parts.length);
    let opRoom = Math.max(0, limits.maxOperations - shop.operations.length);
    let machineRoom = Math.max(0, limits.maxMachines - shop.machines.length);
    let toolRoom = Math.max(0, limits.maxTools - shop.tools.length);
    let jobRoom = Math.max(0, limits.maxAssignments - shop.assignments.length);

    const newParts = new Set();
    for (const p of read.parts) {
      const fill = {};
      if (p.desc) fill.desc = p.desc;
      if (p.notes) fill.notes = p.notes;
      const match = partByKey.get(p.key);
      if (match) { plan.parts.push({ part: match, fields: fill, existing: true }); continue; }
      if (partRoom > 0) { partRoom--; plan.parts.push({ key: p.key, fields: { number: p.number, ...fill } }); newParts.add(p.key); }
      else plan.overflowParts++;
    }
    const newOps = new Set();
    for (const o of read.operations) {
      if (opByKey.has(o.key)) continue;
      // an operation whose part could not be made has nothing to belong to
      if (!partByKey.has(o.partKey) && !newParts.has(o.partKey)) { plan.overflowOperations++; continue; }
      if (opRoom > 0) { opRoom--; plan.operations.push(o); newOps.add(o.key); }
      else plan.overflowOperations++;
    }
    const newMachines = new Set();
    for (const m of read.machines) {
      if (machineByKey.has(m.key)) {
        // an existing machine still learns which cell it is in
        if (m.cell) plan.cells.push({ machine: machineByKey.get(m.key), name: m.cell });
        continue;
      }
      if (machineRoom > 0) { machineRoom--; plan.machines.push(m); newMachines.add(m.key); }
      else plan.overflowMachines++;
    }
    const newTools = new Set();
    for (const t of read.tools) {
      if (toolByKey.has(t.key)) {
        plan.tools.push({ tool: toolByKey.get(t.key), fields: t.fields, existing: true });
        continue;
      }
      if (toolRoom > 0) { toolRoom--; plan.tools.push({ fields: t.fields, key: t.key }); newTools.add(t.key); }
      else plan.overflowTools++;
    }

    for (const link of read.links) {
      // a link whose machine or tool could not be made has nothing to join
      const machineIn = machineByKey.has(link.machineKey) || newMachines.has(link.machineKey);
      const toolIn = toolByKey.has(link.toolKey) || newTools.has(link.toolKey);
      if (!machineIn || !toolIn) { plan.overflowJobs++; continue; }
      // an op that did not fit leaves the tool on the machine with none set
      const opIn = !link.operationKey || opByKey.has(link.operationKey) || newOps.has(link.operationKey);

      const match = jobByKey.get(link.key);
      // A cycle is the same cycle if it was recorded at the same moment and ran
      // the same length, so the same file imported twice adds nothing the second
      // time. Rows repeated inside one file collapse the same way.
      const seen = new Set((match ? match.runs : []).map(r => r.at + ':' + r.sec));
      const fresh = [];
      for (const r of link.runs) {
        const key = r.at + ':' + r.sec;
        if (seen.has(key)) { plan.dupeRuns++; continue; }
        seen.add(key);
        fresh.push(r);
      }
      const kept = (match ? match.runs.length : 0) + fresh.length;
      if (kept > limits.maxRuns) plan.overflowRuns += kept - limits.maxRuns;
      if (match) {
        plan.newRuns += fresh.length;
        plan.update.push({ job: match, fields: link.fields, runs: fresh, layout: link.layout });
      } else if (jobRoom > 0) {
        jobRoom--;
        plan.newRuns += fresh.length;
        plan.add.push({ link, runs: fresh, withOp: opIn });
      } else {
        plan.overflowJobs++;
      }
    }
    return plan;
  }

  function applyImport(plan) {
    const now = Date.now();
    const partByKey = new Map(shop.parts.map(p => [lower(p.number || p.desc), p]));
    const machineByKey = new Map(shop.machines.map(m => [lower(m.name), m]));
    const toolByKey = new Map(shop.tools.map(t => [toolKeyOf(t.partNumber, t.desc), t]));
    const opByKey = new Map(shop.operations.map(o => {
      const p = partById(o.partId);
      return [opKeyOf(lower(p && (p.number || p.desc)), o.name), o];
    }));

    for (const p of plan.parts) {
      if (p.existing) {
        Object.assign(p.part, p.fields); // a blank cell leaves what is already there
        touch(p.part);
        continue;
      }
      const part = {
        id: newId('p'), number: '', desc: '', notes: '', ...p.fields,
        createdAt: now, updatedAt: now,
      };
      shop.parts.push(part);
      partByKey.set(p.key, part);
    }
    for (const o of plan.operations) {
      const part = partByKey.get(o.partKey);
      if (!part) continue;
      const operation = {
        id: newId('o'), partId: part.id, name: o.name,
        seq: opsOfPart(part.id).reduce((max, x) => Math.max(max, x.seq || 0), 0) + 1,
        notes: o.notes || '', createdAt: now, updatedAt: now,
      };
      shop.operations.push(operation);
      opByKey.set(o.key, operation);
    }
    if (!Array.isArray(shop.cells)) shop.cells = [];
    // A cell named in the file is matched by name and made if it is not there.
    const cellByName = new Map(shop.cells.map(c => [lower(c.name), c]));
    const cellFor = name => {
      const key = lower(name);
      if (!key) return '';
      if (cellByName.has(key)) return cellByName.get(key).id;
      if (shop.cells.length >= (limits.maxCells || 40)) return '';
      const made = {
        id: newId('c'), name: String(name).trim().slice(0, 60),
        seq: shop.cells.reduce((max, c) => Math.max(max, c.seq || 0), 0) + 1,
        notes: '', createdAt: now, updatedAt: now,
      };
      shop.cells.push(made);
      cellByName.set(key, made);
      return made.id;
    };
    for (const m of plan.machines) {
      const machine = {
        id: newId('m'), name: m.name, notes: m.notes || '',
        cellId: cellFor(m.cell), cellSeq: 0, createdAt: now, updatedAt: now,
      };
      if (machine.cellId) {
        machine.cellSeq = machinesOfCell(machine.cellId)
          .reduce((max, x) => Math.max(max, x.cellSeq || 0), 0) + 1;
      }
      shop.machines.push(machine);
      machineByKey.set(m.key, machine);
    }
    // machines already on the floor that the file puts in a cell
    for (const c of plan.cells) {
      const cellId = cellFor(c.name);
      if (!cellId || c.machine.cellId === cellId) continue;
      c.machine.cellId = cellId;
      if (!c.machine.cellSeq) {
        c.machine.cellSeq = machinesOfCell(cellId)
          .reduce((max, x) => Math.max(max, x.cellSeq || 0), 0) + 1;
      }
      touch(c.machine);
    }
    for (const t of plan.tools) {
      if (t.existing) {
        Object.assign(t.tool, t.fields);
        touch(t.tool);
        continue;
      }
      const tool = {
        id: newId('t'), partNumber: '', desc: '', cuttingEdges: 0, cost: 0, notes: '',
        ...t.fields, createdAt: now, updatedAt: now,
      };
      shop.tools.push(tool);
      toolByKey.set(t.key, tool);
    }

    const touched = new Set();
    const numbered = [];   // [the layout's key, the number the file gave it]
    for (const u of plan.update) {
      Object.assign(u.job, u.fields);
      u.job.runs = [...u.runs, ...u.job.runs].sort((a, b) => b.at - a.at).slice(0, limits.maxRuns);
      touch(u.job);
      touched.add(layoutKey(u.job));
      if (u.layout && u.job.operationId) numbered.push([layoutKey(u.job), u.layout]);
    }
    for (const a of plan.add) {
      const machine = machineByKey.get(a.link.machineKey);
      const tool = toolByKey.get(a.link.toolKey);
      if (!machine || !tool) continue;
      const operation = a.link.operationKey ? opByKey.get(a.link.operationKey) : null;
      const job = {
        id: newId('a'), toolId: tool.id, machineId: machine.id,
        operationId: operation ? operation.id : '',
        station: '', seq: 0, indexEdges: 0, partsPerIndex: 0, notes: '',
        ...a.link.fields,
        runs: a.runs.sort((x, y) => y.at - x.at).slice(0, limits.maxRuns),
        createdAt: now, updatedAt: now,
      };
      // a tool set up without saying how many edges are indexed there uses
      // every edge the tool has
      if (!job.indexEdges && tool.cuttingEdges) job.indexEdges = tool.cuttingEdges;
      shop.assignments.push(job);
      touched.add(layoutKey(job));
      if (a.link.layout && job.operationId) numbered.push([layoutKey(job), a.link.layout]);
    }
    for (const key of touched) renumberLayout(key);
    for (const p of shop.parts) renumberPart(p.id);
    // The layouts the new setups have brought into being, numbered next-free…
    ensureLayouts();
    // …and then given back the numbers the file carried, where those are free.
    // A number another layout already answers to is left alone: the file's word
    // is not worth taking two layouts' names away over, and the preview says so.
    for (const [key, number] of numbered) {
      const layout = layoutByKey(key);
      if (!layout || layout.number === number) continue;
      if (layoutList().some(l => l.number === number)) continue;
      layout.number = number;
      touch(layout);
    }
    if (!jobById(shop.activeId) && shop.assignments.length) shop.activeId = shop.assignments[0].id;
    saveNow(); // a bulk import goes out at once rather than sitting in the debounce
    render();
  }

  function renderImport() {
    const box = els.import;
    box.innerHTML = '';
    box.hidden = !pendingImport;
    if (!pendingImport) return;
    const { read, plan, name } = pendingImport;

    box.appendChild(el('div', 'mf-section-title', 'Import ' + name));
    const newParts = plan.parts.filter(p => !p.existing).length;
    const newTools = plan.tools.filter(t => !t.existing).length;
    const lines = [];
    const count = (n, one, many) => { if (n) lines.push(n + ' new ' + (n === 1 ? one : many)); };
    count(newParts, 'part', 'parts');
    count(plan.operations.length, 'operation', 'operations');
    count(plan.machines.length, 'machine', 'machines');
    count(newTools, 'tool', 'tools');
    count(plan.add.length, 'setup', 'setups');
    if (plan.update.length) lines.push(plan.update.length + ' already set up');
    lines.push(plan.newRuns + (plan.newRuns === 1 ? ' new cycle' : ' new cycles'));
    box.appendChild(el('div', 'mf-import-sum', lines.join(' · ')));

    const notes = [];
    if (plan.update.length || plan.tools.some(t => t.existing) || plan.parts.some(p => p.existing)) {
      notes.push('Records already on the board keep every field this file leaves blank, and keep every cycle they already have.');
    }
    if (read.converted) notes.push(read.converted + ' tool life' + (read.converted === 1 ? '' : 's') +
      ' given in cutting minutes per edge ' + (read.converted === 1 ? 'was' : 'were') +
      ' turned into parts between indexes, at the cycle time in the file.');
    if (read.unconverted) notes.push(read.unconverted + ' tool life' + (read.unconverted === 1 ? '' : 's') +
      ' in minutes had no cycle to convert against, and ' +
      (read.unconverted === 1 ? 'was' : 'were') + ' left out.');
    const cells = read.machines.filter(m => m.cell).length;
    if (cells) notes.push('Machines are put in the cells the file names; a cell that is not there yet is made.');
    if (read.layoutNumbers) notes.push('Tool layout numbers in the file are kept where they are free; ' +
      'one that another layout already answers to is left alone.');
    if (plan.dupeRuns) notes.push(plan.dupeRuns + ' cycle' + (plan.dupeRuns === 1 ? ' is' : 's are') +
      ' already recorded and will be left alone.');
    if (read.skipped) notes.push(read.skipped + ' row' + (read.skipped === 1 ? '' : 's') +
      ' named no part, machine or tool and will be skipped.');
    if (read.badSecs) notes.push(read.badSecs + ' cycle time' + (read.badSecs === 1 ? '' : 's') +
      ' could not be read as a number.');
    if (read.badTimes) notes.push(read.badTimes + ' date' + (read.badTimes === 1 ? '' : 's') +
      ' could not be read; those cycles will be stamped now.');
    const overflow = [
      [plan.overflowParts, 'part', 'parts', limits.maxParts],
      [plan.overflowOperations, 'operation', 'operations', limits.maxOperations],
      [plan.overflowMachines, 'machine', 'machines', limits.maxMachines],
      [plan.overflowTools, 'tool', 'tools', limits.maxTools],
      [plan.overflowJobs, 'setup', 'setups', limits.maxAssignments],
    ];
    for (const [n, one, many, cap] of overflow) {
      if (n) notes.push(n + ' ' + (n === 1 ? one : many) + ' will not fit — this account holds ' + cap + '.');
    }
    if (plan.overflowRuns) notes.push('The oldest cycles on some setups will roll off at ' + limits.maxRuns + ' each.');
    notes.push('Nothing is deleted by an import.');
    for (const n of notes) box.appendChild(el('div', 'mf-note', n));

    const btns = el('div', 'mf-form-btns');
    const nothing = !plan.parts.length && !plan.operations.length && !plan.machines.length &&
      !plan.tools.length && !plan.add.length && !plan.update.length;
    btns.appendChild(button('mf-btn mf-btn-go', 'Import', () => {
      const job = pendingImport;
      pendingImport = null;
      applyImport(job.plan);
      flash('Imported ' + job.name + ' — ' + job.plan.add.length + ' setups and ' +
        job.plan.newRuns + ' cycles added.', true);
    }, nothing ? 'There is nothing in this file to add' : ''));
    btns.appendChild(button('mf-btn mf-btn-quiet', 'Cancel', () => { pendingImport = null; renderImport(); }));
    if (nothing) btns.firstChild.disabled = true;
    box.appendChild(btns);
    box.scrollIntoView({ block: 'nearest' });
  }

  async function chooseImport(file) {
    if (!file || !docsIn || !signedIn()) return;
    if (file.size > MAX_IMPORT_BYTES) { flash('That file is larger than this will read (5 MB).'); return; }
    let text;
    try { text = await file.text(); }
    catch (err) { flash('That file could not be read. ' + err.message); return; }
    const read = readImport(text);
    if (read.error) { flash(read.error); return; }
    if (!read.machines.length && !read.tools.length && !read.parts.length) {
      flash('No parts, machines or tools could be read out of that file.');
      return;
    }
    // A file read with nothing open makes the shopwatch to read it into, named
    // after the file. The plan below is against that record, so it is made
    // first — but only once the file has proved to have something in it.
    if (!doc) {
      const named = (file.name || '').replace(/\.[A-Za-z0-9]+$/, '').replace(/[_-]+/g, ' ').trim();
      if (!await createDoc(named || 'Shop floor')) return;
      flash('Started ' + doc.title + ' to read that file into.', true);
    }
    if (!shop) return;
    pendingImport = { read, plan: planImport(read), name: file.name || 'the file' };
    renderImport();
  }

  /* ---------------- export ---------------- */
  // One row per recorded cycle, carrying the tool layout it was measured on and
  // the part, the operation, the machine, the tool and the setup that make up
  // that layout, so the file can be pivoted in a spreadsheet without going back
  // to the app. A setup with nothing timed still gets its row, and so do a part
  // with no operations, an operation with no tools, a tool in the crib and a
  // machine with nothing on it.
  function exportCsv() {
    if (!shop || (!shop.tools.length && !shop.machines.length && !shop.parts.length)) {
      flash('Nothing to export yet.');
      return;
    }
    const cell = v => {
      const s = String(v == null ? '' : v);
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    // Rows are written from a named object rather than a bare list, so a column
    // added in the middle cannot silently shift what is under the ones after it.
    const columns = [...IMPORT_COLUMNS, ...DERIVED_COLUMNS];
    const rows = [columns];
    const push = obj => rows.push(columns.map(k => (obj[k] == null ? '' : obj[k])));

    const machineCells = id => {
      const m = machineById(id);
      if (!m) return {};
      const c = m.cellId ? cellById(m.cellId) : null;
      return { cell: c ? c.name : '', machine: m.name, machine_notes: m.notes };
    };
    const partCells = p => (p ? { part: p.number, part_description: p.desc, part_notes: p.notes } : {});
    const opCells = o => (o ? { ...partCells(partById(o.partId)), op: o.name, op_notes: o.notes } : {});
    const toolCells = t => (t ? {
      tool_part_number: t.partNumber, tool_description: t.desc,
      cutting_edges: t.cuttingEdges || '', tool_cost: t.cost || '', tool_notes: t.notes,
    } : {});

    // in tool layout order, and within a layout in the order the tools cut, so
    // the file opens the way the floor runs
    const jobs = [...shop.assignments].sort((a, b) => {
      const la = layoutOf(a), lb = layoutOf(b);
      if (la && lb && la !== lb) return byNumber(la, lb);
      if (!la !== !lb) return la ? -1 : 1;   // the ones on no layout go last
      return opLabel(a).localeCompare(opLabel(b)) || bySeq(a, b);
    });
    for (const a of jobs) {
      const s = statsFor(a);
      const life = lifeFor(a, s ? s.avg : 0, s ? s.avgCut : 0);
      const layout = layoutOf(a);
      const base = {
        tool_layout: layout ? layout.number : '',
        ...machineCells(a.machineId),
        ...opCells(jobOperation(a)),
        ...toolCells(jobTool(a)),
        seq: a.seq || '', station: a.station,
        indexable_edges: a.indexEdges || '',
        parts_per_index: a.partsPerIndex || '', notes: a.notes,
        cycles_timed: s ? s.count : 0,
        average_seconds: s ? round(s.avg, 2) : '',
        parts_per_tool: life ? life.partsPerTool || '' : '',
      };
      if (!a.runs.length) { push(base); continue; }
      for (const r of a.runs) {
        push({ ...base,
          cycle_seconds: round(r.sec, 2),
          cycle_cut_seconds: r.cut ? round(r.cut, 2) : '',
          recorded_at: new Date(r.at).toISOString() });
      }
    }
    // the whole floor, not only the timed part of it: an operation nothing is
    // set up for, a part with no operations, a tool in the crib, an idle machine
    for (const o of shop.operations) {
      if (!jobsOfOperation(o.id).length) push({ ...opCells(o), cycles_timed: 0 });
    }
    for (const p of shop.parts) {
      if (!opsOfPart(p.id).length) push({ ...partCells(p), cycles_timed: 0 });
    }
    for (const t of shop.tools) {
      if (!jobsOfTool(t.id).length) push({ ...toolCells(t), cycles_timed: 0 });
    }
    for (const m of shop.machines) {
      if (!jobsOnMachine(m.id).length) push({ ...machineCells(m.id), cycles_timed: 0 });
    }

    const csv = rows.map(r => r.map(cell).join(',')).join('\r\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'shopwatch-' + new Date().toISOString().slice(0, 10) + '.csv';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }


  /* ---------------- the tool layout, on paper ----------------
     A shop runs off a tool layout sheet: one page, one layout, every pocket on
     it and what goes in each. This is that sheet, made out of what the
     shopwatch already knows — so it carries the measured cycle and the time in
     cut alongside the tooling, which a typed-up sheet never does.

     One page per tool layout, laid out the way the screen lays one out: the
     number and the address at the top, the layout's cycle divided between its
     tools in the order they cut, the same tools as columns of cut and waste,
     and then the table — pocket by pocket, with the tool in it, what it is
     timed at, and the tool life worked out for it there. The pockets are the
     spine of that table, ready for the holder and the insert to hang off each
     one as those become records of their own.

     It is a print document rather than a file this add-on writes byte by byte:
     the browser's own "Save as PDF" makes a better PDF than anything that could
     be hand-rolled here, it needs no library, and the same page prints straight
     onto paper for the machine. The colours are the app's, so what comes out
     reads as the screen it came from; print-color-adjust keeps them, since a
     chart whose fills the printer has helpfully removed says nothing.
  ---------------------------------------------------------------- */
  const escHtml = s => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  const PDF_STYLE = `
    :root {
      --bg: #10141D; --panel: #141926; --line: #232938; --ink: #EDEFF4;
      --dim: #8A93A6; --accent: #4FD1E0; --cut: #E8734A; --waste: #6E3F2E;
      --unmarked: #565E72;
      --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
    }
    * { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    /* The padding is for the window this opens in, where there is no page
       margin to stand the sheet off the edge of the glass. Printing has one, so
       it is given back there rather than counted twice. */
    body {
      margin: 0; padding: 10px 14px; background: var(--bg); color: var(--ink);
      font: 11px/1.45 -apple-system, "Segoe UI", Roboto, sans-serif;
    }
    @page { size: A4 portrait; margin: 10mm; }
    @media print { body { padding: 0; } }
    /* One layout, one page. The last one does not push a blank sheet out. */
    .tl { padding: 4mm 0 0; page-break-after: always; break-after: page; }
    .tl:last-child { page-break-after: auto; break-after: auto; }

    .head { display: flex; align-items: flex-start; gap: 12px; border-bottom: 2px solid var(--accent); padding-bottom: 8px; }
    .no {
      font-family: var(--mono); font-size: 26px; font-weight: 700; line-height: 1;
      color: var(--accent); border: 2px solid var(--accent); border-radius: 8px;
      padding: 6px 10px; white-space: nowrap;
    }
    .who { flex: 1; min-width: 0; }
    /* What the page is, said once, the way a controlled document says it */
    .doctype {
      font-size: 8.5px; letter-spacing: 0.14em; text-transform: uppercase;
      color: var(--dim); font-weight: 600; margin-bottom: 2px;
    }
    .machine { font-size: 17px; font-weight: 700; }
    .op { font-family: var(--mono); font-size: 12px; color: var(--dim); margin-top: 2px; }
    .figure { text-align: right; white-space: nowrap; }
    .total { font-family: var(--mono); font-size: 24px; font-weight: 700; line-height: 1.05; }
    .sub { font-size: 10px; color: var(--dim); }

    .panel { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 9px 11px; margin-top: 8px; page-break-inside: avoid; }
    .panel-head { display: flex; align-items: baseline; gap: 10px; margin-bottom: 7px; }
    .k { font-size: 9.5px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--dim); font-weight: 600; }
    .v { margin-left: auto; font-family: var(--mono); font-size: 11px; color: var(--dim); }

    .bar { display: flex; gap: 2px; height: 20px; }
    .seg { display: flex; align-items: center; justify-content: center; min-width: 3px; font-family: var(--mono); font-size: 9px; font-weight: 700; }
    .seg:last-child { border-radius: 0 3px 3px 0; }

    .legend { margin-top: 8px; }
    .lrow { display: flex; align-items: center; gap: 7px; padding: 2px 0; font-size: 10.5px; }
    .lrow.off { color: var(--dim); }
    .sw { width: 9px; height: 9px; border-radius: 2px; border: 1px solid var(--line); flex: none; }
    .n { font-family: var(--mono); font-size: 9.5px; color: var(--dim); width: 12px; flex: none; }
    .nm { flex: 1; min-width: 0; }
    .val { font-family: var(--mono); font-variant-numeric: tabular-nums; }
    .pct { color: var(--dim); width: 62px; text-align: right; flex: none; font-size: 10px; }
    .chip {
      font-family: var(--mono); font-size: 9px; font-weight: 700; letter-spacing: 0.04em;
      background: var(--line); color: var(--accent); border-radius: 4px; padding: 1px 5px; flex: none;
    }

    .plot { display: flex; align-items: flex-end; justify-content: flex-start; gap: 8px; height: 70px; border-bottom: 1px solid var(--line); }
    .slot { flex: 1 1 0; max-width: 54px; height: 100%; display: flex; align-items: flex-end; justify-content: center; }
    .col { width: 100%; max-width: 20px; display: flex; flex-direction: column; justify-content: flex-end; }
    .waste { background: var(--waste); border-radius: 3px 3px 0 0; min-height: 1px; }
    .cut { background: var(--cut); min-height: 1px; }
    .cut.top { border-radius: 3px 3px 0 0; }
    .unmarked { flex: 1; border: 1px solid var(--unmarked); border-bottom: none; border-radius: 3px 3px 0 0; }
    .axis { display: flex; justify-content: flex-start; gap: 8px; margin-top: 4px; }
    .aslot { flex: 1 1 0; max-width: 54px; text-align: center; font-family: var(--mono); font-size: 9px; color: var(--dim); }
    .aslot b { display: block; color: var(--ink); font-size: 9px; }
    .key { display: flex; gap: 12px; margin-top: 8px; font-size: 9.5px; color: var(--dim); }
    .key span { display: flex; align-items: center; gap: 5px; }
    .key i { width: 9px; height: 9px; border-radius: 2px; }

    table { width: 100%; border-collapse: collapse; font-size: 10px; }
    th {
      text-align: left; font-size: 8.5px; letter-spacing: 0.06em; text-transform: uppercase;
      color: var(--dim); font-weight: 600; padding: 0 5px 4px 0; border-bottom: 1px solid var(--line);
    }
    td { padding: 4px 5px 4px 0; border-bottom: 1px solid var(--line); vertical-align: top; }
    tr:last-child td { border-bottom: none; }
    td.num { font-family: var(--mono); font-variant-numeric: tabular-nums; white-space: nowrap; }
    td.pocket { font-family: var(--mono); font-weight: 700; color: var(--accent); white-space: nowrap; }
    td.tool { font-weight: 600; }
    .rownote td { border-bottom: 1px solid var(--line); color: var(--dim); font-size: 9.5px; padding-top: 0; }
    .empty { color: var(--dim); font-size: 10.5px; }

    /* the value stream page: the route across its cells, then the boxes */
    .no.vsm { font-size: 20px; letter-spacing: 0.06em; }
    .vband { border-left: 2px solid var(--accent); padding-left: 8px; margin-bottom: 8px; }
    .vband:last-child { margin-bottom: 0; }
    .vband-k {
      font-size: 8.5px; letter-spacing: 0.1em; text-transform: uppercase;
      color: var(--accent); font-weight: 600; margin-bottom: 4px;
    }
    .vlane { display: flex; align-items: stretch; flex-wrap: wrap; gap: 6px; }
    .vstep { display: flex; align-items: center; gap: 6px; }
    .varrow { color: var(--dim); font-size: 12px; }
    .vboxes { display: flex; flex-direction: column; gap: 4px; }
    .vbox { background: var(--bg); border: 1px solid var(--line); border-radius: 6px; padding: 5px 7px; min-width: 116px; }
    .vbox.best { border-color: var(--accent); }
    .vtop { display: flex; align-items: center; gap: 5px; }
    .vn { font-family: var(--mono); font-size: 9px; font-weight: 700; color: var(--dim); }
    .vop { font-family: var(--mono); font-size: 10.5px; font-weight: 700; letter-spacing: 0.03em; }
    .vtl {
      font-family: var(--mono); font-size: 8.5px; font-weight: 700; color: var(--accent);
      border: 1px solid var(--accent); border-radius: 4px; padding: 0 4px;
    }
    .vmachine { font-size: 10px; margin-top: 2px; }
    .vtime { font-family: var(--mono); font-size: 14px; font-weight: 700; font-variant-numeric: tabular-nums; }
    .vmeta { font-size: 8.5px; color: var(--dim); }

    .notes { margin-top: 8px; page-break-inside: avoid; }
    .note { font-size: 10px; color: var(--dim); margin-top: 4px; }
    .note b { color: var(--ink); font-weight: 600; }
    /* The mark, what the sheet is a sheet of, and when it was taken off the
       record — a page that ends up on a machine has to be traceable back. */
    .foot {
      display: flex; align-items: center; gap: 10px; margin-top: 10px;
      padding-top: 6px; border-top: 1px solid var(--line);
      font-size: 9px; color: var(--dim);
    }
    .foot .brand { display: flex; align-items: center; gap: 5px; flex: none; color: var(--accent); }
    .foot .brand svg { display: block; width: 14px; height: 14px; }
    .foot .name { font-size: 10px; font-weight: 700; letter-spacing: 0.02em; color: var(--ink); }
    .foot .name i { font-style: normal; color: var(--accent); }
    .foot .ref { min-width: 0; }
    .foot .issued { margin-left: auto; white-space: nowrap; }
  `;

  // One page: everything the shopwatch holds about one tool layout.
  function layoutPage(l, when) {
    const jobs = layoutJobsOf(l);
    const op = operationById(l.operationId);
    const part = op ? partById(op.partId) : null;
    const machine = machineById(l.machineId);
    const cell = cellOfMachine(l.machineId);
    const rows = jobs.map((a, i) => {
      const s = statsFor(a);
      return {
        a,
        step: rampStep(i, jobs.length),
        avg: s ? s.avg : 0,
        count: s ? s.count : 0,
        // the cut, and the cycle it is a share of — the marked ones, where any
        // were marked, exactly as the screen does it
        cut: s ? s.avgCut : 0,
        cycle: s ? (s.avgCutCycle || s.avg) : 0,
        marked: s ? s.cutCount : 0,
        life: lifeFor(a, s ? s.avg : 0, s ? s.avgCut : 0),
      };
    });
    const timed = rows.filter(r => r.avg > 0);
    const total = timed.reduce((sum, r) => sum + r.avg, 0);
    const drawn = rows.filter(r => r.cycle > 0);
    const withCut = drawn.filter(r => r.cut > 0);
    const cutTotal = withCut.reduce((sum, r) => sum + r.cut, 0);
    const cycleTotal = withCut.reduce((sum, r) => sum + r.cycle, 0);
    const share = cycleTotal ? cutTotal / cycleTotal : 0;
    const longest = drawn.length ? Math.max(...drawn.map(r => r.cycle)) : 0;

    const head =
      '<div class="head">' +
        '<div class="no">' + escHtml(tlName(l)) + '</div>' +
        '<div class="who">' +
          '<div class="doctype">Tool layout sheet' +
            (cell ? ' · ' + escHtml(cell.name) : '') + '</div>' +
          '<div class="machine">' + escHtml(machine ? machine.name : 'No machine') + '</div>' +
          '<div class="op">' + escHtml(operationLabel(op)) +
            (part && part.desc && part.number ? ' — ' + escHtml(part.desc) : '') + '</div>' +
        '</div>' +
        '<div class="figure">' +
          '<div class="total">' + (total ? fmtSec(total) : '—') + '</div>' +
          '<div class="sub">' + (timed.length
            ? 'measured across ' + timed.length + (timed.length === 1 ? ' tool' : ' tools')
            : 'no cycles recorded') + '</div>' +
        '</div>' +
      '</div>';

    // The cycle divided between the tools in the order they cut, on the same
    // ramp the screen uses — one hue stepped light to dark along the order.
    const bar = timed.length > 1
      ? '<div class="bar">' + timed.map(r =>
        '<div class="seg" style="flex-grow:' + (r.avg / total).toFixed(4) +
        ';background:' + r.step.fill + ';color:' + r.step.ink + '">' +
        (r.avg / total >= 0.07 && r.a.seq ? escHtml(r.a.seq) : '') + '</div>').join('') + '</div>'
      : '';
    const legend = '<div class="legend">' + rows.map(r =>
      '<div class="lrow' + (r.avg ? '' : ' off') + '">' +
        '<span class="sw"' + (r.avg ? ' style="background:' + r.step.fill + '"' : '') + '></span>' +
        '<span class="n">' + escHtml(r.a.seq || '–') + '</span>' +
        (r.a.station ? '<span class="chip">' + escHtml(r.a.station) + '</span>' : '') +
        '<span class="nm">' + escHtml(jobName(r.a)) + '</span>' +
        '<span class="val">' + (r.avg ? fmtSec(r.avg) : '—') + '</span>' +
        '<span class="pct">' + (r.avg ? Math.round((r.avg / total) * 100) + '%' : 'not timed') + '</span>' +
      '</div>').join('') + '</div>';

    const cycle =
      '<div class="panel">' +
        '<div class="panel-head"><span class="k">Cycle by tool</span>' +
          '<span class="v">' + (total ? fmtSec(total) + ' measured' : 'no cycles recorded') + '</span></div>' +
        (timed.length ? bar + legend
          : '<div class="empty">No cycles recorded.</div>') +
      '</div>';

    // A column is a tool's measured cycle; what is filled in is the part of it
    // marked in the cut, so the air above the fill is the waste.
    const plot = drawn.length
      ? '<div class="plot">' + drawn.map(r => {
        const inner = r.cut > 0
          ? ((r.cycle - r.cut > 0
            ? '<div class="waste" style="height:' + (((r.cycle - r.cut) / r.cycle) * 100).toFixed(2) + '%"></div>'
            : '') +
            '<div class="cut' + (r.cycle - r.cut > 0 ? '' : ' top') + '" style="height:' +
            ((r.cut / r.cycle) * 100).toFixed(2) + '%"></div>')
          : '<div class="unmarked"></div>';
        return '<div class="slot"><div class="col" style="height:' +
          ((r.cycle / longest) * 100).toFixed(2) + '%">' + inner + '</div></div>';
      }).join('') + '</div>' +
      '<div class="axis">' + drawn.map(r =>
        '<div class="aslot">' + escHtml(r.a.seq || '–') +
        (r.cut ? '<b>' + Math.round((r.cut / r.cycle) * 100) + '%</b>' : '') + '</div>').join('') + '</div>' +
      '<div class="key">' +
        '<span><i style="background:var(--cut)"></i>in cut</span>' +
        '<span><i style="background:var(--waste)"></i>not cutting</span>' +
        (drawn.some(r => !r.cut) ? '<span><i style="border:1px solid var(--unmarked)"></i>not measured</span>' : '') +
      '</div>'
      : '<div class="empty">No cutting time recorded.</div>';

    const cut =
      '<div class="panel">' +
        '<div class="panel-head"><span class="k">Cutting time and waste</span>' +
          '<span class="v">' + (share
            ? Math.round(share * 100) + '% of the measured cycle in cut'
            : 'no cutting time recorded') + '</span></div>' +
        plot +
      '</div>';

    // The sheet itself: a row per pocket, in the order the tools cut.
    const columns = ['#', 'Pocket', 'Tool', 'Tool part no.', 'Cycles', 'Avg', 'In cut',
      'Edges', 'Parts / index', 'Parts / tool', 'Min / edge'];
    const body = rows.map(r => {
      const tool = jobTool(r.a);
      const cells = [
        ['num', escHtml(r.a.seq || '–')],
        ['pocket', escHtml(r.a.station || '—')],
        ['tool', escHtml(jobName(r.a))],
        ['num', escHtml((tool && tool.partNumber) || '—')],
        ['num', escHtml(r.count || '—')],
        ['num', r.avg ? fmtSec(r.avg) : '—'],
        ['num', r.cut ? fmtSec(r.cut) + ' · ' + Math.round((r.cut / r.cycle) * 100) + '%' : '—'],
        ['num', escHtml(r.a.indexEdges || (tool && tool.cuttingEdges) || '—')],
        ['num', escHtml(r.a.partsPerIndex || '—')],
        ['num', escHtml((r.life && r.life.partsPerTool) || '—')],
        ['num', r.life && r.life.edgeMin ? escHtml(round(r.life.edgeMin, 1)) : '—'],
      ];
      const line = '<tr>' + cells.map(([cls, v]) => '<td class="' + cls + '">' + v + '</td>').join('') + '</tr>';
      // What the last person to set this tool learned about it, under its row —
      // which is the half of a layout sheet that is usually written in pen.
      return line + (r.a.notes
        ? '<tr class="rownote"><td></td><td colspan="' + (columns.length - 1) + '">' +
          escHtml(r.a.notes) + '</td></tr>'
        : '');
    }).join('');
    const table =
      '<div class="panel">' +
        '<div class="panel-head"><span class="k">Tooling, in cutting order</span>' +
          '<span class="v">' + jobs.length + (jobs.length === 1 ? ' pocket' : ' pockets') + '</span></div>' +
        (jobs.length
          ? '<table><thead><tr>' + columns.map(h => '<th>' + escHtml(h) + '</th>').join('') +
            '</tr></thead><tbody>' + body + '</tbody></table>'
          : '<div class="empty">No tools set up.</div>') +
      '</div>';

    const notes = [
      ['Tool layout', l.notes],
      [op ? op.name : 'Operation', op && op.notes],
      [part ? partName(part) : 'Part', part && part.notes],
      [machine ? machine.name : 'Machine', machine && machine.notes],
      [cell ? cell.name : 'Cell', cell && cell.notes],
    ].filter(([, text]) => text);
    const notesBlock = notes.length
      ? '<div class="notes panel">' +
        '<div class="panel-head"><span class="k">Notes</span></div>' +
        notes.map(([who, text]) =>
          '<div class="note"><b>' + escHtml(who) + '</b> — ' + escHtml(text) + '</div>').join('') +
        '</div>'
      : '';

    // The mark, then what this sheet is a sheet of and when it was taken —
    // which is what makes a printed page traceable back to the record it came
    // out of once it is on a machine and out of date.
    const foot = '<div class="foot">' +
      '<span class="brand">' + LOGO + '<span class="name">Shop<i>watch</i></span></span>' +
      '<span class="ref">' + escHtml(doc ? doc.title : '') + ' · ' + escHtml(tlName(l)) +
      ' · ' + escHtml(layoutWhere(l)) + '</span>' +
      '<span class="issued">Issued ' + escHtml(when) + '</span></div>';

    return '<section class="tl">' + head + cycle + cut + table + notesBlock + foot + '</section>';
  }


  /* One part's value stream, on a page: the same map the screen draws, in the
     same order, with the steps as boxes across the cells they run in and the
     process time under them. It prints through the same document as the tool
     layout sheets, so a job can go to the floor as one file — the stream first,
     then a sheet per layout on it. */
  function streamPage(part, when) {
    const steps = streamSteps(part);
    const measured = steps.filter(st => st.cycle > 0);
    const total = measured.reduce((sum, st) => sum + st.cycle, 0);

    const head =
      '<div class="head">' +
        '<div class="no vsm">VS</div>' +
        '<div class="who">' +
          '<div class="doctype">Value stream</div>' +
          '<div class="machine">' + escHtml(partName(part)) + '</div>' +
          '<div class="op">' + escHtml(part.desc || '') +
            (part.desc ? ' · ' : '') + steps.length +
            (steps.length === 1 ? ' operation' : ' operations') + '</div>' +
        '</div>' +
        '<div class="figure">' +
          '<div class="total">' + (total ? fmtSec(total) : '—') + '</div>' +
          '<div class="sub">' + (measured.length
            ? 'process time over ' + measured.length + (measured.length === 1 ? ' step' : ' steps')
            : 'no cycles recorded') + '</div>' +
        '</div>' +
      '</div>';

    // the boxes, banded by cell the way the screen bands them
    const bands = [];
    steps.forEach((st, i) => {
      const route = st.best || st.routes[0] || null;
      const cell = route ? route.cell : null;
      const key = cell ? cell.id : (route ? 'none' : 'nomachine');
      const label = cell ? cell.name : (route ? 'Not in a cell' : 'No machine set up');
      if (!bands.length || bands[bands.length - 1].key !== key) bands.push({ key, label, steps: [] });
      bands[bands.length - 1].steps.push({ st, i });
    });
    const boxHtml = (st, i) => {
      const routes = st.routes.length ? st.routes : [null];
      return '<div class="vstep">' + (i ? '<div class="varrow">&rarr;</div>' : '') +
        '<div class="vboxes">' + routes.map(route =>
          '<div class="vbox' + (route && st.best === route && routes.length > 1 ? ' best' : '') + '">' +
            '<div class="vtop"><span class="vn">' + (i + 1) + '</span>' +
              '<span class="vop">' + escHtml(st.op.name) + '</span>' +
              (route && route.layout ? '<span class="vtl">' + escHtml(tlName(route.layout)) + '</span>' : '') +
            '</div>' +
            '<div class="vmachine">' + escHtml(route ? machineName(route.machineId) : 'No machine set up') + '</div>' +
            '<div class="vtime">' + (route && route.cycle ? fmtSec(route.cycle) : '—') + '</div>' +
            '<div class="vmeta">' + escHtml([
              route ? route.tools + (route.tools === 1 ? ' tool' : ' tools') : '',
              route && route.cutShare ? Math.round(route.cutShare * 100) + '% in cut' : '',
              route && route.cycle && total ? Math.round((route.cycle / total) * 100) + '% of total' : '',
            ].filter(Boolean).join(' · ') || 'nothing measured') + '</div>' +
          '</div>').join('') +
        '</div></div>';
    };
    // the cells it actually crosses — a band for steps with no cell, or no
    // machine at all, is not one of them
    const crossed = new Set(bands.map(b => b.key).filter(k => k !== 'none' && k !== 'nomachine')).size;
    const flow = '<div class="panel"><div class="panel-head"><span class="k">Route</span>' +
      '<span class="v">' + (crossed
        ? 'through ' + crossed + (crossed === 1 ? ' cell' : ' cells')
        : 'no cells set') + '</span></div>' +
      bands.map(b => '<div class="vband"><div class="vband-k">' + escHtml(b.label) + '</div>' +
        '<div class="vlane">' + b.steps.map(x => boxHtml(x.st, x.i)).join('') + '</div></div>').join('') +
      '</div>';

    const bar = measured.length > 1
      ? '<div class="bar">' + measured.map((st, n) => {
        const step = rampStep(n, measured.length);
        const share = st.cycle / total;
        return '<div class="seg" style="flex-grow:' + share.toFixed(4) +
          ';background:' + step.fill + ';color:' + step.ink + '">' +
          (share >= 0.08 ? escHtml(st.op.name) : '') + '</div>';
      }).join('') + '</div>'
      : '';

    const rows = steps.map((st, i) => {
      const route = st.best || st.routes[0] || null;
      return '<tr>' +
        '<td class="num">' + (i + 1) + '</td>' +
        '<td class="pocket">' + escHtml(route && route.layout ? tlName(route.layout) : '—') + '</td>' +
        '<td class="tool">' + escHtml(st.op.name) + '</td>' +
        '<td>' + escHtml(route && route.cell ? route.cell.name : '—') + '</td>' +
        '<td>' + escHtml(route ? machineName(route.machineId) : 'no machine set up') + '</td>' +
        '<td class="num">' + escHtml(route ? route.tools : '—') + '</td>' +
        '<td class="num">' + (st.cycle ? fmtSec(st.cycle) : '—') + '</td>' +
        '<td class="num">' + (route && route.cutShare ? Math.round(route.cutShare * 100) + '%' : '—') + '</td>' +
        '<td class="num">' + (st.cycle && total ? Math.round((st.cycle / total) * 100) + '%' : '—') + '</td>' +
        '</tr>';
    }).join('');
    const table = '<div class="panel"><div class="panel-head"><span class="k">Process time by step</span>' +
      '<span class="v">' + (total ? fmtSec(total) + ' measured' : 'no cycles recorded') + '</span></div>' +
      bar +
      '<table><thead><tr>' +
      ['#', 'Layout', 'Operation', 'Cell', 'Machine', 'Tools', 'Cycle', 'In cut', 'Share']
        .map(h => '<th>' + escHtml(h) + '</th>').join('') +
      '</tr></thead><tbody>' + rows + '</tbody></table></div>';

    // What the map does not claim. On a printed sheet this matters more than on
    // screen: a page with no caveat on it gets read as the whole picture.
    const untimed = steps.length - measured.length;
    const scope = '<div class="notes panel"><div class="panel-head"><span class="k">Scope</span></div>' +
      '<div class="note">Process time only — measured at the machine, tool by tool. Waiting between ' +
      'steps, batch sizes and changeovers are not held in this record and are not shown.</div>' +
      (untimed ? '<div class="note">' + untimed + ' of ' + steps.length +
        (steps.length === 1 ? ' step ' : ' steps ') + (untimed === 1 ? 'has' : 'have') +
        ' nothing measured yet, so the total is the process time measured so far rather than ' +
        'the whole part.</div>' : '') +
      (steps.some(st => st.routes.length > 1)
        ? '<div class="note">Where an operation runs on more than one machine, those are alternative ' +
          'routings: they are shown side by side and the total takes the fastest measured.</div>'
        : '') +
      '</div>';

    const foot = '<div class="foot">' +
      '<span class="brand">' + LOGO + '<span class="name">Shop<i>watch</i></span></span>' +
      '<span class="ref">' + escHtml(doc ? doc.title : '') + ' · Value stream · ' +
      escHtml(partName(part)) + '</span>' +
      '<span class="issued">Issued ' + escHtml(when) + '</span></div>';

    return '<section class="tl">' + head + flow + table + scope + foot + '</section>';
  }

  // The value stream for one part, printed on its own.
  function exportStreamPdf(partId) {
    const part = partById(partId) || streamPart();
    if (!part) { flash('Add a part and its operations first — a value stream is a part’s route.'); return; }
    if (!opsOfPart(part.id).length) {
      flash(partName(part) + ' has no operations yet, so there is no route to map.');
      return;
    }
    if (!printDoc(partName(part) + ' — value stream', [streamPage(part, issuedNow())])) return;
    flash('The value stream for ' + partName(part) + ' — choose “Save as PDF” in the print dialog.', true);
  }

  // Every tool layout, or one of them, as a print-ready document handed to the
  // browser's own print dialog — where "Save as PDF" is one of the choices.
  // A date and a time, without the seconds: this stamps a document, it does not
  // time anything.
  const issuedNow = () => new Date().toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });

  // Hand a set of pages to the browser's own print dialog, where Save as PDF is
  // one of the choices and a printer is the other. Returns false if the window
  // never opened, so a caller does not announce a document nobody has.
  function printDoc(title, pages) {
    const html = '<!doctype html><html><head><meta charset="utf-8"><title>' + escHtml(title) +
      '</title><style>' + PDF_STYLE + '</style></head><body>' + pages.join('') + '</body></html>';
    const win = window.open('', '_blank');
    if (!win) { flash('Allow pop-ups on this site to make the PDF.'); return false; }
    win.document.open();
    win.document.write(html);
    win.document.close();
    // The print is fired from here rather than from a script inside the page,
    // which is the more reliable of the two where inline script is restricted.
    let printed = false;
    const firePrint = () => {
      if (printed) return;
      printed = true;
      try { win.focus(); win.print(); } catch { /* the page is open; Ctrl+P still works */ }
    };
    win.onload = () => setTimeout(firePrint, 120);
    setTimeout(firePrint, 350);
    return true;
  }

  function exportPdf(onlyId) {
    if (!shop) return;
    const pages = onlyId ? [layoutById(onlyId)].filter(Boolean) : allLayouts();
    if (!pages.length) {
      flash(shop.assignments.length
        ? 'None of the tools set up here are on an operation yet, so there is no tool layout to print.'
        : 'Set a tool up on a machine for an operation first — a tool layout is what a page is.');
      return;
    }
    const when = issuedNow();
    const title = (doc ? doc.title : 'Shopwatch') +
      (onlyId ? ' — ' + tlName(pages[0]) : ' — tool layouts');
    if (!printDoc(title, pages.map(l => layoutPage(l, when)))) return;

    // A tool on a machine with no operation named is on no layout, so it is on
    // no page. Better said than quietly left out of a sheet somebody is about
    // to work from.
    const loose = onlyId ? 0 : shop.assignments.filter(a => !a.operationId).length;
    flash(pages.length + (pages.length === 1 ? ' tool layout' : ' tool layouts') +
      ', one to a page — choose “Save as PDF” in the print dialog.' +
      (loose ? ' ' + loose + (loose === 1 ? ' tool is' : ' tools are') +
        ' on a machine with no operation named, so ' + (loose === 1 ? 'it is' : 'they are') +
        ' on no layout and no page.' : ''), true);
  }

  /* ---------------- keyboard ---------------- */
  // Hands are usually on the machine rather than the keyboard, but a laptop at
  // the bench gets the three keys that matter. Ignored while typing, and while
  // this screen is not the one on show.
  function onKey(e) {
    if (!host || host.hidden || form) return;
    if (!canEdit()) return;   // the watch belongs to whoever may record with it
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const tag = e.target && e.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'BUTTON') return;
    if (e.key === ' ') { e.preventDefault(); startStop(); return; }
    if (e.key === 'l' || e.key === 'L') { e.preventDefault(); lap(); return; }
    if (e.key === 'n' || e.key === 'N') { e.preventDefault(); lapNext(); return; }
    if (e.key === 'c' || e.key === 'C') { e.preventDefault(); toggleCut(); return; }
    if (e.key === 'r' || e.key === 'R') { e.preventDefault(); reset(); }
  }

  /* ---------------- the mark ----------------
     A stopwatch whose hand is a cutting insert: the two things this screen is
     about, in one shape. The dial and the crown say what it is from across a
     bench; the rhombus sweeping out of the middle is an 80° insert, which is
     the hand of a watch that only ever times metal being cut.

     It is drawn rather than fetched — an inline SVG needs no file, no request
     and no second copy at another size, and it takes the palette with it: the
     mark is currentColor, so it is the app's accent wherever the app's accent
     is, and the pivot is punched out in the page colour rather than painted in
     a colour that would be wrong on another background.

     The wordmark beside it splits the way the app's own does — MindMap**Share**,
     Shop**watch** — because the two halves are the two halves of the idea.
  ---------------------------------------------------------------- */
  const LOGO = '<svg viewBox="0 0 24 24" class="mf-logo" aria-hidden="true" focusable="false">' +
    // the crown: the button, and a neck run far enough down to meet the dial —
    // the two are one shape at any size, and a gap there reads as a loose dot
    '<rect x="10.2" y="0.9" width="3.6" height="2.3" rx="1.1" fill="currentColor"/>' +
    '<rect x="11.1" y="2.6" width="1.8" height="3.6" fill="currentColor"/>' +
    '<circle cx="12" cy="13.6" r="8" fill="none" stroke="currentColor" stroke-width="1.8"/>' +
    // the hand: a rhombus, the shape of the insert it is timing, swept out of
    // the middle to where a second hand sits
    '<polygon points="16.17,9.43 15.05,13.61 10.87,14.73 11.99,10.55" fill="currentColor"/>' +
    '<circle cx="12" cy="13.6" r="1" fill="var(--bg)"/>' +
    '</svg>';

  function brand() {
    const box = el('div', 'mf-brand');
    // The mark is set as markup because an SVG built with createElement lands in
    // the HTML namespace and never draws. It is a constant with nothing
    // interpolated into it.
    const mark = el('span', 'mf-mark');
    mark.innerHTML = LOGO;
    box.appendChild(mark);

    // The mark and the name, and nothing under them. A line of copy explaining
    // what the screen is for is for somebody who has not opened it yet; on the
    // screen itself it is one more thing between the operator and the watch.
    const title = el('h1', 'mf-h1');
    title.appendChild(document.createTextNode('Shop'));
    title.appendChild(el('span', 'mf-h1-b', 'watch'));
    box.appendChild(title);
    return box;
  }

  /* ---------------- the shell's hooks ---------------- */
  function mount(section, context) {
    ctx = context;
    host = section;
    host.classList.add('mf-root');

    const page = el('div', 'mf-page');

    const top = el('div', 'mf-top');
    top.appendChild(brand());
    const actions = el('div', 'mf-top-btns');
    // Everything that adds to a floor is left off a screen that cannot write to
    // one. Export stays: reading it and downloading it are the same permission.
    if (signedIn()) {
      actions.appendChild(button('mf-btn mf-btn-sm', '+ Part', withDoc(() => openForm('part'))));
      actions.appendChild(button('mf-btn mf-btn-sm', '+ Machine', withDoc(() => openForm('machine'))));
      actions.appendChild(button('mf-btn mf-btn-sm', '+ Tool', withDoc(() => openForm('tool'))));
      actions.appendChild(button('mf-btn mf-btn-sm', '+ Setup', withDoc(() => openForm('assignment')),
        'Put a tool from the crib on a machine, for an operation'));
    }
    // The file input is driven by the button beside it rather than shown raw,
    // and is reset after each pick so choosing the same file twice still fires.
    const file = el('input', 'mf-file');
    file.type = 'file';
    file.accept = '.csv,text/csv,text/plain';
    file.addEventListener('change', () => {
      const chosen = file.files && file.files[0];
      file.value = '';
      chooseImport(chosen);
    });
    if (signedIn()) {
      actions.appendChild(button('mf-btn mf-btn-sm', '⤒ Import', () => file.click(),
        'Read a spreadsheet of tooling back in — the columns ⤓ Export writes'));
    }
    actions.appendChild(button('mf-btn mf-btn-sm', '⤓ Export', exportCsv, 'Download the whole shop record as a spreadsheet'));
    // Reading a floor and printing it are the same permission, so this stays on
    // a screen that may not write, next to Export for the same reason.
    actions.appendChild(button('mf-btn mf-btn-sm', '🖨 PDF', () => exportPdf(),
      'Every tool layout, one to a page — to print, or to save as a PDF'));
    if (signedIn()) actions.appendChild(file);
    top.appendChild(actions);
    page.appendChild(top);

    els.flash = el('div', 'mf-flash');
    els.flash.hidden = true;
    page.appendChild(els.flash);

    els.docbar = el('div', 'mf-docbar');
    els.docbar.hidden = true;
    page.appendChild(els.docbar);
    els.share = el('div', 'mf-share');
    els.share.hidden = true;
    page.appendChild(els.share);
    els.chat = el('div', 'mf-chat');
    els.chat.hidden = true;
    page.appendChild(els.chat);

    els.import = el('div', 'mf-import');
    els.import.hidden = true;
    page.appendChild(els.import);

    els.watch = el('div', 'mf-watch');
    els.stats = el('div', 'mf-stats');
    els.runs = el('div', 'mf-runs');
    els.form = el('div', 'mf-form');
    els.form.hidden = true;
    els.chart = el('div', 'mf-chart');
    els.chart.hidden = true;
    els.cutchart = el('div', 'mf-cutchart');
    els.cutchart.hidden = true;
    els.stream = el('div', 'mf-stream');
    els.stream.hidden = true;
    els.search = el('div', 'mf-searchbox');
    els.search.hidden = true;
    els.parts = el('div', 'mf-parts');
    els.machines = el('div', 'mf-machines');
    els.tools = el('div', 'mf-tools');
    page.appendChild(els.watch);
    page.appendChild(els.stats);
    page.appendChild(els.runs);
    page.appendChild(els.form);
    page.appendChild(els.chart);
    page.appendChild(els.cutchart);
    page.appendChild(els.stream);
    page.appendChild(els.search);
    page.appendChild(els.parts);
    page.appendChild(els.machines);
    page.appendChild(els.tools);
    host.appendChild(page);

    document.addEventListener('keydown', onKey);
    restoreLocal();
    render(); // the loading state; open() runs straight after this and fetches
  }

  // Coming back to the screen: the record may have moved on another device, and
  // #/p/manufacturing/t/<id> points the watch at a particular setup.
  function open(sub) {
    restoreLocal();
    startTick();
    const path = String(sub || '');
    const asDoc = path.match(/^d\/([A-Za-z0-9]{1,40})$/);
    if (asDoc) wantDoc = asDoc[1];
    const pick = path.match(/^[ta]\/([A-Za-z0-9]{1,24})$/);
    if (pick) pendingPick = pick[1];
    // An unsaved edit outranks a refetch — never pull the record out from under
    // a time somebody just measured.
    if (shop && dirty && !wantDoc) { render(); return; }
    if (wantDoc && doc && wantDoc === doc.id) { wantDoc = ''; startLive(); render(); return; }
    loadDocs();
  }

  function leave() {
    stopTick(); // the watch keeps time off the clock; only the display stops
    stopLive(); // and the stream closes rather than ticking on in the background
    flush();
  }

  window.MindMapPlugins.register({ id: ID, mount, open, leave });
})();
