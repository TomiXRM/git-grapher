// ggit themes; Color Vision uses Catppuccin Mocha with Okabe-Ito overrides.
// Store settings in herdr shared state "ggit.settings" so graph and detached details follow the same choice.
// The default "herdr" theme uses the host theme unchanged.
import { shared, setShared } from "herdr";

// Only fields used by the views are included. Apple themes use system blue; other themes use link/selection accents.
// syntax follows helper class order: keyword, string, comment, function, type, number, constant, operator, punctuation, variable.
// muted is subdued text; sub is readable secondary text. accent colours buttons, focus rings and selection.
// accent_foreground is white at contrast >= 3:1, otherwise black.
const K = {
  "apple-dark": { name: "Apple Dark", dark: true, background: "#101012", foreground: "#ffffff", muted: "#98989f", sub: "#98989f", raised: "#2c2c2e", selected: "#3a3a3c",
    popover: "#2a2a2c", ansi1: "#ff4245", ansi2: "#30d158", ansi3: "#ff9230", ansi4: "#0091ff", accent: "#ffd600", accent_foreground: "#000000",
    syntax: ["#fc5fa3", "#fc6a5d", "#6c7986", "#67b7a4", "#9ef1dd", "#d0bf69", "#d0bf69", "#ffffff", "#ffffff", "#67b7a4"],
    lanes: ["#ffd600", "#30d158", "#3cd3fe", "#0091ff", "#db34f2", "#ff375f", "#ff3d49", "#ff9230"] },
  "apple-light": { name: "Apple Light", dark: false, background: "#ffffff", foreground: "#000000", muted: "#666666", sub: "#606060", raised: "#e5e5e5", selected: "#d9edff",
    popover: "#ffffff", ansi1: "#e9152d", ansi2: "#008932", ansi3: "#c55300", ansi4: "#1e6ef4", accent: "#0088ff", accent_foreground: "#ffffff",
    syntax: ["#9b2393", "#c41a16", "#5d6c79", "#326d74", "#1c464a", "#1c00cf", "#1c00cf", "#000000", "#000000", "#326d74"],
    lanes: ["#1e6ef4", "#b02fc2", "#e7124d", "#ff333f", "#c55300", "#a16a00", "#008932", "#007eae"] },
  "flower-road": { name: "Flower Road", dark: false, background: "#fff8f3", foreground: "#172540", muted: "#6a7592", sub: "#3b4767", raised: "#eaddd8", selected: "#c5ddd1",
    popover: "#fffcfa", ansi1: "#c73d88", ansi2: "#318259", ansi3: "#8a5a10", ansi4: "#2e549e", accent: "#d698ba", accent_foreground: "#000000",
    syntax: ["#a5276b", "#318259", "#6a7592", "#2e549e", "#70741b", "#9c4e1c", "#9c4e1c", "#172540", "#172540", "#178282"],
    lanes: ["#e15757", "#1b993b", "#a667e4", "#a2811d", "#1a9393", "#de46b8", "#57941a", "#5f80e3"] },
  "color-vision": { name: "Color Vision (Blue/Orange)", dark: true, background: "#1e1e2e", foreground: "#cdd6f4", muted: "#585b70", sub: "#a6adc8", raised: "#313244", selected: "#45475a",
    popover: "#313244", ansi1: "#e69f00", ansi2: "#56b4e9", ansi3: "#f0e442", ansi4: "#cc79a7", accent: "#56b4e9", accent_foreground: "#000000",
    syntax: ["#cba6f7", "#a6e3a1", "#9399b2", "#89b4fa", "#f9e2af", "#fab387", "#fab387", "#89dceb", "#9399b2", "#eba0ac"],
    lanes: ["#e69f00", "#56b4e9", "#f0e442", "#cc79a7", "#009e73", "#d55e00", "#3d8fd6", "#b8b8b8"] },
};
export const THEMES = [["herdr", "Follow herdr"], ...Object.entries(K).map(([k, v]) => [k, v.name])];

export const settings = () => ({ theme: "herdr", verbose: false, ...(shared("ggit.settings") ?? {}) });
export const setSetting = (k, v) => setShared("ggit.settings", { ...settings(), [k]: v });

// The herdr theme with ours laid over it. hover / dim / input / border follow from the fields above.
export function applyTheme(base, slug = settings().theme) { // slug: props.theme (screenshots)
  const k = K[slug];
  if (!k) return base;
  const { name, dark, ...c } = k;
  return { ...base, ...c, hover: c.selected, dim: c.muted, input: c.raised, border: c.raised, chrome: c.background, root: c.background };
}
