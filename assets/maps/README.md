# 本物の地形のマップ

TERRA と LUNA の表面を本物の地球と月に近づけるためのマップを置く場所 (設計: `docs/design-earth-moon.md`)。
ゲームは `src/terrain/maps.js` でここの `<名前>.bin.gz` を読む。形はそのファイルの先頭の説明を見る。

地球の標高・夜の明かりと、月の標高・明るさの 4 つが入っている。土地被覆 (`earth-cover`) はまだない
(元のデータの入手に NASA Earthdata のアカウントが要るため)。それまで TERRA の色と植生は今のノイズの規則のまま。

## 置く予定のマップ

| ファイル | 中身 | 大きさ | 元のデータ (候補) |
|---|---|---|---|
| ファイル | 状態 | 容量 |
|---|---|---|
| `earth-height.bin.gz` 地球の標高・水深 (m、Int16)、4096×2048 | 入っている | 13.1 MB |
| `earth-lights.bin.gz` 夜の明かり (0..1、Uint8)、4096×2048 | 入っている | 0.4 MB |
| `moon-height.bin.gz` 月の標高 (m、Int16)、2048×1024 | 入っている | 3.6 MB |
| `moon-albedo.bin.gz` 月の明るさ (0..1、Uint8)、2048×1024 | 入っている | 1.6 MB |
| `earth-cover.bin.gz` 土地被覆の区分 (MODIS の IGBP 区分の番号、Uint8)、4096×2048 | まだ (候補: NASA MODIS MCD12C1) | — |


## 変える手順

`tools/maps/convert.py` (Python 3、numpy、Pillow が要る) で変える。元の画像は正距円筒図法 (北が上) であること。

入っているマップは、次の引数で作った (元のファイルは下の「出典」)。

```
python tools/maps/convert.py ETOPO_2022_v1_60s_N90W180_surface.tif earth-height --kind height --width 4096
python tools/maps/convert.py BlackMarble_2016_3km_gray_geo.tif     earth-lights --kind lights --width 4096 --percentile 100
python tools/maps/convert.py ldem_16.tif                           moon-height  --kind height --width 2048 --value-scale 1000
python tools/maps/convert.py lroc_color_poles_4k.tif               moon-albedo  --kind albedo --width 2048
python tools/maps/convert.py <土地被覆の画像>                       earth-cover  --kind cover  --width 4096
```

- 4 つとも経度 −180° が左端、北が上なので `--lon0` は要らない。
- `ldem_16.tif` は基準の半径 (1737.4 km) からの高さを km で持つので、`--value-scale 1000` で m にする。
- 夜の明かりは海の上がほとんど 0 なので、上位の画素でそろえず (`--percentile 100`)、元の 0〜255 をそのまま使う。

- 経度 0° が左端の画像は `--lon0 0` を付ける (ゲームの形は経度 −180° が左端)。
- 標高の単位が m でなければ `--value-scale` で直す (例: km なら 1000)。値なしの画素は `--nodata` で 0 にする。
- 区分のマップの名前は `-cover`、夜の明かりは `-lights` で終える (`maps.js` が縮小版を作らないように。明かりは GPU が作る)。

## 出典

どれも米国政府の機関が作った公開データで、使い方の制限はない。NASA の画像は出典の表記を求めている。

- **地球の標高・水深** (`earth-height`): NOAA National Centers for Environmental Information. 2022:
  ETOPO 2022 15 Arc-Second Global Relief Model. https://doi.org/10.25921/fd45-gt74
  (使ったのは 60 秒角の表面標高の GeoTIFF `ETOPO_2022_v1_60s_N90W180_surface.tif`。
  https://www.ncei.noaa.gov/products/etopo-global-relief-model)
- **地球の夜の明かり** (`earth-lights`): NASA Earth Observatory images by Joshua Stevens, using Suomi NPP VIIRS data from
  Miguel Román, NASA's Goddard Space Flight Center. Earth at Night (Black Marble) 2016、
  `BlackMarble_2016_3km_gray_geo.tif` (https://science.nasa.gov/earth/earth-observatory/earth-at-night/maps)
- **月の標高と明るさ** (`moon-height`・`moon-albedo`): NASA's Scientific Visualization Studio, CGI Moon Kit
  (https://svs.gsfc.nasa.gov/4720)。LRO の LOLA (標高) と LROC WAC (色) から作られたもの。
  `ldem_16.tif` と `lroc_color_poles_4k.tif` を使った。
