// ggit-helper diff: unified diff -> JSON rows with syntax spans (s) and changed-word ranges (w).
// Uses syntect + two-face with onig; the tree-sitter engine is not built (feature "ts" is disabled).
//
// ggit-helper diff [--repo R] [--engine syntect|ts|none] [--ctx hunk|file] [--max-cols N] [--no-cut] [--cls num|name] [--repeat N]
//    (--stdin | -- <git diff args>)
// Runs `git -C R diff --no-color --no-ext-diff --full-index <args>` itself (herdr exec has no stdin).
// stdout: {"c":[class names],"files":[{"p","op"?,"lang"?,"rows":[{k,o?,n?,t,s?,w?,f?}]} | {"p","note"}],"ms":{..}}
// Offsets in s/w are UTF-16 units into t (JS slice), after tab -> 4 spaces and the max-cols clip.
// error: {"error":..} on stdout, exit 1.
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::time::{Duration, Instant};

const CLASSES: [&str; 10] =
    ["keyword", "string", "comment", "function", "type", "number", "constant", "operator", "punctuation", "variable"];
const KW: u8 = 0;
const STR: u8 = 1;
const COM: u8 = 2;
const FUN: u8 = 3;
const TY: u8 = 4;
const NUM: u8 = 5;
const CON: u8 = 6;
const OP: u8 = 7;
const PUN: u8 = 8;
const VAR: u8 = 9;
#[allow(dead_code)]
const NONE: u8 = 255;

type Spans = Vec<(usize, usize, u8)>; // byte start, byte end, class (within one line)

#[allow(dead_code)]
fn push_merge(sp: &mut Spans, s: usize, e: usize, c: u8) {
    if let Some(l) = sp.last_mut() {
        if l.1 == s && l.2 == c {
            l.1 = e;
            return;
        }
    }
    sp.push((s, e, c));
}

// ---------------------------------------------------------------- syntect
#[cfg(feature = "syn-core")]
mod syn {
    use super::*;
    use syntect::easy::ScopeRangeIterator;
    use syntect::parsing::{ParseState, Scope, ScopeStack, SyntaxSet};

    pub struct Syn {
        ss: SyntaxSet,
        cache: HashMap<Scope, Option<(u8, bool)>>, // class, and whether it is a real comment/string scope
    }

    // First matching dotted prefix wins. ponytail: hand table, not a theme; edit here to recolor.
    const MAP: &[(&str, u8)] = &[
        ("comment", COM), ("string", STR), ("constant.character.escape", STR), ("constant.numeric", NUM),
        ("constant", CON), ("keyword.operator", OP), ("keyword", KW), ("storage.type", KW), ("storage.modifier", KW),
        ("entity.name.function", FUN), ("support.function", FUN), ("variable.function", FUN),
        ("entity.name.tag", KW), ("entity.other.attribute-name", TY), ("entity.name", TY), ("support.type", TY),
        ("support.class", TY), ("entity.other.inherited-class", TY), ("variable.language", CON),
        ("support.constant", CON), ("variable", VAR), ("punctuation", PUN), ("markup.heading", KW),
        ("markup.raw.inline", STR), ("markup.underline.link", STR),
    ];

    fn map(s: &str) -> Option<u8> {
        MAP.iter()
            .find(|(p, _)| s.starts_with(p) && (s.len() == p.len() || s.as_bytes()[p.len()] == b'.'))
            .map(|x| x.1)
    }

    impl Syn {
        pub fn new() -> Self {
            Syn { ss: two_face::syntax::extra_newlines(), cache: HashMap::new() }
        }
        pub fn lang(&self, path: &str, first: &str) -> Option<(usize, String)> {
            let name = path.rsplit('/').next().unwrap_or(path);
            let ext = name.rsplit_once('.').map(|x| x.1).unwrap_or(name);
            let s = self
                .ss
                .find_syntax_by_extension(name)
                .or_else(|| self.ss.find_syntax_by_extension(ext))
                .or_else(|| self.ss.find_syntax_by_first_line(first))?;
            let i = self.ss.syntaxes().iter().position(|x| std::ptr::eq(x, s))?;
            Some((i, s.name.clone()))
        }
        pub fn hl(&mut self, id: usize, lines: &[&str]) -> Vec<Spans> {
            let Syn { ss, cache } = self;
            let syn = &ss.syntaxes()[id];
            let mut ps = ParseState::new(syn);
            let mut st = ScopeStack::new();
            let mut out = Vec::with_capacity(lines.len());
            let mut buf = String::new();
            for l in lines {
                buf.clear();
                buf.push_str(l);
                buf.push('\n');
                let mut sp = Spans::new();
                match ps.parse_line(&buf, ss) {
                    Ok(ops) => {
                        for (r, op) in ScopeRangeIterator::new(&ops, &buf) {
                            let _ = st.apply(op);
                            let end = r.end.min(l.len());
                            if r.start >= end {
                                continue;
                            }
                            if let Some(c) = class(cache, &st) {
                                push_merge(&mut sp, r.start, end, c);
                            }
                        }
                    }
                    Err(_) => {
                        ps = ParseState::new(syn);
                        st = ScopeStack::new();
                    }
                }
                out.push(sp);
            }
            out
        }
    }

    // A comment/string anywhere in the stack wins (quotes stay string-coloured); else the innermost mapped scope.
    fn class(cache: &mut HashMap<Scope, Option<(u8, bool)>>, st: &ScopeStack) -> Option<u8> {
        let mut inner = None;
        for s in st.as_slice().iter().rev() {
            let c = *cache.entry(*s).or_insert_with(|| {
                let n = s.build_string();
                map(&n).map(|c| (c, n.starts_with("comment") || n.starts_with("string")))
            });
            if let Some((c, dom)) = c {
                if dom {
                    return Some(c);
                }
                inner.get_or_insert(c);
            }
        }
        inner
    }
}

// ---------------------------------------------------------------- tree-sitter
#[cfg(feature = "ts")]
mod ts {
    use super::*;
    use std::cell::OnceCell;
    use tree_sitter_highlight::{HighlightConfiguration, HighlightEvent, Highlighter};

    // Capture names we ask for; tree-sitter-highlight matches the longest dotted prefix.
    const NAMES: &[(&str, u8)] = &[
        ("keyword", KW), ("string", STR), ("string.special", STR), ("escape", STR), ("character", STR),
        ("comment", COM), ("function", FUN), ("function.macro", FUN), ("type", TY), ("constructor", TY),
        ("number", NUM), ("float", NUM), ("boolean", CON), ("constant", CON), ("constant.builtin", CON),
        ("operator", OP), ("punctuation", PUN), ("variable", VAR), ("variable.builtin", CON),
        ("variable.parameter", VAR), ("property", VAR), ("tag", KW), ("attribute", TY), ("label", VAR),
        ("module", TY), ("namespace", TY), ("text.title", KW), ("text.literal", STR), ("text.uri", STR),
        ("text.reference", STR), ("embedded", NONE),
    ];

    fn mk(l: tree_sitter::Language, name: &str, h: &str, i: &str, loc: &str) -> Option<HighlightConfiguration> {
        let mut c = HighlightConfiguration::new(l, name, h, i, loc).map_err(|e| eprintln!("ts {name}: {e:?}")).ok()?;
        c.configure(&NAMES.iter().map(|x| x.0).collect::<Vec<_>>());
        Some(c)
    }

    type Make = fn() -> Option<HighlightConfiguration>;
    // (name, extensions + injection aliases, constructor)
    const DEFS: &[(&str, &[&str], Make)] = &[
        ("rust", &["rs"], || mk(tree_sitter_rust::LANGUAGE.into(), "rust", tree_sitter_rust::HIGHLIGHTS_QUERY, tree_sitter_rust::INJECTIONS_QUERY, "")),
        ("javascript", &["js", "mjs", "cjs", "jsx"], || {
            use tree_sitter_javascript as j;
            mk(j::LANGUAGE.into(), "javascript", &format!("{}\n{}", j::HIGHLIGHT_QUERY, j::JSX_HIGHLIGHT_QUERY), j::INJECTIONS_QUERY, j::LOCALS_QUERY)
        }),
        ("typescript", &["ts", "mts", "cts"], || {
            use {tree_sitter_javascript as j, tree_sitter_typescript as t};
            mk(t::LANGUAGE_TYPESCRIPT.into(), "typescript", &format!("{}\n{}", t::HIGHLIGHTS_QUERY, j::HIGHLIGHT_QUERY), j::INJECTIONS_QUERY, &format!("{}\n{}", j::LOCALS_QUERY, t::LOCALS_QUERY))
        }),
        ("tsx", &["tsx"], || {
            use {tree_sitter_javascript as j, tree_sitter_typescript as t};
            mk(t::LANGUAGE_TSX.into(), "tsx", &format!("{}\n{}\n{}", t::HIGHLIGHTS_QUERY, j::HIGHLIGHT_QUERY, j::JSX_HIGHLIGHT_QUERY), j::INJECTIONS_QUERY, &format!("{}\n{}", j::LOCALS_QUERY, t::LOCALS_QUERY))
        }),
        ("python", &["py", "pyi"], || mk(tree_sitter_python::LANGUAGE.into(), "python", tree_sitter_python::HIGHLIGHTS_QUERY, "", "")),
        ("go", &["go"], || mk(tree_sitter_go::LANGUAGE.into(), "go", tree_sitter_go::HIGHLIGHTS_QUERY, "", "")),
        ("json", &["json"], || mk(tree_sitter_json::LANGUAGE.into(), "json", tree_sitter_json::HIGHLIGHTS_QUERY, "", "")),
        ("toml", &["toml"], || mk(tree_sitter_toml_ng::LANGUAGE.into(), "toml", tree_sitter_toml_ng::HIGHLIGHTS_QUERY, "", "")),
        ("yaml", &["yml", "yaml"], || mk(tree_sitter_yaml::LANGUAGE.into(), "yaml", tree_sitter_yaml::HIGHLIGHTS_QUERY, "", "")),
        ("markdown", &["md", "markdown"], || mk(tree_sitter_md::LANGUAGE.into(), "markdown", tree_sitter_md::HIGHLIGHT_QUERY_BLOCK, tree_sitter_md::INJECTION_QUERY_BLOCK, "")),
        ("markdown_inline", &[], || mk(tree_sitter_md::INLINE_LANGUAGE.into(), "markdown_inline", tree_sitter_md::HIGHLIGHT_QUERY_INLINE, tree_sitter_md::INJECTION_QUERY_INLINE, "")),
        ("css", &["css"], || mk(tree_sitter_css::LANGUAGE.into(), "css", tree_sitter_css::HIGHLIGHTS_QUERY, "", "")),
        ("html", &["html", "htm"], || mk(tree_sitter_html::LANGUAGE.into(), "html", tree_sitter_html::HIGHLIGHTS_QUERY, tree_sitter_html::INJECTIONS_QUERY, "")),
        ("bash", &["sh", "bash", "zsh", "shell"], || mk(tree_sitter_bash::LANGUAGE.into(), "bash", tree_sitter_bash::HIGHLIGHT_QUERY, "", "")),
        ("c", &["c", "h"], || mk(tree_sitter_c::LANGUAGE.into(), "c", tree_sitter_c::HIGHLIGHT_QUERY, "", "")),
        ("cpp", &["cpp", "cc", "cxx", "hpp", "hh", "hxx", "c++"], || {
            mk(tree_sitter_cpp::LANGUAGE.into(), "cpp", &format!("{}\n{}", tree_sitter_cpp::HIGHLIGHT_QUERY, tree_sitter_c::HIGHLIGHT_QUERY), "", "")
        }),
    ];

    pub struct Ts {
        cells: Vec<OnceCell<Option<HighlightConfiguration>>>, // ponytail: built on first use; query compile is the cold cost
        hl: Highlighter,
    }

    fn find(name: &str) -> Option<usize> {
        let n = name.to_ascii_lowercase();
        let n = match n.as_str() { "py" => "python", "js" => "javascript", "ts" => "typescript", x => x };
        DEFS.iter().position(|d| d.0 == n || d.1.contains(&n))
    }

    fn get(cells: &[OnceCell<Option<HighlightConfiguration>>], i: usize) -> Option<&HighlightConfiguration> {
        cells[i].get_or_init(DEFS[i].2).as_ref()
    }

    impl Ts {
        pub fn new() -> Self {
            Ts { cells: (0..DEFS.len()).map(|_| OnceCell::new()).collect(), hl: Highlighter::new() }
        }
        pub fn lang(&self, path: &str, _first: &str) -> Option<(usize, String)> {
            let name = path.rsplit('/').next().unwrap_or(path);
            let ext = name.rsplit_once('.')?.1.to_ascii_lowercase();
            let i = DEFS.iter().position(|d| d.1.contains(&ext.as_str()))?;
            Some((i, DEFS[i].0.to_string()))
        }
        pub fn hl(&mut self, id: usize, lines: &[&str]) -> Vec<Spans> {
            let mut src = String::with_capacity(lines.iter().map(|l| l.len() + 1).sum());
            let mut starts = Vec::with_capacity(lines.len());
            for l in lines {
                starts.push(src.len());
                src.push_str(l);
                src.push('\n');
            }
            let mut out = vec![Spans::new(); lines.len()];
            let Ts { cells, hl } = self;
            let cells = &*cells;
            let Some(cfg) = get(cells, id) else { return out };
            let Ok(ev) = hl.highlight(cfg, src.as_bytes(), None, None, |n| find(n).and_then(|i| get(cells, i))) else { return out };
            let mut stack: Vec<u8> = Vec::new();
            for e in ev {
                match e {
                    Ok(HighlightEvent::HighlightStart(h)) => stack.push(NAMES[h.0].1),
                    Ok(HighlightEvent::HighlightEnd) => {
                        stack.pop();
                    }
                    Ok(HighlightEvent::Source { mut start, end }) => {
                        let c = *stack.last().unwrap_or(&NONE);
                        if c == NONE {
                            continue;
                        }
                        while start < end {
                            let li = starts.partition_point(|&s| s <= start) - 1;
                            let (ls, le) = (starts[li], starts[li] + lines[li].len());
                            let e2 = end.min(le);
                            if start < e2 {
                                push_merge(&mut out[li], start - ls, e2 - ls, c);
                            }
                            start = le + 1;
                        }
                    }
                    Err(_) => break,
                }
            }
            out
        }
    }
}

enum Eng {
    None,
    #[cfg(feature = "syn-core")]
    Syn(syn::Syn),
    #[cfg(feature = "ts")]
    Ts(ts::Ts),
}

impl Eng {
    fn new(name: &str) -> Result<Eng, String> {
        match name {
            "none" => Ok(Eng::None),
            #[cfg(feature = "syn-core")]
            "syntect" => Ok(Eng::Syn(syn::Syn::new())),
            #[cfg(feature = "ts")]
            "ts" => Ok(Eng::Ts(ts::Ts::new())),
            _ => Err(format!("engine {name} not built in")),
        }
    }
    fn lang(&self, path: &str, first: &str) -> Option<(usize, String)> {
        let _ = (path, first);
        match self {
            Eng::None => None,
            #[cfg(feature = "syn-core")]
            Eng::Syn(s) => s.lang(path, first),
            #[cfg(feature = "ts")]
            Eng::Ts(t) => t.lang(path, first),
        }
    }
    fn streams(&self) -> bool {
        match self {
            #[cfg(feature = "syn-core")]
            Eng::Syn(_) => true,
            _ => false,
        }
    }
    fn hl(&mut self, id: usize, lines: &[&str]) -> Vec<Spans> {
        let _ = id;
        match self {
            Eng::None => vec![Spans::new(); lines.len()],
            #[cfg(feature = "syn-core")]
            Eng::Syn(s) => s.hl(id, lines),
            #[cfg(feature = "ts")]
            Eng::Ts(t) => t.hl(id, lines),
        }
    }
}

// ---------------------------------------------------------------- diff parse
struct Row {
    k: u8, // b'@' b'+' b'-' b' ' b'\\'
    o: u32,
    n: u32,
    t: String,
    f: String, // '@' rows: function context after the second @@
}

#[derive(Default)]
struct File {
    path: String,
    old: Option<String>,
    blobs: (String, String),
    rows: Vec<Row>,
    note: Option<&'static str>,
}

fn row(k: u8, o: u32, n: u32, t: &str) -> Row {
    Row { k, o, n, t: t.to_string(), f: String::new() }
}

fn parse(text: &str) -> Vec<File> {
    let mut files: Vec<File> = Vec::new();
    let (mut a, mut b, mut in_hunk) = (0u32, 0u32, false);
    let (mut minus, mut plus) = (None::<String>, None::<String>);
    let body = text.strip_suffix('\n').unwrap_or(text);
    let fin = |f: Option<&mut File>, m: Option<String>, p: Option<String>| {
        if let (Some(f), Some(m), Some(p)) = (f, m, p) {
            if m != p { f.old = Some(m) }
        }
    };
    for l in body.split('\n') {
        if let Some(rest) = l.strip_prefix("diff --git ") {
            fin(files.last_mut(), minus.take(), plus.take());
            in_hunk = false;
            // ponytail: unquoted paths only (git runs with core.quotePath=false; a path with " b/" in it breaks)
            let path = rest.rsplit_once(" b/").map(|x| x.1).unwrap_or(rest).to_string();
            files.push(File { path, ..Default::default() });
            continue;
        }
        let Some(f) = files.last_mut() else { continue };
        if let Some(h) = l.strip_prefix("@@ -") {
            let (nums, fun) = h.split_once(" @@").unwrap_or((h, ""));
            let (x, y) = nums.split_once(" +").unwrap_or((nums, "0"));
            let p = |s: &str| s.split(',').next().and_then(|v| v.parse::<u32>().ok()).unwrap_or(0);
            (a, b, in_hunk) = (p(x), p(y), true);
            f.rows.push(Row { k: b'@', o: 0, n: 0, t: format!("@@ -{nums} @@"), f: fun.trim_start().to_string() });
            continue;
        }
        if in_hunk {
            let k = l.as_bytes().first().copied().unwrap_or(b' ');
            let t = l.get(1..).unwrap_or("");
            match k {
                b'+' => { f.rows.push(row(k, 0, b, t)); b += 1; continue }
                b'-' => { f.rows.push(row(k, a, 0, t)); a += 1; continue }
                b' ' => { f.rows.push(row(k, a, b, t)); a += 1; b += 1; continue }
                b'\\' => { f.rows.push(row(k, 0, 0, l.get(2..).unwrap_or(""))); continue }
                _ => in_hunk = false,
            }
        }
        if let Some(ix) = l.strip_prefix("index ") {
            if let Some((x, y)) = ix.split(' ').next().unwrap_or("").split_once("..") {
                f.blobs = (x.to_string(), y.to_string());
            }
        } else if let Some(p) = l.strip_prefix("--- ") {
            minus = p.strip_prefix("a/").map(str::to_string);
        } else if let Some(p) = l.strip_prefix("+++ ") {
            plus = p.strip_prefix("b/").map(str::to_string);
            if let Some(p) = &plus { f.path = p.clone() }
        } else if l.starts_with("Binary files ") || l == "GIT binary patch" {
            f.note = Some("binary");
        }
    }
    fin(files.last_mut(), minus, plus);
    files
}

// ---------------------------------------------------------------- word diff
// Tokens: a run of word chars, a run of whitespace, or one other char (so `a.b(c)` -> a . b ( c )).
fn toks(s: &str) -> Vec<&str> {
    let kind = |c: char| if c.is_alphanumeric() || c == '_' { 1 } else if c.is_whitespace() { 2 } else { 0 };
    let (mut v, mut start, mut pk) = (Vec::new(), 0, 3);
    for (i, c) in s.char_indices() {
        let k = kind(c);
        if i > start && (k == 0 || k != pk) {
            v.push(&s[start..i]);
            start = i;
        }
        pk = k;
    }
    if start < s.len() {
        v.push(&s[start..]);
    }
    v
}

const MAX_DIST: f64 = 0.6; // delta's default --max-line-distance
const LOOKAHEAD: usize = 16; // ponytail: a '-' line looks at most 16 '+' lines ahead; keeps big rewrites O(16·n)

type Ranges = Vec<(usize, usize)>;

fn wdiff(a: &str, b: &str) -> Option<(Ranges, Ranges)> {
    let (ta, tb) = (toks(a), toks(b));
    let ops = similar::capture_diff_slices_deadline(
        similar::Algorithm::Myers, &ta, &tb, Some(Instant::now() + Duration::from_millis(5)));
    let off = |t: &[&str]| {
        let mut v = Vec::with_capacity(t.len() + 1);
        let mut s = 0;
        v.push(0);
        for x in t { s += x.len(); v.push(s) }
        v
    };
    let (oa, ob) = (off(&ta), off(&tb));
    let (mut ra, mut rb, mut changed) = (Ranges::new(), Ranges::new(), 0);
    for op in ops {
        let (tag, x, y) = op.as_tag_tuple();
        if tag == similar::DiffTag::Equal {
            continue;
        }
        if !x.is_empty() {
            ra.push((oa[x.start], oa[x.end]));
            changed += oa[x.end] - oa[x.start];
        }
        if !y.is_empty() {
            rb.push((ob[y.start], ob[y.end]));
            changed += ob[y.end] - ob[y.start];
        }
    }
    if changed as f64 > MAX_DIST * (a.len() + b.len()).max(1) as f64 {
        return None;
    }
    let merge = |r: Ranges| r.into_iter().fold(Ranges::new(), |mut v, (s, e)| {
        match v.last_mut() { Some(l) if l.1 == s => l.1 = e, _ => v.push((s, e)) }
        v
    });
    Some((merge(ra), merge(rb)))
}

// A run of '-' rows directly followed by a run of '+' rows: each '-' takes the first similar '+' after the last pair.
fn words(rows: &[Row]) -> Vec<Ranges> {
    let mut w = vec![Ranges::new(); rows.len()];
    let mut i = 0;
    while i < rows.len() {
        if rows[i].k != b'-' {
            i += 1;
            continue;
        }
        let d0 = i;
        while i < rows.len() && rows[i].k == b'-' { i += 1 }
        let a0 = i;
        while i < rows.len() && rows[i].k == b'+' { i += 1 }
        let mut j0 = a0;
        for d in d0..a0 {
            for j in j0..i.min(j0 + LOOKAHEAD) {
                if let Some((x, y)) = wdiff(&rows[d].t, &rows[j].t) {
                    w[d] = x;
                    w[j] = y;
                    j0 = j + 1;
                    break;
                }
            }
        }
    }
    w
}

// ---------------------------------------------------------------- spans per row
fn file_lines(b: &[u8]) -> Vec<&str> {
    let s = std::str::from_utf8(b).unwrap_or("");
    s.strip_suffix('\n').unwrap_or(s).split('\n').collect()
}

// Rows on one side grouped by hunk: old = ' ' and '-', new = ' ' and '+'.
fn side_hunks(rows: &[Row], old: bool) -> Vec<Vec<usize>> {
    let mut hs: Vec<Vec<usize>> = Vec::new();
    for (i, r) in rows.iter().enumerate() {
        let on = match r.k { b'@' => { hs.push(Vec::new()); false } b' ' => true, b'-' => old, b'+' => !old, _ => false };
        if on {
            if let Some(h) = hs.last_mut() { h.push(i) }
        }
    }
    hs
}

struct Stats {
    file_ctx: usize,
    mismatch: usize,
}

// The highlighter only sees the first `cut` bytes of a line (0 = all): past max-cols nothing is shown, and a 130 KB
// minified line otherwise costs syntect ~200 ms. UTF-8 bytes >= UTF-16 units, so the visible part is always kept
// (except tab-heavy lines). ponytail: a string cut open at the end can leak its state into the next line.
fn cut(l: &str, n: usize) -> &str {
    if n == 0 || l.len() <= n { return l }
    let mut i = n;
    while !l.is_char_boundary(i) { i -= 1 }
    &l[..i]
}

fn row_spans(eng: &mut Eng, id: usize, rows: &[Row], blobs: [Option<&[u8]>; 2], st: &mut Stats, cut_at: usize) -> Vec<Spans> {
    let mut out = vec![Spans::new(); rows.len()];
    for (si, old) in [(0, true), (1, false)] {
        let want = |k: u8| if old { k == b'-' } else { k == b'+' || k == b' ' };
        let hs = side_hunks(rows, old);
        if !hs.iter().flatten().any(|&i| want(rows[i].k)) {
            continue;
        }
        if let Some(b) = blobs[si] {
            let fl = file_lines(b);
            let ln = |r: &Row| (if old { r.o } else { r.n }) as usize;
            // syntect streams, so it can stop after the last needed line; tree-sitter must see the whole file
            // (cut at the change, an open /* or """ never closes and error recovery drops the comment/string).
            let need = hs.iter().flatten().map(|&i| ln(&rows[i])).max().unwrap_or(0).min(fl.len());
            let max = if eng.streams() { need } else { fl.len() };
            let sp = eng.hl(id, &fl[..max].iter().map(|l| cut(l, cut_at)).collect::<Vec<_>>());
            st.file_ctx += 1;
            for &i in hs.iter().flatten() {
                let n = ln(&rows[i]);
                if !want(rows[i].k) { continue }
                if n >= 1 && n <= need && fl[n - 1] == rows[i].t { out[i] = sp[n - 1].clone() } else { st.mismatch += 1 }
            }
            continue;
        }
        for h in &hs {
            let lines: Vec<&str> = h.iter().map(|&i| cut(&rows[i].t, cut_at)).collect();
            let sp = eng.hl(id, &lines);
            for (j, &i) in h.iter().enumerate() {
                if want(rows[i].k) { out[i] = sp[j].clone() }
            }
        }
    }
    out
}

// ---------------------------------------------------------------- output
fn json_str(out: &mut String, s: &str) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
}

const CLIP: &str = " … (line truncated)"; // same note as lib/diff.js

// Display text (tab -> 4 spaces, clipped at max_cols UTF-16 units) and a byte -> unit map (None = identity).
fn display(raw: &str, max_cols: usize) -> (std::borrow::Cow<'_, str>, Option<Vec<u32>>) {
    if raw.is_ascii() && !raw.contains('\t') && (max_cols == 0 || raw.len() <= max_cols) {
        return (raw.into(), None);
    }
    let mut t = String::with_capacity(raw.len() + 8);
    let mut m = vec![0u32; raw.len() + 1];
    let mut u = 0u32;
    let mut clipped = false;
    for (b, c) in raw.char_indices() {
        let w = if c == '\t' { 4 } else { c.len_utf16() as u32 };
        clipped |= max_cols > 0 && (u + w) as usize > max_cols;
        m[b..b + c.len_utf8()].fill(u);
        if clipped { continue }
        if c == '\t' { t.push_str("    ") } else { t.push(c) }
        u += w;
    }
    m[raw.len()] = u;
    if clipped {
        t.push_str(CLIP);
    }
    (t.into(), Some(m))
}

struct Opt {
    no_cut: bool,
    repo: Option<String>,
    engine: String,
    ctx_file: bool,
    max_cols: usize,
    cls_name: bool,
    repeat: usize,
    stdin: bool,
    args: Vec<String>,
}

fn emit_file(out: &mut String, f: &File, eng: &mut Eng, blobs: &HashMap<String, Vec<u8>>, o: &Opt, st: &mut Stats, tm: &mut [Duration; 2]) {
    out.push_str("{\"p\":");
    json_str(out, &f.path);
    if let Some(op) = &f.old {
        out.push_str(",\"op\":");
        json_str(out, op);
    }
    if let Some(n) = f.note {
        out.push_str(",\"note\":\"");
        out.push_str(n);
        out.push_str("\"}");
        return;
    }
    let first = f.rows.iter().find(|r| r.k == b'+' || r.k == b' ').map(|r| r.t.as_str()).unwrap_or("");
    let t0 = Instant::now();
    let spans = match eng.lang(&f.path, first) {
        Some((id, name)) => {
            out.push_str(",\"lang\":");
            json_str(out, &name);
            let b = |h: &str| if o.ctx_file && !h.bytes().all(|c| c == b'0') { blobs.get(h).map(|v| v.as_slice()) } else { None };
            row_spans(eng, id, &f.rows, [b(&f.blobs.0), b(&f.blobs.1)], st, if o.no_cut { 0 } else { o.max_cols })
        }
        None => vec![Spans::new(); f.rows.len()],
    };
    let t1 = Instant::now();
    let w = words(&f.rows);
    tm[0] += t1 - t0;
    tm[1] += t1.elapsed();
    out.push_str(",\"rows\":[");
    for (i, r) in f.rows.iter().enumerate() {
        if i > 0 { out.push(',') }
        out.push_str("{\"k\":");
        json_str(out, &(r.k as char).to_string());
        if r.o > 0 { out.push_str(&format!(",\"o\":{}", r.o)) }
        if r.n > 0 { out.push_str(&format!(",\"n\":{}", r.n)) }
        let (t, m) = if r.k == b'@' { (r.t.as_str().into(), None) } else { display(&r.t, o.max_cols) };
        out.push_str(",\"t\":");
        json_str(out, &t);
        if !r.f.is_empty() {
            out.push_str(",\"f\":");
            json_str(out, &r.f);
        }
        let u = |b: usize| m.as_ref().map(|m| m[b.min(m.len() - 1)] as usize).unwrap_or(b);
        let mut first = true;
        for &(s, e, c) in &spans[i] {
            let (s, e) = (u(s), u(e));
            if e <= s { continue }
            out.push_str(if first { ",\"s\":[" } else { "," });
            first = false;
            if o.cls_name { out.push_str(&format!("[{},{},\"{}\"]", s, e - s, CLASSES[c as usize])) } else { out.push_str(&format!("[{},{},{}]", s, e - s, c)) }
        }
        if !first { out.push(']') }
        let mut first = true;
        for &(s, e) in &w[i] {
            let (s, e) = (u(s), u(e));
            if e <= s { continue }
            out.push_str(if first { ",\"w\":[" } else { "," });
            first = false;
            out.push_str(&format!("[{},{}]", s, e - s));
        }
        if !first { out.push(']') }
        out.push('}');
    }
    out.push_str("]}");
}

// One `git cat-file --batch` for every blob id; missing ids are left out.
fn cat_blobs(repo: &str, ids: Vec<String>) -> HashMap<String, Vec<u8>> {
    let mut m = HashMap::new();
    let Ok(mut ch) = std::process::Command::new("git")
        .args(["-C", repo, "cat-file", "--batch"])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .spawn() else { return m };
    let mut sin = ch.stdin.take().unwrap();
    let req = ids.iter().map(|i| format!("{i}\n")).collect::<String>();
    let th = std::thread::spawn(move || { let _ = sin.write_all(req.as_bytes()); });
    let mut r = BufReader::new(ch.stdout.take().unwrap());
    for id in ids {
        let mut hdr = String::new();
        if r.read_line(&mut hdr).unwrap_or(0) == 0 { break }
        let p: Vec<&str> = hdr.split_whitespace().collect();
        if p.len() == 3 && p[1] == "blob" {
            let n: usize = p[2].parse().unwrap_or(0);
            let mut b = vec![0; n + 1];
            if r.read_exact(&mut b).is_err() { break }
            b.pop();
            m.insert(id, b);
        }
    }
    let _ = th.join();
    let _ = ch.wait();
    m
}

pub fn run(args: Vec<String>) -> Result<String, String> {
    let t0 = Instant::now();
    let mut o = Opt { no_cut: false, repo: None, engine: default_engine().into(), ctx_file: true, max_cols: 2000, cls_name: false, repeat: 1, stdin: false, args: vec![] };
    let mut a = args.into_iter();
    while let Some(k) = a.next() {
        let mut v = || a.next().ok_or(format!("{k} needs a value"));
        match k.as_str() {
            "--repo" => o.repo = Some(v()?),
            "--engine" => o.engine = v()?,
            "--ctx" => o.ctx_file = v()? == "file",
            "--no-cut" => o.no_cut = true,
            "--max-cols" => o.max_cols = v()?.parse().map_err(|_| "bad --max-cols")?,
            "--cls" => o.cls_name = v()? == "name",
            "--repeat" => o.repeat = v()?.parse().map_err(|_| "bad --repeat")?,
            "--stdin" => o.stdin = true,
            "--" => { o.args = a.collect(); break }
            _ => return Err(format!("unknown arg {k}")),
        }
    }
    let text = if o.stdin {
        let mut s = String::new();
        std::io::stdin().read_to_string(&mut s).map_err(|e| e.to_string())?;
        s
    } else {
        let repo = o.repo.as_deref().ok_or("--repo or --stdin needed")?;
        let r = std::process::Command::new("git")
            .args(["-C", repo, "-c", "core.quotePath=false", "diff", "--no-color", "--no-ext-diff", "--full-index"])
            .args(&o.args)
            .output()
            .map_err(|e| e.to_string())?;
        if !r.status.success() {
            return Err(String::from_utf8_lossy(&r.stderr).trim().to_string());
        }
        String::from_utf8_lossy(&r.stdout).into_owned() // ponytail: non-UTF-8 lines become U+FFFD
    };
    let t_git = t0.elapsed();
    let ti = Instant::now();
    let mut eng = Eng::new(&o.engine)?;
    let t_init = ti.elapsed();
    let tp = Instant::now();
    let files = parse(&text);
    let t_parse = tp.elapsed();
    // exec stdout is capped at 8 MiB; dense minified diffs can produce about 11 KB of JSON per 2,000-column row.
    // Above 20,000 rows or 2 MB of diff, return plain: true and let JS display uncoloured text.
    let rows: usize = files.iter().map(|f| f.rows.len()).sum();
    let plain = rows > 20_000 || text.len() > 2_000_000;
    if plain { eng = Eng::new("none")?; }
    let tb = Instant::now();
    let mut blobs = HashMap::new();
    if o.ctx_file {
        if let Some(repo) = &o.repo {
            let ids: Vec<String> = files.iter().flat_map(|f| [f.blobs.0.clone(), f.blobs.1.clone()])
                .filter(|h| !h.is_empty() && !h.bytes().all(|c| c == b'0')).collect();
            blobs = cat_blobs(repo, ids);
            // Working-tree side of `git diff`: its id is not in the object store, read the file instead.
            for f in &files {
                let id = &f.blobs.1;
                if !id.is_empty() && !id.bytes().all(|c| c == b'0') && !blobs.contains_key(id) {
                    if let Ok(b) = std::fs::read(std::path::Path::new(repo).join(&f.path)) {
                        blobs.insert(id.clone(), b);
                    }
                }
            }
        }
    }
    let t_blobs = tb.elapsed();
    let mut out = String::new();
    let mut runs = Vec::new();
    let mut st = Stats { file_ctx: 0, mismatch: 0 };
    let mut tm = [Duration::ZERO; 2];
    for _ in 0..o.repeat.max(1) {
        out.clear();
        st = Stats { file_ctx: 0, mismatch: 0 };
        tm = [Duration::ZERO; 2];
        let tr = Instant::now();
        out.push_str("{\"c\":[");
        out.push_str(&CLASSES.iter().map(|c| format!("\"{c}\"")).collect::<Vec<_>>().join(","));
        out.push_str("],\"files\":[");
        for (i, f) in files.iter().enumerate() {
            if i > 0 { out.push(',') }
            emit_file(&mut out, f, &mut eng, &blobs, &o, &mut st, &mut tm);
        }
        out.push(']');
        runs.push(tr.elapsed());
    }
    let ms = |d: Duration| format!("{:.2}", d.as_secs_f64() * 1e3);
    out.push_str(&format!(
        ",\"ms\":{{\"git\":{},\"init\":{},\"parse\":{},\"blobs\":{},\"hl\":{},\"wd\":{},\"run1\":{},\"runN\":{},\"total\":{}}},\"engine\":\"{}\",\"file_ctx\":{},\"mismatch\":{}}}",
        ms(t_git), ms(t_init), ms(t_parse), ms(t_blobs), ms(tm[0]), ms(tm[1]), ms(runs[0]), ms(*runs.last().unwrap()), ms(t0.elapsed()), o.engine, st.file_ctx, st.mismatch
    ));
    if plain { out.insert_str(out.len() - 1, ",\"plain\":true"); }
    if out.len() > 7 << 20 { return Err("diff too large to colour".into()); } // ponytail: the JS falls back to plain git diff
    Ok(out)
}

fn default_engine() -> &'static str {
    if cfg!(feature = "ts") { "ts" } else if cfg!(feature = "syn-core") { "syntect" } else { "none" }
}

#[cfg(test)]
mod t {
    use super::*;
    #[test]
    fn parse_words_display() {
        let d = "diff --git a/x.rs b/x.rs\nindex 1..2 100644\n--- a/x.rs\n+++ b/x.rs\n@@ -1,2 +1,2 @@ fn main\n-let a = foo(1);\n+let a = bar(1);\n ok\n";
        let f = parse(d);
        assert_eq!(f.len(), 1);
        assert_eq!(f[0].path, "x.rs");
        let r = &f[0].rows;
        assert_eq!((r[1].k, r[1].o, r[2].k, r[2].n, r[3].o, r[3].n), (b'-', 1, b'+', 1, 2, 2));
        assert_eq!(r[0].f, "fn main");
        let w = words(r);
        assert_eq!(w[1], vec![(8, 11)]); // "foo"
        assert_eq!(w[2], vec![(8, 11)]);
        let (t, m) = display("\té😀x", 0);
        assert_eq!(t, "    é😀x");
        let m = m.unwrap();
        assert_eq!((m[1], m[3], m[7]), (4, 5, 7)); // after tab, after é, after 😀 (2 units)
    }
}
