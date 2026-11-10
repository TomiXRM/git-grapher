---- MODULE RefCas ----
\* Moving a branch to a new commit from the tip ggit planned on, while another program (an agent, a terminal) may
\*   commit on it: the merge commit (lib/conflict.js commitMerge), an off-branch merge (lib/merge.js), fast-forwarding
\*   a branch that is not checked out to its remote (lib/core.js syncRemote). Each uses `git update-ref <ref> <new> <old>`,
\*   which git applies only if the ref still holds old.
\* Not covered: deleting a branch (the same old-value check, but the effect and its backup ref are different), whether
\*   the new commit really is on top of old (tree and parents are checked by other tests), and the steps around the
\*   update (checkout, cleanup).
\* Commits are numbers; a commit made on top of c is c + 1 (Other) or c + 10 (ours), so lost work is visible.
EXTENDS Naturals

CONSTANTS
  Cas     \* TRUE: update-ref with the expected old value; FALSE: plain update-ref (or branch -f / -D)

VARIABLES ref, plan, phase, made, lost
vars == <<ref, plan, phase, made, lost>>
\* ref: the branch tip; plan: the tip read when planning; made: commits that were ever the tip; lost: a tip that was
\* overwritten without being an ancestor of what replaced it

Init == ref = 0 /\ plan = 0 /\ phase = "idle" /\ made = {0} /\ lost = FALSE

\* ggit reads the tip and plans its change on it.
Plan == phase = "idle" /\ plan' = ref /\ phase' = "planned" /\ UNCHANGED <<ref, made, lost>>

\* ggit moves the ref to plan + 10 (its commit on top of what it read).
Move == /\ phase = "planned"
        /\ IF Cas /\ ref /= plan
           THEN phase' = "refused" /\ UNCHANGED <<ref, made, lost>>
           ELSE /\ phase' = "done" /\ ref' = plan + 10 /\ made' = made \cup {plan + 10}
                /\ lost' = (lost \/ ref /= plan)  \* the tip at that moment is not an ancestor of plan + 10
        /\ UNCHANGED plan

\* Someone else commits on the branch (only a couple of times, to keep the model small).
Other == ref < 3 /\ ref' = ref + 1 /\ made' = made \cup {ref + 1} /\ UNCHANGED <<plan, phase, lost>>

Next == Plan \/ Move \/ Other

\* --- properties ---
\* No commit that was the branch tip is dropped from the branch by ggit.
NoLostCommit == ~lost
====
