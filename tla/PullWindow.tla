---- MODULE PullWindow ----
\* The window between the Pull preview and `git pull` (time of check to time of use).
\* Code: lib/preview-pull.js reads HEAD and the cached @{upstream} and never fetches; header.js holds the rules:
\*   Suspend   autoFetchOk() starts no auto fetch from the start of a preview until that pull settles (`pulling`)
\*   Serialize a Fetch while a Pull is queued or running goes into the write queue behind it (netQueued, netRunning);
\*             the queued pull waits for a fetch already running outside the queue (freeFetch)
\*   Drain     the preview awaits a running fetch (fetchJob) first
\*   Reverify  confirming plans again and goes back to the preview if HEAD or @{upstream} moved, or if the preview saw
\*             the repository change while it read (observed-basis-changed)
\*   Recheck   inside the write queue, after a fetch running outside it has finished, pullAt() reads HEAD and
\*             @{upstream} again and refuses as stale if they are not the preview's
\* The person can press Fetch at any time (Manual); Suspend does not apply to that, Serialize does. Confirming does not
\*   wait for a running fetch; the queued pull does.
\* Scope: one Header (one copy of the mod) and one Pull request at a time; other copies and other processes are External.
\* `git pull` fetches first, and `pull --rebase` takes the fork-point from the tracking ref before that fetch.
\* Versions are counters: remote = tip on the server, track = refs/remotes/origin/<b>, head = local branch tip.
EXTENDS Naturals

CONSTANTS
  InitStale,  \* TRUE: the cache is already behind the server when the preview runs
  Suspend,    \* rule: the app starts no periodic fetch while the preview is shown (confirm phase)
  Serialize,  \* rule: app writes (the pull) and app fetches never run at the same time (pull waits)
  Drain,      \* rule: the preview waits until an in-flight app fetch has finished
  RemoteMoves,\* someone pushes to the server during the window (the app cannot stop it)
  External,   \* another process on this machine (other pane / agent) fetches or commits (cannot be stopped)
  Manual,     \* the person may press Fetch during the window
  Recheck,    \* rule: right before `git pull`, refuse if HEAD or the tracking ref moved since the preview
  ReadFails,  \* the last read can fail (or there is no basis: no upstream, detached, unborn); git pull then decides
  Reverify    \* rule: on confirm, re-read HEAD and @{upstream}; if either moved, back to a new preview

MaxR == 2

VARIABLES remote, track, head, phase, pre, fork, fetched, exec, af, appHit
vars == <<remote, track, head, phase, pre, fork, fetched, exec, af, appHit>>

None == [head |-> 99, track |-> 99]

Init == /\ remote = (IF InitStale THEN 1 ELSE 0) /\ track = 0 /\ head = 0
        /\ phase = "idle" /\ pre = None /\ fork = 99 /\ fetched = 99 /\ exec = None
        /\ af = FALSE /\ appHit = 0

Window == phase \in {"confirm", "checked", "dispatch", "fetching", "integrating"}

\* previewPull: observes HEAD and the cached @{upstream}, verifies they did not change during the preview.
Preview == /\ phase = "idle" /\ (Drain => ~af)
           /\ phase' = "confirm" /\ pre' = [head |-> head, track |-> track]
           /\ UNCHANGED <<remote, track, head, fork, fetched, exec, af, appHit>>

\* User confirms -> plain `git pull`: the fork-point comes from the tracking ref before pull's own fetch.
\* Reverify: the re-read and the start of `git pull` are two steps (other processes can run in between).
Confirm == /\ phase = "confirm"
           /\ IF Reverify /\ (head /= pre.head \/ track /= pre.track)
              THEN phase' = "idle" /\ pre' = None
              ELSE phase' = "checked" /\ pre' = pre
           /\ UNCHANGED <<remote, track, head, fork, fetched, exec, af, appHit>>
\* The queued pull starts once no fetch runs (Serialize); with Recheck it reads the refs and is refused if they moved.
\* With ReadFails the read may not give an answer and the pull goes ahead (modelled as: the check never refuses).
\* The read and `git pull` starting are two steps: another program can still move a ref between them.
StartPull == /\ phase = "checked" /\ (Serialize => ~af)
             /\ IF Recheck /\ (head /= pre.head \/ track /= pre.track) /\ ~ReadFails
                THEN phase' = "idle" /\ pre' = None
                ELSE phase' = "dispatch" /\ pre' = pre
             /\ UNCHANGED <<remote, track, head, fork, fetched, exec, af, appHit>>
Dispatch == phase = "dispatch" /\ phase' = "fetching" /\ fork' = track
            /\ UNCHANGED <<remote, track, head, pre, fetched, exec, af, appHit>>

\* pull's own fetch: updates the tracking ref; the merge/rebase target is what this fetch brought (FETCH_HEAD).
PullFetch == /\ phase = "fetching"
             /\ phase' = "integrating" /\ track' = remote /\ fetched' = remote
             /\ UNCHANGED <<remote, head, pre, fork, exec, af, appHit>>

Integrate == /\ phase = "integrating"
             /\ phase' = "done" /\ exec' = [head |-> head, track |-> fetched]
             /\ UNCHANGED <<remote, track, head, pre, fork, fetched, af, appHit>>

\* The app's fetch, two steps (start / ref update at the end): the periodic one, or Fetch pressed by the person.
SerializeOk == Serialize => phase \notin {"checked", "dispatch", "fetching", "integrating"}
AppFetchStart == /\ ~af /\ (Suspend => phase \notin {"confirm", "checked"}) /\ SerializeOk
                 /\ af' = TRUE
                 /\ UNCHANGED <<remote, track, head, phase, pre, fork, fetched, exec, appHit>>
ManualFetchStart == /\ Manual /\ ~af /\ SerializeOk /\ af' = TRUE
                    /\ UNCHANGED <<remote, track, head, phase, pre, fork, fetched, exec, appHit>>
AppFetchEnd == /\ af
               /\ af' = FALSE /\ track' = remote
               /\ appHit' = IF Window /\ track /= remote THEN appHit + 1 ELSE appHit
               /\ UNCHANGED <<remote, head, phase, pre, fork, fetched, exec>>

RemotePush == /\ RemoteMoves /\ remote < MaxR /\ remote' = remote + 1
              /\ UNCHANGED <<track, head, phase, pre, fork, fetched, exec, af, appHit>>
ExtFetch == /\ External /\ track /= remote /\ track' = remote
            /\ UNCHANGED <<remote, head, phase, pre, fork, fetched, exec, af, appHit>>
ExtCommit == /\ External /\ head < 2 /\ head' = head + 1
             /\ UNCHANGED <<remote, track, phase, pre, fork, fetched, exec, af, appHit>>

Next == \/ Preview \/ Confirm \/ StartPull \/ Dispatch \/ PullFetch \/ Integrate
        \/ AppFetchStart \/ ManualFetchStart \/ AppFetchEnd \/ RemotePush \/ ExtFetch \/ ExtCommit

\* --- properties ---
\* The pull integrated exactly the (head, upstream) pair the preview was computed on.
PullMatchesPreviewBasis == phase = "done" => exec = pre
\* The rebase fork-point input (tracking ref before pull's fetch) is the one the preview saw.
ForkPointMatchesPreview == phase \in {"fetching", "integrating", "done"} => fork = pre.track
\* No app-started fetch moved the tracking ref inside the preview..integrate window.
NoAppFetchInWindow == appHit = 0
\* The app's own fetch and pull never overlap (ref-lock contention is not modelled).
NoOverlap == ~(af /\ phase \in {"fetching", "integrating"})
====
