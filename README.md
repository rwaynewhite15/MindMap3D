# MindMapShare

**MindMapShare** ([MindMapShare.com](https://MindMapShare.com)) is a social 3D
mind-mapping app. Every idea is a shaded 3D sphere floating in space; you connect
spheres with weighted links, nest them inside larger translucent "group" spheres, keep
as many separate maps as you like, and decide for each one whether the whole world can
see it or only your friends. Maps can be shared for real-time co-editing, with a
built-in chat and an automatic, timestamped log of who changed what.

It runs as a single small Node server with a no-build web front end. There are **no
runtime dependencies** for local use — your data lives in a JSON file — and it upgrades
to Postgres for production simply by setting one environment variable.

## Run it locally

Requires [Node.js](https://nodejs.org) 20+.

- **Easiest (Windows):** double-click `start.bat` — it starts the server and opens the app.
- Or from a terminal: `node server.js`, then open <http://localhost:3000>.

With no configuration the server stores everything in `data/data.json` — perfect for
home/LAN use, zero dependencies required. To run locally against a real Postgres
database instead, copy `.env.example` to `.env`, paste your connection string, and
run `npm install` once.

### Use it on your phone

Start the server on your PC, then on a phone connected to the **same Wi-Fi**, open the
`http://192.168.x.x:3000` address the server prints at startup. (If it doesn't load,
allow Node.js through Windows Firewall on private networks.)

## What you can do

### Accounts, profiles & friends
- Sign up with a username and password, add an optional display name, and choose
  whether other people see it.
- **Browse** and search everyone on the app; open anyone's profile to view their maps.
- Send, accept, and decline **friend requests**. Friendship is what unlocks
  friends-only maps and is required before you can grant someone edit access.

### Multiple maps per account
- Keep several independent maps (e.g. "Work", "Novel ideas", "Trip planning"). Switch
  between them from the dropdown on the map screen; create one with **+ New**.
- Each map has its **own name and its own privacy setting** — this is per-map, not a
  single account-wide toggle. The Settings screen only sets the *default* privacy used
  when you make a new map.
- Rename or delete a map (you always keep at least one) from **Map ▾**.

### Privacy — friends-only maps are truly hidden
- A map set to **Friends only** is invisible to anyone who isn't your friend: it is not
  listed on your profile, not counted in your bubble/map totals in Browse, and cannot be
  opened by URL — to a stranger it's as if the map doesn't exist.
- A **Public** map is viewable (read-only) by everyone on the app.
- Being able to *view* a map never implies being able to *edit* it — see below.

### Building a map
- **3D sphere bubbles** — tap a bubble to select it, tap again to rename, drag to move.
- **Weighted connections** — any bubble can link to none, one, or many others. Select a
  bubble, tap **+ Connection**, then tap the other bubble. New links start at weight 1
  (a thin line); tap any line (or its numbered dot) to open a slider and make it thicker
  (1–10 — the weight *is* the line thickness) or remove it.
- **Container / group bubbles** — **+ Group** creates a big translucent sphere. Add
  bubbles inside it (select the group, then **+ Bubble**), or move existing bubbles in
  and out with **Group ▾**. Bubbles inside a group can still link to bubbles outside it.
- **Overlap picker** — hovering highlights exactly what a click will select. When several
  things stack up under the cursor — a bubble inside a group with a line crossing behind
  it — hover for a second and a dropdown lists everything there so you can pick the one
  you meant. On mobile, one tap selects the top element; double-tap for the same dropdown.
- **Touch friendly** — one finger orbits, pinch zooms, drag moves bubbles; on desktop use
  the mouse wheel, and the Enter / Delete / F2 / Esc shortcuts.

### Sharing & real-time collaboration
- **Grant edit access** to friends from **Map ▾ → "Who can edit this map?"**. Maps
  shared with you appear in your own map dropdown under **Shared with me**, labelled with
  the owner's username.
- **Only the owner** can rename a map, change its privacy, manage editors, or delete it.
  Editors can change the map's contents but not its settings — all enforced on the server.
- **Live updates** — when two people have the same map open, edits appear on everyone
  else's screen within a moment, without disturbing their camera angle, zoom, or the
  bubble they're dragging. A small "**\_\_\_ others here**" indicator shows who else is
  currently viewing the map.
- **Chat & activity log** (the 💬 panel) — collaborators can chat, and every change is
  recorded as an attributed, timestamped line, e.g.
  *Bob added bubble "Sun" · Sun 7/19/26 @ 6:00am*. It also logs renames, deletions,
  moves in/out of groups, new/removed connections, and strength changes. The whole
  history is saved with the map and survives reloads and restarts; an unread badge
  appears on the chat button when new activity arrives while the panel is closed.

  > Concurrency is **last-write-wins** — great for people working on different parts of a
  > map at once; two people editing the *same* bubble in the same instant can overwrite
  > each other. There is no operational-transform merging.

## Deploy to the internet (Render + Neon)

The server automatically uses **Postgres** when a `DATABASE_URL` environment variable is
present, so production deployment is configuration, not code:

1. **Neon** (<https://neon.tech>): create a project, copy the connection string.
2. **GitHub**: push this repo.
3. **Render** (<https://render.com>): New → Web Service → connect the repo.
   - Build command: `npm install`
   - Start command: `node server.js`
   - Environment variable: `DATABASE_URL` = your Neon connection string
4. **Custom domain** (e.g. `MindMapShare.com`): in the Render service → Settings → Custom
   Domains, add your domain and set the DNS records Render shows you. HTTPS certificates
   are automatic.

Tables are created — and existing data is migrated — automatically on first boot (see
below). Sessions get the `Secure` cookie flag behind HTTPS, and login/registration are
rate-limited per IP.

### Live collaboration behind a proxy

Real-time updates use **Server-Sent Events** (one long-lived HTTP connection per open
map). This needs no extra service, but a reverse proxy must not buffer or prematurely
close the stream — the server already sends the `X-Accel-Buffering: no` header and a
25-second heartbeat to keep connections healthy through common proxies (nginx, Render).

### Schema migrations are automatic and safe

On boot the Postgres backend adds any missing columns with
`ADD COLUMN IF NOT EXISTS` and runs a **one-time, idempotent** migration that wraps each
legacy single-map account into the new multi-map shape. It only *reads* the old `map`
column to build the first entry of the new `maps` array — it never drops or overwrites
existing bubbles, and re-running it is a no-op. Chat/activity history rides along inside
the map JSON, so no schema change is required for it. Existing maps become a map named
"My Map" that keeps the account's previous visibility setting.

## Files

| Path | What it is |
|---|---|
| `server.js` | Node server: accounts, sessions, friends, multi-map storage, live SSE + chat, static files |
| `public/` | The web app (HTML/CSS/JS, no build step) |
| `data/data.json` | Local-mode user data (created on first run; not used with `DATABASE_URL`) |
| `.env.example` | Template for running locally against Postgres |
| `start.bat` | Windows launcher: starts the server and opens the app |
| `legacy-index.html` | The original single-user prototype, kept for reference |

Passwords are stored salted and hashed (scrypt). Sessions are HttpOnly cookies.
