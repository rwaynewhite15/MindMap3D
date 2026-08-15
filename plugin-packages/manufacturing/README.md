# Shopwatch — a MindMapShare plugin

A cycle-time stopwatch for the shop floor, arranged around the **tool layout** —
one machine, one part, one operation, numbered the way the floor asks for it —
over the records the times belong to: the parts being made and their operations,
the machines, and the tool crib.

**A cycle time is only ever true of one tool, on one machine, doing one
operation.** That is the shape of the record:

- a **tool** carries what is true of it wherever it runs — its own part number,
  what it is, how many cutting edges it has, and optionally what it costs
- a **part** carries its **operations**, and an operation belongs to exactly one
  part, because that is what an op is: a step in making *that* part, not a name
  that means the same thing everywhere
- **setting a tool up** on a machine for one of those operations carries what is
  only true of that combination: which **pocket** it sits in, how many of the
  tool's edges are **indexed through** there, and how many **parts run between
  one index and the next** — along with every cycle timed against it
- and one machine and one operation together are a **tool layout**: since an op
  belongs to one part, that is machine-, part- and operation-specific, which is
  exactly what a tool layout is on the floor. It carries **a number of its
  own** — *run TL 12* — and the tools set up on it are its pockets, in the order
  they cut

So a tool runs on as many machines as it is set up on, a machine holds as many
tools, and the same tool in the same machine cutting a different operation is on
a different layout with its own times. **The screen is arranged around the tool
layout**: it is what the charts are of, what the running order is within, what
the PDF prints one of to a page, and what everything is filed under. Time enough
cycles and the record answers the questions that are actually asked at the
machine:

- how long the layout really takes, on average, at best, and how far it spreads
- how much of the measured cycle is actually cut, and how much of it is not
- how long an edge lasts in minutes of cut, at the parts it runs between indexes
- how many parts a whole tool covers, how many tools a hundred parts consumes,
  and what they cost per part
- and, across the layout's tools in the order they cut, **where the cycle
  actually goes**

**Cutting time is measured, not typed.** There is nowhere to enter what a tool
*should* spend in cut, because a number somebody typed and a number somebody
measured are two answers to one question and only one of them is evidence. The
time in cut comes from marking the tool in and out at the machine, and every
figure worked out from it says so.

## Installing

This plugin is not part of MindMapShare. It is downloaded separately and put in
the app's `plugins/` folder:

```bash
node tools/install-plugin.js manufacturing            # from a copy that ships it
node tools/install-plugin.js ~/Downloads/plugin.zip   # from a download
```

Restart the server. **Shopwatch** then appears in the **Features** library, next
to the built-in screens; add it there and it joins your toolbar. Without it
installed, nothing about the app changes.

The folder and the plugin id are still `manufacturing`: the id is the URL prefix
for its API, and it is what every saved shopwatch is filed under, so renaming it
would orphan every one already saved. Only the name on screen is Shopwatch.

It needs a host that speaks **plugin contract v2** — the version that owns
documents, sharing and the live channel on an add-on's behalf. An older host
refuses to load it and says so at startup rather than half-installing it.

To take it off again: `node tools/install-plugin.js --remove manufacturing`.
Shopwatches stay on each account and come back if it is reinstalled — as does its
place in anyone's toolbar, which is kept rather than quietly dropped.

## Using it

**Start a shopwatch.** A shopwatch is one floor: its parts and their operations,
its machines, its tool crib, and every cycle timed against them. An account keeps
as many as it needs — one per cell, one per building, one per customer, one to
try something in — and the switcher at the top of the screen moves between them.
A new one is **yours and private** until you say otherwise.

Everything below happens inside the open shopwatch. Nothing crosses from one to
another except by [saving a copy](#sharing-a-shopwatch) or by exporting a
spreadsheet out of one and importing it into another.

**Add a part**, and give it the operations that make it:

| Field | What it is |
| --- | --- |
| Part number | The part being made, not the tool: `12345-A` |
| Description | What it is: "pump housing" |
| Operation | What the traveller calls the step: `Op 20` |
| Step | Where that op falls in making the part — 1 runs first |

**Add a machine.** A name is all it is: whatever it is called on the floor.

**Add a tool.** A tool is described once, however many machines it ends up on:

| Field | What it is |
| --- | --- |
| Part number | The tool's own number — what it is ordered by: `CNMG432-MP` |
| Description | What it is: "80° CNMG rougher" |
| Cutting edges | Usable cutting edges the tool has — 4 on a CNMG insert |
| Cost | Optional — what one costs, for cost per part |

**Set it up.** This is where the tool, the machine and the operation meet, and it
is the thing the shopwatch times:

| Field | What it is |
| --- | --- |
| Tool | Which tool from the crib this is |
| Machine | Which machine it is running on |
| Operation | Which op of which part it is cutting |
| Pocket | Turret station or pocket it sits in: `T0303` |
| Seq | Where the tool falls in that layout's running order — 1 cuts first |
| Indexable edges | How many of the tool's edges get indexed through here |
| Parts per index | Parts run between one edge index and the next |

**The machine and the operation together are the tool layout**, so setting the
first tool up on a pair makes one, already numbered; every tool set up on the
same pair after that joins it. The same tool set up for a second operation gets
its own times, its own edges and its own tool life there — which is the point. A rougher that spends 38
seconds in cut on Op 20 and 12 on Op 10 of the same part is one tool with two
setups, not two tools; the same is true of the same op on a second machine.

Leaving **indexable edges** blank means every edge the tool has. Adding a part
leads straight into its first operation, adding an operation into setting a tool
up for it, and adding a machine or a tool into setting that up too — because a
part with no ops, a tool on no machine and a machine with no tools are all
records that cannot tell you anything yet.

**Number the tool layout.** A layout appears the moment the first tool is set up
on a machine for an operation, and it arrives with the next free number on it,
because a layout nobody can name cannot be asked for. **TL 4** is a button
wherever it appears — on the watch, on the layout panel, on each machine's
groups — and pressing it is where the number is changed to whatever the floor
actually calls that layout.

| Field | What it is |
| --- | --- |
| Tool layout number | What this layout is called on the floor — its own number in this shopwatch |
| Notes | Fixture, offsets, work stops: what the next person setting it should know |

**Two layouts cannot share a number**, and saying so is the whole of the
validation: a number that names two layouts names neither, so the form says
which layout already answers to it and changes nothing. The machine, the part
and the op are not fields here — they are what the layout *is*, settled by the
tools set up on it — and there is no delete either: a layout exists exactly as
long as it has tools, so taking the last one off is what ends it, and its number
goes back in the pot.

Numbers survive everything else. Cloning a machine or a part number gives the
new pairs their own next-free numbers; a spreadsheet exported and read back
brings its numbers with it; and a floor recorded before layouts existed opens
with every pair already numbered, machine by machine and, within a machine, in
the order the ops run.

**Time it.** **Start** when the tool goes in, **Cycle done** at the end of each
part. Each press records the split since the last one, so a run of parts gives a
run of cycle times without stopping the watch. **Reset** zeroes the display and
keeps every recorded cycle.

**Mark it in and out of the cut.** A cycle time is everything — rapids, the
tool change, the bar feed, and the part of it actually cutting metal. Only the
last is the **cutting time** the tool life is worked out from, and it cannot be
read off a cycle time afterwards. So it is marked as it happens: press
**◻ Mark in cut** as the tool enters the material and again as it comes out.

Press it as many times as the tool enters and leaves within one cycle — the
stretches add up. What has accumulated shows under the clock while the cycle
runs, goes onto the cycle when it is recorded, and starts again from nothing for
the next one. A **paused watch is not cutting**: time through a pause is not
counted, and a tool still in the cut when you resume carries on from where it
was.

The measured figure then appears as **time in cut**, with what share of the
cycle it is and what the rest of that cycle went on, and each recorded cycle
shows its own.

That share is worked out over the cycles that were **actually marked**, not over
every cycle timed. Averaging the time in cut over the marked cycles and the
cycle over all of them would let a mostly-unmarked op come out more than 100%
cut, which would be arithmetic rather than anything that happened at the
machine.

**Cutting time comes from what was marked**, and failing that from the whole
measured cycle — which is an overestimate. The **min / edge** tile says which of
the two it used, so a tool life worked out from a whole cycle is never mistaken
for one worked out from real time in cut.

**Time the layout tool by tool.** A tool layout is a run of tools cutting one
after another, and **Tool done →** is the press for measuring each one's share of
it:
it records the split against the tool that has just finished cutting and moves
the watch to the next tool in the running order, **without stopping**. So the
next split starts the moment the last one ends, which is what actually happens
at the spindle. Press it down the whole layout and past the last tool it comes
back to the first — down the layout is one part, and the next part starts again
at tool 1.

Nothing is recorded by the move itself, and a press that times nothing moves
nothing: with the watch stopped, or on a double tap, the tool does not change.
It only appears on a layout with more than one tool set up; on a single-tool
layout it would be **Cycle done** under a name that promises more.

A few passes down the layout and the **Tool layout** panel fills in on its own —
each tool's average, its share of the total, and where the cycle actually goes.

**Fold the watch away.** The clock is deliberately huge — it has to be read
from an arm's length at the machine — which on a phone is most of the screen
spent on a number you are not always looking at. The **▾** on the watch folds it
down to a bar: which layout and which tool, the running time, and the presses a
cycle needs — **Cut**, **Start/Stop**, **Tool done →** and **Cycle done** — with
the layout, the tools and the lists it was covering now on screen underneath it.

Folding is not stopping. The watch keeps running, the panel still goes amber
while it does, the keys still work, and the time comes back with the watch when
you open it again — a measurement in progress is never thrown away by tidying
the screen. Like the folded lists, it is remembered on that device rather than
saved to the account, so folding the watch on the phone at the machine leaves
the office screen alone.

At a laptop, <kbd>Space</kbd> starts and stops, <kbd>L</kbd> marks a cycle,
<kbd>N</kbd> is **Tool done →**, <kbd>C</kbd> marks in and out of cut, and
<kbd>R</kbd> resets. A time measured
somewhere else is typed straight in as `42.6` or `1:23.4`.

The watch keeps time from the clock rather than counting up, so a phone that
sleeps mid-cycle, a backgrounded tab and a page reload all come back reading
correctly.

**Read the numbers.** From the parts per index on the setup, and the time marked
in cut (or, until anything is marked, the measured average):

```
parts per tool     = parts per index × indexable edges
minutes per edge   = parts per index × time in cut ÷ 60
tools / 100 parts  = 100 ÷ parts per tool
cost per part      = tool cost ÷ parts per tool
```

**Put the tools in running order.** Each setup carries a **Seq** — 1 cuts first —
within its tool layout. A newly set-up tool takes the next number automatically,
so entering tools in the order they run needs no thought; the ↑ / ↓ buttons on a
card move it a place either way afterwards, and the layout renumbers itself so
the sequence is always 1..n with no gaps. The lists, the charts, the PDF and the
CSV all follow that order, and the watch says which tool of how many you are
timing.

**See where the cycle goes.** The **Tool layout** panel is one layout's whole
measured cycle — the sum of every tool's average — with a stacked bar underneath
dividing it between the tools in the order they cut. Each segment
is one tool, sized by its share; the table below the bar names them, gives each
average and its percentage, and doubles as the legend. Hovering (or tabbing to)
either the bar or a row lights up the other, so a two-percent segment is still
reachable.

The segment fills come from a single cyan ramp stepped light→dark along the
running order, so the order is legible in the color itself rather than needing
eight unrelated hues. The ramp is checked against the dark chart surface for
monotone lightness, a visible gap between adjacent steps, one hue, and a darkest
step that still clears the surface.

A tool with nothing timed against it yet cannot contribute to the total, so it is
listed as **not timed** and a line under the chart says how many of the layout's
tools are in that state — the total is what has been measured, not the whole
layout. A layout with only one timed tool gets the figure without a bar; one
segment is not a part-to-whole story.

**See what is not cutting.** The **Tool layout** panel says which tool owns the
cycle. The **In cut, and the waste** panel under it answers the other question,
which is usually the more useful one: how much of each tool's cycle is making
chips.

It is one column per tool of the layout, side by side. A column is that tool's
measured cycle, drawn to a scale shared across the layout, and only the part of
it marked in the cut is filled in — so **the empty top of each column is the
waste**: the rapids, the tool change, the bar feed. The tool with the most air
above its fill is the one worth attacking, and because every column is on the
same scale, that comparison is a glance rather than a calculation. The figure
above the plot is the layout's own share, over the tools that were marked.

The fill is the app's in-cut hue and the unfilled part is a dark step of that
same hue, so cut and not-cut read as one measure rather than two subjects; the
pair is checked against the panel it is drawn on for monotone lightness, a
visible gap between the steps, one hue, and a dark step that still clears the
surface. Between the two is a 2px gap in the panel colour rather than a border —
white space is what separates the fills, the same as on the layout's cycle bar.

The most and least cut columns are labelled on the axis; every other number is
in the table under the plot, which gives each tool its time in cut, what was
wasted and its percentage, and doubles as the accessible twin of the plot.
Hovering or tabbing to either a column or a row lights up the other.

**A tool nobody marked in cut is not drawn as a column of waste** — that would be
a measurement nobody took. It is drawn as an outline with nothing in it, listed
as **not marked**, and counted in a line under the chart.

**Read it from three ends.** **Parts and operations** lists each part with its
ops, and each op with the tool layouts it runs as — *TL 3 Haas ST-20, TL 7
Doosan* — how many tools are set up for it and what they measure. **Machines**
lists each machine with its tool layouts, each under its number, and the tools of
each in the order they cut. **Tools** lists the crib, each tool with the layouts
it is on as chips — click one to point the watch at that tool, on that layout.
One filter box narrows all three, and it knows the numbers: typing **TL 12**, or
just **12**, is a way of asking for everything on that layout.

**Fold away what you are not looking at.** Every heading opens and closes what is
under it — each of the three lists, and each part and each machine inside them —
as does the stopwatch. A closed heading still carries what it holds (a machine's
tool count and measured cycle, a part's ops) and keeps its **+** button, so a
shop with forty tools and a dozen machines can be read one block at a time, which
is the difference between usable and not on a phone at the machine. What is
folded is remembered on that device — it is a view preference, not part of the
shop record, so it is not saved to the account and never reaches anyone else. **A
filter outranks a fold**: searching opens everything, because a screen that hid
the answer it was just asked for would be worse than useless. The watch is the
one exception, since a running stopwatch is never the answer to a search.

Deleting a machine takes its setups and leaves the tools in the crib; deleting a
tool takes it out of every setup it was in; deleting an operation takes the
setups that were for it, because the cycles timed belong to the op. All of them
say exactly what will go before they do it.

**Clone a machine** when a second one of the same kind arrives. **Clone** on a
machine opens a new machine already carrying its number's successor — `MC-101`
suggests `MC-102`, `Lathe 3` suggests `Lathe 4`, and a name ending in anything
else gets a number put on the end — and saving copies **the tools** across, in the
stations they sit in. The suggested number is only a suggestion; type over it
before saving if the machine is called something else.

By default it copies the tooling and nothing else, because nothing else is a fact
about the machine. A tool that cuts three operations on the original comes across
once, as one tool in one station; **which operations the new machine runs is its
own business**, and the indexable edges and the parts between indexes are both
facts about the op being cut. The clone therefore lists its tools under **No
operation set** until each is put on one — which is a setup like any other, and
the point at which it becomes something the watch can time.

**Bring the operations too** — the tick box on the clone form — when the second
machine is standing in for the first and running the same work. Each setup then
arrives whole: the same tool, in the same station, on the same operation, with
the indexable edges and tool life worked out for it, and the op ends up listing
both machines. That is a claim about the new machine — that it cuts the same op
the same way — so it is asked for rather than assumed, and
the form says which of the two it is about to do before you save.

The **recorded cycles** stay with the original either way: a cycle time is a
measurement taken on one machine, and carrying it onto another would be inventing
data about a machine nobody has stood in front of.

**Clone a part number** when a revision comes through, or a second number is made
the same way. **Clone** on a part opens a new part number already carrying its
successor — a revision letter takes the next letter, so `12345-A` suggests
`12345-B` and `778-C` suggests `778-D`; a number ending in digits takes the next
number the way a machine does; anything else gets a number put on the end. As
with a machine, the suggestion is only a suggestion.

Saving copies **the whole route**: every operation of the part, and every setup on
each of them — the same tools, on the same machines, in the same stations, with
the indexable edges and the parts between indexes worked out for them. So `12345-B` arrives running Op 10 and Op 20 on the same machines with
the same tooling, and the work left is whatever is actually different about it.

Unlike a cloned machine, none of that is optional, because the two cases are not
alike. Which operations a machine runs is a decision about the machine — so it is
asked. The operations that make a part *are* the part; a part number cloned
without them would be a new part number and nothing else, which **+ Part**
already does.

The **recorded cycles** stay with the original here too: they were measured making
that part, on parts that were actually cut, and a number nobody has run yet has
nothing to show. So the clone reads as ops and tools with no measured time
against them, which is exactly what it is until somebody stands at the machine.

## The tool layout, on paper

A shop runs off a **tool layout sheet**: one page, one layout, every pocket on it
and what goes in each. **🖨 PDF** is that sheet, made out of what the shopwatch
already knows — so it carries the measured cycle and the time in cut alongside
the tooling, which a typed-up sheet never does.

**One tool layout per page**, in number order, laid out the way the screen lays
one out:

- the **number** and the whole address — the machine, the part, the op — across
  the top, with the layout's measured cycle beside them
- **the cycle, tool by tool**: the stacked bar dividing that cycle between the
  tools in the order they cut, on the same light→dark ramp the screen uses, with
  the table under it naming each one and giving its average and its share
- **in cut, and the waste**: the same tools as columns, each the tool's measured
  cycle with only the marked-in-cut part filled in, every column on one scale
- **the tools, in the order they cut**: a row per **pocket** — the tool in it,
  its own part number, cycles timed, average, time in cut and what share that is,
  indexable edges, parts per index, parts per tool and minutes per edge — with
  whatever was written about that setup underneath its row
- and the **notes** on the layout, the op, the part and the machine at the foot

The 🖨 PDF on the top bar prints **every** layout in the shopwatch; the **PDF**
on the Tool layout panel prints the one you are looking at. Both open a
print-ready page and hand it to the browser, where *Save as PDF* is one of the
choices in the print dialog and a printer is the other — the same page goes
straight onto paper for the machine. Nothing is uploaded and no library is
fetched; it is the browser's own printing, so it works offline and the file never
leaves the device.

A tool that is on a machine but on no operation is on no layout, so it is on no
page — and rather than leave it quietly out of a sheet somebody is about to work
from, the message that opens the print dialog says how many are in that state.

Reading a shopwatch and printing it are the same permission, so **a read-only
shopwatch gets the PDF too**: send somebody a link and they can print the layouts
without being able to change a number in them.

*(Pockets are the spine of that table, which is where the tool holder and the
insert in each one will hang as those become records of their own.)*

## Sharing a shopwatch

A cycle time is worth more to the people who did not take it. **Share** on the
doc bar is where a shopwatch stops being only yours, and it asks two separate
questions, because they have different answers.

**Who can open it** — one of three:

| | |
| --- | --- |
| **Private** | Only you, and anyone you invite to edit. This is where every shopwatch starts. |
| **Friends** | The people you are friends with in the app can open it, and it appears in their feed. |
| **Everyone** | Anyone with the link can open it, and it can be found in Discover. |

**Who can change it** — a list of usernames, and it is a separate question
because it *overrides* the tier: an invited editor can open a **private**
shopwatch, time cycles in it and talk in it. That is how you hand the job to the
person setting it, without publishing the shop to anybody else. Up to 20 people
per shopwatch.

Everyone else who can open it gets it **read only**: the doc bar says so, and the
screen simply never writes — no half-saved edit, no error after the fact. What
they *can* do is **Save a copy**, which takes the whole record into a private
shopwatch of their own, to change without touching yours.

**Work in it together.** Two people with the same shopwatch open see each other's
edits as they happen — a cycle timed at the machine appears on the office screen
without a reload, and the doc bar says how many people are in here. This is the
same live channel the mind maps use. A time being typed in is never overwritten
by someone else's save mid-keystroke: the incoming version is held until yours
has gone.

**Say something about it.** 💬 opens the shopwatch's chat. Everyone who can open
the shopwatch reads it; everyone who can change it can post. Edits post
themselves into it — *timed 80° CNMG rougher at 00:33.3 on HAAS ST-20* — so the
chat doubles as the log of what happened to the floor, and a question asked in it
reaches whoever is in there without leaving the screen. The last 400 messages are
kept.

**In the feed.** A friends-or-everyone shopwatch gets a card in the feed of the
people who can see it, saying what is in it — *3 parts · 3 machines · 3 tools ·
12 cycles timed* — and opening the card opens the shopwatch. Making one public,
being invited to edit one, and a cycle being timed in one you are in all send the
usual notification.

**Copy link** hands you the shopwatch's address. It is not a magic link: whoever
opens it still has to be allowed to see it, so sending a private shopwatch's link
to somebody shows them nothing until you invite them.

**A link to an *Everyone* shopwatch needs no account at all.** Send it to a
customer, an auditor, a machine builder — anyone — and it opens for them signed
out: the parts and their operations, the machines, the tool crib, the tool
layouts and their charts, and every cycle recorded, exactly as you see them. It
is genuinely read only, and not by disabling things — the stopwatch itself, the
setup forms, the layout numbering, the add and delete controls and the reorder
arrows are simply not drawn, so nothing on the screen looks live and does
nothing. The clock goes with them: one that can never move is as dead as a
button that does nothing, so a reader gets the layout named and the numbers under
it instead. What they do get besides the floor is **⤓ Export** and **🖨 PDF** —
reading a floor, downloading it and printing it are the same permission — and a
way to sign in and start one of their own.

Friends-only and private shopwatches stay shut to signed-out visitors, and no
part of the add-on other than that one address opens without an account — not
the list of shopwatches, not the chat, not the live channel. Remember what
*Everyone* means in full, though: **anyone with the link, and discoverable** —
it also puts a card in Discover. Use *Friends* or an invited editor for a floor
that should reach particular people and nobody else.

**Delete shopwatch** takes it and everything in it, and says how many cycles that
is before it does. Anyone you shared it with loses it too.

### Moving a floor into another shopwatch

**Duplicate**, on the doc bar, stands a second shopwatch up beside the open one
holding everything it holds — the parts and their operations, the machines, the
tool crib and every cycle timed. It is private to you whatever the original was,
and the two are separate from that moment: changing one leaves the other alone.
Useful for a second bay set up like the first, a what-if you do not want in the
real record, or a copy to hand to somebody.

On a shopwatch somebody else shared with you, the same button reads **Save a
copy** — the same move, and the only way to work in a floor you can open but not
change.

To bring a floor into a shopwatch that already has one, go through a
spreadsheet instead: **⤓ Export** the first, open the second, **⤒ Import** the
file. That merges rather than replaces — the preview says what is new before
anything happens, and matching records are filled in rather than duplicated.

## Spreadsheets, in and out

**⤓ Export** downloads every recorded cycle, one row each, carrying the tool
layout it was measured on and the part, the operation, the machine, the tool and
the setup that make up that layout — in layout order, and within a layout in the
order the tools cut. A part with no operations, an operation nothing is set up
for, a tool in the crib and an idle machine each get a row of their own, so the
file is the whole record rather than only the parts that have been timed.

**⤒ Import** reads one back, into the open shopwatch — or, with none open, into a
new one named after the file. It is the same shape the export writes, so a file
that came out of here goes back in unchanged — and a tool list somebody already
keeps in a spreadsheet can be brought in by putting these headers on it:

```
tool_layout, machine, machine_notes, part, part_description, part_notes,
op, op_notes, seq, station, tool_part_number, tool_description, cutting_edges,
tool_cost, tool_notes, indexable_edges, parts_per_index, notes,
cycle_seconds, cycle_cut_seconds, recorded_at
```

Columns are read **by name, not by position** — reorder them, leave out the ones
that do not apply, or use a common alternative (`tl`, `layout`, `machine name`,
`part number`, `operation`, `turret`, `pocket`, `tool no`, `description`,
`edges`, `cut time`, `parts between indexes`, `seconds`, `date`) and it still
reads. A row makes
whatever it names: a part, an operation of it, a machine, a tool, the setup
joining them, and a cycle timed against it. A file needs at least one column
naming a part, a machine or a tool. Each record that can carry notes has its own
notes column, so a machine's notes and a setup's never overwrite one another;
plain `notes` is the setup's. An op named with no part gathers under one part
called **Unassigned** rather than each row inventing one. The three worked-out
columns the export adds — cycles timed, average, parts per tool — are ignored on
the way in: they come from the cycles, and a stale figure in a spreadsheet should
not be able to contradict the times it was supposed to summarize.

**Older files still read.** From version 1: `insert` is taken as the tool's part
number, `indexes_per_insert` as its cutting edges, and a tool life given in
cutting minutes per edge is turned into parts between indexes at the cycles in
the file itself, which is the same division version 1 did on screen. A life with
no cycles to divide by is left out rather than guessed at, and the preview says
how many.

Quoted fields, commas and newlines inside them, semicolon-separated files from
non-English spreadsheets, comma decimals (`10,5`) and Excel's byte-order mark all
read as you would expect.

**An import never deletes anything.** Choosing a file shows what it would do —
how many parts, operations, machines, tools and setups are new, how many are
already there, how many cycles would be added — and nothing happens until you say
Import. A part is matched by number, an operation by its name within that part, a
machine by name, a tool by its part number and description, and a setup by the
machine, tool and operation it joins plus the pocket it sits in; each gains any
field the file fills in and keeps everything it leaves blank. **`tool_layout`**
belongs to the machine-and-op pair a row names rather than to any one record, and
is taken where it is free — so a file exported from here goes back in with its
layouts still called what they were called, while a number another layout already
answers to is left alone rather than taken off it. Cycles are
recognized by when they were recorded and how long they took, so **importing the
same file twice adds nothing the second time**.

## Coming from an earlier version

Records are converted the first time they are read, in steps that each undo one
shape the record used to have. Nothing is discarded and no number is invented.

**Version 1** kept one flat record per tool, with the machine as a field on it —
so the same tool on two machines was two unrelated records and nothing linked
them. Each old record becomes a machine, a tool and the setup between the two;
tools met twice under the same insert designation and description collapse into
one crib entry with a setup on each machine. The insert designation becomes the
tool's part number, indexes per insert its cutting edges, and the tool life in
minutes per edge becomes parts per index at that measured cycle. Where nothing was timed there is no cycle to divide by,
so the old figure is carried into the setup's notes rather than turned into a
number nobody measured — as is an inserts-per-op count above one.

**Version 2** kept the part and the op as text on that link, repeated on every
tool of the job. They become records: a part, and the operations belonging to it,
with each setup naming the operation it is for. A setup that named neither gets
no operation rather than an invented one, and says so on screen until one is
chosen; an op named with no part gathers under a part called **Unassigned**.

**Version 3** kept a cutting time typed onto the setup beside the one measured at
the machine. Two answers to one question, only one of them evidence: the typed
one goes into that setup's notes rather than being thrown away, and the measured
one stands alone.

**Version 4** had no tool layouts, because the machine-and-operation pair was
only ever implied by the setups on it. Every pair with a tool on it becomes a
numbered layout — machine by machine, and within a machine in the order the ops
run, which is the order somebody numbering them by hand would have used. Nothing
about the floor changes: the same pairs were already what the charts and the
running order were per, and they now have a name to be asked for by. The numbers
are yours to change from that point on.

## The record, as a relational schema

The record is stored as one JSON document per shopwatch (see below), but it is
relational in shape and worth reading that way. Seven entities inside the
shopwatch, and one junction doing most of the work:

```mermaid
erDiagram
    ACCOUNT     ||--o{ SHOPWATCH   : owns
    ACCOUNT     }o--o{ SHOPWATCH   : "may edit"
    SHOPWATCH   ||--o{ MACHINE     : holds
    SHOPWATCH   ||--o{ TOOL        : holds
    SHOPWATCH   ||--o{ PART        : holds
    PART        ||--o{ OPERATION   : "is made by"
    OPERATION   |o--o{ SETUP       : "is cut by"
    MACHINE     ||--o{ SETUP       : "holds"
    TOOL        ||--o{ SETUP       : "is used in"
    SETUP       ||--o{ CYCLE       : "was timed as"
    MACHINE     ||--o{ TOOL_LAYOUT : "is set up as"
    OPERATION   ||--o{ TOOL_LAYOUT : "is cut as"
    TOOL_LAYOUT ||--o{ SETUP       : "is made of"
```

```sql
CREATE TABLE shopwatch (            -- one floor, and who may see it
  id          text PRIMARY KEY,
  owner_id    text NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  title       text NOT NULL CHECK (length(title) <= 80),
  visibility  text NOT NULL DEFAULT 'private'
              CHECK (visibility IN ('private', 'friends', 'public')),
  created_at  timestamptz NOT NULL,
  updated_at  timestamptz NOT NULL
);
CREATE INDEX ON shopwatch (owner_id, updated_at DESC);
CREATE INDEX ON shopwatch (visibility, updated_at DESC);   -- the feed

CREATE TABLE shopwatch_editor (     -- invited to change it, whatever the tier
  shopwatch_id text NOT NULL REFERENCES shopwatch(id) ON DELETE CASCADE,
  account_id   text NOT NULL REFERENCES account(id)   ON DELETE CASCADE,
  PRIMARY KEY (shopwatch_id, account_id)
);

CREATE TABLE shopwatch_message (    -- the chat, and what was done to the floor
  id           text PRIMARY KEY,
  shopwatch_id text NOT NULL REFERENCES shopwatch(id) ON DELETE CASCADE,
  account_id   text     NULL REFERENCES account(id)   ON DELETE SET NULL,
  body         text NOT NULL CHECK (length(body) <= 400),
  kind         text NOT NULL DEFAULT 'said' CHECK (kind IN ('said', 'did')),
  at           timestamptz NOT NULL
);
CREATE INDEX ON shopwatch_message (shopwatch_id, at DESC);

CREATE TABLE machine (              -- what is on the floor
  id           text PRIMARY KEY,
  shopwatch_id text NOT NULL REFERENCES shopwatch(id) ON DELETE CASCADE,
  name         text NOT NULL CHECK (length(name) <= 60),
  notes        text NOT NULL DEFAULT '' CHECK (length(notes) <= 400),
  created_at   timestamptz NOT NULL,
  updated_at   timestamptz NOT NULL
);
CREATE UNIQUE INDEX ON machine (shopwatch_id, lower(name));

CREATE TABLE tool (                 -- the crib: true wherever the tool runs
  id            text PRIMARY KEY,
  shopwatch_id  text NOT NULL REFERENCES shopwatch(id) ON DELETE CASCADE,
  part_number   text NOT NULL DEFAULT '' CHECK (length(part_number) <= 60),
  description   text NOT NULL DEFAULT '' CHECK (length(description) <= 80),
  cutting_edges int  NOT NULL DEFAULT 0 CHECK (cutting_edges BETWEEN 0 AND 64),
  cost          numeric NOT NULL DEFAULT 0 CHECK (cost BETWEEN 0 AND 100000),
  notes         text NOT NULL DEFAULT '',
  created_at    timestamptz NOT NULL,
  updated_at    timestamptz NOT NULL,
  CHECK (part_number <> '' OR description <> '')   -- something to know it by
);

CREATE TABLE part (                 -- what is being made
  id           text PRIMARY KEY,
  shopwatch_id text NOT NULL REFERENCES shopwatch(id) ON DELETE CASCADE,
  number       text NOT NULL DEFAULT '' CHECK (length(number) <= 60),
  description  text NOT NULL DEFAULT '' CHECK (length(description) <= 80),
  notes        text NOT NULL DEFAULT '',
  created_at   timestamptz NOT NULL,
  updated_at   timestamptz NOT NULL,
  CHECK (number <> '' OR description <> '')
);
CREATE UNIQUE INDEX ON part (shopwatch_id, lower(number)) WHERE number <> '';

CREATE TABLE operation (            -- a step in making one part
  id         text PRIMARY KEY,
  part_id    text NOT NULL REFERENCES part(id) ON DELETE CASCADE,
  name       text NOT NULL CHECK (length(name) <= 40),
  seq        int  NOT NULL DEFAULT 0 CHECK (seq BETWEEN 0 AND 999),
  notes      text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE UNIQUE INDEX ON operation (part_id, lower(name));

CREATE TABLE setup (                -- one tool, on one machine, doing one op
  id              text PRIMARY KEY,
  tool_id         text NOT NULL REFERENCES tool(id)      ON DELETE CASCADE,
  machine_id      text NOT NULL REFERENCES machine(id)   ON DELETE CASCADE,
  operation_id    text     NULL REFERENCES operation(id) ON DELETE SET NULL,
  station         text NOT NULL DEFAULT '' CHECK (length(station) <= 20),
  seq             int  NOT NULL DEFAULT 0 CHECK (seq BETWEEN 0 AND 999),
  index_edges     int  NOT NULL DEFAULT 0 CHECK (index_edges BETWEEN 0 AND 64),
  parts_per_index int  NOT NULL DEFAULT 0 CHECK (parts_per_index BETWEEN 0 AND 100000),
  notes           text NOT NULL DEFAULT '',
  created_at      timestamptz NOT NULL,
  updated_at      timestamptz NOT NULL
);
CREATE INDEX ON setup (machine_id, operation_id, seq);   -- the running order

CREATE TABLE tool_layout (          -- one machine cutting one operation
  id           text PRIMARY KEY,
  shopwatch_id text NOT NULL REFERENCES shopwatch(id)  ON DELETE CASCADE,
  machine_id   text NOT NULL REFERENCES machine(id)    ON DELETE CASCADE,
  operation_id text NOT NULL REFERENCES operation(id)  ON DELETE CASCADE,
  number       int  NOT NULL CHECK (number BETWEEN 1 AND 9999),
  notes        text NOT NULL DEFAULT '' CHECK (length(notes) <= 400),
  created_at   timestamptz NOT NULL,
  updated_at   timestamptz NOT NULL
);
-- one layout per pair, and a number that names exactly one layout
CREATE UNIQUE INDEX ON tool_layout (machine_id, operation_id);
CREATE UNIQUE INDEX ON tool_layout (shopwatch_id, number);

CREATE TABLE cycle (                -- one part, timed
  id       text PRIMARY KEY,
  setup_id text NOT NULL REFERENCES setup(id) ON DELETE CASCADE,
  sec      numeric NOT NULL CHECK (sec > 0 AND sec <= 86400),
  at       timestamptz NOT NULL,
  note     text NOT NULL DEFAULT '' CHECK (length(note) <= 80)
);
CREATE INDEX ON cycle (setup_id, at DESC);

CREATE TABLE shop (                 -- one row per shopwatch: what the watch is on
  shopwatch_id    text PRIMARY KEY REFERENCES shopwatch(id) ON DELETE CASCADE,
  active_setup_id text NULL REFERENCES setup(id) ON DELETE SET NULL,
  version         int NOT NULL,
  updated_at      timestamptz NOT NULL
);
```

**`tool_layout` is the pair `setup` keeps implying.** `(machine_id,
operation_id)` is already what the running order is numbered within, what both
charts are of and what a PDF page is — so the only thing a layout table adds is
the one fact about that pair which is a decision rather than a reading: its
`number`. Everything else about a layout is an aggregate over the setups that
name the same pair, which is why there is no `cycle_time` or `tool_count` on it.
Its two unique indexes are the whole of its integrity: one layout per pair, and
one layout per number.

The pair is derived, so the layout is too: a pair with no setups left is not a
layout, and its row goes — freeing its number — while a pair that gains its first
setup gets a row with the next free number. Both directions are enforced on every
write rather than left to the client, so a record that arrives without layouts
(anything written before version 5) comes back with them.

**`setup` is the whole point.** Tools and machines are many-to-many, and so are
tools and operations, and machines and operations; all three relations are the
same junction read from a different side. It is a *ternary* junction with
attributes: `index_edges` and `parts_per_index` are true of that combination and
of nothing narrower, which is why a tool cutting two operations in the same
machine is two rows with two tool lives. `cycle` hangs off
`setup` for the same reason — a measurement belongs to the exact combination it
was measured on.

`operation_id` is the one nullable foreign key: a tool can be in a machine before
anybody has said what it is cutting, and a cloned machine arrives in exactly that
state. Nothing derived is stored — averages, spread, parts per tool, minutes per
edge, tools per hundred and cost per part are all computed from these columns, so
no stale figure can contradict the cycles it came from.

Natural keys, used to match records when a spreadsheet is imported: machine by
`lower(name)`; tool by `(lower(part_number), lower(description))`; part by
`lower(number)`; operation by `(part_id, lower(name))`; setup by
`(machine_id, tool_id, operation_id, lower(station))`; tool layout by
`(machine_id, operation_id)` — never by its number, which is a name rather than
an identity and is taken from a file only where it is free; cycle by
`(setup_id, at, sec)`, which is what makes importing the same file twice a no-op.

**`shopwatch` is the sharing boundary.** Everything on the floor hangs off one
row of it, which is what makes a shopwatch shareable as a unit: `visibility`
answers who may open it, `shopwatch_editor` answers who may change it, and the
second overrides the first — an editor row lets somebody into a private
shopwatch, which is the point of having two questions. Nothing below `shopwatch`
carries a permission of its own, so there is no way for a machine or a cycle to
end up visible to somebody the shopwatch is not.

Row caps, enforced on every write: 40 shopwatches per account, 20 editors and 400
messages per shopwatch, and within one shopwatch 60 machines, 200 tools, 120
parts, 300 operations, 200 setups, 200 tool layouts, 300 cycles per setup.

## What it stores, and where

Every shopwatch is saved on the account that made it, in the same database as the
rest of the app. A shopwatch is **private until its owner shares it**, and what
sharing does is exactly what the Share panel says: a friends or public tier lets
those people open it and puts a card in their feed, and an invited editor can
open and change it whatever the tier is. Nothing is sent outside the app either
way. Shopwatches are included in **Settings → Export my data**, and they are
deleted with the account — including for the people they were shared with.

## How it is put together

```
plugin.json          the manifest the app reads at startup
server.js            what an empty floor is, and what a stored one may contain
                     (no routes — the host serves every document itself)
public/client.js     the Shopwatch screen, and the mark in its top left corner
public/client.css    its styles, scoped under .mf-root
```

The mark is a stopwatch whose hand is a cutting insert — the two things the
screen is about, in one shape — drawn as an inline SVG in `client.js` rather than
shipped as a file: nothing to fetch, nothing to keep a second copy of at another
size, and it takes the palette with it, since the mark is `currentColor` and the
pivot is punched out in the page colour. The name beside it splits the way the
app's own does, **Shop**·*watch*.

Sharing is not implemented here. `server.js` exports a `docs` contract — an empty
record, a `sanitize` that rebuilds one, and a one-line `summary` for the feed —
and the host owns the envelope around it: who a shopwatch belongs to, who may
open it, who may change it, its live channel, its chat and its feed card. So this
add-on has no permission code of its own to get wrong, and the routes under
`/api/plugins/manufacturing/docs/...` are the host's, the same ones any add-on
gets.

**It mounts no routes of its own at all.** `server.js` returns `docs` and nothing
else — no `handle` — so `/api/plugins/manufacturing/…` answers 404 for anything
that is not a document route. Every floor lives in a shopwatch, and the private
per-account store this add-on used before shopwatches existed is neither read
nor written.

`sanitize` rebuilds every field of what a client sends before it is stored, drops
any operation whose part is gone, any setup whose tool or machine is gone and any
tool layout whose pair is gone or has no tools left on it, numbers every pair that
has tools and none, gives a duplicated number away to the first layout claiming
it, and holds the record to sensible limits (120 parts, 300 operations, 60
machines, 200 tools, 200 setups, 200 tool layouts, 300 recorded cycles each) — the same guard whether the record
came from its owner or from somebody they invited. The client owns the state on
screen and autosaves it; a recorded cycle is sent at once rather than on the
debounce, because it is the one thing here that cannot be retyped from memory. A
save is skipped entirely on a screen that may only read.
