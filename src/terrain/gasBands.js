import { mulberry32 } from '../math/random.js';

/**
 * ガス巨星の縞の色を返す関数を作る。地形のチャンク (Worker) とメインスレッドの両方で使うので、
 * three.js にも DOM にも依存しない。
 * 以前は 128×64 の球の頂点に色を付けていたが、実寸の木星 (半径 7 万 km) では多角形の平らな所が
 * 雲の頂きで 21 km もへこむので、地形と同じ LOD のチャンクで描くようにした (docs/design-real-scale.md の5章)。
 *
 * def = { seed, gas: { bands: [[r,g,b], ...], count, spot? } }
 *   spot = { lat, lon (rad), w, h (経度・緯度方向の半径, rad), color }  大きな渦 (木星の大赤斑のようなもの)
 * @returns (out, x, y, z) => out に色 (リニアRGB, 0..1) を入れる。(x,y,z) は単位ベクトル
 */
export function makeGasColor(def) {
  const rand = mulberry32(def.seed);
  const { bands, count } = def.gas;
  // 縞ごとの色と、境目の位置
  const stripes = [];
  for (let i = 0; i <= count; i++) {
    const c = bands[Math.floor(rand() * bands.length)];
    const k = (0.8 + rand() * 0.4) * 0.5; // 明るい日差しで白く飛ばないよう、暗めにしておく
    stripes.push([c[0] * k, c[1] * k, c[2] * k]);
  }
  const phase = rand() * 10;
  const spot = def.gas.spot;

  return function color(out, x, y, z) {
    const lon = Math.atan2(z, x);
    const lat = Math.asin(Math.max(-1, Math.min(1, y)));
    // 縞を少し波打たせる
    const wobble = Math.sin(lon * 5 + y * 9 + phase) * 0.012 + Math.sin(lon * 11 - phase) * 0.006;
    const t = (lat / Math.PI + 0.5 + wobble) * count;
    const i0 = Math.max(0, Math.min(count - 1, Math.floor(t)));
    let f = t - i0;
    f = f * f * (3 - 2 * f);
    const a = stripes[i0], b = stripes[i0 + 1];
    let r = a[0] + (b[0] - a[0]) * f, g = a[1] + (b[1] - a[1]) * f, bl = a[2] + (b[2] - a[2]) * f;
    if (spot) {
      let dl = lon - spot.lon;
      dl -= Math.round(dl / (2 * Math.PI)) * 2 * Math.PI;
      const e = Math.hypot((dl * Math.cos(lat)) / spot.w, (lat - spot.lat) / spot.h);
      if (e < 1.4) {
        // 中心ほど濃く、縁は明るい輪で縞から切り離す
        const core = 1 - Math.min(1, Math.max(0, (e - 0.55) / 0.45));
        const rim = Math.max(0, 1 - Math.abs(e - 1.05) / 0.25) * 0.35;
        const k = 0.5;
        r = r + (spot.color[0] * k - r) * core + rim * 0.25;
        g = g + (spot.color[1] * k - g) * core + rim * 0.22;
        bl = bl + (spot.color[2] * k - bl) * core + rim * 0.18;
      }
    }
    out[0] = r; out[1] = g; out[2] = bl; out[3] = 0;
    return out;
  };
}
