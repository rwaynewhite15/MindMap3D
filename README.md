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

## What's new

- **🎮 Games!** — a built-in **game editor and arcade**. Write small HTML/JS games (or any
  interactive widget) right in the browser, starting from a template. Games run safely
  sandboxed, keep score, post to **per-game leaderboards**, and can even **call the AI
  mid-play** (think AI-written trivia questions or NPC dialogue). Publish to friends or
  everyone and discover other people's games on the new **Games** page.
- **Ranked play, decided by the server** — a game can ship **rules that run on our servers**,
  so matches stop being self-reported: illegal moves are refused before they reach your
  opponent, the winner is worked out from the moves themselves, and a client that claims a
  victory it didn't earn is simply told no. Ranked games keep an **Elo ladder**. Author rules
  run in a locked-down sandbox — a separate process with no filesystem, no environment, and
  no network.
- **Multiplayer, with a real lobby** — games can host **live matches against other people**.
  There are no join codes to pass around: every player waiting for an opponent shows up as an
  **open table in that game's lobby**, and you simply **sit down** at one (or hit **Quick
  match**). Game cards show *"🟢 2 players waiting to play"* so you can find a live game.
  Prefer solo? **Play an AI character** instead — the platform invents named opponents with
  their own personalities that **build win/loss records** on the same ladder as human players.
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
- **☰ Outline** — view the map as a collapsible text tree (groups with their children,
  then loose bubbles), with note/link/done markers. Click a row to focus that node on the
  canvas; double-click to edit. Notes show inline beneath their bubble. Available both
  while editing and when **viewing** a map read-only (on someone's profile or your own
  preview), where clicking a row centers the view on that bubble. **Export** the
  outline with the ⤓ button as **PDF** (a vector picture of the map plus the full
  outline, via the browser's Save-as-PDF), **Markdown**, **plain text**, or **OPML** (for
  other outliners).
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

### Games — build, play, compete

MindMapShare includes a small arcade: anyone can **create games** (or other interactive
widgets) and share them the same way maps are shared.

- **The Games page** (🎮 in the nav) lists **your games** and a **Discover** feed of public
  games from the whole community. Signed-out visitors can browse and play public games too.
- **The editor** is a split view: your **HTML/CSS/JS code on the left, a live preview on
  the right** — press **▶ Run** to save and play instantly. Start from a template: a blank
  scaffold, an arcade game, a multiplayer Tic Tac Toe, or an AI trivia quiz.
- **Scores & leaderboards** — games report scores through a tiny `MindGame` API
  (`setScore`, `addScore`, `gameOver`). Each game keeps a **leaderboard of every player's
  personal best** (with play counts), shown beside the game with medals for the top three
  and your own rank pinned. A game can rank **higher-is-better or lower-is-better** (for
  time-based or golf-style games).
- **AI inside games** *(when the server has AI enabled)* — game code can call
  `MindGame.ai(prompt)` to get AI answers mid-play: generated quiz questions, NPC
  dialogue, hints, opponents. Requests are relayed and rate-limited by the server; the
  game code never sees any credentials.
- **Same privacy tiers as maps** — every game is **Private**, **Friends only**, or
  **Public**. Publishing a playable game notifies your friends and followers (bell and
  push), and tapping the alert drops them straight into the game.
- **Multiplayer & AI opponents** — games can host live matches through a pooling lobby;
  see below.

#### Multiplayer & the pooling lobby

Games can run **live matches** between players — and against AI characters — without the
author writing any networking code.

- **The lobby is a pool, not a code exchange.** Anyone waiting for an opponent is an **open
  table** listed in that game's lobby, showing who's waiting and for how long. You **sit
  down** at a table to start the match, or press **Quick match** to be paired with whoever
  has waited longest. Tables appear and disappear live over a stream, and the Games hub
  advertises *"🟢 N players waiting to play"* on each card so live games are easy to find.
- **AI opponents are characters, not difficulty settings.** The first time someone plays
  a game's AI, the platform *invents* a persona server-side — a name, a personality, and a
  play style ("Rusty Circuits: a creaky old bot with surprising flashes of brilliance") —
  saves it to the game, and seats it. Its moves can be driven by `MindGame.ai(prompt, {as})`,
  which answers **in that character's voice**, and it **accumulates a win/loss record** that
  sits on the same match ladder as human players. Later matches can re-seat the same rival.
- **Match records** live beside the score leaderboard: a W/L/D ladder covering humans and AI
  personas alike, sorted by wins.
- **For game authors** it's a handful of calls — `MindGame.match({mode:'pvp'})`,
  `match.send(move)`, `match.on('message', …)`, `match.end({winner})`, plus
  `MindGame.onLobby(fn)` for a live table list. The **Tic Tac Toe template** is a complete
  working example: lobby, quick match, AI opponent, forfeit handling, and result recording.

#### Ranked play — results the leaderboard can trust

Casual games report their own results, so their boards are honour-system. A **ranked** game
adds a second, small piece of code — **rules that run on MindMapShare's servers** — and the
players' browsers stop being the authority:

```js
const Rules = {
  seats: 2,
  setup(players) { return { board: ['','','','','','','','',''], turn: 0 }; },
  move(state, seat, data) {
    // `seat` is who the SERVER saw send this move — it cannot be forged.
    if (seat !== state.turn)  return { error: 'It is not your turn.' };
    if (state.board[data.cell]) return { error: 'That square is taken.' };
    state.board[data.cell] = seat === 0 ? 'X' : 'O';
    // …return { state, done: true, winner: seat } when it's decided
    return { state, next: 1 - seat };
  },
};
```

- **Every move is checked before it is relayed.** An illegal move is refused with the rules'
  own message and never reaches the opponent — it simply didn't happen.
- **The server declares the result.** When the rules say the game is over, the server ends
  the match and records it. A client that POSTs "I won" gets a 409; the only result a player
  may declare is **resignation**. Quitting mid-match forfeits (after a short grace period, so
  a dropped connection isn't an instant loss) — and the server awards that too.
- **Elo ratings** start at 1200 and move only from server-decided matches (K=32 until a
  player has 10 games, then 24; provisional ratings are marked "?"). The **ranked ladder**
  sits beside the casual score board, precisely because those two kinds of number deserve
  different levels of trust.
- **Ranked is PvP-only.** In a vs-AI match your own browser drives the opponent, so a rating
  from it would mean nothing.
- **Turning it on**: write the rules in the editor's **⚖️ Ranked** panel and press *Check
  rules* — they're compiled and smoke-tested in the sandbox, and ranked can only be switched
  on once they actually run. The **Tic Tac Toe template ships with rules**, so a game made
  from it is ranked from the moment it's created.

#### Safety — why user-written code is safe to run

- Game code runs in a **sandboxed iframe with a locked-down Content Security
  Policy**: an opaque origin, no cookies, and **no network access at all**. Games talk to
  the app only through a narrow `postMessage` bridge (score, round-over, AI ask, moves),
  and everything privileged happens outside the sandbox: **the host page holds the session,
  opens the match stream, and makes every API call**. The server binds each connection to
  the signed-in user and **stamps every relayed move with the verified sender**, so game
  code cannot forge who moved, join a match it wasn't seated at, or read anyone's
  credentials. Turn order is enforced server-side — an out-of-turn move is rejected before
  it reaches the other player.

Rules themselves are author-written code that the *server* runs, so they get their own
containment, layered deliberately:

1. a **separate process** (`rules-runner.js`) started with Node's permission model —
   **no filesystem, no child processes, no worker threads, no native addons**;
2. **an empty environment** (`env: {}`): no `DATABASE_URL`, no API keys, nothing to steal;
3. **a `vm` context per game** with dynamic code generation disabled (no `eval`, no
   `new Function`), where **only JSON strings cross the boundary** — the documented `vm`
   escape works by grabbing a host object handed into the sandbox, and nothing is;
4. **CPU and memory ceilings**: a runaway `move()` fails that one move (the player is told
   the rules took too long), a memory bomb kills only the sandbox, and the parent restarts
   it. If the sandbox can't start at all, ranked play is unavailable rather than unguarded.

`vm` alone is explicitly not a security boundary, which is exactly why it is never the only
one. This is verified by tests that fire hostile rules at it — reading files, spawning
shells, reaching for `process.env`, the `constructor.constructor` escape, infinite loops,
memory bombs — and check the server keeps serving.

> **Remaining caveat, stated plainly:** *single-player score* leaderboards are still
> self-reported and remain honour-system — validating those needs replay verification,
> which isn't built. What ranked play fixes is **match** results: those are decided by the
> server from the moves themselves.

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

The same key also powers AI inside games: the `MindGame.ai()` calls a running game makes,
and the AI opponent personas that multiplayer invents — both served by the fast
`claude-haiku-4-5` model and rate-limited per user. Without the key, games still work:
`MindGame.aiAvailable` is `false` so well-written games fall back gracefully, and personas
are drawn from a built-in cast instead.

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

Real-time updates use **Server-Sent Events** (one long-lived HTTP connection per open
map, per open game match, and per watched game lobby). A reverse proxy must not buffer or
prematurely close the stream — the server sends the `X-Accel-Buffering: no` header and a
25-second heartbeat to keep connections healthy through common proxies (nginx, Render).

Game matches are **in-memory** on the server: a restart drops matches in flight (players
just start a new one), while everything durable — AI personas, win/loss records, scores,
ranked ratings — lives on the game record in the database. Because match state is per-process, running
multiple workers would need a shared bus (Redis) before matches could span them; a single
web service handles the current scale fine.

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
| `server.js` | Node server: accounts, sessions, friends & follows, multi-map storage, likes, feed, live SSE + chat, AI generation, games (sandboxed serving, leaderboards, AI relay, matches + lobby + AI personas, ranked play + Elo), static files |
| `rules-runner.js` | The sandbox for ranked games' server-side rules — spawned as a privilege-stripped child process (no filesystem, no environment, no network), one `vm` context per game |
| `public/` | The web app (HTML/CSS/JS, no build step) |
| `data/data.json` | Local-mode user data (created on first run; not used with `DATABASE_URL`) |
| `.env.example` | Template for running locally against Postgres |
| `start.bat` | Windows launcher: starts the server and opens the app |
| `legacy-index.html` | The original single-user prototype, kept for reference |

Passwords are stored salted and hashed (scrypt). Sessions are HttpOnly cookies. The only
runtime dependencies are `pg` (used only with `DATABASE_URL`) and `@anthropic-ai/sdk`
(used only when `ANTHROPIC_API_KEY` is set); both are loaded lazily, so the app runs
without either configured.
