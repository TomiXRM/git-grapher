// Send an AI question to a new Claude pane below the graph or an existing agent pane by terminal address.
// Shared by commit details and Conflict Mode. Exclude shells, where questions would execute as commands.
// Do not rely on program.agent: Claude Code panes can report false.
// ponytail: new panes always run "claude"; add a setting or use knownAgents() to support other agents.
import { panes, focused, hc, run } from "herdr";
import { div, h_flex, svg, v_flex } from "./ui/zoom.js";
import { Popup } from "gpui-base";

const alpha = (c, a) => (c && c.length === 7 ? c + a : c);

export function askTargets() {
  const here = focused()?.tab;
  const list = panes().filter((p) => p.terminal && p.program && !p.program.shell).sort((a, b) => (b.tab === here) - (a.tab === here));
  const name = (p) => `${p.program?.name ?? p.app ?? "terminal"}${p.tab === here ? " · this tab" : ""}${p.title ? " · " + p.title : p.cwd ? " · " + p.cwd.split("/").pop() : ""}`;
  return [{ v: "new", label: "New pane below (claude)" }, ...list.map((p) => ({ v: p.terminal, label: name(p) }))];
}

// → Promise<{ ok, text }>. A new pane starts in the repo's folder, so the agent gets that project's settings.
export async function sendAsk(target, repo, msg) {
  if (target === "new") {
    run("pane.split", { pane: focused()?.pane ?? undefined, direction: "down",
      argv: repo ? ["/bin/sh", "-c", 'cd "$1" && exec claude "$2"', "sh", repo, msg] : ["claude", msg] });
    return { ok: true, text: "Opened" };
  }
  const r = await hc(["send", target, msg]).catch((e) => ({ code: 1, stderr: String(e) }));
  return r.code === 0 ? { ok: true, text: "Sent" } : { ok: false, text: (r.stderr || r.stdout || "Could not send").split("\n")[0] };
}

// The pull-down shows the selected target and opens its list below.
// st: { target, menu } belongs to the caller; a closed pane falls back to "new".
export function askPicker(t, st, id) {
  const opts = askTargets(), line = alpha(t.foreground, "1f"), dim = t.muted ?? alpha(t.foreground, "99");
  if (!opts.some((o) => o.v === st.target)) st.target = "new";
  const cur = opts.find((o) => o.v === st.target);
  const trigger = h_flex().id(`${id}-target`).h(26).px(8).gap(6).items_center().rounded(6).cursor_pointer().text_size(12)
    .border_1().border_color(line).bg(t.background).hover((h) => h.bg(t.hover ?? t.raised))
    .on_click((_e, cx) => { st.menu = !st.menu; cx.notify(); })
    .child(div().flex_1().min_w(0).truncate().child(cur.label))
    .child(svg("mods/git-grapher/icons/chevron-down.svg").size(12).flex_none().text_color(dim));
  const menu = v_flex().id(`${id}-target-list`).min_w(220).p(4).rounded(7).border_1().border_color(line).bg(t.raised ?? t.background).shadow_md()
    .on_mouse_down_out((_e, cx) => { st.menu = false; cx.notify(); })
    .children(opts.map((o) => h_flex().id(`${id}-opt-` + o.v).h(26).px(8).items_center().rounded(5).cursor_pointer().text_size(12)
      .when(o.v === st.target, (e) => e.bg(alpha(t.accent ?? t.foreground, "26"))).hover((h) => h.bg(t.hover ?? t.raised))
      .on_click((_e, cx) => { st.target = o.v; st.menu = false; cx.notify(); })
      .child(div().min_w(0).truncate().child(o.label))));
  return Popup.new(`${id}-target-popup`, trigger).anchor("top_left").when(Boolean(st.menu), (e) => e.content(menu));
}
