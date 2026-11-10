// Settings sections use headings above rounded 10 px cards with 12 px insets and 1 px row separators.
// Rows place a title and secondary description left of their control, with minimum heights 40 / 52 px.
// Dark cards mix background and raised colours; light cards use background with a hairline border.
import { div, svg, h_flex, v_flex, Input, ZOOM_MIN, ZOOM_MAX } from "./ui/zoom.js";
import { modal, modalButton } from "./modal.js";
import { THEMES } from "./themes.js";

const hex = (c) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
const mix = (a, b, f) => (a?.length === 7 && b?.length === 7)
  ? "#" + hex(a).map((x, i) => Math.round(x + (hex(b)[i] - x) * f).toString(16).padStart(2, "0")).join("") : a;
const lum = (c) => { const [r, g, b] = hex(c); return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255; };

export function settingsView(t, { g, set, done, icon, paneW, genInput = null, upd = null, onUpdate = null }) {
  const fg = t.foreground, dark = lum(t.background ?? "#000000") < 0.5, sub = t.sub ?? t.muted ?? fg;
  const win = dark ? t.background : mix(t.background, t.raised ?? t.background, 0.3);
  const card = dark ? mix(t.background, t.raised ?? t.background, 0.42) : t.background;
  const hair = mix(card, sub, dark ? 0.18 : 0.22), control = mix(card, sub, 0.16), accent = t.accent ?? fg;

  const section = (title, rows) => v_flex().gap(8)
    .child(div().px(12).font_weight(700).child(title))
    .child(v_flex().w_full().rounded(10).px(12).bg(card).when(!dark, (e) => e.border_1().border_color(hair))
      .children(rows.flatMap((r, i) => (i ? [div().h(1).flex_none().bg(hair), r] : [r]))));
  const row = (id, title, desc, ctl) => h_flex().id(id).w_full().min_h(desc ? 52 : 40).py(7).gap(12).items_center()
    .child(v_flex().flex_1().min_w(0).gap(2).child(div().child(title))
      .children(desc ? [div().text_size(11.5).text_color(sub).whitespace_normal().child(desc)] : []))
    .children(ctl ? [ctl] : []);

  const themeRow = ([k, name]) => row("set-theme-" + k, name, null, g.theme === k ? svg("mods/git-grapher/icons/check.svg").size(14).text_color(accent) : null)
    .cursor_pointer().on_click((_e, cx) => set("theme", k, cx));

  // Stepper: 24 px controls, 7 px corners, 40 px value field, 8 px gaps and 10% steps.
  const z = Math.round((g.zoom ?? 1) * 10) / 10;
  const step = (id, label, d) => {
    const next = Math.round((z + d) * 10) / 10, ok = next >= ZOOM_MIN && next <= ZOOM_MAX;
    return div().id(id).size(24).flex_none().flex().items_center().justify_center().rounded(7).bg(control).text_size(14)
      .when(!ok, (e) => e.opacity(0.4))
      .when(ok, (e) => e.cursor_pointer().hover((x) => x.bg(mix(card, sub, 0.26))).on_click((_e, cx) => set("zoom", next, cx)))
      .child(label);
  };
  const stepper = h_flex().flex_none().gap(8).items_center().child(step("zoom-out", "−", -0.1))
    .child(div().w(40).text_center().child(`${Math.round(z * 100)}%`)).child(step("zoom-in", "+", 0.1));

  // Switch: 36 x 20 px track, 16 px knob; accent when on.
  const sw = (id, on, flip) => div().id(id).w(36).h(20).flex_none().rounded_full().p(2).flex().cursor_pointer()
    .bg(on ? accent : control).when(on, (e) => e.justify_end()).on_click((_e, cx) => flip(cx))
    .child(div().size(16).rounded_full().bg("#ffffff").shadow_sm());

  // Updates (update.js / update.sh): the release this is, the latest one, the optional helper.
  const btn = (id, label, fn) => div().id(id).h(24).px(10).flex_none().flex().items_center().rounded(7).bg(control).text_size(12)
    .when(!!fn, (e) => e.cursor_pointer().hover((x) => x.bg(mix(card, sub, 0.26))).on_click((_e, cx) => fn(cx)))
    .when(!fn, (e) => e.opacity(0.5)).child(label);
  const u = upd ?? {}, v = `v${u.version ?? "?"}`;
  const verText = u.dev ? `${v} · a development copy (scripts/dev-link.sh), not updated here`
    : !u.latest ? `${v} · ${u.checked ? "could not reach the release page" : "checking for a newer release…"}` : u.available ? `${v} · ${u.latest} is available` : `${v} · up to date`;
  const canRun = !!onUpdate && !u.dev && !!u.latest && !u.busy;
  const updates = [
    row("set-version", "Git Grapher", verText, u.available && !u.dev
      ? btn("set-update", u.busy === "install" ? "Updating…" : `Update to ${u.latest}`, canRun ? (cx) => onUpdate("install", cx) : null) : null),
    row("set-helper", "Helper", u.helper ? "Installed: syntax colours in diffs, PDF and HEIC previews"
      : "Not installed. Adds syntax colours in diffs and PDF / HEIC previews", !u.helper && !u.dev
      ? btn("set-helper-install", u.busy === "helper" ? "Installing…" : "Install", canRun ? (cx) => onUpdate("helper", cx) : null) : null),
    ...(u.text ? [div().id("set-update-text").w_full().py(8).text_size(11.5).text_color(sub).whitespace_normal().child(u.text)] : []),
  ];

  return modal(t, { icon, color: t.muted ?? fg, title: "Settings", paneW, bg: win,
    body: [v_flex().gap(16).pt(4)
      .child(section("Theme", THEMES.map(themeRow)))
      .child(section("Layout", [row("set-zoom", "Zoom", "Text and layout of Git Grapher (70%–200%).", stepper),
        row("set-avatars", "Avatar nodes", "Faces as the graph's dots", sw("set-avatars-sw", g.avatars !== false, (cx) => set("avatars", g.avatars === false, cx)))]))
      // the command that writes a commit message; the prompt is its last argument, its output the message.
      // One short line, the field below at full width.
      .children(genInput ? [section("Commit message", [v_flex().id("set-gen").w_full().py(9).gap(6)
        .child(h_flex().gap(8).items_baseline().child(div().child("Generate command")).child(div().text_size(11.5).text_color(sub).child("run with the staged diff")))
        .child(div().w_full().h(26).px(8).rounded(6).bg(control).flex().items_center().child(Input.new(genInput).w_full().text_size(12)))])] : [])
      .child(section("Updates", updates))
      .child(section("Results", [row("set-verbose", "Verbose", "Open Details with every git command.", sw("set-verbose-sw", g.verbose, (cx) => set("verbose", !g.verbose, cx)))]))],
    actions: [modalButton(t, "dlg-ok", "Done", done, { primary: true })] });
}
