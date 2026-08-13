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
- and, across the op's tools in the order they cut, **where the cycle actually goes**

## Installing

This plugin is not part of MindMapShare. It is downloaded separately and put in
the app's `plugins/` folder:

```bash
node tools/install-plugin.js manufacturing            # from a copy that ships it
node tools/install-plugin.js ~/Downloads/plugin.zip   # from a download
```

Restart the server. **Shop** then appears in the **Features** library, next to the
built-in screens; add it there and it joins your toolbar. Without it installed,
nothing about the app changes.

To take it off again: `node tools/install-plugin.js --remove manufacturing`.
Tool records stay on each account and come back if it is reinstalled — as does
its place in anyone's toolbar, which is kept rather than quietly dropped.

## Using it

**Add a tool.** A tool is one cutting tool on one op:

| Field | What it is |
| --- | --- |
| Part | The part number the op belongs to |
| Machine | Which machine it runs on |
| Op | The operation — Op 20, or whatever the traveller calls it |
| Seq | Where the tool falls in the op's running order — 1 cuts first |
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

**Put the tools in running order.** Each tool carries a **Seq** — 1 cuts first.
A new tool takes the next number in its op automatically, so entering tools in
the order they run needs no thought; the ↑ / ↓ buttons on a tool card move it a
place either way afterwards, and the op renumbers itself so the sequence is
always 1..n with no gaps. The tool list, the chart and the CSV all follow that
order, and the watch says which tool of how many you are timing.

**See where the cycle goes.** The **Op cycle** panel is the op's whole measured
cycle — the sum of every tool's average — with a stacked bar underneath dividing
it between the tools in the order they cut. Each segment is one tool, sized by
its share; the table below the bar names them, gives each average and its
percentage, and doubles as the legend. Hovering (or tabbing to) either the bar
or a row lights up the other, so a two-percent segment is still reachable.

The segment fills come from a single cyan ramp stepped light→dark along the
running order, so the order is legible in the color itself rather than needing
eight unrelated hues. The ramp is checked against the dark chart surface for
monotone lightness, a visible gap between adjacent steps, one hue, and a darkest
step that still clears the surface.

A tool with nothing timed against it yet cannot contribute to the total, so it is
listed as **not timed** and a line under the chart says how many of the op's
tools are in that state — the total is what has been measured, not a finished op.
An op with only one timed tool gets the figure without a bar; one segment is not
a part-to-whole story.

Tools are grouped by part, machine and op, and each group heading also shows the
total measured cycle across its timed tools, so every op on the board reads at a
glance and not just the one being timed.

**⤓ CSV** downloads every recorded cycle, one row each, carrying the tool it
belongs to and its place in the op, ordered the way the job runs, for pivoting in
a spreadsheet.

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
