#!/usr/bin/env python3
"""
Generates the Tone Art Studio brand assets: the app mark at every size Windows
asks for, the multi-resolution .ico used by the executable, shortcut, installer
and uninstaller, and the two Inno Setup wizard bitmaps.

Run from the repository root:

    python3 assets/brand/generate-icons.py

The mark is five console-meter bars - four in warm cream, the centre one a
rose-to-amber gradient - on the same dark rounded tile the app uses. It reads
as a level meter at a glance, stays legible at 16 px in the taskbar, and the
single lit bar is the one detail that survives at that size.
"""

from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parent
FONT_DIR = Path("/tmp/sys/root/usr/share/fonts/truetype/dejavu")
FONT_BOLD = FONT_DIR / "DejaVuSans-Bold.ttf"
FONT_REGULAR = FONT_DIR / "DejaVuSans.ttf"

ROSE = (244, 63, 94)
ROSE_SOFT = (255, 138, 158)
CREAM = (244, 233, 214)
AMBER = (245, 165, 36)
BG_TOP = (22, 26, 35)
BG_BOTTOM = (10, 12, 17)

SCALE = 4
BASE = 1024

# The five meter bars, in 0..1 of the tile: (centre x, height). The tallest bar
# sits in the middle and the pair either side decays, like a note measured on a
# console. Width and heights are shared with the SVG below.
BARS = [(0.23, 0.297), (0.365, 0.475), (0.5, 0.74), (0.635, 0.5625), (0.77, 0.385)]
BAR_WIDTH = 0.0996
ACCENT = 2
TILE_RADIUS = 0.225


def font(size: int, bold: bool = True) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(str(FONT_BOLD if bold else FONT_REGULAR), size)


def rounded(draw: ImageDraw.ImageDraw, box, radius, fill):
    draw.rounded_rectangle(box, radius=radius, fill=fill)


def tile(edge: int) -> Image.Image:
    """The dark rounded body every mark is painted onto."""
    canvas = Image.new("RGBA", (edge, edge), (0, 0, 0, 0))
    draw = ImageDraw.Draw(canvas)

    body = Image.new("RGBA", (edge, edge), (0, 0, 0, 0))
    body_draw = ImageDraw.Draw(body)
    for y in range(edge):
        blend = y / edge
        color = tuple(round(BG_TOP[i] * (1 - blend) + BG_BOTTOM[i] * blend) for i in range(3))
        body_draw.line([(0, y), (edge, y)], fill=color + (255,))
    mask = Image.new("L", (edge, edge), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, edge - 1, edge - 1], radius=int(edge * TILE_RADIUS), fill=255)
    canvas.alpha_composite(Image.composite(body, Image.new("RGBA", (edge, edge), (0, 0, 0, 0)), mask))

    # A rose light sits above the bars, as if the console were lit from the top.
    glow = Image.new("RGBA", (edge, edge), (0, 0, 0, 0))
    ImageDraw.Draw(glow).ellipse([edge * 0.02, -edge * 0.30, edge * 0.98, edge * 0.42], fill=ROSE + (82,))
    glow = glow.filter(ImageFilter.GaussianBlur(edge * 0.10))
    glow.putalpha(ImageChops.multiply(glow.getchannel("A"), mask))
    canvas.alpha_composite(glow)

    draw.rounded_rectangle(
        [edge * 0.004, edge * 0.004, edge * 0.996, edge * 0.996],
        radius=int(edge * TILE_RADIUS),
        outline=ROSE + (125,),
        width=max(2, int(edge * 0.0065)),
    )
    return canvas


def bar_box(edge: int, index: int) -> tuple[float, float, float, float]:
    centre, height = BARS[index]
    width = BAR_WIDTH * edge
    left = (centre * edge) - width / 2
    top = (0.5 - height / 2) * edge
    return left, top, left + width, top + height * edge


def bar_mask(edge: int, indices) -> Image.Image:
    mask = Image.new("L", (edge, edge), 0)
    draw = ImageDraw.Draw(mask)
    for index in indices:
        box = bar_box(edge, index)
        rounded(draw, box, (box[2] - box[0]) / 2, 255)
    return mask


def accent_gradient(edge: int) -> Image.Image:
    """Rose at the top of the lit bar, amber at the bottom.

    The ramp is a smooth two-colour blend, so it is painted once at the working
    resolution and stretched: computing it per pixel at 4096 px is needlessly
    slow and looks identical.
    """
    left, top, right, bottom = (int(round(v)) for v in bar_box(edge, ACCENT))
    ramp = Image.new("RGBA", (1, max(1, bottom - top)))
    pixels = ramp.load()
    for y in range(ramp.height):
        blend = y / max(1, ramp.height - 1)
        pixels[0, y] = tuple(round(ROSE[i] * (1 - blend) + AMBER[i] * blend) for i in range(3)) + (255,)
    gradient = Image.new("RGBA", (edge, edge), (0, 0, 0, 0))
    gradient.paste(ramp.resize((max(1, right - left), ramp.height), Image.BILINEAR), (left, top))
    return gradient


def mark(size: int) -> Image.Image:
    """The square app mark, anti-aliased by drawing large and downsampling."""
    edge = min(BASE * SCALE, max(BASE, size * SCALE))
    canvas = tile(edge)

    cream = Image.new("RGBA", (edge, edge), CREAM + (255,))
    others = [i for i in range(len(BARS)) if i != ACCENT]
    canvas.alpha_composite(Image.composite(cream, Image.new("RGBA", (edge, edge), (0, 0, 0, 0)), bar_mask(edge, others)))
    canvas.alpha_composite(
        Image.composite(accent_gradient(edge), Image.new("RGBA", (edge, edge), (0, 0, 0, 0)), bar_mask(edge, [ACCENT]))
    )

    return canvas.resize((size, size), Image.LANCZOS)


def wordmark(width: int, height: int) -> Image.Image:
    """Installer wizard panel: mark, product name and a thin rose rule."""
    image = Image.new("RGB", (width, height), (15, 18, 25))
    draw = ImageDraw.Draw(image)
    for y in range(height):
        blend = y / height
        color = tuple(round(BG_TOP[i] * (1 - blend * 0.85) + BG_BOTTOM[i] * (blend * 0.85)) for i in range(3))
        draw.line([(0, y), (width, y)], fill=color)

    # soft glow at the top, blurred so its edge never shows
    glow = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    ImageDraw.Draw(glow).ellipse([-width * 0.4, -height * 0.22, width * 1.4, height * 0.4], fill=ROSE + (60,))
    glow = glow.filter(ImageFilter.GaussianBlur(width * 0.18))
    image.paste(Image.alpha_composite(image.convert("RGBA"), glow).convert("RGB"), (0, 0))

    logo = mark(int(width * 0.52))
    image.paste(logo, (int(width * 0.24), int(height * 0.13)), logo)

    draw = ImageDraw.Draw(image)
    title = "TONE ART"
    subtitle = "STUDIO"
    title_font = font(max(15, int(width * 0.088)))
    sub_font = font(max(10, int(width * 0.072)))

    title_w = draw.textlength(title, font=title_font)
    sub_w = draw.textlength(subtitle, font=sub_font)
    draw.text(((width - title_w) / 2, height * 0.44), title, font=title_font, fill=CREAM)
    draw.text(((width - sub_w) / 2, height * 0.53), subtitle, font=sub_font, fill=ROSE_SOFT)

    rule_y = int(height * 0.63)
    draw.line([(width * 0.18, rule_y), (width * 0.82, rule_y)], fill=ROSE + (170,), width=1)

    small = font(max(8, int(width * 0.048)), bold=False)
    for index, line in enumerate(("ASIO · VST3", "48 kHz studio")):
        line_w = draw.textlength(line, font=small)
        draw.text(((width - line_w) / 2, height * 0.67 + index * height * 0.045), line, font=small, fill=(154, 161, 175))

    return image


def icon_small(width: int, height: int) -> Image.Image:
    image = Image.new("RGB", (width, height), (13, 15, 21))
    logo = mark(int(width * 0.86))
    image.paste(logo, ((width - logo.width) // 2, (height - logo.height) // 2), logo)
    return image


SVG = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" role="img" aria-label="Tone Art Studio">
  <defs>
    <linearGradient id="body" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#161a23"/>
      <stop offset="1" stop-color="#0a0c11"/>
    </linearGradient>
    <radialGradient id="glow" cx="0.5" cy="0.05" r="0.75">
      <stop offset="0" stop-color="#f43f5e" stop-opacity="0.32"/>
      <stop offset="1" stop-color="#f43f5e" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="accent" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#f43f5e"/>
      <stop offset="1" stop-color="#f5a524"/>
    </linearGradient>
  </defs>
  <rect x="2" y="2" width="508" height="508" rx="114" fill="url(#body)" stroke="#f43f5e" stroke-opacity="0.49" stroke-width="3.4"/>
  <rect x="2" y="2" width="508" height="508" rx="114" fill="url(#glow)"/>
  <rect x="92.5" y="180" width="51" height="152" rx="25.5" fill="#f4e9d6"/>
  <rect x="161.5" y="134.5" width="51" height="243" rx="25.5" fill="#f4e9d6"/>
  <rect x="230.5" y="66.5" width="51" height="379" rx="25.5" fill="url(#accent)"/>
  <rect x="299.5" y="112" width="51" height="288" rx="25.5" fill="#f4e9d6"/>
  <rect x="368.5" y="157.5" width="51" height="197" rx="25.5" fill="#f4e9d6"/>
</svg>
"""


def main() -> None:
    ROOT.mkdir(parents=True, exist_ok=True)

    (ROOT / "tone-art-logo.svg").write_text(SVG)

    sizes = [16, 24, 32, 48, 64, 128, 256, 512, 1024]
    marks = {size: mark(size) for size in sizes}
    for size in sizes:
        marks[size].save(ROOT / f"tone-art-{size}.png")

    marks[256].save(
        ROOT / "tone-art.ico",
        sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
    )

    wordmark(164, 314).save(ROOT / "wizard-large.bmp", format="BMP")
    icon_small(58, 58).save(ROOT / "wizard-small.bmp", format="BMP")

    # The same mark is the app's thumbnail: browser tab, bookmark, phone home
    # screen and the desktop window. Vite copies public/ verbatim into dist/,
    # and the native host serves dist/ from its resource provider root.
    public = ROOT.parents[1] / "public"
    public.mkdir(parents=True, exist_ok=True)
    (public / "logo.svg").write_text(SVG)
    for size, name in (
        (16, "favicon-16.png"),
        (32, "favicon-32.png"),
        (180, "apple-touch-icon.png"),
        (192, "icon-192.png"),
        (512, "icon-512.png"),
    ):
        mark(size).save(public / name)

    print("wrote:", ", ".join(sorted(p.name for p in ROOT.glob("tone-art-*"))))
    print("wrote: wizard-large.bmp, wizard-small.bmp")
    print("wrote:", ", ".join(sorted(p.name for p in public.glob("*"))))


if __name__ == "__main__":
    main()
