#!/usr/bin/env python3
# 纯蓝单色极简图标：实心蓝圆角磁贴 + 白色描边 2x2 网格（呼应导航栏品牌图形）。
# 无外部依赖，标准库手绘 + 5x5 超采样抗锯齿。
import struct, zlib

W = H = 512

def clamp(v, a, b):
    return max(a, min(b, v))

def rr_inside(px, py, x0, y0, x1, y1, r):
    if px < x0 or px > x1 or py < y0 or py > y1:
        return False
    if px < x0 + r and py < y0 + r:
        return (px - (x0 + r)) ** 2 + (py - (y0 + r)) ** 2 <= r * r
    if px > x1 - r and py < y0 + r:
        return (px - (x1 - r)) ** 2 + (py - (y0 + r)) ** 2 <= r * r
    if px < x0 + r and py > y1 - r:
        return (px - (x0 + r)) ** 2 + (py - (y1 - r)) ** 2 <= r * r
    if px > x1 - r and py > y1 - r:
        return (px - (x1 - r)) ** 2 + (py - (y1 - r)) ** 2 <= r * r
    return True

TILE = (56, 56, 456, 456, 104)
BLUE = (47, 129, 247)        # 纯蓝主色（贴合全局 --blue 主题）
WHITE = (255, 255, 255)

# 2x2 网格（与导航栏品牌图形一致）
GAP = 28
GX0, GY0, GX1, GY1 = 116, 116, 396, 396
cw = (GX1 - GX0 - GAP) // 2
cells = [
    (GX0, GY0, GX0 + cw, GY0 + cw, 24),
    (GX0 + cw + GAP, GY0, GX1, GY0 + cw, 24),
    (GX0, GY0 + cw + GAP, GX0 + cw, GY1, 24),
    (GX0 + cw + GAP, GY0 + cw + GAP, GX1, GY1, 24),
]
STROKE = 22

def sample(px, py):
    # 磁贴底色
    if rr_inside(px, py, *TILE):
        dr, dg, db, da = BLUE[0], BLUE[1], BLUE[2], 255.0
    else:
        dr, dg, db, da = 0.0, 0.0, 0.0, 0.0
    # 白色描边网格
    for (x0, y0, x1, y1, r) in cells:
        outer = rr_inside(px, py, x0, y0, x1, y1, r)
        ri = max(0, r - STROKE)
        inner = rr_inside(px, py, x0 + STROKE, y0 + STROKE, x1 - STROKE, y1 - STROKE, ri)
        if outer and not inner:
            sa = 255.0
            out_a = sa + da * (1 - sa / 255.0)
            if out_a > 0:
                dr = (WHITE[0] * sa + dr * da * (1 - sa / 255.0)) / out_a
                dg = (WHITE[1] * sa + dg * da * (1 - sa / 255.0)) / out_a
                db = (WHITE[2] * sa + db * da * (1 - sa / 255.0)) / out_a
            da = out_a
    return (dr, dg, db, da)

def render(size):
    N = 5
    raw = bytearray()
    for y in range(size):
        row = bytearray()
        for x in range(size):
            R = G = B = A = 0.0
            for sy in range(N):
                for sx in range(N):
                    px = (x + (sx + 0.5) / N) * W / size
                    py = (y + (sy + 0.5) / N) * H / size
                    r, g, b, a = sample(px, py)
                    R += r * a
                    G += g * a
                    B += b * a
                    A += a
            A += 1e-9
            R /= A
            G /= A
            B /= A
            A /= (N * N)
            row += bytes((int(clamp(R, 0, 255)), int(clamp(G, 0, 255)),
                          int(clamp(B, 0, 255)), int(clamp(A, 0, 255))))
        raw += b"\x00" + row
    return bytes(raw)

def write_png(path, size, raw):
    def chunk(typ, data):
        c = struct.pack(">I", len(data)) + typ + data
        crc = zlib.crc32(typ + data) & 0xffffffff
        return c + struct.pack(">I", crc)
    sig = b"\x89PNG\r\n\x1a\n"
    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    idat = zlib.compress(raw, 9)
    with open(path, "wb") as f:
        f.write(sig + chunk(b"IHDR", ihdr) + chunk(b"IDAT", idat) + chunk(b"IEND", b""))

write_png("scripts/icon_source.png", W, render(W))
print("icon written")
