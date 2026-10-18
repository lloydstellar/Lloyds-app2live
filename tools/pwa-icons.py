# Makes the icons of LA2L Sender as an installed web app (server/public/icon-*.png) from
# tools/logo-600.jpg, the 600 x 600 logo of lloydstellar.nl. Run it again when the logo changes:
# python3 tools/pwa-icons.py (needs Pillow).
# The device's logo (src/ui/la2l-logo-big.png, 120 pixels) is this logo cut round and made
# lighter; the icons are made the same way, so they look the same, only sharp.
from pathlib import Path
from PIL import Image, ImageDraw

root = Path(__file__).resolve().parent.parent
out = root / 'server' / 'public'

source = Image.open(root / 'tools' / 'logo-600.jpg').convert('RGB')
# Lighter as the device's logo: white from 235, and a gamma of 0.7.
source = source.point(lambda v: round(255 * min(1, v / 235) ** 0.7))
# Round: the circle that fills the square, with a smooth edge (drawn 4 times larger).
size = source.width
edge = Image.new('L', (size * 4, size * 4), 0)
ImageDraw.Draw(edge).ellipse((0, 0, size * 4 - 1, size * 4 - 1), fill=255)
logo = source.convert('RGBA')
logo.putalpha(edge.resize((size, size), Image.LANCZOS))

for size in (192, 512):
    # Any shape: the round logo on transparency, edge to edge.
    # 256 colours are plenty for the engraving, and keep the files small.
    small = lambda im: im.quantize(256, method=Image.Quantize.FASTOCTREE)
    small(logo.resize((size, size), Image.LANCZOS)).save(out / f'icon-{size}.png', optimize=True)
    # Maskable: Android may cut the icon to a circle or a rounded square, keeping the middle
    # 80 percent, so the logo sits in that middle on a black square.
    square = Image.new('RGBA', (size, size), (0, 0, 0, 255))
    inner = round(size * 0.8)
    square.alpha_composite(logo.resize((inner, inner), Image.LANCZOS), ((size - inner) // 2, (size - inner) // 2))
    small(square.convert('RGB')).save(out / f'icon-maskable-{size}.png', optimize=True)
