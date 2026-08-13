# Manufacturing — a MindMapShare plugin

A cycle-time stopwatch for the shop floor, over a tool crib and the machines it
feeds.

A tool and a machine are separate records, and **a tool runs on as many machines
as it is assigned to, while a machine holds as many tools**. Neither owns the
other. What is true of the tool itself — its part number, what it is, how many
cutting edges it has — is kept once, in the crib. What changes from machine to
machine — the cutting time, how many of those edges get indexed through there,
how many parts run between one index and the next — is kept on the assignment
that puts the tool on the machine, along with every cycle timed against it.

Time enough cycles and the record answers the questions that are actually asked
at the machine:

- how long the op really takes, on average, at best, and how far it spreads
- how much of the measured cycle is actually cut
- how long an edge lasts in minutes of cut, at the parts it runs between indexes
- how many parts a whole tool covers, how many tools a hundred parts consumes,
  and what they cost per part
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
Shop records stay on each account and come back if it is reinstalled — as does
its place in anyone's toolbar, which is kept rather than quietly dropped.

## Using it

**Add a machine.** A name is all it is: whatever it is called on the floor.

**Add a tool.** A tool is one cutting tool, described once however many machines
it ends up on:

| Field | What it is |
| --- | --- |
| Part number | The tool's own number — what it is ordered by: `CNMG432-MP` |
| Description | What it is: "80° CNMG rougher" |
| Cutting edges | Usable cutting edges the tool has — 4 on a CNMG insert |
| Cost | Optional — what one costs, for cost per part |

**Assign it to a machine.** This is where the tool meets the job, and it is the
thing the stopwatch times:

| Field | What it is |
| --- | --- |
| Tool | Which tool from the crib this is |
| Machine | Which machine it is running on |
| Part | The part number of the job it is cutting |
| Op | The operation — Op 20, or whatever the traveller calls it |
| Seq | Where the tool falls in the op's running order — 1 cuts first |
| Station | Turret position or pocket: `T0303` |
| Cutting time | Seconds in cut on one part, on this machine |
| Indexable edges | How many of the tool's edges get indexed through here |
| Parts per index | Parts run between one edge index and the next |

The same tool assigned to a second machine gets its own cutting time, its own
edges and its own tool life there — which is the point: a rougher that gives 250
parts an edge on one machine and 180 on another is one tool with two sets of
numbers, not two tools.

Leaving **indexable edges** blank means every edge the tool has. Adding a tool
leads straight into assigning it, and adding a machine leads straight into
putting a tool on it, because a tool on no machine and a machine with no tools
are both records that cannot tell you anything yet.

**Time it.** **Start** when the tool goes in, **Cycle done** at the end of each
part. Each press records the split since the last one, so a run of parts gives a
run of cycle times without stopping the watch. **Reset** zeroes the display and
keeps every recorded cycle. A cycle is always recorded against one tool *on one
machine*, never against the tool in the abstract.

At a laptop, <kbd>Space</kbd> starts and stops, <kbd>L</kbd> marks a cycle and
<kbd>R</kbd> resets. A time measured somewhere else is typed straight in as
`42.6` or `1:23.4`.

The watch keeps time from the clock rather than counting up, so a phone that
sleeps mid-cycle, a backgrounded tab and a page reload all come back reading
correctly.

**Read the numbers.** From the parts per index on the assignment, and the cutting
time (or, until one is filled in, the measured average):

```
parts per tool     = parts per index × indexable edges
minutes per edge   = parts per index × cutting time ÷ 60
tools / 100 parts  = 100 ÷ parts per tool
cost per part      = tool cost ÷ parts per tool
```

With a cutting time and a measured average both present, the screen also says how
much of the cycle is cut and how much is everything else.

**Put the tools in running order.** Each assignment carries a **Seq** — 1 cuts
first — within its machine, part and op. A newly assigned tool takes the next
number automatically, so entering tools in the order they run needs no thought;
the ↑ / ↓ buttons on a card move it a place either way afterwards, and the op
renumbers itself so the sequence is always 1..n with no gaps. The lists, the
chart and the CSV all follow that order, and the watch says which tool of how
many you are timing.

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

**Read it from either end.** **Machines** lists each machine with the tools
assigned to it, grouped by the part and op they are set up for and in the order
they cut, with the measured cycle on the machine and on each group. **Tools**
lists the crib, each tool with the machines it runs on as chips — click one to
point the watch at that tool on that machine. One filter box narrows both.

Deleting a machine takes its assignments with it and leaves the tools in the
crib; deleting a tool takes it off every machine it was on. Both say exactly what
will go before they do it.

## Spreadsheets, in and out

**⤓ Export** downloads every recorded cycle, one row each, carrying the machine,
the tool and the setup between them, ordered the way the floor runs. Tools not on
a machine and machines with no tools get a row of their own, so the file is the
whole record rather than only the parts that have been timed.

**⤒ Import** reads one back. It is the same shape the export writes, so a file
that came out of here goes back in unchanged — and a tool list somebody already
keeps in a spreadsheet can be brought in by putting these headers on it:

```
machine, machine_notes, part, op, seq, station,
tool_part_number, tool_description, cutting_edges, tool_cost, tool_notes,
cutting_time_sec, indexable_edges, parts_per_index, notes,
cycle_seconds, recorded_at
```

Columns are read **by name, not by position** — reorder them, leave out the ones
that do not apply, or use a common alternative (`machine name`, `part number`,
`operation`, `turret`, `tool no`, `description`, `edges`, `cut time`,
`parts between indexes`, `seconds`, `date`) and it still reads. A row makes
whatever it names: a machine, a tool, the assignment between them, and a cycle
timed against it. A file needs at least one column naming a machine or a tool.
Three things can carry notes and each has its own column, so a machine's notes
and a setup's never overwrite one another; plain `notes` is the setup's. The
three worked-out columns the export adds — cycles timed, average, parts per
tool — are ignored on the way in: they come from the cycles, and a stale figure in
a spreadsheet should not be able to contradict the times it was supposed to
summarize.

**Files from version 1 still read.** `insert` is taken as the tool's part number,
`indexes_per_insert` as its cutting edges, and a tool life given in cutting
minutes per edge is turned into parts between indexes at the cutting time in the
file — or, failing that, at the cycles in the file itself, which is the same
division version 1 did on screen. A life with neither to divide by is left out
rather than guessed at, and the preview says how many.

Quoted fields, commas and newlines inside them, semicolon-separated files from
non-English spreadsheets, comma decimals (`10,5`) and Excel's byte-order mark all
read as you would expect.

**An import never deletes anything.** Choosing a file shows what it would do —
how many machines, tools and assignments are new, how many are already there, how
many cycles would be added — and nothing happens until you say Import. A machine
already there is matched by name, a tool by its part number and description, an
assignment by the machine and tool it joins plus the part, op and station it is
set up for; each gains any field the file fills in and keeps everything it leaves
blank. Cycles are recognized by when they were recorded and how long they took,
so **importing the same file twice adds nothing the second time**.

## Coming from version 1

Version 1 kept one flat record per tool, with the machine as a field on it — so
the same tool on two machines was two unrelated records and nothing linked them.
An existing record is converted the first time it is read: each old record
becomes a machine, a tool and the assignment between the two, which is what it
always described. Tools met twice under the same insert designation and
description collapse into one crib entry with an assignment on each machine.

The old insert designation becomes the tool's part number, indexes per insert
becomes its cutting edges, the measured average becomes the cutting time, and the
tool life in minutes per edge becomes parts per index at that measured cycle.
Where there is nothing timed there is no cycle to divide by, so the old figure is
carried into the assignment's notes rather than turned into a number nobody
measured — as is an inserts-per-op count above one. Nothing is discarded, and no
number is invented.

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

`server.js` rebuilds every field of what a client sends before it is stored,
drops any assignment whose tool or machine is gone, and holds the record to
sensible limits (60 machines, 200 tools, 200 assignments, 300 recorded cycles
each). The client owns the state on screen and autosaves it; a recorded cycle is
sent at once rather than on the debounce, because it is the one thing here that
cannot be retyped from memory.
