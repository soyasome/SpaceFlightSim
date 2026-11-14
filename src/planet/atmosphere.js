import * as THREE from 'three';

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
  };
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

/** 地表のマテリアル。頂点色 + 太陽光 + 大気によるかすみ。 */
export function createTerrainMaterial(uniforms) {
  return new THREE.ShaderMaterial({
    uniforms,
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
      uniform vec3 uSkyLight; // 空からの光の色 (大気がなければほぼ黒)
      varying vec3 vRel;
      varying vec3 vNormal;
      varying vec4 vColor;
      ${NOISE_GLSL}

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

        // 急斜面には水平な地層の縞を出す
        float steep = 1.0 - smoothstep(0.55, 0.8, dot(N, up));
        float alt = length(pc) - uRp;
        float strata = vnoise(vec3(alt * 0.35 + nB * 3.0, 7.3, 2.1), 4096.0) - 0.5;
        detail += strata * 0.4 * steep * fadeB;
        albedo *= 1.0 + detail * ground;

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
        float day = smoothstep(-0.2, 0.3, dot(up, uSunDir));
        vec3 skyLight = uSkyLight * uSunI * 0.011 * day;
        vec3 col = albedo * (light + skyLight + vec3(0.0015, 0.002, 0.003));
        col += albedo * lava * 1.0; // 溶岩は夜でも光る

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
        gl_FragColor = vec4(col, dot(T, vec3(0.3333)));
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
}
