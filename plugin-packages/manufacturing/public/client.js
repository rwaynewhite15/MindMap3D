'use strict';

/* ================================================================
   Manufacturing add-on — the Shop screen

   A stopwatch for timing cycles at the machine, and the tool records the
   times belong to: part, machine, op, station, insert, indexes per insert,
   inserts per op, expected tool life. Time enough cycles against a tool and
   the record answers the questions that actually matter on the floor — how
   many parts an edge lasts, how often to index, how many inserts a hundred
   parts costs.

   Everything here lives inside the section the shell hands to mount(). The
   only way out of it is ctx: ctx.api for this add-on's own routes, ctx.me for
   who is signed in, ctx.go to move around inside this screen.
================================================================ */
(function () {
  const ID = 'manufacturing';

  /* ---------------- state ---------------- */
  let ctx = null;
  let host = null;          // the <section> the shell gave us
  let shop = null;          // { tools, activeId, updatedAt }
  let limits = { maxTools: 200, maxRuns: 300 };
  let dirty = false;
  let saveTimer = null;
  let flashTimer = null;
  let filter = '';
  let form = null;          // the tool being added or edited, as a draft
  let formError = '';
  let pendingTool = '';     // a tool named by the URL, waiting on the record to load
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

  /* ---------------- the record ---------------- */
  const activeTool = () => (shop ? shop.tools.find(t => t.id === shop.activeId) || null : null);

  // Where a tool runs, as one line: the grouping every number below is per.
  const opLabel = t => [t.part, t.machine, t.op].filter(Boolean).join(' · ') || 'Unassigned';
  const toolLabel = t => t.desc || t.station || t.insert || 'Tool';

  // Running order within an op. A tool with no sequence yet sorts after the ones
  // that have one, oldest first, so an unplaced tool lands at the end of the list
  // rather than jumping to the front of the job.
  function bySeq(a, b) {
    const as = a.seq || Infinity, bs = b.seq || Infinity;
    if (as !== bs) return as - bs;
    return (a.createdAt || 0) - (b.createdAt || 0);
  }

  // Every tool on the same part/machine/op, in the order they run.
  const opTools = t => (t && shop ? shop.tools.filter(x => opLabel(x) === opLabel(t)).sort(bySeq) : []);

  // Close up the numbering of an op after a move or a deletion, so the sequence
  // is always 1..n with no gaps and no ties.
  function renumberOp(label) {
    shop.tools.filter(x => opLabel(x) === label).sort(bySeq).forEach((t, i) => {
      if (t.seq !== i + 1) { t.seq = i + 1; touch(t); }
    });
  }

  function statsFor(t) {
    const runs = (t && t.runs) || [];
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

  // What the timed cycle says about tool life. Every figure here is per
  // cutting edge first, because that is what wears: an insert with four
  // indexes is four edges, and a tool holding three inserts burns three edges
  // at once. Returns null until there is both a measured cycle and a life to
  // measure it against.
  function lifeFor(t, avgSec) {
    if (!avgSec || !t.lifeMin) return null;
    const partsPerEdge = Math.floor((t.lifeMin * 60) / avgSec);
    const indexes = t.indexes || 0;
    const inserts = t.insertsPerOp || 0;
    const partsPerInsert = indexes ? partsPerEdge * indexes : 0;
    return {
      partsPerEdge,
      partsPerInsert,
      // inserts consumed per hundred parts, at this cycle time
      per100: partsPerInsert && inserts ? (inserts * 100) / partsPerInsert : 0,
      // one edge covers partsPerEdge parts, and the tool spends one edge on
      // each of its inserts over that same run
      costPart: partsPerEdge && indexes && inserts && t.insertCost
        ? (inserts * (t.insertCost / indexes)) / partsPerEdge : 0,
    };
  }

  /* ---------------- loading & saving ---------------- */
  async function load() {
    try {
      const data = await ctx.api('/');
      shop = data.shop;
      limits = data.limits || limits;
    } catch (err) {
      shop = shop || { tools: [], activeId: '', updatedAt: 0 };
      flash('Your tool records could not be loaded (' + err.message + ').');
    }
    // a link that named a tool arrived before the tools did
    if (pendingTool) {
      const id = pendingTool;
      pendingTool = '';
      if (shop.tools.some(t => t.id === id)) { selectTool(id); return; }
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

  function touch(t) {
    t.updatedAt = Date.now();
  }

  /* ---------------- stopwatch ---------------- */
  function startStop() {
    if (!activeTool()) { flash('Pick a tool first — a cycle time belongs to one.'); return; }
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
    const t = activeTool();
    if (!t) { flash('Pick a tool first — a cycle time belongs to one.'); return; }
    if (!watch.running && !watch.accum) { flash('Start the watch, then mark each cycle as it finishes.'); return; }
    const now = elapsed();
    const cycle = (now - watch.lastLap) / 1000;
    if (cycle < 0.2) return; // a double-tap is not a cycle
    watch.lastLap = now;
    watch.laps += 1;
    saveWatch();
    addRun(t, round(cycle, 2));
    renderWatch();
  }

  function reset() {
    watch = { running: false, since: 0, accum: 0, lastLap: 0, laps: 0 };
    saveWatch();
    stopTick();
    renderWatch();
  }

  function addRun(t, sec, at) {
    if (!sec) return;
    t.runs.unshift({ id: 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8), sec, at: at || Date.now(), note: '' });
    if (t.runs.length > limits.maxRuns) t.runs.length = limits.maxRuns;
    touch(t);
    saveNow();
    renderStats();
    renderRuns();
    renderChart(); // this tool's share of the op just moved
    renderTools(); // as did its average, on its card
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
    renderTools();
  }

  function renderWatch() {
    const box = els.watch;
    box.innerHTML = '';
    if (!shop) { box.appendChild(el('div', 'mf-loading', 'Loading your tools…')); return; }
    const t = activeTool();

    if (!t) {
      const empty = el('div', 'mf-empty');
      empty.appendChild(el('div', 'mf-empty-title', shop.tools.length ? 'Pick a tool to time' : 'Add the first tool'));
      empty.appendChild(el('div', 'mf-empty-text', shop.tools.length
        ? 'Every cycle time is recorded against one tool, so choose the one at the spindle before you start the watch.'
        : 'A tool is a part, a machine, an op and what is cutting — the stopwatch records against it, and the tool-life numbers come out of it.'));
      if (!shop.tools.length) empty.appendChild(button('mf-btn mf-btn-go', '+ Add a tool', () => openForm(null)));
      box.appendChild(empty);
      return;
    }

    box.classList.toggle('mf-running', watch.running);

    // which tool the watch is pointed at, and how to change it
    const head = el('div', 'mf-watch-head');
    const who = el('div', 'mf-watch-who');
    const title = el('div', 'mf-watch-title');
    if (t.seq) title.appendChild(el('span', 'mf-seq', String(t.seq)));
    if (t.station) title.appendChild(el('span', 'mf-chip', t.station));
    title.appendChild(el('span', 'mf-watch-name', toolLabel(t)));
    who.appendChild(title);
    const where = el('div', 'mf-watch-op', opLabel(t));
    // where in the op's running order this tool sits
    const order = opTools(t);
    if (t.seq && order.length > 1) where.textContent += ' · tool ' + t.seq + ' of ' + order.length;
    who.appendChild(where);
    head.appendChild(who);
    head.appendChild(button('mf-btn mf-btn-sm', 'Edit tool', () => openForm(t.id)));
    box.appendChild(head);

    els.time = el('div', 'mf-time', fmtClock(elapsed()));
    box.appendChild(els.time);

    const line = el('div', 'mf-lapline');
    const last = t.runs.length ? t.runs[0] : null;
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

    if (shop.tools.length > 1) {
      const pick = el('select', 'mf-pick');
      pick.setAttribute('aria-label', 'Tool being timed');
      for (const other of shop.tools) {
        const o = el('option', null, toolLabel(other) + ' — ' + opLabel(other));
        o.value = other.id;
        if (other.id === t.id) o.selected = true;
        pick.appendChild(o);
      }
      pick.addEventListener('change', () => selectTool(pick.value));
      box.appendChild(pick);
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
    const t = activeTool();
    if (!t) return;
    const s = statsFor(t);
    if (!s) {
      box.appendChild(el('div', 'mf-note', 'Time a few cycles and the averages, the parts per edge and the insert usage all fall out of them.'));
      return;
    }

    const timing = el('div', 'mf-tiles');
    timing.appendChild(tile('cycles timed', String(s.count)));
    timing.appendChild(tile('average', fmtSec(s.avg)));
    timing.appendChild(tile('best', fmtSec(s.best)));
    timing.appendChild(tile('spread', fmtSec(s.spread), 'Slowest cycle minus fastest — how repeatable the op is'));
    box.appendChild(timing);

    const life = lifeFor(t, s.avg);
    if (!life) {
      const missing = [];
      if (!t.lifeMin) missing.push('expected tool life');
      if (!t.indexes) missing.push('indexes per insert');
      if (!t.insertsPerOp) missing.push('inserts per op');
      if (missing.length) {
        const note = el('div', 'mf-note');
        note.appendChild(document.createTextNode('Add ' + missing.join(', ') + ' to this tool and the tool-life numbers appear here. '));
        const link = button('mf-link', 'Edit tool', () => openForm(t.id));
        note.appendChild(link);
        box.appendChild(note);
      }
      return;
    }

    const derived = el('div', 'mf-tiles mf-tiles-life');
    if (!life.partsPerEdge) {
      derived.appendChild(tile('parts per edge', '—', 'One edge does not last a whole part at this cycle time'));
    } else {
      derived.appendChild(tile('parts per edge', String(life.partsPerEdge),
        'Cutting minutes per edge ÷ measured cycle — index this tool every ' + life.partsPerEdge + ' parts'));
      if (life.partsPerInsert) {
        derived.appendChild(tile('parts per insert', String(life.partsPerInsert),
          t.indexes + ' indexes × ' + life.partsPerEdge + ' parts per edge'));
      }
      if (life.per100) {
        derived.appendChild(tile('inserts / 100 parts', String(round(life.per100, 2)),
          t.insertsPerOp + ' in the tool, each good for ' + life.partsPerInsert + ' parts'));
      }
      if (life.costPart) {
        derived.appendChild(tile('insert cost / part', round(life.costPart, 3).toFixed(3),
          'One edge of each of the ' + t.insertsPerOp + ' inserts, spread over ' + life.partsPerEdge + ' parts'));
      }
    }
    box.appendChild(derived);

    if (life.partsPerEdge) {
      box.appendChild(el('div', 'mf-note',
        'At ' + fmtSec(s.avg) + ' a cycle, ' + t.lifeMin + ' min of edge life is ' + life.partsPerEdge +
        ' parts — index at ' + life.partsPerEdge + ', change the set at ' + (life.partsPerInsert || life.partsPerEdge) + '.'));
    }
  }

  /* ---------------- the op cycle chart ---------------- */
  // The tools of an op are an ordered set — tool 1 cuts before tool 2 — so the
  // segments take a one-hue ramp stepped light→dark along the running order,
  // not eight unrelated colors. Reading left to right you see the order in the
  // color itself. The steps are interpolated in OKLab between the app's palest
  // and deepest cyan and checked against the dark chart surface (#141926):
  // monotone lightness, every adjacent gap ≥ 0.06 L, one hue, and the darkest
  // step still clearing the surface at 2.55:1.
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
    const active = activeTool();
    if (!active) { box.hidden = true; return; }

    const tools = opTools(active);
    const rows = tools.map((t, i) => {
      const s = statsFor(t);
      return { t, i, avg: s ? s.avg : 0, count: s ? s.count : 0, step: rampStep(i, tools.length) };
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
        seg.dataset.tool = r.t.id;
        seg.tabIndex = 0;
        if (n === timed.length - 1) seg.classList.add('mf-seg-end');
        seg.title = (r.t.seq ? r.t.seq + '. ' : '') + toolLabel(r.t) +
          ' — ' + fmtSec(r.avg) + ', ' + Math.round(share * 100) + '% of the cycle';
        // A number only goes inside a segment wide enough to hold it; the rest
        // are read off the table, which lists every one of them.
        if (share >= 0.07 && r.t.seq) seg.appendChild(el('span', 'mf-seg-n', String(r.t.seq)));
        bar.appendChild(seg);
      });
      box.appendChild(bar);
    }

    // The table is the legend and the accessible twin of the bar in one: every
    // segment's identity, its measured average, and its share, as text.
    const table = el('div', 'mf-legend');
    for (const r of rows) {
      const row = el('div', 'mf-legend-row' + (r.avg ? '' : ' mf-legend-off'));
      row.dataset.tool = r.t.id;
      const swatch = el('span', 'mf-swatch');
      if (r.avg) swatch.style.background = r.step.fill;
      row.appendChild(swatch);
      row.appendChild(el('span', 'mf-legend-n', r.t.seq ? String(r.t.seq) : '–'));
      const name = el('span', 'mf-legend-name');
      if (r.t.station) name.appendChild(el('span', 'mf-chip mf-chip-sm', r.t.station));
      name.appendChild(document.createTextNode(toolLabel(r.t)));
      row.appendChild(name);
      row.appendChild(el('span', 'mf-legend-v', r.avg ? fmtSec(r.avg) : '—'));
      row.appendChild(el('span', 'mf-legend-p', r.avg ? Math.round((r.avg / total) * 100) + '%' : 'not timed'));
      row.addEventListener('click', () => selectTool(r.t.id));
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
    const t = activeTool();
    if (!t) return;

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
      addRun(t, round(sec, 2));
    };
    input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); commit(); } });
    add.appendChild(input);
    add.appendChild(button('mf-btn mf-btn-sm', 'Add', commit, 'Record a time measured somewhere else'));
    head.appendChild(add);
    box.appendChild(head);

    if (!t.runs.length) {
      box.appendChild(el('div', 'mf-note', 'Nothing timed against this tool yet.'));
      return;
    }

    const list = el('div', 'mf-runs-list');
    t.runs.forEach((r, i) => {
      const row = el('div', 'mf-run');
      row.appendChild(el('div', 'mf-run-n', '#' + (t.runs.length - i)));
      row.appendChild(el('div', 'mf-run-t', fmtSec(r.sec)));
      row.appendChild(el('div', 'mf-run-at', fmtAgo(r.at)));
      row.appendChild(button('mf-x', '✕', () => {
        t.runs = t.runs.filter(x => x.id !== r.id);
        touch(t);
        save();
        renderStats();
        renderRuns();
      }, 'Delete this cycle'));
      list.appendChild(row);
    });
    box.appendChild(list);
  }

  /* ---------------- the tool form ---------------- */
  const FIELDS = [
    { key: 'part', label: 'Part', placeholder: 'Part number', wide: true },
    { key: 'machine', label: 'Machine', placeholder: 'Machine name or number' },
    { key: 'op', label: 'Op', placeholder: 'Op 20' },
    { key: 'seq', label: 'Seq', placeholder: '1', num: true, hint: 'Where it falls in the op — 1 cuts first' },
    { key: 'station', label: 'Station', placeholder: 'T0303' },
    { key: 'desc', label: 'Tool', placeholder: '80° CNMG rougher', wide: true },
    { key: 'insert', label: 'Insert', placeholder: 'CNMG432-MP', wide: true },
    { key: 'indexes', label: 'Indexes per insert', placeholder: '4', num: true, hint: 'Usable cutting edges on one insert' },
    { key: 'insertsPerOp', label: 'Inserts per op', placeholder: '1', num: true, hint: 'Inserts mounted in this tool' },
    { key: 'lifeMin', label: 'Tool life (min per edge)', placeholder: '15', num: true, hint: 'Cutting minutes one edge is expected to last' },
    { key: 'insertCost', label: 'Insert cost', placeholder: '9.40', num: true, hint: 'Optional — what one insert costs, for cost per part' },
  ];

  function openForm(id) {
    if (!shop) return; // still loading; there is nothing to add a tool to yet
    const t = id ? shop.tools.find(x => x.id === id) : null;
    form = t ? { ...t, runs: undefined } : {
      id: '', part: '', machine: '', op: '', station: '', seq: '', desc: '', insert: '',
      indexes: '', insertsPerOp: '', lifeMin: '', insertCost: '', notes: '',
    };
    // Carry the last tool's op over to a new one: tools are added a few at a
    // time for the same job, and retyping the part number each time is noise.
    // The sequence follows on from that op's last tool, since tools are usually
    // entered in the order they cut.
    if (!t) {
      const from = activeTool() || shop.tools[shop.tools.length - 1];
      if (from) {
        form.part = from.part; form.machine = from.machine; form.op = from.op;
        form.seq = String(opTools(from).reduce((max, x) => Math.max(max, x.seq || 0), 0) + 1);
      } else {
        form.seq = '1';
      }
    }
    formError = '';
    renderForm();
    const first = els.form.querySelector('input, textarea');
    if (first) first.focus();
    els.form.scrollIntoView({ block: 'nearest' });
  }

  function closeForm() {
    form = null;
    formError = '';
    renderForm();
  }

  function saveForm() {
    const draft = form;
    const clean = v => String(v == null ? '' : v).trim();
    const numeric = v => {
      const n = Number(clean(v));
      return Number.isFinite(n) && n > 0 ? n : 0;
    };
    const tool = {
      id: draft.id || 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
      part: clean(draft.part), machine: clean(draft.machine), op: clean(draft.op),
      station: clean(draft.station), desc: clean(draft.desc), insert: clean(draft.insert),
      seq: Math.floor(numeric(draft.seq)),
      indexes: Math.floor(numeric(draft.indexes)),
      insertsPerOp: Math.floor(numeric(draft.insertsPerOp)),
      lifeMin: numeric(draft.lifeMin),
      insertCost: numeric(draft.insertCost),
      notes: clean(draft.notes).slice(0, 400),
    };
    if (!tool.part && !tool.machine && !tool.op && !tool.station && !tool.desc) {
      formError = 'Give the tool something to be known by — a part, a machine, an op, a station or a description.';
      renderForm();
      return;
    }
    const existing = shop.tools.find(t => t.id === tool.id);
    if (existing) {
      const movedOp = opLabel(existing);
      Object.assign(existing, tool);
      touch(existing);
      // Editing can move a tool to another op or renumber it; close up the gap
      // it left behind as well as the order it joined.
      renumberOp(movedOp);
      if (opLabel(existing) !== movedOp) renumberOp(opLabel(existing));
    } else {
      if (shop.tools.length >= limits.maxTools) {
        formError = 'That is as many tools as one account keeps (' + limits.maxTools + ').';
        renderForm();
        return;
      }
      tool.runs = [];
      tool.createdAt = Date.now();
      tool.updatedAt = tool.createdAt;
      shop.tools.push(tool);
      renumberOp(opLabel(tool));
      setActive(tool.id); // a tool added mid-shift is the one being timed next
    }
    form = null;
    formError = '';
    save();
    render();
  }

  function deleteTool(id) {
    const t = shop.tools.find(x => x.id === id);
    if (!t) return;
    const runs = t.runs.length;
    const warn = runs
      ? 'Delete ' + toolLabel(t) + ' and the ' + runs + (runs === 1 ? ' cycle' : ' cycles') + ' timed against it?'
      : 'Delete ' + toolLabel(t) + '?';
    if (!confirm(warn)) return;
    const wasActive = shop.activeId === id;
    const from = opLabel(t);
    shop.tools = shop.tools.filter(x => x.id !== id);
    renumberOp(from); // the op runs one tool shorter now; close the gap
    if (wasActive) setActive(shop.tools.length ? shop.tools[0].id : '');
    form = null;
    save();
    render();
  }

  function renderForm() {
    const box = els.form;
    box.innerHTML = '';
    box.hidden = !form;
    if (!form) return;

    box.appendChild(el('div', 'mf-section-title', form.id ? 'Edit tool' : 'New tool'));
    const grid = el('div', 'mf-grid');
    for (const f of FIELDS) {
      const wrap = el('label', 'mf-field' + (f.wide ? ' mf-field-wide' : ''));
      wrap.appendChild(el('span', 'mf-field-k', f.label));
      const input = el('input', 'mf-input');
      input.value = form[f.key] == null ? '' : String(form[f.key]);
      input.placeholder = f.placeholder || '';
      if (f.num) { input.inputMode = 'decimal'; input.autocomplete = 'off'; }
      if (f.hint) input.title = f.hint;
      input.addEventListener('input', () => { form[f.key] = input.value; });
      wrap.appendChild(input);
      if (f.hint) wrap.appendChild(el('span', 'mf-field-hint', f.hint));
      grid.appendChild(wrap);
    }
    const notes = el('label', 'mf-field mf-field-wide');
    notes.appendChild(el('span', 'mf-field-k', 'Notes'));
    const area = el('textarea', 'mf-input mf-area');
    area.value = form.notes || '';
    area.rows = 2;
    area.placeholder = 'Speeds and feeds, what it sounds like when it is dull, anything worth the next setup knowing';
    area.addEventListener('input', () => { form.notes = area.value; });
    notes.appendChild(area);
    grid.appendChild(notes);
    box.appendChild(grid);

    if (formError) box.appendChild(el('div', 'mf-error', formError));

    const row = el('div', 'mf-form-btns');
    row.appendChild(button('mf-btn mf-btn-go', 'Save tool', saveForm));
    row.appendChild(button('mf-btn mf-btn-quiet', 'Cancel', closeForm));
    if (form.id) row.appendChild(button('mf-btn mf-btn-danger', 'Delete tool', () => deleteTool(form.id)));
    box.appendChild(row);
  }

  /* ---------------- the tool list ---------------- */
  // Pointing the watch at a different tool. The time on the display belonged to
  // the tool that just left, and its cycles are already recorded against it, so
  // the watch starts the new tool from zero. Returns false if nothing moved.
  function setActive(id) {
    if (!shop || shop.activeId === id) return false;
    shop.activeId = id;
    reset();
    return true;
  }

  function selectTool(id) {
    if (!setActive(id)) return;
    save();
    render();
  }

  function matches(t) {
    if (!filter) return true;
    const hay = [t.part, t.machine, t.op, t.station, t.desc, t.insert, t.notes].join(' ').toLowerCase();
    return hay.includes(filter);
  }

  function renderTools() {
    const box = els.tools;
    // the list is rebuilt as the filter is typed, so note where the caret was
    const active = document.activeElement;
    const hadSearch = !!(active && active.classList && active.classList.contains('mf-search'));
    const caret = hadSearch ? active.selectionStart : 0;
    box.innerHTML = '';
    if (!shop) return;

    const head = el('div', 'mf-section-head');
    head.appendChild(el('div', 'mf-section-title', 'Tools'));
    head.appendChild(button('mf-btn mf-btn-sm', '+ Tool', () => openForm(null)));
    box.appendChild(head);

    if (shop.tools.length > 3) {
      const search = el('input', 'mf-input mf-search');
      search.type = 'search';
      search.placeholder = 'Filter by part, machine, op, insert…';
      search.value = filter;
      search.addEventListener('input', () => { filter = search.value.trim().toLowerCase(); renderTools(); });
      box.appendChild(search);
      if (hadSearch) { search.focus(); search.setSelectionRange(caret, caret); }
    }

    const shown = shop.tools.filter(matches);
    if (!shown.length) {
      box.appendChild(el('div', 'mf-note', shop.tools.length ? 'No tool matches that.' : 'No tools yet.'));
      return;
    }

    // Grouped by the job they belong to — part, machine and op together — each
    // group in the order its tools cut, with the op's whole measured cycle
    // across them on the heading.
    const groups = new Map();
    for (const t of shown) {
      const key = opLabel(t);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(t);
    }
    for (const tools of groups.values()) tools.sort(bySeq);
    for (const [label, tools] of groups) {
      const gh = el('div', 'mf-group');
      gh.appendChild(el('div', 'mf-group-k', label));
      let total = 0, timed = 0;
      for (const t of tools) {
        const s = statsFor(t);
        if (s) { total += s.avg; timed++; }
      }
      if (timed) {
        gh.appendChild(el('div', 'mf-group-v', fmtSec(total) + ' over ' + timed +
          (timed === 1 ? ' timed tool' : ' timed tools')));
      }
      box.appendChild(gh);

      // Reordering is only offered on the unfiltered list: moving a tool past a
      // neighbour that a filter is hiding would not do what it looks like.
      const canMove = !filter;
      tools.forEach((t, pos) => {
        const card = el('div', 'mf-card' + (t.id === shop.activeId ? ' mf-card-on' : ''));
        card.tabIndex = 0;
        card.setAttribute('role', 'button');

        const top = el('div', 'mf-card-top');
        top.appendChild(el('span', 'mf-seq', t.seq ? String(t.seq) : '–'));
        if (t.station) top.appendChild(el('span', 'mf-chip', t.station));
        top.appendChild(el('span', 'mf-card-name', toolLabel(t)));
        const s = statsFor(t);
        if (s) top.appendChild(el('span', 'mf-card-avg', fmtSec(s.avg)));
        if (canMove && tools.length > 1) {
          const moves = el('span', 'mf-moves');
          const move = (label, to, enabled, title) => {
            const b = button('mf-move', label, e => { e.stopPropagation(); moveTool(t.id, to); }, title);
            b.disabled = !enabled;
            moves.appendChild(b);
          };
          move('↑', pos - 1, pos > 0, 'Run this tool earlier in the op');
          move('↓', pos + 1, pos < tools.length - 1, 'Run this tool later in the op');
          top.appendChild(moves);
        }
        card.appendChild(top);

        const meta = [];
        if (t.insert) meta.push(t.insert);
        if (t.indexes) meta.push(t.indexes + '× index');
        if (t.insertsPerOp) meta.push(t.insertsPerOp + ' per op');
        if (t.lifeMin) meta.push(t.lifeMin + ' min life');
        if (meta.length) card.appendChild(el('div', 'mf-card-meta', meta.join(' · ')));

        const foot = el('div', 'mf-card-foot');
        if (s) {
          const life = lifeFor(t, s.avg);
          foot.appendChild(el('span', null, s.count + (s.count === 1 ? ' cycle' : ' cycles') +
            (life && life.partsPerEdge ? ' · index every ' + life.partsPerEdge + ' parts' : '')));
        } else {
          foot.appendChild(el('span', null, 'not timed yet'));
        }
        const edit = button('mf-link', 'Edit', e => { e.stopPropagation(); openForm(t.id); });
        foot.appendChild(edit);
        card.appendChild(foot);

        const choose = () => selectTool(t.id);
        card.addEventListener('click', choose);
        card.addEventListener('keydown', e => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); choose(); }
        });
        box.appendChild(card);
      });
    }
  }

  // Move a tool one place earlier or later in its op, and renumber the op so the
  // sequence stays 1..n.
  function moveTool(id, to) {
    const t = shop.tools.find(x => x.id === id);
    if (!t) return;
    const order = opTools(t);
    const from = order.indexOf(t);
    if (to < 0 || to >= order.length || to === from) return;
    order.splice(to, 0, ...order.splice(from, 1));
    order.forEach((x, i) => { x.seq = i + 1; touch(x); });
    save();
    renderChart();
    renderTools();
  }

  /* ---------------- import ----------------
     A spreadsheet of tooling goes back in the way it came out. The columns are
     the ones the export writes, read by name rather than by position, so a file
     with them reordered, renamed to a common alternative, or missing the ones
     that do not apply still reads. The three worked-out columns the export adds
     (cycles timed, average, parts per edge) are ignored on the way in — they are
     derived from the cycles, and taking them as given would let a stale figure
     in a spreadsheet contradict the times it was supposed to summarize.

     An import never deletes anything. A tool already on the board is matched by
     what identifies it on the floor — part, machine, op, station, description —
     and gains the file's cycles and any field the file fills in; everything else
     is added. Re-importing the same file changes nothing, because a cycle is
     recognized by when it was recorded and how long it took.
  ---------------------------------------------------------------- */
  const IMPORT_COLUMNS = [
    'part', 'machine', 'op', 'seq', 'station', 'tool', 'insert',
    'indexes_per_insert', 'inserts_per_op', 'tool_life_min_per_edge', 'insert_cost',
    'notes', 'cycle_seconds', 'recorded_at',
  ];
  // header name (normalized) → the field it fills. The export's own names plus
  // the shorter ones a person is likely to type.
  const COLUMN_ALIASES = {
    part: 'part', part_number: 'part', partno: 'part',
    machine: 'machine',
    op: 'op', operation: 'op',
    seq: 'seq', sequence: 'seq', order: 'seq',
    station: 'station', turret: 'station', pocket: 'station',
    tool: 'desc', tool_description: 'desc', description: 'desc',
    insert: 'insert',
    indexes_per_insert: 'indexes', indexes: 'indexes', edges: 'indexes',
    inserts_per_op: 'insertsPerOp', inserts: 'insertsPerOp',
    tool_life_min_per_edge: 'lifeMin', tool_life: 'lifeMin', life_min: 'lifeMin', tool_life_min: 'lifeMin',
    insert_cost: 'insertCost', cost: 'insertCost',
    notes: 'notes', note: 'notes',
    cycle_seconds: 'sec', cycle_sec: 'sec', seconds: 'sec', cycle_time: 'sec',
    recorded_at: 'at', at: 'at', date: 'at', timestamp: 'at',
  };
  const IDENTITY = ['part', 'machine', 'op', 'station', 'desc'];
  const MAX_IMPORT_BYTES = 5 * 1024 * 1024;

  const normHeader = h => String(h || '')
    .replace(/^﻿/, '')       // Excel writes a byte-order mark on the first cell
    .trim().toLowerCase()
    .replace(/[\s-]+/g, '_')
    .replace(/[^a-z0-9_]/g, '');

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

  // Read a file into the tools and cycles it describes, with a note of anything
  // that could not be used. Nothing is changed here — this only reads.
  function readImport(text) {
    const rows = parseCsv(text, sniffSeparator(text));
    if (!rows.length) return { error: 'That file has nothing in it.' };
    const header = rows[0].map(normHeader).map(h => COLUMN_ALIASES[h] || '');
    if (!header.some(f => IDENTITY.includes(f))) {
      return { error: 'That file has no column naming the tools. It needs at least one of ' +
        'part, machine, op, station or tool — the columns the ⤓ Export button writes.' };
    }
    const numeric = new Set(['seq', 'indexes', 'insertsPerOp', 'lifeMin', 'insertCost']);
    const byKey = new Map();
    let dataRows = 0, skipped = 0, badTimes = 0, badSecs = 0;

    for (const raw of rows.slice(1)) {
      dataRows++;
      const cell = {};
      header.forEach((field, i) => { if (field) cell[field] = String(raw[i] == null ? '' : raw[i]).trim(); });
      const fields = {};
      for (const f of ['part', 'machine', 'op', 'station', 'desc', 'insert', 'notes']) {
        if (cell[f]) fields[f] = cell[f];
      }
      for (const f of numeric) {
        if (!cell[f]) continue;
        // "9,40" from a comma-decimal locale, and a currency symbol, both read
        const n = Number(String(cell[f]).replace(/[^0-9.,-]/g, '').replace(',', '.'));
        if (Number.isFinite(n) && n > 0) fields[f] = f === 'insertCost' || f === 'lifeMin' ? n : Math.floor(n);
      }
      if (!IDENTITY.some(f => fields[f])) { skipped++; continue; }

      const key = IDENTITY.map(f => (fields[f] || '').toLowerCase()).join(' ');
      if (!byKey.has(key)) byKey.set(key, { key, fields: {}, runs: [] });
      const tool = byKey.get(key);
      Object.assign(tool.fields, fields); // later rows fill in what earlier ones left blank

      if (cell.sec) {
        const sec = parseTime(cell.sec) || Number(String(cell.sec).replace(',', '.'));
        if (Number.isFinite(sec) && sec > 0) {
          let at = cell.at ? Date.parse(cell.at) : NaN;
          if (!Number.isFinite(at)) { if (cell.at) badTimes++; at = Date.now(); }
          tool.runs.push({ sec: round(sec, 2), at: Math.min(at, Date.now()) });
        } else badSecs++;
      }
    }
    return { tools: [...byKey.values()], dataRows, skipped, badTimes, badSecs };
  }

  // Work out exactly what an import would do, before it does any of it. The
  // preview and the import itself both read this, so what is shown is what runs.
  function planImport(read) {
    const plan = { add: [], update: [], newRuns: 0, dupeRuns: 0, overflowTools: 0, overflowRuns: 0 };
    const existing = new Map(shop.tools.map(t => [
      IDENTITY.map(f => String(t[f] || '').toLowerCase()).join(' '), t]));
    let room = Math.max(0, limits.maxTools - shop.tools.length);

    for (const incoming of read.tools) {
      const match = existing.get(incoming.key);
      // A cycle is the same cycle if it was recorded at the same moment and ran
      // the same length, so the same file imported twice adds nothing the second
      // time. Rows repeated inside one file collapse the same way.
      const seen = new Set((match ? match.runs : []).map(r => r.at + ':' + r.sec));
      const fresh = [];
      for (const r of incoming.runs) {
        const stamp = r.at + ':' + r.sec;
        if (seen.has(stamp)) { plan.dupeRuns++; continue; }
        seen.add(stamp);
        fresh.push(r);
      }
      const keptRuns = (match ? match.runs.length : 0) + fresh.length;
      if (keptRuns > limits.maxRuns) plan.overflowRuns += keptRuns - limits.maxRuns;
      plan.newRuns += fresh.length;
      if (match) {
        plan.update.push({ tool: match, fields: incoming.fields, runs: fresh });
      } else if (room > 0) {
        room--;
        plan.add.push({ fields: incoming.fields, runs: fresh });
      } else {
        plan.overflowTools++;
        plan.newRuns -= fresh.length;
      }
    }
    return plan;
  }

  function applyImport(read, plan) {
    const touched = new Set();
    for (const u of plan.update) {
      Object.assign(u.tool, u.fields); // a blank cell leaves what is already there
      u.tool.runs = [...u.runs, ...u.tool.runs].sort((a, b) => b.at - a.at).slice(0, limits.maxRuns);
      touch(u.tool);
      touched.add(opLabel(u.tool));
    }
    for (const a of plan.add) {
      const tool = {
        id: 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
        part: '', machine: '', op: '', station: '', seq: 0, desc: '', insert: '',
        indexes: 0, insertsPerOp: 0, lifeMin: 0, insertCost: 0, notes: '',
        ...a.fields,
        runs: a.runs.sort((x, y) => y.at - x.at).slice(0, limits.maxRuns),
        createdAt: Date.now(), updatedAt: Date.now(),
      };
      shop.tools.push(tool);
      touched.add(opLabel(tool));
    }
    for (const label of touched) renumberOp(label);
    if (!shop.activeId && shop.tools.length) shop.activeId = shop.tools[0].id;
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
    const lines = [];
    if (plan.add.length) lines.push(plan.add.length + (plan.add.length === 1 ? ' new tool' : ' new tools'));
    if (plan.update.length) lines.push(plan.update.length + ' already on the board' +
      (plan.update.length === 1 ? '' : ''));
    lines.push(plan.newRuns + (plan.newRuns === 1 ? ' new cycle' : ' new cycles'));
    box.appendChild(el('div', 'mf-import-sum', lines.join(' · ')));

    const notes = [];
    if (plan.update.length) {
      notes.push('Tools already on the board keep every field this file leaves blank, and keep every cycle they already have.');
    }
    if (plan.dupeRuns) notes.push(plan.dupeRuns + ' cycle' + (plan.dupeRuns === 1 ? ' is' : 's are') +
      ' already recorded and will be left alone.');
    if (read.skipped) notes.push(read.skipped + ' row' + (read.skipped === 1 ? '' : 's') +
      ' named no tool and will be skipped.');
    if (read.badSecs) notes.push(read.badSecs + ' cycle time' + (read.badSecs === 1 ? '' : 's') +
      ' could not be read as a number.');
    if (read.badTimes) notes.push(read.badTimes + ' date' + (read.badTimes === 1 ? '' : 's') +
      ' could not be read; those cycles will be stamped now.');
    if (plan.overflowTools) notes.push(plan.overflowTools + ' tool' + (plan.overflowTools === 1 ? '' : 's') +
      ' will not fit — this account holds ' + limits.maxTools + '.');
    if (plan.overflowRuns) notes.push('The oldest cycles on some tools will roll off at ' + limits.maxRuns + ' per tool.');
    notes.push('Nothing is deleted by an import.');
    for (const n of notes) box.appendChild(el('div', 'mf-note', n));

    const btns = el('div', 'mf-form-btns');
    const nothing = !plan.add.length && !plan.update.length;
    btns.appendChild(button('mf-btn mf-btn-go', 'Import', () => {
      const job = pendingImport;
      pendingImport = null;
      applyImport(job.read, job.plan);
      flash('Imported ' + job.name + ' — ' + job.plan.add.length + ' new, ' +
        job.plan.update.length + ' updated, ' + job.plan.newRuns + ' cycles added.');
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
    if (!read.tools.length) { flash('No tools could be read out of that file.'); return; }
    pendingImport = { read, plan: planImport(read), name: file.name || 'the file' };
    renderImport();
  }

  /* ---------------- export ---------------- */
  // One row per recorded cycle, carrying the tool it belongs to, so the file
  // can be pivoted in a spreadsheet without going back to the app.
  function exportCsv() {
    if (!shop || !shop.tools.length) { flash('Nothing to export yet.'); return; }
    const cell = v => {
      const s = String(v == null ? '' : v);
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const rows = [[
      ...IMPORT_COLUMNS, // everything an import reads back, in the order it is written
      'cycles_timed', 'average_seconds', 'parts_per_edge', // worked out from the rest
    ]];
    // in running order, op by op, so the file opens the way the job runs
    for (const t of [...shop.tools].sort((a, b) => opLabel(a).localeCompare(opLabel(b)) || bySeq(a, b))) {
      const s = statsFor(t);
      const life = s ? lifeFor(t, s.avg) : null;
      const base = [t.part, t.machine, t.op, t.seq || '', t.station, t.desc, t.insert,
        t.indexes || '', t.insertsPerOp || '', t.lifeMin || '', t.insertCost || '', t.notes];
      const tail = [s ? s.count : 0, s ? round(s.avg, 2) : '', life ? life.partsPerEdge : ''];
      if (!t.runs.length) { rows.push(base.concat(['', '']).concat(tail)); continue; }
      for (const r of t.runs) {
        rows.push(base.concat([round(r.sec, 2), new Date(r.at).toISOString()]).concat(tail));
      }
    }
    const csv = rows.map(r => r.map(cell).join(',')).join('\r\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'cycle-times-' + new Date().toISOString().slice(0, 10) + '.csv';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  /* ---------------- keyboard ---------------- */
  // Hands are usually on the machine rather than the keyboard, but a laptop at
  // the bench gets the three keys that matter. Ignored while typing, and while
  // the Shop screen is not the one on show.
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
    heading.appendChild(el('h1', 'mf-h1', 'Shop floor'));
    heading.appendChild(el('div', 'mf-sub', 'Cycle times, tool by tool'));
    top.appendChild(heading);
    const actions = el('div', 'mf-top-btns');
    actions.appendChild(button('mf-btn mf-btn-sm', '+ Tool', () => openForm(null)));
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
    actions.appendChild(button('mf-btn mf-btn-sm', '⤓ Export', exportCsv, 'Download every recorded cycle as a spreadsheet'));
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
    els.tools = el('div', 'mf-tools');
    page.appendChild(els.watch);
    page.appendChild(els.stats);
    page.appendChild(els.runs);
    page.appendChild(els.form);
    page.appendChild(els.chart);
    page.appendChild(els.tools);
    host.appendChild(page);

    document.addEventListener('keydown', onKey);
    restoreWatch();
    render(); // the loading state; open() runs straight after this and fetches
  }

  // Coming back to the screen: the record may have moved on another device, and
  // #/p/manufacturing/t/<id> points the watch at a particular tool.
  function open(sub) {
    startTick();
    const pick = String(sub || '').match(/^t\/([A-Za-z0-9]{1,24})$/);
    if (pick) pendingTool = pick[1];
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
