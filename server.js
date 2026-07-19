'use strict';
/*
 * Mind/Map 3D — zero-dependency Node.js server.
 * Accounts, sessions, friends, profile visibility, mind map storage, static files.
 * Run: node server.js   (then open http://localhost:3000)
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'data.json');
const SESSION_TTL = 30 * 24 * 60 * 60 * 1000; // 30 days
const MAX_BODY = 2 * 1024 * 1024; // 2 MB

// ---------------- persistence ----------------
let db = { users: {}, sessions: {} };

function load() {
  try {
    db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    if (!db.users) db.users = {};
    if (!db.sessions) db.sessions = {};
  } catch { /* first run */ }
}

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = DATA_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db));
    fs.renameSync(tmp, DATA_FILE);
  }, 200);
}

// ---------------- helpers ----------------
const newId = () => crypto.randomBytes(12).toString('hex');

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

function findUserByUsername(username) {
  const uname = String(username || '').toLowerCase();
  return Object.values(db.users).find(u => u.username === uname) || null;
}

function defaultMap(label) {
  return {
    nodes: { n1: { id: 'n1', label: label || 'Me', pos: [0, 0, 0], r: 62, hue: 0, parentId: null, kind: 'bubble' } },
    edges: [],
  };
}

function relationTo(viewer, owner) {
  if (!viewer) return 'none';
  if (viewer.id === owner.id) return 'self';
  if ((owner.friends || []).includes(viewer.id)) return 'friends';
  if ((owner.requestsIn || []).includes(viewer.id)) return 'out';   // viewer sent a request
  if ((owner.requestsOut || []).includes(viewer.id)) return 'in';   // owner sent viewer a request
  return 'none';
}

function canViewMap(viewer, owner) {
  const rel = relationTo(viewer, owner);
  if (rel === 'self') return true;
  if (owner.visibility === 'public') return true;
  return rel === 'friends';
}

function publicUser(u, viewer) {
  return {
    username: u.username,
    name: u.showDisplayName && u.displayName ? u.displayName : null,
    bio: u.bio || '',
    visibility: u.visibility,
    nodeCount: Object.keys((u.map && u.map.nodes) || {}).length,
    friendCount: (u.friends || []).length,
    relation: viewer ? relationTo(viewer, u) : 'none',
  };
}

function meUser(u) {
  return {
    username: u.username,
    displayName: u.displayName || '',
    showDisplayName: !!u.showDisplayName,
    visibility: u.visibility,
    bio: u.bio || '',
  };
}

// ---------------- map validation ----------------
function sanitizeMap(input) {
  if (!input || typeof input !== 'object') return null;
  const out = { nodes: {}, edges: [] };
  const nodes = input.nodes && typeof input.nodes === 'object' ? input.nodes : {};
  const ids = Object.keys(nodes).slice(0, 500);
  const num = v => (typeof v === 'number' && isFinite(v) ? v : 0);
  for (const id of ids) {
    const n = nodes[id];
    if (!n || typeof n !== 'object') continue;
    const safeId = String(id).slice(0, 24);
    out.nodes[safeId] = {
      id: safeId,
      label: String(n.label || '').slice(0, 80),
      pos: Array.isArray(n.pos) ? [num(n.pos[0]), num(n.pos[1]), num(n.pos[2])] : [0, 0, 0],
      r: Math.max(20, Math.min(400, num(n.r) || 62)),
      hue: Math.max(0, Math.min(11, Math.floor(num(n.hue)))),
      parentId: n.parentId ? String(n.parentId).slice(0, 24) : null,
      kind: n.kind === 'container' ? 'container' : 'bubble',
    };
  }
  // drop parent references to nodes that don't exist / aren't containers
  for (const n of Object.values(out.nodes)) {
    const p = n.parentId && out.nodes[n.parentId];
    if (!p || p.kind !== 'container') n.parentId = null;
  }
  const edges = Array.isArray(input.edges) ? input.edges.slice(0, 2000) : [];
  const seen = new Set();
  for (const e of edges) {
    if (!e || typeof e !== 'object') continue;
    const a = String(e.a || '').slice(0, 24);
    const b = String(e.b || '').slice(0, 24);
    if (!out.nodes[a] || !out.nodes[b] || a === b) continue;
    const key = a < b ? a + '|' + b : b + '|' + a;
    if (seen.has(key)) continue;
    seen.add(key);
    out.edges.push({
      id: String(e.id || newId()).slice(0, 24),
      a, b,
      w: Math.max(1, Math.min(10, Math.round(num(e.w) || 1))),
    });
  }
  return out;
}

// ---------------- sessions / cookies ----------------
function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function authUser(req) {
  const sid = parseCookies(req).sid;
  if (!sid) return null;
  const sess = db.sessions[sid];
  if (!sess) return null;
  if (Date.now() - sess.createdAt > SESSION_TTL) { delete db.sessions[sid]; save(); return null; }
  return db.users[sess.userId] || null;
}

function startSession(res, userId) {
  const sid = crypto.randomBytes(32).toString('hex');
  db.sessions[sid] = { userId, createdAt: Date.now() };
  save();
  res.setHeader('Set-Cookie', `sid=${sid}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL / 1000}`);
}

// ---------------- request plumbing ----------------
function sendJSON(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch { reject(new Error('bad json')); }
    });
    req.on('error', reject);
  });
}

// ---------------- API ----------------
async function handleApi(req, res, pathname) {
  const user = authUser(req);
  const route = req.method + ' ' + pathname;

  // --- auth ---
  if (route === 'POST /api/register') {
    const body = await readBody(req);
    const username = String(body.username || '').trim().toLowerCase();
    const password = String(body.password || '');
    if (!/^[a-z0-9_]{3,20}$/.test(username)) return sendJSON(res, 400, { error: 'Username must be 3–20 characters: letters, numbers, underscores.' });
    if (password.length < 6) return sendJSON(res, 400, { error: 'Password must be at least 6 characters.' });
    if (findUserByUsername(username)) return sendJSON(res, 409, { error: 'That username is taken.' });
    const salt = crypto.randomBytes(16).toString('hex');
    const displayName = String(body.displayName || '').trim().slice(0, 40);
    const u = {
      id: newId(),
      username,
      salt,
      passHash: hashPassword(password, salt),
      displayName,
      showDisplayName: body.showDisplayName !== false,
      visibility: body.visibility === 'friends' ? 'friends' : 'public',
      bio: '',
      createdAt: Date.now(),
      friends: [], requestsIn: [], requestsOut: [],
      map: defaultMap(displayName || username),
    };
    db.users[u.id] = u;
    startSession(res, u.id);
    return sendJSON(res, 200, { user: meUser(u) });
  }

  if (route === 'POST /api/login') {
    const body = await readBody(req);
    const u = findUserByUsername(body.username);
    const password = String(body.password || '');
    if (!u || hashPassword(password, u.salt) !== u.passHash) {
      return sendJSON(res, 401, { error: 'Wrong username or password.' });
    }
    startSession(res, u.id);
    return sendJSON(res, 200, { user: meUser(u) });
  }

  if (route === 'POST /api/logout') {
    const sid = parseCookies(req).sid;
    if (sid) { delete db.sessions[sid]; save(); }
    res.setHeader('Set-Cookie', 'sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
    return sendJSON(res, 200, { ok: true });
  }

  // --- everything below requires sign-in ---
  if (!user) return sendJSON(res, 401, { error: 'Not signed in.' });

  if (route === 'GET /api/me') return sendJSON(res, 200, { user: meUser(user) });

  if (route === 'PUT /api/me') {
    const body = await readBody(req);
    if ('displayName' in body) user.displayName = String(body.displayName || '').trim().slice(0, 40);
    if ('showDisplayName' in body) user.showDisplayName = !!body.showDisplayName;
    if ('visibility' in body) user.visibility = body.visibility === 'friends' ? 'friends' : 'public';
    if ('bio' in body) user.bio = String(body.bio || '').slice(0, 300);
    save();
    return sendJSON(res, 200, { user: meUser(user) });
  }

  if (route === 'GET /api/map') return sendJSON(res, 200, { map: user.map });

  if (route === 'PUT /api/map') {
    const body = await readBody(req);
    const map = sanitizeMap(body.map);
    if (!map) return sendJSON(res, 400, { error: 'Invalid map.' });
    user.map = map;
    save();
    return sendJSON(res, 200, { ok: true });
  }

  if (req.method === 'GET' && pathname === '/api/users') {
    const q = String(new URL(req.url, 'http://x').searchParams.get('q') || '').trim().toLowerCase();
    let users = Object.values(db.users);
    if (q) {
      users = users.filter(u =>
        u.username.includes(q) ||
        (u.showDisplayName && u.displayName && u.displayName.toLowerCase().includes(q)));
    }
    users.sort((a, b) => b.createdAt - a.createdAt);
    return sendJSON(res, 200, { users: users.slice(0, 100).map(u => publicUser(u, user)) });
  }

  const profileMatch = pathname.match(/^\/api\/users\/([a-z0-9_]{3,20})$/);
  if (req.method === 'GET' && profileMatch) {
    const target = findUserByUsername(profileMatch[1]);
    if (!target) return sendJSON(res, 404, { error: 'No such user.' });
    const allowed = canViewMap(user, target);
    return sendJSON(res, 200, {
      user: publicUser(target, user),
      canView: allowed,
      map: allowed ? target.map : null,
    });
  }

  // --- friends ---
  if (route === 'GET /api/friends') {
    const pick = ids => (ids || []).map(id => db.users[id]).filter(Boolean).map(u => publicUser(u, user));
    return sendJSON(res, 200, {
      friends: pick(user.friends),
      incoming: pick(user.requestsIn),
      outgoing: pick(user.requestsOut),
    });
  }

  const friendAction = pathname.match(/^\/api\/friends\/(request|accept|decline|cancel|remove)$/);
  if (req.method === 'POST' && friendAction) {
    const body = await readBody(req);
    const target = findUserByUsername(body.username);
    if (!target || target.id === user.id) return sendJSON(res, 400, { error: 'Invalid user.' });
    const act = friendAction[1];
    const rm = (arr, id) => { const i = arr.indexOf(id); if (i >= 0) arr.splice(i, 1); };

    if (act === 'request') {
      if (user.friends.includes(target.id)) return sendJSON(res, 400, { error: 'Already friends.' });
      if (user.requestsIn.includes(target.id)) {
        // they already asked us — treat as accept
        rm(user.requestsIn, target.id); rm(target.requestsOut, user.id);
        user.friends.push(target.id); target.friends.push(user.id);
      } else if (!user.requestsOut.includes(target.id)) {
        user.requestsOut.push(target.id);
        target.requestsIn.push(user.id);
      }
    } else if (act === 'accept') {
      if (!user.requestsIn.includes(target.id)) return sendJSON(res, 400, { error: 'No request from that user.' });
      rm(user.requestsIn, target.id); rm(target.requestsOut, user.id);
      user.friends.push(target.id); target.friends.push(user.id);
    } else if (act === 'decline') {
      rm(user.requestsIn, target.id); rm(target.requestsOut, user.id);
    } else if (act === 'cancel') {
      rm(user.requestsOut, target.id); rm(target.requestsIn, user.id);
    } else if (act === 'remove') {
      rm(user.friends, target.id); rm(target.friends, user.id);
    }
    save();
    return sendJSON(res, 200, { ok: true, relation: relationTo(user, target) });
  }

  return sendJSON(res, 404, { error: 'Not found.' });
}

// ---------------- static files ----------------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end(); return; }
  fs.readFile(filePath, (err, buf) => {
    if (err) {
      // SPA fallback: unknown non-file routes get the app shell
      if (!path.extname(rel)) {
        fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (e2, html) => {
          if (e2) { res.writeHead(404); res.end('Not found'); return; }
          res.writeHead(200, { 'Content-Type': MIME['.html'] });
          res.end(html);
        });
        return;
      }
      res.writeHead(404); res.end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream' });
    res.end(buf);
  });
}

// ---------------- server ----------------
load();
const server = http.createServer(async (req, res) => {
  const pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  try {
    if (pathname.startsWith('/api/')) await handleApi(req, res, pathname);
    else serveStatic(req, res, pathname);
  } catch (err) {
    sendJSON(res, err.message === 'too large' ? 413 : 400, { error: err.message === 'bad json' ? 'Bad request.' : 'Server error.' });
  }
});

server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.log(`Port ${PORT} is already in use — Mind/Map 3D is probably already running.`);
    console.log(`Just open http://localhost:${PORT} in your browser.`);
    process.exit(0);
  }
  throw err;
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('Mind/Map 3D is running:');
  console.log(`  This computer:  http://localhost:${PORT}`);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const iface of list || []) {
      if (iface.family === 'IPv4' && !iface.internal) {
        console.log(`  Phone (same Wi-Fi): http://${iface.address}:${PORT}`);
      }
    }
  }
});
