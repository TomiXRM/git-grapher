// ggx-preview: turn a PDF / heic / (gif, webp still) / svg into a PNG under a content-hash name.
//
// ggx-preview --out DIR [--engine E] [--page N | --strip] [--max PX] [--width PX (pdf page width)]
//             (--path FILE | --git REPO REV:PATH | --stdin)
// stdout: {"path":..,"width":..,"height":..,"pages":..,"kind":..,"engine":..,"ms":..}
// error:  {"error":..} on stdout, exit 1.
use image::{imageops, ImageEncoder, RgbaImage};
use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use std::time::Instant;

type R<T> = Result<T, String>;

struct Opt {
    out: String,
    engine: Option<String>,
    page: usize, // 1-based
    strip: bool,
    max: u32,
    width: Option<u32>, // pdf: page width in px (the long side still capped by MAX_PX)
}

const STRIP_H: u32 = 256; // ponytail: fixed thumb height, a flag when someone needs another
const STRIP_GAP: u32 = 8;
const STRIP_MAX_PAGES: usize = 64; // ponytail: hard cap so a 500-page PDF stays one small exec
const MAX_PX: u32 = 16384; // gpui texture side; real cap is the 16 MiB file limit

mod diff;

fn main() {
    // `ggit-helper diff …`: syntax-coloured diff rows (diff.rs); its JSON carries its own "ms".
    if std::env::args().nth(1).as_deref() == Some("diff") {
        match diff::run(std::env::args().skip(2).collect()) {
            Ok(j) => println!("{j}"),
            Err(e) => { println!("{{\"error\":{}}}", json_str(&e)); std::process::exit(1); }
        }
        return;
    }
    let t0 = Instant::now();
    match run() {
        Ok(mut j) => {
            j.push_str(&format!(",\"ms\":{}}}", t0.elapsed().as_millis()));
            println!("{j}");
        }
        Err(e) => {
            println!("{{\"error\":{}}}", json_str(&e));
            std::process::exit(1);
        }
    }
}

fn run() -> R<String> {
    let mut a = std::env::args().skip(1);
    let mut o = Opt { out: String::new(), engine: None, page: 1, strip: false, max: 2048, width: None };
    let mut input: Option<Vec<u8>> = None;
    while let Some(k) = a.next() {
        let mut v = || a.next().ok_or(format!("{k} needs a value"));
        match k.as_str() {
            "--out" => o.out = v()?,
            "--engine" => o.engine = Some(v()?),
            "--page" => o.page = v()?.parse().map_err(|_| "bad --page")?,
            "--max" => o.max = v()?.parse().map_err(|_| "bad --max")?,
            "--strip" => o.strip = true,
            "--width" => o.width = Some(v()?.parse().map_err(|_| "bad --width")?),
            "--path" => input = Some(std::fs::read(v()?).map_err(|e| e.to_string())?),
            "--git" => {
                let repo = v()?;
                let spec = a.next().ok_or("--git needs REPO REV:PATH")?;
                let r = std::process::Command::new("git")
                    .args(["-C", &repo, "cat-file", "--filters", &spec])
                    .output()
                    .map_err(|e| e.to_string())?;
                if !r.status.success() {
                    return Err(String::from_utf8_lossy(&r.stderr).trim().to_string());
                }
                input = Some(r.stdout);
            }
            "--stdin" => {
                let mut b = Vec::new();
                std::io::stdin().read_to_end(&mut b).map_err(|e| e.to_string())?;
                input = Some(b);
            }
            _ => return Err(format!("unknown arg {k}")),
        }
    }
    let data = input.ok_or("no input (--path, --git or --stdin)")?;
    if o.out.is_empty() {
        return Err("--out is required".into());
    }
    o.max = o.max.clamp(16, MAX_PX);
    let kind = sniff(&data).ok_or("unsupported type")?;
    let engine = o.engine.clone().unwrap_or_else(|| default_engine(kind).to_string());

    let mut h = Sha256::new();
    h.update(&data);
    h.update(format!("|{kind}|{engine}|{}|{}|{}|{:?}", o.page, o.strip, o.max, o.width));
    let name: String = h.finalize().iter().take(16).map(|b| format!("{b:02x}")).collect();
    let path = format!("{}/{name}.png", o.out.trim_end_matches('/'));

    let (img, pages) = match kind {
        "pdf" => pdf(&engine, &data, &o)?,
        "heic" => (fit(heic(&engine, &data)?, o.max), 1),
        "gif" | "webp" => (fit(still(&data)?, o.max), 1),
        "svg" => (svg(&data, o.max)?, 1),
        _ => unreachable!(),
    };
    let (w, hh) = img.dimensions();
    if !std::path::Path::new(&path).exists() {
        std::fs::create_dir_all(&o.out).map_err(|e| e.to_string())?;
        let part = format!("{path}.{}.part", std::process::id());
        let mut f = std::io::BufWriter::new(std::fs::File::create(&part).map_err(|e| e.to_string())?);
        image::codecs::png::PngEncoder::new_with_quality(
            &mut f,
            image::codecs::png::CompressionType::Fast,
            image::codecs::png::FilterType::Adaptive,
        )
        .write_image(img.as_raw(), w, hh, image::ExtendedColorType::Rgba8)
        .map_err(|e| e.to_string())?;
        f.flush().map_err(|e| e.to_string())?;
        drop(f);
        std::fs::rename(&part, &path).map_err(|e| e.to_string())?;
    }
    Ok(format!(
        "{{\"path\":{},\"width\":{w},\"height\":{hh},\"pages\":{pages},\"kind\":\"{kind}\",\"engine\":\"{engine}\"",
        json_str(&path)
    ))
}

fn sniff(d: &[u8]) -> Option<&'static str> {
    if d.windows(5).take(1024).any(|w| w == b"%PDF-") {
        return Some("pdf");
    }
    if d.len() > 12 && &d[4..8] == b"ftyp" {
        let brand = &d[8..12];
        if [b"heic", b"heix", b"heim", b"heis", b"hevc", b"hevx", b"mif1", b"msf1"].iter().any(|b| brand == *b) {
            return Some("heic");
        }
    }
    if d.starts_with(b"GIF8") {
        return Some("gif");
    }
    if d.len() > 12 && &d[0..4] == b"RIFF" && &d[8..12] == b"WEBP" {
        return Some("webp");
    }
    if String::from_utf8_lossy(&d[..d.len().min(1024)]).contains("<svg") {
        return Some("svg");
    }
    None
}

fn default_engine(kind: &str) -> &'static str {
    match kind {
        "pdf" => "hayro",
        "heic" => "heicrs",
        _ => "image",
    }
}

fn json_str(s: &str) -> String {
    let mut o = String::from("\"");
    for c in s.chars() {
        match c {
            '"' => o.push_str("\\\""),
            '\\' => o.push_str("\\\\"),
            c if (c as u32) < 0x20 => o.push_str(&format!("\\u{:04x}", c as u32)),
            c => o.push(c),
        }
    }
    o.push('"');
    o
}

fn fit(img: RgbaImage, max: u32) -> RgbaImage {
    let (w, h) = img.dimensions();
    if w.max(h) <= max {
        return img;
    }
    let s = max as f64 / w.max(h) as f64;
    let (nw, nh) = (((w as f64 * s).round() as u32).max(1), ((h as f64 * s).round() as u32).max(1));
    imageops::resize(&img, nw, nh, imageops::FilterType::Triangle)
}

#[allow(dead_code)]
fn rgba(w: u32, h: u32, data: Vec<u8>) -> R<RgbaImage> {
    RgbaImage::from_raw(w, h, data).ok_or_else(|| "pixel buffer size mismatch".to_string())
}

// ---------- PDF ----------

// What every PDF backend gives: page count, page size in points, render page i at a scale.
trait PdfDoc {
    fn pages(&self) -> usize;
    fn size(&self, i: usize) -> R<(f32, f32)>;
    fn render(&self, i: usize, scale: f32) -> R<RgbaImage>;
}

fn pdf(engine: &str, data: &[u8], o: &Opt) -> R<(RgbaImage, usize)> {
    let doc = open_pdf(engine, data)?;
    let n = doc.pages();
    if n == 0 {
        return Err("pdf has no pages".into());
    }
    if !o.strip {
        let i = o.page.clamp(1, n) - 1;
        let (w, h) = doc.size(i)?;
        let s = match o.width {
            Some(px) => (px.clamp(16, MAX_PX) as f32 / w).min(MAX_PX as f32 / w.max(h)),
            None => o.max as f32 / w.max(h),
        };
        return Ok((doc.render(i, s)?, n));
    }
    let k = n.min(STRIP_MAX_PAGES);
    let mut thumbs = Vec::with_capacity(k);
    for i in 0..k {
        let (_, h) = doc.size(i)?;
        let mut t = doc.render(i, STRIP_H as f32 / h.max(1.0))?;
        if t.height() != STRIP_H {
            let w = (t.width() * STRIP_H / t.height().max(1)).max(1);
            t = imageops::resize(&t, w, STRIP_H, imageops::FilterType::Triangle);
        }
        thumbs.push(t);
    }
    let total: u32 = thumbs.iter().map(|t| t.width()).sum::<u32>() + STRIP_GAP * (k as u32 - 1);
    let mut strip = RgbaImage::from_pixel(total, STRIP_H, image::Rgba([0, 0, 0, 0]));
    let mut x = 0;
    for t in &thumbs {
        imageops::replace(&mut strip, t, x as i64, 0);
        x += t.width() + STRIP_GAP;
    }
    Ok((fit(strip, MAX_PX), n))
}

fn open_pdf(engine: &str, data: &[u8]) -> R<Box<dyn PdfDoc>> {
    match engine {
        #[cfg(feature = "hayro")]
        "hayro" => Ok(Box::new(hayro_doc::Doc::new(data)?)),
        #[cfg(feature = "pdfrender")]
        "pdfrender" => Ok(Box::new(pdfrender_doc::Doc::new(data)?)),
        #[cfg(feature = "pdfium")]
        "pdfium" => Ok(Box::new(pdfium_doc::Doc::new(data)?)),
        #[cfg(feature = "mupdf")]
        "mupdf" => Ok(Box::new(mupdf_doc::Doc::new(data)?)),
        _ => {
            let _ = data;
            Err(format!("pdf engine '{engine}' not built in"))
        }
    }
}

macro_rules! hayro_like {
    ($m:ident, $krate:ident, $interp:ident, $syntax:ident) => {
        mod $m {
            use super::*;
            use $krate::$interp::InterpreterSettings;
            use $krate::$syntax::Pdf;
            use $krate::vello_cpu::color::palette::css::WHITE;
            use $krate::{render, PixmapSettings, RenderCache, RenderSettings};
            pub struct Doc {
                pdf: Pdf,
            }
            impl Doc {
                pub fn new(data: &[u8]) -> R<Self> {
                    Ok(Self { pdf: Pdf::new(data.to_vec()).map_err(|e| format!("{e:?}"))? })
                }
            }
            impl PdfDoc for Doc {
                fn pages(&self) -> usize {
                    self.pdf.pages().len()
                }
                fn size(&self, i: usize) -> R<(f32, f32)> {
                    Ok(self.pdf.pages()[i].render_dimensions())
                }
                fn render(&self, i: usize, s: f32) -> R<RgbaImage> {
                    let px = render(
                        &self.pdf.pages()[i],
                        &RenderCache::new(),
                        &InterpreterSettings::default(),
                        &RenderSettings::default(),
                        &PixmapSettings { x_scale: s, y_scale: s, bg_color: WHITE },
                    );
                    // white background: premultiplied == straight alpha
                    rgba(px.width() as u32, px.height() as u32, px.data_as_u8_slice().to_vec())
                }
            }
        }
    };
}
#[cfg(feature = "hayro")]
hayro_like!(hayro_doc, hayro, hayro_interpret, hayro_syntax);
// pdf-render forked an older hayro: settings carry the scale, no RenderCache.
#[cfg(feature = "pdfrender")]
mod pdfrender_doc {
    use super::*;
    use pdf_render::pdf_interpret::InterpreterSettings;
    use pdf_render::pdf_syntax::Pdf;
    use pdf_render::vello_cpu::color::palette::css::WHITE;
    use pdf_render::{render, RenderSettings};
    pub struct Doc {
        pdf: Pdf,
    }
    impl Doc {
        pub fn new(data: &[u8]) -> R<Self> {
            Ok(Self { pdf: Pdf::new(data.to_vec()).map_err(|e| format!("{e:?}"))? })
        }
    }
    impl PdfDoc for Doc {
        fn pages(&self) -> usize {
            self.pdf.pages().len()
        }
        fn size(&self, i: usize) -> R<(f32, f32)> {
            Ok(self.pdf.pages()[i].render_dimensions())
        }
        fn render(&self, i: usize, s: f32) -> R<RgbaImage> {
            let rs = RenderSettings { x_scale: s, y_scale: s, bg_color: WHITE, ..Default::default() };
            let px = render(&self.pdf.pages()[i], &InterpreterSettings::default(), &rs);
            rgba(px.width() as u32, px.height() as u32, px.data_as_u8_slice().to_vec())
        }
    }
}

#[cfg(feature = "pdfium")]
mod pdfium_doc {
    use super::*;
    use pdfium_render::prelude::*;
    pub struct Doc {
        doc: PdfDocument<'static>,
    }
    impl Doc {
        pub fn new(data: &[u8]) -> R<Self> {
            // library next to the exe, or $PDFIUM_DIR
            let dir = std::env::var("PDFIUM_DIR").unwrap_or_else(|_| {
                std::env::current_exe().unwrap().parent().unwrap().to_string_lossy().into_owned()
            });
            let b = Pdfium::bind_to_library(Pdfium::pdfium_platform_library_name_at_path(&dir))
                .map_err(|e| format!("pdfium load: {e:?}"))?;
            let p: &'static Pdfium = Box::leak(Box::new(Pdfium::new(b)));
            let bytes: &'static [u8] = Box::leak(data.to_vec().into_boxed_slice());
            Ok(Self { doc: p.load_pdf_from_byte_slice(bytes, None).map_err(|e| format!("{e:?}"))? })
        }
    }
    impl PdfDoc for Doc {
        fn pages(&self) -> usize {
            self.doc.pages().len() as usize
        }
        fn size(&self, i: usize) -> R<(f32, f32)> {
            let p = self.doc.pages().get(i as _).map_err(|e| format!("{e:?}"))?;
            Ok((p.width().value, p.height().value))
        }
        fn render(&self, i: usize, s: f32) -> R<RgbaImage> {
            let p = self.doc.pages().get(i as _).map_err(|e| format!("{e:?}"))?;
            let bm = p
                .render_with_config(&PdfRenderConfig::new().scale_page_by_factor(s).render_form_data(true))
                .map_err(|e| format!("{e:?}"))?;
            rgba(bm.width() as u32, bm.height() as u32, bm.as_rgba_bytes())
        }
    }
}

#[cfg(feature = "mupdf")]
mod mupdf_doc {
    use super::*;
    use mupdf::{Colorspace, Document, Matrix};
    pub struct Doc {
        doc: Document,
    }
    impl Doc {
        pub fn new(data: &[u8]) -> R<Self> {
            Ok(Self { doc: Document::from_bytes(data, "application/pdf").map_err(|e| e.to_string())? })
        }
    }
    impl PdfDoc for Doc {
        fn pages(&self) -> usize {
            self.doc.page_count().unwrap_or(0) as usize
        }
        fn size(&self, i: usize) -> R<(f32, f32)> {
            let b = self.doc.load_page(i as i32).and_then(|p| p.bounds()).map_err(|e| e.to_string())?;
            Ok((b.x1 - b.x0, b.y1 - b.y0))
        }
        fn render(&self, i: usize, s: f32) -> R<RgbaImage> {
            let p = self.doc.load_page(i as i32).map_err(|e| e.to_string())?;
            let pm = p
                .to_pixmap(&Matrix::new_scale(s, s), &Colorspace::device_rgb(), false, true)
                .map_err(|e| e.to_string())?;
            let (w, h, n, st) = (pm.width(), pm.height(), pm.n() as usize, pm.stride() as usize);
            let src = pm.samples();
            let mut out = Vec::with_capacity((w * h * 4) as usize);
            for y in 0..h as usize {
                for x in 0..w as usize {
                    let p = &src[y * st + x * n..];
                    out.extend_from_slice(&[p[0], p[1], p[2], 255]);
                }
            }
            rgba(w, h, out)
        }
    }
}

// ---------- heic ----------

fn heic(engine: &str, data: &[u8]) -> R<RgbaImage> {
    match engine {
        #[cfg(feature = "heicrs")]
        "heicrs" => {
            let o = heic_rs::DecodeOptions { layout: heic_rs::PixelLayout::Rgba8, ..Default::default() };
            let i = heic_rs::decode(data, &o).map_err(|e| e.to_string())?;
            rgba(i.width, i.height, i.data)
        }
        #[cfg(feature = "heic")]
        "heic" => {
            let i = heic::DecoderConfig::new().decode(data, heic::PixelLayout::Rgba8).map_err(|e| format!("{e:?}"))?;
            rgba(i.width, i.height, i.data)
        }
        #[cfg(feature = "heicdec")]
        "heicdec" => {
            let i = heic_decoder::decode(data).map_err(|e| format!("{e:?}"))?;
            let c = i.to_rgba8().map_err(|e| format!("{e:?}"))?;
            rgba(c.width as u32, c.height as u32, c.data)
        }
        #[cfg(feature = "libheif")]
        "libheif" => {
            use libheif_rs::{ColorSpace, HeifContext, LibHeif, RgbChroma};
            let lib = LibHeif::new();
            let ctx = HeifContext::read_from_bytes(data).map_err(|e| e.to_string())?;
            let hd = ctx.primary_image_handle().map_err(|e| e.to_string())?;
            let img = lib.decode(&hd, ColorSpace::Rgb(RgbChroma::Rgba), None).map_err(|e| e.to_string())?;
            let pl = img.planes();
            let p = pl.interleaved.ok_or("no interleaved plane")?;
            let (w, h, st) = (p.width, p.height, p.stride);
            let mut out = Vec::with_capacity((w * h * 4) as usize);
            for y in 0..h as usize {
                out.extend_from_slice(&p.data[y * st..y * st + w as usize * 4]);
            }
            rgba(w, h, out)
        }
        _ => {
            let _ = data;
            Err(format!("heic engine '{engine}' not built in"))
        }
    }
}

// ---------- still (first frame) / svg ----------

fn still(data: &[u8]) -> R<RgbaImage> {
    #[cfg(feature = "still")]
    {
        // load_from_memory decodes the first frame of an animated gif / webp
        return image::load_from_memory(data).map(|i| i.to_rgba8()).map_err(|e| e.to_string());
    }
    #[allow(unreachable_code)]
    {
        let _ = data;
        Err("still not built in".into())
    }
}

fn svg(data: &[u8], max: u32) -> R<RgbaImage> {
    #[cfg(feature = "svg")]
    {
        use resvg::{tiny_skia, usvg};
        let tree = usvg::Tree::from_data(data, &usvg::Options::default()).map_err(|e| e.to_string())?;
        let sz = tree.size();
        let s = max as f32 / sz.width().max(sz.height());
        let (w, h) = (((sz.width() * s).ceil() as u32).max(1), ((sz.height() * s).ceil() as u32).max(1));
        let mut pm = tiny_skia::Pixmap::new(w, h).ok_or("svg too large")?;
        resvg::render(&tree, tiny_skia::Transform::from_scale(s, s), &mut pm.as_mut());
        // tiny-skia is premultiplied; un-premultiply for PNG
        let mut d = pm.take();
        for p in d.chunks_exact_mut(4) {
            let a = p[3] as u32;
            if a > 0 && a < 255 {
                for c in &mut p[..3] {
                    *c = ((*c as u32 * 255 + a / 2) / a).min(255) as u8;
                }
            }
        }
        return rgba(w, h, d);
    }
    #[allow(unreachable_code)]
    {
        let _ = (data, max);
        Err("svg not built in".into())
    }
}
