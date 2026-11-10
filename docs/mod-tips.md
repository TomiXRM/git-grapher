# Notes on building a Herdr mod

What tripped up Git Grapher in Herdr's mod runtime, and what works instead. Measured on Herdr 0.1.13–0.1.14, macOS.

## Runtime

- **All mods share one JS realm.** `globalThis` and the prototypes of gpui elements are the same object in every mod. Patching
  a prototype method changes every other mod too, and the patch stacks on each reload until Herdr restarts. Leave shared
  prototypes and globals alone; put your own layer on your own elements with `Object.setPrototypeOf`
  (`mods/git-grapher/ui/zoom.js`).
- **Each copy of a mod (a tab, a pane) loads its modules separately.** Module-level values are not shared between copies; use
  `setShared` for that.
- **The JS heap is about 47 MB, shared by every mod.** One array tops out near 28 MB. Reloading a mod appears to keep the large
  modules a previous copy loaded, so repeated reloads of a multi-megabyte library can use up the heap until Herdr restarts.
  Keep big libraries out of a mod and do heavy work in a separate process (here: `ggit-helper`). Have each copy read only what
  it shows.
- **QuickJS-ng.** No WebAssembly, canvas, `TextDecoder` or `Worker`; `eval` and `new Function` are blocked; built-in objects are
  frozen. Integer loops run about 6× slower than node, typed-array writes about 50×. `zlib` is built in and fast.
- **A mod cannot import outside its own folder,** not even through a symlink.
- **SVGs are not read through a symlinked mod folder,** and per-file symlinks fail to load ("resolves outside the application
  directory"). Install by copying; `scripts/dev-link.sh` does that with rsync.
- **`console.log` output is not visible.** Write values with `setShared` and read `~/.config/herdr-app/shared.json`. Errors show
  in `herdr-app status` under `errors`.
- **`exec` has no stdin.** Pass data as arguments. Linux caps one argument at 128 KiB, so split large text across several.

## Handler contexts

- **A handler's `cx` dies after the first host call it awaits** (`exec`, `hc`, …); after `await null` it still works. A dead
  `cx` throws "cx is no longer valid" from `notify` / `spawn` / `sleep` / clipboard calls, but inside an async function that
  never reaches the screen or the error list: the rest of the function is silently skipped. A render `cx` throws on `notify`
  and `focus` too.
  - Do waiting work in `cx.spawn(async (cx) => …)` and use that `cx`; it stays valid across awaits.
  - Do what must happen inside the user's action (clipboard writes) before awaiting anything; read the data beforehand.
- **Create `InputState` and similar state in `init` or a handler,** not in `render`.
- **There is no `setTimeout`.** Use `cx.timer.after` or `cx.sleep`.

## exec

- **Calls run in parallel, about 13 ms each,** mostly waiting rather than CPU.
- **Too many at once fail.** Herdr's open-file limit (256, shared by every mod) lets about 49 run together; the rest fail at once
  with `Too many open files`. Cap concurrency (8–16) and handle each call's failure instead of one `Promise.all`.
- **Long synchronous JS delays exec results** for as long as it runs.
- **Read-only git does not wake your own `watchFolder`** when run with
  `--no-optional-locks -c core.fsmonitor=false -c diff.autoRefreshIndex=false`. Plain `git status` writes the index and does.

## Lists

- **`uniform_list` ignores `track_scroll`.** Use `v_virtual_list` with `VirtualListScrollHandle` to move the scroll position.
- **Handlers inside virtual-list rows throw (TypeError).** Use the list's `on_item_click(key)` and
  `on_item_secondary_click(key, e)`. To tell parts of a row apart, read the position and `click_count` from `on_mouse_down` on
  the element around the list and work out the row layout; text widths have to be estimated.
- **`scroll_to_item(i, "top")` does nothing for a row already fully visible.** The drawn range includes about two rows off screen.

## Drawing and motion

- **Animating with `cx.notify()` every 16 ms is slow:** the whole view redraws each time. Let GPUI animate with
  `transition(prop, { duration, easing })` or `spring(prop)` and change only the target. Animatable: `top`, `left`, `width`,
  `height`, `opacity`. An appearing element starts at opacity 0 and gets 1 on the next render; a leaving one keeps its id, goes to
  opacity 0, and is removed when the motion ends.
- **A number passed to `line_height` is a multiplier.** Pass `"16px"` for pixels.
- **Sizes from `on_size_change` differ from `w()` / `h()` units** by Herdr's zoom (e.g. 0.9). Measure a hidden `w(100)` element
  too and divide by that ratio.
- **`image()` keeps no aspect ratio.** Give it both width and height.
- **A mod's theme does not reach gpui components** (inputs, TextView); they use Herdr's theme. `text_color` on a TextView fixes
  its text; the input caret colour cannot be set.
- **Herdr's UI font (Geist) has no bold.** `font_weight` 700 and 900 look the same.

## Checking

- **Build states from props, then take a screenshot** with `herdr-app shot`.
- **Try changes on a throwaway repository** (`mktemp -d`), not the one you are developing in.
- **Time git inside Herdr** (write timings with `setShared`); timing from a shell includes its own startup.
