# MindMapShare

**MindMapShare** ([MindMapShare.com](https://MindMapShare.com)) is a social
mind-mapping app. Ideas are bubbles on a clean 2D canvas: you connect them with
weighted links, group related ones inside container bubbles, attach notes, links, and
task checkboxes, and keep as many separate maps as you like. Maps can be public,
friends-only, or private, shared for real-time co-editing with built-in chat and an
attributed activity log — and there's a social side too: **follow** other people, see a
**home feed** of their fresh maps, and **like** the ones you enjoy. You can even
**generate a starting map from a text prompt with AI**.

It runs as a single small Node server with a no-build web front end. With no
configuration your data lives in a JSON file; it upgrades to **Postgres** for production
and turns on **AI generation** simply by setting environment variables.

## Run it locally

Requires [Node.js](https://nodejs.org) 20+.

- **Easiest (Windows):** double-click `start.bat` — it starts the server and opens the app.
- Or from a terminal: `npm install` once, then `node server.js`, and open <http://localhost:3000>.

With no configuration the server stores everything in `data/data.json` — perfect for
home/LAN use. Postgres and AI generation are **optional** integrations, each enabled by
an environment variable (see below); their libraries install with `npm install`.

### Use it on your phone

Start the server on your PC, then on a phone connected to the **same Wi-Fi**, open the
`http://192.168.x.x:3000` address the server prints at startup. (If it doesn't load,
allow Node.js through Windows Firewall on private networks.) The layout is
mobile-friendly: on small screens the top navigation collapses into a **☰ hamburger
menu**.

## What you can do

### Accounts, profiles & the social side
- Sign up with a username and password, add an optional display name, and choose whether
  it's shown to everyone or just friends.
- **Browse** and search everyone on the app; open anyone's profile to view their maps.
- **Friends** — send, accept, and decline friend requests. Friendship unlocks
  friends-only maps and is required before you can grant someone edit access.
- **Follow** — follow anyone (one-directional, like most social apps) to fill your feed.
- **Home feed** — your landing screen shows recent maps from people you follow (and your
  friends), newest first, with a **Discover public maps** section when your feed is thin.
- **Likes** — like any map you can view, from the feed or the read-only map view.

### Multiple maps per account
- Keep several independent maps (e.g. "Work", "Novel ideas", "Trip planning"). Switch
  between them from the dropdown on the map screen; create one with **+ New**. Selecting a
  map **frames the whole thing** in view automatically.
- Each map has its **own name and its own privacy setting** — this is per-map, not a
  single account-wide toggle. Settings only sets the *default* privacy for new maps.
- From **Map ▾** you can rename a map, delete it (you always keep at least one),
  **duplicate** it (an independent private copy of its contents — no shared editors,
  chat, or likes carry over), and **reorder** your maps — **drag** the ⠿ handle (or use
  ↑ ↓) — so the dropdown lists them the way you want.

### Privacy — friends-only maps are truly hidden
- A map set to **Friends only** is invisible to anyone who isn't your friend: not listed
  on your profile, not counted in your totals in Browse, and it can't be opened by URL —
  to a stranger it's as if the map doesn't exist.
- A **Public** map is viewable (read-only) by everyone; a **Private** map is yours alone
  (plus anyone you've granted edit access).
- Being able to *view* a map never implies being able to *edit* it — see below.

### Building a map
- **2D bubbles** — a flat, pannable canvas. Tap a bubble to select it, tap again to
  rename, drag to move. Drag the background to pan, pinch or scroll to zoom, and use
  **⌖** to fit the whole map on screen.
- **Manual resize** — select a bubble or group and drag the round handle on its
  lower-right edge to make it any size (groups never shrink below the space their
  contents need).
- **🔓 Lock** — pin the selected bubble or group so it can't be accidentally moved or
  resized (shortcut **L**). A 🔒 badge marks locked items; tap **Lock** again to release.
- **📍 Set** — *tap* to snap the selected item back to a saved size & position; *press and
  hold* to save the current size & position as that "home". Handy alongside Lock for
  keeping a layout put.
- **Notes, links & tasks** — every bubble (and group) can carry a free-text **note**, an
  optional **link** (a web address), and a **✓ done** flag for tracking tasks. Links show
  as a small badge and notes surface in the **Outline** (and beneath the bubble there);
  done bubbles are dimmed with a struck-through label.
- **Weighted connections** — select a bubble, tap **+ Connection**, then tap another.
  New links start at weight 1 (a thin line); tap a line (or its numbered dot) for a
  slider to make it thicker (1–10 — the weight *is* the thickness) or remove it. From the
  same panel you can turn a connection into a **directional arrow** (with **⇄ Reverse** to
  flip it) and pick its **color** — a chosen hue, or **A** to default to the first
  bubble's color.
- **Groups** — **+ Group** creates a container bubble. Add bubbles inside it (select the
  group, then **+ Bubble**), or move bubbles in and out with **Group ▾**. Grouped
  bubbles can still link to bubbles outside the group.
- **✨ Tidy** — automatically spreads the whole map into a clean, evenly-spaced layout and
  fits it to the screen.
- **☰ Outline** — view the map as a collapsible text tree (groups with their children,
  then loose bubbles), with note/link/done markers. Click a row to focus that node on the
  canvas; double-click to edit. Notes show inline beneath their bubble. Available both
  while editing and when **viewing** a map read-only (on someone's profile or your own
  preview), where clicking a row centers the view on that bubble. **Export** the
  outline with the ⤓ button as **PDF** (a vector picture of the map plus the full
  outline, via the browser's Save-as-PDF), **Markdown**, **plain text**, or **OPML** (for
  other outliners).
- **✨ AI** *(when enabled)* — describe a topic and AI generates a starting map of grouped,
  connected ideas for you to refine. The button appears only when the server has an
  Anthropic API key configured (see below).
- **Overlap picker** — hovering highlights exactly what a click will select. When things
  stack up, hover for a second (or double-tap on mobile) for a dropdown listing
  everything under the cursor.

### Sharing & real-time collaboration
- **Grant edit access** to friends from **Map ▾ → "Who can edit this map?"**. Maps shared
  with you appear in your map dropdown under **Shared with me**.
- **Only the owner** can rename a map, change its privacy, manage editors, or delete it.
  Editors change contents but not settings — all enforced on the server.
- **Preview** your own map as visitors see it — the read-only view a stranger or follower
  gets — without leaving the editor.
- **Live updates** — when two people have the same map open, edits (including notes,
  links, and task toggles) appear on everyone's screen within a moment, without disturbing
  their pan, zoom, or the bubble they're dragging. A small "**\_\_\_ others here**"
  indicator shows who else is viewing.
- **Chat & activity log** (the 💬 panel) — collaborators can chat, and every change is
  recorded as an attributed, timestamped line — bubbles added/renamed/deleted, notes
  added/edited/removed, tasks completed/reopened, moves in and out of groups, and
  connection changes. The history saves with the map and survives restarts; an unread
  badge appears when new activity arrives while the panel is closed.

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
   - Environment variables:
     - `DATABASE_URL` = your Neon connection string (enables Postgres persistence)
     - `ANTHROPIC_API_KEY` = an Anthropic API key *(optional — enables the ✨ AI button)*
4. **Custom domain** (e.g. `MindMapShare.com`): in the Render service → Settings → Custom
   Domains, add your domain and set the DNS records Render shows. HTTPS is automatic.

Tables are created — and existing data is migrated — automatically on first boot.
Sessions get the `Secure` cookie flag behind HTTPS, and login/registration are
rate-limited per IP.

> **Persistence note:** without `DATABASE_URL` the server stores data in a JSON file on
> local disk, which is **ephemeral** on hosts like Render (wiped on each deploy/restart).
> Set `DATABASE_URL` in production so accounts and maps survive.

### AI map generation

Setting `ANTHROPIC_API_KEY` turns on the **✨ AI** button. Generation calls the
[Anthropic API](https://console.anthropic.com) (`@anthropic-ai/sdk`, model
`claude-opus-4-8`) to turn a prompt into groups, nodes, and weighted edges, which load
into the current map. Without the key the app runs normally and the button stays hidden.
Requests are rate-limited per user.

### Live collaboration behind a proxy

Real-time updates use **Server-Sent Events** (one long-lived HTTP connection per open
map). A reverse proxy must not buffer or prematurely close the stream — the server sends
the `X-Accel-Buffering: no` header and a 25-second heartbeat to keep connections healthy
through common proxies (nginx, Render).

### Schema migrations are automatic and safe

On boot the Postgres backend adds any missing columns with `ADD COLUMN IF NOT EXISTS`
(including the `following`/`followers` follow graph) and runs a **one-time, idempotent**
migration that wraps each legacy single-map account into the multi-map shape. It only
*reads* the old `map` column to build the first entry of the new `maps` array — it never
drops or overwrites existing bubbles, and re-running it is a no-op. Notes, links, tasks,
likes, and chat/activity history all ride along inside the map JSON, so no schema change
is required for them.

## Files

| Path | What it is |
|---|---|
| `server.js` | Node server: accounts, sessions, friends & follows, multi-map storage, likes, feed, live SSE + chat, AI generation, static files |
| `public/` | The web app (HTML/CSS/JS, no build step) |
| `data/data.json` | Local-mode user data (created on first run; not used with `DATABASE_URL`) |
| `.env.example` | Template for running locally against Postgres |
| `start.bat` | Windows launcher: starts the server and opens the app |
| `legacy-index.html` | The original single-user prototype, kept for reference |

Passwords are stored salted and hashed (scrypt). Sessions are HttpOnly cookies. The only
runtime dependencies are `pg` (used only with `DATABASE_URL`) and `@anthropic-ai/sdk`
(used only when `ANTHROPIC_API_KEY` is set); both are loaded lazily, so the app runs
without either configured.
