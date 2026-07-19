# Mind/Map 3D

A social 3D mind-mapping app. Every bubble is a shaded 3D sphere floating in space;
you connect them with weighted links, group them inside larger translucent container
spheres, and share your map with everyone or just your friends.

## Run it locally

Requires [Node.js](https://nodejs.org) 20+.

- **Easiest:** double-click `start.bat` — it starts the server and opens the app.
- Or from a terminal: `node server.js`, then open <http://localhost:3000>.

With no configuration the server stores everything in `data/data.json` — perfect for
home/LAN use, zero dependencies required. To run locally against a real Postgres
database instead, copy `.env.example` to `.env`, paste your connection string, and
run `npm install` once.

### Use it on your phone

Start the server on your PC, then on a phone connected to the **same Wi-Fi**, open the
`http://192.168.x.x:3000` address the server prints at startup. (If it doesn't load,
allow Node.js through Windows Firewall on private networks.)

## Features

- **Accounts & profiles** — sign up with a username and password, add an optional
  display name, and choose whether other people see it.
- **Privacy** — your mind map can be visible to *everyone on the app* or *friends only*
  (change anytime in Settings).
- **Friends** — browse and search for people, send/accept/decline friend requests.
- **3D sphere bubbles** — tap a bubble to select it, tap again to rename, drag to move.
- **Weighted connections** — any bubble can link to none, one, or many others.
  Select a bubble, tap **+ Connection**, then tap the other bubble. New links start at
  weight 1 (a thin line); tap any line (or its numbered dot) to open a slider and make
  it thicker (1–10 — the weight *is* the line thickness) or remove it.
- **Container bubbles** — "+ Group" creates a big translucent sphere. Add bubbles
  inside it (select the group, then "+ Bubble"), or move existing bubbles in and out
  with "Group ▾". Bubbles inside a group can still link to bubbles outside it.
- **Overlap picker** — hovering highlights exactly what a click will select (with the
  cursor turning into a pointer). When several things stack up under the cursor —
  a bubble inside a group with a line crossing behind it — hover for a second and a
  dropdown lists everything there so you can pick the one you meant. On mobile,
  one tap selects the top element; double-tap to get the same dropdown.
- **Touch friendly** — one finger orbits, pinch zooms, drag moves bubbles;
  on desktop use the mouse wheel, and Enter / Delete / F2 / Esc shortcuts.

## Files

## Deploy to the internet (Render + Neon)

The server automatically uses **Postgres** when a `DATABASE_URL` environment variable
is present, so production deployment is configuration, not code:

1. **Neon** (<https://neon.tech>): create a project, copy the connection string.
2. **GitHub**: push this repo.
3. **Render** (<https://render.com>): New → Web Service → connect the repo.
   - Build command: `npm install`
   - Start command: `node server.js`
   - Environment variable: `DATABASE_URL` = your Neon connection string
4. **Custom domain**: in the Render service → Settings → Custom Domains, add your
   domain and set the DNS records Render shows you. HTTPS certificates are automatic.

Tables are created automatically on first boot. Sessions get the `Secure` cookie flag
behind HTTPS, and login/registration are rate-limited per IP.

## Files

| Path | What it is |
|---|---|
| `server.js` | Node server: accounts, sessions, friends, map storage, static files |
| `public/` | The web app (HTML/CSS/JS, no build step) |
| `data/data.json` | Local-mode user data (created on first run; not used with `DATABASE_URL`) |
| `.env.example` | Template for running locally against Postgres |
| `legacy-index.html` | The original single-user prototype, kept for reference |

Passwords are stored salted and hashed (scrypt). Sessions are HttpOnly cookies.
