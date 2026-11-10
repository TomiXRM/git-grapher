---- MODULE RefreshCopies ----
\* Several copies of Git Grapher on one repository (tabs, the graph and its detail pane) keeping each other fresh.
\* Code: drive.js. Each copy watches the worktree folder; a relevant batch kicks a debounced read and, with Tell, also
\*   stamps the shared bump "ggit.bump.<machine>:<root>" ({ by, id }). A copy also stamps when its own read sees the
\*   refs change (store sig) or a write finish. Every 250 ms a copy checks the bump and reads if it is someone else's and
\*   unseen; before stamping it consumes an unseen bump. A 45 s poll reads anyway (Poll).
\* Host assumptions: when several copies wait on the same folder, a change batch reaches only one of them (Single, as
\*   observed); a change while no copy waits is lost (whether Herdr buffers it is not measured). A change is either to
\*   refs (seen by the read's signature) or only to worktree files.
\* What is abstract: the bump is "someone stamped; who has seen it" (no ids, no lagging shared() views, no overwrite
\*   of an unseen bump, so consume-before-stamp is not exercised); a read and its stamp are one step and never fail;
\*   stamps after the copy's own writes, the debounce, remote (poll-only) copies and changing watch sets are left out.
\*   So this checks the notification design (watch, Tell, check, poll), not the bump's id scheme.
EXTENDS Naturals, FiniteSets

CONSTANTS
  N,       \* number of copies
  Single,  \* TRUE: a change batch is delivered to one waiting copy only; FALSE: to every waiting copy
  Tell,    \* TRUE: a copy that got a batch stamps the bump (needed for worktree-only changes)
  Poll     \* TRUE: the periodic poll reads now and then (45 s by default)

C == 1..N
MaxV == 3
Kinds == {"ref", "work"}

VARIABLES repo, refs, view, vrefs, armed, kick, bumpBy, seen
vars == <<repo, refs, view, vrefs, armed, kick, bumpBy, seen>>
\* repo: version of everything shown; refs: version of the refs only (what the store's signature sees)
\* view[c] / vrefs[c]: what copy c last read; armed[c]: its watchFolder call is pending
\* kick[c]: "none" | "read" | "tell" (a read is due; "tell" stamps first); bumpBy: 0 (no bump yet) or the copy that
\* stamped last; seen[c]: copy c has seen the current bump

Init == /\ repo = 0 /\ refs = 0 /\ view = [c \in C |-> 0] /\ vrefs = [c \in C |-> 0]
        /\ armed = [c \in C |-> TRUE] /\ kick = [c \in C |-> "none"]
        /\ bumpBy = 0 /\ seen = [c \in C |-> TRUE]

Waiting == {c \in C : armed[c]}

\* Something outside changes the repository. The batch goes to one waiting copy (Single) or to all of them.
Change(k) == /\ repo < MaxV /\ repo' = repo + 1 /\ refs' = (IF k = "ref" THEN refs + 1 ELSE refs)
             /\ IF Waiting = {} THEN UNCHANGED <<armed, kick>>
                ELSE IF Single
                     THEN \E c \in Waiting : armed' = [armed EXCEPT ![c] = FALSE]
                                            /\ kick' = [kick EXCEPT ![c] = IF Tell THEN "tell" ELSE "read"]
                     ELSE armed' = [c \in C |-> FALSE]
                          /\ kick' = [c \in C |-> IF c \in Waiting THEN (IF Tell THEN "tell" ELSE "read") ELSE kick[c]]
             /\ UNCHANGED <<view, vrefs, bumpBy, seen>>

\* The watch loop calls watchFolder again (it does not wait for the read).
Rearm(c) == ~armed[c] /\ armed' = [armed EXCEPT ![c] = TRUE] /\ UNCHANGED <<repo, refs, view, vrefs, kick, bumpBy, seen>>

\* A stamp: new bump by c, which only c has seen.
StampBy(c) == bumpBy' = c /\ seen' = [d \in C |-> d = c]

\* The debounced read. With "tell", stamp first. A read that sees the refs change stamps too.
Read(c) == /\ kick[c] /= "none"
           /\ view' = [view EXCEPT ![c] = repo] /\ vrefs' = [vrefs EXCEPT ![c] = refs]
           /\ kick' = [kick EXCEPT ![c] = "none"]
           /\ IF kick[c] = "tell" \/ refs /= vrefs[c] THEN StampBy(c) ELSE UNCHANGED <<bumpBy, seen>>
           /\ UNCHANGED <<repo, refs, armed>>

\* Every 250 ms: someone else's unseen bump -> read.
Check(c) == /\ ~seen[c] /\ bumpBy /= c
            /\ seen' = [seen EXCEPT ![c] = TRUE]
            /\ kick' = [kick EXCEPT ![c] = IF kick[c] = "none" THEN "read" ELSE kick[c]]
            /\ UNCHANGED <<repo, refs, view, vrefs, armed, bumpBy>>

Tick(c) == /\ Poll /\ kick[c] = "none" /\ view[c] /= repo
           /\ kick' = [kick EXCEPT ![c] = "read"]
           /\ UNCHANGED <<repo, refs, view, vrefs, armed, bumpBy, seen>>

Next == \/ \E k \in Kinds : Change(k)
        \/ \E c \in C : Rearm(c) \/ Read(c) \/ Check(c) \/ Tick(c)

Spec == Init /\ [][Next]_vars /\ \A c \in C : WF_vars(Rearm(c)) /\ WF_vars(Read(c)) /\ WF_vars(Check(c)) /\ WF_vars(Tick(c))

\* --- properties ---
\* Once the repository stops changing, every copy ends up showing it.
EventuallyAllFresh == <>[](\A c \in C : view[c] = repo)
\* Nothing left to do anywhere, yet a copy shows an old version: without Poll it stays that way.
Quiet == \A c \in C : armed[c] /\ kick[c] = "none" /\ seen[c]
QuietIsFresh == Quiet => \A c \in C : view[c] = repo
====
