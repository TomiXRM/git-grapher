---- MODULE Drawer ----
\* The commit detail: a drawer inside the graph pane, or a detached pane next to it.
\* Code: graph.js detailPane() (the pane id kept in shared "ggit.detail.<tab>", still listed in panes()) and detach()
\*   (ignored while a split is under way or a detail pane exists; the new pane is adopted when it shows up in panes());
\*   detail-main.js docks by closing its own pane. Herdr runs close() on every copy when the app quits.
\* "modekey" is the alternative: a docked/detached mode in the shared key, set back in the pane's close().
\* PaneAppears is the pane appearing and being found in one step: in the code the pending split is retired when the
\*   search finds the pane or when a pane born after it claims the key (detailPane); test/views.test.js checks that path.
\* IdsKept: whether a restored pane keeps its id. If not, the graph cannot find its detail pane (panes() does not say a
\*   copy's role) until the person uses that pane, which claims the key (Claim).
EXTENDS Naturals

CONSTANTS
  Design,         \* "panes" (used) | "modekey" (alternative)
  SplitGuard,     \* TRUE: detach is ignored while an earlier pane.split has not shown up in panes() yet
  PanesRestored,  \* TRUE: after a quit or crash Herdr brings the detail pane back with the layout (not measured)
  IdsKept         \* TRUE: a restored pane keeps its id (not measured)

VARIABLES sel, panesD, splitting, mode, running, known
vars == <<sel, panesD, splitting, mode, running, known>>
\* known: the graph can find the detail pane (its id is in the shared key and listed in panes())

Init == sel = FALSE /\ panesD = 0 /\ splitting = 0 /\ mode = "docked" /\ running = TRUE /\ known = TRUE

Detached == IF Design = "panes" THEN panesD > 0 /\ known ELSE mode = "detached"
DrawerShown == running /\ sel /\ ~Detached

Select == running /\ ~sel /\ sel' = TRUE /\ UNCHANGED <<panesD, splitting, mode, running, known>>
Deselect == running /\ sel /\ sel' = FALSE /\ UNCHANGED <<panesD, splitting, mode, running, known>>

\* Detach is only clickable while the drawer is shown.
Detach == /\ DrawerShown /\ (SplitGuard => splitting = 0) /\ panesD + splitting < 2
          /\ splitting' = splitting + 1
          /\ mode' = IF Design = "modekey" THEN "detached" ELSE mode
          /\ UNCHANGED <<sel, panesD, running, known>>
\* Herdr creates the pane some frames later.
PaneAppears == running /\ splitting > 0 /\ splitting' = splitting - 1 /\ panesD' = panesD + 1 /\ known' = TRUE
               /\ UNCHANGED <<sel, mode, running>>
\* Dock or closing the pane; "modekey" sets the mode back in close().
ClosePane == running /\ panesD > 0 /\ panesD' = panesD - 1
             /\ mode' = (IF Design = "modekey" THEN "docked" ELSE mode)
             /\ UNCHANGED <<sel, splitting, running, known>>
\* Quit runs close() on every copy; a crash runs nothing. Pending splits are lost (assumed).
Quit == running /\ running' = FALSE /\ splitting' = 0
        /\ mode' = (IF Design = "modekey" /\ panesD > 0 THEN "docked" ELSE mode)
        /\ UNCHANGED <<sel, panesD, known>>
Crash == running /\ running' = FALSE /\ splitting' = 0 /\ UNCHANGED <<sel, panesD, mode, known>>
\* Restart: the selection comes back from the shared key; the pane per PanesRestored.
Restart == ~running /\ running' = TRUE /\ panesD' = (IF PanesRestored THEN panesD ELSE 0)
           /\ known' = (IdsKept \/ ~PanesRestored \/ panesD = 0)
           /\ UNCHANGED <<sel, splitting, mode>>
\* The person uses the restored detail pane: it writes its id into the shared key.
Claim == running /\ panesD > 0 /\ ~known /\ known' = TRUE /\ UNCHANGED <<sel, panesD, splitting, mode, running>>

Next == Select \/ Deselect \/ Detach \/ PaneAppears \/ ClosePane \/ Quit \/ Crash \/ Restart \/ Claim

\* --- properties ---
NoDouble == ~(DrawerShown /\ running /\ panesD > 0)
\* With a selection, the detail is somewhere (or a split is on its way).
NoneMissing == (running /\ sel) => (DrawerShown \/ panesD > 0 \/ splitting > 0)
AtMostOneDetail == panesD + splitting <= 1
====
