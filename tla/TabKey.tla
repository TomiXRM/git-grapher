---- MODULE TabKey ----
\* The graph owns ggit.tab.<tab>; the detached detail owns ggit.file.<tab>. Both records contain a file (or null),
\* its target, n, and at. Graph selection, drawer clicks, and Back all write the tab key; no action clears both keys.
\* lib/tabkey.js chooses matching repo/sha/machine, then greatest n, then greatest at; an exact tie keeps the tab key.
\* Each writer computes nextN from its own shared() view. Sync is a host assumption, not an established guarantee.
\* One graph and one detail, one tab, two commits and two paths. Start with commit a and its x diff open.
\* MaxWrites bounds further user writes; renders and deliveries remain enabled at the bound. Tests use three writes,
\* five for commit revisits, and two for foreign-target seeds. Passing checks describe these bounded executions.
\* Separate short runs seed a file from another repo or machine, after a stale detail click, to exercise target filtering.
\* Loads are abstracted to the commit whose interactive list is ready. File tokens retain that origin for assertions.
EXTENDS Naturals

CONSTANTS Sync, Clock, Seed, MaxWrites
\* Sync: "atomic" reads the store immediately; "replica" reads a local view with delayed delivery of the other key.
\* Clock: "ordered" gives each action a greater timestamp; "equal" permits all writes in the same millisecond.
\* Seed: "empty", "repo", or "machine" selects an empty file key or one naming a different target.
\* Own writes are visible immediately; delivery copies the latest store value and can skip intermediate writes.
\* Host reordering, restarts, additional writers, wall-clock rollback, and props-only detail previews are outside this model.

None == "none"
Shas == {"a", "b"}
Paths == {"x", "y"}
Max(a, b) == IF a > b THEN a ELSE b
Target(s) == [repo |-> "repo", sha |-> s, machine |-> "local"]
File(s, p) == [repo |-> "repo", sha |-> s, machine |-> "local", path |-> p]
NoFile == File(None, None)
Record(s, f, n, at) == [repo |-> "repo", sha |-> s, machine |-> "local", file |-> f, n |-> n, at |-> at]
Empty == Record(None, NoFile, 0, 0)
SeedStamp == IF Clock = "ordered" THEN 1 ELSE 0
SeedFile == CASE Seed = "empty" -> Empty
             [] Seed = "repo" -> [Record("a", [File("a", "y") EXCEPT !.repo = "other"], 2, SeedStamp) EXCEPT !.repo = "other"]
             [] Seed = "machine" -> [Record("a", [File("a", "y") EXCEPT !.machine = "remote"], 2, SeedStamp) EXCEPT !.machine = "remote"]
Fits(k, s) == k.repo = s.repo /\ k.sha = s.sha /\ k.machine = s.machine
Newer(a, b) == a.n > b.n \/ (a.n = b.n /\ a.at >= b.at)
Pick(t, f, s) == IF Fits(t, s) /\ (~Fits(f, s) \/ Newer(t, f)) THEN t
                 ELSE IF Fits(f, s) THEN f ELSE Empty
FileFor(t, f, s) == Pick(t, f, s).file
NextN(t, f) == Max(t.n, f.n) + 1

VARIABLES
  sel, gdv, ddv, dpicked,  \* selected commit, drawer list, detached list and its last rendered file highlight
  tab, file,              \* store values; also the graph's own tab view and the detail's own file view
  gfile, dtab,             \* each writer's view of the other key
  step,                   \* bound and logical user-action order, independent of n and at
  intent, kind            \* latest user action for each commit, used only by assertions

vars == <<sel, gdv, ddv, dpicked, tab, file, gfile, dtab, step, intent, kind>>
Stamp == IF Clock = "ordered" THEN step + 2 ELSE 0
Open == IF sel = None THEN NoFile ELSE FileFor(tab, gfile, Target(sel))
Quiet == gfile = file /\ dtab = tab

Init == /\ sel = "a" /\ gdv = "a" /\ ddv = "a" /\ dpicked = TRUE
        /\ tab = Record("a", File("a", "x"), 1, 0) /\ file = SeedFile
        /\ gfile = file /\ dtab = tab /\ step = 0
        /\ intent = [s \in Shas |-> IF s = "a" THEN File("a", "x") ELSE NoFile]
        /\ kind = [s \in Shas |-> "initial"]

GWrite(s, f, why) ==
  /\ step < MaxWrites
  /\ LET n == NextN(tab, gfile)
         k == Record(s, f, n, Stamp)
     IN /\ tab' = k
        /\ IF Sync = "atomic" THEN dtab' = k ELSE UNCHANGED dtab
  /\ step' = step + 1
  /\ IF s = None THEN UNCHANGED <<intent, kind>>
     ELSE /\ intent' = [intent EXCEPT ![s] = f] /\ kind' = [kind EXCEPT ![s] = why]
  /\ UNCHANGED <<file, gfile>>

DWrite(f, why) ==
  /\ step < MaxWrites /\ ddv /= None
  /\ LET n == NextN(dtab, file)
         k == Record(ddv, f, n, Stamp)
     IN /\ file' = k
        /\ IF Sync = "atomic" THEN gfile' = k ELSE UNCHANGED gfile
  /\ step' = step + 1
  /\ intent' = [intent EXCEPT ![ddv] = f] /\ kind' = [kind EXCEPT ![ddv] = why]
  /\ UNCHANGED <<tab, dtab>>

\* selectNow calls write(null), raising n even when revisiting a previously selected commit.
GraphSelect(s) == s /= sel /\ sel' = s /\ GWrite(s, NoFile, "select") /\ UNCHANGED <<gdv, ddv, dpicked>>
\* The closing drawer retains the last list; its onFile guard still rejects clicks without a matching selection.
GraphRender == sel /= None /\ gdv /= sel /\ gdv' = sel
               /\ UNCHANGED <<sel, ddv, dpicked, tab, file, gfile, dtab, step, intent, kind>>
DrawerClick(p) == sel /= None /\ gdv = sel /\ GWrite(sel, File(gdv, p), "file")
                  /\ UNCHANGED <<sel, gdv, ddv, dpicked>>
\* The graph's Back button and Esc write null to the tab key, leaving the detail's file key intact.
GraphBack == Open /= NoFile /\ GWrite(sel, NoFile, "back") /\ UNCHANGED <<sel, gdv, ddv, dpicked>>
\* target() follows the tab key visible to the detail; render/load may lag the graph selection.
DetailRender ==
  LET picked == dtab.sha /= None /\ FileFor(dtab, file, Target(dtab.sha)) /= NoFile
  IN /\ (ddv /= dtab.sha \/ dpicked /= picked)
     /\ ddv' = dtab.sha /\ dpicked' = picked
     /\ UNCHANGED <<sel, gdv, tab, file, gfile, dtab, step, intent, kind>>
\* onFile uses the loaded list's target, but reads both local keys again to compute nextN.
DetailClick(p) == DWrite(File(ddv, p), "file") /\ UNCHANGED <<sel, gdv, ddv, dpicked>>
\* Esc uses the last rendered picked state, then the same onFile(null) callback as a file click.
DetailEsc == ddv /= None /\ dpicked /\ DWrite(NoFile, "detail-back")
             /\ UNCHANGED <<sel, gdv, ddv, dpicked>>

DeliverG == Sync = "replica" /\ gfile /= file /\ gfile' = file
            /\ UNCHANGED <<sel, gdv, ddv, dpicked, tab, file, dtab, step, intent, kind>>
DeliverD == Sync = "replica" /\ dtab /= tab /\ dtab' = tab
            /\ UNCHANGED <<sel, gdv, ddv, dpicked, tab, file, gfile, step, intent, kind>>

Next == \/ \E s \in Shas \cup {None} : GraphSelect(s)
        \/ GraphRender \/ (\E p \in Paths : DrawerClick(p)) \/ GraphBack
        \/ DetailRender \/ (\E p \in Paths : DetailClick(p)) \/ DetailEsc
        \/ DeliverG \/ DeliverD

\* A file token remembers where the clicked row came from; matching the record tag alone would miss a bad writer.
DiffMatchesCommit == Open = NoFile \/ Fits(Open, Target(sel))
ShaFollowsGraph == tab.sha = sel
\* Quiet means all deliveries are complete, not that renders ran or that a fairness assumption forced delivery.
\* Once all shared-state deliveries finish, the displayed file agrees with the actual latest user action for this commit.
LatestActionWins == Quiet /\ sel /= None => Open = intent[sel]
BackCloses == Quiet /\ sel /= None /\ kind[sel] = "back" => Open = NoFile
SelectionClears == Quiet /\ sel /= None /\ kind[sel] = "select" => Open = NoFile
DetailEscCloses == Quiet /\ sel /= None /\ kind[sel] = "detail-back" => Open = NoFile
\* With equal counters, a strictly later timestamp must win; equal timestamps instead retain the tab key.
TimestampOrdersCollision == Quiet /\ sel /= None /\ file.sha = sel /\ tab.n = file.n => Open = intent[sel]
\* A lagging writer can allocate the same counter as the other key, even if its wall-clock timestamp is later.
NoCounterCollision == tab.n /= file.n
====
