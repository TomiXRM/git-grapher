# Draws the hero (docs/media/hero.png), the herdr.dev card (preview.png) and the social preview (docs/media/social.png)
# from the pane screenshot hero-pane.png. Needs Pillow and numpy, and macOS fonts. Run: python3 docs/media/hero.py
from pathlib import Path
import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageFilter
HERE = Path(__file__).resolve().parent

def render(W, H, ts):
    """Text block centred at scale ts, the pane fitted whole on the right."""
    S = lambda v: round(v * ts)
    pane = Image.open(HERE / "hero-pane.png").convert("RGB")
    M = round(H * 0.06); ph = H - 2 * M; pw = round(pane.width * ph / pane.height); pane = pane.resize((pw, ph), Image.LANCZOS)
    HN = "/System/Library/Fonts/HelveticaNeue.ttc"; MONO = "/System/Library/Fonts/SFNSMono.ttf"
    f = lambda s, i=0: ImageFont.truetype(HN, S(s), index=i); m = lambda s: ImageFont.truetype(MONO, S(s))
    bg = Image.new("RGB", (W, H), (9, 9, 12)); d = ImageDraw.Draw(bg)
    for x in range(0, W, 64): d.line((x, 0, x, H), fill=(15, 15, 20))
    for y in range(0, H, 64): d.line((0, y, W, y), fill=(15, 15, 20))
    sx, sy = W / 2560, H / 1600
    glow = Image.new("RGB", (W, H)); g = ImageDraw.Draw(glow)
    for e, c in (((1500, -300, 2900, 900), (70, 56, 0)), ((1700, 900, 3000, 2000), (0, 40, 90)), ((-500, 900, 700, 2000), (40, 10, 60))):
        g.ellipse((e[0] * sx, e[1] * sy, e[2] * sx, e[3] * sy), fill=c)
    bg = Image.fromarray(np.clip(np.asarray(bg).astype(int) + np.asarray(glow.filter(ImageFilter.GaussianBlur(240 * sy))).astype(int), 0, 255).astype("uint8"))
    d = ImageDraw.Draw(bg)
    d.arc((1250 * sx, 150 * sy, 2950 * sx, 1850 * sy), 150, 320, fill=(60, 52, 20), width=3); d.arc((1050 * sx, -50 * sy, 3150 * sx, 2050 * sy), 160, 300, fill=(28, 34, 60), width=3)
    X = round(110 * sx); T = round((H - S(1108)) / 2)  # text block is 1108 tall at scale 1
    Y = lambda v: T + S(v)
    a, b = "Herdr mod", "git graph · diff · commit · merge"; fa, fb = f(28, 1), m(26)
    wa, wb = d.textlength(a, font=fa), d.textlength(b, font=fb); pwid = S(8 + 20) + wa + S(20 + 22) + wb + S(30)
    d.rounded_rectangle((X, Y(0), X + pwid, Y(62)), S(31), fill=(18, 18, 24), outline=(48, 48, 58), width=2)
    d.rounded_rectangle((X + S(8), Y(8), X + S(8) + wa + S(40), Y(54)), S(23), fill=(54, 46, 8)); d.text((X + S(28), Y(14)), a, font=fa, fill=(255, 220, 70))
    d.text((X + S(8) + wa + S(62), Y(16)), b, font=fb, fill=(170, 170, 182))
    s = S(116); ic = Image.new("RGB", (116, 116)); idr = ImageDraw.Draw(ic)
    for yy in range(116): idr.line((0, yy, 116, yy), fill=(255, int(214 - 70 * yy / 116), int(10 + 30 * yy / 116)))
    ink = (20, 16, 0)
    idr.line((38, 26, 38, 90), fill=ink, width=9); idr.line((38, 60, 78, 44), fill=ink, width=9); idr.line((78, 44, 78, 30), fill=ink, width=9)
    for cx, cy in ((38, 26), (38, 90), (78, 30)): idr.ellipse((cx - 12, cy - 12, cx + 12, cy + 12), fill=ink); idr.ellipse((cx - 5, cy - 5, cx + 5, cy + 5), fill=(255, 200, 20))
    ic = ic.resize((s, s), Image.LANCZOS); msk = Image.new("L", (s, s), 0); ImageDraw.Draw(msk).rounded_rectangle((0, 0, s, s), S(28), fill=255)
    bg.paste(ic, (X, Y(120)), msk)
    d.text((X + s + S(36), Y(138)), "Git Grapher", font=f(76, 1), fill=(255, 255, 255))
    d.text((X, Y(310)), "Every branch, at a glance.", font=f(80, 1), fill=(255, 255, 255))
    t2 = "Right beside your agents."; f2 = f(80, 1); tw = int(d.textlength(t2, font=f2)); gm = Image.new("L", (tw + 8, S(120)), 0); ImageDraw.Draw(gm).text((0, 0), t2, font=f2, fill=255)
    grad = Image.new("RGB", gm.size); gd = ImageDraw.Draw(grad)
    for xx in range(gm.width):
        u = xx / gm.width; c0, c1, c2 = (255, 214, 0), (255, 146, 48), (255, 55, 95)
        c = [round(c0[i] + (c1[i] - c0[i]) * u * 2) if u < .5 else round(c1[i] + (c2[i] - c1[i]) * (u - .5) * 2) for i in range(3)]; gd.line((xx, 0, xx, gm.height), fill=tuple(c))
    bg.paste(grad, (X, Y(408)), gm)
    y = 570
    for line in ["A git client in a Herdr pane. Watch commits land while your", "agents work, read any diff, and commit from the graph.", "Everything it does is your own git."]:
        d.text((X, Y(y)), line, font=f(37), fill=(172, 172, 184)); y += 56
    y = 800
    for a, b in [("Live graph", "updates as agents commit"), ("Worktrees and stashes", "as rows on top of the graph"), ("Diff and file history", "split view, syntax colours"), ("AI commit messages", "written from the staged diff")]:
        d.rounded_rectangle((X, Y(y), X + S(56), Y(y + 56)), S(14), fill=(22, 22, 28), outline=(50, 50, 60), width=2); d.ellipse((X + S(20), Y(y + 20), X + S(36), Y(y + 36)), fill=(255, 214, 0))
        d.text((X + S(84), Y(y + 8)), a, font=f(38, 1), fill=(240, 240, 244)); d.text((X + S(84) + d.textlength(a, font=f(38, 1)) + S(28), Y(y + 14)), b, font=m(30), fill=(140, 140, 152)); y += 84
    px, py, r = W - pw - round(70 * sx), M, round(30 * sy)
    sh = Image.new("RGBA", (W, H), (0, 0, 0, 0)); ImageDraw.Draw(sh).rounded_rectangle((px - 10, py + 30, px + pw + 10, py + ph + 30), r, fill=(0, 0, 0, 210))
    bg = Image.alpha_composite(bg.convert("RGBA"), sh.filter(ImageFilter.GaussianBlur(46)))
    pm = Image.new("L", pane.size, 0); ImageDraw.Draw(pm).rounded_rectangle((0, 0, pw, ph), r, fill=255); bg.paste(pane, (px, py), pm)
    ImageDraw.Draw(bg).rounded_rectangle((px, py, px + pw, py + ph), r, outline=(74, 74, 82), width=2)
    return bg.convert("RGB")

hero = render(2560, 1600, 1.0)
hero.save(HERE / "hero.png", optimize=True)
hero.resize((1600, 1000), Image.LANCZOS).save(HERE.parent.parent / "preview.png", optimize=True)
render(2560, 1280, 0.9).resize((1280, 640), Image.LANCZOS).save(HERE / "social.png", optimize=True)  # GitHub: 2:1, under 1 MB
