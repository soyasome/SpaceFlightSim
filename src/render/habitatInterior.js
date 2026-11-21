import * as THREE from 'three';
import { stripTheta } from '../universe/habitatTerrain.js';
import { mulberry32 } from '../math/random.js';

// オニール・シリンダーの中の地形と、木と家。座標は円筒ローカル座標 (Y = 軸)。
//
// 地形: 陸の帯を、帯の幅方向に 4 つ × 軸方向に 32 個 (1 km ごと) のチャンクに区切る。
// カメラからの距離に応じて、チャンクの細かさ (一辺の分割数 4〜64) を変える。
// 細かさの違うチャンクの継ぎ目は、縁から外 (地面の下) へ垂らしたスカートで隠す。
// 中は十数 km しかないので、Worker を使わず本体で作る (1フレームに使ってよい時間を決めて少しずつ)。
//
// 光: 向かいの窓から差し込む鏡の光。鏡の開き (昼と夜) に応じて、明るさと差し込む角度が変わる。
//   L = normalize(真上 × (0.25 + 0.65 × 高さ) + 軸の向き × 0.6)   (高さ = 太陽の高さに当たる値、uElev)
// lightDirAt (habitat.js) と同じ式にすること。

const ACROSS = 4; // 帯の幅方向のチャンクの数
const ALONG_SIZE = 1000; // 軸方向のチャンクの長さ (m)
const SKIRT = 40; // スカートの長さ (m)
const BUDGET_MS = 5; // 1フレームにチャンクの生成へ使ってよい時間
const SCATTER_RADIUS = 2500; // 木と家を描く範囲 (m)
const SCATTER_CELL = 200; // 木と家を決める区画 (m)
const TREE_MAX = 30000, HOUSE_MAX = 8000;

const sat = (x) => Math.min(1, Math.max(0, x));
const smooth = (a, b, x) => {
  const t = sat((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};

// ---------------------------------------------------------------- シェーダー

/** 光と霧の共通の GLSL。p: 円筒ローカル座標。uDay: 昼の明るさ 0..1、uElev: 太陽の高さ -1..1 */
export const INTERIOR_LIGHT_GLSL = /* glsl */ `
  uniform float uDay;
  uniform float uElev;
  vec3 interiorUp(vec3 p) {
    float r = length(p.xz);
    return r > 1.0 ? -vec3(p.x, 0.0, p.z) / r : vec3(1.0, 0.0, 0.0);
  }
  vec3 interiorLight(vec3 p) {
    return normalize(interiorUp(p) * (0.25 + 0.65 * max(uElev, 0.0)) + vec3(0.0, 0.6, 0.0));
  }
  // 光の色: 朝夕は赤みがかる
  vec3 sunColor() {
    return mix(vec3(1.0, 0.62, 0.38), vec3(1.0, 0.96, 0.88), smoothstep(0.0, 0.5, uElev)) * 1.4 * uDay;
  }
  vec3 skyAmbient() {
    return vec3(0.22, 0.26, 0.32) * (0.08 + 0.92 * uDay);
  }
  vec3 fogColor() {
    return vec3(0.45, 0.55, 0.68) * (0.06 + 0.94 * uDay);
  }
  vec3 applyFog(vec3 col, float d) {
    return mix(col, fogColor(), 1.0 - exp(-d / 20000.0));
  }
  float nightK() { return 1.0 - smoothstep(0.0, 0.6, uDay); }
`;

const TERRAIN_VERT = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_vertex>
  attribute vec4 aColor;
  varying vec3 vLocal;
  varying vec3 vRel;
  varying vec3 vNormal;
  varying vec4 vColor;
  void main() {
    vLocal = position;
    vNormal = normal;
    vColor = aColor;
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vRel = wp.xyz;
    gl_Position = projectionMatrix * viewMatrix * wp;
    #include <logdepthbuf_vertex>
  }`;

const TERRAIN_FRAG = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_fragment>
  ${INTERIOR_LIGHT_GLSL}
  uniform mat3 uRot; // 円筒ローカル → 描画座標の向き (視線の向きをローカルに戻すのに使う)
  varying vec3 vLocal;
  varying vec3 vRel;
  varying vec3 vNormal;
  varying vec4 vColor;
  float h21(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  void main() {
    #include <logdepthbuf_fragment>
    vec3 N = normalize(vNormal);
    vec3 L = interiorLight(vLocal);
    float water = step(0.75, vColor.a);
    float town = step(0.25, vColor.a) * (1.0 - water);
    vec3 albedo = vColor.rgb;
    float d = length(vRel);
    // 近くでは畑の畝の細かい縞
    float fine = (h21(floor(vLocal.xz * 0.25) + floor(vLocal.y * 0.25)) - 0.5) * 0.12 * (1.0 - smoothstep(300.0, 1500.0, d));
    albedo *= 1.0 + fine * (1.0 - water);
    float ndl = max(dot(N, L), 0.0);
    vec3 col = albedo * (sunColor() * ndl + skyAmbient());
    // 水面: 光の照り返し
    if (water > 0.5) {
      vec3 V = normalize(-(transpose(uRot) * vRel)); // 円筒ローカル座標での、地面から目への向き
      vec3 Hh = normalize(L + V);
      col += sunColor() * 0.35 * pow(max(dot(interiorUp(vLocal), Hh), 0.0), 120.0);
      col = mix(col, fogColor() * 0.8, pow(1.0 - max(dot(V, interiorUp(vLocal)), 0.0), 4.0) * 0.6);
    }
    // 夜の町明かり: 町の地面に、窓や街灯のような明かりを散らす
    float n = nightK();
    if (n > 0.0 && town > 0.0) {
      vec2 g = vec2(atan(vLocal.x, vLocal.z) * 4000.0, vLocal.y);
      float lamp = step(0.62, h21(floor(g / 18.0)));
      float far = smoothstep(1500.0, 6000.0, d);
      lamp = mix(lamp, 0.38, far);
      col += vec3(1.0, 0.72, 0.42) * lamp * 0.35 * n;
    }
    col = applyFog(col, d);
    gl_FragColor = vec4(col, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }`;

/** 木と家 (InstancedMesh)。頂点色 × インスタンスの色。家は夜に窓が灯る (aWin = 1 の面)。 */
const PROP_VERT = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_vertex>
  attribute vec3 aTint;
  attribute float aWin;
  uniform float uFade;
  varying vec3 vLocal;
  varying vec3 vRel;
  varying vec3 vNormal;
  varying vec3 vColor;
  varying float vWin;
  varying vec3 vObj;
  varying float vSeed;
  void main() {
    vec4 origin = modelMatrix * vec4(instanceMatrix[3].xyz, 1.0);
    float s = 1.0 - smoothstep(0.8 * uFade, uFade, length(origin.xyz)); // 遠くでは縮めて消す
    vec4 lp = instanceMatrix * vec4(position * s, 1.0);
    vLocal = lp.xyz;
    vNormal = normalize(mat3(instanceMatrix) * normal);
    vColor = aTint * instanceColor;
    vWin = aWin;
    vObj = position * vec3(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz), length(instanceMatrix[2].xyz));
    vSeed = fract(sin(dot(instanceMatrix[3].xyz, vec3(0.0123, 0.0457, 0.0789))) * 43758.5453);
    vec4 wp = modelMatrix * lp;
    vRel = wp.xyz;
    gl_Position = projectionMatrix * viewMatrix * wp;
    #include <logdepthbuf_vertex>
  }`;

const PROP_FRAG = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_fragment>
  ${INTERIOR_LIGHT_GLSL}
  varying vec3 vLocal;
  varying vec3 vRel;
  varying vec3 vNormal;
  varying vec3 vColor;
  varying float vWin;
  varying vec3 vObj;
  varying float vSeed;
  float h21(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233)) + vSeed * 31.7) * 43758.5453); }
  void main() {
    #include <logdepthbuf_fragment>
    vec3 N = normalize(vNormal);
    if (!gl_FrontFacing) N = -N;
    vec3 L = interiorLight(vLocal);
    float ndl = max(dot(N, L), 0.0) * 0.85 + 0.15 * max(dot(N, interiorUp(vLocal)), 0.0);
    vec3 col = vColor * (sunColor() * ndl + skyAmbient());
    // 家の窓: 壁に並ぶ窓。夜は部屋ごとにまちまちに灯る
    if (vWin > 0.5) {
      vec2 cell = vec2((abs(N.x) > abs(N.z) ? vObj.z : vObj.x) / 3.0, vObj.y / 3.0);
      vec2 f = fract(cell);
      float win = step(0.3, f.x) * step(f.x, 0.7) * step(0.35, f.y) * step(f.y, 0.75);
      float lit = step(0.45, h21(floor(cell)));
      col *= 1.0 - 0.4 * win;
      col += vec3(1.0, 0.75, 0.45) * win * lit * 0.6 * nightK();
    }
    col = applyFog(col, length(vRel));
    gl_FragColor = vec4(col, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }`;

// ---------------------------------------------------------------- 形

/** 複数のジオメトリをまとめ、頂点ごとの色 (aTint) と窓の印 (aWin) を付ける。 */
function merge(parts) {
  const pos = [], nor = [], tint = [], win = [];
  for (const { geo, color, window: w = 0 } of parts) {
    const g = geo.index ? geo.toNonIndexed() : geo;
    const p = g.attributes.position, n = g.attributes.normal;
    for (let i = 0; i < p.count; i++) {
      pos.push(p.getX(i), p.getY(i), p.getZ(i));
      nor.push(n.getX(i), n.getY(i), n.getZ(i));
      tint.push(...color);
      win.push(w && Math.abs(n.getY(i)) < 0.5 ? 1 : 0);
    }
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  out.setAttribute('aTint', new THREE.Float32BufferAttribute(tint, 3));
  out.setAttribute('aWin', new THREE.Float32BufferAttribute(win, 1));
  return out;
}

/** 木 (高さ 1、根元が原点)。 */
function treeGeometry() {
  return merge([
    { geo: new THREE.CylinderGeometry(0.04, 0.06, 0.35, 5).translate(0, 0.175, 0), color: [0.12, 0.08, 0.05] },
    { geo: new THREE.ConeGeometry(0.3, 0.8, 7).translate(0, 0.6, 0), color: [0.07, 0.17, 0.06] },
  ]);
}

/** 家 (底面 1 × 1、壁の高さ 1、切妻屋根)。 */
function houseGeometry() {
  const roof = new THREE.CylinderGeometry(0.62, 0.62, 1.04, 3, 1).rotateZ(Math.PI / 2).rotateX(Math.PI / 2);
  roof.scale(1, 0.5, 1).translate(0, 1.0 + 0.14, 0);
  return merge([
    { geo: new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0), color: [0.78, 0.74, 0.66], window: 1 },
    { geo: roof, color: [0.42, 0.2, 0.15] },
  ]);
}

// ---------------------------------------------------------------- 地形

export class InteriorTerrain {
  /**
   * @param def 円筒の定義
   * @param terrain 中の地形 (makeInteriorTerrain)
   * @param uniforms 昼と夜の uniform (uDay, uElev)
   * @param parent 追加先の Group (円筒ローカル座標)
   */
  constructor(def, terrain, uniforms, parent) {
    this.def = def;
    this.terrain = terrain;
    this.parent = parent;
    this.material = new THREE.ShaderMaterial({
      uniforms: { ...uniforms, uRot: { value: new THREE.Matrix3() } },
      side: THREE.DoubleSide, // 中からしか見えないので、三角形の向きは気にしない
      vertexShader: TERRAIN_VERT,
      fragmentShader: TERRAIN_FRAG,
    });
    const along = Math.round(def.length / ALONG_SIZE);
    this.chunks = [];
    for (let k = 0; k < 3; k++) {
      for (let i = 0; i < ACROSS; i++) {
        for (let j = 0; j < along; j++) {
          const a0 = -1 + (2 * i) / ACROSS, a1 = -1 + (2 * (i + 1)) / ACROSS;
          const y0 = -def.length / 2 + j * ALONG_SIZE;
          const th = stripTheta(k, (a0 + a1) / 2);
          this.chunks.push({
            k, a0, a1, y0, y1: y0 + ALONG_SIZE, seg: 0, want: 0, mesh: null,
            center: new THREE.Vector3(Math.sin(th) * def.radius, y0 + ALONG_SIZE / 2, Math.cos(th) * def.radius),
          });
        }
      }
    }
    this.indexCache = new Map();
    this.ready = false; // 一度すべてのチャンクを作ったか
  }

  /** カメラからの距離で決める、チャンクの一辺の分割数。 */
  _segFor(chunk, cam) {
    const d = Math.max(0, chunk.center.distanceTo(cam) - 750);
    const spacing = Math.min(250, Math.max(14, d / 25));
    return Math.min(64, Math.max(4, 2 ** Math.round(Math.log2(ALONG_SIZE / spacing))));
  }

  /** camLocal: 円筒ローカル座標でのカメラ。毎フレーム呼ぶ。 */
  update(camLocal) {
    for (const c of this.chunks) c.want = this._segFor(c, camLocal);
    if (!this.ready) {
      // 最初は全部を粗く作る (穴が開かないように)。近い所はこの後で細かくする
      for (const c of this.chunks) this._build(c, Math.min(c.want, 8));
      this.ready = true;
      return;
    }
    const t0 = performance.now();
    const todo = this.chunks.filter((c) => c.seg !== c.want)
      .sort((p, q) => p.center.distanceToSquared(camLocal) - q.center.distanceToSquared(camLocal));
    for (const c of todo) {
      this._build(c, c.want);
      if (performance.now() - t0 > BUDGET_MS) break;
    }
  }

  _indices(seg) {
    let idx = this.indexCache.get(seg);
    if (idx) return idx;
    const V = seg + 1;
    const list = [];
    for (let j = 0; j < seg; j++) {
      for (let i = 0; i < seg; i++) {
        const a = j * V + i, b = a + 1, c = a + V, d = c + 1;
        list.push(a, c, b, b, c, d);
      }
    }
    // スカート: 縁の頂点 e と、その下に垂らした頂点 s (V*V から並ぶ) を四角形でつなぐ
    const edges = this._edges(seg);
    let s = V * V;
    for (const edge of edges) {
      for (let t = 0; t < edge.length - 1; t++) {
        const e0 = edge[t], e1 = edge[t + 1], s0 = s + t, s1 = s + t + 1;
        list.push(e0, s0, e1, e1, s0, s1);
      }
      s += edge.length;
    }
    idx = new THREE.Uint32BufferAttribute(list, 1);
    this.indexCache.set(seg, idx);
    return idx;
  }

  _edges(seg) {
    const V = seg + 1;
    const bottom = [], top = [], left = [], right = [];
    for (let i = 0; i < V; i++) {
      bottom.push(i);
      top.push(seg * V + i);
      left.push(i * V);
      right.push(i * V + seg);
    }
    return [bottom, top, left, right];
  }

  _build(c, seg) {
    const T = this.terrain, R = this.def.radius;
    const V = seg + 1, B = seg + 3; // B: 法線を求めるために外周を1周ぶん余分に計算する
    const da = (c.a1 - c.a0) / seg, dy = (c.y1 - c.y0) / seg;
    const px = new Float64Array(B * B), py = new Float64Array(B * B), pz = new Float64Array(B * B);
    const samples = new Array(V * V);
    for (let j = 0; j < B; j++) {
      for (let i = 0; i < B; i++) {
        const a = c.a0 + (i - 1) * da, y = c.y0 + (j - 1) * dy;
        const th = stripTheta(c.k, a);
        const s = T.sample(th, y);
        const g = R - Math.max(0, s.h);
        const k = j * B + i;
        px[k] = Math.sin(th) * g; py[k] = y; pz[k] = Math.cos(th) * g;
        if (i >= 1 && i <= V && j >= 1 && j <= V) samples[(j - 1) * V + (i - 1)] = { th, y, s };
      }
    }
    const edges = this._edges(seg);
    const skirtCount = edges.reduce((n, e) => n + e.length, 0);
    const count = V * V + skirtCount;
    const pos = new Float32Array(count * 3), nor = new Float32Array(count * 3), col = new Uint8Array(count * 4);
    const out = [0, 0, 0, 0];
    for (let j = 0; j < V; j++) {
      for (let i = 0; i < V; i++) {
        const k = (j + 1) * B + (i + 1), o = j * V + i;
        pos[o * 3] = px[k]; pos[o * 3 + 1] = py[k]; pos[o * 3 + 2] = pz[k];
        // 法線: 隣の点との差の外積。軸の方 (中) を向かせる
        const ax = px[k + 1] - px[k - 1], ay = py[k + 1] - py[k - 1], az = pz[k + 1] - pz[k - 1];
        const bx = px[k + B] - px[k - B], by = py[k + B] - py[k - B], bz = pz[k + B] - pz[k - B];
        let nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
        const len = Math.hypot(nx, ny, nz) || 1;
        nx /= len; ny /= len; nz /= len;
        const r = Math.hypot(px[k], pz[k]) || 1;
        const ux = -px[k] / r, uz = -pz[k] / r; // 真上 (軸の方)
        if (nx * ux + nz * uz < 0) { nx = -nx; ny = -ny; nz = -nz; }
        nor[o * 3] = nx; nor[o * 3 + 1] = ny; nor[o * 3 + 2] = nz;
        const sm = samples[o];
        T.color(out, sm.th, sm.y, nx * ux + nz * uz, sm.s);
        col[o * 4] = Math.round(sat(out[0]) * 255);
        col[o * 4 + 1] = Math.round(sat(out[1]) * 255);
        col[o * 4 + 2] = Math.round(sat(out[2]) * 255);
        col[o * 4 + 3] = Math.round(out[3] * 255);
      }
    }
    // スカート: 縁の頂点を軸から外 (地面の下) へずらしたもの
    let s = V * V;
    for (const edge of edges) {
      for (const e of edge) {
        const x = pos[e * 3], y = pos[e * 3 + 1], z = pos[e * 3 + 2];
        const r = Math.hypot(x, z) || 1;
        pos[s * 3] = x * (1 + SKIRT / r); pos[s * 3 + 1] = y; pos[s * 3 + 2] = z * (1 + SKIRT / r);
        for (let q = 0; q < 3; q++) nor[s * 3 + q] = nor[e * 3 + q];
        for (let q = 0; q < 4; q++) col[s * 4 + q] = col[e * 4 + q];
        s++;
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    geo.setAttribute('aColor', new THREE.BufferAttribute(col, 4, true));
    geo.setIndex(this._indices(seg));
    if (c.mesh) {
      c.mesh.geometry.dispose();
      c.mesh.geometry = geo;
    } else {
      c.mesh = new THREE.Mesh(geo, this.material);
      c.mesh.frustumCulled = false;
      this.parent.add(c.mesh);
    }
    c.seg = seg;
  }

  /** 描画の向き (円筒ローカル → 描画座標) を渡す。水面の照り返しに使う。 */
  setRotation(quat) {
    this.material.uniforms.uRot.value.setFromMatrix4(new THREE.Matrix4().makeRotationFromQuaternion(quat));
  }

  dispose() {
    for (const c of this.chunks) if (c.mesh) c.mesh.geometry.dispose();
    this.material.dispose();
  }
}

// ---------------------------------------------------------------- 木と家

const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _p = new THREE.Vector3(), _s = new THREE.Vector3();
const _x = new THREE.Vector3(), _y = new THREE.Vector3(), _z = new THREE.Vector3(), _basis = new THREE.Matrix4();
const _c = new THREE.Color();

function cellSeed(seed, i, j, salt) {
  let h = Math.imul(seed | 0, 0x9e3779b1) ^ Math.imul(i | 0, 0x27d4eb2d) ^ Math.imul(j | 0, 0x165667b1) ^ salt;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  return (h ^ (h >>> 13)) >>> 0;
}

/**
 * 区画 (周方向の番号 i, 軸方向の番号 j) の木と家を決める。three.js の描画には触れないので、テストから呼べる。
 * @returns { trees: [{ th, y, h, size, yaw, shade }], houses: [{ th, y, h, w, d, height, shade }] }
 *   th, y: 位置。h: 地面の標高
 */
export function buildPropCell(def, terrain, i, j) {
  const R = def.radius, H = def.length / 2;
  const rand = mulberry32(cellSeed(def.seed, i, j, 0x51ed27));
  const trees = [], houses = [];
  const s0 = i * SCATTER_CELL, y0 = j * SCATTER_CELL;
  // 町: 40 m ごとの敷地に家を1軒ずつ
  for (let lj = 0; lj < 5; lj++) {
    for (let li = 0; li < 5; li++) {
      const pick = rand(), w = rand(), d = rand(), ht = rand(), sh = rand();
      const s = s0 + (li + 0.5) * 40, y = y0 + (lj + 0.5) * 40;
      if (Math.abs(y) > H - 100) continue;
      const th = s / R;
      const smp = terrain.sample(th, y);
      if (!smp.land || smp.town < 0.6 || smp.h <= 1 || pick > 0.75) continue;
      houses.push({ th, y, h: smp.h, w: 10 + 10 * w, d: 9 + 8 * d, height: 5 + 8 * ht * ht, shade: 0.8 + 0.35 * sh });
    }
  }
  // 森の木
  for (let n = 0; n < 40; n++) {
    const u = rand(), v = rand(), pick = rand(), sz = rand(), yaw = rand(), sh = rand();
    const s = s0 + u * SCATTER_CELL, y = y0 + v * SCATTER_CELL;
    if (Math.abs(y) > H - 50) continue;
    const th = s / R;
    const smp = terrain.sample(th, y);
    if (!smp.land || smp.h <= 1.5 || pick > smp.forest) continue;
    trees.push({ th, y, h: smp.h, size: 10 + 12 * sz, yaw: yaw * Math.PI * 2, shade: 0.75 + 0.5 * sh });
  }
  return { trees, houses };
}

export class InteriorProps {
  constructor(def, terrain, uniforms, parent) {
    this.def = def;
    this.terrain = terrain;
    this.parent = parent;
    const material = (fade) => new THREE.ShaderMaterial({
      uniforms: { ...uniforms, uFade: { value: fade } },
      side: THREE.DoubleSide,
      vertexShader: PROP_VERT,
      fragmentShader: PROP_FRAG,
    });
    const make = (geo, max) => {
      const mesh = new THREE.InstancedMesh(geo, material(SCATTER_RADIUS), max);
      mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(max * 3), 3);
      mesh.count = 0;
      mesh.frustumCulled = false;
      parent.add(mesh);
      return mesh;
    };
    this.trees = make(treeGeometry(), TREE_MAX);
    this.houses = make(houseGeometry(), HOUSE_MAX);
    this.cells = new Map(); // 'i,j' → buildPropCell の結果
    this.last = null;
  }

  /** camLocal: 円筒ローカル座標でのカメラ。カメラが 150 m 動くたびに詰め直す。 */
  update(camLocal) {
    if (this.last && this.last.distanceTo(camLocal) < 150) return;
    this.last = (this.last || new THREE.Vector3()).copy(camLocal);
    const R = this.def.radius, N = Math.round((2 * Math.PI * R) / SCATTER_CELL);
    // カメラの近く (地面の上の点までの距離が SCATTER_RADIUS 以内) の区画を集める
    const wanted = new Set();
    const span = Math.ceil((SCATTER_RADIUS + R) / SCATTER_CELL);
    const thc = Math.atan2(camLocal.x, camLocal.z);
    const ic = Math.round((thc * R) / SCATTER_CELL), jc = Math.floor(camLocal.y / SCATTER_CELL);
    const jr = Math.ceil(SCATTER_RADIUS / SCATTER_CELL);
    for (let dj = -jr; dj <= jr; dj++) {
      for (let di = -span; di <= span; di++) {
        const i = (((ic + di) % N) + N) % N, j = jc + dj;
        const th = ((i + 0.5) * SCATTER_CELL) / R, y = (j + 0.5) * SCATTER_CELL;
        const dx = Math.sin(th) * R - camLocal.x, dz = Math.cos(th) * R - camLocal.z, dyy = y - camLocal.y;
        if (dx * dx + dyy * dyy + dz * dz > (SCATTER_RADIUS + SCATTER_CELL) ** 2) continue;
        const key = `${i},${j}`;
        wanted.add(key);
        if (!this.cells.has(key)) this.cells.set(key, buildPropCell(this.def, this.terrain, i, j));
      }
    }
    for (const key of this.cells.keys()) if (!wanted.has(key)) this.cells.delete(key);
    this._upload();
  }

  _place(th, y, h, out) {
    const g = this.def.radius - h;
    out.set(Math.sin(th) * g, y, Math.cos(th) * g);
    _y.set(-Math.sin(th), 0, -Math.cos(th)); // 真上 (軸の方)
    _x.set(Math.cos(th), 0, -Math.sin(th)); // 周方向
    _z.crossVectors(_x, _y);
  }

  _upload() {
    let nt = 0, nh = 0;
    for (const cell of this.cells.values()) {
      for (const t of cell.trees) {
        if (nt >= TREE_MAX) break;
        this._place(t.th, t.y, t.h - 0.3, _p);
        _q.setFromRotationMatrix(_basis.makeBasis(_x, _y, _z));
        _q.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), t.yaw));
        _s.set(t.size, t.size, t.size);
        this.trees.setMatrixAt(nt, _m.compose(_p, _q, _s));
        this.trees.setColorAt(nt, _c.setRGB(t.shade, t.shade, t.shade));
        nt++;
      }
      for (const b of cell.houses) {
        if (nh >= HOUSE_MAX) break;
        this._place(b.th, b.y, b.h - 0.5, _p);
        _q.setFromRotationMatrix(_basis.makeBasis(_x, _y, _z));
        _s.set(b.w, b.height, b.d);
        this.houses.setMatrixAt(nh, _m.compose(_p, _q, _s));
        this.houses.setColorAt(nh, _c.setRGB(b.shade, b.shade, b.shade));
        nh++;
      }
    }
    for (const [mesh, n] of [[this.trees, nt], [this.houses, nh]]) {
      mesh.count = n;
      mesh.instanceMatrix.needsUpdate = true;
      mesh.instanceColor.needsUpdate = true;
    }
  }

  dispose() {
    for (const m of [this.trees, this.houses]) {
      m.geometry.dispose();
      m.material.dispose();
      m.dispose();
    }
  }
}
