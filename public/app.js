'use strict';

/* ================================================================
   API helper
================================================================ */
async function api(path, method = 'GET', body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(path, opts);
  let data = {};
  try { data = await res.json(); } catch { /* empty */ }
  if (!res.ok) {
    const err = new Error(data.error || 'Request failed');
    err.status = res.status;
    throw err;
  }
  return data;
}

const $ = sel => document.querySelector(sel);

/* ================================================================
   Palette
================================================================ */
const HUES = [
  { main: '#4FD1E0', lite: '#C8F3F8', dark: '#16646F' },
  { main: '#F0B84A', lite: '#FBE8C0', dark: '#7A5613' },
  { main: '#F07A8F', lite: '#FBD3DA', dark: '#7A2334' },
  { main: '#9BD65A', lite: '#E0F4C8', dark: '#476E1B' },
  { main: '#B08CF0', lite: '#E4D8FB', dark: '#4E3387' },
  { main: '#F09A5A', lite: '#FBDFC8', dark: '#7A4113' },
];
const hueOf = n => HUES[(n.hue || 0) % HUES.length];

/* ================================================================
   Fit-to-bubble text sizing
================================================================ */
// Shared offscreen canvas for measuring text without touching layout.
const _measureCtx = document.createElement('canvas').getContext('2d');

const _bubbleFont = '-apple-system, "Segoe UI", Roboto, system-ui, sans-serif';

// Word-wrap `label` to fit width `boxW` at font size `fs`. Words are only ever
// broken *between* each other, never mid-word — a single word too wide for the
// box stays on its own (over-wide) line, and fitBubbleFont shrinks the font
// until even that word fits. Returns the array of lines.
function wrapLabelLines(label, boxW, fs) {
  _measureCtx.font = '700 ' + fs + 'px ' + _bubbleFont;
  const w = s => _measureCtx.measureText(s).width;
  const lines = [];
  let line = '';
  for (const word of label.split(/\s+/)) {
    if (!word) continue;
    const trial = line ? line + ' ' + word : word;
    if (w(trial) <= boxW) line = trial;
    else { if (line) lines.push(line); line = word; }
  }
  if (line) lines.push(line);
  return lines;
}

// Largest font size (px) at which `text` wraps to fit inside a circle of the
// given radius. Bubbles are round, so we fit the label into the circle's
// inscribed square (side ≈ r·√2) minus a little padding. Returns a size clamped
// to a readable range so text always fits without getting oversized on short
// labels. The `box` used for measuring is exposed via bubbleTextBox(r).
function bubbleTextBox(r) { return r * Math.SQRT2 * 0.9; }
function fitBubbleFont(text, r) {
  const label = (text || 'Untitled').trim() || 'Untitled';
  const box = bubbleTextBox(r);
  const MAX = Math.min(20, r * 0.55);    // cap so a lone word isn't oversized
  // low floor: since words are never broken, a long single word has to shrink
  // a lot to fit on one line — we let it, rather than clip or break the word
  const MIN = 3;
  const fits = fs => {
    const lines = wrapLabelLines(label, box, fs);
    // vertical: every line, stacked, fits within the box height
    if (lines.length * fs * 1.2 > box) return false;
    // horizontal: no line overflows — this is what forces the font down until
    // an unbreakable long word fits on its single line
    _measureCtx.font = '700 ' + fs + 'px ' + _bubbleFont;
    for (const line of lines) {
      if (_measureCtx.measureText(line).width > box) return false;
    }
    return true;
  };
  let lo = MIN, hi = MAX, best = MIN;
  if (fits(hi)) return hi;
  for (let i = 0; i < 16 && hi - lo > 0.25; i++) {
    const mid = (lo + hi) / 2;
    if (fits(mid)) { best = mid; lo = mid; } else { hi = mid; }
  }
  return Math.max(MIN, best);
}

/* ================================================================
   3D map view (spheres, weighted edges, container spheres)
================================================================ */
function createMapView(host, opts = {}) {
  const editable = !!opts.editable;
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const FOCAL = 700;

  host.innerHTML = '';
  // three stacked layers so connections read correctly over opaque groups:
  //   group circles (bottom) → connection lines (middle) → bubbles (top)
  const groupLayer = document.createElement('div');
  groupLayer.className = 'group-layer';
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'edges');
  const layer = document.createElement('div');
  layer.className = 'nodes-layer';
  host.appendChild(groupLayer);
  host.appendChild(svg);
  host.appendChild(layer);

  let map = { nodes: {}, edges: [] };
  let idCounter = 1;
  let hueCounter = 0;
  let hueOverride = null;   // user-chosen color for new bubbles; null = round-robin
  // The view is a flat 2D plane: yaw/pitch are pinned to 0 so project() collapses
  // to orthographic pan + uniform-scale zoom. camDist drives zoom; pivot is the
  // world point held at screen center. There is no rotation, orbit, or spin.
  let yaw = 0, pitch = 0, camDist = 950;
  let pivot = [0, 0, 0];    // world point at screen center (pan position)
  let centeredId = null;    // node the view last recentered on (read-only tap-to-focus)
  let anchorId = null;      // node that "reset view" centers on (persisted with the map)
  let spinning = false;     // 2D: never auto-spins
  let showWeights = true;   // show the numbered weight badges on connections
  let selectedId = null;
  let connectFrom = null;
  let highlightedEdge = null;
  let running = false;
  let lastProj = {};        // screen positions from the latest frame, for hit testing
  let lastMouse = null;     // host-relative mouse position (mouse pointers only)
  let hoverId = null;       // bubble the next click would select
  let hoverEdgeId = null;   // edge the next click would select
  let hoverLock = false;    // true while the pick menu controls highlighting
  let lastTap = null;       // for double-tap detection
  let pendingTimer = null;  // deferred single-tap action (waiting out a double-tap)
  let dwellTimer = null;    // hover-for-a-second timer
  let arranging = null;     // { t0, dur, from, to } while auto-arrange glides bubbles

  const nodeEls = new Map();
  const edgeEls = new Map();

  /* ---------- vector helpers ---------- */
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const add3 = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
  const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
  const len = a => Math.hypot(a[0], a[1], a[2]);
  const norm = a => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
  // flat 2D: random directions live in the z=0 plane so every placement,
  // clamp, and layout scatter keeps nodes on the plane
  const randUnit = () => {
    const t = Math.random() * Math.PI * 2;
    return [Math.cos(t), Math.sin(t), 0];
  };

  /* ---------- projection ---------- */
  function project(p, w, h) {
    const cy = Math.cos(yaw), sy = Math.sin(yaw);
    const cp = Math.cos(pitch), sp = Math.sin(pitch);
    // rotate around the pivot: it stays fixed at screen center as yaw/pitch change
    const px = p[0] - pivot[0], py = p[1] - pivot[1], pz = p[2] - pivot[2];
    const x1 = px * cy - pz * sy;
    const z1 = px * sy + pz * cy;
    const y2 = py * cp - z1 * sp;
    const z2 = py * sp + z1 * cp;
    const zc = z2 + camDist;
    const s = FOCAL / Math.max(zc, 60);
    return { x: w / 2 + x1 * s, y: h / 2 + y2 * s, s, zc, behind: zc < 60 };
  }

  function cameraBasis() {
    const cy = Math.cos(-yaw), sy = Math.sin(-yaw);
    const cp = Math.cos(-pitch), sp = Math.sin(-pitch);
    function invRot(v) {
      const y1 = v[1] * cp - v[2] * sp;
      const z1 = v[1] * sp + v[2] * cp;
      const x2 = v[0] * cy - z1 * sy;
      const z2 = v[0] * sy + z1 * cy;
      return [x2, y1, z2];
    }
    return { right: invRot([1, 0, 0]), up: invRot([0, 1, 0]) };
  }

  /* ---------- graph helpers ---------- */
  const newId = () => {
    while (map.nodes['n' + idCounter]) idCounter++;
    return 'n' + (idCounter++);
  };
  const childrenOf = id => Object.values(map.nodes).filter(n => n.parentId === id);
  const containers = () => Object.values(map.nodes).filter(n => n.kind === 'container');
  const edgesOf = id => map.edges.filter(e => e.a === id || e.b === id);

  function clampInside(n) {
    const c = n.parentId && map.nodes[n.parentId];
    if (!c) return;
    let d = sub(n.pos, c.pos);
    let L = len(d);
    if (L < 0.001) { d = randUnit(); L = 1; }
    const maxL = Math.max(10, c.r - n.r - 10);
    if (L > maxL) n.pos = add3(c.pos, mul(d, maxL / L));
  }

  const GROUP_MIN_R = 130;   // an empty group never shrinks below this
  const GROUP_PAD = 22;      // breathing room between the outermost child and the ring

  // Size a container to snugly fit its children: big enough that every child
  // sits fully inside (plus padding), but no bigger. Unlike a grow-only pass,
  // this also shrinks a group back down when children are removed or pulled in,
  // so a group always tracks the space its contents actually need.
  function fitContainer(c) {
    if (!c || c.kind !== 'container') return;
    let need = GROUP_MIN_R;
    for (const ch of childrenOf(c.id)) {
      need = Math.max(need, len(sub(ch.pos, c.pos)) + ch.r + GROUP_PAD);
    }
    c.r = need;
  }

  // Grow a container just enough to contain a newly added/moved child, without
  // shrinking it (used on live edits so an existing layout doesn't jump).
  function growContainer(c) {
    if (!c || c.kind !== 'container') return;
    let need = GROUP_MIN_R;
    for (const ch of childrenOf(c.id)) {
      need = Math.max(need, len(sub(ch.pos, c.pos)) + ch.r + GROUP_PAD);
    }
    c.r = Math.max(c.r, need);
  }

  function changed() {
    buildDOM();
    if (opts.onChange) opts.onChange();
  }

  /* ---------- DOM build ---------- */
  function buildDOM() {
    layer.innerHTML = '';
    groupLayer.innerHTML = '';
    svg.innerHTML = '';
    nodeEls.clear();
    edgeEls.clear();

    for (const e of map.edges) {
      const na = map.nodes[e.a], nb = map.nodes[e.b];
      if (!na || !nb) continue;
      const line = document.createElementNS(SVG_NS, 'line');
      line.setAttribute('stroke', hueOf(na).main);
      line.setAttribute('stroke-linecap', 'round');
      svg.appendChild(line);

      let handle = null;
      if (editable) {
        handle = document.createElementNS(SVG_NS, 'g');
        handle.setAttribute('class', 'whandle');
        const circ = document.createElementNS(SVG_NS, 'circle');
        circ.setAttribute('r', 12);
        circ.setAttribute('fill', '#141926');
        circ.setAttribute('stroke', hueOf(na).main);
        circ.setAttribute('stroke-width', 1.5);
        const txt = document.createElementNS(SVG_NS, 'text');
        txt.setAttribute('text-anchor', 'middle');
        txt.setAttribute('dominant-baseline', 'central');
        txt.setAttribute('fill', '#EDEFF4');
        txt.setAttribute('font-size', 11);
        txt.setAttribute('font-weight', 700);
        txt.textContent = e.w;
        handle.appendChild(circ);
        handle.appendChild(txt);
        svg.appendChild(handle);
      }
      edgeEls.set(e.id, { line, handle });
    }

    for (const n of Object.values(map.nodes)) {
      const col = hueOf(n);
      const el = document.createElement('div');
      el.className = 'bubble' + (n.kind === 'container' ? ' container' : '') + (n.mapRef ? ' map-link' : '');
      el.style.setProperty('--main', col.main);
      el.style.setProperty('--lite', col.lite);
      el.style.setProperty('--dark', col.dark);
      el.style.width = n.r * 2 + 'px';
      el.style.height = n.r * 2 + 'px';
      const label = document.createElement('div');
      label.className = 'label';
      label.textContent = n.label || 'Untitled';
      // shrink the label so it always fits inside a normal bubble; group labels
      // sit outside the circle (see CSS) and keep the default size + ellipsis
      if (n.kind !== 'container') label.style.fontSize = fitBubbleFont(n.label, n.r).toFixed(1) + 'px';
      el.appendChild(label);
      // small badges mark bubbles that carry a note and/or a link
      const badges = [];
      if (n.mapRef) badges.push(['🗺️', 'Links to a map']);
      if (n.note && n.note.trim()) badges.push(['📝', 'Has a note']);
      if (n.link) badges.push(['🔗', 'Has a link']);
      if (badges.length) {
        const wrap = document.createElement('div');
        wrap.className = 'node-badges';
        for (const [icon, title] of badges) {
          const b = document.createElement('div');
          b.className = 'note-badge';
          b.textContent = icon; b.title = title;
          wrap.appendChild(b);
        }
        el.appendChild(wrap);
      }
      el.classList.toggle('has-note', !!(n.note && n.note.trim()));
      el.classList.toggle('done', !!n.done); // completed task: dimmed + struck through
      // group circles go in the bottom layer (behind the connection lines);
      // bubbles go in the top layer (in front of the lines)
      (n.kind === 'container' ? groupLayer : layer).appendChild(el);
      nodeEls.set(n.id, el);
    }
    updateSelectionClasses();
  }

  function updateSelectionClasses() {
    for (const [id, el] of nodeEls) {
      el.classList.toggle('selected', id === selectedId);
      el.classList.toggle('connect-source', id === connectFrom);
      el.classList.toggle('hovered', id === hoverId);
    }
    host.classList.toggle('connecting', !!connectFrom);
  }

  /* ---------- render loop ---------- */
  function frame() {
    if (!running) return;
    // glide bubbles toward their auto-arranged spots
    if (arranging) {
      const t = Math.min(1, (performance.now() - arranging.t0) / arranging.dur);
      const ek = easeInOut(t);
      for (const [id, dest] of Object.entries(arranging.to)) {
        const nd = map.nodes[id], fr = arranging.from[id];
        if (nd && fr) {
          nd.pos = [fr[0] + (dest[0] - fr[0]) * ek,
                    fr[1] + (dest[1] - fr[1]) * ek,
                    fr[2] + (dest[2] - fr[2]) * ek];
        }
      }
      if (t >= 1) finishArrange();
    }
    const w = host.clientWidth, h = host.clientHeight;
    const proj = {};
    for (const n of Object.values(map.nodes)) {
      const p = project(n.pos, w, h);
      p.scale = Math.max(0.18, Math.min(2.2, p.s));
      proj[n.id] = p;
    }
    lastProj = proj;

    for (const [id, el] of nodeEls) {
      const p = proj[id];
      const n = map.nodes[id];
      if (!p || !n) continue;
      if (p.behind) { el.style.display = 'none'; continue; }
      el.style.display = '';
      el.style.transform = `translate(-50%, -50%) translate(${p.x}px, ${p.y}px) scale(${p.scale})`;
      el.style.opacity = 1; // flat 2D: every node is fully opaque (no depth fade)
      // small, layer-local z-index: selected/hovered come forward among their
      // siblings. Kept tiny (was ~99500) so nodes never paint over the menus.
      el.style.zIndex = id === selectedId ? 3 : id === hoverId ? 2 : 1;
    }

    for (const e of map.edges) {
      const els = edgeEls.get(e.id);
      if (!els) continue;
      const a = proj[e.a], b = proj[e.b];
      if (!a || !b || a.behind || b.behind) {
        els.line.style.display = 'none';
        if (els.handle) els.handle.style.display = 'none';
        continue;
      }
      els.line.style.display = '';
      // stop the line at each bubble's edge instead of running to its center:
      // trim by the on-screen radius of each end (capped so ends never cross)
      const na = map.nodes[e.a], nb = map.nodes[e.b];
      const ddx = b.x - a.x, ddy = b.y - a.y;
      const dlen = Math.hypot(ddx, ddy) || 1;
      const ux = ddx / dlen, uy = ddy / dlen;
      const cap = dlen * 0.45; // keep at least ~10% of the span visible
      const ta = Math.min(na.r * a.scale, cap), tb = Math.min(nb.r * b.scale, cap);
      const x1 = a.x + ux * ta, y1 = a.y + uy * ta;
      const x2 = b.x - ux * tb, y2 = b.y - uy * tb;
      els.line.setAttribute('x1', x1); els.line.setAttribute('y1', y1);
      els.line.setAttribute('x2', x2); els.line.setAttribute('y2', y2);
      const depth = (a.s + b.s) / 2;
      const hi = e.id === highlightedEdge;
      const hov = e.id === hoverEdgeId;
      // weight IS the thickness: 1 → hairline, 10 → thick rope
      let op = Math.max(0.5, Math.min(0.95, depth * 0.9));
      if (hov) op = Math.min(1, op + 0.3);
      if (hi) op = 1;
      els.line.setAttribute('stroke-opacity', op);
      els.line.setAttribute('stroke-width', Math.max(1.6, (0.6 + e.w) * depth) + (hi ? 1.5 : hov ? 1 : 0));
      if (els.handle) {
        els.handle.style.display = showWeights ? '' : 'none';
        // sit the weight badge at the midpoint of the visible (trimmed) segment
        els.handle.setAttribute('transform', `translate(${(x1 + x2) / 2}, ${(y1 + y2) / 2}) scale(${Math.max(0.7, Math.min(1.2, depth))})`);
      }
    }

    // keep the hover highlight honest while the scene moves under a still cursor
    let hoveringNode = false;
    if ((editable || opts.tapToCenter) && lastMouse && !drag && !hoverLock) {
      let hits = hitTest(lastMouse.x, lastMouse.y);
      if (!editable) hits = hits.filter(h => h.type === 'node');
      applyHover(hits[0] || null);
      hoveringNode = hits.length > 0;
    }

    // pause auto-spin while hovering a bubble so it stays put long enough to
    // click, and so an overlap dwell can complete
    if (spinning && !drag && !sheetOpen() && !hoveringNode) yaw += 0.0028;
    requestAnimationFrame(frame);
  }

  function sheetOpen() {
    return opts.isSheetOpen ? opts.isSheetOpen() : false;
  }

  /* ---------- hit testing (what is under a point, front to back) ---------- */
  function segDist(px, py, a, b) {
    const dx = b.x - a.x, dy = b.y - a.y;
    const L2 = dx * dx + dy * dy;
    let t = L2 ? ((px - a.x) * dx + (py - a.y) * dy) / L2 : 0;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (a.x + t * dx), py - (a.y + t * dy));
  }

  // Returns every element at (x, y) in click-priority order: the first entry is
  // what a plain click selects. Bubbles beat lines (lines always render behind
  // spheres); within each kind, nearer wins, with containers nudged behind.
  function hitTest(x, y) {
    const nodesHit = [], edgesHit = [];
    for (const n of Object.values(map.nodes)) {
      const p = lastProj[n.id];
      if (!p || p.behind) continue;
      if (Math.hypot(x - p.x, y - p.y) <= n.r * p.scale) {
        nodesHit.push({ type: 'node', id: n.id, z: p.zc + (n.kind === 'container' ? 40 : 0) });
      }
    }
    nodesHit.sort((a, b) => a.z - b.z);
    for (const e of map.edges) {
      const a = lastProj[e.a], b = lastProj[e.b];
      if (!a || !b || a.behind || b.behind) continue;
      const depth = (a.s + b.s) / 2;
      const nearMid = Math.hypot(x - (a.x + b.x) / 2, y - (a.y + b.y) / 2) <= 15;
      const grab = Math.max(12, ((0.5 + e.w) * depth) / 2 + 6);
      if (nearMid || segDist(x, y, a, b) <= grab) {
        edgesHit.push({ type: 'edge', id: e.id, z: (a.zc + b.zc) / 2 });
      }
    }
    edgesHit.sort((a, b) => a.z - b.z);
    return [...nodesHit, ...edgesHit];
  }

  function tapPoint(e) {
    const rect = host.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  /* ---------- hover highlight ---------- */
  function applyHover(hit) {
    const nId = hit && hit.type === 'node' ? hit.id : null;
    if (nId !== hoverId) {
      const prev = hoverId && nodeEls.get(hoverId);
      if (prev) prev.classList.remove('hovered');
      hoverId = nId;
      const cur = hoverId && nodeEls.get(hoverId);
      if (cur) cur.classList.add('hovered');
    }
    hoverEdgeId = hit && hit.type === 'edge' ? hit.id : null;
    host.classList.toggle('hoverable', !!hit);
  }

  /* ---------- pointer handling ---------- */
  const pointers = new Map();
  let drag = null;

  host.addEventListener('pointerdown', e => {
    e.preventDefault();
    finishArrange(); // a touch mid-glide snaps the layout to its final spots
    clearTimeout(pendingTimer); pendingTimer = null;
    clearTimeout(dwellTimer); dwellTimer = null;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      drag = { type: 'pinch', startDist: Math.hypot(a.x - b.x, a.y - b.y), startCam: camDist };
      return;
    }
    if (drag) return;

    const pt = tapPoint(e);
    // editable views hit-test for selection/editing; read-only views hit-test
    // too so a tap can pick the center of rotation
    const hits = (editable || opts.tapToCenter) ? hitTest(pt.x, pt.y) : [];
    const top = hits[0] || null;

    // background drag always pans (2D: there is no orbit)
    const bgDrag = () => {
      drag = { type: 'pan', startX: e.clientX, startY: e.clientY, startPivot: [...pivot], moved: false };
      host.classList.add('dragging');
    };

    // read-only "tap a bubble to center on it" mode
    if (!editable && opts.tapToCenter) {
      if (top && top.type === 'node') {
        drag = { type: 'centerTap', id: top.id, startX: e.clientX, startY: e.clientY, moved: false };
      } else {
        bgDrag();
      }
      return;
    }

    if (top && top.type === 'node') {
      const id = top.id;
      // connect mode: tapping a second bubble completes the link
      if (connectFrom && connectFrom !== id) {
        const from = connectFrom;
        connectFrom = null;
        const edge = connectNodes(from, id);
        updateSelectionClasses();
        if (edge && opts.onConnected) opts.onConnected(edge.id);
        drag = { type: 'noop' };
        return;
      }
      const wasSelected = selectedId === id;
      selectedId = id;
      updateSelectionClasses();
      if (opts.onSelect) opts.onSelect(id);
      const n = map.nodes[id];
      const starts = { [id]: [...n.pos] };
      if (n.kind === 'container') {
        for (const ch of childrenOf(id)) starts[ch.id] = [...ch.pos];
      }
      const p = project(n.pos, host.clientWidth, host.clientHeight);
      drag = { type: 'node', id, startX: e.clientX, startY: e.clientY, starts, scale: p.s, moved: false, wasSelected };
    } else if (top && top.type === 'edge') {
      drag = { type: 'edgeTap', edgeId: top.id, startX: e.clientX, startY: e.clientY, moved: false };
    } else {
      bgDrag();
    }
  });

  // hover tracking + "hovered a stack for a second" dropdown (mouse only).
  // Runs for the editor and for read-only tap-to-center views.
  host.addEventListener('pointermove', e => {
    if (!(editable || opts.tapToCenter) || e.pointerType !== 'mouse') return;
    lastMouse = tapPoint(e);
    if (drag || hoverLock) return;
    clearTimeout(dwellTimer); dwellTimer = null;
    let hits = hitTest(lastMouse.x, lastMouse.y);
    // when only picking a center, only bubbles/groups matter — ignore edges
    if (!editable) hits = hits.filter(h => h.type === 'node');
    applyHover(hits[0] || null);
    if (hits.length >= 2 && opts.onPick) {
      const cx = e.clientX, cy = e.clientY;
      // freeze the overlapping set now; the scene may spin the bubbles apart
      // before the dwell completes, but the user's intent is captured here
      const frozen = hits;
      dwellTimer = setTimeout(() => {
        if (drag || hoverLock) return;
        opts.onPick(frozen, cx, cy, 'hover');
      }, 600);
    }
  });

  host.addEventListener('pointerleave', e => {
    if (e.pointerType !== 'mouse') return;
    lastMouse = null;
    clearTimeout(dwellTimer); dwellTimer = null;
    if (!hoverLock) applyHover(null);
  });

  /* ---------- taps (with double-tap → pick menu) ---------- */
  function handleTap(e, kind, dragInfo) {
    const now = Date.now();
    const pt = tapPoint(e);
    const hits = hitTest(pt.x, pt.y);
    const isDouble = lastTap && (now - lastTap.t) < 350 &&
      Math.hypot(e.clientX - lastTap.cx, e.clientY - lastTap.cy) < 30;
    lastTap = { t: now, cx: e.clientX, cy: e.clientY };

    if (isDouble && hits.length >= 2) {
      clearTimeout(pendingTimer); pendingTimer = null;
      lastTap = null;
      if (opts.onPick) opts.onPick(hits, e.clientX, e.clientY, 'tap');
      return;
    }

    if (kind === 'node') {
      if (dragInfo.wasSelected && opts.onRenameRequest) {
        const id = dragInfo.id;
        // if things overlap here, wait out a possible double-tap before renaming
        if (hits.length >= 2) pendingTimer = setTimeout(() => opts.onRenameRequest(id), 370);
        else opts.onRenameRequest(id);
      }
    } else if (kind === 'edge') {
      const id = dragInfo.edgeId;
      const fire = () => { if (opts.onEdgeTap) opts.onEdgeTap(id); };
      if (hits.length >= 2) pendingTimer = setTimeout(fire, 370);
      else fire();
    } else {
      // background tap: clear selection / cancel connect
      if (connectFrom) {
        connectFrom = null;
        if (opts.onConnectCancel) opts.onConnectCancel();
      }
      selectedId = null;
      updateSelectionClasses();
      if (opts.onSelect) opts.onSelect(null);
    }
  }

  // read-only center-pick tap: single tap centers on the node; when bubbles
  // overlap, a double-tap opens the pick dropdown to choose which one.
  function handleCenterTap(e, tappedId) {
    const now = Date.now();
    const pt = tapPoint(e);
    const hits = hitTest(pt.x, pt.y).filter(h => h.type === 'node');
    const isDouble = lastTap && (now - lastTap.t) < 350 &&
      Math.hypot(e.clientX - lastTap.cx, e.clientY - lastTap.cy) < 30;
    lastTap = { t: now, cx: e.clientX, cy: e.clientY };

    if (isDouble && hits.length >= 2) {
      clearTimeout(pendingTimer); pendingTimer = null;
      lastTap = null;
      if (opts.onPick) opts.onPick(hits, e.clientX, e.clientY, 'tap');
      return;
    }
    const centerNow = () => {
      const n = map.nodes[tappedId];
      if (n) { pivot = [...n.pos]; centeredId = tappedId; if (opts.onCenter) opts.onCenter(tappedId); }
    };
    // overlap: wait out a possible double-tap before committing the single-tap center
    if (hits.length >= 2) pendingTimer = setTimeout(centerNow, 370);
    else centerNow();
  }

  window.addEventListener('pointermove', e => {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (!drag) return;

    if (drag.type === 'pinch' && pointers.size >= 2) {
      const [a, b] = [...pointers.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      camDist = Math.min(3200, Math.max(300, drag.startCam * (drag.startDist / dist)));
    } else if (drag.type === 'orbit') {
      const dx = e.clientX - drag.startX, dy = e.clientY - drag.startY;
      if (Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true;
      yaw = drag.startYaw + dx * 0.006;
      pitch = Math.max(-1.4, Math.min(1.4, drag.startPitch + dy * 0.006));
    } else if (drag.type === 'pan') {
      const dx = e.clientX - drag.startX, dy = e.clientY - drag.startY;
      if (Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true;
      // move the view-center point along the camera plane; the scene follows the finger
      const { right, up } = cameraBasis();
      const wpp = camDist / FOCAL; // world units per screen pixel at the view plane
      pivot = sub(drag.startPivot, add3(mul(right, dx * wpp), mul(up, dy * wpp)));
    } else if (drag.type === 'node' && editable) {
      const dx = e.clientX - drag.startX, dy = e.clientY - drag.startY;
      if (Math.abs(dx) + Math.abs(dy) > 5) drag.moved = true;
      if (!drag.moved) return;
      const { right, up } = cameraBasis();
      const delta = add3(mul(right, dx / drag.scale), mul(up, dy / drag.scale));
      for (const [sid, s] of Object.entries(drag.starts)) {
        if (map.nodes[sid]) map.nodes[sid].pos = add3(s, delta);
      }
      const n = map.nodes[drag.id];
      if (n) {
        clampInside(n);
        // dragging a bubble around inside its group nudges the ring to keep it fit
        if (n.kind !== 'container' && n.parentId && map.nodes[n.parentId]) fitContainer(map.nodes[n.parentId]);
      }
    } else if (drag.type === 'centerTap') {
      // dragging from a bubble in read-only view pans the flat view
      const dx = e.clientX - drag.startX, dy = e.clientY - drag.startY;
      if (Math.abs(dx) + Math.abs(dy) > 4) {
        if (!drag.moved) {
          drag.moved = true;
          drag.startPivot = [...pivot];
          drag.grabX = e.clientX; drag.grabY = e.clientY;
          host.classList.add('dragging');
        }
        const { right, up } = cameraBasis();
        const wpp = camDist / FOCAL;
        pivot = sub(drag.startPivot,
          add3(mul(right, (e.clientX - drag.grabX) * wpp), mul(up, (e.clientY - drag.grabY) * wpp)));
      }
    } else if (drag.type === 'edgeTap') {
      const dx = e.clientX - drag.startX, dy = e.clientY - drag.startY;
      if (Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true;
    }
  });

  window.addEventListener('pointerup', e => {
    const had = pointers.delete(e.pointerId);
    if (had && drag) {
      if (drag.type === 'node') {
        if (drag.moved) {
          if (opts.onChange) opts.onChange();
        } else {
          handleTap(e, 'node', drag);
        }
      } else if (drag.type === 'edgeTap' && !drag.moved) {
        handleTap(e, 'edge', drag);
      } else if (drag.type === 'centerTap' && !drag.moved) {
        handleCenterTap(e, drag.id);
      } else if ((drag.type === 'orbit' || drag.type === 'pan') && !drag.moved) {
        // a click on empty space stops orbiting a bubble (drags pan again)
        if (centeredId) {
          centeredId = null;
          if (opts.onCenter) opts.onCenter(null);
        }
        if (editable) handleTap(e, 'bg', drag);
      }
    }
    if (pointers.size === 0) { drag = null; host.classList.remove('dragging'); }
    else if (pointers.size === 1 && drag && drag.type === 'pinch') drag = null;
  });

  window.addEventListener('pointercancel', e => {
    pointers.delete(e.pointerId);
    if (pointers.size === 0) { drag = null; host.classList.remove('dragging'); }
  });

  host.addEventListener('wheel', e => {
    e.preventDefault();
    camDist = Math.min(3200, Math.max(300, camDist * (e.deltaY < 0 ? 0.92 : 1.08)));
  }, { passive: false });

  /* ---------- mutations ---------- */
  function connectNodes(aId, bId) {
    if (aId === bId || !map.nodes[aId] || !map.nodes[bId]) return null;
    const existing = map.edges.find(e =>
      (e.a === aId && e.b === bId) || (e.a === bId && e.b === aId));
    if (existing) return existing;
    const edge = { id: 'e' + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36), a: aId, b: bId, w: 1 };
    map.edges.push(edge);
    changed();
    return edge;
  }

  function addBubble() {
    const sel = selectedId && map.nodes[selectedId];
    const id = newId();
    const n = {
      id, label: '', note: '', link: '', done: false, pos: [0, 0, 0], r: 62,
      hue: hueOverride !== null ? hueOverride : hueCounter++ % HUES.length,
      parentId: null, kind: 'bubble', mapRef: '',
    };

    if (sel && sel.kind === 'container') {
      n.parentId = sel.id;
      if (hueOverride === null) n.hue = sel.hue; // match the group unless a color was chosen
      n.pos = add3(sel.pos, mul(randUnit(), Math.max(20, sel.r * 0.45)));
      map.nodes[id] = n;
      clampInside(n);
      growContainer(sel);
    } else if (sel) {
      n.parentId = sel.parentId; // stays inside the same group as its sibling
      n.pos = add3(sel.pos, mul(randUnit(), sel.r + n.r + 70));
      map.nodes[id] = n;
      clampInside(n);
      if (n.parentId) growContainer(map.nodes[n.parentId]);
      map.edges.push({ id: 'e' + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36), a: sel.id, b: id, w: 1 });
    } else {
      n.pos = mul(randUnit(), 160 + Math.random() * 160);
      map.nodes[id] = n;
    }

    selectedId = id;
    changed();
    if (opts.onSelect) opts.onSelect(id);
    return id;
  }

  // Insert a bubble that links to another map. Positioned like addBubble, but
  // carries a mapRef and a label seeded from the target map's name. Viewers who
  // tap it are taken to that map (see the read-only viewer's onCenter).
  function addMapLinkBubble(mapId, label) {
    const id = addBubble();
    const n = map.nodes[id];
    n.mapRef = String(mapId || '');
    n.label = String(label || 'Map').slice(0, 80);
    changed();
    buildDOM(); // reflect the new label/badge immediately
    updateSelectionClasses();
    return id;
  }

  function addContainer() {
    const sel = selectedId && map.nodes[selectedId];
    const id = newId();
    const base = sel ? sel.pos : [0, 0, 0];
    const offset = sel ? (sel.r + 150 + 90) : 200 + Math.random() * 120;
    const n = {
      id, label: '', note: '', link: '', done: false, kind: 'container', r: 150,
      hue: hueOverride !== null ? hueOverride : hueCounter++ % HUES.length,
      parentId: null,
      pos: sel ? add3(base, mul(randUnit(), offset)) : mul(randUnit(), offset),
    };
    map.nodes[id] = n;
    selectedId = id;
    changed();
    if (opts.onSelect) opts.onSelect(id);
    return id;
  }

  function deleteSelected() {
    const n = selectedId && map.nodes[selectedId];
    if (!n) return;
    const doomed = [n.id];
    if (n.kind === 'container') {
      const kids = childrenOf(n.id);
      if (kids.length && !confirm(`Delete this group and the ${kids.length} bubble${kids.length > 1 ? 's' : ''} inside it?`)) return;
      for (const k of kids) doomed.push(k.id);
    }
    // deleting a bubble that lived in a group frees up space — shrink the group to fit
    const parent = n.kind !== 'container' && n.parentId && map.nodes[n.parentId];
    for (const id of doomed) delete map.nodes[id];
    map.edges = map.edges.filter(e => !doomed.includes(e.a) && !doomed.includes(e.b));
    if (parent) fitContainer(parent);
    selectedId = null;
    changed();
    if (opts.onSelect) opts.onSelect(null);
  }

  function renameSelected(label) {
    const n = selectedId && map.nodes[selectedId];
    if (!n) return;
    n.label = String(label || '').trim().slice(0, 80) || 'Untitled';
    changed();
  }

  function renameNode(id, label) {
    const n = map.nodes[id];
    if (!n) return;
    n.label = String(label || '').trim().slice(0, 80) || 'Untitled';
    changed();
  }

  // Set the free-text note attached to a node. Returns true if it changed,
  // so callers can skip a needless save/broadcast when nothing was edited.
  function setNote(id, note) {
    const n = map.nodes[id];
    if (!n) return false;
    const next = String(note || '').slice(0, 4000);
    if (next === (n.note || '')) return false;
    n.note = next;
    changed();
    return true;
  }

  // A node's link (an http(s) URL). Non-URLs are cleared. Returns true if changed.
  function setLink(id, link) {
    const n = map.nodes[id];
    if (!n) return false;
    let next = String(link || '').trim().slice(0, 300);
    if (next && !/^https?:\/\//i.test(next)) next = 'https://' + next; // be forgiving
    if (next && !/^https?:\/\//i.test(next)) next = '';
    if (next === (n.link || '')) return false;
    n.link = next;
    changed();
    return true;
  }

  // Mark a node done (a completed task) or not. Returns true if changed.
  function setDone(id, done) {
    const n = map.nodes[id];
    if (!n) return false;
    if (!!done === !!n.done) return false;
    n.done = !!done;
    changed();
    return true;
  }

  // Replace the whole map's contents (nodes + edges) in place — used by AI
  // generation. Keeps the current camera; caller persists via onChange.
  function loadGenerated(m) {
    const src = (m && m.nodes) || {};
    map.nodes = {};
    for (const [id, n] of Object.entries(src)) {
      map.nodes[id] = {
        id, label: n.label || '', note: n.note || '', link: n.link || '', done: !!n.done,
        pos: Array.isArray(n.pos) ? [n.pos[0] || 0, n.pos[1] || 0, 0] : [0, 0, 0],
        r: n.r || 62, hue: n.hue || 0, parentId: n.parentId || null,
        kind: n.kind === 'container' ? 'container' : 'bubble', mapRef: n.mapRef || '',
        order: (typeof n.order === 'number' && isFinite(n.order)) ? n.order : null,
      };
    }
    map.edges = ((m && m.edges) || []).map(e => ({ id: e.id, a: e.a, b: e.b, w: e.w || 3 }));
    normalizeOrder();
    selectedId = null; connectFrom = null; highlightedEdge = null;
    hueCounter = Object.keys(map.nodes).length;
    buildDOM();
    fitView();
    if (opts.onChange) opts.onChange();
  }

  function setWeight(edgeId, w) {
    const e = map.edges.find(x => x.id === edgeId);
    if (!e) return;
    e.w = Math.max(1, Math.min(10, Math.round(w)));
    changed();
  }

  function deleteEdge(edgeId) {
    map.edges = map.edges.filter(x => x.id !== edgeId);
    changed();
  }

  /* ---------- outline order ----------
     Siblings carry an explicit `order` so the outline can be rearranged without
     disturbing the canvas layout — the two views of a map are ordered
     independently. Maps written before ordering existed arrive with order null;
     normalizeOrder numbers them the way the outline already listed them, so
     nothing appears to jump the first time an old map is opened. */
  const orderKey = n => ((n.parentId && map.nodes[n.parentId]) ? n.parentId : '');

  function normalizeOrder() {
    const buckets = new Map();
    for (const n of Object.values(map.nodes)) {
      const k = orderKey(n);
      if (!buckets.has(k)) buckets.set(k, []);
      buckets.get(k).push(n);
    }
    const ranked = n => (typeof n.order === 'number' && isFinite(n.order));
    for (const list of buckets.values()) {
      if (list.every(ranked)) continue;
      // Renumber a bucket that isn't fully ordered yet. Items that already carry
      // an order keep their relative places; the rest fall in behind them in the
      // outline's legacy order — groups first, then loose bubbles.
      list.slice().sort((a, b) => {
        const ra = ranked(a), rb = ranked(b);
        if (ra && rb) return a.order - b.order;
        if (ra !== rb) return ra ? -1 : 1;
        return (a.kind === 'container' ? 0 : 1) - (b.kind === 'container' ? 0 : 1);
      }).forEach((n, i) => { n.order = i; });
    }
  }

  // The children of a node — or the map's top level, for a null id — in outline
  // order. This is the one ordering the outline panel and every export share.
  function orderedChildren(parentId) {
    const key = parentId || '';
    return Object.values(map.nodes)
      .filter(n => n.id !== parentId && orderKey(n) === key)
      .sort((a, b) => (a.order || 0) - (b.order || 0));
  }

  // Put a freshly created node last among its siblings.
  function appendOrder(n) {
    const sibs = orderedChildren(n.parentId).filter(s => s.id !== n.id);
    n.order = sibs.length ? Math.max(...sibs.map(s => s.order || 0)) + 1 : 0;
  }

  // Every node beneath `id`, at any depth (a group's whole subtree).
  function descendantsOf(id) {
    const out = [];
    const walk = pid => {
      for (const kid of childrenOf(pid)) {
        if (kid.id === pid || out.includes(kid.id)) continue; // guard a bad parent chain
        out.push(kid.id);
        walk(kid.id);
      }
    };
    walk(id);
    return out;
  }

  // Add a sub-item under `parentId` — the outline's "+". A plain bubble is
  // promoted to a group first: in a mind map an idea with sub-ideas *is* a
  // group, and only groups can hold children.
  function addChildOf(parentId) {
    const p = map.nodes[parentId];
    if (!p) return null;
    if (p.kind !== 'container') {
      p.kind = 'container';
      p.r = Math.max(p.r, 150);
      p.mapRef = ''; // a group can't double as a link to another map
    }
    const id = newId();
    const n = {
      id, label: '', note: '', link: '', done: false,
      pos: add3(p.pos, mul(randUnit(), Math.max(20, p.r * 0.45))),
      r: 62, hue: p.hue, parentId: p.id, kind: 'bubble', mapRef: '', order: 0,
    };
    map.nodes[id] = n;
    appendOrder(n);
    clampInside(n);
    growContainer(p);
    selectedId = id;
    changed();
    if (opts.onSelect) opts.onSelect(id);
    return id;
  }

  // Add an item directly below `afterId` at the same outline level, pushing the
  // rest of that level down a slot.
  function addSiblingAfter(afterId) {
    const sib = map.nodes[afterId];
    if (!sib) return null;
    const parent = (sib.parentId && map.nodes[sib.parentId]) || null;
    const id = newId();
    const n = {
      id, label: '', note: '', link: '', done: false,
      pos: add3(sib.pos, mul(randUnit(), sib.r + 62 + 70)),
      r: 62, hue: sib.hue, parentId: parent ? parent.id : null,
      kind: 'bubble', mapRef: '', order: (sib.order || 0) + 1,
    };
    for (const s of orderedChildren(n.parentId)) {
      if ((s.order || 0) >= n.order) s.order = (s.order || 0) + 1;
    }
    map.nodes[id] = n;
    if (parent) { clampInside(n); growContainer(parent); }
    selectedId = id;
    changed();
    if (opts.onSelect) opts.onSelect(id);
    return id;
  }

  // A brand-new top-level item, for the outline's footer buttons. Deliberately
  // ignores the current selection — "add a topic" means a topic of its own, not
  // one wired to whatever happens to be selected on the canvas.
  function addRootItem(kind) {
    selectedId = null;
    const id = kind === 'container' ? addContainer() : addBubble();
    const n = map.nodes[id];
    if (n) { appendOrder(n); changed(); }
    return id;
  }

  // Swap an item with its previous (dir < 0) or next sibling in the outline.
  function moveInOutline(id, dir) {
    return moveToIndex(id, indexInOutline(id) + (dir < 0 ? -1 : 1));
  }

  function indexInOutline(id) {
    const n = map.nodes[id];
    return n ? orderedChildren(n.parentId).findIndex(s => s.id === id) : -1;
  }

  // Drop an item at `index` among its siblings (used by ↑/↓ and by dragging).
  // Renumbering the whole level keeps the orders dense and collision-free.
  function moveToIndex(id, index) {
    const n = map.nodes[id];
    if (!n) return false;
    const sibs = orderedChildren(n.parentId);
    const i = sibs.findIndex(s => s.id === id);
    if (i < 0 || index < 0 || index >= sibs.length || index === i) return false;
    sibs.splice(index, 0, sibs.splice(i, 1)[0]);
    sibs.forEach((s, k) => { s.order = k; });
    changed();
    return true;
  }

  // Delete a node by id — with its whole subtree, for a group. Unlike
  // deleteSelected this takes no confirmation of its own; the outline asks.
  function deleteNodeById(id) {
    const n = map.nodes[id];
    if (!n) return false;
    const doomed = [id, ...descendantsOf(id)];
    const parent = n.parentId && map.nodes[n.parentId];
    for (const d of doomed) delete map.nodes[d];
    map.edges = map.edges.filter(e => !doomed.includes(e.a) && !doomed.includes(e.b));
    if (parent) fitContainer(parent);
    if (doomed.includes(selectedId)) {
      selectedId = null;
      if (opts.onSelect) opts.onSelect(null);
    }
    changed();
    return true;
  }

  function moveIntoContainer(nodeId, containerId) {
    const n = map.nodes[nodeId];
    if (!n || n.kind === 'container') return;
    const old = n.parentId && map.nodes[n.parentId];
    if (containerId) {
      const c = map.nodes[containerId];
      if (!c || c.kind !== 'container') return;
      n.parentId = c.id;
      n.pos = add3(c.pos, mul(randUnit(), Math.max(20, c.r * 0.45)));
      clampInside(n);
      growContainer(c);
    } else {
      n.parentId = null;
      if (old) {
        n.pos = add3(old.pos, mul(norm(sub(n.pos, old.pos)), old.r + n.r + 50));
        fitContainer(old); // the child left — shrink the old group back down to fit
      }
    }
    changed();
  }

  /* ---------- auto-arrange (2D tidy) layout helpers ---------- */
  // Evenly pack `count` points on a flat z=0 disc (sunflower phyllotaxis);
  // neighboring points end up roughly `spacing` apart.
  function flatDisc(count, spacing) {
    const pts = [];
    const golden = Math.PI * (3 - Math.sqrt(5));
    for (let i = 0; i < count; i++) {
      const rr = spacing * Math.sqrt(i + 0.5);
      const th = golden * i;
      pts.push([Math.cos(th) * rr, Math.sin(th) * rr, 0]);
    }
    return pts;
  }

  // Force-directed layout: repulsion spreads items evenly, weighted-edge
  // springs keep connected items adjacent, gravity keeps the cloud compact.
  // items: [{ id, r, p:[x,y,z] }] — p is mutated. edges: [{ a, b, w }].
  // With `flat` set, starts are projected onto the z=0 plane and every random
  // jiggle stays in-plane, so all forces (and thus the result) are planar.
  function forceLayout(items, edges, gap, flat) {
    const rnd = flat
      ? () => { const t = Math.random() * Math.PI * 2; return [Math.cos(t), Math.sin(t), 0]; }
      : randUnit;
    if (flat) for (const it of items) it.p = [it.p[0], it.p[1], 0];
    const n = items.length;
    if (n < 2) { if (n === 1) items[0].p = [0, 0, 0]; return; }
    const idx = new Map(items.map((it, i) => [it.id, i]));
    const avgR = items.reduce((s, i) => s + i.r, 0) / n;
    const k = avgR * 2 + gap; // ideal neighbor spacing

    // scatter exactly-coincident starts so forces have a direction to act on
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
      if (len(sub(items[i].p, items[j].p)) < 1) {
        items[j].p = add3(items[j].p, mul(rnd(), 5 + Math.random() * 10));
      }
    }

    const iters = n > 200 ? 70 : n > 80 ? 140 : 280; // fewer passes on huge maps

    // connected pairs get almost no long-range repulsion — their spring alone
    // sets the distance, so edge weight maps directly onto visible closeness
    const linked = new Map(); // "i|j" (i<j) → strongest weight between the pair
    for (const e of edges) {
      const i = idx.get(e.a), j = idx.get(e.b);
      if (i === undefined || j === undefined || i === j) continue;
      const key = i < j ? i + '|' + j : j + '|' + i;
      linked.set(key, Math.max(linked.get(key) || 0, e.w || 1));
    }

    let temp = k * Math.cbrt(n);
    const cool = Math.pow(0.02, 1 / iters);
    for (let it = 0; it < iters; it++) {
      const disp = items.map(() => [0, 0, 0]);
      const cutoff = k * 2.5; // repulsion is local-only, so gravity can pack the cloud densely
      for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
        let d = sub(items[i].p, items[j].p);
        let dist = len(d);
        if (dist < 1) { d = rnd(); dist = 1; }
        const minD = items[i].r + items[j].r + gap;
        if (dist > cutoff && dist > minD) continue; // far apart and not touching: no push
        // full repulsion between unrelated items; barely any between linked ones
        // (the overlap shove still applies to both so bodies never interpenetrate)
        const scale = dist < minD ? 4 : linked.has(i + '|' + j) ? 0.1 : 1;
        const f = (k * k) / dist * scale;
        const push = mul(d, f / dist);
        disp[i] = add3(disp[i], push);
        disp[j] = sub(disp[j], push);
      }
      for (const e of edges) {
        const i = idx.get(e.a), j = idx.get(e.b);
        if (i === undefined || j === undefined) continue;
        let d = sub(items[j].p, items[i].p);
        const dist = len(d) || 1;
        // weight 10 → practically touching; weight 1 → a loose (but short) leash
        const ideal = items[i].r + items[j].r + 16 + Math.max(0, 10 - e.w) * 22;
        const f = (dist - ideal) * (0.06 + e.w * 0.02); // heavier = stiffer spring
        const pull = mul(d, f / dist);
        disp[i] = add3(disp[i], pull);
        disp[j] = sub(disp[j], pull);
      }
      for (let i = 0; i < n; i++) {
        disp[i] = add3(disp[i], mul(items[i].p, -0.055)); // gravity toward the origin
        const dl = len(disp[i]);
        if (dl > temp) disp[i] = mul(disp[i], temp / dl);
        items[i].p = add3(items[i].p, disp[i]);
      }
      temp *= cool;
    }

    // hard de-overlap: nudge apart any pair still closer than their bodies allow
    for (let pass = 0; pass < 40; pass++) {
      let moved = false;
      for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
        let d = sub(items[j].p, items[i].p);
        let dist = len(d);
        if (dist < 1) { d = rnd(); dist = 1; }
        const minD = items[i].r + items[j].r + Math.min(gap, 30);
        if (dist < minD) {
          const shift = mul(d, (minD - dist) / dist / 2);
          items[i].p = sub(items[i].p, shift);
          items[j].p = add3(items[j].p, shift);
          moved = true;
        }
      }
      if (!moved) break;
    }

    // recenter the cloud on the origin (where the default camera looks)
    const c = mul(items.reduce((s, i) => add3(s, i.p), [0, 0, 0]), 1 / n);
    for (const it of items) it.p = sub(it.p, c);
  }
  /* ---------- end auto-arrange layout helpers ---------- */

  function easeInOut(t) { return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; }

  function finishArrange() {
    if (!arranging) return;
    for (const [id, to] of Object.entries(arranging.to)) {
      const nd = map.nodes[id];
      if (nd) nd.pos = [...to];
    }
    arranging = null;
    if (opts.onChange) opts.onChange(); // persist the arranged layout
  }

  // Tidy the whole map into a clean, evenly-spread 2D layout and fit it on
  // screen. Group children pack onto flat discs inside their container;
  // top-level bubbles and groups spread with a planar force-directed layout.
  function autoArrange() {
    const all = Object.values(map.nodes);
    if (!all.length || arranging) return false;

    // 1) inside each group: pack children on a flat disc sized to fit them
    const containerKids = new Map();
    for (const nd of all) if (nd.kind === 'container') containerKids.set(nd.id, []);
    for (const nd of all) {
      if (nd.parentId && containerKids.has(nd.parentId)) containerKids.get(nd.parentId).push(nd);
    }
    const newSize = new Map();     // containerId → radius that snugly fits its children
    const childOffset = new Map(); // childId → flat offset from its container's center
    for (const [cid, kids] of containerKids) {
      if (!kids.length) { newSize.set(cid, GROUP_MIN_R); continue; }
      const mr = Math.max(...kids.map(kd => kd.r));
      const spacing = 2 * mr + 24;
      const pts = kids.length === 1 ? [[0, 0, 0]] : flatDisc(kids.length, spacing);
      kids.forEach((kd, i) => childOffset.set(kd.id, pts[i]));
      // radius to the farthest child's outer edge (+ padding) — a snug fit
      let discR = 0;
      for (const p of pts) discR = Math.max(discR, Math.hypot(p[0], p[1]));
      newSize.set(cid, Math.max(GROUP_MIN_R, discR + mr + GROUP_PAD));
    }

    // 2) top level (loose bubbles + groups): force-directed spread in the plane.
    // Edges that reach inside a group count as edges to the group itself.
    const isTop = nd => !(nd.parentId && map.nodes[nd.parentId]);
    const items = all.filter(isTop).map(nd => ({
      id: nd.id,
      r: nd.kind === 'container' ? (newSize.get(nd.id) || nd.r) : nd.r,
      p: [...nd.pos],
    }));
    const rep = id => {
      const nd = map.nodes[id];
      return nd && nd.parentId && map.nodes[nd.parentId] ? nd.parentId : id;
    };
    const topEdges = new Map();
    for (const e of map.edges) {
      const a = rep(e.a), b = rep(e.b);
      if (a === b) continue;
      const key = a < b ? a + '|' + b : b + '|' + a;
      const prev = topEdges.get(key);
      if (!prev || e.w > prev.w) topEdges.set(key, { a, b, w: e.w });
    }
    forceLayout(items, [...topEdges.values()], 40, true);

    // 3) collect targets; children ride along with their group (flat offsets,
    // so they land in the same plane)
    const to = {};
    for (const it of items) {
      to[it.id] = it.p;
      const kids = containerKids.get(it.id);
      if (kids) for (const kd of kids) to[kd.id] = add3(it.p, childOffset.get(kd.id));
    }
    for (const [cid, r] of newSize) { const c = map.nodes[cid]; if (c) c.r = r; }
    buildDOM();

    // 4) face the plane straight-on and stop the spin so it stays 2D on screen;
    // pull the camera back just far enough that the whole layout fits
    yaw = 0; pitch = 0;
    pivot = [0, 0, 0];
    centeredId = null;
    spinning = false;
    let extent = 200;
    for (const it of items) {
      extent = Math.max(extent, Math.hypot(it.p[0], it.p[1]) + it.r);
    }
    const half = Math.max(120, Math.min(host.clientWidth || 800, host.clientHeight || 600) / 2 - 40);
    camDist = Math.min(3200, Math.max(300, (FOCAL * extent) / half));

    // 5) glide everything to its new spot, then save
    const from = {};
    for (const id of Object.keys(to)) from[id] = [...map.nodes[id].pos];
    arranging = { t0: performance.now(), dur: 750, from, to };
    return true;
  }

  /* ---------- public API ---------- */
  return {
    setMap(m, opts) {
      map = { nodes: {}, edges: [] };
      const nodes = (m && m.nodes) || {};
      for (const [id, n] of Object.entries(nodes)) {
        map.nodes[id] = {
          id,
          label: n.label || '',
          note: n.note || '',
          link: n.link || '',
          done: !!n.done,
          pos: Array.isArray(n.pos) ? [n.pos[0] || 0, n.pos[1] || 0, 0] : [0, 0, 0], // flat 2D: z always 0
          r: n.r || 62,
          hue: n.hue || 0,
          parentId: n.parentId || null,
          kind: n.kind === 'container' ? 'container' : 'bubble',
          mapRef: n.mapRef || '', // a bubble linking to another map (a "map bubble")
          // position among its siblings in the outline; null until numbered
          order: (typeof n.order === 'number' && isFinite(n.order)) ? n.order : null,
        };
      }
      map.edges = ((m && m.edges) || []).map(e => ({ id: e.id, a: e.a, b: e.b, w: e.w || 3 }));
      normalizeOrder();
      idCounter = 1;
      hueCounter = Object.keys(map.nodes).length;
      selectedId = null;
      connectFrom = null;
      highlightedEdge = null;
      hoverId = null;
      hoverEdgeId = null;
      hoverLock = false;
      lastTap = null;
      arranging = null; // never carry an in-flight arrange into another map
      hueOverride = null; // color choice is per-map-session; back to auto-cycling
      // load the persisted anchor and start the view centered on it (else origin)
      anchorId = m && m.anchorId && map.nodes[m.anchorId] ? m.anchorId : null;
      pivot = anchorId ? [...map.nodes[anchorId].pos] : [0, 0, 0];
      centeredId = anchorId; // anchored maps open in orbit mode, others in pan mode
      clearTimeout(pendingTimer); pendingTimer = null;
      clearTimeout(dwellTimer); dwellTimer = null;
      buildDOM();
      // fit the whole map into view when a map is opened/selected (not on live
      // remote updates, which preserve the viewer's camera). Deferred a frame so
      // the host has its real size if the section just became visible.
      if (opts && opts.fit) {
        centeredId = null; // frame the map flat rather than orbiting the anchor
        requestAnimationFrame(fitView);
      }
    },
    // Apply a map that arrived from another user, preserving this user's
    // camera, spin, and selection. Skipped mid-drag so we never yank a bubble
    // out from under the cursor — the next remote update reconciles it.
    applyRemote(m) {
      if (drag && (drag.type === 'node' || drag.type === 'edgeTap')) return false;
      const keepSel = selectedId;
      const keepConnect = connectFrom;
      map = { nodes: {}, edges: [] };
      const nodes = (m && m.nodes) || {};
      for (const [id, n] of Object.entries(nodes)) {
        map.nodes[id] = {
          id,
          label: n.label || '',
          note: n.note || '',
          link: n.link || '',
          done: !!n.done,
          pos: Array.isArray(n.pos) ? [n.pos[0] || 0, n.pos[1] || 0, 0] : [0, 0, 0], // flat 2D: z always 0
          r: n.r || 62,
          hue: n.hue || 0,
          parentId: n.parentId || null,
          kind: n.kind === 'container' ? 'container' : 'bubble',
          mapRef: n.mapRef || '', // a bubble linking to another map (a "map bubble")
          // position among its siblings in the outline; null until numbered
          order: (typeof n.order === 'number' && isFinite(n.order)) ? n.order : null,
        };
      }
      map.edges = ((m && m.edges) || []).map(e => ({ id: e.id, a: e.a, b: e.b, w: e.w || 3 }));
      normalizeOrder();
      hueCounter = Object.keys(map.nodes).length;
      selectedId = map.nodes[keepSel] ? keepSel : null;
      connectFrom = map.nodes[keepConnect] ? keepConnect : null;
      if (highlightedEdge && !map.edges.some(e => e.id === highlightedEdge)) highlightedEdge = null;
      // pick up an anchor change from a collaborator without yanking the camera
      anchorId = m && m.anchorId && map.nodes[m.anchorId] ? m.anchorId : null;
      if (centeredId && !map.nodes[centeredId]) centeredId = null; // centered node was deleted
      buildDOM();
      return true;
    },
    // include the anchor so it persists with nodes/edges on save
    getMap: () => ({ nodes: map.nodes, edges: map.edges, anchorId }),
    getNode: id => map.nodes[id],
    getEdge: id => map.edges.find(e => e.id === id),
    getSelected: () => (selectedId && map.nodes[selectedId]) || null,
    containers,
    start() { if (!running) { running = true; requestAnimationFrame(frame); } },
    stop() { running = false; },
    addBubble, addMapLinkBubble, addContainer, deleteSelected, renameSelected, renameNode, setNote,
    setLink, setDone, loadGenerated,
    // outline editing: add / reorder / delete by id, and the shared sibling order
    addChildOf, addSiblingAfter, addRootItem, moveInOutline, moveToIndex, indexInOutline,
    deleteNodeById, orderedChildren,
    setWeight, deleteEdge, moveIntoContainer, autoArrange,
    // colors: recolor an existing node / pick the color for future bubbles
    setNodeHue(id, hue) {
      const n = map.nodes[id];
      if (!n) return;
      n.hue = Math.max(0, Math.min(HUES.length - 1, Math.floor(hue) || 0));
      changed();
    },
    setHueOverride(h) {
      hueOverride = (h === null || h === undefined) ? null
        : Math.max(0, Math.min(HUES.length - 1, Math.floor(h)));
    },
    getHueOverride: () => hueOverride,
    startConnect() {
      const n = selectedId && map.nodes[selectedId];
      if (!n) return false;
      connectFrom = n.id;
      updateSelectionClasses();
      return true;
    },
    cancelConnect() { connectFrom = null; updateSelectionClasses(); },
    isConnecting: () => !!connectFrom,
    setHighlightedEdge(id) { highlightedEdge = id; },
    selectNode(id) {
      if (!map.nodes[id]) return;
      selectedId = id;
      updateSelectionClasses();
      if (opts.onSelect) opts.onSelect(id);
    },
    // select a node and pan the view to center it (used by the outline)
    focusNode(id) {
      const n = map.nodes[id];
      if (!n) return false;
      selectedId = id;
      pivot = [...n.pos];
      updateSelectionClasses();
      if (opts.onSelect) opts.onSelect(id);
      return true;
    },
    // center the rotation on a node (used by read-only viewers)
    centerOnNode(id) {
      const n = map.nodes[id];
      if (!n) return false;
      pivot = [...n.pos];
      centeredId = id;
      return true;
    },
    setPickHover(hit) { applyHover(hit); },
    setHoverLock(b) {
      hoverLock = b;
      clearTimeout(dwellTimer); dwellTimer = null;
      if (!b) applyHover(null); // next frame recomputes from the real cursor
    },
    zoom(f) { camDist = Math.min(3200, Math.max(300, camDist * f)); },
    // reset view = fit the whole map on screen, centered
    resetCamera() { fitView(); },
    setShowWeights(b) { showWeights = b; },
    getShowWeights: () => showWeights,
  };

  // Center the pivot on the content's bounding box and pick a zoom that fits
  // it comfortably on screen (with a margin). Used by "reset view".
  function fitView() {
    const all = Object.values(map.nodes);
    if (!all.length) { pivot = [0, 0, 0]; camDist = 950; return; }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of all) {
      minX = Math.min(minX, n.pos[0] - n.r); maxX = Math.max(maxX, n.pos[0] + n.r);
      minY = Math.min(minY, n.pos[1] - n.r); maxY = Math.max(maxY, n.pos[1] + n.r);
    }
    pivot = [(minX + maxX) / 2, (minY + maxY) / 2, 0];
    const w = host.clientWidth || 800, h = host.clientHeight || 600;
    const halfW = Math.max(200, (maxX - minX) / 2 + 60);
    const halfH = Math.max(160, (maxY - minY) / 2 + 60);
    // camDist so FOCAL/camDist * half-extent fits within the half-viewport
    const need = Math.max((FOCAL * halfW) / (w / 2), (FOCAL * halfH) / (h / 2));
    camDist = Math.min(3200, Math.max(300, need));
  }
}

/* ================================================================
   App state + router
================================================================ */
let me = null;
let myMap = null;        // editable map view
let profileMap = null;   // read-only map view
let currentProfile = null;
let saveTimer = null;
let mapsMine = [];       // my maps (metas, incl. editors)
let mapsShared = [];     // maps I can edit, owned by others
let currentMapId = null;
let currentMapInfo = null; // { owner, isOwner, canEdit } for the open map
let liveSource = null;   // EventSource for the currently open map
let chatItems = [];      // chat + activity entries for the open map
let chatOpen = false;
let chatUnread = 0;

const sections = ['auth', 'home', 'map', 'desk', 'browse', 'friends', 'profile', 'settings', 'privacy', 'terms', 'soul'];

function show(name) {
  if (name !== 'desk') flushDeskSave(); // don't leave a board edit sitting in a timer
  if (name !== 'profile') hideNoteViewer(); // the note reader belongs to the profile map
  // the outline serves both the editor and the profile viewer; close it only when
  // leaving both (the rebuild for the new map happens after visibility flips below)
  if (name !== 'map' && name !== 'profile' && outlineOpen) toggleOutline(false);
  $('#btnAI').hidden = !(me && me.aiEnabled); // AI button only when the server enables it
  for (const s of sections) $('#view-' + s).hidden = s !== name;
  // now that the active section is set, rebuild the outline against its map
  if (outlineOpen && (name === 'map' || name === 'profile')) buildOutline();
  // hide the top bar (and its hamburger) only on the full-screen auth card
  $('#topbar').hidden = name === 'auth';
  $('#navToggle').hidden = name === 'auth';
  // auth-only nav links are hidden for anonymous visitors; show a Sign in link instead
  for (const a of document.querySelectorAll('#mainNav a[data-auth]')) a.hidden = !me;
  $('#notifWrap').hidden = !me; // the bell lives outside the nav; toggle it too
  $('#navSignIn').hidden = !!me;
  for (const a of document.querySelectorAll('#mainNav a')) {
    a.classList.toggle('active', a.dataset.nav === name);
  }
  if (myMap) { name === 'map' ? myMap.start() : myMap.stop(); }
  if (profileMap) { name === 'profile' ? profileMap.start() : profileMap.stop(); }
  if (name !== 'profile') closeComments(); // the comment panel belongs to the profile viewer
}

function route() {
  closeSheets();
  hidePickMenu();
  closeNavMenu(); // any navigation closes the mobile hamburger menu
  const h = location.hash.replace(/^#\/?/, '') || (me ? 'home' : 'browse');

  // legal pages are public — reachable signed in or not (soul = the joke draft)
  if (h === 'privacy' || h === 'terms' || h === 'soul') { show(h); window.scrollTo(0, 0); return; }

  // someone's shared desk: #/desk/<username>, plus the code when it is
  // link-shared. Open to signed-out visitors, so it sits ahead of the sign-in gate.
  const sharedDesk = h.match(/^desk\/([a-z0-9_]{3,20})(?:\/([A-Z2-9]{4,40}))?$/);
  if (sharedDesk) { show('desk'); loadSharedDesk(sharedDesk[1], sharedDesk[2] || ''); return; }

  if (!me) {
    // anonymous visitors may browse public maps and profiles;
    // everything else prompts them to sign in
    if (h.startsWith('u/')) { openProfile(h.slice(2)); return; }
    if (h === 'browse') { show('browse'); loadBrowse(); return; }
    show('auth'); // #/signin, #/map, #/friends, #/settings all land here
    return;
  }

  if (h.startsWith('u/')) { openProfile(h.slice(2)); return; }
  if (h === 'home') { show('home'); loadFeed(); return; }
  if (h === 'desk') { show('desk'); loadDesk(); return; }
  if (h === 'browse') { show('browse'); loadBrowse(); return; }
  if (h === 'friends') { show('friends'); loadFriends(); return; }
  if (h === 'settings') { show('settings'); fillSettings(); return; }
  show('map');
}
window.addEventListener('hashchange', route);

/* ================================================================
   Mobile hamburger menu (top nav)
================================================================ */
const navToggle = $('#navToggle');
const mainNav = $('#mainNav');

function openNavMenu() {
  mainNav.classList.add('open');
  navToggle.setAttribute('aria-expanded', 'true');
}
function closeNavMenu() {
  mainNav.classList.remove('open');
  navToggle.setAttribute('aria-expanded', 'false');
}

navToggle.addEventListener('click', e => {
  e.stopPropagation();
  mainNav.classList.contains('open') ? closeNavMenu() : openNavMenu();
});
// tap a link closes it (route() also closes on hash change, but same-hash taps
// wouldn't fire that); tap anywhere outside closes it too
mainNav.addEventListener('click', e => { if (e.target.closest('a')) closeNavMenu(); });
document.addEventListener('click', e => {
  if (mainNav.classList.contains('open') &&
      !mainNav.contains(e.target) && !navToggle.contains(e.target)) closeNavMenu();
});

/* ================================================================
   Sheets
================================================================ */
const sheetShade = $('#sheetShade');
const allSheets = ['#sheetRename', '#sheetEdge', '#sheetGroup', '#sheetColor', '#sheetNewMap', '#sheetMapLink', '#sheetMapSettings', '#sheetAI', '#sheetExport', '#sheetDeleteAccount', '#sheetDeskShare'];

function openSheet(sel) {
  closeSheets();
  sheetShade.hidden = false;
  $(sel).hidden = false;
}
function closeSheets() {
  sheetShade.hidden = true;
  for (const s of allSheets) $(s).hidden = true;
  // note: rename/edge targets are NOT cleared here — openSheet() calls this
  // right before a sheet opens, and the guards on the hidden sheets make
  // stale targets harmless.
  if (myMap) myMap.setHighlightedEdge(null);
}
function anySheetOpen() { return allSheets.some(s => !$(s).hidden) || !$('#pickMenu').hidden; }
sheetShade.addEventListener('pointerdown', () => { commitRenameIfOpen(); closeSheets(); });

/* ---------- edit sheet (name + notes) ---------- */
let renameTarget = null;
// focusField: 'label' (default, used on add/rename) or 'note' (used by 📝 Note)
function openRename(nodeId, focusField) {
  const n = myMap.getNode(nodeId);
  if (!n) return;
  renameTarget = nodeId;
  openSheet('#sheetRename');
  const isGroup = n.kind === 'container';
  $('#renameTitle').textContent = isGroup ? 'Edit group' : 'Edit bubble';
  const input = $('#renameInput');
  input.value = n.label === 'Untitled' ? '' : n.label;
  input.placeholder = isGroup ? 'Name this group…' : 'Type an idea…';
  const note = $('#noteInput');
  note.value = n.note || '';
  $('#linkInput').value = n.link || '';
  $('#doneInput').checked = !!n.done;
  requestAnimationFrame(() => {
    if (focusField === 'note') { note.focus(); note.select(); }
    else { input.focus(); input.select(); }
  });
}
function commitRenameIfOpen() {
  if (renameTarget && !$('#sheetRename').hidden) {
    myMap.renameNode(renameTarget, $('#renameInput').value);
    myMap.setNote(renameTarget, $('#noteInput').value);
    myMap.setLink(renameTarget, $('#linkInput').value);
    myMap.setDone(renameTarget, $('#doneInput').checked);
    refreshToolbar(); // reflect a note being added/removed on the Note button
    refreshOutlineIfOpen();
  }
}
$('#renameSave').addEventListener('click', () => { commitRenameIfOpen(); closeSheets(); });
$('#renameCancel').addEventListener('click', () => closeSheets());
$('#renameInput').addEventListener('keydown', e => {
  e.stopPropagation();
  // Enter in the name field saves right away (keeps the quick add-and-name flow)
  if (e.key === 'Enter') { commitRenameIfOpen(); closeSheets(); }
  if (e.key === 'Escape') closeSheets();
});
$('#noteInput').addEventListener('keydown', e => {
  e.stopPropagation(); // Enter here is a newline; don't trigger global shortcuts
  // Cmd/Ctrl+Enter saves without hunting for the button
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { commitRenameIfOpen(); closeSheets(); }
  if (e.key === 'Escape') closeSheets();
});
$('#linkInput').addEventListener('keydown', e => {
  e.stopPropagation();
  if (e.key === 'Enter') { commitRenameIfOpen(); closeSheets(); }
  if (e.key === 'Escape') closeSheets();
});

/* ---------- edge (weight) sheet ---------- */
let edgeTarget = null;
function openEdgeSheet(edgeId) {
  const e = myMap.getEdge(edgeId);
  if (!e) return;
  edgeTarget = edgeId;
  openSheet('#sheetEdge');
  myMap.setHighlightedEdge(edgeId);
  const na = myMap.getNode(e.a), nb = myMap.getNode(e.b);
  $('#edgeEnds').textContent = `${na ? na.label || 'Untitled' : '?'}  ↔  ${nb ? nb.label || 'Untitled' : '?'}`;
  $('#weightSlider').value = e.w;
  $('#weightValue').textContent = e.w;
}
$('#weightSlider').addEventListener('input', () => {
  const w = +$('#weightSlider').value;
  $('#weightValue').textContent = w;
  if (edgeTarget) myMap.setWeight(edgeTarget, w);
});
$('#edgeDelete').addEventListener('click', () => {
  if (edgeTarget) myMap.deleteEdge(edgeTarget);
  closeSheets();
});
$('#edgeDone').addEventListener('click', () => closeSheets());

/* ---------- group sheet ---------- */
function openGroupSheet() {
  const sel = myMap.getSelected();
  if (!sel || sel.kind === 'container') return;
  openSheet('#sheetGroup');
  const box = $('#groupOptions');
  box.innerHTML = '';
  $('#groupSheetTitle').textContent = sel.parentId ? 'Move bubble' : 'Move into group';

  if (sel.parentId) {
    const btn = document.createElement('button');
    btn.className = 'tb';
    const c = myMap.getNode(sel.parentId);
    btn.textContent = `⤴ Take out of "${c ? c.label || 'Untitled' : '?'}"`;
    btn.addEventListener('click', () => { myMap.moveIntoContainer(sel.id, null); closeSheets(); });
    box.appendChild(btn);
  }

  const others = myMap.containers().filter(c => c.id !== sel.parentId);
  for (const c of others) {
    const btn = document.createElement('button');
    btn.className = 'tb';
    btn.textContent = `◯ Move into "${c.label || 'Untitled'}"`;
    btn.addEventListener('click', () => { myMap.moveIntoContainer(sel.id, c.id); closeSheets(); });
    box.appendChild(btn);
  }
  if (!sel.parentId && others.length === 0) {
    const p = document.createElement('div');
    p.className = 'empty';
    p.textContent = 'No groups yet — tap “+ Group” to create a container bubble first.';
    box.appendChild(p);
  }
}

/* ---------- color sheet + copy-color (eyedropper) mode ---------- */
let colorCopyTarget = null; // node waiting to receive a color copied from another bubble

function swatchButton(i, isSel, onPick) {
  const h = HUES[i];
  const b = document.createElement('button');
  b.className = 'swatch' + (isSel ? ' sel' : '');
  b.style.background = `radial-gradient(circle at 32% 28%, ${h.lite}, ${h.main} 60%, ${h.dark} 130%)`;
  b.title = 'Use this color';
  b.addEventListener('click', () => onPick(i));
  return b;
}

function renderSwatches() {
  const sel = myMap.getSelected();
  $('#colorSelWrap').hidden = !sel;
  const rowSel = $('#swatchSel');
  rowSel.innerHTML = '';
  if (sel) {
    for (let i = 0; i < HUES.length; i++) {
      rowSel.appendChild(swatchButton(i, (sel.hue || 0) % HUES.length === i, pick => {
        myMap.setNodeHue(sel.id, pick);
        renderSwatches(); // live: the bubble recolors behind the sheet
      }));
    }
  }
  const rowNew = $('#swatchNew');
  rowNew.innerHTML = '';
  const auto = document.createElement('button');
  auto.className = 'tb' + (myMap.getHueOverride() === null ? ' active' : '');
  auto.textContent = 'Auto';
  auto.title = 'Cycle through the palette automatically';
  auto.addEventListener('click', () => { myMap.setHueOverride(null); renderSwatches(); });
  rowNew.appendChild(auto);
  for (let i = 0; i < HUES.length; i++) {
    rowNew.appendChild(swatchButton(i, myMap.getHueOverride() === i, pick => {
      myMap.setHueOverride(pick);
      renderSwatches();
    }));
  }
  $('#colorModeNote').textContent = myMap.getHueOverride() === null
    ? 'New bubbles cycle through the palette; bubbles added inside a group match the group.'
    : 'New bubbles (and bubbles added inside groups) will use the chosen color.';
}

function openColorSheet() {
  openSheet('#sheetColor');
  renderSwatches();
}

$('#colorDone').addEventListener('click', () => closeSheets());
$('#btnCopyColor').addEventListener('click', () => {
  const sel = myMap.getSelected();
  if (!sel) return;
  colorCopyTarget = sel.id;
  closeSheets();
  setHint('Now tap the bubble whose color you want to copy', true);
});

/* ================================================================
   Pick menu — choose between overlapping elements
================================================================ */
const pickMenu = $('#pickMenu');
let pickAnchor = null;
let pickView = null; // the map view the currently-open pick menu belongs to

function describeHit(view, hit) {
  if (hit.type === 'node') {
    const n = view.getNode(hit.id);
    if (!n) return null;
    return {
      color: hueOf(n).main,
      label: n.label || 'Untitled',
      tag: n.kind === 'container' ? 'group' : 'bubble',
      isLine: false,
    };
  }
  const e = view.getEdge(hit.id);
  if (!e) return null;
  const na = view.getNode(e.a), nb = view.getNode(e.b);
  return {
    color: na ? hueOf(na).main : '#8A93A6',
    label: `${na ? na.label || 'Untitled' : '?'} ↔ ${nb ? nb.label || 'Untitled' : '?'}`,
    tag: 'weight ' + e.w,
    isLine: true,
  };
}

// A view is "center-only" (read-only viewer) if it exposes centerOnNode but
// isn't the editor; there, the pick menu lists bubbles/groups to revolve around.
function makePickHandler(view) {
  const centerOnly = view !== myMap && typeof view.centerOnNode === 'function';
  return (hits, cx, cy, mode) => showPickMenu(view, centerOnly, hits, cx, cy, mode);
}

function showPickMenu(view, centerOnly, hits, cx, cy, mode) {
  if (allSheets.some(s => !$(s).hidden)) return; // never open over a bottom sheet
  pickMenu.innerHTML = '';
  pickMenu.dataset.mode = mode;
  pickAnchor = { x: cx, y: cy };
  pickView = view;
  // when the menu only picks a center of rotation, edges aren't selectable
  const items = centerOnly ? hits.filter(h => h.type === 'node') : hits;
  for (const hit of items) {
    const d = describeHit(view, hit);
    if (!d) continue;
    const item = document.createElement('button');
    item.className = 'pick-item';
    const dot = document.createElement('span');
    dot.className = 'pick-dot' + (d.isLine ? ' line-dot' : '');
    dot.style.setProperty('--pc', d.color);
    const lb = document.createElement('span');
    lb.className = 'pick-label';
    lb.textContent = d.label;
    const tag = document.createElement('span');
    tag.className = 'pick-tag';
    tag.textContent = centerOnly ? 'center on' : d.tag;
    item.appendChild(dot);
    item.appendChild(lb);
    item.appendChild(tag);
    item.addEventListener('pointerenter', () => view.setPickHover(hit));
    item.addEventListener('pointerleave', () => view.setPickHover(null));
    item.addEventListener('click', () => {
      hidePickMenu();
      if (centerOnly) { view.centerOnNode(hit.id); }
      else if (hit.type === 'node') view.selectNode(hit.id);
      else openEdgeSheet(hit.id);
    });
    pickMenu.appendChild(item);
  }
  if (!pickMenu.children.length) return;
  view.setHoverLock(true);
  pickMenu.hidden = false;
  const r = pickMenu.getBoundingClientRect();
  pickMenu.style.left = Math.max(8, Math.min(cx + 6, window.innerWidth - r.width - 8)) + 'px';
  pickMenu.style.top = Math.max(8, Math.min(cy + 6, window.innerHeight - r.height - 8)) + 'px';
}

function hidePickMenu() {
  if (pickMenu.hidden) return;
  pickMenu.hidden = true;
  pickAnchor = null;
  const v = pickView || myMap;
  if (v) { v.setPickHover(null); v.setHoverLock(false); }
  pickView = null;
}

// tap/click anywhere outside closes it
window.addEventListener('pointerdown', e => {
  if (!pickMenu.hidden && !pickMenu.contains(e.target)) hidePickMenu();
}, true);

// a hover-opened menu goes away when the mouse wanders off
window.addEventListener('pointermove', e => {
  if (pickMenu.hidden || pickMenu.dataset.mode !== 'hover') return;
  if (pickMenu.contains(e.target)) return;
  if (pickAnchor && Math.hypot(e.clientX - pickAnchor.x, e.clientY - pickAnchor.y) > 90) hidePickMenu();
});

window.addEventListener('keydown', e => {
  if (e.key === 'Escape') hidePickMenu();
});

/* ================================================================
   My map (editor) wiring
================================================================ */
const hintEl = $('#mapHint');
const DEFAULT_HINT = 'Tap to select · Drag a bubble to move it · Drag background to pan · Pinch/scroll to zoom';

function setHint(text, accent) {
  hintEl.textContent = text;
  hintEl.classList.toggle('accent', !!accent);
}

let mapDirty = false;

function saveMap() {
  if (!currentMapId) return;
  refreshOutlineIfOpen(); // keep the outline in sync with edits
  mapDirty = true;
  clearTimeout(saveTimer);
  const state = $('#saveState');
  state.hidden = false;
  state.textContent = 'Saving…';
  const id = currentMapId;
  saveTimer = setTimeout(() => doSave(id), 800);
}

async function doSave(id) {
  if (id !== currentMapId) return; // switched maps; flushSave already handled it
  const state = $('#saveState');
  try {
    await api('/api/maps/' + id, 'PUT', { map: myMap.getMap() });
    mapDirty = false;
    state.textContent = 'Saved ✓';
    setTimeout(() => { if (state.textContent === 'Saved ✓') state.hidden = true; }, 1500);
  } catch (err) {
    if (err.status === 403 || err.status === 404) {
      // edit permission was revoked (or the map is gone) — stop retrying
      mapDirty = false;
      state.textContent = 'No longer editable';
      alert('You no longer have edit access to this map.');
      loadMaps().catch(() => {});
      return;
    }
    state.textContent = 'Save failed — retrying…';
    saveTimer = setTimeout(() => doSave(id), 3000);
  }
}

// push any pending change for the current map before switching away from it
function flushSave() {
  clearTimeout(saveTimer);
  if (mapDirty && currentMapId) {
    mapDirty = false;
    api('/api/maps/' + currentMapId, 'PUT', { map: myMap.getMap() }).catch(() => {});
    $('#saveState').hidden = true;
  }
}

function refreshToolbar() {
  const sel = myMap ? myMap.getSelected() : null;
  $('#btnConnect').disabled = !sel;
  $('#btnRename').disabled = !sel;
  const noteBtn = $('#btnNote');
  noteBtn.disabled = !sel;
  const hasNote = !!sel && !!(sel.note && sel.note.trim());
  noteBtn.classList.toggle('active', hasNote);
  noteBtn.textContent = hasNote ? '📝 Note ✓' : '📝 Note';
  $('#btnDelete').disabled = !sel;
  $('#btnGroupMenu').disabled = !sel || sel.kind === 'container';
  $('#btnAddBubble').textContent = sel && sel.kind === 'container' ? '+ Bubble in group' : '+ Bubble';
}

/* ================================================================
   Outline view — the map as a collapsible text tree
================================================================ */
let outlineOpen = false;
const outlineCollapsed = new Set(); // group ids currently collapsed

// The map the outline/export act on: the read-only profile viewer when it's the
// active section, otherwise the editor. Lets the Outline panel and every export
// serve both the editor and view mode from one code path.
function onProfileView() { return !$('#view-profile').hidden; }
function activeMap() { return (onProfileView() && profileMap) ? profileMap : myMap; }

function toggleOutline(force) {
  outlineOpen = force === undefined ? !outlineOpen : force;
  $('#outlinePanel').hidden = !outlineOpen;
  $('#btnOutline').classList.toggle('active', outlineOpen);
  $('#btnPOutline').classList.toggle('active', outlineOpen);
  if (outlineOpen) buildOutline();
}
function refreshOutlineIfOpen() { if (outlineOpen) buildOutline(); }

// Who may change what, from the outline. Editing follows the map's edit
// permission (owner or a granted editor); rearranging is the owner's alone.
// The read-only profile viewer is never editable, whoever is looking at it.
function outlineEditable() {
  return activeMap() === myMap && !!(currentMapInfo && currentMapInfo.canEdit);
}
function outlineOwner() {
  return activeMap() === myMap && !!(currentMapInfo && currentMapInfo.isOwner);
}

function outlineStateText() {
  if (onProfileView()) return 'Read-only — open the map in the editor to change it.';
  if (!outlineEditable()) return 'Read-only.';
  return outlineOwner()
    ? 'Tap a row to find it on the map · drag ⠿ to reorder'
    : 'You can edit this outline · tap a row to find it on the map';
}

// A small round button in a row's action cluster.
function outlineBtn(glyph, title, fn, cls) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'outline-act' + (cls ? ' ' + cls : '');
  b.textContent = glyph;
  b.title = title;
  b.setAttribute('aria-label', title);
  b.addEventListener('click', e => { e.stopPropagation(); fn(); });
  return b;
}

function makeOutlineRow(n, depth, childrenOf, siblings, index) {
  const editable = outlineEditable();
  const owner = outlineOwner();
  const row = document.createElement('div');
  row.className = 'outline-row' + (n.kind === 'container' ? ' group' : '') + (n.done ? ' done' : '');
  row.dataset.id = n.id;
  row.style.paddingLeft = (8 + depth * 16) + 'px';

  // the owner drags this handle to rearrange the level; everyone else never
  // sees it, so the row keeps its full width
  if (owner) {
    const grip = document.createElement('span');
    grip.className = 'outline-grip';
    grip.textContent = '⠿';
    grip.title = 'Drag to reorder';
    grip.addEventListener('pointerdown', e => startOutlineDrag(e, n.id));
    row.appendChild(grip);
  }

  // a caret appears for anything that actually has children (groups and parent
  // bubbles alike); childless nodes keep the plain dot
  if (childrenOf(n.id).length) {
    const caret = document.createElement('button');
    caret.className = 'outline-caret';
    caret.textContent = outlineCollapsed.has(n.id) ? '▸' : '▾';
    caret.title = 'Collapse / expand';
    caret.addEventListener('click', e => {
      e.stopPropagation();
      if (outlineCollapsed.has(n.id)) outlineCollapsed.delete(n.id); else outlineCollapsed.add(n.id);
      buildOutline();
    });
    row.appendChild(caret);
  } else if (!editable) {
    const dot = document.createElement('span');
    dot.className = 'outline-dot';
    row.appendChild(dot);
  }

  // Editors get a real checkbox in place of the dot: ticking items off is the
  // whole point of studying from an outline.
  if (editable) {
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.className = 'outline-check';
    box.checked = !!n.done;
    box.title = n.done ? 'Mark as not done' : 'Mark as done';
    box.addEventListener('click', e => e.stopPropagation());
    box.addEventListener('change', () => myMap.setDone(n.id, box.checked));
    row.appendChild(box);
  }

  const label = document.createElement('span');
  label.className = 'outline-label';
  label.textContent = n.label || 'Untitled';
  row.appendChild(label);

  const meta = document.createElement('span');
  meta.className = 'outline-meta';
  const bits = [];
  if (n.mapRef) bits.push('🗺️');
  if (n.link) bits.push('🔗');
  if (n.note && n.note.trim()) bits.push('📝');
  meta.textContent = bits.join(' ');
  row.appendChild(meta);

  if (editable) {
    const acts = document.createElement('span');
    acts.className = 'outline-acts';
    if (owner) {
      const up = outlineBtn('↑', 'Move up', () => moveOutlineItem(n.id, -1));
      const down = outlineBtn('↓', 'Move down', () => moveOutlineItem(n.id, 1));
      up.disabled = index === 0;
      down.disabled = index === siblings.length - 1;
      acts.append(up, down);
    }
    acts.append(
      outlineBtn('✎', 'Edit this item — label, notes, link', () => openRename(n.id)),
      outlineBtn('＋', n.kind === 'container'
        ? 'Add a sub-item inside this group'
        : 'Add a sub-item (turns this into a group)', () => addOutlineChild(n.id)),
      outlineBtn('🗑', 'Delete this item', () => deleteOutlineItem(n.id), 'danger'),
    );
    row.appendChild(acts);
  }

  // the note itself renders on its own full-width line beneath the label, so
  // the outline reads like an annotated document rather than just flagging 📝
  if (n.note && n.note.trim()) {
    const note = document.createElement('div');
    note.className = 'outline-note';
    note.textContent = n.note.trim();
    row.appendChild(note);
  }

  // single click focuses the node on the canvas; double-click opens the editor
  // (the profile viewer is read-only, so it only centers)
  const inEditor = activeMap() === myMap;
  row.addEventListener('click', () => {
    if (outlineDrag || Date.now() - outlineDragEndedAt < 300) return; // tail of a drag
    const m = activeMap();
    if (inEditor) { m.focusNode(n.id); refreshToolbar(); }
    else if (m.centerOnNode) m.centerOnNode(n.id); // read-only viewer centers instead
  });
  if (editable) row.addEventListener('dblclick', () => openRename(n.id));
  return row;
}

/* ---------- outline edits ----------
   These all mutate the editor's map, whose onChange is saveMap — so each one
   autosaves, broadcasts to anyone else on the map, and rebuilds this panel
   through exactly the path a canvas edit takes. Nothing here saves by hand. */
function addOutlineChild(parentId) {
  if (!outlineEditable()) return;
  outlineCollapsed.delete(parentId); // reveal the new item in its parent
  const id = myMap.addChildOf(parentId);
  if (!id) return;
  refreshToolbar();
  openRename(id); // straight into naming it — an unnamed row helps nobody
}

function addOutlineRoot(kind) {
  if (!outlineEditable()) return;
  const id = myMap.addRootItem(kind);
  if (!id) return;
  refreshToolbar();
  openRename(id);
}

function deleteOutlineItem(id) {
  if (!outlineEditable()) return;
  const n = myMap.getNode(id);
  if (!n) return;
  const kids = myMap.orderedChildren(id).length;
  const what = '“' + (n.label || 'Untitled') + '”';
  if (!confirm(kids
    ? 'Delete ' + what + ' and the ' + kids + ' item' + (kids > 1 ? 's' : '') + ' inside it?'
    : 'Delete ' + what + '?')) return;
  myMap.deleteNodeById(id);
  refreshToolbar();
}

function moveOutlineItem(id, dir) {
  if (outlineOwner()) myMap.moveInOutline(id, dir);
}

/* ---------- drag to reorder (owner) ----------
   The grip keeps pointer capture for the whole gesture, so touch and mouse both
   track cleanly. We only highlight the row we would drop onto while dragging
   and commit on release — rebuilding the list mid-drag would destroy the very
   element holding the capture. Dragging reorders within one level only;
   re-parenting stays in the canvas's Group ▾ menu. */
let outlineDrag = null;       // { id, parentId, target }
let outlineDragEndedAt = 0;   // so the click that ends a drag doesn't also fire

function startOutlineDrag(e, id) {
  if (!outlineOwner()) return;
  e.preventDefault();
  e.stopPropagation();
  const n = myMap.getNode(id);
  if (!n) return;
  outlineDrag = { id, parentId: n.parentId || null, target: null };
  const grip = e.currentTarget;
  grip.setPointerCapture(e.pointerId);
  grip.addEventListener('pointermove', onOutlineDragMove);
  grip.addEventListener('pointerup', endOutlineDrag);
  grip.addEventListener('pointercancel', endOutlineDrag);
  markOutlineDrag();
}

function onOutlineDragMove(e) {
  if (!outlineDrag) return;
  const el = document.elementFromPoint(e.clientX, e.clientY);
  const row = el && el.closest ? el.closest('.outline-row') : null;
  let target = null;
  if (row && row.dataset.id && row.dataset.id !== outlineDrag.id) {
    const cand = myMap.getNode(row.dataset.id);
    if (cand && (cand.parentId || null) === outlineDrag.parentId) target = cand.id;
  }
  if (target !== outlineDrag.target) { outlineDrag.target = target; markOutlineDrag(); }
}

function markOutlineDrag() {
  for (const row of $('#outlineBody').querySelectorAll('.outline-row')) {
    row.classList.toggle('dragging', !!outlineDrag && row.dataset.id === outlineDrag.id);
    row.classList.toggle('drop-target', !!outlineDrag && row.dataset.id === outlineDrag.target);
  }
}

function endOutlineDrag() {
  if (!outlineDrag) return;
  const { id, target } = outlineDrag;
  outlineDrag = null;
  outlineDragEndedAt = Date.now();
  if (target) myMap.moveToIndex(id, myMap.indexInOutline(target));
  buildOutline(); // always: a drag that moved nothing still has classes to clear
}

function buildOutline() {
  const body = $('#outlineBody');
  body.innerHTML = '';
  const src = activeMap();
  if (!src) return;
  const editable = outlineEditable();
  $('#outlineState').textContent = outlineStateText();
  $('#outlineAdd').hidden = !editable;

  const { nodes, childrenOf, roots } = outlineStructure();
  if (!nodes.length) {
    const d = document.createElement('div');
    d.className = 'empty';
    d.textContent = editable
      ? 'Nothing here yet — add a topic below to start your outline.'
      : 'This map is empty.';
    body.appendChild(d);
    return;
  }

  // any node with children can be expanded, so sub-topics nest to any depth
  const addRow = (n, depth, siblings, index) => {
    body.appendChild(makeOutlineRow(n, depth, childrenOf, siblings, index));
    if (outlineCollapsed.has(n.id)) return;
    const kids = childrenOf(n.id);
    kids.forEach((k, i) => addRow(k, depth + 1, kids, i));
  };
  roots.forEach((n, i) => addRow(n, 0, roots, i));
}

// The name of the currently open map, for export titles/filenames. In view mode
// it comes from the active profile tab (or the map itself); in the editor from
// the map switcher.
function currentMapName() {
  if (onProfileView()) {
    const tab = $('#profileTabs') && $('#profileTabs').querySelector('.map-tab.active');
    if (tab && tab.textContent.trim()) return tab.textContent.trim();
    return profileMapName || 'Mind map';
  }
  const sel = $('#mapSelect');
  const opt = sel && sel.selectedOptions && sel.selectedOptions[0];
  const raw = (opt ? opt.textContent : '') || '';
  return raw.replace(/\s*👥.*$/, '').trim() || 'Mind map'; // strip the shared-with marker
}

// The ordered outline structure the panel and every export share.
//
// `roots` is top-level items only: a node whose parent exists is rendered by its
// parent, so listing it at the top level too would duplicate it. Every consumer
// walks `childrenOf` recursively, so nesting of any depth comes out as
// sub-topics — and both lists honour the order set in the outline panel.
function outlineStructure() {
  const src = activeMap();
  const nodes = Object.values(src.getMap().nodes || {});
  // The map view owns sibling order, so the panel, the exports, and anyone
  // rearranging rows all agree on one sequence. It also guards a corrupt parent
  // chain, which a naive recursive walk would follow forever.
  const childrenOf = id => src.orderedChildren(id);
  return { nodes, childrenOf, roots: src.orderedChildren(null) };
}

// Markdown: groups as bold bullets, bubbles nested, notes as blockquotes,
// done tasks struck through, links as markdown links.
function buildOutlineMarkdown() {
  const { nodes, childrenOf, roots } = outlineStructure();
  const label = n => {
    let s = (n.label || 'Untitled').trim() || 'Untitled';
    if (n.done) s = '~~' + s + '~~ ✓';
    if (n.link) s += ' ([link](' + n.link + '))';
    return s;
  };
  const note = (n, pad) => (!n.note || !n.note.trim()) ? ''
    : n.note.replace(/\r/g, '').trim().split('\n').map(l => pad + '> ' + l).join('\n') + '\n';

  let out = '# ' + currentMapName() + '\n\n';
  if (!nodes.length) return out + '_(empty map)_\n';
  // depth-first: every child becomes a nested sub-topic, at any depth
  const emit = (n, depth) => {
    const pad = '  '.repeat(depth);
    const text = n.kind === 'container' ? '**' + label(n) + '**' : label(n);
    out += pad + '- ' + text + '\n' + note(n, pad + '  ');
    for (const c of childrenOf(n.id)) emit(c, depth + 1);
  };
  for (const n of roots) emit(n, 0);
  return out;
}

// Plain text: an indented outline with •/- bullets; notes indented beneath.
function buildOutlineText() {
  const { nodes, childrenOf, roots } = outlineStructure();
  const label = n => {
    let s = (n.label || 'Untitled').trim() || 'Untitled';
    if (n.done) s += ' [done]';
    if (n.link) s += ' (' + n.link + ')';
    return s;
  };
  const note = (n, pad) => (!n.note || !n.note.trim()) ? ''
    : n.note.replace(/\r/g, '').trim().split('\n').map(l => pad + l).join('\n') + '\n';

  const title = currentMapName();
  let out = title + '\n' + '='.repeat(title.length) + '\n\n';
  if (!nodes.length) return out + '(empty map)\n';
  // depth-first: top level uses •, every nested sub-topic uses -
  const emit = (n, depth) => {
    const pad = '    '.repeat(depth);
    out += pad + (depth === 0 ? '• ' : '- ') + label(n) + '\n' + note(n, pad + '    ');
    for (const c of childrenOf(n.id)) emit(c, depth + 1);
  };
  for (const n of roots) emit(n, 0);
  return out;
}

// OPML 2.0: a standard outline format importable by many outliners/mind-map
// tools. Notes ride on the conventional `_note` attribute.
function buildOutlineOPML() {
  const { childrenOf, roots } = outlineStructure();
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/\r/g, '').replace(/\n/g, '&#10;');
  const node = (n, indent) => {
    const attrs = ['text="' + esc(n.label || 'Untitled') + '"'];
    if (n.note && n.note.trim()) attrs.push('_note="' + esc(n.note.trim()) + '"');
    if (n.link) attrs.push('url="' + esc(n.link) + '"');
    if (n.done) attrs.push('_done="true"');
    // any node with children nests them, not just containers
    const kids = childrenOf(n.id);
    if (kids.length) {
      return indent + '<outline ' + attrs.join(' ') + '>\n'
        + kids.map(k => node(k, indent + '  ')).join('')
        + indent + '</outline>\n';
    }
    return indent + '<outline ' + attrs.join(' ') + '/>\n';
  };
  const body = roots.map(n => node(n, '    ')).join('');
  return '<?xml version="1.0" encoding="UTF-8"?>\n<opml version="2.0">\n'
    + '  <head><title>' + esc(currentMapName()) + '</title></head>\n'
    + '  <body>\n' + body + '  </body>\n</opml>\n';
}

// A standalone SVG picture of the map — the same bubbles, groups, weighted
// connections, and colours as the canvas, laid out in map coordinates and
// cropped to a tight bounding box. Used by the PDF export (and self-contained,
// so it renders anywhere the SVG markup is dropped in).
function buildMapSVG() {
  const map = activeMap().getMap();
  const nodes = Object.values(map.nodes || {});
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  if (!nodes.length) {
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 60">'
      + '<text x="100" y="34" text-anchor="middle" font-family="sans-serif" '
      + 'font-size="14" fill="#7C8598">(empty map)</text></svg>';
  }

  // bounding box over every bubble/group, padded by a margin
  const M = 40;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of nodes) {
    minX = Math.min(minX, n.pos[0] - n.r); maxX = Math.max(maxX, n.pos[0] + n.r);
    minY = Math.min(minY, n.pos[1] - n.r); maxY = Math.max(maxY, n.pos[1] + n.r);
  }
  const w = (maxX - minX) + M * 2, h = (maxY - minY) + M * 2;
  const X = x => (x - minX + M).toFixed(1), Y = y => (y - minY + M).toFixed(1);

  const parts = [];
  // connections first, so bubbles sit on top; thickness = weight, like the canvas
  for (const e of map.edges || []) {
    const a = map.nodes[e.a], b = map.nodes[e.b];
    if (!a || !b) continue;
    parts.push('<line x1="' + X(a.pos[0]) + '" y1="' + Y(a.pos[1]) + '" x2="'
      + X(b.pos[0]) + '" y2="' + Y(b.pos[1]) + '" stroke="' + hueOf(a).main
      + '" stroke-width="' + (e.w || 1) + '" stroke-linecap="round" opacity="0.85"/>');
  }
  // groups (behind), then bubbles (in front) — matching the canvas layering
  const draw = n => {
    const col = hueOf(n);
    const isGroup = n.kind === 'container';
    const op = n.done ? 0.4 : 1;
    parts.push('<circle cx="' + X(n.pos[0]) + '" cy="' + Y(n.pos[1]) + '" r="' + n.r
      + '" fill="' + (isGroup ? 'none' : col.dark) + '" stroke="' + col.main
      + '" stroke-width="' + (isGroup ? 2 : 3) + '"'
      + (isGroup ? ' stroke-dasharray="6 5"' : '') + ' opacity="' + op + '"/>');
    if (!isGroup) {
      // fit + wrap the label just like the live bubble, so nothing is clipped
      const lbl = (n.label || '').trim() || 'Untitled';
      const fs = fitBubbleFont(lbl, n.r);
      const lines = wrapLabelLines(lbl, bubbleTextBox(n.r), fs);
      const lineH = fs * 1.2;
      const y0 = n.pos[1] - (lines.length - 1) * lineH / 2; // vertically centre the block
      // NB: Y() returns a formatted string, so the line offset has to be applied
      // in map coordinates *before* formatting — adding to Y()'s result would
      // concatenate ("140.0" + 16.8) instead of adding.
      const tspans = lines.map((ln, i) =>
        '<tspan x="' + X(n.pos[0]) + '" y="' + Y(y0 + i * lineH) + '">' + esc(ln) + '</tspan>'
      ).join('');
      parts.push('<text text-anchor="middle" dominant-baseline="central" '
        + 'font-family="sans-serif" font-weight="700" font-size="' + fs.toFixed(1)
        + '" fill="' + col.lite + '"' + (n.done ? ' text-decoration="line-through"' : '')
        + ' opacity="' + op + '">' + tspans + '</text>');
    } else {
      // group name sits at the top edge of its circle
      parts.push('<text x="' + X(n.pos[0]) + '" y="' + (Y(n.pos[1] - n.r) - 6).toFixed(1)
        + '" text-anchor="middle" font-family="sans-serif" font-size="14" font-weight="700" fill="'
        + col.main + '">' + esc((n.label || 'Group').trim() || 'Group') + '</text>');
    }
  };
  for (const n of nodes) if (n.kind === 'container') draw(n);
  for (const n of nodes) if (n.kind !== 'container') draw(n);

  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + w.toFixed(0) + ' '
    + h.toFixed(0) + '" font-family="sans-serif">' + parts.join('') + '</svg>';
}

// The outline as printable HTML (groups → children, notes beneath), reusing the
// same structure the Outline panel and text exports share.
function buildOutlineHTML() {
  const { nodes, childrenOf, roots } = outlineStructure();
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  const escAttr = s => esc(s).replace(/"/g, '&quot;');
  const safeHref = u => {
    const raw = String(u || '').trim();
    if (!raw) return '';
    // Accept normal web/mail links; block javascript/data payloads.
    if (/^(https?:|mailto:)/i.test(raw)) return raw;
    return '';
  };
  const item = n => {
    let lbl = esc((n.label || 'Untitled').trim() || 'Untitled');
    if (n.done) lbl = '<s>' + lbl + '</s> ✓';
    const href = safeHref(n.link);
    if (href) lbl += ' <a href="' + escAttr(href) + '">🔗</a>';
    let s = '<li>' + lbl;
    if (n.note && n.note.trim()) s += '<div class="note">' + esc(n.note.trim()) + '</div>';
    // any node with children nests them, not just containers
    const kids = childrenOf(n.id);
    if (kids.length) {
      s += '<ul>' + kids.map(item).join('') + '</ul>';
    }
    return s + '</li>';
  };
  if (!nodes.length) return '<p><em>(empty map)</em></p>';
  return '<ul class="outline">' + roots.map(item).join('') + '</ul>';
}

// PDF export: open a print-ready document (the map picture on top, the outline
// below) and hand it to the browser's "Save as PDF". No external libraries —
// the SVG is inline and vector-crisp at any zoom.
function exportOutlinePDF() {
  if (!activeMap()) return;
  const title = currentMapName();
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const doc = '<!doctype html><html><head><meta charset="utf-8"><title>' + esc(title) + '</title>'
    + '<style>'
    + '@page { margin: 18mm; }'
    + 'body { font: 14px/1.5 -apple-system, Segoe UI, Roboto, sans-serif; color: #1b1f27; }'
    + 'h1 { font-size: 22px; margin: 0 0 4px; }'
    + '.sub { color: #6b7280; font-size: 12px; margin-bottom: 16px; }'
    + '.map { text-align: center; margin: 0 0 22px; page-break-inside: avoid; }'
    + '.map svg { max-width: 100%; height: auto; max-height: 150mm; }'
    + 'h2 { font-size: 15px; margin: 18px 0 6px; border-bottom: 1px solid #e5e7eb; padding-bottom: 3px; }'
    + 'ul.outline, ul.outline ul { margin: 4px 0; padding-left: 22px; }'
    + 'ul.outline li { margin: 3px 0; }'
    + '.note { color: #4b5563; font-size: 12px; border-left: 2px solid #d1d5db; padding-left: 8px; margin: 3px 0 6px; white-space: pre-wrap; }'
    + 'a { color: inherit; text-decoration: none; }'
    + '</style></head><body>'
    + '<h1>' + esc(title) + '</h1>'
    + '<div class="sub">Mind map exported from MindMapShare</div>'
    + '<div class="map">' + buildMapSVG() + '</div>'
    + '<h2>Outline</h2>' + buildOutlineHTML()
    + '</body></html>';

  const win = window.open('', '_blank');
  if (!win) { setHint('Allow pop-ups to export as PDF.', true); return; }
  win.document.open();
  win.document.write(doc);
  win.document.close();
  // Trigger print from the opener context (more reliable than inline popup script
  // in environments that restrict inline scripts).
  let printed = false;
  const firePrint = () => {
    if (printed) return;
    printed = true;
    try {
      win.focus();
      win.print();
      setHint('Opening the print dialog — choose “Save as PDF”.', false);
    } catch {
      setHint('PDF page opened. If print did not start, press Ctrl+P and choose “Save as PDF”.', true);
    }
  };
  win.onload = () => setTimeout(firePrint, 120);
  // Some browsers may not emit onload consistently for this document; fallback.
  setTimeout(firePrint, 350);
}

const EXPORT_FORMATS = {
  md: { build: buildOutlineMarkdown, mime: 'text/markdown;charset=utf-8', ext: 'md', name: 'Markdown' },
  txt: { build: buildOutlineText, mime: 'text/plain;charset=utf-8', ext: 'txt', name: 'plain text' },
  opml: { build: buildOutlineOPML, mime: 'text/x-opml;charset=utf-8', ext: 'opml', name: 'OPML' },
};

function downloadOutline(format) {
  if (!activeMap()) return;
  const f = EXPORT_FORMATS[format] || EXPORT_FORMATS.md;
  const safe = currentMapName().replace(/[^\w\- ]+/g, '').trim() || 'mindmap';
  const blob = new Blob([f.build()], { type: f.mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = safe + ' outline.' + f.ext;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  setHint('Outline exported as ' + f.name, false);
}

$('#btnOutlineExport').addEventListener('click', () => openSheet('#sheetExport'));
$('#exportPdf').addEventListener('click', () => { closeSheets(); exportOutlinePDF(); });
$('#exportMd').addEventListener('click', () => { downloadOutline('md'); closeSheets(); });
$('#exportTxt').addEventListener('click', () => { downloadOutline('txt'); closeSheets(); });
$('#exportOpml').addEventListener('click', () => { downloadOutline('opml'); closeSheets(); });
$('#exportCancel').addEventListener('click', () => closeSheets());
$('#btnOutlineClose').addEventListener('click', () => toggleOutline(false));
$('#btnOutlineAddTopic').addEventListener('click', () => addOutlineRoot('bubble'));
$('#btnOutlineAddGroup').addEventListener('click', () => addOutlineRoot('container'));

/* ================================================================
   AI map generation (optional — only when the server has it configured)
================================================================ */
function openAISheet() {
  if (!me || !me.aiEnabled) return;
  openSheet('#sheetAI');
  $('#aiError').textContent = '';
  const ta = $('#aiPrompt');
  requestAnimationFrame(() => ta.focus());
}
// mode: 'add' expands the current map (nothing removed); 'replace' overwrites it.
async function runAIGenerate(mode) {
  const prompt = $('#aiPrompt').value.trim();
  const err = $('#aiError');
  if (prompt.length < 3) { err.textContent = 'Describe the map you want in a few words.'; return; }
  if (!currentMapId) return;
  // guard the destructive path: replacing a map that already has content
  if (mode === 'replace') {
    const hasContent = Object.keys(myMap.getMap().nodes || {}).length > 0;
    if (hasContent && !confirm('Begin a new map? This replaces everything currently on this map.')) return;
  }
  const addBtn = $('#aiAdd'), repBtn = $('#aiReplace');
  const active = mode === 'add' ? addBtn : repBtn;
  const label = active.textContent;
  addBtn.disabled = repBtn.disabled = true;
  active.textContent = mode === 'add' ? 'Adding…' : 'Generating…';
  err.textContent = '';
  try {
    if (mode === 'add') {
      // make sure the server has our latest edits before it reads the map to expand
      clearTimeout(saveTimer);
      mapDirty = false;
      await api('/api/maps/' + currentMapId, 'PUT', { map: myMap.getMap() });
    }
    const data = await api('/api/maps/' + currentMapId + '/generate', 'POST', { prompt, mode });
    myMap.loadGenerated(data.map); // loads the (merged, for add) map, fits the view, and saves
    refreshToolbar();
    refreshOutlineIfOpen();
    closeSheets();
    setHint(mode === 'add'
      ? 'Added to your map ✨ — edit away, it saves automatically'
      : 'Generated a map ✨ — edit away, it saves automatically', false);
  } catch (e) {
    err.textContent = e.message || 'Generation failed.';
  }
  addBtn.disabled = repBtn.disabled = false;
  active.textContent = label;
}
$('#aiCancel').addEventListener('click', () => closeSheets());
$('#aiAdd').addEventListener('click', () => runAIGenerate('add'));
$('#aiReplace').addEventListener('click', () => runAIGenerate('replace'));
$('#aiPrompt').addEventListener('keydown', e => {
  e.stopPropagation();
  // Cmd/Ctrl+Enter runs the safe, non-destructive "add" action
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) runAIGenerate('add');
  if (e.key === 'Escape') closeSheets();
});

function initEditor() {
  myMap = createMapView($('#myMapHost'), {
    editable: true,
    onChange: saveMap,
    onSelect: id => {
      // copy-color mode: the next tapped bubble donates its color
      if (colorCopyTarget) {
        if (id && id !== colorCopyTarget) {
          const src = myMap.getNode(id);
          const target = colorCopyTarget;
          colorCopyTarget = null;
          const copied = src && myMap.getNode(target);
          if (copied) myMap.setNodeHue(target, src.hue || 0);
          myMap.selectNode(target); // hand the selection back to the recolored bubble
          refreshToolbar();
          if (copied) setHint('Color copied ✓', false); // after selectNode so it isn't wiped
          return;
        }
        if (!id) { colorCopyTarget = null; setHint(DEFAULT_HINT, false); } // background cancels
      }
      refreshToolbar();
      if (!myMap.isConnecting()) setHint(DEFAULT_HINT, false);
      $('#btnConnect').classList.toggle('active', myMap.isConnecting());
    },
    onRenameRequest: id => openRename(id),
    onEdgeTap: id => openEdgeSheet(id),
    onConnected: id => {
      $('#btnConnect').classList.remove('active');
      setHint(DEFAULT_HINT, false);
      openEdgeSheet(id);
    },
    onConnectCancel: () => {
      $('#btnConnect').classList.remove('active');
      setHint(DEFAULT_HINT, false);
    },
    // editor pick menu: selects nodes / opens the edge sheet (myMap is set by now)
    onPick: (hits, cx, cy, mode) => showPickMenu(myMap, false, hits, cx, cy, mode),
    onCenter: id => { if (id === null) setHint(DEFAULT_HINT, false); }, // left orbit mode
    isSheetOpen: anySheetOpen,
  });

  $('#btnAddBubble').addEventListener('click', () => {
    const id = myMap.addBubble();
    refreshToolbar();
    openRename(id);
  });
  $('#btnAddGroup').addEventListener('click', () => {
    const id = myMap.addContainer();
    refreshToolbar();
    openRename(id);
  });
  $('#btnAddMapLink').addEventListener('click', openMapLinkSheet);
  $('#btnOutline').addEventListener('click', () => toggleOutline());
  $('#btnAI').addEventListener('click', openAISheet);
  $('#btnConnect').addEventListener('click', () => {
    if (myMap.isConnecting()) {
      myMap.cancelConnect();
      $('#btnConnect').classList.remove('active');
      setHint(DEFAULT_HINT, false);
    } else if (myMap.startConnect()) {
      $('#btnConnect').classList.add('active');
      setHint('Now tap another bubble to connect it', true);
    }
  });
  $('#btnRename').addEventListener('click', () => {
    const sel = myMap.getSelected();
    if (sel) openRename(sel.id);
  });
  $('#btnNote').addEventListener('click', () => {
    const sel = myMap.getSelected();
    if (sel) openRename(sel.id, 'note');
  });
  $('#btnColor').addEventListener('click', openColorSheet);
  $('#btnDelete').addEventListener('click', () => { myMap.deleteSelected(); refreshToolbar(); });
  $('#btnGroupMenu').addEventListener('click', openGroupSheet);

  // connection weight numbers: on by default, choice remembered
  const btnWeights = $('#btnWeights');
  const savedWeights = localStorage.getItem('mms:showWeights');
  const showW = savedWeights === null ? true : savedWeights === '1';
  myMap.setShowWeights(showW);
  btnWeights.classList.toggle('active', showW);
  btnWeights.addEventListener('click', () => {
    const on = !myMap.getShowWeights();
    myMap.setShowWeights(on);
    btnWeights.classList.toggle('active', on);
    try { localStorage.setItem('mms:showWeights', on ? '1' : '0'); } catch { /* private mode */ }
    setHint(on ? 'Connection weights shown' : 'Connection weights hidden', false);
  });

  $('#btnCenter').addEventListener('click', () => myMap.resetCamera());
  $('#btnZoomIn').addEventListener('click', () => myMap.zoom(0.85));
  $('#btnZoomOut').addEventListener('click', () => myMap.zoom(1.18));

  window.addEventListener('keydown', e => {
    if (!me || $('#view-map').hidden) return;
    if (anySheetOpen()) return;
    const tag = document.activeElement && document.activeElement.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    if (e.key === 'Enter') { e.preventDefault(); const id = myMap.addBubble(); refreshToolbar(); openRename(id); }
    else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); myMap.deleteSelected(); refreshToolbar(); }
    else if (e.key === 'F2') {
      const sel = myMap.getSelected();
      if (sel) { e.preventDefault(); openRename(sel.id); }
    } else if (e.key === 'n' || e.key === 'N') {
      const sel = myMap.getSelected();
      if (sel) { e.preventDefault(); openRename(sel.id, 'note'); }
    } else if (e.key === 'Escape' && myMap.isConnecting()) {
      myMap.cancelConnect();
      $('#btnConnect').classList.remove('active');
      setHint(DEFAULT_HINT, false);
    } else if (e.key === 'Escape' && colorCopyTarget) {
      colorCopyTarget = null;
      setHint(DEFAULT_HINT, false);
    }
  });

  refreshToolbar();
}

/* ================================================================
   Multiple maps: switcher, create, settings (visibility + editors)
================================================================ */
const lastMapKey = () => 'mms:lastMap:' + (me ? me.username : '');

// icon + words for each visibility tier, reused across the UI
const VIS = {
  private: { icon: '🔒', label: 'Private', long: 'Only you' },
  friends: { icon: '👥', label: 'Friends only', long: 'Friends only' },
  public: { icon: '🌐', label: 'Public', long: 'Everyone on MindMapShare' },
};
const visInfo = v => VIS[v] || VIS.friends;

function renderMapSelect() {
  const sel = $('#mapSelect');
  sel.innerHTML = '';
  const gMine = document.createElement('optgroup');
  gMine.label = 'My maps';
  for (const m of mapsMine) {
    const o = document.createElement('option');
    o.value = m.id;
    // only non-public maps get an icon, to keep the list uncluttered
    o.textContent = m.name + (m.visibility === 'public' ? '' : ' ' + visInfo(m.visibility).icon);
    gMine.appendChild(o);
  }
  sel.appendChild(gMine);
  if (mapsShared.length) {
    const g = document.createElement('optgroup');
    g.label = 'Shared with me';
    for (const m of mapsShared) {
      const o = document.createElement('option');
      o.value = m.id;
      o.textContent = `${m.name} — @${m.owner.username}`;
      g.appendChild(o);
    }
    sel.appendChild(g);
  }
  if (currentMapId) sel.value = currentMapId;
}

async function loadMaps(selectId) {
  const data = await api('/api/maps');
  mapsMine = data.mine;
  mapsShared = data.shared;
  const all = [...mapsMine, ...mapsShared];
  let target = selectId || currentMapId || localStorage.getItem(lastMapKey());
  if (!all.some(m => m.id === target)) target = mapsMine[0] && mapsMine[0].id;
  renderMapSelect();
  if (target) await openMyMap(target);
}

async function openMyMap(id) {
  flushSave();
  colorCopyTarget = null; // a copy-color pick can't span map switches
  const data = await api('/api/maps/' + id);
  currentMapId = data.map.id;
  currentMapInfo = data;
  try { localStorage.setItem(lastMapKey(), id); } catch { /* private mode */ }
  $('#mapSelect').value = id;
  $('#btnMapSettings').hidden = !data.isOwner;
  myMap.setMap(data.map, { fit: true }); // opening/selecting a map frames the whole thing
  refreshToolbar();
  setHint(data.isOwner ? DEFAULT_HINT : `Editing @${data.owner.username}'s map “${data.map.name}”`, false);
  await startLive(id, data.canEdit);
}

$('#mapSelect').addEventListener('change', () => {
  openMyMap($('#mapSelect').value).catch(err => {
    alert(err.message);
    loadMaps().catch(() => {});
  });
});

/* ---------- new map sheet ---------- */
$('#btnNewMap').addEventListener('click', () => {
  openSheet('#sheetNewMap');
  $('#newMapName').value = '';
  $('#newMapError').textContent = '';
  const def = me && VIS[me.visibility] ? me.visibility : 'friends';
  for (const r of document.querySelectorAll('input[name=newMapVis]')) r.checked = r.value === def;
  requestAnimationFrame(() => $('#newMapName').focus());
});
$('#newMapCancel').addEventListener('click', () => closeSheets());
$('#newMapCreate').addEventListener('click', async () => {
  const name = $('#newMapName').value.trim();
  const visEl = document.querySelector('input[name=newMapVis]:checked');
  try {
    const data = await api('/api/maps', 'POST', { name, visibility: visEl ? visEl.value : 'public' });
    closeSheets();
    await loadMaps(data.map.id);
  } catch (err) {
    $('#newMapError').textContent = err.message;
  }
});
$('#newMapName').addEventListener('keydown', e => {
  e.stopPropagation();
  if (e.key === 'Enter') $('#newMapCreate').click();
  if (e.key === 'Escape') closeSheets();
});

/* ---------- insert-a-map-as-bubble sheet ---------- */
// Lists my other maps and maps from people I follow; picking one drops a bubble
// that links to it into the map I'm editing. Tapping that bubble in the read-only
// view opens the linked map.
async function openMapLinkSheet() {
  const list = $('#mapLinkList');
  list.innerHTML = '<div class="muted">Loading…</div>';
  openSheet('#sheetMapLink');
  // maps from people I follow (best-effort — the picker still works without them)
  let followed = [];
  try { const d = await api('/api/following/maps'); followed = d.maps || []; } catch { /* ignore */ }

  const pick = (mapId, name) => {
    myMap.addMapLinkBubble(mapId, name || 'Map'); // its changed() triggers the save
    closeSheets();
    refreshToolbar();
  };
  const addRow = (label, sub) => {
    const b = document.createElement('button');
    b.className = 'tb';
    b.innerHTML = escapeHtml(label) + (sub ? ' <span class="muted">' + escapeHtml(sub) + '</span>' : '');
    list.appendChild(b);
    return b;
  };
  const section = title => {
    const h = document.createElement('div');
    h.className = 'section-title';
    h.textContent = title;
    list.appendChild(h);
  };

  list.innerHTML = '';
  const mine = mapsMine.filter(m => m.id !== currentMapId);
  if (mine.length) {
    section('Your maps');
    for (const m of mine) addRow(m.name || 'Untitled map').addEventListener('click', () => pick(m.id, m.name || 'Map'));
  }
  if (followed.length) {
    section('Maps you follow');
    for (const m of followed) {
      addRow(m.name || 'Untitled map', '@' + m.owner.username)
        .addEventListener('click', () => pick(m.id, m.name || 'Map'));
    }
  }
  if (!mine.length && !followed.length) {
    const p = document.createElement('div');
    p.className = 'muted';
    p.textContent = 'No other maps yet — create another map, or follow people to link to their maps.';
    list.appendChild(p);
  }
}
$('#mapLinkCancel').addEventListener('click', () => closeSheets());

/* ---------- map settings sheet (rename, visibility, editors, order, delete) ---------- */
let msEditors = []; // [{ username, name }] for the map being configured
let msOrder = [];   // working copy of my maps' order: [{ id, name }]

function openMapSettings() {
  const meta = mapsMine.find(m => m.id === currentMapId);
  if (!meta) return;
  openSheet('#sheetMapSettings');
  $('#msName').value = meta.name;
  for (const r of document.querySelectorAll('input[name=msVis]')) r.checked = r.value === meta.visibility;
  $('#msError').textContent = '';
  msEditors = meta.editors || [];
  msOrder = mapsMine.map(m => ({ id: m.id, name: m.name }));
  renderMsEditors();
  renderMsOrder();
  fillFriendPick();
}

function renderMsOrder() {
  const box = $('#msOrder');
  box.innerHTML = '';
  msOrder.forEach((m, i) => {
    const row = document.createElement('div');
    row.className = 'map-order-row' + (m.id === currentMapId ? ' current' : '');
    row.dataset.idx = i;

    // drag handle: press and drag to reorder (works with mouse and touch)
    const grip = document.createElement('span');
    grip.className = 'mo-grip';
    grip.textContent = '⠿';
    grip.title = 'Drag to reorder';
    grip.addEventListener('pointerdown', e => startMsDrag(e, i));

    const name = document.createElement('span');
    name.className = 'mo-name';
    name.textContent = m.name;

    // ↑/↓ remain as a keyboard/touch-friendly fallback alongside dragging
    const up = document.createElement('button');
    up.className = 'mo-move';
    up.textContent = '↑';
    up.title = 'Move up';
    up.disabled = i === 0;
    up.addEventListener('click', () => moveMsOrder(i, -1));

    const down = document.createElement('button');
    down.className = 'mo-move';
    down.textContent = '↓';
    down.title = 'Move down';
    down.disabled = i === msOrder.length - 1;
    down.addEventListener('click', () => moveMsOrder(i, 1));

    row.append(grip, name, up, down);
    box.appendChild(row);
  });
}

function moveMsOrder(i, dir) {
  const j = i + dir;
  if (j < 0 || j >= msOrder.length) return;
  [msOrder[i], msOrder[j]] = [msOrder[j], msOrder[i]];
  renderMsOrder();
}

// Pointer-driven drag-to-reorder for the Map settings order list. The grip that
// starts the drag keeps pointer capture for the whole gesture (so touch and
// mouse both track smoothly); as the pointer moves we splice the dragged map to
// whichever row-height band it's over and shuffle the live DOM in place (a full
// re-render happens only on release, so the captured grip survives the drag).
let msDrag = null;
function startMsDrag(e, index) {
  e.preventDefault();
  const rect = $('#msOrder').children[index].getBoundingClientRect();
  msDrag = {
    id: msOrder[index].id,
    grip: e.currentTarget,          // the grip keeps capture the whole drag
    grabDY: e.clientY - rect.top,   // where inside the row we grabbed
    height: rect.height || 40,
  };
  markMsDragging();
  e.currentTarget.setPointerCapture(e.pointerId);
  e.currentTarget.addEventListener('pointermove', onMsDragMove);
  e.currentTarget.addEventListener('pointerup', endMsDrag);
  e.currentTarget.addEventListener('pointercancel', endMsDrag);
}
function markMsDragging() {
  if (!msDrag) return;
  for (const r of $('#msOrder').children) {
    r.classList.toggle('dragging', msOrder[+r.dataset.idx] && msOrder[+r.dataset.idx].id === msDrag.id);
  }
}
function onMsDragMove(e) {
  if (!msDrag) return;
  const box = $('#msOrder');
  const from = msOrder.findIndex(m => m.id === msDrag.id);
  if (from < 0) return;
  const boxRect = box.getBoundingClientRect();
  // pointer y within the list, adjusted to the dragged row's centre, picks the slot
  const y = e.clientY - boxRect.top - msDrag.grabDY + msDrag.height / 2;
  let to = Math.floor(y / msDrag.height);
  to = Math.max(0, Math.min(msOrder.length - 1, to));
  if (to !== from) {
    // reorder both the array and the live DOM by MOVING the dragged row — never
    // re-render mid-drag, or we'd destroy the grip that holds the pointer capture
    const [item] = msOrder.splice(from, 1);
    msOrder.splice(to, 0, item);
    const rows = [...box.children];
    const dragRow = rows[from];
    const refRow = to < rows.length ? rows[to] : null;
    if (to > from) box.insertBefore(dragRow, refRow ? refRow.nextSibling : null);
    else box.insertBefore(dragRow, refRow);
    // keep dataset.idx and ↑/↓ disabled-state in sync with the new positions
    [...box.children].forEach((r, i) => {
      r.dataset.idx = i;
      const [up, down] = r.querySelectorAll('.mo-move');
      if (up) up.disabled = i === 0;
      if (down) down.disabled = i === box.children.length - 1;
    });
  }
}
function endMsDrag(e) {
  if (msDrag && msDrag.grip) {
    try { msDrag.grip.releasePointerCapture(e.pointerId); } catch { /* already gone */ }
  }
  msDrag = null;
  renderMsOrder(); // clean rebuild to reattach fresh handlers and clear drag state
}
$('#btnMapSettings').addEventListener('click', openMapSettings);

// Preview my own maps in the read-only viewer, the way a visitor sees them.
// Opens on the map I'm currently editing (flushing any pending save first).
$('#btnPreview').addEventListener('click', () => {
  if (!me) return;
  flushSave();
  if (currentMapId) pendingProfileMapId = currentMapId;
  location.hash = '#/u/' + me.username;
});

function renderMsEditors() {
  const box = $('#msEditors');
  box.innerHTML = '';
  if (!msEditors.length) {
    const d = document.createElement('div');
    d.className = 'muted';
    d.textContent = 'Only you can edit this map.';
    box.appendChild(d);
    return;
  }
  for (const ed of msEditors) {
    const chip = document.createElement('span');
    chip.className = 'editor-chip';
    chip.appendChild(document.createTextNode(ed.name ? `${ed.name} (@${ed.username})` : '@' + ed.username));
    const x = document.createElement('button');
    x.textContent = '✕';
    x.title = 'Remove edit permission';
    x.addEventListener('click', () => changeEditor(ed.username, 'remove'));
    chip.appendChild(x);
    box.appendChild(chip);
  }
}

async function fillFriendPick() {
  const sel = $('#msFriendPick');
  sel.innerHTML = '';
  let friends = [];
  try { friends = (await api('/api/friends')).friends; } catch { /* offline */ }
  const already = new Set(msEditors.map(e => e.username));
  const avail = friends.filter(f => !already.has(f.username));
  for (const f of avail) {
    const o = document.createElement('option');
    o.value = f.username;
    o.textContent = f.name ? `${f.name} (@${f.username})` : '@' + f.username;
    sel.appendChild(o);
  }
  sel.disabled = !avail.length;
  $('#msAddEditor').disabled = !avail.length;
  if (!avail.length) {
    const o = document.createElement('option');
    o.textContent = friends.length ? 'All friends can already edit' : 'Add friends first to grant edit';
    sel.appendChild(o);
  }
}

async function changeEditor(username, action) {
  try {
    const data = await api(`/api/maps/${currentMapId}/editors`, 'POST', { username, action });
    msEditors = data.editors;
    const meta = mapsMine.find(m => m.id === currentMapId);
    if (meta) meta.editors = msEditors;
    renderMsEditors();
    fillFriendPick();
  } catch (err) {
    $('#msError').textContent = err.message;
  }
}

$('#msAddEditor').addEventListener('click', () => {
  const uname = $('#msFriendPick').value;
  if (uname) changeEditor(uname, 'add');
});

$('#msDone').addEventListener('click', async () => {
  const visEl = document.querySelector('input[name=msVis]:checked');
  try {
    await api(`/api/maps/${currentMapId}/meta`, 'PUT', {
      name: $('#msName').value.trim(),
      visibility: visEl ? visEl.value : 'public',
    });
    // persist the map order if it changed from what the server has
    const current = mapsMine.map(m => m.id);
    const wanted = msOrder.map(m => m.id);
    if (wanted.join(',') !== current.join(',')) {
      await api('/api/maps/reorder', 'POST', { order: wanted });
    }
    closeSheets();
    await loadMaps(currentMapId);
  } catch (err) {
    $('#msError').textContent = err.message;
  }
});

$('#msDuplicate').addEventListener('click', async () => {
  try {
    const data = await api(`/api/maps/${currentMapId}/duplicate`, 'POST');
    closeSheets();
    await loadMaps(data.map.id);
  } catch (err) {
    $('#msError').textContent = err.message;
  }
});

$('#msDeleteMap').addEventListener('click', async () => {
  const meta = mapsMine.find(m => m.id === currentMapId);
  if (!meta) return;
  if (!confirm(`Delete map “${meta.name}” and everything in it?`)) return;
  try {
    await api('/api/maps/' + currentMapId, 'DELETE');
    closeSheets();
    currentMapId = null;
    mapDirty = false;
    await loadMaps();
  } catch (err) {
    $('#msError').textContent = err.message;
  }
});

$('#msName').addEventListener('keydown', e => {
  e.stopPropagation();
  if (e.key === 'Enter') $('#msDone').click();
  if (e.key === 'Escape') closeSheets();
});

/* ================================================================
   Live collaboration: SSE stream, presence, chat + activity log
================================================================ */
function stopLive() {
  if (liveSource) { liveSource.close(); liveSource = null; }
}

async function startLive(mapId, canEdit) {
  stopLive();
  chatItems = [];
  chatUnread = 0;
  updateChatBadge();
  updatePresence([]);
  renderChat();

  // load history first so the log has context, then stream new events
  try {
    const data = await api('/api/maps/' + mapId + '/chat');
    if (mapId !== currentMapId) return; // switched maps while loading
    chatItems = data.chat || [];
    renderChat();
  } catch { /* no history is fine */ }

  $('#chatInput').disabled = !canEdit;
  $('#chatInput').placeholder = canEdit ? 'Message collaborators…' : 'Only editors can chat here';
  $('#chatForm').querySelector('button').disabled = !canEdit;

  const es = new EventSource('/api/maps/' + mapId + '/live');
  liveSource = es;

  es.addEventListener('hello', e => updatePresence(JSON.parse(e.data).users));
  es.addEventListener('presence', e => updatePresence(JSON.parse(e.data).users));

  es.addEventListener('map', e => {
    if (mapId !== currentMapId) return;
    const m = JSON.parse(e.data);
    const applied = myMap.applyRemote(m);
    // the outline is an editing surface of its own now, so a collaborator's
    // change has to land there too — not just on the canvas
    if (applied) { refreshToolbar(); refreshOutlineIfOpen(); }
    // if we were mid-drag it didn't apply; our next save reconciles anyway
    const st = $('#saveState');
    st.hidden = false; st.textContent = 'Updated by @' + m.by;
    setTimeout(() => { if (st.textContent.startsWith('Updated by')) st.hidden = true; }, 1600);
  });

  es.addEventListener('chat', e => {
    if (mapId !== currentMapId) return;
    addChatItem(JSON.parse(e.data));
  });

  es.addEventListener('meta', e => {
    if (mapId !== currentMapId) return;
    const meta = JSON.parse(e.data);
    const info = mapsMine.find(x => x.id === mapId) || mapsShared.find(x => x.id === mapId);
    if (info) { info.name = meta.name; info.visibility = meta.visibility; renderMapSelect(); }
    // owner may have narrowed visibility (e.g. to private) — if I'm not the owner,
    // confirm I can still see it; a 404 means I lost access and get bounced out.
    if (currentMapInfo && !currentMapInfo.isOwner) {
      api('/api/maps/' + mapId).catch(() => {
        alert('This map is no longer shared with you.');
        stopLive();
        loadMaps().catch(() => {});
      });
    }
  });

  es.addEventListener('revoked', e => {
    if (mapId !== currentMapId) return;
    if (me && JSON.parse(e.data).username === me.username) {
      alert('Your access to this map was removed.');
      stopLive();
      loadMaps().catch(() => {});
    }
  });

  es.addEventListener('gone', () => {
    if (mapId !== currentMapId) return;
    alert('This map was deleted by its owner.');
    stopLive();
    currentMapId = null;
    loadMaps().catch(() => {});
  });
}

function updatePresence(users) {
  // "here" == this friend has the same map open right now (SSE-driven)
  const others = (users || []).filter(u => !me || u.username !== me.username);
  const pill = $('#presencePill');
  const role = u => (u.canEdit ? 'can edit' : 'view only');
  if (!others.length) {
    pill.hidden = true;
    $('#chatPresence').textContent = 'Only you here';
    return;
  }
  const label = u => (u.name || '@' + u.username);
  pill.hidden = false;
  pill.textContent = others.length === 1
    ? `${label(others[0])} · ${role(others[0])}`
    : others.length + ' others here';
  // full per-person roster with roles in the chat header
  $('#chatPresence').textContent = 'Here now: ' +
    others.map(u => `${label(u)} (${role(u)})`).join(', ');
}

/* ---------- chat rendering ---------- */
function fmtTime(ts) {
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (sameDay) return time;
  const date = d.toLocaleDateString([], { weekday: 'short', month: 'numeric', day: 'numeric', year: '2-digit' });
  return `${date} @ ${time}`;
}

function chatItemEl(item) {
  const who = item.actor ? (item.actor.name || '@' + item.actor.username) : 'Someone';
  const mine = me && item.actor && item.actor.username === me.username;
  const wrap = document.createElement('div');

  if (item.kind === 'message') {
    wrap.className = 'chat-item chat-msg' + (mine ? ' mine' : '');
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.innerHTML = `<span class="who">${escapeHtml(mine ? 'You' : who)}</span> · ${fmtTime(item.ts)}`;
    const body = document.createElement('div');
    body.className = 'body';
    body.textContent = item.text;
    wrap.appendChild(meta);
    wrap.appendChild(body);
  } else {
    // activity: "Bob added bubble "Sun" · Sun 7/19/26 @ 6:00am"
    wrap.className = 'chat-item chat-activity';
    wrap.innerHTML =
      `<span class="dot">•</span>` +
      `<span><span class="who">${escapeHtml(mine ? 'You' : who)}</span> ${escapeHtml(item.text)} ` +
      `<time>${fmtTime(item.ts)}</time></span>`;
  }
  return wrap;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderChat() {
  const log = $('#chatLog');
  log.innerHTML = '';
  if (!chatItems.length) {
    const d = document.createElement('div');
    d.className = 'chat-empty';
    d.textContent = 'No messages yet. Say hello, or start editing — changes show up here.';
    log.appendChild(d);
    return;
  }
  for (const item of chatItems) log.appendChild(chatItemEl(item));
  log.scrollTop = log.scrollHeight;
}

function addChatItem(item) {
  if (chatItems.some(x => x.id === item.id)) return; // ignore echo of our own post
  chatItems.push(item);
  if (chatItems.length > 400) chatItems.shift();
  const log = $('#chatLog');
  const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 60;
  if (chatItems.length === 1) renderChat();
  else log.appendChild(chatItemEl(item));
  if (nearBottom || (me && item.actor && item.actor.username === me.username)) {
    log.scrollTop = log.scrollHeight;
  }
  if (!chatOpen) { chatUnread++; updateChatBadge(); }
}

function updateChatBadge() {
  const b = $('#chatBadge');
  b.hidden = !chatUnread;
  b.textContent = chatUnread > 99 ? '99+' : chatUnread;
}

function openChat() {
  chatOpen = true;
  chatUnread = 0;
  updateChatBadge();
  $('#chatPanel').hidden = false;
  $('#btnChat').classList.add('active');
  applyChatLayout();
  if (!chatCollapsed) { const log = $('#chatLog'); log.scrollTop = log.scrollHeight; }
}
function closeChat() {
  chatOpen = false;
  $('#chatPanel').hidden = true;
  $('#btnChat').classList.remove('active');
}

$('#btnChat').addEventListener('click', () => (chatOpen ? closeChat() : openChat()));
$('#btnChatClose').addEventListener('click', closeChat);

/* ================================================================
   Chat window: collapse, move, resize — persisted per user
================================================================ */
const CHAT_MIN_W = 240, CHAT_MIN_H = 220;
const chatLayoutKey = () => 'mms:chatLayout:' + (me ? me.username : '');
let chatCollapsed = false;
let chatGeom = null; // { left, top, width, height } once the user has moved/resized it

function loadChatLayout() {
  chatCollapsed = false;
  chatGeom = null;
  try {
    const raw = localStorage.getItem(chatLayoutKey());
    if (raw) {
      const s = JSON.parse(raw);
      chatCollapsed = !!s.collapsed;
      if (s.geom && typeof s.geom.width === 'number') chatGeom = s.geom;
    }
  } catch { /* ignore */ }
}
function saveChatLayout() {
  try { localStorage.setItem(chatLayoutKey(), JSON.stringify({ collapsed: chatCollapsed, geom: chatGeom })); }
  catch { /* private mode */ }
}

// The panel lives inside #view-map; clamp geometry to that box.
function chatBounds() {
  const host = $('#view-map');
  return { w: host.clientWidth, h: host.clientHeight };
}

function applyChatLayout() {
  const panel = $('#chatPanel');
  panel.classList.toggle('collapsed', chatCollapsed);
  $('#btnChatCollapse').textContent = chatCollapsed ? '▸' : '▾';
  $('#btnChatCollapse').title = chatCollapsed ? 'Expand' : 'Collapse';

  if (chatGeom) {
    const { w, h } = chatBounds();
    const width = Math.min(chatGeom.width, w);
    const height = Math.min(chatGeom.height, h);
    const left = Math.max(0, Math.min(chatGeom.left, w - width));
    const top = Math.max(0, Math.min(chatGeom.top, h - Math.min(height, 60)));
    panel.classList.add('floating');
    panel.style.left = left + 'px';
    panel.style.top = top + 'px';
    panel.style.width = width + 'px';
    panel.style.height = chatCollapsed ? 'auto' : height + 'px';
  } else {
    // default docked-right layout: let CSS drive it
    panel.classList.remove('floating');
    panel.style.left = panel.style.top = panel.style.width = panel.style.height = '';
  }
}

// switch from docked to floating using the panel's current on-screen rect,
// so it doesn't jump when the user first grabs it
function ensureFloating() {
  if (chatGeom) return;
  const panel = $('#chatPanel');
  const pr = panel.getBoundingClientRect();
  const hr = $('#view-map').getBoundingClientRect();
  chatGeom = {
    left: pr.left - hr.left,
    top: pr.top - hr.top,
    width: pr.width,
    height: pr.height,
  };
}

$('#btnChatCollapse').addEventListener('click', e => {
  e.stopPropagation();
  chatCollapsed = !chatCollapsed;
  applyChatLayout();
  saveChatLayout();
  if (!chatCollapsed) { const log = $('#chatLog'); log.scrollTop = log.scrollHeight; }
});

/* ---- drag the header to move ---- */
$('#chatHead').addEventListener('pointerdown', e => {
  // ignore clicks on the header buttons
  if (e.target.closest('button')) return;
  e.preventDefault();
  ensureFloating();
  const panel = $('#chatPanel');
  const { w, h } = chatBounds();
  const start = { x: e.clientX, y: e.clientY, left: chatGeom.left, top: chatGeom.top };
  panel.classList.add('dragging');
  $('#chatHead').setPointerCapture(e.pointerId);

  const move = ev => {
    const width = parseFloat(panel.style.width) || chatGeom.width;
    chatGeom.left = Math.max(0, Math.min(start.left + (ev.clientX - start.x), w - width));
    chatGeom.top = Math.max(0, Math.min(start.top + (ev.clientY - start.y), h - 44));
    panel.style.left = chatGeom.left + 'px';
    panel.style.top = chatGeom.top + 'px';
  };
  const up = () => {
    panel.classList.remove('dragging');
    $('#chatHead').removeEventListener('pointermove', move);
    $('#chatHead').removeEventListener('pointerup', up);
    saveChatLayout();
  };
  $('#chatHead').addEventListener('pointermove', move);
  $('#chatHead').addEventListener('pointerup', up);
});

/* ---- drag the corner to resize ---- */
$('#chatResize').addEventListener('pointerdown', e => {
  e.preventDefault();
  e.stopPropagation();
  ensureFloating();
  const panel = $('#chatPanel');
  const { w, h } = chatBounds();
  const start = { x: e.clientX, y: e.clientY, width: chatGeom.width, height: chatGeom.height };
  panel.classList.add('resizing');
  $('#chatResize').setPointerCapture(e.pointerId);

  const move = ev => {
    const maxW = w - chatGeom.left, maxH = h - chatGeom.top;
    chatGeom.width = Math.max(CHAT_MIN_W, Math.min(start.width + (ev.clientX - start.x), maxW));
    chatGeom.height = Math.max(CHAT_MIN_H, Math.min(start.height + (ev.clientY - start.y), maxH));
    panel.style.width = chatGeom.width + 'px';
    panel.style.height = chatGeom.height + 'px';
  };
  const up = () => {
    panel.classList.remove('resizing');
    $('#chatResize').removeEventListener('pointermove', move);
    $('#chatResize').removeEventListener('pointerup', up);
    saveChatLayout();
  };
  $('#chatResize').addEventListener('pointermove', move);
  $('#chatResize').addEventListener('pointerup', up);
});

// keep the panel on-screen if the window resizes
window.addEventListener('resize', () => { if (chatOpen) applyChatLayout(); });

$('#chatForm').addEventListener('submit', async e => {
  e.preventDefault();
  const input = $('#chatInput');
  const text = input.value.trim();
  if (!text || !currentMapId) return;
  input.value = '';
  try {
    const data = await api('/api/maps/' + currentMapId + '/chat', 'POST', { text });
    addChatItem(data.entry); // show immediately; the SSE echo is de-duped by id
  } catch (err) {
    input.value = text;
    alert(err.message);
  }
});
$('#chatInput').addEventListener('keydown', e => e.stopPropagation());

/* ================================================================
   Browse
================================================================ */
function avatarColor(name) {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return HUES[h % HUES.length].main;
}

function userCard(u, actionsHtmlBuilder) {
  const card = document.createElement('button');
  card.className = 'user-card';
  const shownName = u.name || '@' + u.username;
  const av = document.createElement('div');
  av.className = 'avatar';
  av.style.setProperty('--av', avatarColor(u.username));
  av.textContent = shownName.replace('@', '').charAt(0).toUpperCase();
  const who = document.createElement('div');
  who.className = 'who';
  const nm = document.createElement('div');
  nm.className = 'nm';
  nm.textContent = shownName + (me && u.username === me.username ? ' (you)' : '');
  const hd = document.createElement('div');
  hd.className = 'hd';
  hd.textContent = '@' + u.username + (u.mapCount
    ? ' · ' + u.mapCount + ' map' + (u.mapCount === 1 ? '' : 's') +
      ' · ' + u.nodeCount + ' bubble' + (u.nodeCount === 1 ? '' : 's')
    : '');
  who.appendChild(nm);
  who.appendChild(hd);
  card.appendChild(av);
  card.appendChild(who);
  if (actionsHtmlBuilder) {
    actionsHtmlBuilder(card, u);
  } else {
    const meta = document.createElement('div');
    meta.className = 'meta';
    // a quick follow toggle right from the list (not on your own card)
    if (me && u.username !== me.username && 'followedByMe' in u) {
      const follow = document.createElement('button');
      const paint = () => {
        follow.className = 'tb sm' + (u.followedByMe ? '' : ' primary-tb');
        follow.textContent = u.followedByMe ? '✓ Following' : '+ Follow';
      };
      paint();
      follow.addEventListener('click', async e => {
        e.stopPropagation();
        follow.disabled = true;
        try {
          const r = await api('/api/follow', 'POST', {
            username: u.username, action: u.followedByMe ? 'unfollow' : 'follow',
          });
          u.followedByMe = r.following; paint();
        } catch (err) { alert(err.message); }
        follow.disabled = false;
      });
      meta.appendChild(follow);
    }
    const pill = document.createElement('span');
    pill.className = 'pill' + (u.relation === 'friends' ? ' friends' : '');
    // to a stranger, private and friends-only maps are both simply invisible
    pill.textContent = u.relation === 'friends' ? '✓ Friends'
      : u.mapCount ? 'Public maps' : 'Nothing public';
    meta.appendChild(pill);
    card.appendChild(meta);
  }
  card.addEventListener('click', () => { location.hash = '#/u/' + u.username; });
  return card;
}

let browseTimer = null;
async function loadBrowse() {
  const q = $('#searchInput').value.trim();
  const data = await api('/api/users' + (q ? '?q=' + encodeURIComponent(q) : ''));
  const list = $('#userList');
  list.innerHTML = '';
  if (!data.users.length) {
    const d = document.createElement('div');
    d.className = 'empty';
    d.textContent = q ? 'Nobody found for that search.' : 'Nobody here yet.';
    list.appendChild(d);
    return;
  }
  for (const u of data.users) list.appendChild(userCard(u));
}
$('#searchInput').addEventListener('input', () => {
  clearTimeout(browseTimer);
  browseTimer = setTimeout(loadBrowse, 300);
});

/* ================================================================
   Home feed (social) — recent maps from people you follow, plus discovery
================================================================ */
function timeAgo(ts) {
  if (!ts) return '';
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60); if (m < 60) return m + 'm ago';
  const h = Math.floor(m / 60); if (h < 24) return h + 'h ago';
  const d = Math.floor(h / 24); if (d < 7) return d + 'd ago';
  const w = Math.floor(d / 7); if (w < 5) return w + 'w ago';
  return new Date(ts).toLocaleDateString();
}

let pendingProfileMapId = null; // a specific map a feed card asked to open next
let pendingOpenComments = false; // a feed card asked to open that map's comments

function feedCard(item) {
  const owner = item.owner || {};
  const shownName = owner.name || '@' + owner.username;
  const card = document.createElement('div');
  card.className = 'feed-card';

  const head = document.createElement('div');
  head.className = 'feed-card-head';
  const av = document.createElement('div');
  av.className = 'avatar sm';
  av.style.setProperty('--av', avatarColor(owner.username || '?'));
  av.textContent = (shownName.replace('@', '').charAt(0) || '?').toUpperCase();
  const meta = document.createElement('div');
  meta.className = 'feed-meta';
  const who = document.createElement('div'); who.className = 'feed-who'; who.textContent = shownName;
  const sub = document.createElement('div'); sub.className = 'feed-sub muted';
  sub.textContent = '@' + owner.username + ' · ' + timeAgo(item.updatedAt);
  meta.appendChild(who); meta.appendChild(sub);
  head.appendChild(av); head.appendChild(meta);
  const goProfile = () => { location.hash = '#/u/' + owner.username; };
  av.style.cursor = who.style.cursor = 'pointer';
  av.addEventListener('click', goProfile);
  who.addEventListener('click', goProfile);

  const openMap = () => { pendingProfileMapId = item.id; location.hash = '#/u/' + owner.username; };

  const body = document.createElement('button');
  body.className = 'feed-body';
  const title = document.createElement('div'); title.className = 'feed-title'; title.textContent = item.name || 'Untitled map';
  const stat = document.createElement('div'); stat.className = 'feed-stat muted';
  const n = item.nodeCount || 0;
  stat.textContent = n + ' bubble' + (n === 1 ? '' : 's') + (item.visibility === 'friends' ? ' · friends-only' : '');
  body.appendChild(title); body.appendChild(stat);
  body.addEventListener('click', openMap);

  const foot = document.createElement('div');
  foot.className = 'feed-foot';
  const like = document.createElement('button');
  const paint = () => {
    like.className = 'like-btn' + (item.likedByMe ? ' liked' : '');
    like.innerHTML = (item.likedByMe ? '♥' : '♡') + ' <span>' + (item.likeCount || 0) + '</span>';
  };
  paint();
  like.addEventListener('click', async e => {
    e.stopPropagation();
    like.disabled = true;
    try {
      const r = await api('/api/maps/' + item.id + '/like', 'POST');
      item.likedByMe = r.likedByMe; item.likeCount = r.likeCount; paint();
    } catch (err) { alert(err.message); }
    like.disabled = false;
  });
  // comment count, shown right beside the likes; tapping opens the map with its
  // comment panel already open (signed-in only — comments are a signed-in feature)
  const comments = document.createElement('button');
  comments.className = 'comment-count';
  comments.title = 'Comments';
  comments.innerHTML = '💬 <span>' + (item.commentCount || 0) + '</span>';
  comments.addEventListener('click', e => {
    e.stopPropagation();
    pendingProfileMapId = item.id;
    pendingOpenComments = true;
    location.hash = '#/u/' + owner.username;
  });
  const open = document.createElement('button');
  open.className = 'tb';
  open.textContent = 'Open map →';
  open.addEventListener('click', openMap);
  foot.appendChild(like);
  if (me) foot.appendChild(comments); // anonymous visitors can't see/post comments
  foot.appendChild(open);

  card.appendChild(head); card.appendChild(body); card.appendChild(foot);
  return card;
}

async function loadFeed() {
  const list = $('#feedList');
  list.innerHTML = '<div class="empty">Loading…</div>';
  try {
    const data = await api('/api/feed');
    list.innerHTML = '';
    if (!data.items.length) {
      const d = document.createElement('div'); d.className = 'empty';
      d.textContent = data.following
        ? 'No fresh maps from people you follow yet — check back soon.'
        : "You're not following anyone yet. Follow people to fill your feed — or explore public maps below.";
      list.appendChild(d);
    } else {
      for (const it of data.items) list.appendChild(feedCard(it));
    }
    const disc = $('#feedDiscover');
    if (data.discover && data.discover.length) {
      disc.hidden = false;
      const dl = $('#feedDiscoverList'); dl.innerHTML = '';
      for (const it of data.discover) dl.appendChild(feedCard(it));
    } else {
      disc.hidden = true;
    }
  } catch (err) {
    list.innerHTML = '';
    const d = document.createElement('div'); d.className = 'empty'; d.textContent = err.message;
    list.appendChild(d);
  }
}

/* ================================================================
   Friends
================================================================ */
function actionBtn(label, cls, fn) {
  const b = document.createElement('button');
  b.className = 'tb ' + (cls || '');
  b.textContent = label;
  b.addEventListener('click', async e => {
    e.stopPropagation();
    b.disabled = true;
    try { await fn(); } catch (err) { alert(err.message); }
  });
  return b;
}

async function friendAction(action, username) {
  await api('/api/friends/' + action, 'POST', { username });
}

async function loadFriends() {
  const data = await api('/api/friends');
  updateBadge(data.incoming.length);
  const box = $('#friendsContent');
  box.innerHTML = '';

  const section = (title, users, build) => {
    if (!users.length) return;
    const h = document.createElement('div');
    h.className = 'section-title';
    h.textContent = title;
    box.appendChild(h);
    const wrap = document.createElement('div');
    wrap.className = 'user-list';
    for (const u of users) wrap.appendChild(userCard(u, build));
    box.appendChild(wrap);
  };

  section('Friend requests', data.incoming, (card, u) => {
    const act = document.createElement('div');
    act.className = 'friend-actions';
    act.appendChild(actionBtn('Accept', 'primary-tb', async () => { await friendAction('accept', u.username); loadFriends(); }));
    act.appendChild(actionBtn('Decline', '', async () => { await friendAction('decline', u.username); loadFriends(); }));
    card.appendChild(act);
  });

  section('Sent requests', data.outgoing, (card, u) => {
    const act = document.createElement('div');
    act.className = 'friend-actions';
    act.appendChild(actionBtn('Cancel', '', async () => { await friendAction('cancel', u.username); loadFriends(); }));
    card.appendChild(act);
  });

  section('Friends', data.friends);

  if (!data.friends.length && !data.incoming.length && !data.outgoing.length) {
    const d = document.createElement('div');
    d.className = 'empty';
    d.textContent = 'No friends yet. Find people in Browse and send a request.';
    box.appendChild(d);
  }
}

function updateBadge(n) {
  const b = $('#friendBadge');
  b.hidden = !n;
  b.textContent = n;
}

/* ================================================================
   Notifications (bell feed + Web Push)
   ----------------------------------------------------------------
   A per-user SSE stream feeds a bell dropdown live; the same events also
   arrive as OS-level Web Push (when the user opts in) via /sw.js.
================================================================ */
let notifItems = [];      // newest-first
let notifUnread = 0;
let notifSource = null;   // EventSource for the bell stream
let notifPanelOpen = false;
let vapidKey = null;      // server's public VAPID key, or null when push is off
const pushSupported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

function updateNotifBadge() {
  const b = $('#notifBadge');
  b.hidden = !notifUnread;
  b.textContent = notifUnread > 99 ? '99+' : notifUnread;
}

function relTime(ts) {
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60); if (m < 60) return m + 'm ago';
  const h = Math.floor(m / 60); if (h < 24) return h + 'h ago';
  const d = Math.floor(h / 24); if (d < 7) return d + 'd ago';
  return new Date(ts).toLocaleDateString();
}

function notifActorName(n) {
  return (n.actor && (n.actor.name || '@' + n.actor.username)) || 'Someone';
}

function renderNotifs() {
  const list = $('#notifList');
  list.innerHTML = '';
  if (!notifItems.length) {
    const e = document.createElement('div');
    e.className = 'notif-empty';
    e.textContent = 'No notifications yet.';
    list.appendChild(e);
    return;
  }
  for (const n of notifItems) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'notif-item' + (n.read ? '' : ' unread');

    const verbs = {
      comment: ' commented on ',
      chat: ' chatted in ',
      edit: ' edited ',
      newmap: ' posted a new map ',
    };
    const verb = verbs[n.kind] || ' updated ';
    const title = document.createElement('div');
    title.className = 'notif-title';
    const who = document.createElement('b'); who.textContent = notifActorName(n);
    const mapb = document.createElement('b'); mapb.textContent = '“' + (n.mapName || 'a map') + '”';
    title.append(who, verb, mapb);
    item.appendChild(title);

    if (n.text) {
      const p = document.createElement('div');
      p.className = 'notif-preview';
      p.textContent = n.text;
      item.appendChild(p);
    }
    const t = document.createElement('div');
    t.className = 'notif-time';
    t.textContent = relTime(n.ts);
    item.appendChild(t);

    item.addEventListener('click', () => openNotifTarget(n));
    list.appendChild(item);
  }
}

// Jump to what the notification is about: the map, via the profile map viewer.
function openNotifTarget(n) {
  closeNotifPanel();
  pendingProfileMapId = n.mapId;
  const target = '#/u/' + n.mapOwner;
  if (location.hash === target) openProfile(n.mapOwner); // same hash won't refire route()
  else location.hash = target;
}

async function loadNotifications() {
  try {
    const data = await api('/api/notifications');
    notifItems = data.notifications || [];
    notifUnread = data.unread || 0;
    updateNotifBadge();
    if (notifPanelOpen) renderNotifs();
  } catch { /* not signed in */ }
}

function connectNotifyStream() {
  if (notifSource) return;
  try {
    notifSource = new EventSource('/api/notifications/stream');
    notifSource.addEventListener('notify', e => {
      let n; try { n = JSON.parse(e.data); } catch { return; }
      notifItems.unshift(n);
      if (notifItems.length > 100) notifItems.pop();
      if (!n.read) { notifUnread++; updateNotifBadge(); }
      if (notifPanelOpen) renderNotifs();
    });
    // EventSource reconnects on its own; nothing to do on error
  } catch { /* SSE unavailable */ }
}

function disconnectNotifyStream() {
  if (notifSource) { notifSource.close(); notifSource = null; }
}

function openNotifPanel() {
  notifPanelOpen = true;
  $('#notifPanel').hidden = false;
  $('#notifBell').setAttribute('aria-expanded', 'true');
  renderNotifs();
  refreshPushButton();
  if (notifUnread) {
    // opening the bell clears the unread count
    notifUnread = 0; updateNotifBadge();
    for (const n of notifItems) n.read = true;
    api('/api/notifications/read', 'POST', {}).catch(() => {});
    renderNotifs();
  }
}
function closeNotifPanel() {
  notifPanelOpen = false;
  $('#notifPanel').hidden = true;
  $('#notifBell').setAttribute('aria-expanded', 'false');
}
function toggleNotifPanel() { notifPanelOpen ? closeNotifPanel() : openNotifPanel(); }

function startNotifications() {
  loadNotifications();
  connectNotifyStream();
  initPushState();
}
function stopNotifications() {
  disconnectNotifyStream();
  notifItems = []; notifUnread = 0;
  updateNotifBadge();
  closeNotifPanel();
}

/* ---- Web Push opt-in ---- */
function urlBase64ToUint8Array(base64) {
  const padding = '='.repeat((4 - base64.length % 4) % 4);
  const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}

async function registerSW() {
  if (!pushSupported) return null;
  try { return await navigator.serviceWorker.register('/sw.js'); }
  catch { return null; }
}

async function initPushState() {
  try {
    const v = await api('/api/push/vapid');
    vapidKey = v.enabled ? v.key : null;
  } catch { vapidKey = null; }
  if (pushSupported && vapidKey) {
    await registerSW();
    // already granted on a prior visit? make sure the server still has a sub
    if (Notification.permission === 'granted') ensureSubscribed().catch(() => {});
  }
  refreshPushButton();
}

function refreshPushButton() {
  const btn = $('#notifPushBtn');
  const state = $('#notifPushState');
  if (!btn || !state) return;
  if (!pushSupported || !vapidKey) {
    btn.hidden = true;
    state.textContent = pushSupported
      ? 'Live alerts on. (Device push isn’t set up on this server.)'
      : 'Live alerts on. (This browser can’t do device push.)';
    return;
  }
  if (Notification.permission === 'granted') {
    btn.hidden = true; state.textContent = 'Push notifications are on.';
  } else if (Notification.permission === 'denied') {
    btn.hidden = true; state.textContent = 'Push is blocked in your browser settings.';
  } else {
    btn.hidden = false; state.textContent = '';
  }
}

async function ensureSubscribed() {
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(vapidKey),
    });
  }
  await api('/api/push/subscribe', 'POST', { subscription: sub.toJSON() });
}

async function enablePush() {
  const state = $('#notifPushState');
  try {
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') { refreshPushButton(); return; }
    await registerSW();
    await ensureSubscribed();
    refreshPushButton();
  } catch (err) {
    state.textContent = 'Could not enable push: ' + err.message;
  }
}

// Bell wiring (elements exist by the time app.js runs).
$('#notifBell').addEventListener('click', e => { e.stopPropagation(); toggleNotifPanel(); });
$('#notifPanel').addEventListener('click', e => e.stopPropagation()); // clicks inside stay open
$('#notifPushBtn').addEventListener('click', e => { e.stopPropagation(); enablePush(); });
$('#notifClear').addEventListener('click', async e => {
  e.stopPropagation();
  notifItems = []; notifUnread = 0; updateNotifBadge(); renderNotifs();
  try { await api('/api/notifications', 'DELETE'); } catch { /* ignore */ }
});
document.addEventListener('click', e => {
  if (notifPanelOpen && !$('#notifWrap').contains(e.target)) closeNotifPanel();
});

async function refreshBadge() {
  try {
    const data = await api('/api/friends');
    updateBadge(data.incoming.length);
  } catch { /* not signed in */ }
}

/* ================================================================
   Profile (view someone else's map)
================================================================ */
// Are we viewing our own profile (read-only viewer preview of our own maps)?
let viewingSelf = false;

async function openProfile(username) {
  viewingSelf = !!(me && username === me.username);
  show('profile');
  closeComments(); // start each profile with the comment panel reset
  try {
    const data = await api('/api/users/' + username);
    currentProfile = data;
    const u = data.user;
    $('#profileName').textContent = (u.name || '@' + u.username) + (viewingSelf ? ' · preview' : '');
    const bits = ['@' + u.username];
    if (u.bio) bits.push(u.bio);
    $('#profileHandle').textContent = bits.join(' · ');
    const fc = u.followerCount || 0;
    $('#profileHandle').textContent = bits.join(' · ') + ' · ' + fc + ' follower' + (fc === 1 ? '' : 's');
    renderFollowButton();
    renderFriendButton();
    // a desk shared with everyone is reachable from its owner's profile; one
    // shared by link is not advertised here
    $('#btnProfileDesk').hidden = !u.deskPublic || viewingSelf;
    renderProfileTabs(data.maps);
    if (data.maps.length) {
      $('#profileLocked').hidden = true;
      $('#profileToolbar').hidden = false;
      $('#profileHint').hidden = false;
      // a feed card may have requested a specific map; else show the first
      const wanted = pendingProfileMapId && data.maps.some(m => m.id === pendingProfileMapId)
        ? pendingProfileMapId : data.maps[0].id;
      pendingProfileMapId = null;
      await openProfileMap(wanted);
      profileMap.start();
      // a feed card's comment count asks to open the comment panel straight away
      if (pendingOpenComments) openComments();
      pendingOpenComments = false;
    } else {
      pendingOpenComments = false;
      $('#profileLocked').hidden = false;
      $('#profileToolbar').hidden = true;
      $('#profileHint').hidden = true;
      const who = u.name || '@' + u.username;
      // could be friends-only maps (become a friend to see them) or all-private maps
      $('#lockedText').textContent =
        viewingSelf ? "You don't have any maps yet. Head to My Maps to create one."
        : !me ? who + " has no public maps. Sign in and add them as a friend to see friends-only maps."
        : u.relation === 'friends' ? who + " hasn't shared any maps with friends."
        : who + "'s maps aren't public. Add them as a friend to see friends-only maps.";
      profileMap.setMap({ nodes: {}, edges: [] });
    }
  } catch (err) {
    $('#profileName').textContent = 'Not found';
    $('#profileHandle').textContent = err.message;
    $('#btnFriendAction').hidden = true;
    $('#profileTabs').hidden = true;
    $('#profileHint').hidden = true;
    $('#profileLocked').hidden = false;
    $('#lockedText').textContent = err.message;
  }
}

function renderProfileTabs(maps) {
  const bar = $('#profileTabs');
  bar.innerHTML = '';
  bar.hidden = maps.length < 2;
  // when the map-tabs row is showing, push the viewer + hint below it so they
  // don't sit under the tabs (CSS keys off this class)
  $('#view-profile').classList.toggle('has-tabs', maps.length >= 2);
  for (const m of maps) {
    const b = document.createElement('button');
    b.className = 'map-tab';
    b.textContent = m.name;
    b.dataset.id = m.id;
    b.addEventListener('click', () => openProfileMap(m.id).catch(err => alert(err.message)));
    bar.appendChild(b);
  }
}

let profileMapId = null;    // map currently previewed on a profile
let profileMapName = '';    // its name, for outline export titles/filenames
let profileCanEdit = false; // whether that previewed map is editable by me
let profileLike = { count: 0, liked: false }; // like state of the previewed map

async function openProfileMap(id) {
  for (const b of $('#profileTabs').children) b.classList.toggle('active', b.dataset.id === id);
  const data = await api('/api/maps/' + id);
  profileMapId = id;
  profileMapName = (data.map && data.map.name) || '';
  profileCanEdit = !!data.canEdit;
  profileMap.setMap(data.map, { fit: true }); // selecting a map frames the whole thing
  // if the owner granted us edit rights, offer to open it in the real editor
  $('#btnPEdit').hidden = !data.canEdit;
  profileLike = { count: data.likeCount || 0, liked: !!data.likedByMe };
  renderProfileLike(!!data.isOwner);
  // any signed-in user can save their own editable copy of a map they can view
  $('#btnPClone').hidden = !me;
  updateCommentsButton(data.commentCount || 0);
  if (commentsOpen) loadComments(); // switching map tabs reloads the open panel
  refreshOutlineIfOpen(); // keep an open outline in sync when switching map tabs
}

function renderProfileLike(isOwner) {
  const btn = $('#btnPLike');
  if (isOwner) { btn.hidden = true; return; } // you don't like your own map
  btn.hidden = false;
  btn.classList.toggle('liked', profileLike.liked);
  btn.textContent = (profileLike.liked ? '♥ ' : '♡ ') + profileLike.count;
  // guests see the like count but can't toggle it
  btn.classList.toggle('readonly', !me);
  btn.title = me ? 'Like this map' : 'Sign in to like this map';
}
$('#btnPLike').addEventListener('click', async () => {
  if (!profileMapId) return;
  if (!me) { location.hash = '#/signin'; return; } // guests: prompt sign-in
  $('#btnPLike').disabled = true;
  try {
    const r = await api('/api/maps/' + profileMapId + '/like', 'POST');
    profileLike = { count: r.likeCount, liked: r.likedByMe };
    renderProfileLike(false);
  } catch (err) { alert(err.message); }
  $('#btnPLike').disabled = false;
});

// Save a copy: clone the previewed map into my own maps, then open it in the
// editor. Works for any map I can view — my own or someone else's.
$('#btnPClone').addEventListener('click', async () => {
  if (!profileMapId || !me) return;
  const btn = $('#btnPClone');
  btn.disabled = true;
  const prev = btn.textContent;
  btn.textContent = 'Saving…';
  try {
    const r = await api('/api/maps/' + profileMapId + '/clone', 'POST');
    await loadMaps(r.map.id); // pull the new map into my list and select it
    location.hash = '#/map';
    await openMyMap(r.map.id);
  } catch (err) {
    alert(err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = prev;
  }
});

/* ---------- comments (read-only map viewer) ----------
   A public comment section on the previewed map. Any signed-in viewer can read
   and post — including the owner viewing their own map. Authors can delete their
   own comments; the owner can moderate any. Loaded on demand when the panel is
   opened, and after switching map tabs while it's open. */
let commentItems = [];
let commentsCanModerate = false;
let commentsOpen = false;
let commentsReqMapId = null; // guards against out-of-order responses when switching maps

function updateCommentsButton(count) {
  const btn = $('#btnPComments');
  // everyone (guests included) can read comments; only signed-in users can post
  btn.hidden = false;
  btn.textContent = '💬 Comments' + (count ? ' ' + count : '');
}

// Show the compose box only to signed-in users; guests get a sign-in prompt.
function applyCommentCompose() {
  const canPost = !!me;
  $('#commentsForm').hidden = !canPost;
  $('#commentsSignin').hidden = canPost;
}

function commentEl(c) {
  const who = c.actor ? (c.actor.name || '@' + c.actor.username) : 'Someone';
  const wrap = document.createElement('div');
  wrap.className = 'comment-item' + (c.mine ? ' mine' : '');
  wrap.dataset.id = c.id;
  const head = document.createElement('div');
  head.className = 'comment-head';
  head.innerHTML = `<span class="who">${escapeHtml(c.mine ? 'You' : who)}</span>` +
    `<time>${fmtTime(c.ts)}</time>`;
  if (c.mine || commentsCanModerate) {
    const del = document.createElement('button');
    del.className = 'del';
    del.title = 'Delete comment';
    del.setAttribute('aria-label', 'Delete comment');
    del.textContent = '✕';
    del.addEventListener('click', () => deleteComment(c.id));
    head.appendChild(del);
  }
  const body = document.createElement('div');
  body.className = 'body';
  body.textContent = c.text;
  wrap.appendChild(head);
  wrap.appendChild(body);
  return wrap;
}

function renderComments() {
  const log = $('#commentsLog');
  log.innerHTML = '';
  $('#commentsCount').textContent = commentItems.length
    ? commentItems.length + (commentItems.length === 1 ? ' comment' : ' comments') : '';
  if (!commentItems.length) {
    const d = document.createElement('div');
    d.className = 'chat-empty';
    d.textContent = 'No comments yet. Be the first to say something.';
    log.appendChild(d);
    return;
  }
  for (const c of commentItems) log.appendChild(commentEl(c));
  log.scrollTop = log.scrollHeight;
}

async function loadComments() {
  if (!profileMapId) return;
  commentsReqMapId = profileMapId;
  $('#commentsLog').innerHTML = '<div class="chat-empty">Loading…</div>';
  try {
    const data = await api('/api/maps/' + profileMapId + '/comments');
    if (commentsReqMapId !== profileMapId) return; // a newer map was opened meanwhile
    commentItems = data.comments || [];
    commentsCanModerate = !!data.canModerate;
    renderComments();
    updateCommentsButton(commentItems.length);
  } catch (err) {
    $('#commentsLog').innerHTML = '<div class="chat-empty">' + escapeHtml(err.message) + '</div>';
  }
}

function openComments() {
  if (!profileMapId) return; // guests can read, signed-in users can also post
  commentsOpen = true;
  $('#commentsPanel').hidden = false;
  $('#btnPComments').classList.add('active');
  applyCommentCompose();
  loadComments();
  if (me) setTimeout(() => $('#commentsInput').focus(), 50);
}

function closeComments() {
  commentsOpen = false;
  $('#commentsPanel').hidden = true;
  $('#btnPComments').classList.remove('active');
}

async function deleteComment(id) {
  if (!profileMapId) return;
  try {
    await api('/api/maps/' + profileMapId + '/comments/' + id, 'DELETE');
    commentItems = commentItems.filter(c => c.id !== id);
    renderComments();
    updateCommentsButton(commentItems.length);
  } catch (err) { alert(err.message); }
}

$('#btnPComments').addEventListener('click', () => { commentsOpen ? closeComments() : openComments(); });
$('#btnCommentsClose').addEventListener('click', closeComments);
$('#commentsForm').addEventListener('submit', async e => {
  e.preventDefault();
  if (!me) { location.hash = '#/signin'; return; }
  const input = $('#commentsInput');
  const text = input.value.trim();
  if (!text || !profileMapId) return;
  input.disabled = true;
  try {
    const r = await api('/api/maps/' + profileMapId + '/comments', 'POST', { text });
    input.value = '';
    if (r.entry && !commentItems.some(c => c.id === r.entry.id)) {
      commentItems.push(r.entry);
      renderComments();
      updateCommentsButton(commentItems.length);
    }
  } catch (err) { alert(err.message); }
  input.disabled = false;
  input.focus();
});

// jump from the read-only profile preview into the full editor
async function editProfileMap() {
  const id = profileMapId;
  if (!id || !profileCanEdit) return;
  // the grant may be newer than our last maps load — make sure it's listed
  if (![...mapsMine, ...mapsShared].some(m => m.id === id)) await loadMaps(id);
  location.hash = '#/map';
  await openMyMap(id);
}
$('#btnPEdit').addEventListener('click', () => editProfileMap().catch(err => alert(err.message)));

function renderFriendButton() {
  const btn = $('#btnFriendAction');
  // anonymous visitors can view but not friend anyone; you can't friend yourself
  if (!currentProfile || !me || viewingSelf) { btn.hidden = true; return; }
  const rel = currentProfile.user.relation;
  btn.hidden = false;
  btn.className = 'tb';
  if (rel === 'none') { btn.textContent = '+ Add friend'; btn.classList.add('primary-tb'); }
  else if (rel === 'out') btn.textContent = 'Requested · cancel?';
  else if (rel === 'in') { btn.textContent = 'Accept request'; btn.classList.add('primary-tb'); }
  else if (rel === 'friends') btn.textContent = '✓ Friends';
}

$('#btnFriendAction').addEventListener('click', async () => {
  if (!currentProfile) return;
  const u = currentProfile.user;
  const rel = u.relation;
  try {
    if (rel === 'none') await friendAction('request', u.username);
    else if (rel === 'out') await friendAction('cancel', u.username);
    else if (rel === 'in') await friendAction('accept', u.username);
    else if (rel === 'friends') {
      if (!confirm('Remove ' + (u.name || '@' + u.username) + ' from your friends?')) return;
      await friendAction('remove', u.username);
    }
    openProfile(u.username); // refresh relation + map access
    refreshBadge();
  } catch (err) { alert(err.message); }
});

$('#btnProfileDesk').addEventListener('click', () => {
  if (currentProfile) location.hash = '#/desk/' + currentProfile.user.username;
});

// follow button on a profile (asymmetric follow, distinct from friends)
function renderFollowButton() {
  const btn = $('#btnFollowAction');
  if (!currentProfile || !me || viewingSelf) { btn.hidden = true; return; }
  const u = currentProfile.user;
  btn.hidden = false;
  btn.className = 'tb' + (u.followedByMe ? '' : ' primary-tb');
  btn.textContent = u.followedByMe ? '✓ Following' : '+ Follow';
}

$('#btnFollowAction').addEventListener('click', async () => {
  if (!currentProfile || !me) return;
  const u = currentProfile.user;
  try {
    const r = await api('/api/follow', 'POST', {
      username: u.username, action: u.followedByMe ? 'unfollow' : 'follow',
    });
    u.followedByMe = r.following;
    u.followerCount = r.followerCount;
    renderFollowButton();
  } catch (err) { alert(err.message); }
});

$('#btnProfileBack').addEventListener('click', () => {
  if (history.length > 1) history.back();
  else location.hash = '#/home';
});

let profileHintTimer = null;
const PROFILE_HINT_DEFAULT = 'Tap a bubble to focus it · Drag to pan · Pinch/scroll to zoom';
function setProfileHint(text) {
  $('#profileHint').textContent = text;
  clearTimeout(profileHintTimer);
  profileHintTimer = setTimeout(() => { $('#profileHint').textContent = PROFILE_HINT_DEFAULT; }, 2500);
}

// read-only note reader shown when a map viewer taps a bubble that has a note
function showNoteViewer(n) {
  $('#noteViewerTitle').textContent = n.label || 'Untitled';
  const body = $('#noteViewerBody');
  body.textContent = n.note || '';
  body.hidden = !(n.note && n.note.trim());
  const link = $('#noteViewerLink');
  if (n.link && /^https?:\/\//i.test(n.link)) {
    link.href = n.link;
    link.textContent = '🔗 ' + n.link;
    link.hidden = false;
  } else {
    link.hidden = true;
  }
  // a map bubble carries a mapRef: offer a button that opens the linked map
  const mapBtn = $('#noteViewerMapLink');
  if (n.mapRef) {
    mapBtn.hidden = false;
    mapBtn.onclick = () => { hideNoteViewer(); openLinkedMap(n.mapRef); };
  } else {
    mapBtn.hidden = true;
    mapBtn.onclick = null;
  }
  $('#noteViewer').hidden = false;
}
function hideNoteViewer() { $('#noteViewer').hidden = true; }

// Open a map referenced by a "map bubble". The reference is just a map id, so
// resolve its owner (and confirm we can view it) via the map endpoint, then land
// in the read-only viewer on that map. Handles deleted / no-longer-visible maps.
async function openLinkedMap(mapId) {
  if (!mapId) return;
  try {
    const data = await api('/api/maps/' + mapId);
    const targetHash = '#/u/' + data.owner.username;
    // If that owner's profile is already open, the hash won't change (so no
    // hashchange/route fires) — switch the previewed map directly. Otherwise
    // navigate and let openProfile pick up the requested map.
    if (onProfileView() && location.hash === targetHash) {
      await openProfileMap(mapId);
    } else {
      pendingProfileMapId = mapId;
      location.hash = targetHash;
    }
  } catch (err) {
    alert(err.status === 404 ? "That map isn't available (it may be private or deleted)." : err.message);
  }
}

function initProfileViewer() {
  // read-only; a tap on a bubble focuses it (and pops its note if it has one);
  // overlapping bubbles open a dropdown to choose which one
  profileMap = createMapView($('#profileMapHost'), {
    editable: false,
    tapToCenter: true,
    onPick: (hits, cx, cy, mode) => showPickMenu(profileMap, true, hits, cx, cy, mode),
    onCenter: id => {
      if (id === null) { hideNoteViewer(); setProfileHint('Drag to pan · tap a bubble to focus it'); return; }
      const n = profileMap.getNode(id);
      if (!n) return;
      // tapping a bubble that carries a note, link, or map reference pops it open
      if ((n.note && n.note.trim()) || n.link || n.mapRef) showNoteViewer(n);
      else { hideNoteViewer(); setProfileHint(`"${n.label || 'Untitled'}" · drag to pan`); }
    },
    isSheetOpen: () => !$('#pickMenu').hidden,
  });
  $('#noteViewerClose').addEventListener('click', hideNoteViewer);
  $('#btnPOutline').addEventListener('click', () => toggleOutline());
  $('#btnPCenter').addEventListener('click', () => profileMap.resetCamera());
  $('#btnPZoomIn').addEventListener('click', () => profileMap.zoom(0.85));
  $('#btnPZoomOut').addEventListener('click', () => profileMap.zoom(1.18));
}

/* ================================================================
   The Standing Desk — one private work board per account

   Where a map holds ideas, the desk holds open work: what is assigned
   to you, and what you are waiting on from someone else. Each item
   records the date it was last updated, so a request made three weeks
   ago is visible as exactly that. Nothing here is shared, published, or
   shown on a profile — the board belongs to its owner alone.
================================================================ */
const DESK_DAY = 86400000;

let desk = null;            // { ref, items, notes, closed } — null until loaded
let deskOwner = null;       // whose desk is on screen; null means your own
                            // (set → read-only: someone else's shared board)
let deskMaxItems = 40;      // open items the board holds, both states together
let deskMaxDone = 100;      // completed items, which stay until they are deleted
let deskMaxRef = 40;        // reference entries the board holds
let deskMaxNotes = 20000;   // characters of markup in one note
let deskMaxNoteCount = 20;  // separate notes a board can hold
let deskNoteId = null;      // which note the editor is showing
let deskFocusNote = false;  // a note was just created and should take the caret
let deskStaleDays = 14;     // no activity for this long and an item is stalled
let deskForm = null;        // which add form is open: 'mine' | 'waiting' | 'ref' | null
let deskFocusForm = false;  // a form just opened and should take the caret
let deskMapPickFor = null;  // id of the item whose map picker is open, if any
let deskTagEdit = null;     // { id, mode } while an item's project is being changed
let deskFocusTagBox = false; // that editor just opened a text box, which takes the caret
let deskFlashText = '';     // transient line above the board
let deskFlashTimer = null;
let deskSaveTimer = null;
let deskDirty = false;

const deskRoot = $('#deskRoot');

const deskDays = ms => Math.max(0, Math.floor((Date.now() - ms) / DESK_DAY));
const deskAge = d => (d >= deskStaleDays ? 'stalled' : d >= 7 ? 'aging' : 'current');
const deskDaysLabel = d => (d === 0 ? 'today' : d === 1 ? '1 day' : d + ' days');
const deskUid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
// The two working columns hold open items only; a completed one drops out of
// them and into its own section, newest first, until it is deleted.
const deskIn = state => (desk ? desk.items.filter(i => i.state === state && !i.done) : []);
const deskDone = () => (desk ? desk.items.filter(i => i.done).sort((a, b) => b.done - a.done) : []);
const deskDoneWhen = it => {
  const d = deskDays(it.done);
  return d === 0 ? 'today' : d === 1 ? 'yesterday' : d + ' days ago';
};

/* ---------- links to mind maps ----------
   An item or a reference entry may point at one of the maps on your own map
   screen — your maps and the ones shared with you to edit. Only the map's id is
   stored; the name is resolved at render time, so a rename shows through. */
const deskLinkableMaps = () => [...mapsMine, ...mapsShared];
const deskMapName = id => {
  const m = deskLinkableMaps().find(x => x.id === id);
  return m ? (m.name || 'Untitled map') : null;
};

function deskMapSelectHtml(attrs, selected, blankLabel) {
  const option = m => `<option value="${escapeHtml(m.id)}"${m.id === selected ? ' selected' : ''}>` +
    `${escapeHtml(m.name || 'Untitled map')}</option>`;
  const group = (label, list) => (list.length
    ? `<optgroup label="${label}">${list.map(option).join('')}</optgroup>` : '');
  return `<select class="dk-select" ${attrs}>
    <option value="">${blankLabel}</option>
    ${group('My maps', mapsMine)}
    ${group('Shared with me', mapsShared)}
  </select>`;
}

// A linked map opens where you would actually work on it: in the editor when it
// is one of yours, otherwise through the read-only viewer, which reports a map
// that has been deleted or unshared.
function deskOpenMap(mapId) {
  if (!mapId) return;
  flushDeskSave(); // leaving the desk — don't strand a pending edit
  if (deskLinkableMaps().some(m => m.id === mapId)) {
    location.hash = '#/map';
    openMyMap(mapId).catch(err => alert(err.message));
  } else {
    openLinkedMap(mapId);
  }
}

/* ---------- load / save ---------- */
async function loadDesk() {
  // coming back from someone else's board: theirs is on screen, drop it
  if (deskOwner) { desk = null; deskOwner = null; deskForm = null; deskMapPickFor = null; }
  const first = !desk;
  if (first) deskRoot.innerHTML = '<div class="dk-loading">Loading your desk…</div>';
  // Unsaved local edits outrank a refetch — never pull the board out from
  // under something the user just typed.
  if (!deskDirty) {
    try {
      const data = await api('/api/desk');
      desk = data.desk;
      deskMaxItems = data.maxItems;
      deskMaxDone = data.maxDone;
      deskMaxRef = data.maxRef;
      deskMaxNotes = data.maxNotes;
      deskMaxNoteCount = data.maxNoteCount;
      try { deskNoteId = localStorage.getItem(deskNoteKey()); } catch { deskNoteId = null; }
      deskStaleDays = data.staleDays;
    } catch (err) {
      if (first) {
        deskRoot.innerHTML = '';
        const p = document.createElement('div');
        p.className = 'dk-loading';
        p.textContent = 'This desk could not be loaded. ' + err.message;
        deskRoot.appendChild(p);
        return;
      }
      deskFlash('This board could not be refreshed. Showing your most recent local copy.');
    }
  }
  renderDesk();
}

// Someone else's board is read-only in every path, not just in the markup: the
// save helpers refuse outright so no stray handler can write to it.
function saveDesk() {
  if (!desk || deskOwner) return;
  deskDirty = true;
  clearTimeout(deskSaveTimer);
  deskSaveTimer = setTimeout(doDeskSave, 700);
}

async function doDeskSave() {
  if (!desk || deskOwner || !deskDirty) return;
  try {
    await api('/api/desk', 'PUT', { desk });
    deskDirty = false;
  } catch (err) {
    // keep the edit in memory and keep trying; the board is the user's only copy
    deskFlash('Changes have not been saved yet (' + err.message + '). Retrying.');
    clearTimeout(deskSaveTimer);
    deskSaveTimer = setTimeout(doDeskSave, 4000);
  }
}

// Push a pending edit out before the page (or the session) goes away.
// keepalive lets the request outlive the unload the way a queued beacon would.
function flushDeskSave() {
  clearTimeout(deskSaveTimer);
  if (!desk || deskOwner || !deskDirty) return;
  deskDirty = false;
  fetch('/api/desk', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ desk }),
    keepalive: true,
    // a flush on the way out of the view still gets retried; one on the way out
    // of the page has nothing left to retry with, and that is fine
  }).catch(() => { deskDirty = true; deskSaveTimer = setTimeout(doDeskSave, 4000); });
}
window.addEventListener('pagehide', flushDeskSave);

// Patched straight into the alert slot rather than re-rendered: a flash can
// land while someone is mid-sentence in a card or an add form, and a full
// re-render there would throw away what they had typed.
/* ---------- someone else's desk, opened by link ---------- */
// #/desk/<username> for a desk anyone may see, #/desk/<username>/<code> for one
// shared by link. Works signed out; the code is the credential.
async function loadSharedDesk(username, code) {
  flushDeskSave(); // your own pending edit still belongs to your own board
  desk = null;
  deskOwner = null;
  deskForm = null;
  deskMapPickFor = null;
  deskRoot.innerHTML = '<div class="dk-loading">Loading desk…</div>';
  let data;
  try {
    data = await api('/api/users/' + encodeURIComponent(username) + '/desk' +
      (code ? '?code=' + encodeURIComponent(code) : ''));
  } catch (err) {
    deskRoot.innerHTML = '';
    const p = document.createElement('div');
    p.className = 'dk-loading';
    p.textContent = err.status === 404
      ? 'That desk is not available. The link may be wrong, or its owner may have stopped sharing it.'
      : 'That desk could not be loaded. ' + err.message;
    deskRoot.appendChild(p);
    return;
  }
  // your own share link belongs in your own editable board
  if (data.isOwner) { location.hash = '#/desk'; return; }
  desk = { ...data.desk, visibility: data.visibility, code: '' };
  deskNoteId = null;
  deskOwner = data.owner;
  deskStaleDays = data.staleDays;
  renderDesk();
}

/* ---------- sharing (owner only) ---------- */
const DESK_SHARE_LABEL = {
  private: 'Private to you',
  code: 'Shared by link',
  public: 'Visible to anyone',
};

function deskShareLink() {
  if (!desk || !me) return '';
  const base = location.origin + location.pathname + '#/desk/' + me.username;
  if (desk.visibility === 'public') return base;
  if (desk.visibility === 'code' && desk.code) return base + '/' + desk.code;
  return '';
}

function openDeskShare() {
  if (!desk || deskOwner) return;
  openSheet('#sheetDeskShare');
  $('#deskShareError').textContent = '';
  fillDeskShare();
}

function fillDeskShare() {
  if (!desk) return;
  for (const r of document.querySelectorAll('input[name="deskVis"]')) {
    r.checked = r.value === desk.visibility;
  }
  const link = deskShareLink();
  $('#deskShareLinkWrap').hidden = !link;
  $('#deskShareLink').value = link;
  $('#deskShareCopy').hidden = !link;
  $('#deskShareNewCode').hidden = desk.visibility !== 'code';
  $('#deskShareNote').textContent = desk.visibility === 'code'
    ? 'Anyone with this link can read the whole board, working notes included. Switching to Private turns the link off; switching back turns the same link on again. Generate a new code to revoke it for good.'
    : desk.visibility === 'public'
      ? 'The whole board, working notes included, is readable by anyone — signed in or not — and is linked from your profile.'
      : '';
}

async function setDeskVisibility(v) {
  if (!desk || deskOwner) return;
  const previous = desk.visibility;
  desk.visibility = v;
  clearTimeout(deskSaveTimer); // a permission change applies now, not in 700ms
  deskDirty = true;
  try {
    const r = await api('/api/desk', 'PUT', { desk });
    deskDirty = false;
    desk.visibility = r.visibility;
    desk.code = r.code || '';
    $('#deskShareError').textContent = '';
  } catch (err) {
    desk.visibility = previous;
    deskDirty = false;
    $('#deskShareError').textContent = 'Could not change sharing: ' + err.message;
  }
  fillDeskShare();
  renderDesk();
}

for (const r of document.querySelectorAll('input[name="deskVis"]')) {
  r.addEventListener('change', () => { if (r.checked) setDeskVisibility(r.value); });
}
$('#deskShareDone').addEventListener('click', () => closeSheets());
$('#deskShareCopy').addEventListener('click', () => {
  const link = $('#deskShareLink').value;
  if (!link) return;
  navigator.clipboard.writeText(link).then(
    () => { $('#deskShareError').textContent = ''; $('#deskShareNote').textContent = 'Link copied to the clipboard.'; },
    () => { $('#deskShareError').textContent = 'Your browser blocked clipboard access. Select the link and copy it manually.'; });
});
$('#deskShareNewCode').addEventListener('click', async () => {
  if (!confirm('Generate a new code? The current link will stop working for everyone you have given it to.')) return;
  try {
    const r = await api('/api/desk/code', 'POST');
    desk.code = r.code;
    $('#deskShareError').textContent = '';
    fillDeskShare();
    $('#deskShareNote').textContent = 'New code generated. The previous link no longer works.';
  } catch (err) {
    $('#deskShareError').textContent = 'Could not generate a new code: ' + err.message;
  }
});

function deskFlash(msg) {
  deskFlashText = msg;
  clearTimeout(deskFlashTimer);
  paintDeskFlash();
  deskFlashTimer = setTimeout(() => { deskFlashText = ''; paintDeskFlash(); }, 6000);
}
function paintDeskFlash() {
  const slot = $('#dkAlert');
  if (!slot) return; // board isn't on screen yet; renderDesk paints it in
  slot.innerHTML = '';
  if (!deskFlashText) return;
  const box = document.createElement('div');
  box.className = 'dk-alert';
  box.setAttribute('role', 'status');
  box.textContent = deskFlashText;
  slot.appendChild(box);
}

/* ---------- mutations ---------- */
function deskAdd(state, f) {
  const title = f.title.trim();
  if (!title) return;
  // The board itself has a ceiling. Say so rather than letting the save quietly
  // drop the oldest item to fit.
  if (desk.items.filter(i => !i.done).length >= deskMaxItems) {
    deskFlash(`This board holds ${deskMaxItems} open items. Complete or delete one first.`);
    return;
  }
  desk.items.unshift({
    id: deskUid(), title, tag: f.tag.trim(), next: f.next.trim(), who: f.who.trim(),
    mapRef: f.mapRef || '', state, moved: Date.now(),
  });
  deskForm = null;
  saveDesk();
  renderDesk();
}

// Reassigning an item is also an update to it, so the last-updated date is set
// to now: the count that matters is the time since responsibility last moved.
function deskReassign(id) {
  const it = desk.items.find(x => x.id === id);
  if (!it) return;
  it.state = it.state === 'mine' ? 'waiting' : 'mine';
  it.moved = Date.now();
  saveDesk();
  renderDesk();
}

function deskTouch(id) {
  const it = desk.items.find(x => x.id === id);
  if (!it) return;
  it.moved = Date.now();
  saveDesk();
  renderDesk();
}

// Completing an item no longer takes it off the board — it moves to Completed
// and stays there, so what got done is still in front of you, until you delete
// it or put it back.
function deskComplete(id) {
  const it = desk.items.find(x => x.id === id);
  if (!it || it.done) return;
  if (deskDone().length >= deskMaxDone) {
    deskFlash(`Completed holds ${deskMaxDone} items. Delete some of them first.`);
    return;
  }
  it.done = Date.now();
  saveDesk();
  renderDesk();
}

function deskReopen(id) {
  const it = desk.items.find(x => x.id === id);
  if (!it || !it.done) return;
  it.done = 0;
  it.moved = Date.now(); // it is live again, so its clock starts again
  saveDesk();
  renderDesk();
}

function deskRemove(id) {
  desk.items = desk.items.filter(x => x.id !== id);
  saveDesk();
  renderDesk();
}

// A project is only ever the name written on the items carrying it, so renaming
// one means rewriting that name wherever it appears — completed items included,
// since they still show it and still feed the list of known projects.
function deskRenameProject(from, to) {
  if (!desk || deskOwner || !from) return;
  const name = to.trim().slice(0, 80);
  if (name === from) return;
  let n = 0;
  for (const it of desk.items) if (it.tag === from) { it.tag = name; n++; }
  const items = `${n} item${n === 1 ? '' : 's'}`;
  deskFlash(name
    ? `Renamed \u201c${from}\u201d to \u201c${name}\u201d on ${items}.`
    : `Cleared \u201c${from}\u201d from ${items}.`);
  saveDesk();
}

function deskSetTag(id, tag) {
  const it = desk.items.find(x => x.id === id);
  if (!it) return;
  it.tag = String(tag || '').trim().slice(0, 80);
  saveDesk();
}

function deskEditField(id, field, val) {
  const it = desk.items.find(x => x.id === id);
  if (!it) return;
  it[field] = val.trim();
  saveDesk();
}

/* ---------- working notes: a small rich-text editor ----------
   Bold, italic, three sizes, bullets, numbering and alignment, on a
   contenteditable driven by document.execCommand. execCommand is deprecated
   but is the only formatting engine every browser ships, and this app has no
   build step to bring in an editor library.

   Everything execCommand emits is normalised straight afterwards into the
   small tag-and-class vocabulary the server accepts (see sanitizeNoteHtml), so
   what the editor holds is always what will be stored — and what a viewer of a
   shared desk will be shown. */
const NOTE_SIZES = [
  { cls: 'dk-t-sm', label: 'Small' },
  { cls: 'dk-t-md', label: 'Normal' },
  { cls: 'dk-t-lg', label: 'Large' },
];
const NOTE_ALIGN = { left: 'dk-al-left', center: 'dk-al-center', right: 'dk-al-right' };
const NOTE_CLASSES = new Set([...NOTE_SIZES.map(s => s.cls), ...Object.values(NOTE_ALIGN)]);

const notesEl = () => $('#dkNotes');

// Which note the editor is on. Remembered per account, so coming back to the
// desk reopens the one you were last writing in rather than the first.
const deskNoteKey = () => 'mms:desknote:' + (me ? me.username : '-');
function deskNotes() { return desk && Array.isArray(desk.notes) ? desk.notes : []; }
function activeNote() {
  const all = deskNotes();
  if (!all.length) return null;
  return all.find(n => n.id === deskNoteId) || all[0];
}
function setActiveNote(id) {
  deskNoteId = id;
  if (!deskOwner) { try { localStorage.setItem(deskNoteKey(), id); } catch { /* private mode */ } }
}

// Fold what execCommand produced back into our own vocabulary: <font size> and
// text-align styles become classes, and anything else is stripped. Runs after
// every command, so nothing outside the allowlist is ever held in the document.
function normalizeNotes(el) {
  for (const f of [...el.querySelectorAll('font')]) f.replaceWith(...f.childNodes);
  for (const n of [...el.querySelectorAll('[style]')]) {
    const align = (n.style.textAlign || '').toLowerCase();
    n.removeAttribute('style');
    if (NOTE_ALIGN[align]) {
      n.classList.remove(...Object.values(NOTE_ALIGN));
      n.classList.add(NOTE_ALIGN[align]);
    }
  }
  for (const n of [...el.querySelectorAll('[class]')]) {
    for (const c of [...n.classList]) if (!NOTE_CLASSES.has(c)) n.classList.remove(c);
    if (!n.classList.length) n.removeAttribute('class');
  }
  // Alignment lands on the editor itself when there is no block to take it;
  // give it one so the choice survives being saved.
  const rootAlign = (el.style.textAlign || '').toLowerCase();
  el.removeAttribute('style');
  if (NOTE_ALIGN[rootAlign]) {
    const block = document.createElement('div');
    block.className = NOTE_ALIGN[rootAlign];
    while (el.firstChild) block.appendChild(el.firstChild);
    el.appendChild(block);
  }
}

// Caret position as a character offset into the editor's text, so it can be put
// back after a re-render replaces the nodes it pointed at.
function notesCaret(el) {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount || !el.contains(sel.anchorNode)) return null;
  const range = sel.getRangeAt(0);
  const before = range.cloneRange();
  before.selectNodeContents(el);
  before.setEnd(range.startContainer, range.startOffset);
  return { at: before.toString().length, len: range.toString().length };
}

function restoreNotesCaret(el, caret) {
  if (!caret) return;
  const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const point = target => {
    let seen = 0;
    walk.currentNode = el;
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      if (seen + n.length >= target) return [n, target - seen];
      seen += n.length;
    }
    return [el, el.childNodes.length];
  };
  const range = document.createRange();
  const [sn, so] = point(caret.at);
  range.setStart(sn, so);
  const [en, eo] = point(caret.at + caret.len);
  try { range.setEnd(en, eo); } catch { range.collapse(true); }
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  el.focus();
}

function saveNotes() {
  const el = notesEl();
  const note = activeNote();
  if (!el || !desk || deskOwner || !note) return;
  normalizeNotes(el);
  note.html = el.innerHTML;
  if (note.html.length > deskMaxNotes) {
    deskFlash(`This note is full (${deskMaxNotes} characters of formatting). Older text may be trimmed when it saves. Start another note with + Note.`);
  }
  saveDesk();
}

/* ---------- one board, several notes ---------- */
function deskAddNote() {
  if (!desk || deskOwner) return;
  if (deskNotes().length >= deskMaxNoteCount) {
    deskFlash(`A board holds ${deskMaxNoteCount} notes. Delete one before adding another.`);
    return;
  }
  const note = { id: deskUid(), title: 'Notes ' + (deskNotes().length + 1), html: '' };
  desk.notes.push(note);
  setActiveNote(note.id);
  deskFocusNote = true;
  saveDesk();
  renderDesk();
}

function deskDeleteNote(id) {
  if (!desk || deskOwner) return;
  const note = deskNotes().find(n => n.id === id);
  if (!note) return;
  const emptyNote = !noteHtmlToText(note.html);
  if (!emptyNote && !confirm(`Delete the note "${note.title}"? Its contents go with it.`)) return;
  desk.notes = deskNotes().filter(n => n.id !== id);
  // a board always keeps a note, so deleting the last one leaves a clean one
  if (!desk.notes.length) desk.notes.push({ id: deskUid(), title: 'Notes', html: '' });
  setActiveNote(desk.notes[0].id);
  saveDesk();
  renderDesk();
}

function deskRenameNote(id, title) {
  const note = deskNotes().find(n => n.id === id);
  if (!note || deskOwner) return;
  note.title = title.slice(0, 60) || 'Notes';
  saveDesk();
}

// A note as plain text — for telling an empty note from a full one, and for the
// copied summary. Kept in step with the copy in server.js, which produces the
// same text for the data export.
function noteHtmlToText(html) {
  // Markers for a list item and a block boundary, so the two can be normalised
  // separately at the end: a run of block boundaries is one line break, and a
  // list item always starts a line without leaving a blank one above it.
  const ITEM = '\u0001', BREAK = '\u0002';
  return String(html || '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '') // no stray control characters
    // An ordered list is numbered here, before the general pass: one sweep over
    // the whole document cannot tell which list a given item belongs to.
    .replace(/<ol\b[^>]*>([\s\S]*?)<\/ol>/gi, (all, inner) => {
      let n = 0;
      return BREAK + inner.replace(/<li\b[^>]*>/gi, () => ITEM + (++n) + '. ') + BREAK;
    })
    .replace(/<li\b[^>]*>/gi, ITEM + '- ') // every item left belongs to a bulleted list
    .replace(/<br\b[^>]*>/gi, '\n')
    .replace(/<\/?(div|p|ul|ol|li|h[1-6])\b[^>]*>/gi, BREAK)
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&') // last, so "&amp;lt;" doesn't become "<"
    .replace(/\u0002+/g, '\n')
    .replace(/\n*\u0001/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function runNoteCommand(cmd) {
  const el = notesEl();
  if (!el) return;
  el.focus();
  document.execCommand(cmd);
  normalizeNotes(el);
  saveNotes();
  refreshNoteToolbar();
}

// Size is applied over the range directly rather than through execCommand,
// whose 'fontSize' reports success and does nothing in current engines. Every
// size is an explicit one, so the innermost wins and Normal genuinely resets a
// stretch of larger text.
const NOTE_BLOCKS = new Set(['DIV', 'P', 'UL', 'OL', 'LI']);
const NOTE_SIZE_CLASSES = NOTE_SIZES.map(s => s.cls);

function applyNoteSize(cls) {
  const el = notesEl();
  const sel = window.getSelection();
  if (!el || !sel || !sel.rangeCount) return;
  const range = sel.getRangeAt(0);
  if (!el.contains(range.commonAncestorContainer)) return;
  if (range.collapsed) { deskFlash('Select some text first, then choose a size.'); return; }

  const frag = range.extractContents();
  // any size already inside gives way to the one being applied
  for (const n of frag.querySelectorAll('[class]')) n.classList.remove(...NOTE_SIZE_CLASSES);
  const blocks = [...frag.children];
  const allBlocks = blocks.length > 0 && blocks.length === frag.childNodes.length &&
    blocks.every(n => NOTE_BLOCKS.has(n.tagName));
  let first, last;
  if (allBlocks) {
    // whole lines selected — size the lines themselves rather than nesting a
    // span around block elements
    for (const b of blocks) b.classList.add(cls);
    first = blocks[0];
    last = blocks[blocks.length - 1];
    range.insertNode(frag);
  } else {
    const span = document.createElement('span');
    span.className = cls;
    span.appendChild(frag);
    range.insertNode(span);
    first = last = span;
  }
  // keep the same text selected, so a second command lands on it
  const after = document.createRange();
  after.setStartBefore(first);
  after.setEndAfter(last);
  sel.removeAllRanges();
  sel.addRange(after);
  el.focus();
  normalizeNotes(el);
  saveNotes();
  refreshNoteToolbar();
}

// The element the selection starts in. Where a range begins *before* an
// element — which is how a freshly applied size leaves things — the anchor node
// is the parent, so step into the child the offset points at.
function noteSelectionNode(el) {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return null;
  const r = sel.getRangeAt(0);
  if (!el.contains(r.commonAncestorContainer)) return null;
  let n = r.startContainer;
  if (n.nodeType === 1 && n.childNodes[r.startOffset]) n = n.childNodes[r.startOffset];
  return n.nodeType === 1 ? n : n.parentElement;
}

// Light up the buttons that describe the text under the caret.
function refreshNoteToolbar() {
  const el = notesEl();
  if (!el || deskOwner) return;
  const on = (sel, state) => {
    const b = deskRoot.querySelector(sel);
    if (b) b.classList.toggle('dk-fmt--on', !!state);
  };
  const q = c => { try { return document.queryCommandState(c); } catch { return false; } };
  on('[data-cmd="bold"]', q('bold'));
  on('[data-cmd="italic"]', q('italic'));
  on('[data-cmd="underline"]', q('underline'));
  on('[data-cmd="insertUnorderedList"]', q('insertUnorderedList'));
  on('[data-cmd="insertOrderedList"]', q('insertOrderedList'));
  const node = noteSelectionNode(el);
  for (const s of NOTE_SIZES) on(`[data-size="${s.cls}"]`, node && node.closest('.' + s.cls));
  for (const [dir, cls] of Object.entries(NOTE_ALIGN)) {
    on(`[data-align="${dir}"]`, node && node.closest('.' + cls));
  }
}

// One tab per note. The active tab carries the title as editable text so a note
// is renamed where it is named; the others are plain buttons that switch to it.
function noteTabsHtml() {
  const ro = !!deskOwner;
  const all = ro ? deskNotes().filter(n => n.html) : deskNotes();
  const current = activeNote();
  // a single untitled note on your own board needs no tab strip at all
  if (!ro && all.length === 1 && all[0].title === 'Notes') {
    return `<div class="dk-tabs"><button class="dk-tab-add" data-act="addnote" title="Start another note">+ Note</button></div>`;
  }
  if (ro && all.length < 2) return '';
  return `<div class="dk-tabs">
    ${all.map(n => {
      const id = escapeHtml(n.id);
      if (current && n.id === current.id) {
        return `<span class="dk-tab dk-tab--on">
          <span class="dk-tab__name"${ro ? '' : ` contenteditable data-note-title="${id}"`}>${escapeHtml(n.title)}</span>
          ${ro ? '' : `<button class="dk-tab__x" data-act="delnote" data-id="${id}" title="Delete this note" aria-label="Delete this note">&times;</button>`}
        </span>`;
      }
      return `<button class="dk-tab" data-act="note" data-id="${id}" title="Open this note">${escapeHtml(n.title)}</button>`;
    }).join('')}
    ${ro ? '' : '<button class="dk-tab-add" data-act="addnote" title="Start another note">+ Note</button>'}
  </div>`;
}

function noteToolbarHtml() {
  const btn = (attr, label, title) =>
    `<button class="dk-fmt" ${attr} title="${title}" aria-label="${title}">${label}</button>`;
  return `<div class="dk-notes-bar">
    ${btn('data-cmd="bold"', '<b>B</b>', 'Bold')}
    ${btn('data-cmd="italic"', '<i>I</i>', 'Italic')}
    ${btn('data-cmd="underline"', '<u>U</u>', 'Underline')}
    <span class="dk-fmt-sep"></span>
    ${NOTE_SIZES.map(s => btn(`data-size="${s.cls}"`, s.label, s.label + ' text')).join('')}
    <span class="dk-fmt-sep"></span>
    ${btn('data-cmd="insertUnorderedList"', '&bull; List', 'Bulleted list')}
    ${btn('data-cmd="insertOrderedList"', '1. List', 'Numbered list')}
    <span class="dk-fmt-sep"></span>
    ${btn('data-align="left"', 'Left', 'Align left')}
    ${btn('data-align="center"', 'Center', 'Align center')}
    ${btn('data-align="right"', 'Right', 'Align right')}
    <span class="dk-fmt-sep"></span>
    ${btn('data-cmd="removeFormat"', 'Clear', 'Remove formatting')}
  </div>`;
}

/* ---------- render ---------- */
const NEXT_PLACEHOLDER = 'Add the next step';
const WHO_PLACEHOLDER = 'Unassigned';
const TAG_PLACEHOLDER = 'No project';

// Changing an item's project, from the card. The picker offers the projects the
// board already knows so the same one is chosen rather than retyped, and the two
// entries at the end swap it for a text box: one to name a project that isn't
// there yet, one to rename this project across every item carrying it.
function deskTagEditHtml(it) {
  const id = escapeHtml(it.id);
  if (deskTagEdit.mode === 'pick') {
    const option = t =>
      `<option value="${escapeHtml(t)}"${t === it.tag ? ' selected' : ''}>${escapeHtml(t)}</option>`;
    return `<div class="dk-card__pick">
      <select class="dk-select" data-act="picktag" data-id="${id}">
        <option value=""${it.tag ? '' : ' selected'}>No project or reference</option>
        ${deskTags().map(option).join('')}
        <option value="" data-new="1">＋ New project or reference…</option>
        ${it.tag ? `<option value="" data-rename="1">✎ Rename &ldquo;${escapeHtml(it.tag)}&rdquo; on every item…</option>` : ''}
      </select>
      <button class="dk-btn" data-act="canceltag">Cancel</button>
    </div>`;
  }
  const renaming = deskTagEdit.mode === 'rename';
  return `<div class="dk-card__pick">
    <input class="dk-select" data-tagbox="1" maxlength="80"
      value="${renaming ? escapeHtml(it.tag) : ''}"
      placeholder="${renaming ? 'New name for this project' : 'New project or reference'}">
    <button class="dk-btn dk-btn--go" data-act="savetag" data-id="${id}">${renaming ? 'Rename everywhere' : 'Set'}</button>
    <button class="dk-btn" data-act="canceltag">Cancel</button>
  </div>`;
}

function deskCardHtml(it) {
  const ro = !!deskOwner; // someone else's board: read it, don't touch it
  const d = deskDays(it.moved);
  const owner = it.state === 'waiting' ? (it.who || 'Unassigned') : (ro ? 'Them' : 'Me');
  const id = escapeHtml(it.id);
  // a shared board arrives with its links already resolved for this viewer
  const mapName = it.mapName || (it.mapRef ? deskMapName(it.mapRef) : null);
  return `
  <article class="dk-card" data-state="${it.state}" data-age="${deskAge(d)}">
    <div class="dk-card__top">
      <h3 class="dk-card__title"${ro ? '' : ` contenteditable data-id="${id}" data-field="title"`}>${escapeHtml(it.title)}</h3>
      <span class="dk-card__clock" title="Days since this item was last updated">${deskDaysLabel(d)}</span>
    </div>
    <div class="dk-card__meta">${ro
      ? escapeHtml(owner) + (it.tag ? ' &middot; ' + escapeHtml(it.tag) : '')
      : (it.state === 'waiting'
          ? `<span class="dk-card__who${it.who ? '' : ' dk-meta--empty'}" contenteditable data-id="${id}" data-field="who"
              title="Who this item is with">${escapeHtml(it.who || WHO_PLACEHOLDER)}</span>`
          : 'Me') +
        ` &middot; <button class="dk-card__tag${it.tag ? '' : ' dk-meta--empty'}" data-act="edittag" data-id="${id}"
            title="Change the project or reference, or rename it everywhere">${escapeHtml(it.tag || TAG_PLACEHOLDER)}</button>`}</div>
    ${it.mapRef ? `<div class="dk-card__map">
      <button class="dk-maplink${mapName ? '' : ' dk-maplink--gone'}" data-act="openmap" data-map="${escapeHtml(it.mapRef)}"
        title="${mapName ? 'Open this map' : 'Open the linked map — it may have been deleted or unshared'}"
        >🗺 ${escapeHtml(mapName || 'Linked map')}</button>
      ${ro ? '' : `<button class="dk-maplink__x" data-act="unlinkmap" data-id="${id}" title="Remove the linked map" aria-label="Remove the linked map">&times;</button>`}
    </div>` : ''}
    ${ro && !it.next ? '' : `<div class="dk-card__next ${it.next ? '' : 'dk-card__next--empty'}"${ro ? '' : ` contenteditable data-id="${id}" data-field="next"`}
         >${escapeHtml(it.next || NEXT_PLACEHOLDER)}</div>`}
    ${ro ? '' : `<div class="dk-card__acts">
      <button class="dk-switch" data-act="reassign" data-id="${id}"
        title="${it.state === 'mine' ? 'Move this item to Waiting on others' : 'Assign this item to me'}"
        >${it.state === 'mine' ? 'Move to waiting' : 'Assign to me'}</button>
      <button class="dk-btn" data-act="touch" data-id="${id}" title="Reset the last-updated date to today">Mark updated</button>
      ${it.mapRef ? '' : `<button class="dk-btn" data-act="linkmap" data-id="${id}" title="Link one of your mind maps to this item">Link a map</button>`}
      <button class="dk-btn dk-btn--done" data-act="complete" data-id="${id}" title="Remove this item and add it to your completed count">Complete</button>
      <button class="dk-btn dk-btn--drop" data-act="delete" data-id="${id}" title="Remove this item without counting it as completed">Delete</button>
    </div>`}
    ${deskTagEdit && deskTagEdit.id === it.id ? deskTagEditHtml(it) : ''}
    ${deskMapPickFor === it.id ? `<div class="dk-card__pick">
      ${deskMapSelectHtml(`data-act="pickmap" data-id="${id}"`, '', 'Choose a map…')}
      <button class="dk-btn" data-act="cancelmap">Cancel</button>
    </div>` : ''}
    ${d >= deskStaleDays ? `<div class="dk-stalled"><span class="dk-stalled__txt">No activity for ${d} days</span><span class="dk-stalled__bar"></span>${ro ? '' : '<span class="dk-stalled__txt">Follow up or remove</span>'}</div>` : ''}
  </article>`;
}

// Every project or reference already on the board, so the same one gets typed
// once and picked thereafter. Sorted, case-insensitive, no duplicates.
function deskTags() {
  const seen = new Map();
  for (const it of desk ? desk.items : []) {
    if (it.tag && !seen.has(it.tag.toLowerCase())) seen.set(it.tag.toLowerCase(), it.tag);
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b));
}

// A plain text box until the board has projects to offer; from then on a
// dropdown of them, with an entry that turns it back into a text box for a new
// one. Swapping happens in place (see the change handler) so nothing else in
// the half-filled form is disturbed.
function deskTagFieldHtml() {
  const tags = deskTags();
  if (!tags.length) return '<input data-f="tag" maxlength="80" placeholder="Project or reference (optional)">';
  return `<select class="dk-select" data-f="tag">
    <option value="">No project or reference</option>
    ${tags.map(t => `<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`).join('')}
    <option value="" data-new="1">＋ New project or reference…</option>
  </select>`;
}

// A completed item is a settled record rather than live work, so it shows as a
// compact row instead of a card: what it was, when it was finished, and the two
// things you can still do with it.
function deskDoneRowHtml(it) {
  const ro = !!deskOwner;
  const id = escapeHtml(it.id);
  const when = deskDoneWhen(it);
  return `
  <li class="dk-done__row">
    <span class="dk-done__txt">${escapeHtml(it.title)}${it.tag ? '<span class="dk-done__tag">' + escapeHtml(it.tag) + '</span>' : ''}</span>
    <span class="dk-done__when" title="Completed ${escapeHtml(new Date(it.done).toLocaleDateString())}">${when}</span>
    ${ro ? '' : `<button class="dk-btn" data-act="reopen" data-id="${id}" title="Put this back on the board">Reopen</button>
    <button class="dk-btn dk-btn--drop" data-act="delete" data-id="${id}" title="Remove this item for good">Delete</button>`}
  </li>`;
}

function deskFormHtml(state) {
  const mine = state === 'mine';
  return `
  <div class="dk-add">
    <input data-f="title" maxlength="200" placeholder="${mine ? 'What needs to be done?' : 'What are you waiting for?'}">
    ${deskTagFieldHtml()}
    <input data-f="next" maxlength="300" placeholder="Next step (optional)">
    <input data-f="who" maxlength="80" placeholder="${mine ? 'Note (optional)' : 'Who it&rsquo;s with'}">
    ${deskMapSelectHtml('data-f="mapRef"', '', 'No linked map')}
    <div class="dk-add__row">
      <button class="dk-btn dk-btn--go" data-act="save" data-state="${state}">Add item</button>
      <button class="dk-btn" data-act="cancel">Cancel</button>
    </div>
  </div>`;
}

function renderDesk() {
  if (!desk) return;
  // The working-notes area is the one field people type into continuously, and a
  // re-render can land mid-sentence (a flash timer, a save retry). Put the
  // caret back where it was.
  const editor = notesEl();
  const caret = editor && editor.contains(document.activeElement) ? notesCaret(editor) : null;

  const mine = deskIn('mine');
  const waiting = deskIn('waiting');
  const done = deskDone();
  const note = activeNote();
  // a completed item has stopped ageing, so it is never counted as stalled
  const stalled = desk.items.filter(i => !i.done && deskDays(i.moved) >= deskStaleDays).length;
  const today = new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });

  const ro = !!deskOwner;
  const whose = ro ? (deskOwner.name || '@' + deskOwner.username) : '';

  deskRoot.innerHTML = `
  <header class="dk-rig">
    <div>
      <h1 class="dk-rig__title">Standing Desk</h1>
      <div class="dk-rig__sub">${ro
        ? `${escapeHtml(whose)} &nbsp;·&nbsp; <span class="dk-ro">Read-only</span>`
        : `${escapeHtml(today)} &nbsp;·&nbsp; <button class="dk-share" data-act="share" title="Choose who can see this desk">${DESK_SHARE_LABEL[desk.visibility] || DESK_SHARE_LABEL.private}</button>`}</div>
    </div>
    <div class="dk-tally">
      <div class="dk-tally__cell dk-tally__cell--mine"><span class="dk-tally__k">Assigned</span><span class="dk-tally__v">${mine.length}</span></div>
      <div class="dk-tally__cell dk-tally__cell--waiting"><span class="dk-tally__k">Waiting</span><span class="dk-tally__v">${waiting.length}</span></div>
      <div class="dk-tally__cell dk-tally__cell--stalled" data-zero="${stalled ? 0 : 1}"><span class="dk-tally__k">Stalled</span><span class="dk-tally__v">${stalled}</span></div>
    </div>
  </header>

  <div id="dkAlert"></div>

  <div class="dk-board">
    <section class="dk-panel">
      <div class="dk-panel__head"><span class="dk-panel__name">Reference</span><span class="dk-panel__note">kept until removed</span></div>
      <div class="dk-panel__body">
        <ul class="dk-ref">${desk.ref.map((r, n) => {
          const name = r.mapRef ? deskMapName(r.mapRef) : null;
          return `
          <li class="dk-ref__row">
            ${r.mapRef ? `<button class="dk-ref__map" data-act="openmap" data-map="${escapeHtml(r.mapRef)}"
              title="Open ${escapeHtml(name || 'the linked map')}" aria-label="Open the linked map">🗺</button>` : ''}
            <span class="dk-ref__txt"${ro ? '' : ` contenteditable data-ref="${n}"`}>${escapeHtml(r.text)}</span>
            ${ro ? '' : `<button class="dk-ref__x" data-act="unref" data-n="${n}" aria-label="Remove reference">&times;</button>`}
          </li>`; }).join('')}</ul>
        ${desk.ref.length ? '' : `<p class="dk-empty">${ro ? 'Nothing pinned here.'
          : 'Details you refer to often.<br>Links, codes, contacts, targets, a map you keep reopening.'}</p>`}
        ${ro ? '' : deskForm === 'ref' ? `<div class="dk-add">
            <input data-f="line" maxlength="200" placeholder="e.g. Release cutoff — Thursday 16:00">
            ${deskMapSelectHtml('data-f="mapRef"', '', 'No linked map')}
            <div class="dk-add__row"><button class="dk-btn dk-btn--go" data-act="saveref">Add</button><button class="dk-btn" data-act="cancel">Cancel</button></div>
          </div>` : '<button class="dk-opener" data-act="openref">Add a reference</button>'}
      </div>
    </section>

    <section class="dk-panel">
      <div class="dk-panel__head"><span class="dk-panel__name">${ro ? 'Assigned to them' : 'Assigned to me'}</span><span class="dk-panel__note">${ro ? 'their own work' : 'your own work'}</span></div>
      <div class="dk-panel__body">
        ${mine.map(deskCardHtml).join('')}
        ${mine.length ? '' : `<p class="dk-empty">${ro ? 'Nothing is assigned to them right now.'
          : 'No items assigned to you.<br>Add anything you&rsquo;re responsible for.'}</p>`}
        ${ro ? '' : deskForm === 'mine' ? deskFormHtml('mine')
          : '<button class="dk-opener" data-act="open" data-state="mine">Add an item</button>'}
      </div>
    </section>

    <section class="dk-panel">
      <div class="dk-panel__head"><span class="dk-panel__name">Waiting on others</span><span class="dk-panel__note">awaiting a response</span></div>
      <div class="dk-panel__body">
        ${waiting.map(deskCardHtml).join('')}
        ${waiting.length ? '' : `<p class="dk-empty">${ro ? 'They are not waiting on anyone.'
          : 'You&rsquo;re not waiting on anyone.<br>Add an item when you hand work off or make a request.'}</p>`}
        ${ro ? '' : deskForm === 'waiting' ? deskFormHtml('waiting')
          : '<button class="dk-opener" data-act="open" data-state="waiting">Add an item you&rsquo;re waiting on</button>'}
      </div>
    </section>

    ${done.length ? `<section class="dk-panel dk-panel--done">
      <div class="dk-panel__head"><span class="dk-panel__name">Completed</span><span class="dk-panel__note">kept until deleted</span></div>
      <div class="dk-panel__body">
        <ul class="dk-done">${done.map(deskDoneRowHtml).join('')}</ul>
      </div>
    </section>` : ''}

    ${ro && !deskNotes().length ? '' : `<section class="dk-panel dk-panel--notes">
      <div class="dk-panel__head"><span class="dk-panel__name">Working notes</span><span class="dk-panel__note">${ro ? 'read-only'
        : desk.visibility === 'private' ? 'private to you' : 'shared with anyone who can see this desk'}</span></div>
      <div class="dk-panel__body">
        ${noteTabsHtml()}
        ${ro ? '' : noteToolbarHtml()}
        <div class="dk-notes" id="dkNotes"${ro ? '' : ' contenteditable data-placeholder="Space to think something through."'}>${note ? note.html : ''}</div>
      </div>
    </section>`}
  </div>

  <div class="dk-foot">
    <span class="dk-foot__txt">Days shown are since each item was last updated. After ${deskStaleDays} days without activity, an item is flagged as stalled.</span>
    <button class="dk-btn" data-act="copy" style="margin-left:auto">Copy summary</button>
  </div>`;

  paintDeskFlash();
  if (caret) {
    restoreNotesCaret(notesEl(), caret);
    refreshNoteToolbar();
  } else if (deskFocusTagBox) {
    // the project editor keeps the caret inside the desk, so Escape reaches the
    // keydown handler that closes it
    deskFocusTagBox = false;
    const box = deskRoot.querySelector('[data-tagbox], select[data-act="picktag"]');
    if (box) { box.focus(); if (box.select) box.select(); }
  } else if (deskFocusNote) {
    deskFocusNote = false;
    const box = notesEl();
    if (box) box.focus();
  } else if (deskFocusForm) {
    // only on the render that opened the form — never steal the caret back
    // from a field the user has already moved on to
    deskFocusForm = false;
    const first = deskRoot.querySelector('.dk-add input');
    if (first) first.focus();
  }
}

/* ---------- events (delegated; deskRoot itself survives every re-render) ---------- */
deskRoot.addEventListener('click', e => {
  const b = e.target.closest('[data-act]');
  if (!b || !desk) return;
  const act = b.dataset.act;
  if (act === 'reassign') deskReassign(b.dataset.id);
  else if (act === 'touch') deskTouch(b.dataset.id);
  else if (act === 'complete') deskComplete(b.dataset.id);
  else if (act === 'reopen') deskReopen(b.dataset.id);
  else if (act === 'delete') deskRemove(b.dataset.id);
  else if (act === 'open') { deskForm = b.dataset.state; deskFocusForm = true; renderDesk(); }
  else if (act === 'openref') { deskForm = 'ref'; deskFocusForm = true; renderDesk(); }
  else if (act === 'cancel') { deskForm = null; renderDesk(); }
  else if (act === 'share') openDeskShare();
  else if (act === 'note') { setActiveNote(b.dataset.id); renderDesk(); }
  else if (act === 'addnote') deskAddNote();
  else if (act === 'delnote') deskDeleteNote(b.dataset.id);
  else if (act === 'openmap') deskOpenMap(b.dataset.map);
  // one editor open on a card at a time, whichever was asked for last
  else if (act === 'linkmap') { deskMapPickFor = b.dataset.id; deskTagEdit = null; renderDesk(); }
  else if (act === 'edittag') {
    deskTagEdit = { id: b.dataset.id, mode: 'pick' };
    deskMapPickFor = null;
    deskFocusTagBox = true;
    renderDesk();
  }
  else if (act === 'canceltag') { deskTagEdit = null; renderDesk(); }
  else if (act === 'savetag') {
    const box = b.closest('.dk-card__pick').querySelector('[data-tagbox]');
    const it = desk.items.find(x => x.id === b.dataset.id);
    if (deskTagEdit.mode === 'rename' && it) deskRenameProject(it.tag, box.value);
    else deskSetTag(b.dataset.id, box.value);
    deskTagEdit = null;
    renderDesk();
  }
  else if (act === 'cancelmap') { deskMapPickFor = null; renderDesk(); }
  else if (act === 'unlinkmap') {
    const it = desk.items.find(x => x.id === b.dataset.id);
    if (it) { it.mapRef = ''; saveDesk(); renderDesk(); }
  } else if (act === 'save') {
    const form = b.closest('.dk-add');
    const val = k => form.querySelector(`[data-f="${k}"]`).value;
    deskAdd(b.dataset.state, {
      title: val('title'), tag: val('tag'), next: val('next'),
      who: val('who'), mapRef: val('mapRef'),
    });
  } else if (act === 'saveref') {
    const form = b.closest('.dk-add');
    const mapRef = form.querySelector('[data-f="mapRef"]').value;
    // A reference that is only a map link still needs a label; the map's own
    // name is the obvious one.
    const v = form.querySelector('[data-f="line"]').value.trim() || (mapRef ? deskMapName(mapRef) || '' : '');
    if (v && desk.ref.length >= deskMaxRef) {
      deskFlash(`Reference holds ${deskMaxRef} entries. Remove one to add another.`);
      return;
    }
    if (v) { desk.ref.push({ text: v, mapRef }); saveDesk(); }
    deskForm = null;
    renderDesk();
  } else if (act === 'unref') {
    desk.ref.splice(+b.dataset.n, 1);
    saveDesk();
    renderDesk();
  } else if (act === 'copy') {
    navigator.clipboard.writeText(deskSummaryText()).then(
      () => deskFlash('Summary copied to the clipboard.'),
      () => deskFlash('Your browser blocked clipboard access. Select the text and copy it manually.'));
  }
});

// contenteditable commits on blur — captured, since blur does not bubble
deskRoot.addEventListener('blur', e => {
  const t = e.target;
  if (!desk || !t.dataset) return;
  if (t.dataset.field) {
    const v = t.textContent.trim();
    // an untouched placeholder is not a value
    if (t.dataset.field === 'next' && v === NEXT_PLACEHOLDER) return;
    if (t.dataset.field === 'who' && v === WHO_PLACEHOLDER) return;
    deskEditField(t.dataset.id, t.dataset.field, v);
    renderDesk();
  } else if (t.dataset.noteTitle) {
    deskRenameNote(t.dataset.noteTitle, t.textContent.trim());
    renderDesk();
  } else if (t.dataset.ref !== undefined) {
    const n = +t.dataset.ref, v = t.textContent.trim();
    if (v) desk.ref[n].text = v; else desk.ref.splice(n, 1); // emptied a line = removed it
    saveDesk();
    renderDesk();
  }
}, true);

deskRoot.addEventListener('change', e => {
  if (!desk) return;
  // the map picker on a card applies as soon as a map is chosen
  const pick = e.target.closest('select[data-act="pickmap"]');
  if (pick) {
    const it = desk.items.find(x => x.id === pick.dataset.id);
    if (it) it.mapRef = pick.value;
    deskMapPickFor = null;
    saveDesk();
    renderDesk();
    return;
  }
  // the project picker on a card: choosing a project applies it, and the two
  // entries at the end open a text box instead
  const pickTag = e.target.closest('select[data-act="picktag"]');
  if (pickTag) {
    const opt = pickTag.selectedOptions[0];
    if (opt && opt.dataset.new) deskTagEdit = { id: pickTag.dataset.id, mode: 'new' };
    else if (opt && opt.dataset.rename) deskTagEdit = { id: pickTag.dataset.id, mode: 'rename' };
    else { deskSetTag(pickTag.dataset.id, pickTag.value); deskTagEdit = null; }
    deskFocusTagBox = !!deskTagEdit;
    renderDesk();
    return;
  }
  // "New project or reference…" turns the dropdown into a text box. Swapped in
  // place rather than re-rendered, so the rest of the form survives.
  const tag = e.target.closest('select[data-f="tag"]');
  if (tag && tag.selectedOptions[0] && tag.selectedOptions[0].dataset.new) {
    const box = document.createElement('input');
    box.dataset.f = 'tag';
    box.maxLength = 80;
    box.placeholder = 'New project or reference';
    tag.replaceWith(box);
    box.focus();
  }
});

// clear a placeholder the moment its field is entered — only where the
// placeholder is text someone is about to type over. The project button also
// carries dk-meta--empty, and emptying that would collapse it out from under
// the click that just landed on it.
deskRoot.addEventListener('focus', e => {
  const t = e.target;
  if (!t.isContentEditable || !t.classList) return;
  if (t.classList.contains('dk-card__next--empty') || t.classList.contains('dk-meta--empty')) {
    t.textContent = '';
  }
}, true);

deskRoot.addEventListener('input', e => {
  if (e.target.id === 'dkNotes' && desk && !deskOwner) saveNotes();
});

/* ---------- working-notes editor wiring ---------- */
// A toolbar button must not take focus, or the selection it is meant to act on
// is gone before the click lands.
deskRoot.addEventListener('mousedown', e => {
  if (e.target.closest('.dk-fmt')) e.preventDefault();
});

deskRoot.addEventListener('click', e => {
  const b = e.target.closest('.dk-fmt');
  if (!b || !desk || deskOwner) return;
  if (b.dataset.cmd) runNoteCommand(b.dataset.cmd);
  else if (b.dataset.size) applyNoteSize(b.dataset.size);
  else if (b.dataset.align) runNoteCommand('justify' + b.dataset.align[0].toUpperCase() + b.dataset.align.slice(1));
});

// Paste arrives as plain text. Formatting is applied from the toolbar, so the
// editor never has to hold markup from somewhere else — which also keeps a
// pasted script or image handler from ever reaching the document.
deskRoot.addEventListener('paste', e => {
  if (e.target.id !== 'dkNotes' || deskOwner) return;
  e.preventDefault();
  const text = (e.clipboardData || window.clipboardData).getData('text/plain');
  document.execCommand('insertText', false, text);
});

// Keep the toolbar showing what the caret is actually sitting in.
document.addEventListener('selectionchange', () => {
  const el = notesEl();
  if (!el || !el.contains(document.activeElement)) return;
  refreshNoteToolbar();
});

deskRoot.addEventListener('keydown', e => {
  // the map editor's shortcuts are guarded on #view-map, but the sheet/menu
  // handlers are not — keep desk typing to the desk
  e.stopPropagation();
  if (e.key === 'Enter' && e.target.matches('.dk-add input')) {
    e.preventDefault();
    e.target.closest('.dk-add').querySelector('[data-act="save"],[data-act="saveref"]').click();
  } else if (e.key === 'Enter' && e.target.dataset && e.target.dataset.noteTitle) {
    e.preventDefault(); // a note title is one line
    e.target.blur();
  } else if (e.key === 'Enter' && e.target.dataset && e.target.dataset.field === 'who') {
    e.preventDefault(); // a name is one line
    e.target.blur();
  } else if (e.key === 'Enter' && e.target.matches('[data-tagbox]')) {
    e.preventDefault();
    e.target.closest('.dk-card__pick').querySelector('[data-act="savetag"]').click();
  } else if (e.key === 'Enter' && e.target.dataset && e.target.dataset.field === 'title') {
    e.preventDefault(); // one line per title; commit it instead of adding a newline
    e.target.blur();
  } else if (e.key === 'Escape' && (deskForm || deskMapPickFor || deskTagEdit)) {
    deskForm = null;
    deskMapPickFor = null;
    deskTagEdit = null;
    renderDesk();
  }
});

// The board as plain text, for pasting into a status update or an email.
// Every note that has something in it, under one heading, each body indented
// beneath its own name so the titles stay legible in a wall of pasted text.
// A note left empty contributes nothing, and with no notes at all the whole
// section is left out.
function deskNoteLines() {
  const out = [];
  for (const n of deskNotes()) {
    const body = noteHtmlToText(n.html);
    if (!body) continue;
    out.push('', n.title, ...body.split('\n').map(line => (line ? '  ' + line : '')));
  }
  return out.length ? ['', 'WORKING NOTES', ...out] : [];
}

function deskSummaryText() {
  const age = it => '[' + deskDaysLabel(deskDays(it.moved)) + ']';
  const next = it => it.next || 'No next step recorded';
  const date = new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
  return [
    (deskOwner ? `Standing Desk of @${deskOwner.username} — ` : 'Standing Desk — ') + date,
    'Figures in brackets are days since each item was last updated.',
    '',
    deskOwner ? 'ASSIGNED TO THEM' : 'ASSIGNED TO ME',
    // (open items only; anything completed is listed at the end)
    ...(deskIn('mine').length ? deskIn('mine').map(it =>
      `- ${it.title}${it.tag ? ' (' + it.tag + ')' : ''} — ${next(it)} ${age(it)}`) : ['- None']),
    '',
    'WAITING ON OTHERS',
    ...(deskIn('waiting').length ? deskIn('waiting').map(it =>
      `- ${it.who || 'Unassigned'}: ${it.title} — ${next(it)} ${age(it)}`) : ['- None']),
    // what has been finished is on the board now, so it belongs in the report too
    ...(deskDone().length ? ['', 'COMPLETED', ...deskDone().map(it =>
      `- ${it.title}${it.tag ? ' (' + it.tag + ')' : ''} [completed ${deskDoneWhen(it)}]`)] : []),
    ...deskNoteLines(),
  ].join('\n');
}

/* ================================================================
   Settings
================================================================ */
function fillSettings() {
  const f = $('#formSettings');
  f.displayName.value = me.displayName || '';
  f.showDisplayName.checked = !!me.showDisplayName;
  f.visibility.value = me.visibility;
  f.bio.value = me.bio || '';
  $('#settingsWho').textContent = 'Signed in as @' + me.username;
  $('#settingsSaved').hidden = true;
  $('#settingsError').textContent = '';
}

$('#formSettings').addEventListener('submit', async e => {
  e.preventDefault();
  const f = e.target;
  try {
    const data = await api('/api/me', 'PUT', {
      displayName: f.displayName.value,
      showDisplayName: f.showDisplayName.checked,
      visibility: f.visibility.value,
      bio: f.bio.value,
    });
    me = data.user;
    $('#settingsSaved').hidden = false;
    $('#settingsError').textContent = '';
    setTimeout(() => { $('#settingsSaved').hidden = true; }, 2000);
  } catch (err) {
    $('#settingsError').textContent = err.message;
  }
});

$('#btnLogout').addEventListener('click', async () => {
  flushSave();
  flushDeskSave();
  stopLive();
  closeChat();
  stopNotifications();
  try { await api('/api/logout', 'POST'); } catch { /* ignore */ }
  me = null;
  mapsMine = [];
  mapsShared = [];
  currentMapId = null;
  currentMapInfo = null;
  desk = null; // the next account to sign in here gets its own board
  location.hash = '';
  show('auth');
});

// Export my data: the endpoint replies with a JSON attachment, so a plain
// navigation to it triggers the browser's download (cookie is sent along).
$('#btnExportData').addEventListener('click', () => {
  flushSave(); // make sure the current map's latest edits are included
  const a = document.createElement('a');
  a.href = '/api/me/export';
  a.download = ''; // filename comes from Content-Disposition
  document.body.appendChild(a);
  a.click();
  a.remove();
});

// Delete account: confirm in a sheet, require the password, then wipe + sign out
$('#btnDeleteAccount').addEventListener('click', () => {
  openSheet('#sheetDeleteAccount');
  $('#deleteAcctPassword').value = '';
  $('#deleteAcctError').textContent = '';
  requestAnimationFrame(() => $('#deleteAcctPassword').focus());
});
$('#deleteAcctCancel').addEventListener('click', () => closeSheets());
$('#deleteAcctPassword').addEventListener('keydown', e => {
  e.stopPropagation();
  if (e.key === 'Enter') $('#deleteAcctConfirm').click();
  if (e.key === 'Escape') closeSheets();
});
$('#deleteAcctConfirm').addEventListener('click', async () => {
  const password = $('#deleteAcctPassword').value;
  if (!password) { $('#deleteAcctError').textContent = 'Enter your password to confirm.'; return; }
  $('#deleteAcctConfirm').disabled = true;
  try {
    await api('/api/me', 'DELETE', { password });
    // fully reset client state, exactly like sign-out. The desk went with the
    // account server-side, so drop it here without trying to flush it.
    flushSave(); stopLive(); closeChat(); closeSheets();
    clearTimeout(deskSaveTimer); deskDirty = false; desk = null;
    me = null; mapsMine = []; mapsShared = [];
    currentMapId = null; currentMapInfo = null;
    location.hash = '';
    show('auth');
  } catch (err) {
    $('#deleteAcctError').textContent = err.message;
    $('#deleteAcctConfirm').disabled = false;
  }
});

/* ================================================================
   Auth
================================================================ */
$('#tabLogin').addEventListener('click', () => {
  $('#tabLogin').classList.add('active');
  $('#tabRegister').classList.remove('active');
  $('#formLogin').hidden = false;
  $('#formRegister').hidden = true;
});
$('#tabRegister').addEventListener('click', () => {
  $('#tabRegister').classList.add('active');
  $('#tabLogin').classList.remove('active');
  $('#formRegister').hidden = false;
  $('#formLogin').hidden = true;
});

async function afterSignIn() {
  desk = null; // whoever just signed in gets their own board, not the last one's
  loadChatLayout();
  await loadMaps();
  refreshBadge();
  startNotifications();
  location.hash = '#/home';
  route();
}

$('#formLogin').addEventListener('submit', async e => {
  e.preventDefault();
  const f = e.target;
  try {
    const data = await api('/api/login', 'POST', {
      username: f.username.value.trim(),
      password: f.password.value,
    });
    me = data.user;
    $('#loginError').textContent = '';
    f.reset();
    await afterSignIn();
  } catch (err) {
    $('#loginError').textContent = err.message;
  }
});

$('#formRegister').addEventListener('submit', async e => {
  e.preventDefault();
  const f = e.target;
  try {
    const data = await api('/api/register', 'POST', {
      username: f.username.value.trim(),
      password: f.password.value,
      displayName: f.displayName.value.trim(),
      showDisplayName: f.showDisplayName.checked,
      // new accounts default to friends-only maps; no visibility question at signup
      visibility: 'friends',
    });
    me = data.user;
    $('#registerError').textContent = '';
    f.reset();
    await afterSignIn();
  } catch (err) {
    $('#registerError').textContent = err.message;
  }
});

/* ================================================================
   Boot
================================================================ */
(async function boot() {
  initEditor();
  initProfileViewer();
  try {
    const data = await api('/api/me');
    me = data.user;
    loadChatLayout();
    await loadMaps();
    refreshBadge();
    startNotifications();
  } catch { me = null; }
  route();
})();
