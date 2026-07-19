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
   3D map view (spheres, weighted edges, container spheres)
================================================================ */
function createMapView(host, opts = {}) {
  const editable = !!opts.editable;
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const FOCAL = 700;

  host.innerHTML = '';
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'edges');
  const layer = document.createElement('div');
  layer.className = 'nodes-layer';
  host.appendChild(svg);
  host.appendChild(layer);

  let map = { nodes: {}, edges: [] };
  let idCounter = 1;
  let hueCounter = 0;
  let yaw = 0.4, pitch = -0.25, camDist = 950;
  let spinning = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
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

  const nodeEls = new Map();
  const edgeEls = new Map();

  /* ---------- vector helpers ---------- */
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const add3 = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
  const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
  const len = a => Math.hypot(a[0], a[1], a[2]);
  const norm = a => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
  const randUnit = () => {
    const t = Math.random() * Math.PI * 2, z = Math.random() * 2 - 1, r = Math.sqrt(1 - z * z);
    return [r * Math.cos(t), z, r * Math.sin(t)];
  };

  /* ---------- projection ---------- */
  function project(p, w, h) {
    const cy = Math.cos(yaw), sy = Math.sin(yaw);
    const cp = Math.cos(pitch), sp = Math.sin(pitch);
    const x1 = p[0] * cy - p[2] * sy;
    const z1 = p[0] * sy + p[2] * cy;
    const y2 = p[1] * cp - z1 * sp;
    const z2 = p[1] * sp + z1 * cp;
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

  function growContainer(c) {
    if (!c || c.kind !== 'container') return;
    let need = 130;
    for (const ch of childrenOf(c.id)) {
      need = Math.max(need, len(sub(ch.pos, c.pos)) + ch.r + 20);
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
      el.className = 'bubble' + (n.kind === 'container' ? ' container' : '');
      el.style.setProperty('--main', col.main);
      el.style.setProperty('--lite', col.lite);
      el.style.setProperty('--dark', col.dark);
      el.style.width = n.r * 2 + 'px';
      el.style.height = n.r * 2 + 'px';
      const label = document.createElement('div');
      label.className = 'label';
      label.textContent = n.label || 'Untitled';
      el.appendChild(label);
      layer.appendChild(el);
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
      el.style.opacity = Math.max(0.4, Math.min(1, p.s * 1.05));
      // containers sit slightly behind their contents in the stacking order
      el.style.zIndex = Math.round(100000 - p.zc) - (n.kind === 'container' ? 40 : 0);
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
      els.line.setAttribute('x1', a.x); els.line.setAttribute('y1', a.y);
      els.line.setAttribute('x2', b.x); els.line.setAttribute('y2', b.y);
      const depth = (a.s + b.s) / 2;
      const hi = e.id === highlightedEdge;
      const hov = e.id === hoverEdgeId;
      // weight IS the thickness: 1 → hairline, 10 → thick rope
      let op = Math.max(0.18, Math.min(0.85, depth * 0.7));
      if (hov) op = Math.min(1, op + 0.35);
      if (hi) op = 1;
      els.line.setAttribute('stroke-opacity', op);
      els.line.setAttribute('stroke-width', Math.max(1.2, (0.5 + e.w) * depth) + (hi ? 1.5 : hov ? 1 : 0));
      if (els.handle) {
        els.handle.style.display = '';
        els.handle.setAttribute('transform', `translate(${(a.x + b.x) / 2}, ${(a.y + b.y) / 2}) scale(${Math.max(0.7, Math.min(1.2, depth))})`);
      }
    }

    // keep the hover highlight honest while the scene moves under a still cursor
    if (editable && lastMouse && !drag && !hoverLock) {
      applyHover(hitTest(lastMouse.x, lastMouse.y)[0] || null);
    }

    if (spinning && !drag && !sheetOpen()) yaw += 0.0028;
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
    const hits = editable ? hitTest(pt.x, pt.y) : [];
    const top = hits[0] || null;

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
      drag = { type: 'orbit', startX: e.clientX, startY: e.clientY, startYaw: yaw, startPitch: pitch, moved: false };
      host.classList.add('dragging');
    }
  });

  // hover tracking + "hovered a stack for a second" dropdown (mouse only)
  host.addEventListener('pointermove', e => {
    if (!editable || e.pointerType !== 'mouse') return;
    lastMouse = tapPoint(e);
    if (drag || hoverLock) return;
    clearTimeout(dwellTimer); dwellTimer = null;
    const hits = hitTest(lastMouse.x, lastMouse.y);
    applyHover(hits[0] || null);
    if (hits.length >= 2 && opts.onPick) {
      const cx = e.clientX, cy = e.clientY;
      dwellTimer = setTimeout(() => {
        if (drag || hoverLock || !lastMouse) return;
        const again = hitTest(lastMouse.x, lastMouse.y);
        if (again.length >= 2) opts.onPick(again, cx, cy, 'hover');
      }, 1000);
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
      if (n) clampInside(n);
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
      } else if (drag.type === 'orbit' && !drag.moved) {
        handleTap(e, 'bg', drag);
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
    const n = { id, label: '', pos: [0, 0, 0], r: 62, hue: hueCounter++ % HUES.length, parentId: null, kind: 'bubble' };

    if (sel && sel.kind === 'container') {
      n.parentId = sel.id;
      n.hue = sel.hue;
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

  function addContainer() {
    const sel = selectedId && map.nodes[selectedId];
    const id = newId();
    const base = sel ? sel.pos : [0, 0, 0];
    const offset = sel ? (sel.r + 150 + 90) : 200 + Math.random() * 120;
    const n = {
      id, label: '', kind: 'container', r: 150,
      hue: hueCounter++ % HUES.length, parentId: null,
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
    for (const id of doomed) delete map.nodes[id];
    map.edges = map.edges.filter(e => !doomed.includes(e.a) && !doomed.includes(e.b));
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
      if (old) n.pos = add3(old.pos, mul(norm(sub(n.pos, old.pos)), old.r + n.r + 50));
    }
    changed();
  }

  /* ---------- public API ---------- */
  return {
    setMap(m) {
      map = { nodes: {}, edges: [] };
      const nodes = (m && m.nodes) || {};
      for (const [id, n] of Object.entries(nodes)) {
        map.nodes[id] = {
          id,
          label: n.label || '',
          pos: Array.isArray(n.pos) ? [...n.pos] : [0, 0, 0],
          r: n.r || 62,
          hue: n.hue || 0,
          parentId: n.parentId || null,
          kind: n.kind === 'container' ? 'container' : 'bubble',
        };
      }
      map.edges = ((m && m.edges) || []).map(e => ({ id: e.id, a: e.a, b: e.b, w: e.w || 3 }));
      idCounter = 1;
      hueCounter = Object.keys(map.nodes).length;
      selectedId = null;
      connectFrom = null;
      highlightedEdge = null;
      hoverId = null;
      hoverEdgeId = null;
      hoverLock = false;
      lastTap = null;
      clearTimeout(pendingTimer); pendingTimer = null;
      clearTimeout(dwellTimer); dwellTimer = null;
      buildDOM();
    },
    getMap: () => map,
    getNode: id => map.nodes[id],
    getEdge: id => map.edges.find(e => e.id === id),
    getSelected: () => (selectedId && map.nodes[selectedId]) || null,
    containers,
    start() { if (!running) { running = true; requestAnimationFrame(frame); } },
    stop() { running = false; },
    addBubble, addContainer, deleteSelected, renameSelected, renameNode,
    setWeight, deleteEdge, moveIntoContainer,
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
    setPickHover(hit) { applyHover(hit); },
    setHoverLock(b) {
      hoverLock = b;
      clearTimeout(dwellTimer); dwellTimer = null;
      if (!b) applyHover(null); // next frame recomputes from the real cursor
    },
    zoom(f) { camDist = Math.min(3200, Math.max(300, camDist * f)); },
    resetCamera() { yaw = 0.4; pitch = -0.25; camDist = 950; },
    setSpin(b) { spinning = b; },
    getSpin: () => spinning,
  };
}

/* ================================================================
   App state + router
================================================================ */
let me = null;
let myMap = null;        // editable map view
let profileMap = null;   // read-only map view
let currentProfile = null;
let saveTimer = null;

const sections = ['auth', 'map', 'browse', 'friends', 'profile', 'settings'];

function show(name) {
  for (const s of sections) $('#view-' + s).hidden = s !== name;
  $('#topbar').hidden = name === 'auth';
  for (const a of document.querySelectorAll('#mainNav a')) {
    a.classList.toggle('active', a.dataset.nav === name);
  }
  if (myMap) { name === 'map' ? myMap.start() : myMap.stop(); }
  if (profileMap) { name === 'profile' ? profileMap.start() : profileMap.stop(); }
}

function route() {
  closeSheets();
  hidePickMenu();
  if (!me) { show('auth'); return; }
  const h = location.hash.replace(/^#\/?/, '') || 'map';
  if (h.startsWith('u/')) { openProfile(h.slice(2)); return; }
  if (h === 'browse') { show('browse'); loadBrowse(); return; }
  if (h === 'friends') { show('friends'); loadFriends(); return; }
  if (h === 'settings') { show('settings'); fillSettings(); return; }
  show('map');
}
window.addEventListener('hashchange', route);

/* ================================================================
   Sheets
================================================================ */
const sheetShade = $('#sheetShade');
const allSheets = ['#sheetRename', '#sheetEdge', '#sheetGroup'];

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

/* ---------- rename sheet ---------- */
let renameTarget = null;
function openRename(nodeId) {
  const n = myMap.getNode(nodeId);
  if (!n) return;
  renameTarget = nodeId;
  openSheet('#sheetRename');
  const input = $('#renameInput');
  input.value = n.label === 'Untitled' ? '' : n.label;
  input.placeholder = n.kind === 'container' ? 'Name this group…' : 'Type an idea…';
  requestAnimationFrame(() => { input.focus(); input.select(); });
}
function commitRenameIfOpen() {
  if (renameTarget && !$('#sheetRename').hidden) {
    myMap.renameNode(renameTarget, $('#renameInput').value);
  }
}
$('#renameSave').addEventListener('click', () => { commitRenameIfOpen(); closeSheets(); });
$('#renameCancel').addEventListener('click', () => closeSheets());
$('#renameInput').addEventListener('keydown', e => {
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

/* ================================================================
   Pick menu — choose between overlapping elements
================================================================ */
const pickMenu = $('#pickMenu');
let pickAnchor = null;

function describeHit(hit) {
  if (hit.type === 'node') {
    const n = myMap.getNode(hit.id);
    if (!n) return null;
    return {
      color: hueOf(n).main,
      label: n.label || 'Untitled',
      tag: n.kind === 'container' ? 'group' : 'bubble',
      isLine: false,
    };
  }
  const e = myMap.getEdge(hit.id);
  if (!e) return null;
  const na = myMap.getNode(e.a), nb = myMap.getNode(e.b);
  return {
    color: na ? hueOf(na).main : '#8A93A6',
    label: `${na ? na.label || 'Untitled' : '?'} ↔ ${nb ? nb.label || 'Untitled' : '?'}`,
    tag: 'weight ' + e.w,
    isLine: true,
  };
}

function showPickMenu(hits, cx, cy, mode) {
  if (allSheets.some(s => !$(s).hidden)) return; // never open over a bottom sheet
  pickMenu.innerHTML = '';
  pickMenu.dataset.mode = mode;
  pickAnchor = { x: cx, y: cy };
  for (const hit of hits) {
    const d = describeHit(hit);
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
    tag.textContent = d.tag;
    item.appendChild(dot);
    item.appendChild(lb);
    item.appendChild(tag);
    item.addEventListener('pointerenter', () => myMap.setPickHover(hit));
    item.addEventListener('pointerleave', () => myMap.setPickHover(null));
    item.addEventListener('click', () => {
      hidePickMenu();
      if (hit.type === 'node') myMap.selectNode(hit.id);
      else openEdgeSheet(hit.id);
    });
    pickMenu.appendChild(item);
  }
  if (!pickMenu.children.length) return;
  myMap.setHoverLock(true);
  pickMenu.hidden = false;
  const r = pickMenu.getBoundingClientRect();
  pickMenu.style.left = Math.max(8, Math.min(cx + 6, window.innerWidth - r.width - 8)) + 'px';
  pickMenu.style.top = Math.max(8, Math.min(cy + 6, window.innerHeight - r.height - 8)) + 'px';
}

function hidePickMenu() {
  if (pickMenu.hidden) return;
  pickMenu.hidden = true;
  pickAnchor = null;
  if (myMap) { myMap.setPickHover(null); myMap.setHoverLock(false); }
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
const DEFAULT_HINT = 'Tap to select · Drag background to orbit · Pinch/scroll to zoom · Double-tap overlapping items to pick one';

function setHint(text, accent) {
  hintEl.textContent = text;
  hintEl.classList.toggle('accent', !!accent);
}

function saveMap() {
  clearTimeout(saveTimer);
  const state = $('#saveState');
  state.hidden = false;
  state.textContent = 'Saving…';
  saveTimer = setTimeout(async () => {
    try {
      await api('/api/map', 'PUT', { map: myMap.getMap() });
      state.textContent = 'Saved ✓';
      setTimeout(() => { if (state.textContent === 'Saved ✓') state.hidden = true; }, 1500);
    } catch {
      state.textContent = 'Save failed — retrying…';
      saveTimer = setTimeout(saveMap, 3000);
    }
  }, 800);
}

function refreshToolbar() {
  const sel = myMap ? myMap.getSelected() : null;
  $('#btnConnect').disabled = !sel;
  $('#btnRename').disabled = !sel;
  $('#btnDelete').disabled = !sel;
  $('#btnGroupMenu').disabled = !sel || sel.kind === 'container';
  $('#btnAddBubble').textContent = sel && sel.kind === 'container' ? '+ Bubble in group' : '+ Bubble';
}

function initEditor() {
  myMap = createMapView($('#myMapHost'), {
    editable: true,
    onChange: saveMap,
    onSelect: () => {
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
    onPick: showPickMenu,
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
  $('#btnDelete').addEventListener('click', () => { myMap.deleteSelected(); refreshToolbar(); });
  $('#btnGroupMenu').addEventListener('click', openGroupSheet);

  const btnSpin = $('#btnSpin');
  btnSpin.classList.toggle('active', true);
  btnSpin.addEventListener('click', () => {
    myMap.setSpin(!myMap.getSpin());
    btnSpin.classList.toggle('active', myMap.getSpin());
  });
  btnSpin.classList.toggle('active', myMap.getSpin());
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
    } else if (e.key === 'Escape' && myMap.isConnecting()) {
      myMap.cancelConnect();
      $('#btnConnect').classList.remove('active');
      setHint(DEFAULT_HINT, false);
    }
  });

  refreshToolbar();
}

async function loadMyMap() {
  const data = await api('/api/map');
  myMap.setMap(data.map);
  refreshToolbar();
}

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
  hd.textContent = '@' + u.username + ' · ' + u.nodeCount + ' bubble' + (u.nodeCount === 1 ? '' : 's');
  who.appendChild(nm);
  who.appendChild(hd);
  card.appendChild(av);
  card.appendChild(who);
  if (actionsHtmlBuilder) {
    actionsHtmlBuilder(card, u);
  } else {
    const meta = document.createElement('div');
    meta.className = 'meta';
    const pill = document.createElement('span');
    pill.className = 'pill' + (u.relation === 'friends' ? ' friends' : '');
    pill.textContent = u.relation === 'friends' ? '✓ Friends'
      : u.visibility === 'public' ? 'Public' : 'Friends only';
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

async function refreshBadge() {
  try {
    const data = await api('/api/friends');
    updateBadge(data.incoming.length);
  } catch { /* not signed in */ }
}

/* ================================================================
   Profile (view someone else's map)
================================================================ */
async function openProfile(username) {
  if (me && username === me.username) { location.hash = '#/map'; return; }
  show('profile');
  try {
    const data = await api('/api/users/' + username);
    currentProfile = data;
    const u = data.user;
    $('#profileName').textContent = u.name || '@' + u.username;
    $('#profileHandle').textContent = '@' + u.username +
      (u.bio ? ' · ' + u.bio : '') +
      (data.canView ? ' · ' + u.nodeCount + ' bubbles' : '');
    renderFriendButton();
    if (data.canView) {
      $('#profileLocked').hidden = true;
      $('#profileToolbar').hidden = false;
      profileMap.setMap(data.map);
      profileMap.start();
    } else {
      $('#profileLocked').hidden = false;
      $('#profileToolbar').hidden = true;
      $('#lockedText').textContent = (u.name || '@' + u.username) + "'s mind map is visible to friends only.";
      profileMap.setMap({ nodes: {}, edges: [] });
    }
  } catch (err) {
    $('#profileName').textContent = 'Not found';
    $('#profileHandle').textContent = err.message;
    $('#btnFriendAction').hidden = true;
    $('#profileLocked').hidden = false;
    $('#lockedText').textContent = err.message;
  }
}

function renderFriendButton() {
  const btn = $('#btnFriendAction');
  if (!currentProfile) { btn.hidden = true; return; }
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

$('#btnProfileBack').addEventListener('click', () => {
  if (history.length > 1) history.back();
  else location.hash = '#/browse';
});

function initProfileViewer() {
  profileMap = createMapView($('#profileMapHost'), { editable: false });
  $('#btnPSpin').classList.add('active');
  $('#btnPSpin').addEventListener('click', () => {
    profileMap.setSpin(!profileMap.getSpin());
    $('#btnPSpin').classList.toggle('active', profileMap.getSpin());
  });
  $('#btnPCenter').addEventListener('click', () => profileMap.resetCamera());
  $('#btnPZoomIn').addEventListener('click', () => profileMap.zoom(0.85));
  $('#btnPZoomOut').addEventListener('click', () => profileMap.zoom(1.18));
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
  try { await api('/api/logout', 'POST'); } catch { /* ignore */ }
  me = null;
  location.hash = '';
  show('auth');
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
  await loadMyMap();
  refreshBadge();
  location.hash = '#/map';
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
      visibility: f.visibility.value,
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
    await loadMyMap();
    refreshBadge();
  } catch { me = null; }
  route();
})();
