from PIL import Image, ImageDraw, ImageFont, ImageFilter

W, H = 2400, 1350
BG, STRIPE = (10, 10, 11), (18, 18, 21)
TX, MU, DIM = (244, 244, 246), (150, 150, 158), (105, 105, 114)
S = '/home/user/95359ef5-7be3-4b6b-89f3-63cb34ac24d5/prelaunch'
SANS = '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf'
MONO = '/usr/share/fonts/truetype/liberation/LiberationMono-Regular.ttf'
MONO_B = '/usr/share/fonts/truetype/liberation/LiberationMono-Bold.ttf'

img = Image.new('RGB', (W, H), BG)
d = ImageDraw.Draw(img)
for x in range(0, W, 9):
    d.line([(x, 0), (x, H)], fill=STRIPE, width=1)

# soft glow behind the screenshot column
glow = Image.new('RGB', (W, H), (0, 0, 0))
ImageDraw.Draw(glow).ellipse([1500, -100, 2450, 1450], fill=(52, 52, 58))
img = Image.blend(img, glow.filter(ImageFilter.GaussianBlur(140)), 0.35)
d = ImageDraw.Draw(img)

def tracked(xy, text, font, fill, tr=0):
    x, y = xy
    for ch in text:
        d.text((x, y), ch, font=font, fill=fill)
        x += d.textlength(ch, font=font) + tr
    return x

X = 110
d.text((X, 92), 'ROOKERY  ·  STELLAR', font=ImageFont.truetype(MONO, 21), fill=MU)

fh = ImageFont.truetype(SANS, 84)
tracked((X - 3, 140), 'BUY STRAIGHT', fh, TX, -3.2)
end = tracked((X - 3, 232), 'FROM YOUR WALLET', fh, TX, -3.2)
d.line([(X, 352), (end, 352)], fill=(64, 64, 74), width=2)

fsub = ImageFont.truetype(MONO, 21)
d.text((X, 384), 'No deposit. No email. One signature and the token is yours.', font=fsub, fill=(176, 176, 184))

fstep_n = ImageFont.truetype(MONO_B, 22)
fstep = ImageFont.truetype(SANS, 30)
steps = [('01', 'Connect Freighter, xBull, Albedo, Rabet or Lobstr'),
         ('02', 'Type the XLM amount and hit Buy from wallet'),
         ('03', 'Sign the payment. Tokens land in about a minute')]
y = 470
for n, t in steps:
    d.rounded_rectangle([X, y + 2, X + 46, y + 40], radius=10, outline=(60, 60, 70), width=1, fill=(15, 15, 18))
    tw = d.textlength(n, font=fstep_n)
    d.text((X + 23 - tw / 2, y + 9), n, font=fstep_n, fill=(200, 200, 208))
    d.text((X + 66, y + 5), t, font=fstep, fill=(214, 214, 220))
    y += 72

d.text((X, 980), 'WALLETS', font=ImageFont.truetype(MONO, 18), fill=MU)
fchip = ImageFont.truetype(MONO_B, 19)
cx, cy = X, 1016
for name in ['FREIGHTER', 'XBULL', 'ALBEDO', 'RABET', 'LOBSTR · WALLETCONNECT']:
    w = int(d.textlength(name, font=fchip) + 34)
    d.rounded_rectangle([cx, cy, cx + w, cy + 44], radius=22, outline=(72, 72, 82), width=1, fill=(16, 16, 19))
    d.text((cx + 17, cy + 12), name, font=fchip, fill=TX)
    cx += w + 12
    if cx > 1150:
        cx, cy = X, cy + 56

# the proof: a real screenshot from production (Stellar token page)
panel = Image.open('/tmp/hermes/screenshots/buy_panel.png').convert('RGB')
ph = 1230
panel = panel.resize((int(panel.width * ph / panel.height), ph), Image.LANCZOS)
px = 1520
img.paste(panel, (px, 60), None)
d.rectangle([px, 60, px + panel.width, 60 + ph], outline=(58, 58, 68), width=2)
d.text((px, 60 + ph + 16), 'LIVE ON ROOKERY  ·  STELLAR TOKEN PAGE', font=ImageFont.truetype(MONO, 16), fill=MU)

out = f'{S}/site/assets/brand/x-buy-from-wallet-2400x1350.png'
img.save(out)
print('saved', out, img.size)
