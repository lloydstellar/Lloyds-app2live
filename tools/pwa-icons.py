# Makes the icons of LA2L Sender as an installed web app (server/public/icon-*.png) from the
# device's logo. Run it again when the logo changes: python3 tools/pwa-icons.py (needs Pillow).
# The logo is 120 pixels, so the larger icons are scaled up; a larger logo makes them sharper.
from pathlib import Path
from PIL import Image

root = Path(__file__).resolve().parent.parent
logo = Image.open(root / 'src' / 'ui' / 'la2l-logo-big.png').convert('RGBA')
out = root / 'server' / 'public'

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
