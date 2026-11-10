---- MODULE Refresh ----
\* Refreshing the graph when the repository changes: watchFolder plus a poll.
\* Code: drive.js runs one watchFolder loop per local worktree (a remote machine is poll only); a relevant batch kicks a debounced store.refresh() that is not
\*   awaited (Await F); a 45 s poll (10 s for a remote machine) also refreshes (Poll T). lib/store.js runs one read at a
\*   time and reads once more if asked during it (Coalesce T); it keeps no newest-wins sequence (Seq F).
\* Herdr's watchFolder(dir) resolves with the changed paths the next time anything under dir changes. Not measured:
\*   whether a change between a resolve and the next call is kept (Buffer) or lost.
\* One copy only: copies telling each other through a shared bump are in RefreshCopies.tla. The repository read is one
\*   step here; the store's several git reads and their failures are not modelled.
EXTENDS Naturals

CONSTANTS
  Buffer,  \* TRUE: changes while no watchFolder call is pending are delivered to the next call
  Await,   \* TRUE: the loop awaits reload before calling watchFolder again; FALSE: fire-and-forget
  Seq,     \* TRUE: a reload's result is dropped once a later reload has started (latest-started wins)
  Poll,    \* TRUE: a timer also starts a reload now and then
  Coalesce \* TRUE: at most one reload in flight; a trigger during it sets "dirty" and the reload runs once more

MaxV == 2         \* the repo changes at most twice, then stays (so "eventually fresh" is meaningful)
R == 1..2         \* at most two reloads in flight

VARIABLES repo, view, w, pend, rl, smp, old, dirty
vars == <<repo, view, w, pend, rl, smp, old, dirty>>
\* w: "armed" (a watchFolder promise is pending) | "fired" (resolved, the loop runs) | "reloading" (Await only)
\* rl[r]: "idle" | "started" | "sampled"; smp[r]: the version it read; old[r]: a later reload has started (Seq drops it)

Init == /\ repo = 0 /\ view = 0 /\ w = "armed" /\ pend = FALSE
        /\ rl = [r \in R |-> "idle"] /\ smp = [r \in R |-> 0] /\ old = [r \in R |-> FALSE] /\ dirty = FALSE

\* Something outside changes the repo (commit in another pane, fetch, ...).
Change == /\ repo < MaxV /\ repo' = repo + 1
          /\ IF w = "armed" THEN w' = "fired" /\ pend' = pend
             ELSE w' = w /\ pend' = (pend \/ Buffer)
          /\ UNCHANGED <<view, rl, smp, old, dirty>>

StartReload(r) == /\ rl[r] = "idle" /\ rl' = [rl EXCEPT ![r] = "started"]
                  /\ old' = [o \in R |-> IF o = r THEN FALSE ELSE rl[o] /= "idle"]
Trigger == IF Coalesce /\ \E o \in R : rl[o] /= "idle" THEN dirty' = TRUE /\ UNCHANGED <<rl, old>>
           ELSE dirty' = dirty /\ \E r \in R : StartReload(r)

\* The loop body after a resolve: start a reload; re-arm now (fire-and-forget) or after it (Await).
Loop == /\ w = "fired" /\ Trigger
        /\ IF Await THEN w' = "reloading" /\ pend' = pend
           ELSE IF pend THEN w' = "fired" /\ pend' = FALSE ELSE w' = "armed" /\ pend' = FALSE
        /\ UNCHANGED <<repo, view, smp>>

Tick == /\ Poll /\ Trigger
        /\ UNCHANGED <<repo, view, w, pend, smp>>

\* reload = git reads (several exec calls; collapsed to one read of the version) ...
Sample(r) == /\ rl[r] = "started" /\ rl' = [rl EXCEPT ![r] = "sampled"] /\ smp' = [smp EXCEPT ![r] = repo]
             /\ UNCHANGED <<repo, view, w, pend, old, dirty>>
\* ... then this.graph = ...; cx.notify().
Apply(r) == /\ rl[r] = "sampled" /\ rl' = [rl EXCEPT ![r] = IF Coalesce /\ dirty THEN "started" ELSE "idle"]
            /\ dirty' = (dirty /\ ~Coalesce)
            /\ IF Seq /\ old[r] THEN view' = view ELSE view' = smp[r]
            /\ IF Await /\ w = "reloading" /\ ~(Coalesce /\ dirty) /\ \A o \in R \ {r} : rl[o] = "idle"
               THEN IF pend THEN w' = "fired" /\ pend' = FALSE ELSE w' = "armed" /\ pend' = FALSE
               ELSE UNCHANGED <<w, pend>>
            /\ UNCHANGED <<repo, smp, old>>

Next == Change \/ Loop \/ Tick \/ \E r \in R : Sample(r) \/ Apply(r)

\* Fairness for the app's steps only; the outside world may stop changing.
Spec == Init /\ [][Next]_vars /\ WF_vars(Loop) /\ WF_vars(Tick) /\ \A r \in R : WF_vars(Sample(r)) /\ WF_vars(Apply(r))

\* --- properties ---
\* Liveness: once the repo stops changing, the graph ends up showing it.
EventuallyFresh == <>[](view = repo)
\* Safety substitute for the liveness check: no reachable quiet state (nothing in flight, the watch armed with
\* nothing pending) shows an old version. Without Poll a quiet state stays quiet, so stale here = stale forever.
Quiet == /\ \A r \in R : rl[r] = "idle"
         /\ w = "armed" /\ ~pend /\ ~dirty
QuietIsFresh == Quiet => view = repo
====
