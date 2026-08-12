# Manufacturing — a MindMapShare plugin

A cycle-time stopwatch for the shop floor, and the tool records the times belong
to.

Time a cycle and it is recorded against **one tool** — a part, a machine, an op,
a station, and what is cutting. Enough cycles and the record answers the
questions that are actually asked at the machine:

- how long the op really takes, on average, at best, and how far it spreads
- how many parts one cutting edge lasts, at the cycle time you just measured
- how often to index, and how many parts a whole insert covers
- how many inserts a hundred parts consumes, and what they cost per part

## Installing

This plugin is not part of MindMapShare. It is downloaded separately and put in
the app's `plugins/` folder:

```bash
node tools/install-plugin.js manufacturing            # from a copy that ships it
node tools/install-plugin.js ~/Downloads/plugin.zip   # from a download
```

Restart the server. **Shop** appears in the top navigation. Without it installed,
nothing about the app changes.

To take it off again: `node tools/install-plugin.js --remove manufacturing`.
Tool records stay on each account and come back if it is reinstalled.

## Using it

**Add a tool.** A tool is one cutting tool on one op:

| Field | What it is |
| --- | --- |
| Part | The part number the op belongs to |
| Machine | Which machine it runs on |
| Op | The operation — Op 20, or whatever the traveller calls it |
| Station | Turret position or pocket: `T0303` |
| Tool | What it is: "80° CNMG rougher" |
| Insert | The insert designation: `CNMG432-MP` |
| Indexes per insert | Usable cutting edges on one insert — 4 on a CNMG |
| Inserts per op | How many inserts are mounted in this tool |
| Tool life | Cutting minutes one edge is expected to last |
| Insert cost | Optional — what one insert costs, for cost per part |

**Time it.** **Start** when the tool goes in, **Cycle done** at the end of each
part. Each press records the split since the last one, so a run of parts gives a
run of cycle times without stopping the watch. **Reset** zeroes the display and
keeps every recorded cycle.

At a laptop, <kbd>Space</kbd> starts and stops, <kbd>L</kbd> marks a cycle and
<kbd>R</kbd> resets. A time measured somewhere else is typed straight in as
`42.6` or `1:23.4`.

The watch keeps time from the clock rather than counting up, so a phone that
sleeps mid-cycle, a backgrounded tab and a page reload all come back reading
correctly.

**Read the numbers.** With a tool life and indexes on the tool, the measured
average turns into:

```
parts per edge    = tool life minutes × 60 ÷ average cycle seconds
parts per insert  = parts per edge × indexes per insert
inserts / 100     = inserts per op × 100 ÷ parts per insert
cost per part     = inserts per op × (insert cost ÷ indexes) ÷ parts per edge
```

Tools are grouped by part, machine and op, and each group shows the total
measured cycle across its timed tools — the op's real cycle time, built from the
tools that make it up.

**⤓ CSV** downloads every recorded cycle, one row each, carrying the tool it
belongs to, for pivoting in a spreadsheet.

## What it stores, and where

Everything is saved on the signed-in account, in the same database as the rest
of the app, private to that account. Nothing is shared, published or sent
anywhere else. It is included in **Settings → Export my data**, and it is
deleted with the account.

## How it is put together

```
plugin.json          the manifest the app reads at startup
server.js            two routes: GET / and PUT /, under /api/plugins/manufacturing
public/client.js     the Shop screen
public/client.css    its styles, scoped under .mf-root
```

`server.js` rebuilds every field of what a client sends before it is stored, and
holds the record to sensible limits (200 tools, 300 recorded cycles per tool).
The client owns the state on screen and autosaves it; a recorded cycle is sent
at once rather than on the debounce, because it is the one thing here that
cannot be retyped from memory.
