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
// Admin console: a single password held in the ADMIN_PASSWORD env var (set in
// the Render dashboard). Unset → the admin page and its API are disabled.
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const ADMIN_TTL = 12 * 60 * 60 * 1000; // 12 hours

const newId = () => crypto.randomBytes(12).toString('hex');

// Map visibility tiers, most- to least-private. Declared up here because the
// storage backends normalize users at construction time (before the domain
// helpers section runs). Unknown/missing input coerces to friends-only.
const VISIBILITIES = ['private', 'friends', 'public'];
function normVisibility(v) {
  return VISIBILITIES.includes(v) ? v : 'friends';
}

/* ----------------------------------------------------------------
   The Standing Desk — one work board per account, always private.
   Where a mind map holds what you think, the desk holds what is
   actually on you: open items split by whose court the ball is in, a
   clock on each that resets when it changes hands, reference lines you
   look up constantly, and a scratch area.
   Declared up here (with normVisibility) because the storage backends
   normalize users at construction time, before the domain section runs.
---------------------------------------------------------------- */
const MAX_DESK_ITEMS = 40;      // open items on the board, both courts together
const MAX_DESK_REF = 40;        // pinned reference lines
const MAX_DESK_SCRATCH = 8000;  // characters in the scratch area
// How many items may sit in your own court at once. This is a discipline
// rule the board enforces in the UI, not a storage limit: nothing here ever
// deletes a card to satisfy it.
const DESK_COURT_CAP = 5;
const DESK_STALE_DAYS = 14;     // untouched this long and an item has gone cold

function makeDesk() {
  return { ref: [], items: [], scratch: '', closed: 0, updatedAt: 0 };
}

// Always returns a valid desk — used both to normalize what we read out of
// storage and to validate what a client PUTs in.
function sanitizeDesk(input) {
  const d = input && typeof input === 'object' ? input : {};
  const text = (v, n) => String(v == null ? '' : v).trim().slice(0, n);
  const items = [];
  for (const raw of Array.isArray(d.items) ? d.items : []) {
    if (!raw || typeof raw !== 'object') continue;
    const title = text(raw.title, 200);
    if (!title) continue; // a card with nothing written on it isn't a card
    const moved = Number(raw.moved);
    items.push({
      id: text(raw.id, 24) || newId(),
      title,
      tag: text(raw.tag, 80),
      next: text(raw.next, 300),
      who: text(raw.who, 80),
      court: raw.court === 'them' ? 'them' : 'me',
      // Clamped to now: a future timestamp would make an item permanently
      // fresh, and the whole point of the board is that the clock runs.
      moved: Number.isFinite(moved) && moved > 0 ? Math.min(moved, Date.now()) : Date.now(),
    });
    if (items.length >= MAX_DESK_ITEMS) break;
  }
  const closed = Math.floor(Number(d.closed));
  return {
    ref: (Array.isArray(d.ref) ? d.ref : [])
      .map(line => text(line, 200)).filter(Boolean).slice(0, MAX_DESK_REF),
    items,
    // not trimmed: leading blank lines and indentation are the user's own
    scratch: String(d.scratch == null ? '' : d.scratch).slice(0, MAX_DESK_SCRATCH),
    closed: Number.isFinite(closed) ? Math.max(0, Math.min(1e6, closed)) : 0,
    updatedAt: Number.isFinite(Number(d.updatedAt)) ? Number(d.updatedAt) : 0,
  };
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
    following: r.following,
    followers: r.followers,
    notifications: r.notifications,
    pushSubs: r.push_subs,
    map: r.map,
    maps: r.maps,
    desk: r.desk,
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
      // asymmetric follow graph (distinct from mutual friends)
      await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS following JSONB NOT NULL DEFAULT '[]'`);
      await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS followers JSONB NOT NULL DEFAULT '[]'`);
      // notification bell feed + Web Push subscriptions
      await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS notifications JSONB NOT NULL DEFAULT '[]'`);
      await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS push_subs JSONB NOT NULL DEFAULT '[]'`);
      // the Standing Desk — one private work board per account
      await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS desk JSONB NOT NULL DEFAULT '{}'`);
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
    async allUsers() {
      const { rows } = await pool.query('SELECT * FROM users ORDER BY created_at DESC LIMIT 1000');
      return rows.map(rowToUser);
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
                            visibility, bio, created_at, friends, requests_in, requests_out, maps,
                            following, followers, notifications, push_subs, desk)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12::jsonb,$13::jsonb,$14::jsonb,$15::jsonb,$16::jsonb,$17::jsonb,$18::jsonb)`,
        [u.id, u.username, u.salt, u.passHash, u.displayName, u.showDisplayName,
         u.visibility, u.bio, u.createdAt,
         JSON.stringify(u.friends), JSON.stringify(u.requestsIn),
         JSON.stringify(u.requestsOut), JSON.stringify(u.maps),
         JSON.stringify(u.following || []), JSON.stringify(u.followers || []),
         JSON.stringify(u.notifications || []), JSON.stringify(u.pushSubs || []),
         JSON.stringify(u.desk || makeDesk())]);
    },
    async saveUser(u) {
      await pool.query(
        `UPDATE users SET display_name=$2, show_display_name=$3, visibility=$4, bio=$5,
                          friends=$6::jsonb, requests_in=$7::jsonb, requests_out=$8::jsonb, maps=$9::jsonb,
                          following=$10::jsonb, followers=$11::jsonb,
                          notifications=$12::jsonb, push_subs=$13::jsonb, desk=$14::jsonb
         WHERE id=$1`,
        [u.id, u.displayName, u.showDisplayName, u.visibility, u.bio,
         JSON.stringify(u.friends), JSON.stringify(u.requestsIn),
         JSON.stringify(u.requestsOut), JSON.stringify(u.maps),
         JSON.stringify(u.following || []), JSON.stringify(u.followers || []),
         JSON.stringify(u.notifications || []), JSON.stringify(u.pushSubs || []),
         JSON.stringify(u.desk || makeDesk())]);
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
    // Delete a user and scrub every reference to them from other users: friend
    // links, requests, follow graph, and any map editor/like grants. Sessions
    // cascade via the FK. Done in one transaction so we never half-delete.
    async deleteUser(userId) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        // strip the id out of every other user's relationship arrays
        await client.query(
          `UPDATE users SET
             friends      = (friends      - $1),
             requests_in  = (requests_in  - $1),
             requests_out = (requests_out - $1),
             following    = (following    - $1),
             followers    = (followers    - $1)
           WHERE friends @> $2 OR requests_in @> $2 OR requests_out @> $2
              OR following @> $2 OR followers @> $2`,
          [userId, JSON.stringify([userId])]);
        // scrub the id from any map's editors[] and likes[] on other accounts
        const { rows } = await client.query(
          `SELECT id, maps FROM users
           WHERE jsonb_path_exists(maps, '$[*].editors[*] ? (@ == $u)', jsonb_build_object('u', $1::text))
              OR jsonb_path_exists(maps, '$[*].likes[*] ? (@ == $u)',   jsonb_build_object('u', $1::text))`,
          [userId]);
        for (const r of rows) {
          if (r.id === userId) continue;
          const maps = r.maps.map(m => ({
            ...m,
            editors: (m.editors || []).filter(id => id !== userId),
            likes: (m.likes || []).filter(id => id !== userId),
          }));
          await client.query('UPDATE users SET maps = $2::jsonb WHERE id = $1',
            [r.id, JSON.stringify(maps)]);
        }
        await client.query('DELETE FROM users WHERE id = $1', [userId]); // sessions cascade
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
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
    async allUsers() {
      return Object.values(db.users).sort((a, b) => b.createdAt - a.createdAt).slice(0, 1000);
    },
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
    async deleteUser(userId) {
      const rm = arr => Array.isArray(arr) ? arr.filter(id => id !== userId) : arr;
      for (const u of Object.values(db.users)) {
        if (u.id === userId) continue;
        u.friends = rm(u.friends);
        u.requestsIn = rm(u.requestsIn);
        u.requestsOut = rm(u.requestsOut);
        u.following = rm(u.following);
        u.followers = rm(u.followers);
        for (const m of u.maps || []) {
          m.editors = rm(m.editors);
          if (Array.isArray(m.likes)) m.likes = rm(m.likes);
        }
      }
      delete db.users[userId];
      for (const [sid, s] of Object.entries(db.sessions)) {
        if (s.userId === userId) delete db.sessions[sid];
      }
      persist();
    },
  };
}

const store = DATABASE_URL ? pgStore() : fileStore();

/* ================================================================
   Domain helpers
================================================================ */
function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

// A fixed decoy salt/hash used when a login names a nonexistent user, so we can
// still spend the same scrypt time and do a same-length constant-time compare
// (the compare always fails — `u` being null is the real gate). Same shapes as
// real records: 16-byte salt (32 hex), 64-byte hash (128 hex).
const DECOY_SALT = '00000000000000000000000000000000';
const DECOY_HASH = hashPassword('\0invalid-login-decoy\0', DECOY_SALT);

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
    comments: [],
    createdAt: now,
    updatedAt: now,
  };
}

const MAX_CHAT = 400; // per map; oldest entries roll off
const MAX_COMMENTS = 500; // per map; oldest entries roll off
const MAX_NOTIFS = 100; // per user; oldest entries roll off
const MAX_PUSH_SUBS = 20; // per user; browsers/devices they enabled push on


// Legacy users carry a single `map`; wrap it into the multi-map shape in place.
function normalizeUser(u) {
  if (!u) return u;
  if (!Array.isArray(u.following)) u.following = [];
  if (!Array.isArray(u.followers)) u.followers = [];
  if (!Array.isArray(u.notifications)) u.notifications = []; // bell feed (chat/comment alerts)
  if (!Array.isArray(u.pushSubs)) u.pushSubs = []; // Web Push subscriptions
  u.desk = sanitizeDesk(u.desk); // the Standing Desk; absent on accounts made before it existed
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
    if (!Array.isArray(m.comments)) m.comments = []; // viewer comments (any signed-in viewer)
    if (!Array.isArray(m.likes)) m.likes = []; // user ids who liked this map
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

function areFriends(a, b) {
  return !!a && !!b && (a.id === b.id || (a.friends || []).includes(b.id));
}

// A user's display name visibility follows their "share my display name" opt-in:
//  - opted in  (showDisplayName true): the display name is shown to anyone.
//  - opted out (default): it is shown only to the user themselves and their friends.
// Anyone who can't see the display name sees just the username.
function nameFor(target, viewer) {
  if (!target.displayName) return null;
  if (target.showDisplayName) return target.displayName;         // shared → everyone
  return areFriends(target, viewer) ? target.displayName : null; // private → friends + self
}

// The name a user presents in shared spaces they've joined (chat, presence,
// activity log among co-editors). Honors their own opt-out — if showDisplayName
// is off, they appear as just their username to everyone — but is not
// per-viewer friend-gated, since a chat line is stored once for all readers.
function selfName(u) {
  return u.showDisplayName && u.displayName ? u.displayName : null;
}
function actorRef(u) {
  return { username: u.username, name: selfName(u) };
}

// A comment as sent to a client. The stored record keeps an authorId so we can
// authorize deletes server-side; we never expose that id — instead we tell each
// viewer whether the comment is theirs (`mine`), which is all the UI needs.
function commentOut(c, viewer) {
  return {
    id: c.id,
    actor: c.actor,
    text: c.text,
    ts: c.ts,
    mine: !!viewer && c.authorId === viewer.id,
  };
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
    likeCount: (m.likes || []).length,
    commentCount: (m.comments || []).length,
  }, extra || {});
}

// mapMeta plus this viewer's like state — used where the viewer is known
// (feed, single-map view) and we want to render a filled/empty heart.
function mapMetaFor(m, viewer, extra) {
  return mapMeta(m, Object.assign({
    likedByMe: !!viewer && (m.likes || []).includes(viewer.id),
  }, extra || {}));
}

function ownerRef(u, viewer) {
  return { username: u.username, name: nameFor(u, viewer) };
}


function publicUser(u, viewer) {
  const visible = visibleMapsOf(u, viewer);
  return {
    username: u.username,
    name: nameFor(u, viewer),
    bio: u.bio || '',
    mapCount: visible.length,
    nodeCount: visible.reduce((s, m) => s + Object.keys(m.nodes || {}).length, 0),
    friendCount: (u.friends || []).length,
    followerCount: (u.followers || []).length,
    followingCount: (u.following || []).length,
    // does the signed-in viewer follow this user?
    followedByMe: !!viewer && (viewer.following || []).includes(u.id),
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
    aiEnabled: aiConfigured(), // whether AI map generation is available
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
  // Outline reordering touches many nodes at once, so it collapses into one
  // line rather than a "moved X" entry per item that shifted.
  let reordered = 0;

  for (const id of Object.keys(an)) {
    const now = an[id], was = bn[id];
    if (!was) {
      entries.push(`added ${noun(now)} "${labelOf(now)}"`);
    } else {
      if ((was.label || '') !== (now.label || '')) {
        entries.push(`renamed ${noun(now)} "${labelOf(was)}" → "${labelOf(now)}"`);
      }
      const wasNote = (was.note || '').trim(), nowNote = (now.note || '').trim();
      if (wasNote !== nowNote) {
        if (!wasNote) entries.push(`added a note to "${labelOf(now)}"`);
        else if (!nowNote) entries.push(`removed the note from "${labelOf(now)}"`);
        else entries.push(`edited the note on "${labelOf(now)}"`);
      }
      if (!was.done !== !now.done) {
        entries.push(`${now.done ? 'completed' : 'reopened'} "${labelOf(now)}"`);
      }
      const wasParent = was.parentId || null, nowParent = now.parentId || null;
      if (wasParent !== nowParent) {
        if (nowParent && an[nowParent]) entries.push(`moved "${labelOf(now)}" into group "${labelOf(an[nowParent])}"`);
        else if (wasParent) entries.push(`took "${labelOf(now)}" out of a group`);
      }
      // an order that was null before is the client numbering an old map for the
      // first time, not somebody rearranging it — don't report that as a change
      if (was.order !== null && was.order !== undefined && was.order !== now.order) reordered++;
    }
  }
  for (const id of Object.keys(bn)) {
    if (!an[id]) entries.push(`deleted ${noun(bn[id])} "${labelOf(bn[id])}"`);
  }
  if (reordered) entries.push('reordered the outline');

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
   Notifications + Web Push
   ----------------------------------------------------------------
   Two delivery channels for "someone chatted / commented" alerts:
     1. an in-app bell, fed live over a per-USER SSE stream (notifyHub)
        and backed by a stored user.notifications[] feed, and
     2. real OS-level Web Push to any browsers the user opted in on
        (user.pushSubs[]), so closed tabs still get pinged.
   Recipients of a map event = the owner + every editor + everyone who
   has previously commented on that map, minus whoever triggered it.
================================================================ */

// Web Push is optional: it only runs when VAPID keys are configured.
let webpush = null;
let pushReady = false;
(function initPush() {
  const pub = process.env.VAPID_PUBLIC_KEY;
  const priv = process.env.VAPID_PRIVATE_KEY;
  if (!pub || !priv) return; // not configured — in-app bell still works
  try {
    webpush = require('web-push');
    const subject = process.env.VAPID_SUBJECT || 'mailto:admin@example.com';
    webpush.setVapidDetails(subject, pub, priv);
    pushReady = true;
  } catch (err) {
    console.warn('Web Push disabled:', err.message);
  }
})();
const pushConfigured = () => pushReady;

// Per-user SSE hub for the notification bell (distinct from the per-map liveHub).
const notifyHub = new Map(); // userId → Set<res>

function startNotifyStream(req, res, userId) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 3000\n\n');
  let set = notifyHub.get(userId);
  if (!set) { set = new Set(); notifyHub.set(userId, set); }
  set.add(res);
  res.write('event: hello\ndata: {}\n\n');

  const beat = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* closed */ } }, 25000);
  const cleanup = () => {
    clearInterval(beat);
    set.delete(res);
    if (!set.size) notifyHub.delete(userId);
  };
  req.on('close', cleanup);
  req.on('error', cleanup);
}

function pushToUser(userId, event, data) {
  const set = notifyHub.get(userId);
  if (!set) return;
  const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of set) {
    try { res.write(frame); } catch { /* dropped; cleanup runs on close */ }
  }
}

// Fire OS-level Web Push to each of a user's subscriptions. Fire-and-forget so
// it never blocks the request; prunes subscriptions the browser has expired.
function sendWebPush(user, notif) {
  if (!pushConfigured() || !Array.isArray(user.pushSubs) || !user.pushSubs.length) return;
  const actor = notif.actor && (notif.actor.name || '@' + notif.actor.username) || 'Someone';
  let title;
  switch (notif.kind) {
    case 'comment': title = `${actor} commented on “${notif.mapName}”`; break;
    case 'edit':    title = `${actor} edited “${notif.mapName}”`; break;
    case 'newmap':  title = `${actor} posted a new map: “${notif.mapName}”`; break;
    default:        title = `${actor} chatted in “${notif.mapName}”`;
  }
  const payload = JSON.stringify({
    title,
    body: notif.text || '',
    url: '/#/u/' + notif.mapOwner,
    tag: 'map-' + notif.mapId,
  });
  let pruned = false;
  for (const sub of [...user.pushSubs]) {
    webpush.sendNotification(sub, payload).catch(err => {
      // 404/410 = the subscription is gone for good; drop it.
      if (err && (err.statusCode === 404 || err.statusCode === 410)) {
        user.pushSubs = (user.pushSubs || []).filter(s => s.endpoint !== sub.endpoint);
        pruned = true;
        store.saveUser(user).catch(() => {});
      }
    });
  }
  return pruned;
}

// A stored notification, as sent to a client. It's already free of anything
// private, so this is mostly a passthrough / shape guard.
function notifOut(n) {
  return {
    id: n.id, kind: n.kind, mapId: n.mapId, mapOwner: n.mapOwner,
    mapName: n.mapName, actor: n.actor, text: n.text, ts: n.ts, read: !!n.read,
  };
}

function unreadCount(u) {
  return (u.notifications || []).reduce((s, n) => s + (n.read ? 0 : 1), 0);
}

// Append a notification to a target user, honoring the per-user cap, and fan it
// out over both delivery channels (bell SSE + Web Push).
function deliverNotif(target, base) {
  if (!Array.isArray(target.notifications)) target.notifications = [];
  const notif = Object.assign({ id: newId(), ts: Date.now(), read: false }, base);
  target.notifications.push(notif);
  if (target.notifications.length > MAX_NOTIFS) {
    target.notifications.splice(0, target.notifications.length - MAX_NOTIFS);
  }
  pushToUser(target.id, 'notify', notifOut(notif)); // live in-app bell
  sendWebPush(target, notif);                        // OS-level push
  return notif;
}

// Deliver a chat / comment / edit alert for map `m` (owned by `owner`) triggered
// by `actorUser`. Mutates each recipient's notifications[] and persists it —
// EXCEPT the owner, whose record the caller saves alongside the map write.
//   opts.includeCommenters  also notify anyone who commented on the map (default true)
//   opts.dedupeMs           skip a recipient who already got the same kind of alert
//                           for this map from this actor within the window (0 = off)
async function notifyMapEvent(owner, m, actorUser, kind, text, opts = {}) {
  const includeCommenters = opts.includeCommenters !== false;
  const dedupeMs = opts.dedupeMs || 0;

  const recipientIds = new Set([owner.id, ...(m.editors || [])]);
  if (includeCommenters) {
    for (const c of (m.comments || [])) if (c.authorId) recipientIds.add(c.authorId);
  }
  recipientIds.delete(actorUser.id); // never notify the person who acted

  const base = {
    kind,
    mapId: m.id,
    mapOwner: owner.username,
    mapName: m.name,
    actor: actorRef(actorUser),
    text: String(text || '').replace(/\s+/g, ' ').trim().slice(0, 140),
  };

  for (const rid of recipientIds) {
    const target = rid === owner.id ? owner : await store.getUserById(rid);
    if (!target) continue;
    if (!Array.isArray(target.notifications)) target.notifications = [];
    // Collapse a burst of edits (autosave fires often) into a single alert:
    // if we already told this person about this kind of change to this map
    // recently, skip rather than pile on.
    if (dedupeMs) {
      const cutoff = Date.now() - dedupeMs;
      const seen = target.notifications.some(n =>
        n.kind === kind && n.mapId === m.id &&
        n.actor && n.actor.username === actorUser.username && n.ts >= cutoff);
      if (seen) continue;
    }
    deliverNotif(target, base);
    // The owner's record is saved by the caller (it also carries the map write);
    // every other recipient we persist right here.
    if (rid !== owner.id) await store.saveUser(target);
  }
}

// Announce a freshly created map to the creator's friends and followers — the
// people who chose to see their activity — but only those who may actually view
// it (private maps notify no one; friends-only maps skip non-friends).
async function notifyNewMap(creator, m) {
  const candidateIds = new Set([...(creator.friends || []), ...(creator.followers || [])]);
  candidateIds.delete(creator.id);
  if (!candidateIds.size) return;
  const targets = await store.getUsersByIds([...candidateIds]);
  const base = {
    kind: 'newmap',
    mapId: m.id,
    mapOwner: creator.username,
    mapName: m.name,
    actor: actorRef(creator),
    text: '',
  };
  for (const target of targets) {
    if (!canViewMapObj(m, creator, target)) continue; // respect the map's visibility
    deliverNotif(target, base);
    await store.saveUser(target);
  }
}


/* ================================================================
   Map validation
================================================================ */
// A node link may only be an http(s) URL — never javascript:, data:, etc.,
// since it becomes a clickable anchor in viewers' browsers.
function cleanLink(v) {
  const s = String(v || '').trim().slice(0, 300);
  if (!s) return '';
  return /^https?:\/\//i.test(s) ? s : '';
}

// A map-bubble reference: the id of another map. Only shape is validated here
// (same charset the map routes accept); whether it exists / is viewable is
// resolved at navigation time, not stored.
function cleanMapRef(v) {
  const s = String(v || '').trim();
  return /^[A-Za-z0-9]{1,40}$/.test(s) ? s : '';
}

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
      note: String(n.note || '').slice(0, 4000),
      link: cleanLink(n.link),
      done: !!n.done,
      pos: Array.isArray(n.pos) ? [num(n.pos[0]), num(n.pos[1]), num(n.pos[2])] : [0, 0, 0],
      r: Math.max(20, Math.min(400, num(n.r) || 62)),
      hue: Math.max(0, Math.min(11, Math.floor(num(n.hue)))),
      parentId: n.parentId ? String(n.parentId).slice(0, 24) : null,
      kind: n.kind === 'container' ? 'container' : 'bubble',
      // Position among its siblings in the outline. Null means "never ordered";
      // the client then falls back to its legacy ordering and numbers them on
      // the next save, so old maps keep the outline they had.
      order: (typeof n.order === 'number' && isFinite(n.order))
        ? Math.max(-100000, Math.min(100000, Math.round(n.order))) : null,
      // optional: this bubble links to another map (a "map bubble"). Stored as a
      // map id; empty/invalid → no link. Navigation resolves + access-checks it.
      mapRef: cleanMapRef(n.mapRef),
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
  // anchor: the node the view resets to; keep only if it points at a real node
  const anchor = input.anchorId ? String(input.anchorId).slice(0, 24) : null;
  out.anchorId = anchor && out.nodes[anchor] ? anchor : null;
  return out;
}

/* ================================================================
   AI map generation (optional — requires ANTHROPIC_API_KEY at runtime)
================================================================ */
const AI_MODEL = 'claude-opus-4-8';
const AI_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    groups: {
      type: 'array',
      description: 'Optional groupings that cluster related ideas.',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: { id: { type: 'string' }, label: { type: 'string' } },
        required: ['id', 'label'],
      },
    },
    nodes: {
      type: 'array',
      description: 'The idea bubbles. 12–30 is a good range.',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string' },
          label: { type: 'string', description: 'Short label, a few words.' },
          note: { type: 'string', description: 'Optional 1–2 sentence detail, or empty string.' },
          group: { type: 'string', description: 'id of the group this belongs to, or empty string.' },
        },
        required: ['id', 'label', 'note', 'group'],
      },
    },
    edges: {
      type: 'array',
      description: 'Connections between node ids. weight 1 (loose) to 10 (tight).',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          from: { type: 'string' },
          to: { type: 'string' },
          weight: { type: 'integer' },
        },
        required: ['from', 'to', 'weight'],
      },
    },
  },
  required: ['groups', 'nodes', 'edges'],
};

function aiConfigured() { return !!process.env.ANTHROPIC_API_KEY; }

// Compact view of an existing map handed to the model when expanding it: just
// group and node ids + labels, so it can reference existing nodes in new edges
// without us shipping positions/notes/etc. Capped to keep the prompt small.
function existingContext(existing) {
  const nodes = (existing && existing.nodes) || {};
  const groups = [], bubbles = [];
  for (const n of Object.values(nodes)) {
    if (!n) continue;
    if (n.kind === 'container') groups.push({ id: n.id, label: String(n.label || '') });
    else bubbles.push({ id: n.id, label: String(n.label || ''), group: n.parentId || '' });
  }
  return { groups: groups.slice(0, 60), nodes: bubbles.slice(0, 200) };
}

// Generate a map from a prompt. When `existing` (a {nodes, edges}) is passed we
// run in "add" mode: the model sees the current map and returns only additions,
// which are merged in beside it (existing content untouched). Otherwise it's a
// fresh map that replaces whatever was there.
async function generateMapFromPrompt(prompt, existing) {
  if (!process.env.ANTHROPIC_API_KEY) {
    const e = new Error('AI map generation isn’t configured on this server. Set ANTHROPIC_API_KEY to enable it.');
    e.status = 503; throw e;
  }
  let Anthropic;
  try { Anthropic = require('@anthropic-ai/sdk'); }
  catch { const e = new Error('AI map generation is unavailable (the Anthropic SDK is not installed).'); e.status = 503; throw e; }
  const client = new Anthropic(); // reads ANTHROPIC_API_KEY from the environment
  const adding = !!existing;
  const base =
    'You design clear, well-organized mind maps. Use short labels (a few words); put any ' +
    'extra detail in the optional note. Connect related ideas with weighted edges (heavier = ' +
    'more strongly related). For new items, use ids you define.';
  const system = adding
    ? base + ' You are EXPANDING an existing map based on the user’s request. Return ONLY new ' +
      'groups, nodes, and edges to ADD — never repeat or restate nodes that already exist. New ' +
      'edges may connect new nodes to each other, or connect a new node to an existing node by ' +
      'using that existing node’s id shown in the map. Add a focused, relevant set (roughly ' +
      '6–15 new nodes) unless the request clearly calls for more.'
    : base + ' Given a topic, break it into a central set of ideas, cluster closely related ones ' +
      'into a few named groups, and aim for 12–30 nodes.';
  const userContent = adding
    ? 'Here is the existing mind map (group and node ids are given so you can connect to them):\n' +
      JSON.stringify(existingContext(existing)) +
      '\n\nExpand it based on this request — return only the additions:\n\n' + prompt
    : 'Create a mind map for this topic:\n\n' + prompt;
  const response = await client.messages.create({
    model: AI_MODEL,
    max_tokens: 8000,
    thinking: { type: 'adaptive' },
    output_config: { effort: 'medium', format: { type: 'json_schema', schema: AI_SCHEMA } },
    system,
    messages: [{ role: 'user', content: userContent }],
  });
  if (response.stop_reason === 'refusal') {
    const e = new Error('The AI declined to generate a map for that prompt.'); e.status = 422; throw e;
  }
  const textBlock = (response.content || []).find(b => b.type === 'text');
  let data;
  try { data = JSON.parse(textBlock ? textBlock.text : '{}'); }
  catch { const e = new Error('The AI returned an unexpected response. Please try again.'); e.status = 502; throw e; }
  return adding ? mergeAIIntoMap(data, existing) : buildMapFromAI(data);
}

// Turn the model's {groups, nodes, edges} into a sanitized map (nodes+edges),
// remapping arbitrary ids to safe ones and laying nodes out radially.
function buildMapFromAI(data) {
  const groupsIn = Array.isArray(data.groups) ? data.groups.slice(0, 8) : [];
  const nodesIn = Array.isArray(data.nodes) ? data.nodes.slice(0, 40) : [];
  const edgesIn = Array.isArray(data.edges) ? data.edges.slice(0, 80) : [];
  const HUES_N = 6;
  const nodes = {};
  const idMap = new Map();     // AI id → new id (groups and nodes share the namespace)
  const groupNewId = new Map();
  let counter = 1;
  const mkId = () => 'n' + (counter++);

  groupsIn.forEach((g, i) => {
    if (!g || typeof g !== 'object') return;
    const id = mkId();
    const aiId = String(g.id != null ? g.id : 'g' + i);
    idMap.set(aiId, id); groupNewId.set(aiId, id);
    nodes[id] = { id, kind: 'container', label: String(g.label || 'Group'), note: '', link: '', done: false, r: 150, hue: i % HUES_N, parentId: null, pos: [0, 0, 0] };
  });
  nodesIn.forEach((nd, i) => {
    if (!nd || typeof nd !== 'object') return;
    const id = mkId();
    const aiId = String(nd.id != null ? nd.id : 'x' + i);
    idMap.set(aiId, id);
    const parentAi = nd.group ? String(nd.group) : '';
    const parentId = parentAi && groupNewId.has(parentAi) ? groupNewId.get(parentAi) : null;
    const hue = parentId ? nodes[parentId].hue : i % HUES_N;
    nodes[id] = { id, kind: 'bubble', label: String(nd.label || 'Idea'), note: String(nd.note || ''), link: '', done: false, r: 62, hue, parentId, pos: [0, 0, 0] };
  });

  layoutRadial(nodes, 0, 0);

  const edges = [];
  const seen = new Set();
  for (const e of edgesIn) {
    if (!e || typeof e !== 'object') continue;
    const a = idMap.get(String(e.from)), b = idMap.get(String(e.to));
    if (!a || !b || a === b) continue;
    const key = a < b ? a + '|' + b : b + '|' + a;
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push({ id: 'e' + edges.length, a, b, w: Math.max(1, Math.min(10, Math.round(Number(e.weight) || 3))) });
  }
  return sanitizeMap({ nodes, edges });
}

// Radial layout of a set of nodes around (cx, cy): top-level items on a big
// circle, each group's children around it. Mutates node.pos (and group r).
function layoutRadial(nodes, cx, cy) {
  const top = Object.values(nodes).filter(n => !n.parentId);
  const R = Math.max(320, top.length * 70);
  top.forEach((n, i) => {
    const a = (i / Math.max(1, top.length)) * Math.PI * 2;
    n.pos = [cx + Math.cos(a) * R, cy + Math.sin(a) * R, 0];
  });
  for (const g of Object.values(nodes)) {
    if (g.kind !== 'container') continue;
    const kids = Object.values(nodes).filter(n => n.parentId === g.id);
    const kr = Math.max(90, kids.length * 26);
    kids.forEach((k, i) => {
      const a = (i / Math.max(1, kids.length)) * Math.PI * 2;
      k.pos = [g.pos[0] + Math.cos(a) * kr, g.pos[1] + Math.sin(a) * kr, 0];
    });
    g.r = Math.max(150, kr + 80);
  }
}

// Merge the model's additions into an existing map. Existing nodes/edges are
// kept exactly as-is; new groups/nodes get fresh non-colliding ids and are laid
// out in empty space to the right of the current content. New edges may link
// new nodes together or to existing nodes (referenced by their real ids).
function mergeAIIntoMap(data, existing) {
  const out = { nodes: {}, edges: [] };
  for (const [id, n] of Object.entries((existing && existing.nodes) || {})) {
    out.nodes[id] = JSON.parse(JSON.stringify(n));
  }
  for (const e of (existing && existing.edges) || []) out.edges.push(JSON.parse(JSON.stringify(e)));

  const groupsIn = Array.isArray(data.groups) ? data.groups.slice(0, 8) : [];
  const nodesIn = Array.isArray(data.nodes) ? data.nodes.slice(0, 40) : [];
  const edgesIn = Array.isArray(data.edges) ? data.edges.slice(0, 80) : [];
  const HUES_N = 6;
  const idMap = new Map();       // AI temp id → fresh real id (new content only)
  const groupNewId = new Map();
  const added = {};              // just the new nodes, for isolated layout
  const freshId = () => { let id; do { id = newId(); } while (out.nodes[id] || added[id]); return id; };

  groupsIn.forEach((g, i) => {
    if (!g || typeof g !== 'object') return;
    const id = freshId();
    const aiId = String(g.id != null ? g.id : 'g' + i);
    idMap.set(aiId, id); groupNewId.set(aiId, id);
    added[id] = { id, kind: 'container', label: String(g.label || 'Group'), note: '', link: '', done: false, r: 150, hue: i % HUES_N, parentId: null, pos: [0, 0, 0], mapRef: '' };
  });
  nodesIn.forEach((nd, i) => {
    if (!nd || typeof nd !== 'object') return;
    const id = freshId();
    const aiId = String(nd.id != null ? nd.id : 'x' + i);
    idMap.set(aiId, id);
    const parentAi = nd.group ? String(nd.group) : '';
    const parentId = parentAi && groupNewId.has(parentAi) ? groupNewId.get(parentAi) : null;
    const hue = parentId ? added[parentId].hue : i % HUES_N;
    added[id] = { id, kind: 'bubble', label: String(nd.label || 'Idea'), note: String(nd.note || ''), link: '', done: false, r: 62, hue, parentId, pos: [0, 0, 0], mapRef: '' };
  });

  // place the new cluster clear of the existing content (to its right)
  const [ox, oy] = openSpotRightOf(out.nodes, added);
  layoutRadial(added, ox, oy);
  Object.assign(out.nodes, added);

  const seen = new Set();
  for (const e of out.edges) seen.add(e.a < e.b ? e.a + '|' + e.b : e.b + '|' + e.a);
  const ref = r => (idMap.has(r) ? idMap.get(r) : (out.nodes[r] ? r : null)); // new temp id or existing real id
  for (const e of edgesIn) {
    if (!e || typeof e !== 'object') continue;
    const a = ref(String(e.from)), b = ref(String(e.to));
    if (!a || !b || a === b) continue;
    const key = a < b ? a + '|' + b : b + '|' + a;
    if (seen.has(key)) continue;
    seen.add(key);
    out.edges.push({ id: newId(), a, b, w: Math.max(1, Math.min(10, Math.round(Number(e.weight) || 3))) });
  }
  return sanitizeMap(out);
}

// Pick an origin for the new cluster: centered vertically on the existing
// content and offset to its right, sized so the cluster clears it.
function openSpotRightOf(existingNodes, added) {
  const ex = Object.values(existingNodes);
  if (!ex.length) return [0, 0];
  let maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const n of ex) {
    maxX = Math.max(maxX, n.pos[0] + n.r);
    minY = Math.min(minY, n.pos[1] - n.r);
    maxY = Math.max(maxY, n.pos[1] + n.r);
  }
  const tops = Object.values(added).filter(n => !n.parentId).length;
  const R = Math.max(320, tops * 70);
  return [maxX + 220 + R, (minY + maxY) / 2];
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

/* ================================================================
   Admin auth — a single ADMIN_PASSWORD env var, no user account.
   The session is a stateless signed cookie: an issued-at timestamp plus
   an HMAC keyed by the admin password itself. Nothing is stored server-side,
   and rotating ADMIN_PASSWORD instantly invalidates every admin session.
================================================================ */
function adminConfigured() { return ADMIN_PASSWORD.length > 0; }

function signAdmin(ts) {
  return crypto.createHmac('sha256', ADMIN_PASSWORD).update('admin:' + ts).digest('hex');
}
function makeAdminToken() {
  const ts = Date.now();
  return ts + '.' + signAdmin(ts);
}
function verifyAdminToken(token) {
  if (!adminConfigured() || !token) return false;
  const dot = token.indexOf('.');
  if (dot < 0) return false;
  const ts = Number(token.slice(0, dot));
  if (!Number.isFinite(ts) || Date.now() - ts > ADMIN_TTL) return false;
  const got = Buffer.from(token.slice(dot + 1));
  const expected = Buffer.from(signAdmin(ts));
  return got.length === expected.length && crypto.timingSafeEqual(got, expected);
}
function isAdmin(req) {
  return verifyAdminToken(parseCookies(req).admin);
}
// Compare a submitted password to ADMIN_PASSWORD in constant time. Both sides
// are SHA-256'd first so timingSafeEqual always sees equal-length buffers and
// the comparison can't leak the password's length.
function checkAdminPassword(pw) {
  if (!adminConfigured()) return false;
  const a = crypto.createHash('sha256').update(String(pw)).digest();
  const b = crypto.createHash('sha256').update(ADMIN_PASSWORD).digest();
  return crypto.timingSafeEqual(a, b);
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
// Defense-in-depth headers applied to every response. The CSP is deliberately
// tight: everything the app loads is same-origin except a data:-URI favicon and
// inline style attributes, so we only open those two doors. frame-ancestors
// 'none' blocks clickjacking; nosniff blocks MIME-confusion attacks.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "object-src 'none'",
].join('; ');
function securityHeaders(res, req) {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  // only advertise HSTS once we're actually on HTTPS, so local http dev is unaffected
  if (isSecure(req)) res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
}

// Reject cross-site state-changing requests: a write whose Origin (or Referer
// host) isn't us is almost certainly a CSRF attempt. Belt-and-suspenders atop
// the SameSite=Lax session cookie. Same-origin and tool/no-Origin GETs pass.
const WRITE_METHODS = new Set(['POST', 'PUT', 'DELETE', 'PATCH']);
function isSameOrigin(req) {
  const host = req.headers.host;
  if (!host) return false;
  const origin = req.headers.origin;
  if (origin) {
    try { return new URL(origin).host === host; } catch { return false; }
  }
  // no Origin header (older browsers, some clients): fall back to Referer host
  const referer = req.headers.referer;
  if (referer) {
    try { return new URL(referer).host === host; } catch { return false; }
  }
  return false; // a state-changing request with neither header is not trusted
}

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
      following: [], followers: [],
      notifications: [], pushSubs: [],
      maps: [makeMap('My Map', body.visibility, displayName || username)],
      desk: makeDesk(),
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
    // Always run scrypt (against a decoy salt when the user is missing) and
    // compare in constant time, so response timing doesn't reveal whether a
    // username exists or where the hashes first differ.
    const salt = u ? u.salt : DECOY_SALT;
    const expected = u ? u.passHash : DECOY_HASH;
    const got = hashPassword(password, salt);
    const ok = !!u && crypto.timingSafeEqual(Buffer.from(got, 'hex'), Buffer.from(expected, 'hex'));
    if (!ok) {
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

  // Resolve the signed-in user if there is one. A handful of read-only routes
  // below work for anonymous visitors too (user === null); everything else
  // requires sign-in, enforced right after the public routes.
  const user = await authUser(req);

  // --- public, read-only browsing (no sign-in required) ---
  // Browse/search users. Anonymous visitors see only users with public maps.
  if (req.method === 'GET' && pathname === '/api/users') {
    const q = String(new URL(req.url, 'http://x').searchParams.get('q') || '').trim();
    const needle = q.toLowerCase();
    const users = await store.searchUsers(q);
    const filtered = users.filter(u =>
      !needle || u.username.includes(needle) || nameFor(u, user));
    // hide accounts a visitor has nothing to see from (no maps they may view)
    const shown = user ? filtered : filtered.filter(u => visibleMapsOf(u, null).length);
    return sendJSON(res, 200, { users: shown.map(u => publicUser(u, user)) });
  }

  // View a profile. Anonymous visitors see only that user's public maps.
  const pubProfileMatch = pathname.match(/^\/api\/users\/([a-z0-9_]{3,20})$/);
  if (req.method === 'GET' && pubProfileMatch) {
    const target = await store.getUserByUsername(pubProfileMatch[1]);
    if (!target) return sendJSON(res, 404, { error: 'No such user.' });
    return sendJSON(res, 200, {
      user: publicUser(target, user),
      maps: visibleMapsOf(target, user).map(m => mapMeta(m)),
    });
  }

  // View a single map by id (read-only). canViewMapObj already limits an
  // anonymous viewer to public maps; the sub-routes below (chat, live, PUT…)
  // still require sign-in.
  const pubMapMatch = pathname.match(/^\/api\/maps\/([A-Za-z0-9]{1,40})$/);
  if (req.method === 'GET' && pubMapMatch) {
    const mapId = pubMapMatch[1];
    const owner = user && user.maps.some(m => m.id === mapId) ? user : await store.getUserByMapId(mapId);
    const m = owner && owner.maps.find(x => x.id === mapId);
    if (!m || !canViewMapObj(m, owner, user)) return sendJSON(res, 404, { error: 'No such map.' });
    const isOwner = !!user && owner.id === user.id;
    const canEdit = isOwner || (!!user && (m.editors || []).includes(user.id));
    return sendJSON(res, 200, {
      map: { id: m.id, name: m.name, visibility: m.visibility, nodes: m.nodes, edges: m.edges, anchorId: m.anchorId || null },
      owner: ownerRef(owner, user), isOwner, canEdit,
      likeCount: (m.likes || []).length,
      likedByMe: !!user && (m.likes || []).includes(user.id),
      commentCount: (m.comments || []).length,
      present: presenceList(m.id),
    });
  }

  // Read comments on a viewable map — allowed for anyone who can see the map,
  // signed-out guests included. Posting and deleting still require sign-in and
  // are handled in the authenticated comment routes below.
  const pubCommentMatch = req.method === 'GET' && pathname.match(/^\/api\/maps\/([A-Za-z0-9]{1,40})\/comments$/);
  if (pubCommentMatch) {
    const mapId = pubCommentMatch[1];
    const owner = user && user.maps.some(m => m.id === mapId) ? user : await store.getUserByMapId(mapId);
    const m = owner && owner.maps.find(x => x.id === mapId);
    if (!m || !canViewMapObj(m, owner, user)) return sendJSON(res, 404, { error: 'No such map.' });
    return sendJSON(res, 200, {
      comments: (m.comments || []).map(c => commentOut(c, user)),
      canPost: !!user, // guests can read but not post
      canModerate: !!user && owner.id === user.id,
    });
  }


  // --- admin console (separate auth: ADMIN_PASSWORD env var, not a user account) ---
  if (pathname === '/api/admin/login' && req.method === 'POST') {
    const ip = clientIp(req);
    if (tooMany('admin:' + ip, 10, 15 * 60 * 1000)) {
      return sendJSON(res, 429, { error: 'Too many attempts. Try again in a few minutes.' });
    }
    if (!adminConfigured()) {
      return sendJSON(res, 503, { error: 'Admin access is not configured on this server. Set the ADMIN_PASSWORD environment variable to enable it.' });
    }
    const body = await readBody(req);
    if (!checkAdminPassword(body.password)) {
      return sendJSON(res, 401, { error: 'Wrong admin password.' });
    }
    attempts.delete('admin:' + ip);
    res.setHeader('Set-Cookie',
      `admin=${makeAdminToken()}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${ADMIN_TTL / 1000}` +
      (isSecure(req) ? '; Secure' : ''));
    return sendJSON(res, 200, { ok: true });
  }

  if (pathname === '/api/admin/logout' && req.method === 'POST') {
    res.setHeader('Set-Cookie', 'admin=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0' + (isSecure(req) ? '; Secure' : ''));
    return sendJSON(res, 200, { ok: true });
  }

  if (pathname === '/api/admin/session' && req.method === 'GET') {
    return sendJSON(res, 200, { authed: isAdmin(req), configured: adminConfigured() });
  }

  // Every other /api/admin/ route requires a valid admin cookie.
  if (pathname.startsWith('/api/admin/')) {
    if (!isAdmin(req)) return sendJSON(res, 401, { error: 'Admin sign-in required.' });

    if (pathname === '/api/admin/stats' && req.method === 'GET') {
      const users = await store.allUsers();
      const now = Date.now();
      const dayAgo = now - 24 * 60 * 60 * 1000;
      const weekAgo = now - 7 * 24 * 60 * 60 * 1000;
      let totalMaps = 0, totalNodes = 0, newToday = 0, newWeek = 0;
      const list = users.map(u => {
        const maps = u.maps || [];
        const nodes = maps.reduce((s, m) => s + Object.keys(m.nodes || {}).length, 0);
        totalMaps += maps.length;
        totalNodes += nodes;
        if (u.createdAt >= dayAgo) newToday++;
        if (u.createdAt >= weekAgo) newWeek++;
        return {
          id: u.id,
          username: u.username,
          displayName: u.displayName || '',
          visibility: u.visibility,
          createdAt: u.createdAt,
          mapCount: maps.length,
          nodeCount: nodes,
          friendCount: (u.friends || []).length,
          followerCount: (u.followers || []).length,
        };
      });
      return sendJSON(res, 200, {
        storage: store.kind,
        aiEnabled: aiConfigured(),
        totals: { users: users.length, maps: totalMaps, nodes: totalNodes, newToday, newWeek },
        users: list,
      });
    }

    const delMatch = pathname.match(/^\/api\/admin\/users\/([a-f0-9]{1,40})$/);
    if (delMatch && req.method === 'DELETE') {
      const target = await store.getUserById(delMatch[1]);
      if (!target) return sendJSON(res, 404, { error: 'No such user.' });
      await store.deleteUser(target.id);
      return sendJSON(res, 200, { ok: true });
    }

    return sendJSON(res, 404, { error: 'Not found.' });
  }

  // --- everything below requires sign-in ---
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

  // Export everything we hold for this account as a downloadable JSON file.
  // Resolves ids to usernames where useful so the export is human-readable, and
  // never includes the password hash/salt.
  if (route === 'GET /api/me/export') {
    const refIds = [...new Set([
      ...(user.friends || []), ...(user.requestsIn || []), ...(user.requestsOut || []),
      ...(user.following || []), ...(user.followers || []),
      ...user.maps.flatMap(m => m.editors || []),
    ])];
    const refUsers = await store.getUsersByIds(refIds);
    const uname = id => { const u = refUsers.find(x => x.id === id); return u ? u.username : null; };
    const unames = ids => (ids || []).map(uname).filter(Boolean);
    const data = {
      exportedAt: new Date().toISOString(),
      account: {
        username: user.username,
        displayName: user.displayName || '',
        showDisplayName: !!user.showDisplayName,
        defaultVisibility: user.visibility,
        bio: user.bio || '',
        createdAt: new Date(user.createdAt).toISOString(),
      },
      social: {
        friends: unames(user.friends),
        followRequestsIncoming: unames(user.requestsIn),
        followRequestsOutgoing: unames(user.requestsOut),
        following: unames(user.following),
        followers: unames(user.followers),
      },
      desk: {
        reference: user.desk.ref,
        items: user.desk.items.map(i => ({
          title: i.title, tag: i.tag, next: i.next, who: i.who,
          court: i.court === 'me' ? 'on me' : 'waiting on them',
          movedAt: new Date(i.moved).toISOString(),
        })),
        scratch: user.desk.scratch,
        closedAllTime: user.desk.closed,
      },
      maps: user.maps.map(m => ({
        id: m.id, name: m.name, visibility: m.visibility,
        editors: unames(m.editors),
        createdAt: m.createdAt ? new Date(m.createdAt).toISOString() : null,
        updatedAt: m.updatedAt ? new Date(m.updatedAt).toISOString() : null,
        nodes: m.nodes, edges: m.edges, anchorId: m.anchorId || null,
        chat: m.chat || [],
      })),
    };
    const body = JSON.stringify(data, null, 2);
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="mindmapshare-${user.username}.json"`,
      'Content-Length': Buffer.byteLength(body),
    });
    return res.end(body);
  }

  // Permanently delete this account. Requires the current password (re-typed),
  // compared in constant time, then scrubs every reference to the user and ends
  // the session.
  if (route === 'DELETE /api/me') {
    const body = await readBody(req);
    const password = String(body.password || '');
    const got = hashPassword(password, user.salt);
    const ok = crypto.timingSafeEqual(Buffer.from(got, 'hex'), Buffer.from(user.passHash, 'hex'));
    if (!ok) return sendJSON(res, 403, { error: 'Password is incorrect.' });
    await store.deleteUser(user.id);
    res.setHeader('Set-Cookie', 'sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0' + (isSecure(req) ? '; Secure' : ''));
    return sendJSON(res, 200, { ok: true });
  }

  // --- notifications (bell feed) ---
  if (route === 'GET /api/notifications') {
    const list = (user.notifications || []).slice().sort((a, b) => b.ts - a.ts).map(notifOut);
    return sendJSON(res, 200, { notifications: list, unread: unreadCount(user) });
  }
  // Live per-user stream that pushes each new notification as it arrives.
  if (route === 'GET /api/notifications/stream') {
    return startNotifyStream(req, res, user.id);
  }
  // Mark notifications read: {ids:[...]} for specific ones, or omit to mark all.
  if (route === 'POST /api/notifications/read') {
    const body = await readBody(req);
    const ids = Array.isArray(body.ids) ? new Set(body.ids) : null;
    for (const n of user.notifications || []) {
      if (!ids || ids.has(n.id)) n.read = true;
    }
    await store.saveUser(user);
    return sendJSON(res, 200, { unread: unreadCount(user) });
  }
  // Clear the whole feed.
  if (route === 'DELETE /api/notifications') {
    user.notifications = [];
    await store.saveUser(user);
    return sendJSON(res, 200, { ok: true });
  }

  // --- Web Push subscription management ---
  // Public VAPID key the browser needs to subscribe; `enabled` is false when the
  // server has no VAPID keys configured (the in-app bell still works either way).
  if (route === 'GET /api/push/vapid') {
    return sendJSON(res, 200, {
      enabled: pushConfigured(),
      key: pushConfigured() ? process.env.VAPID_PUBLIC_KEY : null,
    });
  }
  if (route === 'POST /api/push/subscribe') {
    const body = await readBody(req);
    const sub = body && body.subscription;
    if (!sub || typeof sub.endpoint !== 'string' || !sub.keys) {
      return sendJSON(res, 400, { error: 'Invalid subscription.' });
    }
    if (!Array.isArray(user.pushSubs)) user.pushSubs = [];
    // de-dupe by endpoint; refresh the record if the same browser re-subscribes
    user.pushSubs = user.pushSubs.filter(s => s.endpoint !== sub.endpoint);
    user.pushSubs.push({ endpoint: sub.endpoint, keys: sub.keys, ts: Date.now() });
    if (user.pushSubs.length > MAX_PUSH_SUBS) {
      user.pushSubs.splice(0, user.pushSubs.length - MAX_PUSH_SUBS);
    }
    await store.saveUser(user);
    return sendJSON(res, 200, { ok: true });
  }
  if (route === 'POST /api/push/unsubscribe') {
    const body = await readBody(req);
    const endpoint = body && body.endpoint;
    if (Array.isArray(user.pushSubs) && endpoint) {
      user.pushSubs = user.pushSubs.filter(s => s.endpoint !== endpoint);
      await store.saveUser(user);
    }
    return sendJSON(res, 200, { ok: true });
  }

  // --- the Standing Desk (one private work board per account) ---
  // The board is never shared: no visibility tier, no editors, not on profiles.
  // Reads and writes are always the signed-in user's own row.
  if (route === 'GET /api/desk') {
    return sendJSON(res, 200, {
      desk: user.desk,
      cap: DESK_COURT_CAP,
      maxItems: MAX_DESK_ITEMS,
      maxRef: MAX_DESK_REF,
      staleDays: DESK_STALE_DAYS,
    });
  }

  // Whole-board replace, like the map PUT — the client owns the state and
  // autosaves it. A body without a desk object is rejected rather than treated
  // as an empty board, so a malformed request can never wipe someone's desk.
  if (route === 'PUT /api/desk') {
    const body = await readBody(req);
    if (!body || typeof body.desk !== 'object' || body.desk === null) {
      return sendJSON(res, 400, { error: 'Invalid desk.' });
    }
    const desk = sanitizeDesk(body.desk);
    desk.updatedAt = Date.now();
    user.desk = desk;
    await store.saveUser(user);
    return sendJSON(res, 200, { ok: true, updatedAt: desk.updatedAt });
  }

  // --- maps ---
  if (route === 'GET /api/maps') {
    const editorIds = new Set();
    for (const m of user.maps) for (const id of m.editors) editorIds.add(id);
    const editorUsers = await store.getUsersByIds([...editorIds]);
    const byId = new Map(editorUsers.map(x => [x.id, x]));
    const mine = user.maps.map(m => mapMeta(m, {
      editors: m.editors.map(id => byId.get(id)).filter(Boolean).map(e => ownerRef(e, user)),
    }));
    const owners = await store.getUsersWithEditor(user.id);
    const shared = [];
    for (const owner of owners) {
      if (owner.id === user.id) continue;
      for (const m of owner.maps) {
        if ((m.editors || []).includes(user.id)) shared.push(mapMeta(m, { owner: ownerRef(owner, user) }));
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
    await notifyNewMap(user, m); // tell friends/followers who can see it
    return sendJSON(res, 200, { map: mapMeta(m, { editors: [] }) });
  }

  // Reorder my maps: body { order: [id, id, …] }. Sorts user.maps to match.
  if (route === 'POST /api/maps/reorder') {
    const body = await readBody(req);
    const order = Array.isArray(body.order) ? body.order.map(String) : null;
    if (!order) return sendJSON(res, 400, { error: 'Invalid order.' });
    const rank = new Map(order.map((id, i) => [id, i]));
    // stable sort: ids named in `order` come first in that order; any not
    // listed keep their existing relative position at the end.
    user.maps = user.maps
      .map((m, i) => ({ m, i }))
      .sort((a, b) => {
        const ra = rank.has(a.m.id) ? rank.get(a.m.id) : order.length + a.i;
        const rb = rank.has(b.m.id) ? rank.get(b.m.id) : order.length + b.i;
        return ra - rb;
      })
      .map(x => x.m);
    await store.saveUser(user);
    return sendJSON(res, 200, { ok: true });
  }

  const mapMatch = pathname.match(/^\/api\/maps\/([A-Za-z0-9]{1,40})(?:\/(meta|editors|chat|live|like|generate|duplicate|clone))?$/);
  if (mapMatch) {
    const mapId = mapMatch[1], sub = mapMatch[2];
    const owner = user.maps.some(m => m.id === mapId) ? user : await store.getUserByMapId(mapId);
    const m = owner && owner.maps.find(x => x.id === mapId);
    // a map the viewer may not see behaves exactly like a map that doesn't exist
    if (!m || !canViewMapObj(m, owner, user)) return sendJSON(res, 404, { error: 'No such map.' });
    const isOwner = owner.id === user.id;
    const canEdit = isOwner || (m.editors || []).includes(user.id);

    // GET of a bare map is handled by the public route above (anonymous-friendly)
    if (!sub && req.method === 'PUT') {
      if (!canEdit) return sendJSON(res, 403, { error: 'You do not have edit permission for this map.' });
      const body = await readBody(req);
      const clean = sanitizeMap(body.map);
      if (!clean) return sendJSON(res, 400, { error: 'Invalid map.' });
      const before = { nodes: m.nodes, edges: m.edges };
      const activity = diffMaps(before, clean, actorRef(user));
      m.nodes = clean.nodes;
      m.edges = clean.edges;
      m.anchorId = clean.anchorId;
      m.updatedAt = Date.now();
      for (const entry of activity) pushChat(m, entry);
      // Alert co-collaborators (owner + editors) that a shared map changed. The
      // actor is excluded, so a solo owner editing their own map notifies no one.
      // Autosave fires often, so collapse a burst into one alert per 15 min.
      if (activity.length) {
        const summary = activity.length === 1 ? activity[0].text : `made ${activity.length} changes`;
        await notifyMapEvent(owner, m, user, 'edit', summary,
          { includeCommenters: false, dedupeMs: 15 * 60 * 1000 });
      }
      await store.saveUser(owner);
      // live push: others viewing this map get the new state + the activity lines
      broadcast(m.id, 'map', { nodes: m.nodes, edges: m.edges, anchorId: m.anchorId, by: user.username }, res);
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
      const entry = { kind: 'message', actor: actorRef(user), text, ts: Date.now(), id: newId() };
      pushChat(m, entry);
      await notifyMapEvent(owner, m, user, 'chat', text); // bell + push to owner/editors/commenters
      await store.saveUser(owner);
      broadcast(m.id, 'chat', entry);
      return sendJSON(res, 200, { entry });
    }
    if (sub === 'live' && req.method === 'GET') {
      return startLiveStream(req, res, m.id, Object.assign(actorRef(user), { canEdit }));
    }
    // AI: generate a mind map from a text prompt. Returns nodes+edges for the
    // client to load into this map (it then saves + broadcasts as a normal edit).
    if (sub === 'generate' && req.method === 'POST') {
      if (!canEdit) return sendJSON(res, 403, { error: 'You do not have edit permission for this map.' });
      if (tooMany('gen:' + user.id, 30, 60 * 60 * 1000)) {
        return sendJSON(res, 429, { error: 'Too many generations this hour. Try again later.' });
      }
      const body = await readBody(req);
      const prompt = String(body.prompt || '').trim().slice(0, 600);
      if (prompt.length < 3) return sendJSON(res, 400, { error: 'Describe the map you want in a few words.' });
      // 'add' expands the current map (existing content kept); anything else
      // generates a fresh map that replaces it.
      const existing = body.mode === 'add' ? { nodes: m.nodes, edges: m.edges } : null;
      try {
        const result = await generateMapFromPrompt(prompt, existing);
        return sendJSON(res, 200, { map: { nodes: result.nodes, edges: result.edges } });
      } catch (err) {
        return sendJSON(res, err && err.status ? err.status : 500, { error: (err && err.message) || 'Generation failed.' });
      }
    }
    // Like / unlike a map. Anyone who can view it can like it (canViewMapObj
    // was already enforced above). Toggles the viewer's id in m.likes.
    if (sub === 'like' && req.method === 'POST') {
      if (!Array.isArray(m.likes)) m.likes = [];
      const i = m.likes.indexOf(user.id);
      const liked = i < 0;
      if (liked) m.likes.push(user.id); else m.likes.splice(i, 1);
      await store.saveUser(owner);
      return sendJSON(res, 200, { likeCount: m.likes.length, likedByMe: liked });
    }
    // Duplicate a map I own. The copy is a private clone of the content only:
    // fresh id, no shared editors, no chat/likes, inserted right after the
    // original. Visibility is carried over so it looks like the source.
    if (sub === 'duplicate' && req.method === 'POST') {
      if (!isOwner) return sendJSON(res, 403, { error: 'Only the owner can duplicate a map.' });
      if (user.maps.length >= MAX_MAPS) return sendJSON(res, 400, { error: `You can have up to ${MAX_MAPS} maps.` });
      const now = Date.now();
      const copy = {
        id: newId(),
        name: (m.name + ' (copy)').slice(0, 60),
        visibility: m.visibility,
        editors: [],
        nodes: JSON.parse(JSON.stringify(m.nodes || {})),
        edges: JSON.parse(JSON.stringify(m.edges || [])),
        anchorId: m.anchorId,
        chat: [],
        comments: [],
        likes: [],
        createdAt: now,
        updatedAt: now,
      };
      const idx = user.maps.findIndex(x => x.id === mapId);
      user.maps.splice(idx + 1, 0, copy);
      await store.saveUser(user);
      return sendJSON(res, 200, { map: mapMeta(copy, { editors: [] }) });
    }
    // Clone a map ANYONE can view into the caller's own "my maps". Unlike
    // duplicate (owner-only, sits beside the original), this copies the content
    // into the viewer's account as a fresh, private, independent map — a "save a
    // copy". canViewMapObj was already enforced above. The copy always lands on
    // the caller (user), never the owner.
    if (sub === 'clone' && req.method === 'POST') {
      if (user.maps.length >= MAX_MAPS) return sendJSON(res, 400, { error: `You can have up to ${MAX_MAPS} maps.` });
      const now = Date.now();
      const copy = {
        id: newId(),
        name: (m.name + (isOwner ? ' (copy)' : ' — from @' + owner.username)).slice(0, 60),
        visibility: 'private', // a saved copy starts private; the cloner can reshare
        editors: [],
        nodes: JSON.parse(JSON.stringify(m.nodes || {})),
        edges: JSON.parse(JSON.stringify(m.edges || [])),
        anchorId: m.anchorId,
        chat: [],
        comments: [],
        likes: [],
        createdAt: now,
        updatedAt: now,
      };
      user.maps.push(copy);
      await store.saveUser(user);
      return sendJSON(res, 200, { map: mapMeta(copy, { editors: [] }) });
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
      return sendJSON(res, 200, { editors: eds.map(e => ownerRef(e, user)) });
    }
    return sendJSON(res, 404, { error: 'Not found.' });
  }

  // --- comments: a public comment section on a map. Unlike the editor-only
  //     chat/activity feed above, ANY signed-in viewer who can see the map may
  //     read and post here — including the owner viewing their own map. Authors
  //     can delete their own comments; the map owner can moderate any of them. ---
  const commentMatch = pathname.match(/^\/api\/maps\/([A-Za-z0-9]{1,40})\/comments(?:\/([a-f0-9]{1,40}))?$/);
  if (commentMatch) {
    const mapId = commentMatch[1], commentId = commentMatch[2];
    const owner = user.maps.some(m => m.id === mapId) ? user : await store.getUserByMapId(mapId);
    const m = owner && owner.maps.find(x => x.id === mapId);
    if (!m || !canViewMapObj(m, owner, user)) return sendJSON(res, 404, { error: 'No such map.' });
    if (!Array.isArray(m.comments)) m.comments = [];
    const isOwner = owner.id === user.id;

    // (Reading comments is handled by the public GET route above, which also
    //  serves signed-out guests.)
    if (!commentId && req.method === 'POST') {
      const body = await readBody(req);
      const text = String(body.text || '').trim().slice(0, 1000);
      if (!text) return sendJSON(res, 400, { error: 'Say something first.' });
      // roll the oldest off once we hit the cap
      if (m.comments.length >= MAX_COMMENTS) m.comments.splice(0, m.comments.length - MAX_COMMENTS + 1);
      const entry = { id: newId(), authorId: user.id, actor: actorRef(user), text, ts: Date.now() };
      m.comments.push(entry);
      await notifyMapEvent(owner, m, user, 'comment', text); // bell + push to owner/editors/commenters
      await store.saveUser(owner);
      broadcast(mapId, 'comment', commentOut(entry, null)); // live to any open viewers
      return sendJSON(res, 200, { entry: commentOut(entry, user) });
    }
    if (commentId && req.method === 'DELETE') {
      const i = m.comments.findIndex(c => c.id === commentId);
      if (i < 0) return sendJSON(res, 404, { error: 'No such comment.' });
      if (!isOwner && m.comments[i].authorId !== user.id) {
        return sendJSON(res, 403, { error: 'You can only delete your own comments.' });
      }
      m.comments.splice(i, 1);
      await store.saveUser(owner);
      broadcast(mapId, 'comment-del', { id: commentId });
      return sendJSON(res, 200, { ok: true });
    }
    return sendJSON(res, 404, { error: 'Not found.' });
  }


  // (GET /api/users and GET /api/users/:username are served by the public
  //  read-only routes above, which also handle the signed-in case.)

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

  // --- follow (asymmetric) ---
  if (route === 'POST /api/follow') {
    const body = await readBody(req);
    const target = await store.getUserByUsername(body.username);
    if (!target || target.id === user.id) return sendJSON(res, 400, { error: 'Invalid user.' });
    const rm = (arr, id) => { const i = arr.indexOf(id); if (i >= 0) arr.splice(i, 1); };
    const following = body.action !== 'unfollow';
    if (following) {
      if (!user.following.includes(target.id)) user.following.push(target.id);
      if (!target.followers.includes(user.id)) target.followers.push(user.id);
    } else {
      rm(user.following, target.id);
      rm(target.followers, user.id);
    }
    await store.saveUser(user);
    await store.saveUser(target);
    return sendJSON(res, 200, { ok: true, following, followerCount: target.followers.length });
  }

  // --- home feed: recent maps from people you follow (and your friends),
  //     newest activity first, with like state for the current viewer ---
  // Viewable maps from everyone the signed-in user follows — used by the editor's
  // "insert a map as a bubble" picker so you can link to maps you follow.
  if (route === 'GET /api/following/maps') {
    const authors = await store.getUsersByIds(user.following || []);
    const maps = [];
    for (const author of authors) {
      for (const m of visibleMapsOf(author, user)) {
        maps.push({ id: m.id, name: m.name, owner: ownerRef(author, user) });
      }
    }
    return sendJSON(res, 200, { maps });
  }

  if (route === 'GET /api/feed') {
    const sourceIds = new Set([...(user.following || []), ...(user.friends || [])]);
    const authors = await store.getUsersByIds([...sourceIds]);
    const items = [];
    for (const author of authors) {
      for (const m of visibleMapsOf(author, user)) {
        if (!(m.updatedAt || m.createdAt)) continue;
        items.push(mapMetaFor(m, user, {
          owner: ownerRef(author, user),
          updatedAt: m.updatedAt || m.createdAt || 0,
        }));
      }
    }
    items.sort((a, b) => b.updatedAt - a.updatedAt);
    const following = (user.following || []).length;
    // when the feed is thin, surface recent public maps to discover + follow
    let discover = [];
    if (items.length < 8) {
      const everyone = await store.searchUsers('');
      const seen = new Set([user.id, ...sourceIds]);
      const pool = [];
      for (const other of everyone) {
        if (seen.has(other.id)) continue;
        for (const m of other.maps) {
          if (m.visibility === 'public' && Object.keys(m.nodes || {}).length) {
            pool.push(mapMetaFor(m, user, {
              owner: ownerRef(other, user),
              updatedAt: m.updatedAt || m.createdAt || 0,
            }));
          }
        }
      }
      pool.sort((a, b) => b.updatedAt - a.updatedAt);
      discover = pool.slice(0, 12);
    }
    return sendJSON(res, 200, { items: items.slice(0, 60), discover, following });
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
  if (rel === '/admin') rel = '/admin.html'; // friendly URL for the admin console
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
  securityHeaders(res, req);
  try {
    if (pathname.startsWith('/api/')) {
      // CSRF guard: cross-site writes are rejected before any handler runs
      if (WRITE_METHODS.has(req.method) && !isSameOrigin(req)) {
        return sendJSON(res, 403, { error: 'Cross-site request blocked.' });
      }
      await handleApi(req, res, pathname);
    } else serveStatic(req, res, pathname);
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
