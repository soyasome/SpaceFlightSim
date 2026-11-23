// 緯度経度と惑星ローカル座標の変換。three.js には依存しない (地形の Worker からも使うため)。
//
// 惑星ローカル座標は Y が自転軸 (北が +Y)。自転は Y 軸まわりの正の回転 (planet.js の updateRotation) で、
// 北極の上から見て反時計回り (本物の地球と同じ向き)。このとき地表は +X から −Z の向きへ動くので、そちらが東。
//
//   ローカル = (cos φ · cos λ,  sin φ,  −cos φ · sin λ)     φ: 緯度 (北が正)、λ: 経度 (東が正)
//
// 符号を間違えると、地図が左右反対になり、太陽が西から昇る (docs/design-earth-moon.md の 3.1)。

const DEG = Math.PI / 180;

/** 緯度・経度 (rad) → 単位ベクトル。out は [x, y, z] (省くと新しく作る)。 */
export function geoToLocalRad(lat, lon, out = [0, 0, 0]) {
  const c = Math.cos(lat);
  out[0] = c * Math.cos(lon);
  out[1] = Math.sin(lat);
  out[2] = -c * Math.sin(lon);
  return out;
}

/** 緯度・経度 (度) → 単位ベクトル。 */
export function geoToLocal(latDeg, lonDeg, out) {
  return geoToLocalRad(latDeg * DEG, lonDeg * DEG, out);
}

/** 単位ベクトル (長さは問わない) → { lat, lon } (rad)。lon は −π..π。 */
export function localToGeoRad(x, y, z) {
  const r = Math.hypot(x, y, z);
  return { lat: Math.asin(Math.max(-1, Math.min(1, y / r))), lon: Math.atan2(-z, x) };
}

/** 単位ベクトル → { lat, lon } (度)。 */
export function localToGeo(x, y, z) {
  const g = localToGeoRad(x, y, z);
  return { lat: g.lat / DEG, lon: g.lon / DEG };
}
