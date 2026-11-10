---- MODULE TimeoutRetry ----
\* A write that times out (herdr exec rejects after 30 s and kills only the direct child) and running it again.
\* Code: lib/core.js write() reports a timeout or kill as "unknown" and never retries; the write queue (lib/store.js)
\*   refreshes, then starts the next write. Nothing stops the person from pressing again: the unknown result asks them
\*   to wait. A mod cannot kill a process group, so "groupkill" is not available.
\* Which policy a write has, for a repeat with the same captured target:
\*   block-cas  delete a local branch (update-ref -d <ref> <expected oid>), delete a remote branch
\*              (--force-with-lease=<ref>:<expected>), push a captured commit or tag (<oid>:<ref>, idempotent for a
\*              fixed remote ref), the merge commit and off-branch merges (update-ref with the old value)
\*   block      everything else: stash apply / pop / drop (checked by oid, but not atomically), stash push, commit,
\*              amend, revert, pull, stage / unstage / discard, switch, worktree and config writes
\* An idealized retry policy, not the code's admission rule: here a second attempt starts only after the state was read
\*   and showed the effect missing; in the code the person can press again at any time (the request queues). The effect
\*   is one step on one ref, and Reobserve sees it at once; a remote effect is not always visible to the local refresh.
\*   AtMostOnce for block-cas is about that ref, not about a whole multi-command operation, its cleanup or hooks.
\* One user request; attempt i is a process tree; did[i] = attempt i has applied its effect.
EXTENDS Naturals

CONSTANTS
  Policy,  \* "autoretry"  : on timeout, start the same write again
           \* "block"      : on timeout show "unknown"; re-observe; the user may retry only if the effect is not seen
           \* "block-cas"  : as block, and the effect is conditional on the state the attempt expected
           \*                (an expected old value, or a fixed target): a second one is a no-op
           \* "groupkill"  : as block, and the timeout kills the whole tree (not possible with herdr exec today)
  ServerSide \* TRUE: the effect is applied by another machine (push: the server's receive-pack) and can land
             \* after the local tree is dead. FALSE: a local-only write (stash pop, commit).

Att == 1..2

VARIABLES st, did, applied, app, obs, tries
vars == <<st, did, applied, app, obs, tries>>

Init == /\ st = [i \in Att |-> "none"] /\ did = [i \in Att |-> FALSE]
        /\ applied = 0 /\ app = "idle" /\ obs = "none" /\ tries = 0

\* Can attempt i still apply its effect?
Live(i) == \/ st[i] \in {"running", "orphan"}
           \/ st[i] = "killed" /\ ServerSide /\ ~did[i]

StartAttempt == /\ tries < 2
  /\ \/ app = "idle" /\ tries = 0                                       \* the user's request
     \/ Policy = "autoretry" /\ app = "unknown"                         \* automatic retry
     \/ Policy /= "autoretry" /\ app = "known" /\ obs = "not-applied"   \* the user presses again
  /\ tries' = tries + 1 /\ st' = [st EXCEPT ![tries + 1] = "running"] /\ app' = "waiting"
  /\ UNCHANGED <<did, applied, obs>>

\* The effect lands (at most once per attempt). "block-cas": only if nothing applied before.
Apply(i) == /\ Live(i) /\ ~did[i] /\ did' = [did EXCEPT ![i] = TRUE]
            /\ applied' = IF Policy = "block-cas" /\ applied > 0 THEN applied ELSE applied + 1
            /\ UNCHANGED <<st, app, obs, tries>>

\* Normal exit seen by the app: it knows the outcome. An orphan's exit is seen by nobody.
Finish(i) == /\ st[i] \in {"running", "orphan"}
             /\ st' = [st EXCEPT ![i] = "finished"]
             /\ IF st[i] = "running" /\ app = "waiting" /\ i = tries
                THEN app' = "known" /\ obs' = (IF applied > 0 THEN "applied" ELSE "not-applied")
                ELSE UNCHANGED <<app, obs>>
             /\ UNCHANGED <<did, applied, tries>>

\* exec rejects at 30 s. herdr kills the direct child; the rest of the tree goes on ("orphan").
Timeout(i) == /\ st[i] = "running" /\ app = "waiting" /\ i = tries
              /\ st' = [st EXCEPT ![i] = IF Policy = "groupkill" THEN "killed" ELSE "orphan"]
              /\ app' = "unknown"
              /\ UNCHANGED <<did, applied, obs, tries>>

\* After "unknown", the app reads the state again (the store's refresh) and shows what it saw.
Reobserve == /\ Policy /= "autoretry" /\ app = "unknown"
             /\ app' = "known" /\ obs' = (IF applied > 0 THEN "applied" ELSE "not-applied")
             /\ UNCHANGED <<st, did, applied, tries>>

Next == StartAttempt \/ Reobserve \/ \E i \in Att : Apply(i) \/ Finish(i) \/ Timeout(i)

\* --- properties ---
AtMostOnce == applied <= 1
\* No second write runs while a tree from an earlier attempt can still change the repo.
NoOverlap == \A i, j \in Att : i /= j => ~(Live(i) /\ Live(j))
====
