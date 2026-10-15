"""Render the README cover: text-free illustration + real font glyphs.

Requires Pillow. Supply CJK/Latin font paths to render on another platform.
The generated illustration is never asked to draw text or product UI.
"""

from argparse import ArgumentParser
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont, ImageOps


HERE = Path(__file__).resolve().parent
WIDTH, HEIGHT = 2400, 1350


def spaced(draw, text, xy, font, fill, spacing=5):
    x, y = xy
    for character in text:
        draw.text((x, y), character, font=font, fill=fill, anchor="lt")
        x += draw.textlength(character, font=font) + spacing


def main():
    parser = ArgumentParser(description=__doc__)
    parser.add_argument("--title-font", default="/System/Library/Fonts/Supplemental/Songti.ttc")
    parser.add_argument("--body-font", default="/System/Library/Fonts/STHeiti Medium.ttc")
    parser.add_argument("--latin-font", default="/System/Library/Fonts/Supplemental/Arial.ttf")
    parser.add_argument("--output", type=Path, default=HERE / "hero.jpg")
    args = parser.parse_args()

    with Image.open(HERE / "hero-background.png") as source:
        canvas = ImageOps.fit(source.convert("RGB"), (WIDTH, HEIGHT), Image.Resampling.LANCZOS).convert("RGBA")

    # A subtle scrim behind the copy keeps type legible across background variants.
    scrim = Image.new("RGBA", canvas.size)
    shade = ImageDraw.Draw(scrim)
    for x in range(1450):
        opacity = round(76 * max(0, 1 - x / 1450))
        shade.line((x, 0, x, HEIGHT), fill=(8, 15, 10, opacity))
    canvas = Image.alpha_composite(canvas, scrim)
    draw = ImageDraw.Draw(canvas)
    title = ImageFont.truetype(args.title_font, 220)
    heading = ImageFont.truetype(args.body_font, 76)
    body = ImageFont.truetype(args.body_font, 37)
    label = ImageFont.truetype(args.latin_font, 27)
    version = ImageFont.truetype(args.latin_font, 24)

    draw.rounded_rectangle((42, 42, WIDTH - 42, HEIGHT - 42), radius=34,
                           outline=(180, 155, 97, 95), width=2)
    draw.polygon(((116, 130), (124, 138), (116, 146), (108, 138)), fill="#d2b779")
    spaced(draw, "PERSONAL AGENT", (145, 124), label, "#d2b779", 6)
    draw.text((WIDTH - 116, 126), "OPEN SOURCE / 0.8", anchor="rt", font=version, fill="#c5c9b8")

    spaced(draw, "豆豆", (108, 300), title, "#ead9aa", 22)
    draw.text((114, 645), "从一句话开始，", font=heading, fill="#f4f1e7", anchor="lt")
    draw.text((114, 755), "陪你把事情做完。", font=heading, fill="#f4f1e7", anchor="lt")
    draw.text((116, 946), "记住你关心的事，到点继续做。", font=body, fill="#bec8b6", anchor="lt")
    draw.line((116, 1164, 210, 1164), fill="#c9a45c", width=3)
    spaced(draw, "ANDROID  /  macOS  /  SELF-HOSTED", (116, 1201), label, "#d2b779", 3)

    args.output.parent.mkdir(parents=True, exist_ok=True)
    canvas.convert("RGB").save(args.output, "JPEG", quality=95, subsampling=0, optimize=True)
    print(f"Rendered {args.output.name}: {WIDTH}x{HEIGHT}; all lettering uses font glyphs.")


if __name__ == "__main__":
    main()
