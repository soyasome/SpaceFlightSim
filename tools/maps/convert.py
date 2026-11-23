"""本物の地形のマップを、ゲームが読む形 (assets/maps/<名前>.bin.gz) に変える道具。

使い方の例 (データの入手先と、それぞれの引数は assets/maps/README.md):

    python tools/maps/convert.py 元の画像.tif earth-height --kind height --width 4096
    python tools/maps/convert.py 元の画像.tif earth-cover  --kind cover  --width 4096
    python tools/maps/convert.py 元の画像.tif moon-albedo  --kind albedo --width 2048

- 元の画像は Pillow で読める形 (GeoTIFF の多く、PNG、JPEG) か、numpy の .npy。
  正距円筒図法 (横が経度 360°、縦が緯度 180°、北が上) であること。
- 経度 0° が左端の画像は --lon0 0 を付ける (ゲームの形は経度 −180° が左端なので、半分ずらす)。
- 出力の形は src/terrain/maps.js の先頭の説明を見る (32 バイトの見出し + 画素の並びを gzip)。

必要なもの: Python 3、numpy、Pillow。ゲームを動かすだけなら要らない (変換後のファイルをリポジトリに入れる)。
"""
import argparse
import gzip
import struct
import sys
from pathlib import Path

import numpy as np
from PIL import Image

Image.MAX_IMAGE_PIXELS = None  # 全球のデータは大きいので、Pillow の大きさの上限を外す

OUT_DIR = Path(__file__).resolve().parents[2] / 'assets' / 'maps'
TYPE_INT16, TYPE_UINT8 = 1, 2


def read_image(path):
    """画像を 2 次元の配列として読む (色付きなら明るさにする)。"""
    if path.suffix == '.npy':
        a = np.load(path)
    else:
        img = Image.open(path)
        if img.mode in ('RGB', 'RGBA', 'P', 'LA'):
            img = img.convert('L')
        a = np.array(img)
    if a.ndim == 3:
        a = a.mean(axis=2)
    return a


def resample(a, width, categorical):
    """幅 width (高さはその半分) に縮める。区分の番号は補間せず、ほかは画素の平均を取る。"""
    height = width // 2
    h, w = a.shape
    if categorical:
        # 最も近い画素 (区分の番号を混ぜない)
        ys = ((np.arange(height) + 0.5) * h / height).astype(int)
        xs = ((np.arange(width) + 0.5) * w / width).astype(int)
        return a[np.ix_(ys, xs)]
    if h % height == 0 and w % width == 0:
        fy, fx = h // height, w // width
        return a.astype(np.float64).reshape(height, fy, width, fx).mean(axis=(1, 3))
    img = Image.fromarray(a.astype(np.float32), mode='F')
    return np.array(img.resize((width, height), Image.BOX), dtype=np.float64)


def write_map(name, data, type_code, scale, offset):
    """見出しを付けて gzip で書き出す。"""
    h, w = data.shape
    header = b'SFMP' + struct.pack('<HHIIff', 1, type_code, w, h, scale, offset) + b'\0' * 8
    assert len(header) == 32
    dtype = '<i2' if type_code == TYPE_INT16 else 'u1'
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    out = OUT_DIR / f'{name}.bin.gz'
    with gzip.open(out, 'wb', compresslevel=9) as f:
        f.write(header)
        f.write(np.ascontiguousarray(data).astype(dtype).tobytes())
    return out


def main(argv=None):
    p = argparse.ArgumentParser(description='本物の地形のマップを assets/maps/<名前>.bin.gz に変える')
    p.add_argument('input', type=Path, help='元の画像 (正距円筒図法、北が上)')
    p.add_argument('name', help='出力の名前 (例: earth-height)。区分のマップは -cover で終える')
    p.add_argument('--kind', required=True, choices=['height', 'cover', 'albedo', 'lights'],
                   help='height: 標高 (m、Int16) / cover: 区分の番号 (Uint8) / albedo・lights: 明るさ (0..1、Uint8)')
    p.add_argument('--width', type=int, required=True, help='出力の幅 (高さはその半分)')
    p.add_argument('--lon0', type=float, default=-180, help='元の画像の左端の経度 (度)。0 なら半分ずらす')
    p.add_argument('--value-scale', type=float, default=1.0, help='元の値に掛ける数 (標高の単位を m にするなど)')
    p.add_argument('--nodata', type=float, default=None, help='値なしを表す数 (0 として扱う)')
    p.add_argument('--percentile', type=float, default=99.5,
                   help='明るさのマップで、これより上の画素を 1 にそろえる (外れた明るい画素で全体が暗くならないように)')
    args = p.parse_args(argv)

    if args.kind == 'cover' and not args.name.endswith('-cover'):
        sys.exit('区分のマップの名前は -cover で終える (maps.js が縮小版を作らないように)')

    a = read_image(args.input)
    if args.nodata is not None:
        a = np.where(a == args.nodata, 0, a)
    if args.lon0 != -180:
        shift = int(round((args.lon0 + 180) / 360 * a.shape[1]))
        a = np.roll(a, shift, axis=1)
    a = resample(a, args.width, args.kind == 'cover')

    if args.kind == 'height':
        data = np.clip(np.round(a * args.value_scale), -32768, 32767)
        out = write_map(args.name, data, TYPE_INT16, 1.0, 0.0)
    elif args.kind == 'cover':
        out = write_map(args.name, np.clip(a, 0, 255), TYPE_UINT8, 1.0, 0.0)
    else:
        v = a * args.value_scale
        top = np.percentile(v, args.percentile) or 1.0
        data = np.clip(np.round(v / top * 255), 0, 255)
        out = write_map(args.name, data, TYPE_UINT8, 1 / 255, 0.0)

    print(f'{out} ({out.stat().st_size / 1e6:.2f} MB, {args.width}×{args.width // 2}, '
          f'値 {float(a.min()):.1f}〜{float(a.max()):.1f})')


if __name__ == '__main__':
    main()
