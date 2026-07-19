'use strict';
/*
 * MindMapShare (3D Mind Maps) server.
 * Accounts, sessions, friends, profile visibility, mind map storage, static files.
 *
 * Storage backends (picked automatically):
 *   - DATABASE_URL set   → Postgres (Neon, Render, any pg) — production
 *   - DATABASE_URL unset → JSON file in data/               — local dev / LAN
 *
 * Run: node server.js          (reads .env if present)
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

try { process.loadEnvFile(path.join(__dirname, '.env')); } catch { /* no .env — fine */ }

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const SESSION_TTL = 30 * 24 * 60 * 60 * 1000; // 30 days
const MAX_BODY = 2 * 1024 * 1024; // 2 MB
const DATABASE_URL = process.env.DATABASE_URL;

const newId = () => crypto.randomBytes(12).toString('hex');

// Map visibility tiers, most- to least-private. Declared up here because the
// storage backends normalize users at construction time (before the domain
// helpers section runs). Unknown/missing input coerces to friends-only.
const VISIBILITIES = ['private', 'friends', 'public'];
function normVisibility(v) {
  return VISIBILITIES.includes(v) ? v : 'friends';
}

/* ================================================================
   Storage — two backends, one async API:
     init(), getUserById, getUsersByIds, getUserByUsername,
     searchUsers(q), createUser(u), saveUser(u),
     getUserByMapId(mapId), getUsersWithEditor(userId),
     createSession(sid, userId), getSessionUser(sid), deleteSession(sid)
================================================================ */

function pgStore() {
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: DATABASE_URL, max: 5 });

  const rowToUser = r => r && normalizeUser({
    id: r.id,
    username: r.username,
    salt: r.salt,
    passHash: r.pass_hash,
    displayName: r.display_name,
    showDisplayName: r.show_display_name,
    visibility: r.visibility,
    bio: r.bio,
    createdAt: Number(r.created_at),
    friends: r.friends,
    requestsIn: r.requests_in,
    requestsOut: r.requests_out,
    map: r.map,
    maps: r.maps,
  });

  return {
    kind: 'postgres',
    async init() {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS users (
          id TEXT PRIMARY KEY,
          username TEXT UNIQUE NOT NULL,
          salt TEXT NOT NULL,
          pass_hash TEXT NOT NULL,
          display_name TEXT NOT NULL DEFAULT '',
          show_display_name BOOLEAN NOT NULL DEFAULT true,
          visibility TEXT NOT NULL DEFAULT 'public',
          bio TEXT NOT NULL DEFAULT '',
          created_at BIGINT NOT NULL,
          friends JSONB NOT NULL DEFAULT '[]',
          requests_in JSONB NOT NULL DEFAULT '[]',
          requests_out JSONB NOT NULL DEFAULT '[]',
          map JSONB NOT NULL DEFAULT '{}',
          maps JSONB NOT NULL DEFAULT '[]'
        )`);
      await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS maps JSONB NOT NULL DEFAULT '[]'`);
      // migrate legacy single-map rows into the multi-map shape
      await pool.query(`
        UPDATE users SET maps = jsonb_build_array(jsonb_build_object(
          'id', 'm' || id,
          'name', 'My Map',
          'visibility', visibility,
          'editors', '[]'::jsonb,
          'nodes', COALESCE(map->'nodes', '{}'::jsonb),
          'edges', COALESCE(map->'edges', '[]'::jsonb),
          'createdAt', created_at,
          'updatedAt', created_at))
        WHERE maps = '[]'::jsonb AND map ? 'nodes'`);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS sessions (
          sid TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          created_at BIGINT NOT NULL
        )`);
      await pool.query('DELETE FROM sessions WHERE created_at < $1', [Date.now() - SESSION_TTL]);
    },
    async getUserById(id) {
      const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [id]);
      return rowToUser(rows[0]);
    },
    async getUsersByIds(ids) {
      if (!ids || !ids.length) return [];
      const { rows } = await pool.query('SELECT * FROM users WHERE id = ANY($1)', [ids]);
      const byId = new Map(rows.map(r => [r.id, rowToUser(r)]));
      return ids.map(id => byId.get(id)).filter(Boolean);
    },
    async getUserByUsername(username) {
      const { rows } = await pool.query('SELECT * FROM users WHERE username = $1',
        [String(username || '').toLowerCase()]);
      return rowToUser(rows[0]);
    },
    async searchUsers(q) {
      const like = '%' + String(q || '').replace(/[%_\\]/g, '\\$&') + '%';
      const { rows } = await pool.query(
        `SELECT * FROM users
         WHERE $1 = '%%' OR username ILIKE $1 OR (show_display_name AND display_name ILIKE $1)
         ORDER BY created_at DESC LIMIT 100`, [like]);
      return rows.map(rowToUser);
    },
    async createUser(u) {
      await pool.query(
        `INSERT INTO users (id, username, salt, pass_hash, display_name, show_display_name,
                            visibility, bio, created_at, friends, requests_in, requests_out, maps)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12::jsonb,$13::jsonb)`,
        [u.id, u.username, u.salt, u.passHash, u.displayName, u.showDisplayName,
         u.visibility, u.bio, u.createdAt,
         JSON.stringify(u.friends), JSON.stringify(u.requestsIn),
         JSON.stringify(u.requestsOut), JSON.stringify(u.maps)]);
    },
    async saveUser(u) {
      await pool.query(
        `UPDATE users SET display_name=$2, show_display_name=$3, visibility=$4, bio=$5,
                          friends=$6::jsonb, requests_in=$7::jsonb, requests_out=$8::jsonb, maps=$9::jsonb
         WHERE id=$1`,
        [u.id, u.displayName, u.showDisplayName, u.visibility, u.bio,
         JSON.stringify(u.friends), JSON.stringify(u.requestsIn),
         JSON.stringify(u.requestsOut), JSON.stringify(u.maps)]);
    },
    async getUserByMapId(mapId) {
      const { rows } = await pool.query(
        `SELECT * FROM users
         WHERE jsonb_path_exists(maps, '$[*] ? (@.id == $mid)', jsonb_build_object('mid', $1::text))
         LIMIT 1`, [mapId]);
      return rowToUser(rows[0]);
    },
    async getUsersWithEditor(userId) {
      const { rows } = await pool.query(
        `SELECT * FROM users
         WHERE jsonb_path_exists(maps, '$[*].editors[*] ? (@ == $uid)', jsonb_build_object('uid', $1::text))`,
        [userId]);
      return rows.map(rowToUser);
    },
    async createSession(sid, userId) {
      await pool.query('INSERT INTO sessions (sid, user_id, created_at) VALUES ($1,$2,$3)',
        [sid, userId, Date.now()]);
    },
    async getSessionUser(sid) {
      const { rows } = await pool.query(
        `SELECT s.created_at AS s_created, u.* FROM sessions s
         JOIN users u ON u.id = s.user_id WHERE s.sid = $1`, [sid]);
      if (!rows[0]) return null;
      return { user: rowToUser(rows[0]), createdAt: Number(rows[0].s_created) };
    },
    async deleteSession(sid) {
      await pool.query('DELETE FROM sessions WHERE sid = $1', [sid]);
    },
  };
}

function fileStore() {
  const DATA_DIR = path.join(__dirname, 'data');
  const DATA_FILE = path.join(DATA_DIR, 'data.json');
  let db = { users: {}, sessions: {} };
  try {
    db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    if (!db.users) db.users = {};
    if (!db.sessions) db.sessions = {};
  } catch { /* first run */ }

  let saveTimer = null;
  const persist = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      const tmp = DATA_FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(db));
      fs.renameSync(tmp, DATA_FILE);
    }, 200);
  };

  // migrate legacy single-map users into the multi-map shape
  let migrated = false;
  for (const u of Object.values(db.users)) {
    if (!Array.isArray(u.maps) || !u.maps.length) migrated = true;
    normalizeUser(u);
  }
  if (migrated) persist();

  return {
    kind: 'json file (data/data.json)',
    async init() {},
    async getUserById(id) { return db.users[id] || null; },
    async getUsersByIds(ids) { return (ids || []).map(id => db.users[id]).filter(Boolean); },
    async getUserByUsername(username) {
      const uname = String(username || '').toLowerCase();
      return Object.values(db.users).find(u => u.username === uname) || null;
    },
    async searchUsers(q) {
      let users = Object.values(db.users);
      const needle = String(q || '').toLowerCase();
      if (needle) {
        users = users.filter(u =>
          u.username.includes(needle) ||
          (u.showDisplayName && u.displayName && u.displayName.toLowerCase().includes(needle)));
      }
      return users.sort((a, b) => b.createdAt - a.createdAt).slice(0, 100);
    },
    async createUser(u) { db.users[u.id] = u; persist(); },
    async saveUser(u) { db.users[u.id] = u; persist(); },
    async getUserByMapId(mapId) {
      return Object.values(db.users).find(u => (u.maps || []).some(m => m.id === mapId)) || null;
    },
    async getUsersWithEditor(userId) {
      return Object.values(db.users).filter(u => (u.maps || []).some(m => (m.editors || []).includes(userId)));
    },
    async createSession(sid, userId) { db.sessions[sid] = { userId, createdAt: Date.now() }; persist(); },
    async getSessionUser(sid) {
      const s = db.sessions[sid];
      if (!s) return null;
      const user = db.users[s.userId];
      return user ? { user, createdAt: s.createdAt } : null;
    },
    async deleteSession(sid) { delete db.sessions[sid]; persist(); },
  };
}

const store = DATABASE_URL ? pgStore() : fileStore();

/* ================================================================
   Domain helpers
================================================================ */
function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

const MAX_MAPS = 20;
const MAX_EDITORS = 20;

function makeMap(name, visibility, seedLabel) {
  const now = Date.now();
  return {
    id: newId(),
    name: String(name || '').trim().slice(0, 60) || 'Untitled map',
    visibility: normVisibility(visibility),
    editors: [],
    nodes: { n1: { id: 'n1', label: seedLabel || 'Me', pos: [0, 0, 0], r: 62, hue: 0, parentId: null, kind: 'bubble' } },
    edges: [],
    chat: [],
    createdAt: now,
    updatedAt: now,
  };
}

const MAX_CHAT = 400; // per map; oldest entries roll off

// Legacy users carry a single `map`; wrap it into the multi-map shape in place.
function normalizeUser(u) {
  if (!u) return u;
  if (!Array.isArray(u.maps)) u.maps = [];
  if (!u.maps.length) {
    const m = makeMap('My Map', u.visibility, u.displayName || u.username);
    m.id = 'm' + u.id; // stable id so repeated reads agree before the first save
    if (u.map && u.map.nodes && Object.keys(u.map.nodes).length) {
      m.nodes = u.map.nodes;
      m.edges = Array.isArray(u.map.edges) ? u.map.edges : [];
    }
    u.maps = [m];
  }
  for (const m of u.maps) {
    if (!Array.isArray(m.editors)) m.editors = [];
    m.visibility = normVisibility(m.visibility); // preserve valid tiers, coerce junk
    if (!m.nodes || typeof m.nodes !== 'object') m.nodes = {};
    if (!Array.isArray(m.edges)) m.edges = [];
    if (!Array.isArray(m.chat)) m.chat = [];
  }
  delete u.map;
  return u;
}

function relationTo(viewer, owner) {
  if (!viewer) return 'none';
  if (viewer.id === owner.id) return 'self';
  if ((owner.friends || []).includes(viewer.id)) return 'friends';
  if ((owner.requestsIn || []).includes(viewer.id)) return 'out';   // viewer sent a request
  if ((owner.requestsOut || []).includes(viewer.id)) return 'in';   // owner sent viewer a request
  return 'none';
}

function canViewMapObj(m, owner, viewer) {
  const rel = relationTo(viewer, owner);
  if (rel === 'self') return true;
  // an explicit edit grant always overrides the visibility tier, even 'private'
  if (viewer && (m.editors || []).includes(viewer.id)) return true;
  if (m.visibility === 'private') return false; // owner (and editors, above) only
  if (m.visibility === 'public') return true;
  return m.visibility === 'friends' && rel === 'friends';
}

// Private and friends-only maps are invisible to those who can't view them:
// not listed on the profile, not counted.
function visibleMapsOf(owner, viewer) {
  return (owner.maps || []).filter(m => canViewMapObj(m, owner, viewer));
}

function mapMeta(m, extra) {
  return Object.assign({
    id: m.id,
    name: m.name,
    visibility: m.visibility,
    nodeCount: Object.keys(m.nodes || {}).length,
    updatedAt: m.updatedAt || 0,
  }, extra || {});
}

function ownerRef(u) {
  return { username: u.username, name: u.showDisplayName && u.displayName ? u.displayName : null };
}

function publicUser(u, viewer) {
  const visible = visibleMapsOf(u, viewer);
  return {
    username: u.username,
    name: u.showDisplayName && u.displayName ? u.displayName : null,
    bio: u.bio || '',
    mapCount: visible.length,
    nodeCount: visible.reduce((s, m) => s + Object.keys(m.nodes || {}).length, 0),
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

/* ================================================================
   Change diffing — turn a before/after map into human activity lines
   like: Bob added bubble "Sun"
================================================================ */
function labelOf(n) {
  const l = (n && n.label ? String(n.label).trim() : '') || 'Untitled';
  return l.length > 40 ? l.slice(0, 40) + '…' : l;
}

function diffMaps(before, after, actor) {
  const entries = [];
  const bn = before.nodes || {}, an = after.nodes || {};
  const noun = n => (n.kind === 'container' ? 'group' : 'bubble');

  for (const id of Object.keys(an)) {
    const now = an[id], was = bn[id];
    if (!was) {
      entries.push(`added ${noun(now)} "${labelOf(now)}"`);
    } else {
      if ((was.label || '') !== (now.label || '')) {
        entries.push(`renamed ${noun(now)} "${labelOf(was)}" → "${labelOf(now)}"`);
      }
      const wasParent = was.parentId || null, nowParent = now.parentId || null;
      if (wasParent !== nowParent) {
        if (nowParent && an[nowParent]) entries.push(`moved "${labelOf(now)}" into group "${labelOf(an[nowParent])}"`);
        else if (wasParent) entries.push(`took "${labelOf(now)}" out of a group`);
      }
    }
  }
  for (const id of Object.keys(bn)) {
    if (!an[id]) entries.push(`deleted ${noun(bn[id])} "${labelOf(bn[id])}"`);
  }

  const edgeKey = e => (e.a < e.b ? e.a + '|' + e.b : e.b + '|' + e.a);
  const be = new Map((before.edges || []).map(e => [edgeKey(e), e]));
  const ae = new Map((after.edges || []).map(e => [edgeKey(e), e]));
  const pair = e => `"${labelOf(an[e.a] || bn[e.a] || {})}" ↔ "${labelOf(an[e.b] || bn[e.b] || {})}"`;
  for (const [k, e] of ae) {
    if (!be.has(k)) entries.push(`connected ${pair(e)}`);
    else if ((be.get(k).w || 1) !== (e.w || 1)) entries.push(`set ${pair(e)} strength to ${e.w}`);
  }
  for (const [k, e] of be) {
    if (!ae.has(k)) entries.push(`removed the connection ${pair(e)}`);
  }

  // collapse a big rework into one line so the log stays readable
  if (entries.length > 6) {
    return [{ kind: 'activity', actor, text: `made ${entries.length} changes`, ts: Date.now(), id: newId() }];
  }
  return entries.map(text => ({ kind: 'activity', actor, text, ts: Date.now(), id: newId() }));
}

/* ================================================================
   Live hub — in-memory SSE fan-out + presence, keyed by map id.
   Nothing here is persisted; it is pure connection state.
================================================================ */
const liveHub = new Map(); // mapId → { clients:Set<res>, present:Map<res,{username,name}> }

function hubFor(mapId) {
  let h = liveHub.get(mapId);
  if (!h) { h = { clients: new Set(), present: new Map() }; liveHub.set(mapId, h); }
  return h;
}

function broadcast(mapId, event, data, exceptRes) {
  const h = liveHub.get(mapId);
  if (!h) return;
  const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of h.clients) {
    if (res === exceptRes) continue;
    try { res.write(frame); } catch { /* dropped; cleanup runs on close */ }
  }
}

function presenceList(mapId) {
  const h = liveHub.get(mapId);
  if (!h) return [];
  const seen = new Map();
  for (const p of h.present.values()) seen.set(p.username, p); // one entry per user
  return [...seen.values()];
}

function broadcastPresence(mapId) {
  broadcast(mapId, 'presence', { users: presenceList(mapId) });
}

function pushChat(map, entry) {
  map.chat.push(entry);
  if (map.chat.length > MAX_CHAT) map.chat.splice(0, map.chat.length - MAX_CHAT);
}

// Open a long-lived Server-Sent Events stream for one viewer of one map.
function startLiveStream(req, res, mapId, who) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no', // disable proxy buffering (nginx) so events flush live
  });
  res.write('retry: 3000\n\n'); // tell EventSource to reconnect quickly if dropped

  const h = hubFor(mapId);
  h.clients.add(res);
  h.present.set(res, who);
  broadcastPresence(mapId);
  res.write(`event: hello\ndata: ${JSON.stringify({ you: who, users: presenceList(mapId) })}\n\n`);

  const beat = setInterval(() => {
    try { res.write(': ping\n\n'); } catch { /* closed */ }
  }, 25000);

  const cleanup = () => {
    clearInterval(beat);
    h.clients.delete(res);
    h.present.delete(res);
    if (!h.clients.size) liveHub.delete(mapId);
    else broadcastPresence(mapId);
  };
  req.on('close', cleanup);
  req.on('error', cleanup);
}

/* ================================================================
   Map validation
================================================================ */
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

/* ================================================================
   Sessions, cookies, rate limiting
================================================================ */
function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function isSecure(req) {
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  return proto === 'https';
}

async function authUser(req) {
  const sid = parseCookies(req).sid;
  if (!sid) return null;
  const sess = await store.getSessionUser(sid);
  if (!sess) return null;
  if (Date.now() - sess.createdAt > SESSION_TTL) {
    await store.deleteSession(sid);
    return null;
  }
  return sess.user;
}

async function startSession(req, res, userId) {
  const sid = crypto.randomBytes(32).toString('hex');
  await store.createSession(sid, userId);
  res.setHeader('Set-Cookie',
    `sid=${sid}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL / 1000}` +
    (isSecure(req) ? '; Secure' : ''));
}

function clientIp(req) {
  const xf = req.headers['x-forwarded-for'];
  return xf ? String(xf).split(',')[0].trim() : (req.socket.remoteAddress || 'unknown');
}

const attempts = new Map(); // key → { n, t }
function tooMany(key, limit, windowMs) {
  const now = Date.now();
  if (attempts.size > 2000) {
    for (const [k, a] of attempts) if (now - a.t > windowMs) attempts.delete(k);
  }
  const a = attempts.get(key);
  if (!a || now - a.t > windowMs) { attempts.set(key, { n: 1, t: now }); return false; }
  a.n++;
  return a.n > limit;
}

/* ================================================================
   Request plumbing
================================================================ */
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

/* ================================================================
   API
================================================================ */
async function handleApi(req, res, pathname) {
  const route = req.method + ' ' + pathname;

  // --- auth ---
  if (route === 'POST /api/register') {
    if (tooMany('reg:' + clientIp(req), 10, 60 * 60 * 1000)) {
      return sendJSON(res, 429, { error: 'Too many sign-ups from this address. Try again later.' });
    }
    const body = await readBody(req);
    const username = String(body.username || '').trim().toLowerCase();
    const password = String(body.password || '');
    if (!/^[a-z0-9_]{3,20}$/.test(username)) return sendJSON(res, 400, { error: 'Username must be 3–20 characters: letters, numbers, underscores.' });
    if (password.length < 6) return sendJSON(res, 400, { error: 'Password must be at least 6 characters.' });
    if (await store.getUserByUsername(username)) return sendJSON(res, 409, { error: 'That username is taken.' });
    const salt = crypto.randomBytes(16).toString('hex');
    const displayName = String(body.displayName || '').trim().slice(0, 40);
    const u = {
      id: newId(),
      username,
      salt,
      passHash: hashPassword(password, salt),
      displayName,
      showDisplayName: body.showDisplayName !== false,
      // signup no longer asks; normVisibility defaults the unset field to friends-only
      visibility: normVisibility(body.visibility),
      bio: '',
      createdAt: Date.now(),
      friends: [], requestsIn: [], requestsOut: [],
      maps: [makeMap('My Map', body.visibility, displayName || username)],
    };
    try {
      await store.createUser(u);
    } catch (err) {
      if (err && err.code === '23505') return sendJSON(res, 409, { error: 'That username is taken.' });
      throw err;
    }
    await startSession(req, res, u.id);
    return sendJSON(res, 200, { user: meUser(u) });
  }

  if (route === 'POST /api/login') {
    const ip = clientIp(req);
    if (tooMany('login:' + ip, 25, 15 * 60 * 1000)) {
      return sendJSON(res, 429, { error: 'Too many attempts. Try again in a few minutes.' });
    }
    const body = await readBody(req);
    const u = await store.getUserByUsername(body.username);
    const password = String(body.password || '');
    if (!u || hashPassword(password, u.salt) !== u.passHash) {
      return sendJSON(res, 401, { error: 'Wrong username or password.' });
    }
    attempts.delete('login:' + ip);
    await startSession(req, res, u.id);
    return sendJSON(res, 200, { user: meUser(u) });
  }

  if (route === 'POST /api/logout') {
    const sid = parseCookies(req).sid;
    if (sid) await store.deleteSession(sid);
    res.setHeader('Set-Cookie', 'sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0' + (isSecure(req) ? '; Secure' : ''));
    return sendJSON(res, 200, { ok: true });
  }

  // --- everything below requires sign-in ---
  const user = await authUser(req);
  if (!user) return sendJSON(res, 401, { error: 'Not signed in.' });

  if (route === 'GET /api/me') return sendJSON(res, 200, { user: meUser(user) });

  if (route === 'PUT /api/me') {
    const body = await readBody(req);
    if ('displayName' in body) user.displayName = String(body.displayName || '').trim().slice(0, 40);
    if ('showDisplayName' in body) user.showDisplayName = !!body.showDisplayName;
    if ('visibility' in body) user.visibility = normVisibility(body.visibility);
    if ('bio' in body) user.bio = String(body.bio || '').slice(0, 300);
    await store.saveUser(user);
    return sendJSON(res, 200, { user: meUser(user) });
  }

  // --- maps ---
  if (route === 'GET /api/maps') {
    const editorIds = new Set();
    for (const m of user.maps) for (const id of m.editors) editorIds.add(id);
    const editorUsers = await store.getUsersByIds([...editorIds]);
    const byId = new Map(editorUsers.map(x => [x.id, x]));
    const mine = user.maps.map(m => mapMeta(m, {
      editors: m.editors.map(id => byId.get(id)).filter(Boolean).map(ownerRef),
    }));
    const owners = await store.getUsersWithEditor(user.id);
    const shared = [];
    for (const owner of owners) {
      if (owner.id === user.id) continue;
      for (const m of owner.maps) {
        if ((m.editors || []).includes(user.id)) shared.push(mapMeta(m, { owner: ownerRef(owner) }));
      }
    }
    return sendJSON(res, 200, { mine, shared });
  }

  if (route === 'POST /api/maps') {
    if (user.maps.length >= MAX_MAPS) return sendJSON(res, 400, { error: `You can have up to ${MAX_MAPS} maps.` });
    const body = await readBody(req);
    const m = makeMap(body.name, body.visibility, user.displayName || user.username);
    user.maps.push(m);
    await store.saveUser(user);
    return sendJSON(res, 200, { map: mapMeta(m, { editors: [] }) });
  }

  const mapMatch = pathname.match(/^\/api\/maps\/([A-Za-z0-9]{1,40})(?:\/(meta|editors|chat|live))?$/);
  if (mapMatch) {
    const mapId = mapMatch[1], sub = mapMatch[2];
    const owner = user.maps.some(m => m.id === mapId) ? user : await store.getUserByMapId(mapId);
    const m = owner && owner.maps.find(x => x.id === mapId);
    // a map the viewer may not see behaves exactly like a map that doesn't exist
    if (!m || !canViewMapObj(m, owner, user)) return sendJSON(res, 404, { error: 'No such map.' });
    const isOwner = owner.id === user.id;
    const canEdit = isOwner || (m.editors || []).includes(user.id);

    if (!sub && req.method === 'GET') {
      return sendJSON(res, 200, {
        map: { id: m.id, name: m.name, visibility: m.visibility, nodes: m.nodes, edges: m.edges },
        owner: ownerRef(owner), isOwner, canEdit,
        present: presenceList(m.id),
      });
    }
    if (!sub && req.method === 'PUT') {
      if (!canEdit) return sendJSON(res, 403, { error: 'You do not have edit permission for this map.' });
      const body = await readBody(req);
      const clean = sanitizeMap(body.map);
      if (!clean) return sendJSON(res, 400, { error: 'Invalid map.' });
      const before = { nodes: m.nodes, edges: m.edges };
      const activity = diffMaps(before, clean, ownerRef(user));
      m.nodes = clean.nodes;
      m.edges = clean.edges;
      m.updatedAt = Date.now();
      for (const entry of activity) pushChat(m, entry);
      await store.saveUser(owner);
      // live push: others viewing this map get the new state + the activity lines
      broadcast(m.id, 'map', { nodes: m.nodes, edges: m.edges, by: user.username }, res);
      for (const entry of activity) broadcast(m.id, 'chat', entry);
      return sendJSON(res, 200, { ok: true });
    }
    if (sub === 'chat' && req.method === 'GET') {
      return sendJSON(res, 200, { chat: m.chat, canPost: canEdit });
    }
    if (sub === 'chat' && req.method === 'POST') {
      if (!canEdit) return sendJSON(res, 403, { error: 'Only people who can edit this map can chat here.' });
      const body = await readBody(req);
      const text = String(body.text || '').trim().slice(0, 500);
      if (!text) return sendJSON(res, 400, { error: 'Empty message.' });
      const entry = { kind: 'message', actor: ownerRef(user), text, ts: Date.now(), id: newId() };
      pushChat(m, entry);
      await store.saveUser(owner);
      broadcast(m.id, 'chat', entry);
      return sendJSON(res, 200, { entry });
    }
    if (sub === 'live' && req.method === 'GET') {
      return startLiveStream(req, res, m.id, Object.assign(ownerRef(user), { canEdit }));
    }
    if (!sub && req.method === 'DELETE') {
      if (!isOwner) return sendJSON(res, 403, { error: 'Only the owner can delete a map.' });
      if (user.maps.length <= 1) return sendJSON(res, 400, { error: 'You need at least one map.' });
      user.maps = user.maps.filter(x => x.id !== mapId);
      await store.saveUser(user);
      broadcast(mapId, 'gone', { reason: 'deleted' });
      return sendJSON(res, 200, { ok: true });
    }
    if (sub === 'meta' && req.method === 'PUT') {
      if (!isOwner) return sendJSON(res, 403, { error: 'Only the owner can change map settings.' });
      const body = await readBody(req);
      if ('name' in body) m.name = String(body.name || '').trim().slice(0, 60) || 'Untitled map';
      if ('visibility' in body) m.visibility = normVisibility(body.visibility);
      m.updatedAt = Date.now();
      await store.saveUser(user);
      broadcast(m.id, 'meta', { name: m.name, visibility: m.visibility });
      return sendJSON(res, 200, { map: mapMeta(m) });
    }
    if (sub === 'editors' && req.method === 'POST') {
      if (!isOwner) return sendJSON(res, 403, { error: 'Only the owner can change who edits this map.' });
      const body = await readBody(req);
      const target = await store.getUserByUsername(body.username);
      if (!target || target.id === user.id) return sendJSON(res, 400, { error: 'Invalid user.' });
      let removedTarget = false;
      if (body.action === 'remove') {
        m.editors = m.editors.filter(id => id !== target.id);
        removedTarget = true;
      } else {
        if (m.editors.length >= MAX_EDITORS) return sendJSON(res, 400, { error: `A map can have up to ${MAX_EDITORS} editors.` });
        if (!m.editors.includes(target.id)) m.editors.push(target.id);
      }
      m.updatedAt = Date.now();
      await store.saveUser(user);
      // if the removed editor can no longer view the map at all (private map, or a
      // friends-only map they're not a friend of), cut off their live stream
      if (removedTarget && !canViewMapObj(m, user, target)) {
        broadcast(m.id, 'revoked', { username: target.username });
      }
      const eds = await store.getUsersByIds(m.editors);
      return sendJSON(res, 200, { editors: eds.map(ownerRef) });
    }
    return sendJSON(res, 404, { error: 'Not found.' });
  }

  if (req.method === 'GET' && pathname === '/api/users') {
    const q = String(new URL(req.url, 'http://x').searchParams.get('q') || '').trim();
    const users = await store.searchUsers(q);
    return sendJSON(res, 200, { users: users.map(u => publicUser(u, user)) });
  }

  const profileMatch = pathname.match(/^\/api\/users\/([a-z0-9_]{3,20})$/);
  if (req.method === 'GET' && profileMatch) {
    const target = await store.getUserByUsername(profileMatch[1]);
    if (!target) return sendJSON(res, 404, { error: 'No such user.' });
    // only maps the viewer is allowed to see are listed at all
    return sendJSON(res, 200, {
      user: publicUser(target, user),
      maps: visibleMapsOf(target, user).map(m => mapMeta(m)),
    });
  }

  // --- friends ---
  if (route === 'GET /api/friends') {
    const [friends, incoming, outgoing] = await Promise.all([
      store.getUsersByIds(user.friends),
      store.getUsersByIds(user.requestsIn),
      store.getUsersByIds(user.requestsOut),
    ]);
    return sendJSON(res, 200, {
      friends: friends.map(u => publicUser(u, user)),
      incoming: incoming.map(u => publicUser(u, user)),
      outgoing: outgoing.map(u => publicUser(u, user)),
    });
  }

  const friendAction = pathname.match(/^\/api\/friends\/(request|accept|decline|cancel|remove)$/);
  if (req.method === 'POST' && friendAction) {
    const body = await readBody(req);
    const target = await store.getUserByUsername(body.username);
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
    await store.saveUser(user);
    await store.saveUser(target);
    return sendJSON(res, 200, { ok: true, relation: relationTo(user, target) });
  }

  return sendJSON(res, 404, { error: 'Not found.' });
}

/* ================================================================
   Static files
================================================================ */
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
          res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache' });
          res.end(html);
        });
        return;
      }
      res.writeHead(404); res.end('Not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache', // small files; always revalidate so deploys show up
    });
    res.end(buf);
  });
}

/* ================================================================
   Server
================================================================ */
const server = http.createServer(async (req, res) => {
  const pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  try {
    if (pathname.startsWith('/api/')) await handleApi(req, res, pathname);
    else serveStatic(req, res, pathname);
  } catch (err) {
    if (err.message === 'too large') return sendJSON(res, 413, { error: 'Request too large.' });
    if (err.message === 'bad json') return sendJSON(res, 400, { error: 'Bad request.' });
    console.error(new Date().toISOString(), req.method, pathname, err);
    sendJSON(res, 500, { error: 'Server error.' });
  }
});

server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.log(`Port ${PORT} is already in use — MindMapShare is probably already running.`);
    console.log(`Just open http://localhost:${PORT} in your browser.`);
    process.exit(0);
  }
  throw err;
});

store.init().then(() => {
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`MindMapShare is running (storage: ${store.kind}):`);
    console.log(`  This computer:  http://localhost:${PORT}`);
    if (!DATABASE_URL) {
      console.log('  NOTE: no DATABASE_URL set — using local file storage. Fine for');
      console.log('  home/LAN use; on cloud hosts data would be lost on redeploy.');
      for (const list of Object.values(os.networkInterfaces())) {
        for (const iface of list || []) {
          if (iface.family === 'IPv4' && !iface.internal) {
            console.log(`  Phone (same Wi-Fi): http://${iface.address}:${PORT}`);
          }
        }
      }
    }
  });
}).catch(err => {
  console.error('Failed to initialize storage:', err.message);
  process.exit(1);
});
