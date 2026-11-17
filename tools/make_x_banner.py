from PIL import Image, ImageDraw, ImageFont, ImageFilter

W, H = 1500, 500
BG = (10, 10, 11)
STRIPE = (19, 19, 22)
TX = (244, 244, 246)
MU = (140, 140, 149)
DIM = (108, 108, 117)

SANS = '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf'
MONO = '/usr/share/fonts/truetype/liberation/LiberationMono-Regular.ttf'
BASE = '/home/user/95359ef5-7be3-4b6b-89f3-63cb34ac24d5/prelaunch/site'

img = Image.new('RGB', (W, H), BG)
d = ImageDraw.Draw(img)
for x in range(0, W, 7):
    d.line([(x, 0), (x, H)], fill=STRIPE, width=1)

# ── right: penguin photo, full bleed, faded into the background on its left ──
peng = Image.open(f'{BASE}/assets/penguin/allin.webp').convert('RGB')
# crop out every piece of baked-in text: keep only the character, chair and chips
peng = peng.crop((640, 20, 1344, 700))
ph = H
pw = int(peng.width * ph / peng.height)
peng = peng.resize((pw, ph), Image.LANCZOS).convert('L').convert('RGB')
peng = Image.eval(peng, lambda v: int(v * 0.86))          # settle it onto the black canvas

px = W - pw
fade = 170                                                # width of the blend into black
mask = Image.new('L', (pw, ph), 255)
md = ImageDraw.Draw(mask)
for i in range(fade):
    md.line([(i, 0), (i, ph)], fill=int(255 * (i / fade) ** 1.5))
img.paste(peng, (px, 0), mask)

# soft glow behind the character
glow = Image.new('RGB', (W, H), (0, 0, 0))
ImageDraw.Draw(glow).ellipse([W - 620, 40, W - 40, H + 80], fill=(58, 58, 66))
glow = glow.filter(ImageFilter.GaussianBlur(70))
img = Image.blend(img, glow, 0.30)
d = ImageDraw.Draw(img)

# ── left: wordmark ──
def tracked(draw, xy, text, font, fill, tracking=0):
    x, y = xy
    for ch in text:
        draw.text((x, y), ch, font=font, fill=fill)
        x += draw.textlength(ch, font=font) + tracking
    return x

f_word = ImageFont.truetype(SANS, 100)
x0, y0 = 120, 76
end = tracked(d, (x0, y0), 'ROOKERY', f_word, TX, tracking=-3.5)

# hairline spanning the full wordmark
d.line([(x0 + 3, y0 + 132), (end - 4, y0 + 132)], fill=(62, 62, 72), width=1)

f_sub = ImageFont.truetype(MONO, 16)
f_tag = ImageFont.truetype(MONO, 15)
d.text((x0 + 3, y0 + 152), 'THE STINKY PENGUIN LAUNCHPAD', font=f_sub, fill=MU)

# chains row with the Stellar badge inline, centred on the text
ty = y0 + 186
tb = d.textbbox((0, 0), 'ZRO  ·  ETH  ·  XLM', font=f_tag)
cap_h = tb[3] - tb[1]
box = 21
by = ty + tb[1] + cap_h // 2 - box // 2
mark = Image.open('/tmp/stellar_mark.png').convert('RGBA')
d.rounded_rectangle([x0 + 3, by, x0 + 3 + box, by + box], radius=6, fill=(255, 255, 255))
m2 = mark.resize((15, 15), Image.LANCZOS)
img.paste(m2, (x0 + 3 + (box - 15) // 2, by + (box - 15) // 2), m2)
d = ImageDraw.Draw(img)
d.text((x0 + 3 + box + 10, ty), 'ZRO  ·  ETH  ·  XLM', font=f_tag, fill=DIM)

# fills the middle of the frame with something that means something
f_burn = ImageFont.truetype(MONO, 13)
f_cjk = ImageFont.truetype('/tmp/notosc.otf', 15)
bt = '0.5% OF EVERY TRADE BURNS $'
d.text((x0 + 3, ty + 44), bt, font=f_burn, fill=(88, 88, 96))
bw = d.textlength(bt, font=f_burn)
d.text((x0 + 3 + bw, ty + 42), '臭企鹅', font=f_cjk, fill=(88, 88, 96))

img.save(f'{BASE}/assets/brand/x-banner-1500x500.png')
print('saved', img.size)
