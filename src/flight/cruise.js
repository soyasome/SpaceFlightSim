/**
 * 巡航モードの速度則。調整するときはここだけ触ればよい。
 *
 * 巡航の最高速は「いちばん近い天体 (惑星の地表、恒星の表面) までの距離」で決まる。
 *   速さ = 倍率 × 通常の最高速 (400 m/s)
 * 天体の近くでは 倍率 = 距離 ÷ nearDiv (距離が 1/e になるのに約 3 秒)。
 * farFrom より遠くでは、それより先の分を farDiv で割って足す (約 1.75 秒で 1/e)。
 * 上限はない。遠ざかるほど速くなるので、惑星間は約 1 分、恒星間 (5 光年) は約 2 分で飛べる。
 */
export const CRUISE = {
  nearDiv: 1200, // 天体の近くでの距離 → 倍率の割り算 (m)
  min: 5, // 倍率の下限 (地表すれすれでも通常の5倍は出る)
  farFrom: 1e6, // これより遠くでは加速を速める (m)
  farDiv: 700, // 遠くでの割り算 (m)
};

/** いちばん近い天体までの距離 d (m) から、巡航の倍率を求める。 */
export function cruiseScale(d) {
  const near = Math.min(d, CRUISE.farFrom) / CRUISE.nearDiv;
  const far = Math.max(0, d - CRUISE.farFrom) / CRUISE.farDiv;
  return Math.max(CRUISE.min, near + far);
}
