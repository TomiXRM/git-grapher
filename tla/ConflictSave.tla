---- MODULE ConflictSave ----
\* Saving the merge Result over a conflicted file that another program (an editor, an agent) may also be changing.
\* Code: lib/conflict.js SAVE, one sh script: hash the file, compare with the blob it had when loaded (workId), and only
\*   then write the Result and stage it. The compare and the write are separate commands, so a write landing between
\*   them is overwritten; sh has no file lock (test/conflict.test.js keeps that as a todo test).
EXTENDS Naturals

CONSTANTS
  Check,   \* TRUE: compare with the loaded blob first (the code); FALSE: write blindly
  OneStep  \* TRUE: compare and write as one atomic step (not available from sh)

VARIABLES file, phase, early, late, lostEarly, lostLate
vars == <<file, phase, early, late, lostEarly, lostLate>>
\* file: "loaded" | "edited" | "result"; phase: "open" | "saving" | "checked" | "done" | "refused"
\* early / late: another program wrote before Save started / while it ran; lostEarly / lostLate: that write was overwritten

Init == file = "loaded" /\ phase = "open" /\ early = FALSE /\ late = FALSE /\ lostEarly = FALSE /\ lostLate = FALSE

Edit == /\ phase \in {"open", "saving", "checked"} /\ file /= "edited" /\ file' = "edited"
        /\ early' = (early \/ phase = "open") /\ late' = (late \/ phase /= "open")
        /\ UNCHANGED <<phase, lostEarly, lostLate>>

StartSave == phase = "open" /\ phase' = "saving" /\ UNCHANGED <<file, early, late, lostEarly, lostLate>>

Write == /\ file' = "result" /\ phase' = "done"
         /\ lostEarly' = (lostEarly \/ (file = "edited" /\ early)) /\ lostLate' = (lostLate \/ (file = "edited" /\ late))
         /\ UNCHANGED <<early, late>>

CheckStep == /\ phase = "saving"
             /\ IF Check /\ file /= "loaded" THEN phase' = "refused" /\ UNCHANGED <<file, early, late, lostEarly, lostLate>>
                ELSE IF OneStep THEN Write ELSE phase' = "checked" /\ UNCHANGED <<file, early, late, lostEarly, lostLate>>

WriteStep == phase = "checked" /\ Write

Next == Edit \/ StartSave \/ CheckStep \/ WriteStep

\* --- properties ---
\* A change another program made before Save is never overwritten.
KeepsEarlierEdits == ~lostEarly
\* Nor one made while Save runs.
KeepsAllEdits == ~lostEarly /\ ~lostLate
====
