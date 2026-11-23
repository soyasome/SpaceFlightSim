import * as THREE from 'three';
import { getMap } from '../terrain/maps.js';

/**
 * 大気散乱 (レイリー散乱 + ミー散乱) の共通 GLSL。
 * 空 (大気の殻) と地表の両方のシェーダーで同じ計算を使うので、
 * 宇宙から見た青い縁・昼の空・夕焼け・遠景のかすみが一つのモデルでつながる。
 *
 * 座標はすべて「カメラが原点」の描画座標 (m)。
 */
const ATMOSPHERE_GLSL = /* glsl */ `
uniform vec3 uPlanetCenter; // カメラから見た惑星中心
uniform float uRp;          // 惑星半径 (海面)
uniform float uRa;          // 大気の上端の半径
uniform vec3 uSunDir;       // 太陽の方向 (単位ベクトル)
uniform float uSunI;        // 太陽光の強さ
uniform vec3 uBetaR;        // レイリー散乱係数 (1/m)
uniform float uBetaM;       // ミー散乱係数 (1/m)
uniform float uHR;          // レイリーのスケールハイト (m)
uniform float uHM;          // ミーのスケールハイト (m)

// 球との交差。o は球の中心から見た始点。
// 大きな数どうしの引き算を避けるため、最接近点を経由して求める。
bool raySphere(vec3 o, vec3 d, float r, out float t0, out float t1) {
  float tca = -dot(o, d);
  vec3 perp = o + d * tca;
  float d2 = dot(perp, perp);
  float r2 = r * r;
  if (d2 > r2) return false;
  float thc = sqrt(r2 - d2);
  t0 = tca - thc;
  t1 = tca + thc;
  return true;
}

// 高度 h での大気密度 (x: レイリー, y: ミー)。
// 地面より下も濃い大気として扱うことで、惑星の影 (夜側) が滑らかに暗くなる。
vec2 atmoDensity(float h) {
  return exp(-max(h, -3.0 * uHR) / vec2(uHR, uHM));
}

// 点 p (惑星中心から見た位置) から太陽方向への光学的深さ
vec2 lightDepth(vec3 p) {
  float t0, t1;
  if (!raySphere(p, uSunDir, uRa, t0, t1) || t1 <= 0.0) return vec2(0.0);
  float ds = t1 / float(LIGHT_STEPS);
  vec2 od = vec2(0.0);
  for (int j = 0; j < LIGHT_STEPS; j++) {
    vec3 q = p + uSunDir * (ds * (float(j) + 0.5));
    od += atmoDensity(length(q) - uRp) * ds;
  }
  return od;
}

// カメラから dir 方向へ tStart..tEnd の区間で散乱してくる光を求める。
// transmittance には、その区間を通り抜ける光の割合が入る。
vec3 scatter(vec3 dir, float tStart, float tEnd, out vec3 transmittance) {
  vec3 o = -uPlanetCenter;
  float dt = (tEnd - tStart) / float(PRIMARY_STEPS);
  vec2 od = vec2(0.0);
  vec3 sumR = vec3(0.0), sumM = vec3(0.0);
  for (int i = 0; i < PRIMARY_STEPS; i++) {
    vec3 p = o + dir * (tStart + dt * (float(i) + 0.5));
    vec2 dens = atmoDensity(length(p) - uRp) * dt;
    od += dens;
    vec2 odL = lightDepth(p);
    vec3 att = exp(-(uBetaR * (od.x + odL.x) + uBetaM * 1.1 * (od.y + odL.y)));
    sumR += dens.x * att;
    sumM += dens.y * att;
  }
  float mu = dot(dir, uSunDir);
  float phaseR = 0.0596831 * (1.0 + mu * mu);
  const float g = 0.76;
  float phaseM = 0.1193662 * ((1.0 - g * g) * (1.0 + mu * mu)) /
                 ((2.0 + g * g) * pow(1.0 + g * g - 2.0 * g * mu, 1.5));
  transmittance = exp(-(uBetaR * od.x + uBetaM * 1.1 * od.y));
  return uSunI * (sumR * uBetaR * phaseR + sumM * uBetaM * phaseM);
}
`;

/** 空と地表で共有する uniform を作る。 */
export function makeAtmosphereUniforms(def) {
  // 大気のない天体は、散乱がゼロの大気として扱う (同じシェーダーがそのまま使える)
  const a = def.atmosphere || { height: def.radius * 0.001, betaR: [0, 0, 0], betaM: 0, scaleHeightR: 1, scaleHeightM: 1 };
  return {
    uPlanetCenter: { value: new THREE.Vector3() },
    uRp: { value: def.radius },
    uRa: { value: def.radius + a.height },
    uSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uSunI: { value: a.sunIntensity ?? 22 },
    uBetaR: { value: new THREE.Vector3(...a.betaR) },
    uBetaM: { value: a.betaM },
    uHR: { value: a.scaleHeightR },
    uHM: { value: a.scaleHeightM },
    uPlanetRotInv: { value: new THREE.Matrix3() },
    uCamTile: { value: new THREE.Vector3() },
    uCamTile2: { value: new THREE.Vector3() },
    uTime: { value: 0 },
    // 頂点色の α = 0.5 を「光る溶岩」と読むのは溶岩惑星だけ
    // (海岸では陸の 0 と海の 1 が補間されて 0.5 を通るため)
    uLava: { value: ((def.terrain && def.terrain.type) || def.type) === 'lava' ? 1 : 0 },
    uSkyLight: { value: new THREE.Vector3(...(def.skyLight || [0.3, 0.42, 0.62])) },
    // 都市惑星: 頂点色の α (0..0.5) を街の濃さと読み、敷地の格子 (一辺 uLotN 個) に沿って道路と夜の街明かりを描く
    uCity: { value: ((def.terrain && def.terrain.type) || def.type) === 'city' ? 1 : 0 },
    uLotN: { value: 1 },
    // カメラのいる立方体の面での敷地の座標。CPU で倍精度のまま計算して渡す (planet.js の updateRender)。
    // 実寸の惑星では敷地の座標が 20 万にもなり、float では 1 m 近くずれて道路がちらつくので、カメラからの差だけをシェーダーで足す
    uCamLot: { value: new THREE.Vector4(0, 0, -1, 1) }, // xy: 敷地の座標の小数部, z: 面の軸 (0,1,2。-1 = まだない), w: 面の向き (±1)
    uCamLotInt: { value: new THREE.Vector2() }, // 敷地の座標の整数部を 4096 で割った余り
    uCamFace: { value: new THREE.Vector3() }, // カメラの惑星ローカル座標の、面の上の2成分 (xy) と面の軸の成分 (z)
    ...cloudUniforms(def),
    ...lightsUniforms(def),
  };
}

/**
 * 夜の街明かりのマップ (def.nightLights = マップの名前) を GPU のテクスチャにする。docs/design-earth-moon.md の 4章。
 * 頂点の色に入れると低空でぼやけた大きな塊になるので、地表のシェーダーで緯度経度から読む。
 * マップが読み込まれていなければ (読み込めなかったときなど) 街明かりなしで描く。
 * テクスチャは名前ごとに使い回す (縮尺の切り替えややり直しで作り直さない)。
 */
const lightTextures = new Map();
function lightsUniforms(def) {
  const map = def.nightLights ? getMap(def.nightLights) : null;
  if (!map) return {};
  let tex = lightTextures.get(map.name);
  if (!tex) {
    // 値 (画素 × scale + offset、0..1) を 0..255 にする。変換の道具が書く形 (Uint8、scale 1/255) ならそのまま使う
    const lv = map.levels[0];
    let data = lv.data;
    if (!(data instanceof Uint8Array && Math.abs(map.scale * 255 - 1) < 1e-6 && map.offset === 0)) {
      data = new Uint8Array(lv.data.length);
      for (let i = 0; i < data.length; i++) {
        data[i] = Math.round(Math.min(1, Math.max(0, lv.data[i] * map.scale + map.offset)) * 255);
      }
    }
    tex = new THREE.DataTexture(data, lv.w, lv.h, THREE.RedFormat, THREE.UnsignedByteType);
    tex.wrapS = THREE.RepeatWrapping; // 経度 ±180° でつながる
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.magFilter = THREE.LinearFilter;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.generateMipmaps = true;
    tex.needsUpdate = true;
    lightTextures.set(map.name, tex);
  }
  return { uLights: { value: tex } };
}

/** 街明かりのマップを持つ天体のマテリアルに付ける #define。 */
function lightsDefines(uniforms) {
  return uniforms.uLights ? { NIGHT_LIGHTS: 1 } : {};
}

/**
 * 夜の街明かりの GLSL (NIGHT_LIGHTS のときだけ)。q: 惑星ローカル座標の単位ベクトル。
 * 緯度経度は src/terrain/geo.js と同じ式 (東経が正: λ = atan(−z, x))。マップの 1 行目が北の端。
 */
const LIGHTS_GLSL = /* glsl */ `
uniform sampler2D uLights;
float nightLightsAt(vec3 q) {
  vec2 uv = vec2(atan(-q.z, q.x) / 6.2831853 + 0.5, 0.5 - asin(clamp(q.y, -1.0, 1.0)) / 3.1415927);
  // 経度 ±180° の継ぎ目で、隣のピクセルとの差が 1 周分に跳ぶ (縮小版の選び方が狂って線が出る) のを直す
  vec2 dx = dFdx(uv), dy = dFdy(uv);
  dx.x -= floor(dx.x + 0.5);
  dy.x -= floor(dy.x + 0.5);
  return textureGrad(uLights, uv, dx, dy).r;
}
// 足し込む光。lit: マップの明るさ (0..1)、sunUp: 鉛直と太陽の向きの内積、pl: 惑星に固定された座標 (8192 m 周期)
vec3 nightLights(float lit, float sunUp, vec3 pl, float dist) {
  float night = 1.0 - smoothstep(-0.12, 0.06, sunUp);
  if (night <= 0.0 || lit <= 0.0) return vec3(0.0);
  // 近づいたら、明かりを街区ほどの細かい点に分ける (一様にぼやけた光に見えないように)
  // (周期は pl の 8192 m を割り切る数にする。波長 1 km の街のまとまりと 256 m の街区)
  float near = 1.0 - smoothstep(15000.0, 60000.0, dist);
  float dots = vnoise(pl * 0.0009765625, 8.0) * 0.55 + vnoise(pl * 0.00390625 + 5.0, 32.0) * 0.45;
  float k = mix(1.0, smoothstep(0.4, 0.75, dots) * 2.5, near);
  // 衛星の画像は明るい所が飽和しているので、2 乗して暗い郊外との差を付ける
  return vec3(1.0, 0.68, 0.36) * lit * lit * k * night * 0.9;
}
`;

/**
 * 雲の層の uniform (def.clouds = { altitude (m), cover (0..1) } のある天体だけ)。
 * 雲の層は球のメッシュでは作らず、空と地表のシェーダーの中で視線との交点を計算して描く (CLOUD_GLSL)。
 * 実寸の惑星では、球を多角形で近似したへこみが雲の高さより大きくなるため。docs/design-earth-moon.md の 5章
 */
function cloudUniforms(def) {
  if (!def.clouds) return {};
  const S = def.detailScale ?? 1;
  return {
    uCloudR: { value: def.radius + def.clouds.altitude },
    uCloudCover: { value: def.clouds.cover ?? 0.55 },
    // 2 枚の雲の模様を、それぞれ自転軸まわりに回す角度 (cos, sin)。planet.js の updateRender が時刻から決める
    uCloudRot: { value: new THREE.Vector4(1, 0, 1, 0) },
    // ノイズのオクターブ数。実寸 (細かさの倍率 S) では足して、いちばん小さな雲の大きさ (m) を保つ
    uCloudOct: { value: 7 + Math.round(Math.log2(S)) },
  };
}

/** 雲を持つ天体のマテリアルに付ける #define。 */
export function cloudDefines(uniforms) {
  return uniforms.uCloudR ? { CLOUDS: 1 } : {};
}

/** カメラ位置を周期 TILE / TILE2 (m) で折り返す。シェーダーの模様を float の精度内で惑星に固定するため。 */
export const TILE = 256;
export const TILE2 = 8192;

// 地面の模様に使うノイズ (地表と、岩・木のシェーダーで共通)
const NOISE_GLSL = /* glsl */ `
float hash3(vec3 p) {
  p = fract(p * 0.3183099 + 0.1);
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
// 周期 per で繰り返す値ノイズ
float vnoise(vec3 x, float per) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  vec3 i0 = mod(i, per);
  vec3 i1 = mod(i + 1.0, per);
  return mix(
    mix(mix(hash3(vec3(i0.x, i0.y, i0.z)), hash3(vec3(i1.x, i0.y, i0.z)), f.x),
        mix(hash3(vec3(i0.x, i1.y, i0.z)), hash3(vec3(i1.x, i1.y, i0.z)), f.x), f.y),
    mix(mix(hash3(vec3(i0.x, i0.y, i1.z)), hash3(vec3(i1.x, i0.y, i1.z)), f.x),
        mix(hash3(vec3(i0.x, i1.y, i1.z)), hash3(vec3(i1.x, i1.y, i1.z)), f.x), f.y),
    f.z);
}
// 高さ h (m) の凹凸があるものとして法線を傾ける。
// 画面上の隣のピクセルとの差から傾きを求めるので、テクスチャ座標がいらない。
vec3 bumpNormal(vec3 N, vec3 p, float h) {
  vec3 dpx = dFdx(p), dpy = dFdy(p);
  float dhx = dFdx(h), dhy = dFdy(h);
  vec3 r1 = cross(dpy, N), r2 = cross(N, dpx);
  float det = dot(dpx, r1);
  // 面が法線とほぼ平行なとき (チャンクの縁に垂らしたスカートなど) は計算が発散するので何もしない
  if (abs(det) < 0.35 * length(dpx) * length(dpy) + 1e-12) return N;
  vec3 g = (dhx * r1 + dhy * r2) / det;
  return normalize(N - g);
}
`;

/**
 * 都市惑星の道路と夜景の GLSL (地表のシェーダー用)。
 * キューブ球の面を city.js と同じ敷地の格子に区切り、敷地の縁を道路とする。
 */
const CITY_GLSL = /* glsl */ `
// p: 惑星ローカル座標 (惑星中心が原点)。道路らしさ (0..1) を返し、敷地の番号を id に入れる。
// 1ピクセルに道路が何本も入るほど遠い所では、道路の面積の割合 (平均) を返す
// 立方体の面の軸 (0 = x, 1 = y, 2 = z) ごとの、面の上の2成分と軸の成分。
// 成分の向きが city.js の faceDir と逆の面もあるが、格子は折り返しても整数の所が重なるので、道路の位置は一致する
vec2 faceUV(vec3 v, float axis) { return axis < 0.5 ? v.zy : (axis < 1.5 ? v.xz : v.xy); }
float faceA(vec3 v, float axis) { return axis < 0.5 ? v.x : (axis < 1.5 ? v.y : v.z); }

// p: 惑星ローカル座標 (粗い), d: カメラから見た惑星ローカルの相対位置 (細かい)
float cityStreet(vec3 p, vec3 d, float N, out vec2 id) {
  vec3 a = abs(p);
  float axis = (a.x >= a.y && a.x >= a.z) ? 0.0 : (a.y >= a.z ? 1.0 : 2.0);
  float pa = faceA(p, axis);
  vec2 g; // 敷地の格子の座標 (整数の所が道路の中心)
  if (axis == uCamLot.z && sign(pa) == uCamLot.w) {
    // カメラと同じ面: 面の上の座標の差 st − st_cam を、カメラからの相対位置 d だけで計算する
    //   st = uv / |a| なので st − st_cam = (d_uv · a_cam − uv_cam · d_a) / (sign · a_cam · (a_cam + d_a))
    vec2 du = faceUV(d, axis);
    float da = faceA(d, axis);
    float ca = uCamFace.z;
    vec2 dst = (du * ca - uCamFace.xy * da) / (uCamLot.w * ca * (ca + da));
    g = uCamLot.xy + dst * 0.5 * N;
    id = mod(floor(g) + uCamLotInt, 4096.0);
  } else {
    vec2 st = faceUV(p, axis) / abs(pa);
    g = (st * 0.5 + 0.5) * N;
    id = mod(floor(g), 4096.0);
  }
  vec2 e = abs(fract(g) - 0.5); // 0 = 敷地の中央, 0.5 = 道路の中央
  float w = max(fwidth(g.x), fwidth(g.y));
  const float half_ = 0.5 - ${(0.18 / 2).toFixed(3)}; // 道路の内側の縁 (city.js の STREET)
  float s = smoothstep(half_ - w, half_ + w, max(e.x, e.y));
  return mix(s, 0.34, smoothstep(0.25, 0.6, w));
}

float lotHash(vec2 id) {
  return fract(sin(dot(id, vec2(12.9898, 78.233))) * 43758.5453);
}

// 夜の街明かり (足し込む光)。p: 惑星ローカル座標。sunUp: 鉛直と太陽の向きの内積
vec3 cityLights(vec3 p, float urb, float street, vec2 id, float sunUp, float dist) {
  float night = 1.0 - smoothstep(-0.12, 0.08, sunUp);
  if (night <= 0.0 || urb <= 0.0) return vec3(0.0);
  // 明かりの濃淡: 数十 km の街のまとまりと、数 km の繁華街。暗い隙間を残して網目のように見せる
  float web = vnoise(p / 28000.0, 4096.0) * 0.6 + vnoise(p / 5000.0 + 17.0, 4096.0) * 0.4;
  float glow = smoothstep(0.3, 0.75, web) * urb;
  glow = glow * glow * 1.6 + 0.08 * urb;
  // 道路の街灯 (橙) と、敷地ごとにまちまちな建物の明かり (白〜青)
  float lots = step(0.45, lotHash(id)) * (1.0 - street);
  float far = smoothstep(3000.0, 12000.0, dist); // 遠くでは建物の明かりも面の平均になる
  lots = mix(lots, 0.3, far);
  vec3 c = vec3(1.0, 0.55, 0.22) * street * 0.7 + vec3(0.75, 0.8, 0.9) * lots * 0.3;
  return c * glow * night;
}
`;

// 雲の層 (CLOUDS が定義されたマテリアルだけで使う)。ATMOSPHERE_GLSL・NOISE_GLSL・uPlanetRotInv・uSkyLight の後に置く。
// 雲は半径 uCloudR の薄い球面にあるものとして、視線や太陽光との交点で濃さを求める。
const CLOUD_GLSL = /* glsl */ `
uniform float uCloudR;
uniform float uCloudCover;
uniform vec4 uCloudRot;
uniform float uCloudOct;
// 1 ピクセルが見込む角度 (rad) のおおよその値 (画角 62°・縦 720 ピクセルほど)。遠くの細かい雲を消すのに使う
#define CLOUD_PIXEL 0.0015

vec3 cloudRotY(vec3 p, vec2 cs) { return vec3(p.x * cs.x + p.z * cs.y, p.y, -p.x * cs.y + p.z * cs.x); }

// 惑星ローカル座標の向き q (単位ベクトル) の雲の濃さ (0..1)。fp: 1 ピクセルが球面上で見込む角度 (rad)。
// thick には雲の厚み (0..1。縁の薄い所が 0、芯の厚い所が 1) を返す
float cloudAlpha(vec3 q, float fp, out float thick) {
  // 大きな模様 (天気の系) と細かい模様を別の速さで回し、形が少しずつ変わるようにする
  vec3 p1 = cloudRotY(q, uCloudRot.xy);
  vec3 p2 = cloudRotY(q, uCloudRot.zw);
  vec3 warp = vec3(vnoise(p1 * 2.0 + 3.1, 8192.0), vnoise(p1 * 2.0 - 7.7, 8192.0), vnoise(p1 * 2.0 + 11.3, 8192.0)) - 0.5;
  // 値ノイズは格子の向きに沿った筋が出るので、オクターブごとに座標を回して筋を散らす
  const mat3 ROT = mat3(0.00, 0.80, 0.60, -0.80, 0.36, -0.48, -0.60, -0.48, 0.64);
  mat3 R = mat3(1.0);
  // 細かいオクターブも強めに残し (倍率 0.62)、大きな雲の塊の中にも切れ目と濃淡ができるようにする
  float f = 4.0, a = 1.0, sum = 0.0, norm = 0.0;
  for (int i = 0; i < 12; i++) {
    if (float(i) >= uCloudOct) break;
    // 1 ピクセルより細かい模様は、ちらつかないよう平均 (0) に置き換える
    float keep = 1.0 - smoothstep(0.15, 0.4, fp * f);
    vec3 pp = R * ((i < 2 ? p1 : p2) + warp * 0.2) * f + float(i) * 17.31;
    sum += a * keep * (vnoise(pp, 8192.0) - 0.5) * 2.0;
    norm += a;
    R = ROT * R;
    f *= 2.03;
    a *= 0.62;
  }
  sum /= norm;
  // 緯度ごとの雲の量: 赤道 (熱帯収束帯) と中緯度に多く、亜熱帯 (緯度 25° 前後) の砂漠帯に少ない
  float al = abs(q.y);
  float band = 0.1 * (1.0 - smoothstep(0.0, 0.2, al))
             - 0.14 * exp(-pow((al - 0.42) / 0.12, 2.0))
             + 0.08 * exp(-pow((al - 0.75) / 0.12, 2.0));
  float v = sum * 0.8 + 0.5 + band;
  float t = 0.5 + (0.55 - uCloudCover) * 0.45;
  thick = smoothstep(t, t + 0.3, v);
  return smoothstep(t - 0.03, t + 0.12, v);
}

// 雲の点 pc (惑星中心から見た位置、描画座標の向き) の明るさ。fromBelow: 雲の下から見上げている
vec3 cloudShade(vec3 pc, float thick, bool fromBelow) {
  vec3 up = normalize(pc);
  vec2 odL = lightDepth(pc);
  vec3 sunT = exp(-(uBetaR * odL.x + uBetaM * 1.1 * odL.y)); // 夕方は赤く、夜側は暗く
  float mu = dot(up, uSunDir);
  vec3 sun = sunT * uSunI * 0.085 * (0.45 + 0.55 * max(mu, 0.0)) * smoothstep(-0.12, 0.08, mu);
  vec3 sky = uSkyLight * uSunI * 0.011 * smoothstep(-0.2, 0.3, mu);
  // 上から見ると厚い所ほど明るく (縁の薄い所は灰色がかる)、下から見上げると厚い所ほど暗い
  float shade = fromBelow ? mix(0.9, 0.3, thick) : mix(0.55, 1.0, thick);
  return vec3(0.75) * (sun * shade + sky + vec3(0.0015, 0.002, 0.003));
}

// カメラから dir 方向の tStart..tEnd の間に雲の層があれば、色 col の手前に重ねる。
// col はその区間の大気を通った後の色 (= 手前の散乱 + 透過率 × 奥の色)。alpha に雲の濃さを返す
vec3 cloudOver(vec3 col, vec3 dir, float tStart, float tEnd, out float alpha) {
  alpha = 0.0;
  vec3 o = -uPlanetCenter;
  float c0, c1;
  if (!raySphere(o, dir, uCloudR, c0, c1)) return col;
  float tc = c0 > 0.0 ? c0 : c1;
  if (tc <= 0.0 || tc >= tEnd) return col;
  vec3 pcw = o + dir * tc;
  vec3 q = normalize(uPlanetRotInv * pcw);
  float thick;
  alpha = cloudAlpha(q, tc * CLOUD_PIXEL / uCloudR, thick);
  if (alpha < 0.002) return col;
  // カメラと雲の間の大気
  vec3 T1 = vec3(1.0), s1 = vec3(0.0);
  if (tStart < tc) s1 = scatter(dir, tStart, tc, T1);
  vec3 cloud = s1 + T1 * cloudShade(pcw, thick, dot(o, o) < uCloudR * uCloudR);
  return mix(col, cloud, alpha);
}

// 地表の点 pc (惑星中心から見た位置) に落ちる雲の影 (1 = 影なし)。dist: カメラからの距離
float cloudShadow(vec3 pc, float dist) {
  if (dot(pc, pc) >= uCloudR * uCloudR) return 1.0;
  float s0, s1;
  if (!raySphere(pc, uSunDir, uCloudR, s0, s1) || s1 <= 0.0) return 1.0;
  vec3 q = normalize(uPlanetRotInv * (pc + uSunDir * s1));
  float thick;
  float a = cloudAlpha(q, max(dist, 2000.0) * CLOUD_PIXEL / uCloudR, thick);
  return 1.0 - a * (0.45 + 0.4 * thick);
}
`;

/** 地表のマテリアル。頂点色 + 太陽光 + 大気によるかすみ。 */
export function createTerrainMaterial(uniforms) {
  return new THREE.ShaderMaterial({
    uniforms,
    defines: { ...cloudDefines(uniforms), ...lightsDefines(uniforms) },
    side: THREE.DoubleSide,
    vertexShader: /* glsl */ `
      #include <common>
      #include <logdepthbuf_pars_vertex>
      attribute vec4 aColor;
      varying vec3 vRel;
      varying vec3 vNormal;
      varying vec4 vColor;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vRel = wp.xyz; // カメラが原点なので、これがカメラからの相対位置
        vNormal = mat3(modelMatrix) * normal;
        vColor = aColor;
        gl_Position = projectionMatrix * viewMatrix * wp;
        #include <logdepthbuf_vertex>
      }`,
    fragmentShader: /* glsl */ `
      #define PRIMARY_STEPS 8
      #define LIGHT_STEPS 3
      #include <common>
      #include <logdepthbuf_pars_fragment>
      ${ATMOSPHERE_GLSL}
      uniform mat3 uPlanetRotInv;
      uniform vec3 uCamTile;
      uniform vec3 uCamTile2;
      uniform float uTime;
      uniform float uLava;
      uniform float uCity;
      uniform float uLotN;
      uniform vec4 uCamLot;
      uniform vec2 uCamLotInt;
      uniform vec3 uCamFace;
      uniform vec3 uSkyLight; // 空からの光の色 (大気がなければほぼ黒)
      varying vec3 vRel;
      varying vec3 vNormal;
      varying vec4 vColor;
      ${NOISE_GLSL}
      ${CITY_GLSL}
      #ifdef CLOUDS
      ${CLOUD_GLSL}
      #endif
      #ifdef NIGHT_LIGHTS
      ${LIGHTS_GLSL}
      #endif

      void main() {
        #include <logdepthbuf_fragment>
        float dist = length(vRel);
        vec3 dir = vRel / dist;
        vec3 N = normalize(vNormal);
        vec3 pc = vRel - uPlanetCenter;
        vec3 up = normalize(pc);
        vec3 albedo = vColor.rgb;
        // 面の種類: 0 = 地面, 0.5 = 光る溶岩 (溶岩惑星のみ), 1 = 水面
        float water = step(0.75, vColor.a);
        float lava = (step(0.25, vColor.a) - water) * uLava;
        float ground = 1.0 - water;
        // 都市: 街の濃さ (0..1) と、敷地の格子に沿った道路 (city.js と同じ格子)
        float urb = 0.0, street = 0.0;
        vec2 lotId = vec2(0.0);
        vec3 pLocal = uPlanetRotInv * (vRel - uPlanetCenter); // 惑星ローカル座標
        if (uCity > 0.5) {
          urb = clamp(vColor.a * 2.0, 0.0, 1.0) * ground;
          street = cityStreet(pLocal, uPlanetRotInv * vRel, uLotN, lotId);
        }

        // 頂点色とメッシュの法線だけだとのっぺりするので、ノイズで模様と凹凸を足す。
        // 細かい模様ほど近くでだけ見せる (遠くではちらつくため)。
        vec3 pl = uPlanetRotInv * vRel + uCamTile;   // 惑星に固定された座標 (256 m 周期)
        vec3 pl2 = uPlanetRotInv * vRel + uCamTile2; // 同じく 8192 m 周期 (粗い模様用)
        float fadeA = 1.0 - smoothstep(25000.0, 80000.0, dist); // 波長 256 m
        float fadeB = 1.0 - smoothstep(3000.0, 10000.0, dist);  // 波長 32 m
        float fade1 = 1.0 - smoothstep(200.0, 1500.0, dist);    // 波長 2.7 m
        float fade2 = 1.0 - smoothstep(20.0, 150.0, dist);      // 波長 0.33 m
        float nA = vnoise(pl2 * 0.00390625, 32.0) - 0.5;
        float nB = vnoise(pl2 * 0.03125, 256.0) - 0.5;
        float n1 = vnoise(pl * 0.375, 96.0) - 0.5;
        float n2 = vnoise(pl * 3.0, 768.0) - 0.5;
        float detail = nA * 0.16 * fadeA + nB * 0.2 * fadeB + n1 * 0.3 * fade1 + n2 * 0.24 * fade2;

        // 急斜面には水平な地層の縞を出す。細かい縞 (約 3 m) と、崖の段に見合う太い縞 (約 30 m)。
        // 1ピクセルの間に標高が縞の幅より大きく変わる所 (遠くの崖) では、ちらつかないよう消す
        float steep = 1.0 - smoothstep(0.55, 0.8, dot(N, up));
        float alt = length(pc) - uRp;
        float altW = fwidth(alt);
        float strataFine = (vnoise(vec3(alt * 0.35 + nB * 3.0, 7.3, 2.1), 4096.0) - 0.5)
                         * (1.0 - smoothstep(0.3, 0.8, altW * 0.35));
        float strataCoarse = (vnoise(vec3(alt * 0.03 + nA * 2.0, 3.1, 5.7), 4096.0) - 0.5)
                           * (1.0 - smoothstep(0.3, 0.8, altW * 0.03));
        detail += (strataFine * 0.35 + strataCoarse * 0.7) * steep;
        albedo *= 1.0 + detail * ground;
        albedo *= 1.0 - 0.45 * street * urb; // アスファルトの道路

        // 凹凸 (m) として法線も傾ける。水面では、向きの違う2枚のノイズを流して波にする。
        // (画面上の差分を使うので、分岐の外でまとめて計算する)
        float bump = nB * 2.5 * fadeB + n1 * 0.22 * fade1 + n2 * 0.028 * fade2;
        float wave = vnoise(pl * 0.375 + vec3(uTime * 0.5, uTime * 0.17, uTime * 0.31), 96.0) * 0.22 * fade1
                   + vnoise(pl * 1.5 - vec3(uTime * 0.6, uTime * 0.4, uTime * 0.23), 384.0) * 0.05
                     * (1.0 - smoothstep(80.0, 500.0, dist));
        N = bumpNormal(N, vRel, mix(bump * (1.0 - lava), wave, water));

        // 太陽光。大気を通る間に色が変わる (夕方は赤く、夜側は暗く)
        vec2 odL = lightDepth(pc);
        vec3 sunT = exp(-(uBetaR * odL.x + uBetaM * 1.1 * odL.y));
        float ndl = max(dot(N, uSunDir), 0.0);
        // 凹凸で傾けた法線が、もとの面の裏側まで照らさないようにする
        ndl *= smoothstep(-0.05, 0.1, dot(normalize(vNormal), uSunDir));
        vec3 light = sunT * uSunI * 0.085 * ndl;
        #ifdef CLOUDS
        light *= cloudShadow(pc, dist); // 雲の影
        #endif
        float day = smoothstep(-0.2, 0.3, dot(up, uSunDir));
        vec3 skyLight = uSkyLight * uSunI * 0.011 * day;
        vec3 col = albedo * (light + skyLight + vec3(0.0015, 0.002, 0.003));
        col += albedo * lava * 1.0; // 溶岩は夜でも光る
        if (uCity > 0.5) col += cityLights(pLocal, urb, street, lotId, dot(up, uSunDir), dist);
        #ifdef NIGHT_LIGHTS
        col += nightLights(nightLightsAt(normalize(pLocal)), dot(up, uSunDir), pl2, dist) * ground; // 本物の街明かり
        #endif

        // 水面: さざ波、太陽の反射、浅い角度で映る空、波打ち際の白波
        if (water > 0.5) {
          vec3 Nw = N; // 波で傾いた水面 (遠くは平らな鏡)
          vec3 h = normalize(uSunDir - dir);
          float spec = pow(max(dot(Nw, h), 0.0), 180.0);
          col += sunT * uSunI * 0.25 * spec;
          float fres = pow(1.0 - max(dot(Nw, -dir), 0.0), 5.0);
          col = mix(col, uSkyLight * 1.2 * uSunI * 0.03 * day, fres * 0.7);
          // 海岸の三角形の中でだけ α が 1 より小さくなるのを、岸からの近さとして使う
          float shore = 1.0 - smoothstep(0.75, 1.0, vColor.a);
          float foamN = vnoise(pl * 0.75 + vec3(uTime * 0.25, 0.0, uTime * 0.2), 192.0);
          float foam = smoothstep(0.45, 0.7, shore * 0.9 + foamN * 0.5) * shore
                     * (1.0 - smoothstep(1500.0, 5000.0, dist));
          col = mix(col, vec3(0.85, 0.9, 0.92) * (light * 0.6 + skyLight + vec3(0.002)), foam * 0.8);
        }

        // カメラと地表の間の大気 (遠くほど青くかすむ)
        vec3 o = -uPlanetCenter;
        float tStart = 0.0;
        if (dot(o, o) > uRa * uRa) {
          float a0, a1;
          tStart = raySphere(o, dir, uRa, a0, a1) ? max(a0, 0.0) : dist;
        }
        if (tStart < dist) {
          vec3 T;
          vec3 ins = scatter(dir, tStart, dist, T);
          col = col * T + ins;
        }
        #ifdef CLOUDS
        float cloudA;
        col = cloudOver(col, dir, tStart, dist, cloudA); // カメラと地表の間の雲
        #endif

        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
}

/**
 * 地表に散らばる岩や木 (InstancedMesh) のマテリアル。地表と同じ光とかすみで描く。
 * @param uniforms 惑星の uniform (地表と共有)
 * @param fadeDist この距離に近づくにつれて縮めて消す (m)。突然現れたり消えたりしないように
 * @param wrap 0 = 普通の陰影、1 = 影側にも光が回り込む (葉むら用)
 */
export function createScatterMaterial(uniforms, { fadeDist, wrap = 0, doubleSide = false, cut = false }) {
  return new THREE.ShaderMaterial({
    uniforms: { ...uniforms, uFadeDist: { value: fadeDist }, uWrap: { value: wrap } },
    // cut: 縮めずに fadeDist でぱっと消す (そこから先をビルボードが引き継ぐ木に使う)
    defines: cut ? { HARD_CUT: 1 } : {},
    side: doubleSide ? THREE.DoubleSide : THREE.FrontSide,
    vertexShader: /* glsl */ `
      #include <common>
      #include <logdepthbuf_pars_vertex>
      attribute vec3 aTint;
      uniform float uFadeDist;
      varying vec3 vRel;
      varying vec3 vNormal;
      varying vec3 vColor;
      void main() {
        vec3 tint = aTint;
        #ifdef USE_INSTANCING
          vec4 origin = modelMatrix * vec4(instanceMatrix[3].xyz, 1.0);
          #ifdef HARD_CUT
            float s = 1.0 - step(uFadeDist, length(origin.xyz));
          #else
            float s = 1.0 - smoothstep(0.75 * uFadeDist, uFadeDist, length(origin.xyz));
          #endif
          vec4 wp = modelMatrix * (instanceMatrix * vec4(position * s, 1.0));
          vNormal = mat3(modelMatrix) * (mat3(instanceMatrix) * normal);
        #else
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vNormal = mat3(modelMatrix) * normal;
        #endif
        #ifdef USE_INSTANCING_COLOR
          tint *= instanceColor;
        #endif
        vRel = wp.xyz;
        vColor = tint;
        gl_Position = projectionMatrix * viewMatrix * wp;
        #include <logdepthbuf_vertex>
      }`,
    fragmentShader: /* glsl */ `
      #define PRIMARY_STEPS 4
      #define LIGHT_STEPS 2
      #include <common>
      #include <logdepthbuf_pars_fragment>
      ${ATMOSPHERE_GLSL}
      uniform vec3 uSkyLight;
      uniform float uWrap;
      varying vec3 vRel;
      varying vec3 vNormal;
      varying vec3 vColor;
      void main() {
        #include <logdepthbuf_fragment>
        float dist = length(vRel);
        vec3 dir = vRel / dist;
        vec3 N = normalize(vNormal);
        if (!gl_FrontFacing) N = -N;
        vec3 pc = vRel - uPlanetCenter;
        vec3 up = normalize(pc);

        vec2 odL = lightDepth(pc);
        vec3 sunT = exp(-(uBetaR * odL.x + uBetaM * 1.1 * odL.y));
        float nd = dot(N, uSunDir);
        float ndl = max(mix(nd, nd * 0.5 + 0.5, uWrap), 0.0);
        vec3 light = sunT * uSunI * 0.085 * ndl;
        float day = smoothstep(-0.2, 0.3, dot(up, uSunDir));
        // 空からの光は上向きの面ほど強い
        vec3 skyLight = uSkyLight * uSunI * 0.011 * day * (0.65 + 0.35 * dot(N, up));
        vec3 col = vColor * (light + skyLight + vec3(0.0015, 0.002, 0.003));

        vec3 T;
        vec3 ins = scatter(dir, 0.0, dist, T);
        col = col * T + ins;

        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
}

/**
 * 都市惑星のビル (InstancedMesh) のマテリアル。地表と同じ光とかすみに、窓を足す。
 * 窓は機体ではなくビルの大きさ (m) で並べるので、インスタンスの拡大率を戻した座標で描く。
 * 昼は暗いガラス、夜は部屋ごとにまちまちに灯る。
 * @param fadeDist この距離に近づくにつれて縮めて消す (m)
 */
export function createBuildingMaterial(uniforms, { fadeDist }) {
  return new THREE.ShaderMaterial({
    uniforms: { ...uniforms, uFadeDist: { value: fadeDist } },
    vertexShader: /* glsl */ `
      #include <common>
      #include <logdepthbuf_pars_vertex>
      attribute vec3 aTint;
      uniform float uFadeDist;
      varying vec3 vRel;
      varying vec3 vNormal;
      varying vec3 vColor;
      varying vec3 vObj;     // ビルの中の位置 (m)。y は地面から
      varying vec3 vObjN;    // ビルの座標での法線
      varying float vSeed;   // ビルごとの乱数
      void main() {
        vec4 origin = modelMatrix * vec4(instanceMatrix[3].xyz, 1.0);
        float s = 1.0 - smoothstep(0.75 * uFadeDist, uFadeDist, length(origin.xyz));
        vec4 wp = modelMatrix * (instanceMatrix * vec4(position * vec3(1.0, s, 1.0), 1.0));
        vec3 scl = vec3(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz), length(instanceMatrix[2].xyz));
        vObj = position * scl;
        vObjN = normal;
        vSeed = fract(sin(dot(instanceMatrix[3].xyz, vec3(0.0123, 0.0457, 0.0789))) * 43758.5453);
        vNormal = mat3(modelMatrix) * (mat3(instanceMatrix) * (normal / scl));
        vColor = aTint * instanceColor;
        vRel = wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
        #include <logdepthbuf_vertex>
      }`,
    fragmentShader: /* glsl */ `
      #define PRIMARY_STEPS 4
      #define LIGHT_STEPS 2
      #include <common>
      #include <logdepthbuf_pars_fragment>
      ${ATMOSPHERE_GLSL}
      uniform vec3 uSkyLight;
      varying vec3 vRel;
      varying vec3 vNormal;
      varying vec3 vColor;
      varying vec3 vObj;
      varying vec3 vObjN;
      varying float vSeed;
      float h2(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233)) + vSeed * 91.7) * 43758.5453); }
      void main() {
        #include <logdepthbuf_fragment>
        float dist = length(vRel);
        vec3 dir = vRel / dist;
        vec3 N = normalize(vNormal);
        vec3 pc = vRel - uPlanetCenter;
        vec3 up = normalize(pc);

        // 窓: 外壁を 階 (3.6 m) × 柱の間隔 (3.2 m) のマス目に区切る。屋上と1階にはない
        float wall = 1.0 - step(0.5, abs(vObjN.y));
        vec2 cell = vec2((abs(vObjN.x) > 0.5 ? vObj.z : vObj.x) / 3.2, vObj.y / 3.6);
        vec2 f = fract(cell);
        vec2 aa = fwidth(cell);
        vec2 box = smoothstep(vec2(0.15, 0.22) - aa, vec2(0.15, 0.22) + aa, f)
                 * (1.0 - smoothstep(vec2(0.85, 0.82) - aa, vec2(0.85, 0.82) + aa, f));
        float win = box.x * box.y;
        win = mix(win, 0.42, smoothstep(0.3, 0.7, max(aa.x, aa.y))); // 遠くでは面の平均
        win *= wall * step(4.0, vObj.y);

        vec2 odL = lightDepth(pc);
        vec3 sunT = exp(-(uBetaR * odL.x + uBetaM * 1.1 * odL.y));
        float ndl = max(dot(N, uSunDir), 0.0);
        vec3 light = sunT * uSunI * 0.085 * ndl;
        float day = smoothstep(-0.2, 0.3, dot(up, uSunDir));
        vec3 skyLight = uSkyLight * uSunI * 0.011 * day * (0.65 + 0.35 * dot(N, up));
        vec3 albedo = vColor * (1.0 - 0.55 * win); // 窓ガラスは外壁より暗い
        // 地面に近いほど暗い (足元に回り込む光が少ない)
        albedo *= 0.75 + 0.25 * smoothstep(0.0, 30.0, vObj.y);
        vec3 col = albedo * (light + skyLight + vec3(0.0015, 0.002, 0.003));
        // 夜の窓明かり。部屋ごとに点いたり消えたりしている
        float night = 1.0 - smoothstep(-0.12, 0.08, dot(up, uSunDir));
        float lit = step(0.55, h2(floor(cell)));
        lit = mix(lit, 0.45, smoothstep(0.3, 0.7, max(aa.x, aa.y)));
        vec3 warm = mix(vec3(1.0, 0.72, 0.42), vec3(0.75, 0.85, 1.0), step(0.7, vSeed));
        col += warm * win * lit * night * 0.55;

        vec3 T;
        vec3 ins = scatter(dir, 0.0, dist, T);
        col = col * T + ins;

        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
}

/**
 * 遠くの木を描くビルボードのマテリアル。1本につき板を2枚使う:
 *   ・横から見た絵を貼った、幹を軸にカメラの方へ回る縦の板
 *   ・真上から見た絵を貼った、水平な板 (上空から見下ろしたときに木が線にならないように)
 * ジオメトリの position は (x: -0.5..0.5, y: 0..1, z: 0 = 縦の板 / 1 = 水平な板)。
 * インスタンスの属性: iPos 根元の位置, iSize (幅, 高さ, 種類 0 = 針葉樹 / 1 = 広葉樹), iCol 色合い。
 * @param map 絵のアトラス (横2 × 縦2。列 = 横から / 上から、行 = 種類)
 * @param near これより近い木は描かない (メッシュの木が描く)
 * @param far この距離に近づくにつれて縮めて消す
 */
export function createTreeBillboardMaterial(uniforms, { map, near, far }) {
  return new THREE.ShaderMaterial({
    uniforms: { ...uniforms, uMap: { value: map }, uNear: { value: near }, uFar: { value: far } },
    side: THREE.DoubleSide,
    vertexShader: /* glsl */ `
      #include <common>
      #include <logdepthbuf_pars_vertex>
      attribute vec3 iPos;
      attribute vec3 iSize;
      attribute vec3 iCol;
      uniform vec3 uPlanetCenter;
      uniform float uNear;
      uniform float uFar;
      varying vec3 vRel;
      varying vec3 vNormal;
      varying vec3 vColor;
      varying vec2 vUv;
      void main() {
        vec3 base = (modelMatrix * vec4(iPos, 1.0)).xyz; // 根元 (カメラが原点)
        float dist = length(base);
        vec3 up = normalize(base - uPlanetCenter);
        float s = step(uNear, dist) * (1.0 - smoothstep(0.8 * uFar, uFar, dist));
        vec3 toCam = -base / max(dist, 1.0);
        vec3 right = cross(up, toCam);
        float rl = length(right);
        right = rl > 1e-4 ? right / rl : normalize(cross(up, vec3(0.3, 0.5, 0.8)));
        vec3 fwd = cross(right, up);

        float kind = iSize.z;
        float top = position.z;
        // 絵1枚が覆う範囲 (木の幅・高さに対する比)。scatter.js のアトラスの描き方と揃えること
        float sideW = mix(0.5, 0.9, kind);
        float topW = mix(0.46, 0.9, kind);
        float topH = mix(0.3, 0.66, kind);
        vec3 off = top < 0.5
          ? right * (position.x * sideW * iSize.x) + up * (position.y * 1.02 * iSize.y)
          : (right * position.x + fwd * (position.y - 0.5)) * (topW * iSize.x) + up * (topH * iSize.y);
        vec3 wp = base + off * s;

        vRel = wp;
        vColor = iCol;
        vUv = (vec2(top, kind) + vec2(position.x + 0.5, position.y)) * 0.5;
        // 板でも左右で明るさが変わるよう、丸みのある法線をでっち上げる
        vNormal = top < 0.5 ? up * 0.5 + right * (position.x * 1.6) + toCam * 0.6 : up;
        gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
        #include <logdepthbuf_vertex>
      }`,
    fragmentShader: /* glsl */ `
      #define PRIMARY_STEPS 4
      #define LIGHT_STEPS 2
      #include <common>
      #include <logdepthbuf_pars_fragment>
      ${ATMOSPHERE_GLSL}
      uniform vec3 uSkyLight;
      uniform sampler2D uMap;
      varying vec3 vRel;
      varying vec3 vNormal;
      varying vec3 vColor;
      varying vec2 vUv;
      void main() {
        vec4 tex = texture2D(uMap, vUv);
        if (tex.a < 0.3) discard;
        #include <logdepthbuf_fragment>
        float dist = length(vRel);
        vec3 dir = vRel / dist;
        vec3 N = normalize(vNormal);
        vec3 pc = vRel - uPlanetCenter;
        vec3 up = normalize(pc);

        vec2 odL = lightDepth(pc);
        vec3 sunT = exp(-(uBetaR * odL.x + uBetaM * 1.1 * odL.y));
        float nd = dot(N, uSunDir);
        float ndl = max(mix(nd, nd * 0.5 + 0.5, 0.7), 0.0); // メッシュの木と同じ回り込み
        vec3 light = sunT * uSunI * 0.085 * ndl;
        float day = smoothstep(-0.2, 0.3, dot(up, uSunDir));
        vec3 skyLight = uSkyLight * uSunI * 0.011 * day * (0.65 + 0.35 * dot(N, up));
        vec3 col = tex.rgb * vColor * (light + skyLight + vec3(0.0015, 0.002, 0.003));

        vec3 T;
        vec3 ins = scatter(dir, 0.0, dist, T);
        col = col * T + ins;

        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
}

/**
 * 空のマテリアル。大気の上端を表す球の内側の面に描く。
 * 出力 = 散乱光 + 背景 × 透過率 (背景の星や太陽は大気を通って暗く・赤くなる)。
 */
export function createSkyMaterial(uniforms) {
  return new THREE.ShaderMaterial({
    uniforms,
    defines: cloudDefines(uniforms),
    side: THREE.BackSide,
    transparent: true,
    depthWrite: false,
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.SrcAlphaFactor,
    vertexShader: /* glsl */ `
      #include <common>
      #include <logdepthbuf_pars_vertex>
      varying vec3 vRel;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vRel = wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
        #include <logdepthbuf_vertex>
      }`,
    fragmentShader: /* glsl */ `
      #define PRIMARY_STEPS 16
      #define LIGHT_STEPS 4
      #include <common>
      #include <logdepthbuf_pars_fragment>
      ${ATMOSPHERE_GLSL}
      #ifdef CLOUDS
      uniform mat3 uPlanetRotInv;
      uniform vec3 uSkyLight;
      ${NOISE_GLSL}
      ${CLOUD_GLSL}
      #endif
      varying vec3 vRel;
      void main() {
        #include <logdepthbuf_fragment>
        vec3 dir = normalize(vRel);
        vec3 o = -uPlanetCenter;
        float a0, a1;
        if (!raySphere(o, dir, uRa, a0, a1) || a1 <= 0.0) discard;
        float tStart = max(a0, 0.0);
        float tEnd = a1;
        float p0, p1;
        if (raySphere(o, dir, uRp, p0, p1) && p0 > 0.0) tEnd = min(tEnd, p0);
        if (tEnd <= tStart) discard;
        vec3 T;
        vec3 col = scatter(dir, tStart, tEnd, T);
        float cloudA = 0.0;
        #ifdef CLOUDS
        col = cloudOver(col, dir, tStart, tEnd, cloudA); // 雲は奥の星や太陽を隠す
        #endif
        gl_FragColor = vec4(col, dot(T, vec3(0.3333)) * (1.0 - cloudA));
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
}

/**
 * 惑星の環のマテリアル。赤道面に置いた円盤 (THREE.RingGeometry) に描く。
 * 半径ごとに濃さの違う細い輪を重ね、惑星の影に入った所は暗くする。
 * 太陽と反対側から見ると、環を透けてきた光だけが届くので暗く見える。
 * @param uniforms 惑星の uniform (中心・太陽の向き・明るさを共有する)
 * @param rings { inner, outer (m), color [r, g, b] }
 */
export function createRingMaterial(uniforms, rings) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uPlanetCenter: uniforms.uPlanetCenter,
      uSunDir: uniforms.uSunDir,
      uSunI: uniforms.uSunI,
      uRp: uniforms.uRp,
      uInner: { value: rings.inner },
      uOuter: { value: rings.outer },
      uColor: { value: new THREE.Vector3(...rings.color) },
    },
    side: THREE.DoubleSide,
    transparent: true,
    depthWrite: false,
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
    vertexShader: /* glsl */ `
      #include <common>
      #include <logdepthbuf_pars_vertex>
      varying vec3 vRel;
      varying vec3 vNormal;
      varying vec2 vLocal;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vRel = wp.xyz;
        vNormal = normalize(mat3(modelMatrix) * normal);
        vLocal = position.xz; // 円盤は赤道面 (XZ 平面) に寝かせてある
        gl_Position = projectionMatrix * viewMatrix * wp;
        #include <logdepthbuf_vertex>
      }`,
    fragmentShader: /* glsl */ `
      #include <common>
      #include <logdepthbuf_pars_fragment>
      uniform vec3 uPlanetCenter;
      uniform vec3 uSunDir;
      uniform float uSunI;
      uniform float uRp;
      uniform float uInner;
      uniform float uOuter;
      uniform vec3 uColor;
      varying vec3 vRel;
      varying vec3 vNormal;
      varying vec2 vLocal;

      float h1(float x) { return fract(sin(x * 127.1) * 43758.5453); }
      float n1(float x) { // 1次元の値ノイズ
        float i = floor(x), f = fract(x);
        f = f * f * (3.0 - 2.0 * f);
        return mix(h1(i), h1(i + 1.0), f);
      }
      float band(float t, float a, float b, float soft) {
        return smoothstep(a - soft, a + soft, t) * (1.0 - smoothstep(b - soft, b + soft, t));
      }

      void main() {
        #include <logdepthbuf_fragment>
        float r = length(vLocal);
        float t = (r - uInner) / (uOuter - uInner);
        if (t < 0.0 || t > 1.0) discard;

        // 内側の薄い環 (C)、明るく濃い環 (B)、カッシーニの間隙、外側の環 (A) とその中の細い隙間
        float dens = 0.22 * band(t, 0.0, 0.22, 0.02)
                   + 0.95 * band(t, 0.22, 0.56, 0.01)
                   + 0.65 * band(t, 0.63, 0.97, 0.01);
        dens *= 1.0 - 0.9 * band(t, 0.895, 0.905, 0.003);
        // 細かい輪。1ピクセルに何本も入る所では、ちらつかないよう平らにする
        float w = fwidth(t);
        float fine = (n1(t * 45.0) - 0.5) * 0.5
                   + (n1(t * 160.0) - 0.5) * 0.45 * (1.0 - smoothstep(0.2, 0.8, w * 160.0))
                   + (n1(t * 600.0) - 0.5) * 0.4 * (1.0 - smoothstep(0.2, 0.8, w * 600.0));
        float alpha = clamp(dens * (1.0 + fine), 0.0, 1.0) * 0.92;
        if (alpha < 0.003) discard;

        vec3 N = normalize(vNormal);
        vec3 V = normalize(vRel); // カメラから見た向き
        float sunSide = dot(N, uSunDir);
        float camSide = -dot(N, V);
        float lit = 0.3 + 0.7 * abs(sunSide);
        // 太陽と反対側から見ている: 透けてきた光だけになる
        if (sunSide * camSide < 0.0) lit *= 0.25 + 0.6 * (1.0 - alpha);

        // 惑星の影
        vec3 o = vRel - uPlanetCenter;
        float tca = -dot(o, uSunDir);
        vec3 perp = o + uSunDir * tca;
        float shadow = tca > 0.0 ? smoothstep(uRp * 0.97, uRp * 1.02, length(perp)) : 1.0;

        vec3 albedo = uColor * (0.55 + fine * 0.35) * (0.8 + 0.2 * t);
        vec3 col = albedo * uSunI * 0.085 * lit * (0.03 + 0.97 * shadow);
        gl_FragColor = vec4(col, alpha);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
        gl_FragColor.rgb *= alpha; // 重ね方は「色 × α を足す」(α を掛けておく)
      }`,
  });
}
