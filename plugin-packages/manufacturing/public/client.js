'use strict';

/* ================================================================
   Shopwatch — the shop-floor screen

   Five things, and the relations between them:

     a tool        its own part number, what it is, how many cutting edges
     a machine     what it is called on the floor
     a part        a part number being made
     an operation  one step in making that part — Op 10, Op 20. An operation
                   belongs to one part, because that is what an op is: a step
                   in making that part, not a name that means the same thing
                   everywhere.
     an assignment one tool, on one machine, doing one operation. This is the
                   many-to-many between tools and machines, and it carries what
                   is only true of that combination: the cutting time, how many
                   of the tool's edges are indexed through there, and how many
                   parts run between one index and the next.

   The stopwatch times an assignment, because a cycle time is only ever true of
   one tool on one machine doing one op. The same tool in the same machine
   cutting a different operation is a different setup with its own cutting
   time — the time a tool spends in cut is a fact about the operation, not
   about the tool.

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
  let flashTimer = null;
  let filter = '';
  let form = null;          // { kind: 'machine' | 'tool' | 'part' | 'operation' | 'assignment', draft }
  let formError = '';
  let pendingPick = '';     // a record named by the URL, waiting on the shop to load
  let pendingImport = null; // a read CSV and what importing it would do, awaiting a yes
  let tick = null;          // display interval while the watch runs
  const els = {};           // the panels render() refills

  // The stopwatch. Elapsed time is derived from wall-clock stamps rather than
  // counted up by the interval, so a phone that sleeps mid-cycle, a throttled
  // background tab, and a page reload all come back with the right time.
  let watch = { running: false, since: 0, accum: 0, lastLap: 0, laps: 0 };

  const watchKey = () => {
    const who = ctx && ctx.me() ? ctx.me().username : '';
    return 'mf.watch.' + who;
  };

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
        };
        // a stamp from the future (clock change) would read as negative elapsed
        if (watch.running && watch.since > Date.now()) watch.since = Date.now();
      }
    } catch { /* nothing saved, or unreadable: start fresh */ }
  }

  const elapsed = () => watch.accum + (watch.running ? Date.now() - watch.since : 0);

  /* ---------------- what is folded away ----------------
     Which lists are collapsed is a view preference, not a shop record: it is
     about this screen on this device, so it lives beside the watch in local
     storage rather than being saved to the account and pushed onto every other
     device signed into it. It is held in memory too, because the lists are rebuilt from
     scratch on every save and a fold kept only in the DOM would spring open.
  ---------------------------------------------------------------- */
  let folded = new Set();

  const foldKey = () => {
    const who = ctx && ctx.me() ? ctx.me().username : '';
    return 'mf.folded.' + who;
  };
  function saveFolded() {
    try { localStorage.setItem(foldKey(), JSON.stringify([...folded])); } catch { /* private mode */ }
  }
  function restoreFolded() {
    try {
      const raw = JSON.parse(localStorage.getItem(foldKey()) || '[]');
      if (Array.isArray(raw)) folded = new Set(raw.filter(k => typeof k === 'string').slice(0, 400));
    } catch { /* nothing saved, or unreadable: everything open */ }
  }

  // A filter outranks a fold. Searching for something and being shown a closed
  // heading that contains it would be the screen hiding the answer it was just
  // asked for, so while a filter is on, everything is open.
  const isFolded = key => !filter && folded.has(key);

  function toggleFold(key, redraw) {
    if (folded.has(key)) folded.delete(key);
    else folded.add(key);
    saveFolded();
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
  const jobsOfTool = id => (shop ? shop.assignments.filter(a => a.toolId === id) : []);
  const jobsOnMachine = id => (shop ? shop.assignments.filter(a => a.machineId === id) : []);
  const jobsOfOperation = id => (shop ? shop.assignments.filter(a => a.operationId === id) : []);
  const machinesOfTool = id => {
    const seen = new Set();
    return jobsOfTool(id).map(a => a.machineId).filter(m => (seen.has(m) ? false : seen.add(m)));
  };
  const machinesOfOperation = id => {
    const seen = new Set();
    return jobsOfOperation(id).map(a => a.machineId).filter(m => (seen.has(m) ? false : seen.add(m)));
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

  // The tools that run together: one machine, one operation. That is the
  // grouping the running order, the chart and every total below are per — and
  // it is why the cutting time lives on the assignment, since the same tool in
  // the same machine on another op is another setup with another time.
  const opKey = a => a.machineId + '\u0000' + (a.operationId || '');
  const opJobs = a => (a && shop ? shop.assignments.filter(x => opKey(x) === opKey(a)).sort(bySeq) : []);

  // Running order within an operation. An assignment with no sequence yet
  // sorts after the ones that have one, oldest first, so an unplaced tool
  // lands at the end of the list rather than jumping to the front of the job.
  function bySeq(a, b) {
    const as = a.seq || Infinity, bs = b.seq || Infinity;
    if (as !== bs) return as - bs;
    return (a.createdAt || 0) - (b.createdAt || 0);
  }

  // Close up the numbering of a setup after a move or a deletion, so the
  // sequence is always 1..n with no gaps and no ties.
  function renumberOp(key) {
    shop.assignments.filter(x => opKey(x) === key).sort(bySeq).forEach((a, i) => {
      if (a.seq !== i + 1) { a.seq = i + 1; touch(a); }
    });
  }

  function statsFor(a) {
    const runs = (a && a.runs) || [];
    if (!runs.length) return null;
    let sum = 0, best = Infinity, worst = 0;
    for (const r of runs) {
      sum += r.sec;
      if (r.sec < best) best = r.sec;
      if (r.sec > worst) worst = r.sec;
    }
    return {
      count: runs.length,
      avg: sum / runs.length,
      best,
      worst,
      spread: worst - best,
      last: runs[0].sec, // runs are kept newest first
    };
  }

  // What one tool on one machine is expected to do on one operation, from the
  // two numbers that belong to that setup: the parts it runs between edge
  // indexes, and how many of the tool's edges get indexed through there. A
  // setup that leaves the edges blank falls back to the tool's own count — the
  // whole tool gets used up unless somebody says otherwise. Returns null until
  // there is a tool life to work from; `cut` is the cutting time if it is
  // filled in and the measured average otherwise, so the minutes are honest
  // about which.
  function lifeFor(a, avgSec) {
    const parts = a.partsPerIndex || 0;
    if (!parts) return null;
    const tool = jobTool(a);
    const edges = a.indexEdges || (tool ? tool.cuttingEdges : 0) || 0;
    const partsPerTool = edges ? parts * edges : 0;
    const cut = a.cutSec || avgSec || 0;
    return {
      parts,
      edges,
      edgesFromTool: !a.indexEdges && !!edges,
      partsPerTool,
      edgeMin: cut ? (parts * cut) / 60 : 0,   // cutting minutes one edge lasts
      measured: !a.cutSec && !!cut,            // the minutes came off the stopwatch
      per100: partsPerTool ? 100 / partsPerTool : 0,
      costPart: partsPerTool && tool && tool.cost ? tool.cost / partsPerTool : 0,
    };
  }

  /* ---------------- loading & saving ---------------- */
  async function load() {
    try {
      const data = await ctx.api('/');
      shop = data.shop;
      limits = data.limits || limits;
    } catch (err) {
      shop = shop || { machines: [], tools: [], parts: [], operations: [], assignments: [], activeId: '' };
      flash('Your shop record could not be loaded (' + err.message + ').');
    }
    // a link that named a record arrived before the record did
    if (pendingPick) {
      const id = pendingPick;
      pendingPick = '';
      // the id may name a setup, or a tool whose first setup it is
      const first = jobById(id) || jobsOfTool(id)[0];
      if (first) { selectJob(first.id); return; }
    }
    render();
  }

  function save() {
    if (!shop) return;
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
    if (!shop || !dirty) return;
    try {
      await ctx.api('/', 'PUT', { shop });
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
    if (!shop || !dirty) return;
    dirty = false;
    fetch('/api/plugins/' + ID + '/', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ shop }),
      keepalive: true,
    }).catch(() => { dirty = true; saveTimer = setTimeout(doSave, 4000); });
  }

  function flash(message) {
    if (!els.flash) return;
    els.flash.textContent = message;
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
      watch.accum = elapsed();
      watch.running = false;
    } else {
      watch.since = Date.now();
      watch.running = true;
    }
    saveWatch();
    renderWatch();
    startTick();
  }

  // One part done: record the split since the last cycle and keep running.
  function lap() {
    const a = activeJob();
    if (!a) { flash('Pick a tool at a machine first — a cycle time belongs to one.'); return; }
    if (!watch.running && !watch.accum) { flash('Start the watch, then mark each cycle as it finishes.'); return; }
    const now = elapsed();
    const cycle = (now - watch.lastLap) / 1000;
    if (cycle < 0.2) return; // a double-tap is not a cycle
    watch.lastLap = now;
    watch.laps += 1;
    saveWatch();
    addRun(a, round(cycle, 2));
    renderWatch();
  }

  function reset() {
    watch = { running: false, since: 0, accum: 0, lastLap: 0, laps: 0 };
    saveWatch();
    stopTick();
    renderWatch();
  }

  function addRun(a, sec, at) {
    if (!sec) return;
    a.runs.unshift({ id: newId('r'), sec, at: at || Date.now(), note: '' });
    if (a.runs.length > limits.maxRuns) a.runs.length = limits.maxRuns;
    touch(a);
    saveNow();
    renderStats();
    renderRuns();
    renderChart();    // this tool's share of the operation just moved
    renderParts();    // as did the operation's measured cycle
    renderMachines(); // and its average, on its card
  }

  function startTick() {
    stopTick();
    if (!watch.running) return;
    // A tenth on the display; the interval only reads the clock, so a slow or
    // throttled tick shows a stale number rather than a wrong one.
    tick = setInterval(() => { if (els.time) els.time.textContent = fmtClock(elapsed()); }, 100);
  }
  function stopTick() {
    clearInterval(tick);
    tick = null;
  }

  /* ---------------- rendering ---------------- */
  function render() {
    renderImport();
    renderWatch();
    renderStats();
    renderRuns();
    renderForm();
    renderChart();
    renderSearch();
    renderParts();
    renderMachines();
    renderTools();
  }

  function renderWatch() {
    const box = els.watch;
    box.innerHTML = '';
    if (!shop) { box.appendChild(el('div', 'mf-loading', 'Loading your shop…')); return; }
    const a = activeJob();

    if (!a) {
      const empty = el('div', 'mf-empty');
      const started = shop.tools.length || shop.machines.length || shop.parts.length;
      empty.appendChild(el('div', 'mf-empty-title', shop.assignments.length
        ? 'Pick a tool to time'
        : (started ? 'Set a tool up on a machine' : 'Start with a part, a machine and a tool')));
      empty.appendChild(el('div', 'mf-empty-text', shop.assignments.length
        ? 'Every cycle time is recorded against one tool, on one machine, doing one operation — so choose the one at the spindle before you start the watch.'
        : 'A part has operations; a tool has a part number and cutting edges. Setting a tool up on a machine for one of those operations is what carries the cutting time, the edges indexed there and the parts between indexes — and what the stopwatch records against.'));
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

    box.classList.toggle('mf-running', watch.running);

    // which tool, at which machine, on which operation
    const head = el('div', 'mf-watch-head');
    const who = el('div', 'mf-watch-who');
    const title = el('div', 'mf-watch-title');
    if (a.seq) title.appendChild(el('span', 'mf-seq', String(a.seq)));
    if (a.station) title.appendChild(el('span', 'mf-chip', a.station));
    title.appendChild(el('span', 'mf-watch-name', jobName(a)));
    const tool = jobTool(a);
    if (tool && tool.partNumber && tool.desc) title.appendChild(el('span', 'mf-watch-pn', tool.partNumber));
    who.appendChild(title);
    const where = el('div', 'mf-watch-op', opLabel(a));
    // where in the operation's running order this tool sits
    const order = opJobs(a);
    if (a.seq && order.length > 1) where.textContent += ' · tool ' + a.seq + ' of ' + order.length;
    who.appendChild(where);
    head.appendChild(who);
    head.appendChild(button('mf-btn mf-btn-sm', 'Edit setup', () => openForm('assignment', a.id),
      'The operation, cutting time, edges and tool life of this tool on this machine'));
    box.appendChild(head);

    els.time = el('div', 'mf-time', fmtClock(elapsed()));
    box.appendChild(els.time);

    const line = el('div', 'mf-lapline');
    const last = a.runs.length ? a.runs[0] : null;
    line.textContent = watch.laps
      ? watch.laps + (watch.laps === 1 ? ' cycle this run' : ' cycles this run') +
        (last ? ' · last ' + fmtSec(last.sec) : '')
      : (last ? 'Last recorded cycle ' + fmtSec(last.sec) : 'No cycles recorded yet');
    box.appendChild(line);

    const btns = el('div', 'mf-watch-btns');
    btns.appendChild(button('mf-btn mf-btn-go' + (watch.running ? ' mf-btn-stop' : ''),
      watch.running ? 'Stop' : (watch.accum ? 'Resume' : 'Start'), startStop,
      'Space starts and stops the watch'));
    btns.appendChild(button('mf-btn mf-btn-lap', 'Cycle done', lap,
      'Records the time since the last cycle and keeps the watch running (L)'));
    btns.appendChild(button('mf-btn mf-btn-quiet', 'Reset', reset, 'Back to zero, keeping every recorded cycle (R)'));
    box.appendChild(btns);

    if (shop.assignments.length > 1) {
      box.appendChild(dropdown('mf-pick',
        shop.assignments.map(other => ({ value: other.id, label: jobName(other) + ' — ' + opLabel(other) })),
        a.id, selectJob, 'Tool being timed'));
    }
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
        'This tool is on the machine but not on an operation. The cutting time and the tool life belong to the op it is cutting, so name it. '));
      note.appendChild(button('mf-link', 'Edit setup', () => openForm('assignment', a.id)));
      box.appendChild(note);
    }

    if (s) {
      const timing = el('div', 'mf-tiles');
      timing.appendChild(tile('cycles timed', String(s.count)));
      timing.appendChild(tile('average', fmtSec(s.avg)));
      timing.appendChild(tile('best', fmtSec(s.best)));
      timing.appendChild(tile('spread', fmtSec(s.spread), 'Slowest cycle minus fastest — how repeatable the op is'));
      if (a.cutSec) {
        timing.appendChild(tile('cutting time', fmtSec(a.cutSec),
          'What this tool is set to spend in cut on this machine, on ' + jobLabel(a)));
      }
      box.appendChild(timing);
      if (a.cutSec && s.avg) {
        const share = Math.round((a.cutSec / s.avg) * 100);
        box.appendChild(el('div', 'mf-note',
          a.cutSec > s.avg
            ? 'The cutting time on this setup is longer than the whole measured cycle, so one of the two is wrong.'
            : share >= 100
              ? 'The cutting time is the whole measured cycle. Set it to the time actually in cut and everything else in the cycle shows up here.'
              : 'Cutting time is ' + fmtSec(a.cutSec) + ' of the ' + fmtSec(s.avg) + ' measured cycle — ' +
                share + '% of it is cut, the rest is everything else.'));
      }
    } else {
      box.appendChild(el('div', 'mf-note',
        'Time a few cycles and the averages, and how much of the cycle is cut, fall out of them.'));
    }

    const life = lifeFor(a, s ? s.avg : 0);
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
      'Parts run between one edge index and the next, on this machine and this op'));
    if (life.partsPerTool) {
      derived.appendChild(tile('parts / tool', String(life.partsPerTool),
        life.edges + ' indexable edge' + (life.edges === 1 ? '' : 's') + ' × ' + life.parts + ' parts per index' +
        (life.edgesFromTool ? ' (every edge the tool has)' : '')));
    }
    if (life.edgeMin) {
      derived.appendChild(tile('min / edge', String(round(life.edgeMin, 1)),
        'Cutting minutes one edge lasts, at ' + fmtSec(a.cutSec || (s ? s.avg : 0)) +
        (life.measured ? ' measured cycle' : ' of cut')));
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

    const jobs = opJobs(active);
    const rows = jobs.map((a, i) => {
      const s = statsFor(a);
      return { a, i, avg: s ? s.avg : 0, count: s ? s.count : 0, step: rampStep(i, jobs.length) };
    });
    const timed = rows.filter(r => r.avg > 0);
    const total = timed.reduce((sum, r) => sum + r.avg, 0);
    box.hidden = false;

    const head = el('div', 'mf-chart-head');
    const heading = el('div');
    heading.appendChild(el('div', 'mf-section-title', 'Op cycle'));
    heading.appendChild(el('div', 'mf-chart-op', opLabel(active)));
    head.appendChild(heading);
    const figure = el('div', 'mf-chart-figure');
    figure.appendChild(el('div', 'mf-chart-total', total ? fmtSec(total) : '—'));
    figure.appendChild(el('div', 'mf-chart-sub', timed.length
      ? 'measured across ' + timed.length + (timed.length === 1 ? ' tool' : ' tools')
      : 'nothing timed yet'));
    head.appendChild(figure);
    box.appendChild(head);

    if (!timed.length) {
      box.appendChild(el('div', 'mf-note', 'Time a cycle against a tool on this op and its share of the total appears here.'));
      return;
    }

    // One timed tool is not a part-to-whole story — the figure above already is
    // the whole of it, and a single-segment bar would say nothing more.
    if (timed.length > 1) {
      const bar = el('div', 'mf-bar');
      bar.setAttribute('role', 'img');
      bar.setAttribute('aria-label',
        'Total op cycle ' + fmtSec(total) + ', divided between ' + timed.length + ' tools. The same numbers are in the table below.');
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
        ' tools on this op ' + (untimed === 1 ? 'has' : 'have') +
        ' no cycles timed yet, so the total is what has been measured so far, not the finished op.'));
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

  function renderRuns() {
    const box = els.runs;
    box.innerHTML = '';
    const a = activeJob();
    if (!a) return;

    const head = el('div', 'mf-section-head');
    head.appendChild(el('div', 'mf-section-title', 'Recorded cycles'));
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
    head.appendChild(add);
    box.appendChild(head);

    if (!a.runs.length) {
      box.appendChild(el('div', 'mf-note', 'Nothing timed against this setup yet.'));
      return;
    }

    const list = el('div', 'mf-runs-list');
    a.runs.forEach((r, i) => {
      const row = el('div', 'mf-run');
      row.appendChild(el('div', 'mf-run-n', '#' + (a.runs.length - i)));
      row.appendChild(el('div', 'mf-run-t', fmtSec(r.sec)));
      row.appendChild(el('div', 'mf-run-at', fmtAgo(r.at)));
      row.appendChild(button('mf-x', '✕', () => {
        a.runs = a.runs.filter(x => x.id !== r.id);
        touch(a);
        save();
        renderStats();
        renderRuns();
        renderChart();
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
     wherever it runs, an operation belongs to one part, and the cutting time
     is true only of one tool, on one machine, on one op.
  ---------------------------------------------------------------- */
  const MACHINE_FIELDS = [
    { key: 'name', label: 'Machine', placeholder: 'Haas ST-20', wide: true, hint: 'What it is called on the floor' },
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
    { key: 'station', label: 'Station', placeholder: 'T0303' },
    { key: 'seq', label: 'Seq', placeholder: '1', num: true, hint: 'Where it falls in the op — 1 cuts first' },
    { key: 'cutSec', label: 'Cutting time', placeholder: '42.6', num: true, hint: 'Seconds in cut on one part, on this machine and this op' },
    { key: 'indexEdges', label: 'Indexable edges', placeholder: '4', num: true, hint: 'How many of the tool\'s edges get indexed through here' },
    { key: 'partsPerIndex', label: 'Parts per index', placeholder: '250', num: true, hint: 'Parts run between one edge index and the next' },
  ];

  const FORM_FIELDS = {
    machine: MACHINE_FIELDS, tool: TOOL_FIELDS, part: PART_FIELDS,
    operation: OPERATION_FIELDS, assignment: JOB_FIELDS,
  };
  const FORM_TITLES = {
    machine: ['New machine', 'Edit machine'],
    tool: ['New tool', 'Edit tool'],
    part: ['New part', 'Edit part'],
    operation: ['New operation', 'Edit operation'],
    assignment: ['Set a tool up on a machine', 'Edit this setup'],
  };
  const FINDER = {
    machine: machineById, tool: toolById, part: partById,
    operation: operationById, assignment: jobById,
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
        flash('Add the part and its operation first — the cutting time belongs to an op.');
        openForm(shop.parts.length ? 'operation' : 'part');
        return;
      }
    }
    if (kind === 'operation' && !id && !shop.parts.length) {
      flash('Add the part first — an operation is a step in making one.');
      openForm('part');
      return;
    }
    const found = id ? FINDER[kind](id) : null;
    let draft;
    if (found) {
      draft = { ...found, runs: undefined };
    } else if (kind === 'machine') {
      draft = { id: '', name: '', notes: '', ...(preset || {}) };
    } else if (kind === 'tool') {
      draft = { id: '', partNumber: '', desc: '', cuttingEdges: '', cost: '', notes: '' };
    } else if (kind === 'part') {
      draft = { id: '', number: '', desc: '', notes: '' };
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
        cutSec: '', indexEdges: '', partsPerIndex: '', notes: '', ...(preset || {}),
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
    const key = draft.machineId + '\u0000' + (draft.operationId || '');
    return shop.assignments
      .filter(x => opKey(x) === key && x.id !== draft.id)
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
  // A cutting time is typed the way a time is read off a machine, so it takes
  // 1:23.4 as well as 83.4.
  const cleanTime = v => parseTime(v) || cleanNum(v);

  function saveForm() {
    const { kind, draft } = form;
    if (kind === 'machine') return saveMachine(draft);
    if (kind === 'tool') return saveTool(draft);
    if (kind === 'part') return savePart(draft);
    if (kind === 'operation') return saveOperation(draft);
    return saveAssignment(draft);
  }

  function fail(message) {
    formError = message;
    renderForm();
  }

  // Every save below ends the same way: the form closes, the record is queued
  // for saving, and the screen is redrawn.
  function done() {
    form = null;
    formError = '';
    save();
    render();
  }

  function saveMachine(draft) {
    const name = cleanText(draft.name);
    if (!name) return fail('A machine needs a name — whatever it is called on the floor.');
    const clash = shop.machines.find(m => m.id !== draft.id && m.name.toLowerCase() === name.toLowerCase());
    if (clash) return fail('There is already a machine called ' + clash.name + '.');
    const notes = cleanText(draft.notes).slice(0, 400);
    const existing = machineById(draft.id);
    let created = null;
    if (existing) {
      existing.name = name;
      existing.notes = notes;
      touch(existing);
    } else {
      if (shop.machines.length >= limits.maxMachines) {
        return fail('That is as many machines as one account keeps (' + limits.maxMachines + ').');
      }
      created = { id: newId('m'), name, notes, createdAt: Date.now(), updatedAt: Date.now() };
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
            '. Put each one on an operation to give it a cutting time.');
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
     decision, not a property of the machine, and the cutting time, the edges
     indexed and the parts between indexes are facts about the op being cut.

     A second machine standing in for the first runs the same work, though, so
     the clone can be told to bring the operations too: each setup then arrives
     whole, on the same op, with the cutting time and tool life worked out for
     it. That is a claim about the new machine — that it cuts the same op in
     the same time — so it is asked for rather than assumed.

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
        cutSec: withOps ? a.cutSec : 0,
        indexEdges: withOps ? a.indexEdges : 0,
        partsPerIndex: withOps ? a.partsPerIndex : 0,
        notes: withOps ? a.notes : '',
        runs: [],
        createdAt: now,
        updatedAt: now,
      });
      copied++;
    }
    for (const key of new Set(jobsOnMachine(toId).map(opKey))) renumberOp(key);
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
      else flash('Added to the crib. Set it up on a machine to give it a cutting time and a tool life.');
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
    done();
    // A part is made by its operations; without one there is nothing to set a
    // tool up for.
    if (created) openForm('operation', '', { partId: created.id });
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
      return fail('Choose the operation it is cutting — the cutting time and the tool life belong to one.');
    }
    const assignment = {
      toolId: draft.toolId,
      machineId: draft.machineId,
      operationId: draft.operationId,
      station: cleanText(draft.station),
      seq: Math.floor(cleanNum(draft.seq)),
      cutSec: round(cleanTime(draft.cutSec), 3),
      indexEdges: Math.floor(cleanNum(draft.indexEdges)),
      partsPerIndex: Math.floor(cleanNum(draft.partsPerIndex)),
      notes: cleanText(draft.notes).slice(0, 400),
    };
    const existing = jobById(draft.id);
    if (existing) {
      const wasOp = opKey(existing);
      Object.assign(existing, assignment);
      touch(existing);
      // Editing can move a tool to another machine or another operation, or
      // renumber it; close up the gap it left behind as well as the order it
      // joined.
      renumberOp(wasOp);
      if (opKey(existing) !== wasOp) renumberOp(opKey(existing));
    } else {
      if (shop.assignments.length >= limits.maxAssignments) {
        return fail('That is as many setups as one account keeps (' + limits.maxAssignments + ').');
      }
      const created = {
        id: newId('a'), ...assignment, runs: [], createdAt: Date.now(), updatedAt: Date.now(),
      };
      shop.assignments.push(created);
      renumberOp(opKey(created));
      setActive(created.id); // a tool set up mid-shift is the one being timed next
    }
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
        '? The cutting times belong to this op, so they go with it; the tools stay in the crib.'
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
    for (const key of new Set(shop.assignments.map(opKey))) renumberOp(key);
    if (!jobById(shop.activeId)) setActive(shop.assignments.length ? shop.assignments[0].id : '');
    done();
  }

  const DELETERS = {
    machine: deleteMachine, tool: deleteTool, part: deletePart,
    operation: deleteOperation, assignment: deleteAssignment,
  };
  const DELETE_LABELS = {
    machine: 'Delete machine', tool: 'Delete tool', part: 'Delete part',
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

    const cloneOf = draft.cloneOf ? machineById(draft.cloneOf) : null;
    box.appendChild(el('div', 'mf-section-title',
      cloneOf ? 'Clone ' + cloneOf.name : FORM_TITLES[kind][draft.id ? 1 : 0]));
    if (cloneOf) {
      const tools = distinctTools(cloneOf.id);
      const setups = jobsOnMachine(cloneOf.id).length;
      box.appendChild(el('div', 'mf-note', !tools
        ? 'There are no tools on ' + cloneOf.name + ' yet, so this is a new machine and nothing more.'
        : draft.withOps
          ? 'Saving this makes a second machine set up like ' + cloneOf.name + ': all ' + setups +
            (setups === 1 ? ' setup' : ' setups') + ' copied — the same tools, in the same stations, ' +
            'on the same operations, with the cutting times, indexable edges and tool life worked out ' +
            'for them. The cycles timed on ' + cloneOf.name + ' stay with it: they were measured on ' +
            'that machine.'
          : 'Saving this makes a second machine with the ' + tools +
            (tools === 1 ? ' tool' : ' tools') + ' on ' + cloneOf.name +
            ' copied onto it, in the same stations — the tools and nothing else. Which operations they ' +
            'cut, and the cutting times and tool life that go with them, belong to the op, and the ' +
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
          ', with that op\'s cutting time and tool life'));
        box.appendChild(opt);
      }
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
    if (kind === 'operation') {
      grid.appendChild(pickField('Part',
        [{ value: '', label: 'Choose a part…' }].concat(
          [...shop.parts].sort((x, y) => partName(x).localeCompare(partName(y)))
            .map(p => ({ value: p.id, label: partName(p) }))),
        draft.partId, v => { draft.partId = v; }));
    }

    for (const f of FORM_FIELDS[kind]) {
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
    if (draft.id) {
      row.appendChild(button('mf-btn mf-btn-danger', DELETE_LABELS[kind], () => DELETERS[kind](draft.id)));
    }
    box.appendChild(row);
  }

  /* ---------------- choosing what to time ---------------- */
  // Pointing the watch at a different setup. The time on the display belonged
  // to the one that just left, and its cycles are already recorded against it,
  // so the watch starts the new one from zero. Returns false if nothing moved.
  function setActive(id) {
    if (!shop || shop.activeId === id) return false;
    shop.activeId = id;
    reset();
    return true;
  }

  function selectJob(id) {
    if (!setActive(id)) return;
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
    return !filter || hay(m.name, m.notes).includes(filter);
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
    return hay(a.station, a.notes, machineName(a.machineId), op && op.name,
      part && part.number, part && part.desc,
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
    search.placeholder = 'Filter by part, op, machine, tool…';
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
      button('mf-btn mf-btn-sm', '+ Part', () => openForm('part'))));
    if (isFolded('sec:parts')) return;

    if (!shop.parts.length) {
      box.appendChild(el('div', 'mf-note',
        'No parts yet. A part has operations, and an operation is what a tool is set up for — which is what gives a cutting time something to be true of.'));
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
      pb.appendChild(button('mf-btn mf-btn-sm', '+ Operation', () => openForm('operation', '', { partId: p.id }),
        'Another step in making this part'));
      pb.appendChild(button('mf-link', 'Edit', () => openForm('part', p.id)));
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

        const machines = machinesOfOperation(o.id).map(machineName);
        const bits = [];
        bits.push(machines.length ? machines.join(', ') : 'no machine yet');
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
          acts.appendChild(button('mf-link', 'Time it', () => selectJob(jobs[0].id),
            'Point the watch at the first tool of this op'));
        } else {
          acts.appendChild(button('mf-link', 'Set up a tool', () => openForm('assignment', '', { operationId: o.id })));
        }
        acts.appendChild(button('mf-link', 'Edit', () => openForm('operation', o.id)));
        row.appendChild(acts);
        block.appendChild(row);
      }
      box.appendChild(block);
    }
    if (!shownAny) box.appendChild(el('div', 'mf-note', 'No part matches that.'));
  }

  function renderMachines() {
    const box = els.machines;
    box.innerHTML = '';
    if (!shop) return;

    box.appendChild(sectionHead('sec:machines', 'Machines', shop.machines.length, renderMachines,
      button('mf-btn mf-btn-sm', '+ Machine', () => openForm('machine'))));
    if (isFolded('sec:machines')) return;

    if (!shop.machines.length) {
      box.appendChild(el('div', 'mf-note', 'No machines yet. A machine is what a tool gets set up on.'));
      return;
    }

    const machines = [...shop.machines].sort((a, b) => a.name.localeCompare(b.name));
    let shownAny = false;
    for (const m of machines) {
      const all = jobsOnMachine(m.id);
      // a machine whose own name matches shows everything on it; otherwise only
      // the tools that match are listed under it
      const jobs = matchesMachine(m) ? all : all.filter(matchesJob);
      if (filter && !jobs.length && !matchesMachine(m)) continue;
      shownAny = true;

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
      mb.appendChild(button('mf-btn mf-btn-sm', '+ Tool here', () => openForm('assignment', '', { machineId: m.id }),
        'Set a tool from the crib up on this machine'));
      const tooled = distinctTools(m.id);
      mb.appendChild(button('mf-link', 'Clone', () => cloneMachine(m.id),
        tooled
          ? 'A second machine of the same kind, carrying these ' + tooled +
            (tooled === 1 ? ' tool' : ' tools') + ' in the same stations'
          : 'A second machine of the same kind'));
      mb.appendChild(button('mf-link', 'Edit', () => openForm('machine', m.id)));
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

      // within a machine, the tools are grouped by the operation they are set
      // up for and run in the order they cut
      const groups = new Map();
      for (const a of jobs) {
        const key = opKey(a);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(a);
      }
      for (const group of groups.values()) group.sort(bySeq);
      for (const group of groups.values()) {
        const gh = el('div', 'mf-group');
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
    if (!shownAny) box.appendChild(el('div', 'mf-note', 'No machine matches that.'));
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
    if (canMove && group.length > 1) {
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
    if (a.cutSec) meta.push(fmtSec(a.cutSec) + ' cut');
    if (a.indexEdges) meta.push(a.indexEdges + ' edges');
    if (a.partsPerIndex) meta.push(a.partsPerIndex + ' parts/index');
    if (meta.length) card.appendChild(el('div', 'mf-card-meta', meta.join(' · ')));

    const foot = el('div', 'mf-card-foot');
    const life = lifeFor(a, s ? s.avg : 0);
    foot.appendChild(el('span', null,
      (s ? s.count + (s.count === 1 ? ' cycle' : ' cycles') : 'not timed yet') +
      (life ? ' · index every ' + life.parts + ' parts' : '')));
    foot.appendChild(button('mf-link', 'Setup', e => { e.stopPropagation(); openForm('assignment', a.id); },
      'The operation, cutting time, edges and tool life of this tool here'));
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
    const order = opJobs(a);
    const from = order.indexOf(a);
    if (to < 0 || to >= order.length || to === from) return;
    order.splice(to, 0, ...order.splice(from, 1));
    order.forEach((x, i) => { x.seq = i + 1; touch(x); });
    save();
    renderChart();
    renderMachines();
  }

  function renderTools() {
    const box = els.tools;
    box.innerHTML = '';
    if (!shop) return;

    box.appendChild(sectionHead('sec:tools', 'Tools', shop.tools.length, renderTools,
      button('mf-btn mf-btn-sm', '+ Tool', () => openForm('tool'))));
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
          const label = machineName(a.machineId) + (a.station ? ' · ' + a.station : '');
          tags.appendChild(button('mf-tag' + (a.id === shop.activeId ? ' mf-tag-on' : ''), label,
            () => selectJob(a.id),
            [jobLabel(a), a.cutSec ? fmtSec(a.cutSec) + ' in cut' : '',
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
      foot.appendChild(button('mf-link', 'Edit', () => openForm('tool', t.id)));
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
     and operation it joins plus the station it sits in. Re-importing the same
     file changes nothing, because a cycle is recognized by when it was recorded
     and how long it took.
  ---------------------------------------------------------------- */
  // Each record that can carry notes has its own notes column, so none can
  // swallow another's and a file that came out of here goes back in whole.
  const IMPORT_COLUMNS = [
    'machine', 'machine_notes',
    'part', 'part_description', 'part_notes', 'op', 'op_notes',
    'seq', 'station',
    'tool_part_number', 'tool_description', 'cutting_edges', 'tool_cost', 'tool_notes',
    'cutting_time_sec', 'indexable_edges', 'parts_per_index',
    'notes', 'cycle_seconds', 'recorded_at',
  ];
  const DERIVED_COLUMNS = ['cycles_timed', 'average_seconds', 'parts_per_tool'];
  // header name (normalized) → the field it fills. The export's own names, the
  // shorter ones a person is likely to type, and the ones earlier versions of
  // this add-on wrote, so a file exported before any of this still reads.
  const COLUMN_ALIASES = {
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
    cutting_time_sec: 'cutSec', cutting_time: 'cutSec', cut_time: 'cutSec', cut_sec: 'cutSec',
    parts_per_index: 'partsPerIndex', parts_between_indexes: 'partsPerIndex',
    tool_life_parts: 'partsPerIndex', parts_per_edge: 'partsPerIndex',
    tool_life_min_per_edge: 'lifeMin', tool_life: 'lifeMin', tool_life_min: 'lifeMin', life_min: 'lifeMin',
    tool_cost: 'cost', insert_cost: 'cost', cost: 'cost',
    notes: 'notes', note: 'notes',
    cycle_seconds: 'sec', cycle_sec: 'sec', seconds: 'sec', cycle_time: 'sec',
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
        if (!machines.has(machineKey)) machines.set(machineKey, { name: machineName, notes: '' });
        if (cell.machineNotes) machines.get(machineKey).notes = cell.machineNotes;
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
        links.set(key, { key, machineKey, toolKey, operationKey, fields: {}, runs: [], lifeMin: 0 });
      }
      const link = links.get(key);
      for (const f of ['station', 'notes']) {
        if (cell[f]) link.fields[f] = cell[f];
      }
      for (const f of JOB_NUMERIC) {
        if (!cell[f]) continue;
        const n = readNumber(cell[f]);
        if (n) link.fields[f] = Math.floor(n);
      }
      if (cell.cutSec) {
        const cut = parseTime(cell.cutSec) || readNumber(cell.cutSec);
        if (cut) link.fields.cutSec = round(cut, 3);
      }
      if (cell.lifeMin) link.lifeMin = readNumber(cell.lifeMin) || link.lifeMin;

      if (cell.sec) {
        const sec = parseTime(cell.sec) || readNumber(cell.sec);
        if (sec > 0) {
          let at = cell.at ? Date.parse(cell.at) : NaN;
          if (!Number.isFinite(at)) { if (cell.at) badTimes++; at = Date.now(); }
          link.runs.push({ sec: round(sec, 2), at: Math.min(at, Date.now()) });
        } else badSecs++;
      }
    }

    // Version 1 files carry tool life as cutting minutes per edge. In parts,
    // that is the life divided by the time one part takes — the cutting time if
    // the file gives one, and otherwise the cycles in the file itself, which is
    // the same division version 1 did on screen. With neither, there is nothing
    // to divide by and the figure is left out rather than guessed at.
    for (const link of links.values()) {
      if (link.fields.partsPerIndex || !link.lifeMin) continue;
      const base = link.fields.cutSec ||
        (link.runs.length ? link.runs.reduce((sum, r) => sum + r.sec, 0) / link.runs.length : 0);
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
      machines: [...machines.entries()].map(([key, m]) => ({ key, name: m.name, notes: m.notes })),
      tools: [...tools.values()],
      links: [...links.values()],
      dataRows, skipped, badTimes, badSecs, converted, unconverted,
    };
  }

  // Work out exactly what an import would do, before it does any of it. The
  // preview and the import itself both read this, so what is shown is what runs.
  function planImport(read) {
    const plan = {
      parts: [], operations: [], machines: [], tools: [], add: [], update: [],
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
      if (machineByKey.has(m.key)) continue;
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
        plan.update.push({ job: match, fields: link.fields, runs: fresh });
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
    for (const m of plan.machines) {
      const machine = { id: newId('m'), name: m.name, notes: m.notes || '', createdAt: now, updatedAt: now };
      shop.machines.push(machine);
      machineByKey.set(m.key, machine);
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
    for (const u of plan.update) {
      Object.assign(u.job, u.fields);
      u.job.runs = [...u.runs, ...u.job.runs].sort((a, b) => b.at - a.at).slice(0, limits.maxRuns);
      touch(u.job);
      touched.add(opKey(u.job));
    }
    for (const a of plan.add) {
      const machine = machineByKey.get(a.link.machineKey);
      const tool = toolByKey.get(a.link.toolKey);
      if (!machine || !tool) continue;
      const operation = a.link.operationKey ? opByKey.get(a.link.operationKey) : null;
      const job = {
        id: newId('a'), toolId: tool.id, machineId: machine.id,
        operationId: operation ? operation.id : '',
        station: '', seq: 0, cutSec: 0, indexEdges: 0, partsPerIndex: 0, notes: '',
        ...a.link.fields,
        runs: a.runs.sort((x, y) => y.at - x.at).slice(0, limits.maxRuns),
        createdAt: now, updatedAt: now,
      };
      // a tool set up without saying how many edges are indexed there uses
      // every edge the tool has
      if (!job.indexEdges && tool.cuttingEdges) job.indexEdges = tool.cuttingEdges;
      shop.assignments.push(job);
      touched.add(opKey(job));
    }
    for (const key of touched) renumberOp(key);
    for (const p of shop.parts) renumberPart(p.id);
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
      ' in minutes had no cutting time or cycle to convert against, and ' +
      (read.unconverted === 1 ? 'was' : 'were') + ' left out.');
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
        job.plan.newRuns + ' cycles added.');
    }, nothing ? 'There is nothing in this file to add' : ''));
    btns.appendChild(button('mf-btn mf-btn-quiet', 'Cancel', () => { pendingImport = null; renderImport(); }));
    if (nothing) btns.firstChild.disabled = true;
    box.appendChild(btns);
    box.scrollIntoView({ block: 'nearest' });
  }

  async function chooseImport(file) {
    if (!file || !shop) return;
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
    pendingImport = { read, plan: planImport(read), name: file.name || 'the file' };
    renderImport();
  }

  /* ---------------- export ---------------- */
  // One row per recorded cycle, carrying the part, the operation, the machine,
  // the tool and the setup between them, so the file can be pivoted in a
  // spreadsheet without going back to the app. A setup with nothing timed still
  // gets its row, and so do a part with no operations, an operation with no
  // tools, a tool in the crib and a machine with nothing on it.
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
      return m ? { machine: m.name, machine_notes: m.notes } : {};
    };
    const partCells = p => (p ? { part: p.number, part_description: p.desc, part_notes: p.notes } : {});
    const opCells = o => (o ? { ...partCells(partById(o.partId)), op: o.name, op_notes: o.notes } : {});
    const toolCells = t => (t ? {
      tool_part_number: t.partNumber, tool_description: t.desc,
      cutting_edges: t.cuttingEdges || '', tool_cost: t.cost || '', tool_notes: t.notes,
    } : {});

    // in running order, machine by machine and op by op, so the file opens the
    // way the floor runs
    const jobs = [...shop.assignments].sort((a, b) =>
      opLabel(a).localeCompare(opLabel(b)) || bySeq(a, b));
    for (const a of jobs) {
      const s = statsFor(a);
      const life = lifeFor(a, s ? s.avg : 0);
      const base = {
        ...machineCells(a.machineId),
        ...opCells(jobOperation(a)),
        ...toolCells(jobTool(a)),
        seq: a.seq || '', station: a.station,
        cutting_time_sec: a.cutSec || '', indexable_edges: a.indexEdges || '',
        parts_per_index: a.partsPerIndex || '', notes: a.notes,
        cycles_timed: s ? s.count : 0,
        average_seconds: s ? round(s.avg, 2) : '',
        parts_per_tool: life ? life.partsPerTool || '' : '',
      };
      if (!a.runs.length) { push(base); continue; }
      for (const r of a.runs) {
        push({ ...base, cycle_seconds: round(r.sec, 2), recorded_at: new Date(r.at).toISOString() });
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

  /* ---------------- keyboard ---------------- */
  // Hands are usually on the machine rather than the keyboard, but a laptop at
  // the bench gets the three keys that matter. Ignored while typing, and while
  // this screen is not the one on show.
  function onKey(e) {
    if (!host || host.hidden || form) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const tag = e.target && e.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'BUTTON') return;
    if (e.key === ' ') { e.preventDefault(); startStop(); return; }
    if (e.key === 'l' || e.key === 'L') { e.preventDefault(); lap(); return; }
    if (e.key === 'r' || e.key === 'R') { e.preventDefault(); reset(); }
  }

  /* ---------------- the shell's hooks ---------------- */
  function mount(section, context) {
    ctx = context;
    host = section;
    host.classList.add('mf-root');

    const page = el('div', 'mf-page');

    const top = el('div', 'mf-top');
    const heading = el('div');
    heading.appendChild(el('h1', 'mf-h1', 'Shopwatch'));
    heading.appendChild(el('div', 'mf-sub', 'Cycle times, tool by tool, op by op'));
    top.appendChild(heading);
    const actions = el('div', 'mf-top-btns');
    actions.appendChild(button('mf-btn mf-btn-sm', '+ Part', () => openForm('part')));
    actions.appendChild(button('mf-btn mf-btn-sm', '+ Machine', () => openForm('machine')));
    actions.appendChild(button('mf-btn mf-btn-sm', '+ Tool', () => openForm('tool')));
    actions.appendChild(button('mf-btn mf-btn-sm', '+ Setup', () => openForm('assignment'),
      'Put a tool from the crib on a machine, for an operation'));
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
    actions.appendChild(button('mf-btn mf-btn-sm', '⤒ Import', () => file.click(),
      'Read a spreadsheet of tooling back in — the columns ⤓ Export writes'));
    actions.appendChild(button('mf-btn mf-btn-sm', '⤓ Export', exportCsv, 'Download the whole shop record as a spreadsheet'));
    actions.appendChild(file);
    top.appendChild(actions);
    page.appendChild(top);

    els.flash = el('div', 'mf-flash');
    els.flash.hidden = true;
    page.appendChild(els.flash);

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
    page.appendChild(els.search);
    page.appendChild(els.parts);
    page.appendChild(els.machines);
    page.appendChild(els.tools);
    host.appendChild(page);

    document.addEventListener('keydown', onKey);
    restoreWatch();
    restoreFolded();
    render(); // the loading state; open() runs straight after this and fetches
  }

  // Coming back to the screen: the record may have moved on another device, and
  // #/p/manufacturing/t/<id> points the watch at a particular setup.
  function open(sub) {
    startTick();
    const pick = String(sub || '').match(/^[ta]\/([A-Za-z0-9]{1,24})$/);
    if (pick) pendingPick = pick[1];
    // An unsaved edit outranks a refetch — never pull the record out from under
    // a time somebody just measured.
    if (shop && dirty) { render(); return; }
    load();
  }

  function leave() {
    stopTick(); // the watch keeps time off the clock; only the display stops
    flush();
  }

  window.MindMapPlugins.register({ id: ID, mount, open, leave });
})();
