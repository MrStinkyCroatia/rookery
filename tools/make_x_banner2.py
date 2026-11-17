from PIL import Image, ImageDraw, ImageFont, ImageFilter

W, H = 1500, 500
BG, STRIPE = (10, 10, 11), (19, 19, 22)
TX, MU, DIM = (244, 244, 246), (140, 140, 149), (100, 100, 109)
BASE = '/home/user/95359ef5-7be3-4b6b-89f3-63cb34ac24d5/prelaunch'
SANS = '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf'
MONO = '/usr/share/fonts/truetype/liberation/LiberationMono-Regular.ttf'
MONO_B = '/usr/share/fonts/truetype/liberation/LiberationMono-Bold.ttf'
CJK = f'{BASE}/tools/fonts/notosc-700.woff2'

img = Image.new('RGB', (W, H), BG)
d = ImageDraw.Draw(img)
for x in range(0, W, 7):
    d.line([(x, 0), (x, H)], fill=STRIPE, width=1)

# penguin, full bleed on the right, faded into black
peng = Image.open(f'{BASE}/site/assets/penguin/allin.webp').convert('RGB').crop((640, 20, 1344, 700))
pw = int(peng.width * H / peng.height)
peng = peng.resize((pw, H), Image.LANCZOS).convert('L').convert('RGB')
peng = Image.eval(peng, lambda v: int(v * 0.86))
fade = 190
mask = Image.new('L', (pw, H), 255)
md = ImageDraw.Draw(mask)
for i in range(fade):
    md.line([(i, 0), (i, H)], fill=int(255 * (i / fade) ** 1.5))
img.paste(peng, (W - pw, 0), mask)
glow = Image.new('RGB', (W, H), (0, 0, 0))
ImageDraw.Draw(glow).ellipse([W - 620, 40, W - 40, H + 80], fill=(58, 58, 66))
img = Image.blend(img, glow.filter(ImageFilter.GaussianBlur(70)), 0.28)
d = ImageDraw.Draw(img)

def tracked(xy, text, font, fill, tr=0):
    x, y = xy
    for ch in text:
        d.text((x, y), ch, font=font, fill=fill)
        x += d.textlength(ch, font=font) + tr
    return x

x0 = 118
d.text((x0, 36), 'ROOKERY  ·  THE STINKY PENGUIN LAUNCHPAD', font=ImageFont.truetype(MONO, 15), fill=MU)
fh = ImageFont.truetype(SANS, 62)
tracked((x0 - 2, 62), 'ONE PENGUIN.', fh, TX, -2.5)
end = tracked((x0 - 2, 128), 'THREE LAUNCHPADS.', fh, TX, -2.5)
DIV_Y = 212

# three network chips
f_chip = ImageFont.truetype(MONO_B, 14)
f_sub = ImageFont.truetype(MONO, 11)
giwa = Image.open(f'{BASE}/site/assets/giwa.png').convert('RGBA').resize((22, 22), Image.LANCZOS)
stl = Image.open(f'{BASE}/tools/fonts/stellar_mark.png').convert('RGBA').resize((22, 22), Image.LANCZOS)
chips = [('Ø', None, 'ZERO · ZRO', 'PRE-MARKET'), (None, giwa, 'GIWA · ETH', 'PRE-MARKET'), (None, stl, 'STELLAR · XLM', 'LIVE · LP AT $46K')]
cx, cy = x0, 228
for glyph, icon, label, sub in chips:
    tw = d.textlength(label, font=f_chip)
    w = int(10 + 22 + 12 + tw + 16)
    d.rounded_rectangle([cx, cy, cx + w, cy + 40], radius=20, outline=(70, 70, 80), width=1, fill=(16, 16, 19))
    ix, iy = cx + 10, cy + 9
    if icon is not None:
        img.paste(icon, (ix, iy), icon)                    # GIWA logo / Stellar badge as they are
    else:                                                   # Zero: black disc, white Ø, so it never looks like Stellar
        d.ellipse([ix, iy, ix + 22, iy + 22], fill=(0, 0, 0), outline=(200, 200, 206), width=1)
        f0 = ImageFont.truetype(SANS, 15)
        gw = d.textlength(glyph, font=f0)
        d.text((ix + 11 - gw / 2, iy + 2), glyph, font=f0, fill=(255, 255, 255))
    d.text((cx + 44, cy + 12), label, font=f_chip, fill=TX)
    d.text((cx + 6, cy + 48), sub, font=f_sub, fill=(230, 230, 236) if sub.startswith('LIVE') else DIM)
    cx += w + 14

d.line([(x0, DIV_Y), (max(end, cx - 14), DIV_Y)], fill=(62, 62, 72), width=1)
# burn line with real Chinese glyphs
f_burn = ImageFont.truetype(MONO, 13)
f_cjk = ImageFont.truetype(CJK, 15)
bt = '0.5% OF EVERY TRADE BURNS $'
by = 304
d.text((x0, by), bt, font=f_burn, fill=(92, 92, 100))
d.text((x0 + d.textlength(bt, font=f_burn), by - 2), '臭企鹅', font=f_cjk, fill=(92, 92, 100))

out = f'{BASE}/site/assets/brand/x-banner-launchpads-1500x500.png'
img.save(out)
print('saved', out)
