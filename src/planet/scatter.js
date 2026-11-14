import * as THREE from 'three';
import { faceDir, dirToFace } from '../terrain/chunkBuilder.js';
import { mulberry32 } from '../math/random.js';
import { createScatterMaterial, createTreeBillboardMaterial } from './atmosphere.js';

// 地表に散らばる岩と木。カメラの近くにだけ、InstancedMesh でまとめて描く。
//
// 地表をキューブ球の格子 (区画) に区切り、区画ごとにシード付き乱数で置き場所を決める。
// 同じ区画からは必ず同じものが生えるので、離れて戻ってきても景色は変わらない。
// 当たり判定はない (見た目だけ)。

const TREE_NEAR = 350; // これより近い木は立体のメッシュ、遠い木はビルボード (板に貼った絵) で描く (m)
const TREE_FAR = 3000; // 木を描く限界 (m)
const THIN_DIST = 1600; // これより遠い区画の木は半分に間引く (m)
const BILLBOARD_MAX = 240000;
const MAX_ALT = TREE_FAR; // 地面からこれより高い所では何も出さない (m)
const BUDGET_MS = 4; // 1フレームに区画の生成へ使ってよい時間
const REANCHOR = 2000; // カメラが基準点からこれだけ離れたら基準点を取り直す (m)

const KIND_ROCK = 0, KIND_CONIFER = 1, KIND_BROADLEAF = 2;

const sat = (x) => Math.min(1, Math.max(0, x));
const smooth = (a, b, x) => {
  const t = sat((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};

// ---------------------------------------------------------------- 形

/** 複数のジオメトリを1つにまとめ、頂点ごとの色 (aTint) を付ける。parts = [{ geo, tint(y) }] */
function merge(parts) {
  const pos = [], nor = [], tint = [];
  for (const { geo, color } of parts) {
    const g = geo.index ? geo.toNonIndexed() : geo;
    const p = g.attributes.position, n = g.attributes.normal;
    for (let i = 0; i < p.count; i++) {
      pos.push(p.getX(i), p.getY(i), p.getZ(i));
      nor.push(n.getX(i), n.getY(i), n.getZ(i));
      const c = color(p.getY(i));
      tint.push(c[0], c[1], c[2]);
    }
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  out.setAttribute('aTint', new THREE.Float32BufferAttribute(tint, 3));
  return out;
}

/** 角ばった岩 (半径およそ 1)。向きと縦横比を個体ごとに変えて使い回す。 */
function rockGeometry() {
  const g = new THREE.IcosahedronGeometry(1, 1);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    // 位置だけで決まる凹凸 (面ごとに複製された頂点がずれないように)
    const k = 1 + 0.22 * Math.sin(x * 3.1 + 1.3) * Math.sin(y * 2.7 + 0.4) + 0.16 * Math.sin(z * 4.3 + x * 2.2 + 2.1);
    p.setXYZ(i, x * k, y * k, z * k);
  }
  g.computeVertexNormals(); // 頂点を共有していないので、面ごとに平らな法線になる
  return merge([{ geo: g, color: (y) => { const s = 0.78 + 0.22 * sat(y * 0.5 + 0.5); return [s, s, s]; } }]);
}

/** 針葉樹 (高さ 1、根元が原点)。 */
function coniferGeometry() {
  const trunk = new THREE.CylinderGeometry(0.03, 0.045, 0.3, 5, 1, true).translate(0, 0.15, 0);
  const leaf = (y) => { const s = 0.5 + 0.6 * sat(y); return [0.05 * s, 0.13 * s, 0.055 * s]; };
  const parts = [{ geo: trunk, color: () => [0.11, 0.075, 0.05] }];
  for (const [r, h, y] of [[0.2, 0.42, 0.4], [0.15, 0.36, 0.64], [0.095, 0.3, 0.85]]) {
    parts.push({ geo: new THREE.ConeGeometry(r, h, 7, 1, true).translate(0, y, 0), color: leaf });
  }
  return merge(parts);
}

/** 広葉樹 (高さ 1、根元が原点)。 */
function broadleafGeometry() {
  const trunk = new THREE.CylinderGeometry(0.035, 0.055, 0.45, 5, 1, true).translate(0, 0.225, 0);
  const crown = new THREE.IcosahedronGeometry(1, 1);
  const p = crown.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const k = 1 + 0.2 * Math.sin(x * 4.1 + 0.7) * Math.sin(z * 3.6 + 1.9) + 0.12 * Math.sin(y * 5.2 + x * 3);
    p.setXYZ(i, x * k * 0.36, y * k * 0.32 + 0.66, z * k * 0.36);
  }
  crown.computeVertexNormals();
  return merge([
    { geo: trunk, color: () => [0.12, 0.085, 0.055] },
    // 下の方ほど暗くして、葉むらの奥行きに見せる
    { geo: crown, color: (y) => { const s = 0.45 + 0.75 * sat((y - 0.34) / 0.64); return [0.075 * s, 0.17 * s, 0.05 * s]; } },
  ]);
}

// ---------------------------------------------------------------- 遠くの木 (ビルボード)

const TILE_PX = 128;
const toSrgb = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
const css = (c, k = 1) => `rgb(${c.map((v) => Math.round(255 * toSrgb(Math.min(1, v * k)))).join(',')})`;

/**
 * ビルボードに貼る絵 (横2 × 縦2 のアトラス) を canvas に描いて作る。
 * 列 0 = 横から見た姿、列 1 = 真上から見た姿。行 0 = 針葉樹、行 1 = 広葉樹。
 * 形と色は上のメッシュ (coniferGeometry, broadleafGeometry) に合わせてある。
 * 色は光の当たっていない素の色で、陰影はシェーダーが付ける。
 */
function treeAtlas() {
  const S = TILE_PX * 2;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = S;
  const ctx = canvas.getContext('2d');

  // タイル (col, row) の中を、木の座標 (x: 幹が 0, y: 根元が 0) で描けるようにする。
  // halfW = タイルの幅の半分にあたる長さ、spanY = タイルの高さにあたる長さ
  const tile = (col, row, halfW, y0, spanY, draw) => {
    ctx.save();
    ctx.beginPath();
    ctx.rect(col * TILE_PX, S - (row + 1) * TILE_PX, TILE_PX, TILE_PX);
    ctx.clip();
    ctx.translate((col + 0.5) * TILE_PX, S - row * TILE_PX);
    ctx.scale(TILE_PX / (2 * halfW), -TILE_PX / spanY);
    ctx.translate(0, -y0);
    draw();
    ctx.restore();
  };
  const vertical = (y0, y1, c, k0, k1) => {
    const g = ctx.createLinearGradient(0, y0, 0, y1);
    g.addColorStop(0, css(c, k0));
    g.addColorStop(1, css(c, k1));
    return g;
  };
  const radial = (r, c, k0, k1) => {
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, r);
    g.addColorStop(0, css(c, k0));
    g.addColorStop(1, css(c, k1));
    return g;
  };
  const blob = (cx, cy, rx, ry) => { // でこぼこした丸
    ctx.beginPath();
    for (let i = 0; i <= 40; i++) {
      const a = (i / 40) * Math.PI * 2;
      const k = 1 + 0.1 * Math.sin(a * 5 + 0.6) + 0.07 * Math.sin(a * 9 + 2);
      ctx.lineTo(cx + Math.cos(a) * rx * k, cy + Math.sin(a) * ry * k);
    }
    ctx.fill();
  };

  const CON = [0.05, 0.13, 0.055], BRD = [0.075, 0.17, 0.05];
  // 針葉樹を横から: 幹と、3段に重なった円錐
  tile(0, 0, 0.25, 0, 1.02, () => {
    ctx.fillStyle = css([0.11, 0.075, 0.05]);
    ctx.fillRect(-0.04, 0, 0.08, 0.32);
    for (const [r, h, y] of [[0.2, 0.42, 0.4], [0.15, 0.36, 0.64], [0.095, 0.3, 0.85]]) {
      const b = y - h / 2, t = y + h / 2;
      ctx.fillStyle = vertical(b, t, CON, 0.5 + 0.6 * b, 0.5 + 0.6 * Math.min(1, t));
      ctx.beginPath();
      ctx.moveTo(-r, b); ctx.lineTo(r, b); ctx.lineTo(0, t);
      ctx.fill();
    }
  });
  // 針葉樹を上から: 中心 (梢) が明るい円
  tile(1, 0, 0.23, -0.23, 0.46, () => {
    ctx.fillStyle = radial(0.2, CON, 1.1, 0.62);
    blob(0, 0, 0.19, 0.19);
  });
  // 広葉樹を横から: 幹と、下が暗い葉むら
  tile(0, 1, 0.45, 0, 1.02, () => {
    ctx.fillStyle = css([0.12, 0.085, 0.055]);
    ctx.fillRect(-0.045, 0, 0.09, 0.5);
    ctx.fillStyle = vertical(0.34, 0.98, BRD, 0.45, 1.2);
    blob(0, 0.66, 0.36, 0.3);
  });
  // 広葉樹を上から
  tile(1, 1, 0.45, -0.45, 0.9, () => {
    ctx.fillStyle = radial(0.4, BRD, 1.15, 0.8);
    blob(0, 0, 0.37, 0.37);
  });

  // 透明な所にも葉の色を入れておく (縮小されたときに縁が黒ずまないように)。
  // canvas は上の行が先、テクスチャは下の行が先なので、上下を入れ替えながら写す
  const src = ctx.getImageData(0, 0, S, S).data;
  const data = new Uint8Array(S * S * 4);
  const fill = [CON, BRD].map((c) => c.map((v) => Math.round(255 * toSrgb(v * 0.8))));
  for (let y = 0; y < S; y++) {
    const f = fill[y < TILE_PX ? 0 : 1];
    for (let x = 0; x < S; x++) {
      const i = ((S - 1 - y) * S + x) * 4, o = (y * S + x) * 4;
      const a = src[i + 3];
      data[o] = a > 8 ? src[i] : f[0];
      data[o + 1] = a > 8 ? src[i + 1] : f[1];
      data[o + 2] = a > 8 ? src[i + 2] : f[2];
      data[o + 3] = a;
    }
  }
  const tex = new THREE.DataTexture(data, S, S, THREE.RGBAFormat);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

/** ビルボード1本ぶんの形: 縦の板と水平な板 (z で区別する)。 */
function billboardGeometry() {
  const g = new THREE.InstancedBufferGeometry();
  const quad = (z) => [-0.5, 0, z, 0.5, 0, z, 0.5, 1, z, -0.5, 1, z];
  g.setAttribute('position', new THREE.Float32BufferAttribute([...quad(0), ...quad(1)], 3));
  g.setIndex([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7]);
  for (const name of ['iPos', 'iSize', 'iCol']) {
    const attr = new THREE.InstancedBufferAttribute(new Float32Array(BILLBOARD_MAX * 3), 3);
    attr.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute(name, attr);
  }
  g.instanceCount = 0;
  return g;
}

// ---------------------------------------------------------------- 区画の中身を決める

const ROCK_DENSITY = { rock: 0.9, desert: 0.7, lava: 0.75, ice: 0.4, terran: 0.28 };
const ROCKS_PER_CELL = 16;
const TREES_PER_CELL = 56;

const _d = [0, 0, 0], _e = [0, 0, 0], _col = [0, 0, 0, 0];
const _pos = new THREE.Vector3(), _scl = new THREE.Vector3(), _up = new THREE.Vector3();
const _nrm = new THREE.Vector3(), _t1 = new THREE.Vector3(), _t2 = new THREE.Vector3();
const _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _m = new THREE.Matrix4();
const _Y = new THREE.Vector3(0, 1, 0);

/** 区画ごとの乱数のシード。 */
function cellSeed(seed, layer, face, ix, iy) {
  let h = Math.imul(seed | 0, 0x9e3779b1) ^ Math.imul(layer + 1, 0x85ebca6b);
  h = Math.imul(h ^ face, 0xc2b2ae35) ^ Math.imul(ix, 0x27d4eb2d) ^ Math.imul(iy, 0x165667b1);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  return (h ^ (h >>> 13)) >>> 0;
}

/**
 * 点 _d (単位ベクトル) での地面の法線を _nrm に、鉛直を _up に入れ、標高を返す。
 * span (m) 離れた2点との高さの差から傾きを求める。
 */
function sampleGround(terrain, span) {
  const R = terrain.radius;
  _up.set(_d[0], _d[1], _d[2]);
  const h = terrain.height(_d[0], _d[1], _d[2], 1);
  if (h <= 0) { // 水面や平らな低地
    _nrm.copy(_up);
    return h;
  }
  _t1.set(0, 1, 0);
  if (Math.abs(_up.y) > 0.9) _t1.set(1, 0, 0);
  _t1.cross(_up).normalize();
  _t2.crossVectors(_up, _t1);
  const a = span / R;
  let x = _d[0] + _t1.x * a, y = _d[1] + _t1.y * a, z = _d[2] + _t1.z * a;
  let inv = 1 / Math.sqrt(x * x + y * y + z * z);
  const h1 = Math.max(0, terrain.height(x * inv, y * inv, z * inv, 1));
  x = _d[0] + _t2.x * a; y = _d[1] + _t2.y * a; z = _d[2] + _t2.z * a;
  inv = 1 / Math.sqrt(x * x + y * y + z * z);
  const h2 = Math.max(0, terrain.height(x * inv, y * inv, z * inv, 1));
  _nrm.copy(_up).addScaledVector(_t1, -(h1 - h) / span).addScaledVector(_t2, -(h2 - h) / span).normalize();
  return h;
}

/**
 * 区画の中身を作る。three.js の描画には触れないので、単体テストから直接呼べる。
 * @param layer 0 = 岩, 1 = 木
 * @param n 面の一辺の区画数
 * @returns { center: [x,y,z] (惑星ローカル), lists: { [kind]: { matrices, colors, dims, count } } }
 *   matrices は center からの相対位置で入っている
 */
export function buildCell(terrain, layer, face, ix, iy, n) {
  const R = terrain.radius;
  const rand = mulberry32(cellSeed(terrain.seed, layer, face, ix, iy));
  faceDir(face, (ix + 0.5) / n, (iy + 0.5) / n, _e);
  const hC = terrain.height(_e[0], _e[1], _e[2], 100);
  const rc = R + Math.max(0, hC);
  const center = [_e[0] * rc, _e[1] * rc, _e[2] * rc];
  const acc = {}; // kind → { m: [], c: [] }
  const push = (kind, r, g, b) => {
    const a = acc[kind] || (acc[kind] = { m: [], c: [], d: [] });
    _pos.x -= center[0]; _pos.y -= center[1]; _pos.z -= center[2];
    _m.compose(_pos, _q, _scl);
    for (let i = 0; i < 16; i++) a.m.push(_m.elements[i]);
    a.c.push(r, g, b);
    a.d.push(_scl.x, _scl.y);
  };

  if (layer === 0) {
    const base = ROCK_DENSITY[terrain.type] ?? 0.5;
    const flooded = terrain.type === 'terran' || terrain.type === 'lava' || terrain.type === 'ice';
    for (let k = 0; k < ROCKS_PER_CELL; k++) {
      // 乱数は採否にかかわらず同じ数だけ引く (一部の条件が変わっても他の岩が動かないように)
      const s = (ix + rand()) / n, t = (iy + rand()) / n;
      const pick = rand(), u = rand(), big = rand(), big2 = rand();
      const r1 = rand(), r2 = rand(), r3 = rand(), yaw = rand(), tiltA = rand(), tiltB = rand(), shade = rand();
      faceDir(face, s, t, _d);
      // 岩は一様にではなく、数十 m の塊になって散らばる
      const f = R / 90;
      const cl = terrain.noise(_d[0] * f + 5.5, _d[1] * f - 2.5, _d[2] * f + 8.5);
      let density = base * (0.1 + 0.9 * smooth(-0.15, 0.45, cl));
      if (pick > Math.min(1, density * 1.6)) continue; // 斜面で増える分の余裕を見て先にふるい落とす
      const h = sampleGround(terrain, 1.5);
      if (h <= 0 && flooded) continue; // 海・溶岩・氷の海の上
      const slope = _nrm.dot(_up);
      if (slope < 0.55) continue; // 崖には乗らない
      density *= 1 + 0.6 * smooth(0.97, 0.8, slope); // 斜面の下には岩が多い
      if (terrain.type === 'terran') density *= 0.6 + 1.6 * smooth(1200, 3500, h); // 高山は岩だらけ
      if (pick > density) continue;

      let size = 0.25 + 2.0 * u * u * u;
      if (big < 0.03) size = 3 + 4 * big2;
      _scl.set(size * (0.8 + 0.5 * r1), size * (0.5 + 0.4 * r2), size * (0.8 + 0.5 * r3));
      _q.setFromUnitVectors(_Y, _nrm);
      _q2.setFromAxisAngle(_Y, yaw * Math.PI * 2);
      _q.multiply(_q2);
      _q2.setFromAxisAngle(_t1.set(1, 0, 0), (tiltA - 0.5) * 0.9);
      _q.multiply(_q2);
      _q2.setFromAxisAngle(_t1.set(0, 0, 1), (tiltB - 0.5) * 0.9);
      _q.multiply(_q2);
      // 少し地面に埋める
      _pos.copy(_up).multiplyScalar(R + Math.max(0, h)).addScaledVector(_nrm, -0.3 * _scl.y);
      // 色はその場所の「急斜面の岩」の色に合わせる
      terrain.color(_col, Math.max(h, 1), 0.5, _d[0], _d[1], _d[2]);
      const k2 = 0.85 + 0.35 * shade;
      push(KIND_ROCK, _col[0] * k2, _col[1] * k2, _col[2] * k2);
    }
  } else {
    // 区画の中心で森かどうかを見て、森でなければ何もしない
    const fC = hC < -100 ? 0 : terrain.forest(Math.max(hC, 30), _e[0], _e[1], _e[2]);
    if (fC > 0.02) {
      for (let k = 0; k < TREES_PER_CELL; k++) {
        const s = (ix + rand()) / n, t = (iy + rand()) / n;
        const pick = rand(), kindR = rand(), tall = rand(), wide = rand(), yaw = rand();
        const c1 = rand(), c2 = rand();
        faceDir(face, s, t, _d);
        // 森の中にも空き地がある
        const f = R / 70;
        const gap = smooth(-0.35, 0.15, terrain.noise(_d[0] * f - 3.5, _d[1] * f + 6.5, _d[2] * f + 1.5));
        if (pick > fC * (0.25 + 0.75 * gap)) continue;
        const h = sampleGround(terrain, 2);
        if (h < 3) continue; // 海と砂浜
        if (_nrm.dot(_up) < 0.8) continue; // 急斜面
        const warm = terrain.warmth(h, _d[1]);
        if (warm < 0.3) continue; // 森林限界
        const conifer = warm < 0.6 + (kindR - 0.5) * 0.2;
        const height = conifer ? 9 + 13 * tall : 7 + 9 * tall;
        const width = height * (conifer ? 0.75 + 0.4 * wide : 0.9 + 0.6 * wide);
        _scl.set(width, height, width);
        _q.setFromUnitVectors(_Y, _up);
        _q2.setFromAxisAngle(_Y, yaw * Math.PI * 2);
        _q.multiply(_q2);
        _pos.copy(_up).multiplyScalar(R + h - 0.4);
        push(conifer ? KIND_CONIFER : KIND_BROADLEAF, 0.75 + 0.5 * c1, 0.8 + 0.4 * c2, 0.75 + 0.5 * c1);
      }
    }
  }

  const lists = {};
  for (const kind in acc) {
    lists[kind] = {
      matrices: new Float32Array(acc[kind].m), colors: new Float32Array(acc[kind].c),
      dims: new Float32Array(acc[kind].d), // 幅と高さ (ビルボード用)
      count: acc[kind].c.length / 3,
    };
  }
  return { center, lists };
}

// ---------------------------------------------------------------- 描画

const LAYERS = [
  { cell: 48, radius: 420 }, // 岩
  { cell: 96, radius: TREE_FAR }, // 木
];
// near: この距離より先はメッシュでは描かない (木はビルボードが引き継ぐ)
const KINDS = [
  { layer: 0, max: 6000, geometry: rockGeometry, wrap: 0, doubleSide: false, near: LAYERS[0].radius, cut: false },
  { layer: 1, max: 6000, geometry: coniferGeometry, wrap: 0.7, doubleSide: true, near: TREE_NEAR, cut: true },
  { layer: 1, max: 6000, geometry: broadleafGeometry, wrap: 0.7, doubleSide: true, near: TREE_NEAR, cut: true },
];

const _cam = new THREE.Vector3();
const _f = [0, 0, 0];

export class Scatter {
  /**
   * @param terrain makeTerrain の戻り値
   * @param uniforms 惑星の uniform (地表と共有)
   * @param group 惑星の Group (惑星ローカル座標)
   */
  constructor(terrain, uniforms, group) {
    this.terrain = terrain;
    this.uniforms = uniforms;
    this.group = group;
    const R = terrain.radius;
    // 木は海洋惑星にしかない
    const layerCount = terrain.type === 'terran' ? 2 : 1;
    this.layers = LAYERS.slice(0, layerCount).map((def, index) => {
      const level = Math.max(0, Math.round(Math.log2((Math.PI / 2) * R / def.cell)));
      const n = 2 ** level;
      return {
        index, n, radius: def.radius, size: (Math.PI / 2) * R / n,
        cells: new Map(), queue: [], lastCam: null,
      };
    });
    this.meshes = null; // 初めて地表に近づいたときに作る
    this.anchor = new THREE.Vector3();
    this.hasAnchor = false;
    this.active = false;
    this.count = 0; // メッシュで描いている個数 (デバッグ表示用)
    this.trees = 0; // 木の総数 (ビルボードを含む)
    this.billboards = null;
  }

  _createMeshes() {
    this.meshes = KINDS.map((k) => {
      if (k.layer >= this.layers.length) return null;
      const material = createScatterMaterial(this.uniforms, {
        fadeDist: k.near, wrap: k.wrap, doubleSide: k.doubleSide, cut: k.cut,
      });
      const mesh = new THREE.InstancedMesh(k.geometry(), material, k.max);
      mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(k.max * 3), 3);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
      mesh.count = 0;
      mesh.frustumCulled = false;
      this.group.add(mesh);
      return mesh;
    });
    // 遠くの木
    this.billboards = null;
    if (this.layers.length > 1) {
      this.atlas = treeAtlas();
      this.billboards = new THREE.Mesh(billboardGeometry(), createTreeBillboardMaterial(this.uniforms, {
        map: this.atlas, near: TREE_NEAR, far: TREE_FAR,
      }));
      this.billboards.frustumCulled = false;
      this.billboards.visible = false;
      this.group.add(this.billboards);
    }
  }

  /** camLocal: 惑星ローカル座標でのカメラ位置。毎フレーム呼ぶ。 */
  update(camLocal) {
    const R = this.terrain.radius;
    const r = camLocal.length();
    let near = r - R < MAX_ALT + 15000;
    if (near) {
      const h = this.terrain.height(camLocal.x / r, camLocal.y / r, camLocal.z / r, 50);
      near = r - R - Math.max(0, h) < MAX_ALT;
    }
    if (!near) {
      if (this.active) this._hide();
      return;
    }
    if (!this.meshes) this._createMeshes();
    this.active = true;

    let changed = false;
    for (const layer of this.layers) {
      if (!layer.lastCam || layer.lastCam.distanceTo(camLocal) > layer.size * 0.3) {
        this._collect(layer, camLocal);
        changed = true;
      }
    }
    // 近い区画から、時間の許す範囲で中身を作る
    const t0 = performance.now();
    outer:
    for (const layer of this.layers) {
      while (layer.queue.length) {
        const cell = layer.queue.pop();
        if (cell.dead) continue;
        const built = buildCell(this.terrain, layer.index, cell.face, cell.ix, cell.iy, layer.n);
        cell.center = built.center;
        cell.lists = built.lists;
        changed = true;
        if (performance.now() - t0 > BUDGET_MS) break outer;
      }
    }
    if (!this.hasAnchor || this.anchor.distanceTo(camLocal) > REANCHOR) {
      this.anchor.copy(camLocal);
      this.hasAnchor = true;
      changed = true;
    }
    if (changed) this._upload();
  }

  /** カメラのまわりの区画を数え直し、新しい区画を生成待ちに入れ、遠ざかった区画を捨てる。 */
  _collect(layer, cam) {
    layer.lastCam = (layer.lastCam || new THREE.Vector3()).copy(cam);
    const R = this.terrain.radius, n = layer.n;
    const reach = layer.radius + layer.size;
    _up.copy(cam).normalize();
    _t1.set(0, 1, 0);
    if (Math.abs(_up.y) > 0.9) _t1.set(1, 0, 0);
    _t1.cross(_up).normalize();
    _t2.crossVectors(_up, _t1);

    // 接平面に細かめの格子を敷き、各点がどの区画に入るかを調べる
    // (立方体の面の境目をまたいでも同じ手順で済む)
    const step = layer.size * 0.7;
    const N = Math.ceil(reach / step);
    const wanted = new Set();
    for (let j = -N; j <= N; j++) {
      for (let i = -N; i <= N; i++) {
        const a = i * step, b = j * step;
        if (a * a + b * b > reach * reach) continue;
        _cam.copy(_up).multiplyScalar(R).addScaledVector(_t1, a).addScaledVector(_t2, b).normalize();
        dirToFace(_cam.x, _cam.y, _cam.z, _f);
        const ix = Math.min(n - 1, Math.max(0, Math.floor(_f[1] * n)));
        const iy = Math.min(n - 1, Math.max(0, Math.floor(_f[2] * n)));
        const key = (_f[0] * n + ix) * n + iy;
        if (wanted.has(key)) continue;
        wanted.add(key);
        if (!layer.cells.has(key)) {
          const cell = { face: _f[0], ix, iy, d2: a * a + b * b, lists: null, center: null, dead: false };
          layer.cells.set(key, cell);
          layer.queue.push(cell);
        } else {
          layer.cells.get(key).d2 = a * a + b * b;
        }
      }
    }
    for (const [key, cell] of layer.cells) {
      if (!wanted.has(key)) {
        cell.dead = true;
        layer.cells.delete(key);
      }
    }
    // 末尾から取り出すので、遠い順に並べておく
    layer.queue = layer.queue.filter((c) => !c.dead).sort((p, q) => q.d2 - p.d2);
  }

  /** できあがっている区画の中身を、InstancedMesh のバッファへ詰め直す。 */
  _upload() {
    const ax = this.anchor.x, ay = this.anchor.y, az = this.anchor.z;
    this.count = 0;
    for (let kind = 0; kind < KINDS.length; kind++) {
      const mesh = this.meshes[kind];
      if (!mesh) continue;
      const layer = this.layers[KINDS[kind].layer];
      const max = KINDS[kind].max;
      const M = mesh.instanceMatrix.array, C = mesh.instanceColor.array;
      // メッシュで描く範囲にかかる区画だけを入れる (d2 は少し古いので余裕を見る)
      const reach = KINDS[kind].near + layer.size * 2;
      let count = 0;
      for (const cell of layer.cells.values()) {
        const list = cell.lists && cell.lists[kind];
        if (!list || cell.d2 > reach * reach) continue;
        const take = Math.min(list.count, max - count);
        if (take <= 0) break;
        M.set(take === list.count ? list.matrices : list.matrices.subarray(0, take * 16), count * 16);
        C.set(take === list.count ? list.colors : list.colors.subarray(0, take * 3), count * 3);
        // 位置を「区画の中心から」から「基準点から」に直す
        const ox = cell.center[0] - ax, oy = cell.center[1] - ay, oz = cell.center[2] - az;
        for (let i = count; i < count + take; i++) {
          M[i * 16 + 12] += ox; M[i * 16 + 13] += oy; M[i * 16 + 14] += oz;
        }
        count += take;
      }
      mesh.count = count;
      mesh.visible = count > 0;
      mesh.position.copy(this.anchor);
      mesh.instanceMatrix.clearUpdateRanges();
      mesh.instanceMatrix.addUpdateRange(0, count * 16);
      mesh.instanceMatrix.needsUpdate = true;
      mesh.instanceColor.clearUpdateRanges();
      mesh.instanceColor.addUpdateRange(0, count * 3);
      mesh.instanceColor.needsUpdate = true;
      this.count += count;
    }
    if (this.billboards) this._uploadBillboards();
  }

  /** 木をすべてビルボードのバッファへ詰める。近い木を描かないのはシェーダーの側で決める。 */
  _uploadBillboards() {
    const ax = this.anchor.x, ay = this.anchor.y, az = this.anchor.z;
    const geo = this.billboards.geometry;
    const P = geo.attributes.iPos.array, S = geo.attributes.iSize.array, C = geo.attributes.iCol.array;
    let count = 0;
    outer:
    for (const cell of this.layers[1].cells.values()) {
      if (!cell.lists) continue;
      const ox = cell.center[0] - ax, oy = cell.center[1] - ay, oz = cell.center[2] - az;
      for (const kind of [KIND_CONIFER, KIND_BROADLEAF]) {
        const list = cell.lists[kind];
        if (!list) continue;
        // 遠くの区画は本数を半分にし、そのぶん幅を広げて森の濃さを保つ
        const thin = cell.d2 > THIN_DIST * THIN_DIST;
        const take = Math.min(thin ? Math.ceil(list.count / 2) : list.count, BILLBOARD_MAX - count);
        if (take <= 0) break outer;
        const wide = thin ? 1.4 : 1;
        const m = list.matrices, d = list.dims;
        for (let i = 0, o = count * 3; i < take; i++, o += 3) {
          P[o] = m[i * 16 + 12] + ox; P[o + 1] = m[i * 16 + 13] + oy; P[o + 2] = m[i * 16 + 14] + oz;
          S[o] = d[i * 2] * wide; S[o + 1] = d[i * 2 + 1]; S[o + 2] = kind - KIND_CONIFER;
        }
        C.set(take === list.count ? list.colors : list.colors.subarray(0, take * 3), count * 3);
        count += take;
      }
    }
    geo.instanceCount = count;
    for (const name of ['iPos', 'iSize', 'iCol']) {
      const attr = geo.attributes[name];
      attr.clearUpdateRanges();
      attr.addUpdateRange(0, count * 3);
      attr.needsUpdate = true;
    }
    this.billboards.visible = count > 0;
    this.billboards.position.copy(this.anchor);
    this.trees = count; // 木の総数 (うち近いものはメッシュで描いている)
  }

  _hide() {
    this.active = false;
    this.count = 0;
    this.trees = 0;
    for (const mesh of this.meshes || []) if (mesh) mesh.visible = false;
    if (this.billboards) this.billboards.visible = false;
    // 離れている間は区画を覚えておかない
    for (const layer of this.layers) {
      for (const cell of layer.cells.values()) cell.dead = true;
      layer.cells.clear();
      layer.queue = [];
      layer.lastCam = null;
    }
  }

  dispose() {
    for (const mesh of this.meshes || []) {
      if (!mesh) continue;
      this.group.remove(mesh);
      mesh.geometry.dispose();
      mesh.material.dispose();
      mesh.dispose();
    }
    if (this.billboards) {
      this.group.remove(this.billboards);
      this.billboards.geometry.dispose();
      this.billboards.material.dispose();
      this.atlas.dispose();
      this.billboards = null;
    }
    this.meshes = null;
  }
}
