# MindMapShare

**MindMapShare** ([MindMapShare.com](https://MindMapShare.com)) is a social
mind-mapping app. Ideas are bubbles on a clean 2D canvas: you connect them with
weighted links, group related ones inside container bubbles, attach notes, links, and
task checkboxes, and keep as many separate maps as you like. Maps can be public,
friends-only, or private, shared for real-time co-editing with built-in chat and an
attributed activity log — and there's a social side too: **follow** other people, see a
**home feed** of their fresh maps, and **like** the ones you enjoy. You can even
**generate a starting map from a text prompt with AI**. Alongside your maps, every
account gets one **Standing Desk** — a work board for what is actually on you right now,
and what you're waiting on from someone else, private by default and shareable by link.

It runs as a single small Node server with a no-build web front end. With no
configuration your data lives in a JSON file; it upgrades to **Postgres** for production
and turns on **AI generation** simply by setting environment variables.

## What's new

- **The Standing Desk** — a second page for every account, next to your maps. Where a map
  holds ideas, the desk holds open work: items **assigned to you**, items you are **waiting
  on** from someone else, and the number of days since each was last updated — so a request
  made three weeks ago reads as exactly that. Five assigned items at a time, plus reference
  entries and a working-notes area. One board per person, private by default.
- **Desk items and reference entries can link to a mind map** — pick one of your maps (or a
  map shared with you) when you add an item, or attach one later with **Link a map**. The
  link opens that map in the editor, and shows its current name, so renaming the map keeps
  the link accurate.
- **Desks can be shared** — a desk is private until you say otherwise. Share it with **anyone
  holding its link** (a secret code you can revoke at any time), or with **anyone at all**, in
  which case it is linked from your profile. Viewers get a read-only board, and your **working
  notes are never shared** under any setting.
- **Project or reference is a dropdown** — once a project name is on the board, later items
  pick it from a list instead of retyping it, with a **＋ New** entry for a name that isn't
  there yet.
- **The outline is now an editor, not just a view** — the ☰ Outline panel is a first-class
  way to build and study a map. Anyone with edit access can **rename items, edit notes and
  links, add sub-items, tick things off, and delete** straight from the outline; the **map
  owner** can additionally **rearrange it** by dragging the ⠿ handle or using ↑ / ↓. Sub-items
  nest to any depth, and the order you set is the order every **export** (PDF, Markdown,
  plain text, OPML) uses.
- **Games have been removed.** The game editor, arcade, leaderboards, multiplayer lobby,
  ranked play, and the AI opponents that went with them are gone, along with every
  server route and the rules sandbox behind them. No user-authored code runs on the
  server or in the browser any more, and the Anthropic API key is used **only** for mind-map
  generation.
- **AI can expand a map, not just replace it** — the ✨ AI panel now offers **Add to map**
  (reads your current map as context and adds new, connected ideas beside it — nothing
  removed) alongside **Begin new map** (the original replace behavior).
- **Guests can see likes & comments** — signed-out visitors viewing a public map see its
  like count and can read comments; liking or commenting prompts them to sign in.
- **Map bubbles can link to maps you follow** — the 🗺️ Map picker now lists both your own
  maps and maps from people you follow.
- **Save a copy** of any map you can view into your own maps, and a read-only **comment
  section** on every map, with comment counts shown on home-feed cards.
- **Tidier bubble labels** — long labels shrink to fit and never break a word mid-word.

## Why people choose MindMapShare

- **Visual thinking that stays organized**: map ideas as bubbles, connect them with weighted links, and group concepts into clear structures.
- **Outline + canvas together**: switch between freeform spatial thinking and a collapsible text outline for fast navigation and editing.
- **Built for collaboration**: share maps with friends, co-edit in real time, and keep context with integrated chat and attributed activity history.
- **Privacy that matches real use**: every map can be Public, Friends only, or Private, with owner-controlled edit permissions.
- **Social discovery baked in**: follow creators, browse profiles, and discover fresh public maps from the home feed.
- **From zero to first draft quickly**: generate a starter map from a prompt (when AI is enabled), then refine it with your team.

## Product Tour

These screenshots provide a customer-facing walkthrough of the full product experience.
The screenshots are embedded directly throughout the feature sections below.

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

![Mobile navigation on phone](public/screenshots/13-mobile-hamburger-menu.png)

This view demonstrates that map browsing and navigation remain comfortable on a phone,
not just on desktop.

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
- **Comments** — any signed-in viewer can leave comments on a map from the read-only view
  (the 💬 Comments panel), the owner included. You can delete your own comments; the map
  owner can moderate any of them. Distinct from the editor-only collaboration chat.
- **Guests can see likes & comments** — signed-out visitors viewing a public map see its
  like count and can read the comments; posting a comment or liking prompts them to sign in.

![Home feed with discovery](public/screenshots/01-home-feed.png)

The home feed keeps users engaged with fresh activity from people they care about while
still helping them discover new public maps.

![Browse and profile pages](public/screenshots/12-browse-and-profile.png)

Browse and profile views make MindMapShare feel like a network, not just a single-player
tool.

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
- **Save a copy of any map you can view** — from the read-only map view, **⎘ Save a
  copy** clones the map (your own or someone else's public/friends' map) into your **My
  Maps** as a fresh, private, fully editable copy, then opens it in the editor. The
  original owner isn't affected; no editors, chat, or likes carry over.
- **Map bubbles** — insert a map **as a bubble** with **🗺️ Map** in the editor — one of your
  own maps, or a map from **someone you follow**. It becomes an accent-ringed bubble (with a
  🗺️ badge) labelled after that map; when someone **viewing** the map taps it, they're taken
  to the linked map. Great for splitting a big idea into linked sub-maps, building an index
  map, or pointing at maps you follow.

![Map switcher and create new map](public/screenshots/04-map-switcher-and-new-map.png)

This flow highlights a key product advantage: one account can manage many distinct maps
without clutter or context switching pain.

### The Standing Desk — one work board per account

Open **Desk** in the top navigation. Every account has exactly one, and it is **always
private**: no visibility tier, no editors, never listed on a profile or in the feed. Where
maps are for developing ideas, the desk is for tracking open work.

- **Two states.** Every item is either **Assigned to me** or **Waiting on others**.
  **Move to waiting** / **Assign to me** moves an item between them and **resets its
  last-updated date**, since a reassignment is the point from which the next wait is
  measured. **Mark updated** resets that date without moving the item — for when you
  followed up and the position hasn't changed.
- **A limit of five assigned items.** The board declines a sixth and explains why: complete
  one, or move it to waiting. Nothing is ever deleted to make room.
- **Age is tracked, not guessed.** Each item shows the days since it was last updated. At a
  week it turns amber; after **14 days** it is flagged as stalled, with a red edge and a
  band reading *follow up or remove*. The **Stalled** figure in the header counts them, so
  an item that has quietly gone quiet stays visible.
- **A next step on every item**, edited in place. Left empty it is shown in red — an item
  with no next step is a note, not a commitment.
- **A link to a mind map.** Items and reference entries can each point at one map — your own,
  or one shared with you to edit — chosen when you add them or attached afterwards with
  **Link a map**. Following the link opens that map in the editor. Only the map's id is
  stored, so the desk always shows its current name; if the map is later deleted or
  unshared, the link says so instead of failing silently.
- **One project or reference per item**, chosen from a dropdown of the ones already on the
  board so the same name is typed once and picked thereafter. **＋ New project or reference**
  turns the dropdown back into a text box for a name that isn't there yet.
- **Reference** — short entries you refer to often (links, codes, contacts, targets, a map
  you keep reopening), edited in place and kept separate from the item list.
- **Working notes** — a ruled area at the foot of the board for thinking something through.
  Saved with everything else, but nothing in it is tracked or counted.
- **Copy summary** puts the board on the clipboard as plain text: what is assigned to you,
  then what you are waiting on and from whom, each with its age.

**Sharing.** The state of the board is shown in its header — click it to choose:

- **Private** — only you. The default, and where every desk starts.
- **Anyone with the link** — the board gets a secret code, and the link that carries it
  (`…/#/desk/<you>/<code>`) opens a read-only copy for anyone, signed in or not. **Generate a
  new code** revokes the old link immediately. Turning sharing off and on again keeps the same
  link working, so a link you have handed out doesn't break by accident.
- **Anyone** — readable by everyone and linked from your profile, no code needed.

A viewer sees the items and reference entries, read-only, and can copy the summary. Your
**working notes are never shared**, under any setting. Links to maps a viewer can't open are
left out of what they're sent, rather than shown as something they can't reach.

Everything autosaves as you type, and the board is included in **⤓ Export my data**.
Deleting your account deletes it along with everything else.

### Privacy — friends-only maps are truly hidden
- A map set to **Friends only** is invisible to anyone who isn't your friend: not listed
  on your profile, not counted in your totals in Browse, and it can't be opened by URL —
  to a stranger it's as if the map doesn't exist.
- A **Public** map is viewable (read-only) by everyone; a **Private** map is yours alone
  (plus anyone you've granted edit access).
- Being able to *view* a map never implies being able to *edit* it — see below.

![Per-map privacy controls](public/screenshots/08-map-privacy-controls.png)

Privacy is configured at the map level, so users can publish some ideas, keep others to
friends, and keep sensitive work private.

### Building a map
- **2D bubbles** — a flat, pannable canvas. Tap a bubble to select it, tap again to
  rename, drag to move. Drag the background to pan, pinch or scroll to zoom, and use
  **⌖** to fit the whole map on screen.
- **Notes, links & tasks** — every bubble (and group) can carry a free-text **note**, an
  optional **link** (a web address), and a **✓ done** flag for tracking tasks. Notes and
  links show as small badges; done bubbles are dimmed with a struck-through label.
- **Weighted connections** — select a bubble, tap **+ Connection**, then tap another.
  New links start at weight 1 (a thin line); tap a line (or its numbered dot) for a
  slider to make it thicker (1–10 — the weight *is* the thickness) or remove it.
- **Groups** — **+ Group** creates a container bubble. Add bubbles inside it (select the
  group, then **+ Bubble**), or move bubbles in and out with **Group ▾**. Grouped
  bubbles can still link to bubbles outside the group.
- **✨ Tidy** — automatically spreads the whole map into a clean, evenly-spaced layout and
  fits it to the screen.
- **☰ Outline** — the map as a collapsible text tree, with note/link/done markers and notes
  shown inline beneath their item. Click a row to focus that node on the canvas. Available
  both while editing and when **viewing** a map read-only (on someone's profile or your own
  preview), where clicking a row centers the view on that bubble instead.

  **Editing from the outline** *(owner and anyone granted edit access)*: each row carries
  **✎ Edit** (label, notes, link — the same sheet the canvas uses), **＋** to add a sub-item
  beneath it, **🗑** to delete it, and a **checkbox** to tick it off as you study. The
  **+ Topic** and **+ Group** buttons at the foot of the panel add top-level items. Adding a
  sub-item to a plain bubble turns it into a group, because in a mind map an idea with
  sub-ideas *is* a group — so outlines nest as deep as you need. Every edit autosaves and
  broadcasts to anyone else on the map exactly like a canvas edit.

  **Rearranging** *(owner only)*: drag the **⠿** handle, or use **↑ / ↓**, to reorder items
  within their level. The order is stored per item and is independent of where bubbles sit
  on the canvas, so you can arrange a study sequence without disturbing the layout — and
  every **export** follows it.

  **Export** the outline with the ⤓ button as **PDF** (a vector picture of the map plus the
  full outline, via the browser's Save-as-PDF), **Markdown**, **plain text**, or **OPML**
  (for other outliners).
- **✨ AI** *(when enabled)* — describe what you want and AI builds grouped, connected ideas
  for you to refine, two ways: **Begin new map** generates a fresh map that *replaces* the
  current contents, or **Add to map** reads the existing map as context and *expands* it —
  new ideas are added beside what's there (nothing removed) and can connect to your existing
  bubbles. The button appears only when the server has an Anthropic API key configured (see
  below).
- **Overlap picker** — hovering highlights exactly what a click will select. When things
  stack up, hover for a second (or double-tap on mobile) for a dropdown listing
  everything under the cursor.

![Map canvas overview](public/screenshots/02-map-canvas-overview.png)

The core canvas emphasizes clarity: users can quickly see structure, relationships, and
priority at a glance.

![Create bubbles and weighted links](public/screenshots/05-create-bubble-and-link.png)

Fast creation and mind map linking make brainstorming feel fluid while preserving signal
about which connections matter most.

![Groups for structure](public/screenshots/06-groups-and-structure.png)

Groups help large maps stay readable by clustering related ideas without sacrificing
cross-group connections.

![Notes, links, and task states](public/screenshots/07-notes-links-and-tasks.png)

Notes, links, and task markers turn a visual map into an actionable workspace.

![Outline panel open](public/screenshots/03-outline-open.png)

The Outline view complements the canvas for users who prefer hierarchy and quick scanning
of nested ideas.

![Outline export options](public/screenshots/15-outline-export-options.png)

Export options make maps portable for docs, planning workflows, and external knowledge
tools.

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

![Share map edit access](public/screenshots/09-share-edit-access.png)

Sharing permissions give owners confidence: collaboration is easy to grant and easy to
control.

![Live collaboration with chat](public/screenshots/10-live-collaboration-chat.png)

Real-time updates plus chat reduce coordination overhead for teams working in parallel.

![AI map generation flow](public/screenshots/14-ai-map-generation.png)

AI generation accelerates the blank-page moment by producing a first draft users can
immediately refine. You can also have the AI add to your ideas and build off them.

![Read-only preview experience](public/screenshots/11-read-only-preview.png)

Read-only previews let creators publish and present maps safely without exposing edit
controls.

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
     - `ADMIN_PASSWORD` = a long random secret *(optional — enables the admin console at `/admin`)*
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
`claude-opus-4-8`) to turn a prompt into groups, nodes, and weighted edges. **Begin new
map** replaces the current map; **Add to map** sends the existing map as context and the
model returns only additions, which are merged in beside your current content (new bubbles
can even connect to existing ones). Without the key the app runs normally and the button
stays hidden. Requests are rate-limited per user.

Map generation is the **only** thing the key is used for.

### Admin console

Setting `ADMIN_PASSWORD` turns on an admin dashboard at **`/admin`**, separate from
normal user accounts. Sign in with the password to see site-wide stats (total users,
maps, and nodes, plus recent sign-ups), browse and filter every account, and delete
users (which scrubs all their friend/follow links and shared-map grants). The admin
session is a short-lived, HttpOnly signed cookie — the signature is keyed by
`ADMIN_PASSWORD` itself, so rotating the password immediately invalidates every open
admin session and nothing is stored server-side. Sign-in attempts are rate-limited per
IP. Leave `ADMIN_PASSWORD` unset and both the page and its API stay disabled.

### Live collaboration behind a proxy

Real-time updates use **Server-Sent Events** (one long-lived HTTP connection per open map,
plus one per signed-in user for the notification bell). A reverse proxy must not buffer or
prematurely close the stream — the server sends the `X-Accel-Buffering: no` header and a
25-second heartbeat to keep connections healthy through common proxies (nginx, Render).

Presence and stream membership are **in-memory** per process, so running multiple workers
would need a shared bus (Redis) before live collaboration could span them; a single web
service handles the current scale fine. Everything durable — maps, chat, comments, likes —
lives in the database.

### Schema migrations are automatic and safe

On boot the Postgres backend adds any missing columns with `ADD COLUMN IF NOT EXISTS`
(including the `following`/`followers` follow graph and the `desk` board) and runs a
**one-time, idempotent**
migration that wraps each legacy single-map account into the multi-map shape. It only
*reads* the old `map` column to build the first entry of the new `maps` array — it never
drops or overwrites existing bubbles, and re-running it is a no-op. Notes, links, tasks,
likes, and chat/activity history all ride along inside the map JSON, so no schema change
is required for them.

## Files

| Path | What it is |
|---|---|
| `server.js` | Node server: accounts, sessions, friends & follows, multi-map storage, the Standing Desk, likes, feed, comments, notifications + Web Push, live SSE + chat, AI map generation, static files |
| `public/` | The web app (HTML/CSS/JS, no build step) |
| `data/data.json` | Local-mode user data (created on first run; not used with `DATABASE_URL`) |
| `.env.example` | Template for running locally against Postgres |
| `start.bat` | Windows launcher: starts the server and opens the app |
| `legacy-index.html` | The original single-user prototype, kept for reference |

Passwords are stored salted and hashed (scrypt). Sessions are HttpOnly cookies. The only
runtime dependencies are `pg` (used only with `DATABASE_URL`) and `@anthropic-ai/sdk`
(used only when `ANTHROPIC_API_KEY` is set); both are loaded lazily, so the app runs
without either configured.
