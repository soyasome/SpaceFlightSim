import * as THREE from 'three';
import {
  HABITAT, interiorHeight, interiorGravity, interiorAir, inPort, inInterior, capContact, hullContact,
  MIRROR, trussParts, exteriorContact,
} from '../universe/habitat.js';
import { makeInteriorTerrain } from '../universe/habitatTerrain.js';
import { InteriorTerrain, InteriorProps, INTERIOR_LIGHT_GLSL } from './habitatInterior.js';

/** 中の1日の長さ (秒)。鏡を開いて昼、閉じて夜にする */
export const DAY_LENGTH = 24 * 60;

// オニール・シリンダーの外観と中、それに中にいるときの座標系の窓口。
// 円筒ローカル座標 (Y = 軸、+Y が恒星の側) で組み立てる。
//
// 回るもの (spin): 外壁、窓、補強の輪、両端の蓋、鏡、農業の環
// 回らないもの: 影の側の入港口の筒、2本をつなぐ骨組み (組の1本目だけが持つ)、中の陸と窓と蓋
//
// 回っているのは見た目だけで、中の物理は回らない座標系で計算する (設計書のシンプル版)。
// 中にいる間は外の回転を止め、陸・窓・鏡の並びを中の陸の帯にそろえる (3回対称なので 120° 単位でそろう)。
//
// 外壁は 6 本の帯に分かれる: 陸の帯 (金属の外板) と窓の帯 (ガラス) が 60° ごとに交互に並ぶ。
// 窓の外には鏡が開いている。鏡は影の側の端に蝶番があり、恒星の方へ花びらのように開いて、
// 恒星の光を窓の中へ跳ね返す。

const MIRROR_ANGLE = MIRROR.angle; // 鏡の開き (外壁からの角度)。寸法は universe/habitat.js の MIRROR

// 中の面の共通の頂点シェーダー。vLocal: 円筒ローカル座標、vRel: カメラからの相対位置
const INTERIOR_VERT = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_vertex>
  varying vec3 vLocal;
  varying vec3 vRel;
  void main() {
    vLocal = position;
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vRel = wp.xyz;
    gl_Position = projectionMatrix * viewMatrix * wp;
    #include <logdepthbuf_vertex>
  }`;

// 中から見た両端の蓋: 同心円の段々。光と霧は地形と同じ
const INTERIOR_FRAG = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_fragment>
  ${INTERIOR_LIGHT_GLSL}
  varying vec3 vLocal;
  varying vec3 vRel;
  float h21(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  void main() {
    #include <logdepthbuf_fragment>
    float r = length(vLocal.xz);
    vec3 N = vec3(0.0, -sign(vLocal.y), 0.0);
    vec3 L = interiorLight(vLocal);
    float band = floor(r / 320.0);
    float k = h21(vec2(band, sign(vLocal.y)));
    vec3 albedo = mix(vec3(0.24, 0.32, 0.16), vec3(0.42, 0.4, 0.3), k);
    albedo *= 0.85 + 0.15 * step(0.08, fract(r / 320.0));
    vec3 col = albedo * (sunColor() * max(dot(N, L), 0.0) + skyAmbient() * 1.5);
    col = applyFog(col, length(vRel));
    gl_FragColor = vec4(col, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }`;

// 中から見た窓: ほとんど透明なガラスと、格子状の桟。霧で少しかすむ
const GLASS_FRAG = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_fragment>
  ${INTERIOR_LIGHT_GLSL}
  varying vec3 vLocal;
  varying vec3 vRel;
  void main() {
    #include <logdepthbuf_fragment>
    float s = atan(vLocal.x, vLocal.z) * ${HABITAT.radius.toFixed(1)};
    vec2 q = vec2(s / 350.0, vLocal.y / 500.0);
    vec2 g = abs(fract(q) - 0.5);
    vec2 w = fwidth(q);
    float frame = max(step(0.5 - 0.008 - w.x, g.x), step(0.5 - 0.008 - w.y, g.y));
    frame *= 1.0 - smoothstep(0.08, 0.3, max(w.x, w.y)); // 遠くでは桟を消す
    float d = length(vRel);
    float fogK = 1.0 - exp(-d / 20000.0);
    vec3 col = mix(vec3(0.05, 0.06, 0.07), fogColor(), fogK);
    float a = clamp(frame * 0.5 + 0.05 + fogK * 0.85, 0.0, 1.0);
    gl_FragColor = vec4(col, a);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }`;
const _p = new THREE.Vector3();
const _qm = new THREE.Quaternion();
const _sp = new THREE.Vector3();
const _X = new THREE.Vector3(1, 0, 0);

// 金属らしさは控えめにする (環境マップがないので、金属の度合いが高いと何も映らず黒くなる)
const metal = (color, roughness = 0.6) => new THREE.MeshStandardMaterial({ color, roughness, metalness: 0.2 });

export class HabitatView {
  /** @param def system.habitats の1本 (src/universe/habitat.js の makeHabitatPair) */
  constructor(def) {
    this.def = def;
    this.name = def.name;
    this.radius = def.radius;
    this.sysPos = new THREE.Vector3(...def.position); // 星系座標
    this.pos = this.sysPos.clone(); // 世界座標 (原点が動くたびに game が計算し直す)
    // 円筒ローカル座標 → 星系座標の向き
    const y = new THREE.Vector3(...def.axis);
    const x = new THREE.Vector3(...def.side);
    const z = new THREE.Vector3().crossVectors(x, y);
    this.quat = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
    this.quatInv = this.quat.clone().invert();
    this.spinRate = (def.spin * 2 * Math.PI) / HABITAT.spinPeriod; // 見た目の回転の角速度
    this.angle = 0; // 見た目の回転の角度
    this.frozen = false; // 中にいる間は回転を止める
    this._t0 = 0;
    this._a0 = 0;

    // 座標系としての性質 (game.frame になったとき)
    this.omega = 0; // 物理の上では回らない
    this.gas = false;
    this.safe = true; // 安全地帯 (敵を呼べない)
    this.atmosphere = null;
    this.terrain = makeInteriorTerrain(def); // 中の地形 (当たり判定と描画で共通)

    this.group = new THREE.Group(); // 位置と向きは game が毎フレーム置く
    this.spin = new THREE.Group(); // 見た目の回転
    this.group.add(this.spin);
    this.materials = [];
    this.geometries = [];
    this.mirrors = [];
    this.elev = 1;
    this.day = 1;
    this._build();
    this.interior = new THREE.Group(); // 中 (回らない)。近くにいるときだけ描く
    this.group.add(this.interior);
    this._buildInterior();
  }

  _mat(m) {
    this.materials.push(m);
    return m;
  }

  _mesh(geo, mat, parent = this.spin) {
    this.geometries.push(geo);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    parent.add(mesh);
    return mesh;
  }

  _build() {
    const R = this.def.radius + this.def.hull, L = this.def.length, H = L / 2;
    const hullMat = this._mat(metal(0x8d9196, 0.55));
    const darkMat = this._mat(metal(0x55595f, 0.7));
    // 窓: 暗いガラス越しに、中の陸の帯の光がぼんやり見える
    const glassMat = this._mat(new THREE.MeshStandardMaterial({
      color: 0x1a2633, roughness: 0.15, metalness: 0.3, emissive: 0x6a5a3c, emissiveIntensity: 0.35,
    }));
    // 鏡: 映り込みは描かず、日の当たる明るい面と、強いハイライトで鏡らしく見せる
    const mirrorMat = this._mat(new THREE.MeshStandardMaterial({
      color: 0xd8e2ec, roughness: 0.18, metalness: 0.25, side: THREE.DoubleSide,
    }));
    const lightMat = this._mat(new THREE.MeshBasicMaterial({ color: 0xffd27a, toneMapped: false }));

    // --- 外壁と窓: 60° ごとに交互 (陸の帯は θ = 0°, 120°, 240° を中心にする) ---
    // θ は three.js の CylinderGeometry と同じく +Z から +X へ測る (向き = (sin θ, 0, cos θ))
    const seg = Math.PI / 3;
    for (let k = 0; k < 6; k++) {
      const land = k % 2 === 0;
      const geo = new THREE.CylinderGeometry(R, R, L, 24, 1, true, k * seg - seg / 2, seg);
      this._mesh(geo, land ? hullMat : glassMat);
    }
    // 補強の輪 (2 km ごと) と、窓の縁の桁
    for (let yy = -H; yy <= H + 1; yy += 2000) {
      const ring = new THREE.TorusGeometry(R + 15, 30, 6, 96);
      ring.rotateX(Math.PI / 2);
      ring.translate(0, yy, 0);
      this._mesh(ring, darkMat);
    }
    for (let k = 0; k < 6; k++) {
      const a = k * seg + seg / 2;
      const beam = new THREE.BoxGeometry(90, L, 90);
      beam.translate(Math.sin(a) * (R + 20), 0, Math.cos(a) * (R + 20));
      this._mesh(beam, darkMat);
    }

    // --- 両端の蓋 (影の側は入港口の穴があく) ---
    for (const s of [1, -1]) {
      const cap = s > 0 ? new THREE.CircleGeometry(R, 96) : new THREE.RingGeometry(HABITAT.portRadius + 100, R, 96, 1);
      cap.rotateX(-Math.PI / 2 * s); // 外向きの面
      cap.translate(0, H * s, 0);
      this._mesh(cap, hullMat);
      // 蓋の段々 (同心円の段)
      for (const rr of [0.35, 0.6, 0.82]) {
        const step = new THREE.TorusGeometry(R * rr, 40, 6, 96);
        step.rotateX(Math.PI / 2);
        step.translate(0, H * s + 60 * s, 0); // 太さ 40 m の輪が蓋の内側へはみ出さないように
        this._mesh(step, darkMat);
      }
    }

    // --- 恒星側: 農業の環と発電所の皿 ---
    const farm = new THREE.TorusGeometry(R * 1.55, 420, 12, 128);
    farm.rotateX(Math.PI / 2);
    farm.translate(0, H + 900, 0);
    this._mesh(farm, this._mat(metal(0xa3a07f, 0.7)));
    for (let k = 0; k < 6; k++) {
      const a = (k * Math.PI) / 3;
      const spoke = new THREE.BoxGeometry(R * 1.55, 120, 120);
      spoke.translate((R * 1.55) / 2, 0, 0);
      spoke.rotateY(a);
      spoke.translate(0, H + 900, 0);
      this._mesh(spoke, darkMat);
    }
    const dish = new THREE.SphereGeometry(R * 0.7, 48, 12, 0, Math.PI * 2, 0, 0.5);
    dish.rotateX(Math.PI); // 恒星の方へくぼんだ皿
    dish.translate(0, H + 300 + R * 0.7, 0);
    this._mesh(dish, this._mat(metal(0xd0c8b0, 0.3)));

    // --- 鏡: 窓の帯の外。影の側の端 (y = -H) に蝶番があり、恒星の方へ開く ---
    for (let k = 0; k < 3; k++) {
      const a = k * (2 * Math.PI / 3) + seg; // 窓の帯の中心
      const width = 2 * R * Math.sin(seg / 2) * MIRROR.widthK;
      const geo = new THREE.PlaneGeometry(width, L);
      geo.translate(0, L / 2, 0); // 蝶番 (下の辺) を原点に
      const m = this._mesh(geo, mirrorMat);
      // 外壁に沿って立て (面の法線を外向き)、外へ MIRROR_ANGLE 倒す
      const out = new THREE.Vector3(Math.sin(a), 0, Math.cos(a));
      m.position.set(out.x * (R + MIRROR.offset), -H, out.z * (R + MIRROR.offset));
      m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), out);
      this.mirrors.push({ mesh: m, base: m.quaternion.clone() }); // 開きは updateDay で決める (上 = 恒星側の端を外へ倒す)
    }

    // --- 影の側: 入港口の筒 (回らない)。外側と、中を通る内側の壁 ---
    const PR = HABITAT.portRadius, PL = HABITAT.portLength;
    const port = new THREE.CylinderGeometry(PR + 100, PR + 100, PL, 32, 1, true);
    port.translate(0, -H - PL / 2, 0);
    this._mesh(port, darkMat, this.group);
    const tube = new THREE.CylinderGeometry(PR, PR, PL + 200, 32, 4, true);
    tube.translate(0, -H - PL / 2 + 100, 0);
    this._mesh(tube, this._mat(metal(0x3d4147, 0.8)), this.group).material.side = THREE.BackSide;
    const mouth = new THREE.TorusGeometry(PR + 50, 40, 8, 48);
    mouth.rotateX(Math.PI / 2);
    mouth.translate(0, -H - PL, 0);
    this._mesh(mouth, lightMat, this.group);
    for (let k = 0; k < 8; k++) {
      const a = (k * Math.PI) / 4;
      for (const yy of [-H - PL + 100, -H - PL / 2, -H - 100]) { // 筒の中の誘導灯
        const lamp = new THREE.SphereGeometry(18, 8, 6);
        lamp.translate(Math.cos(a) * (PR - 10), yy, Math.sin(a) * (PR - 10));
        this._mesh(lamp, lightMat, this.group);
      }
    }

    // --- 2本をつなぐ骨組み (組の1本目だけ。寸法は universe/habitat.js の trussParts) ---
    const parts = trussParts(this.def);
    if (parts.length) {
      const trussMat = this._mat(metal(0x6f747b, 0.65));
      for (const p of parts) {
        const geo = p.round
          ? new THREE.CylinderGeometry(p.size[0] / 2, p.size[0] / 2, p.size[1], 16)
          : new THREE.BoxGeometry(...p.size);
        geo.translate(...p.center);
        this._mesh(geo, trussMat, this.group);
      }
    }
  }

  _buildInterior() {
    const R = this.def.radius, L = this.def.length, H = L / 2;
    const seg = Math.PI / 3;
    // 昼と夜 (中のすべての面で共有する)
    this.dayUniforms = { uDay: { value: 1 }, uElev: { value: 1 } };
    const uniforms = this.dayUniforms;
    // 陸の帯: 地形のチャンクと、木と家
    this.terrainView = new InteriorTerrain(this.def, this.terrain, uniforms, this.interior);
    this.props = new InteriorProps(this.def, this.terrain, uniforms, this.interior);
    // 蓋 (中から見える面)。影の側は入港口の穴があく
    const cap = this._mat(new THREE.ShaderMaterial({
      uniforms,
      side: THREE.BackSide,
      vertexShader: INTERIOR_VERT,
      fragmentShader: INTERIOR_FRAG,
    }));
    const sun = new THREE.CircleGeometry(R, 96);
    sun.rotateX(-Math.PI / 2); // 表を外 (+Y) に向ける。BackSide で描くので中から見える
    sun.translate(0, H, 0);
    this._mesh(sun, cap, this.interior);
    const shade = new THREE.RingGeometry(HABITAT.portRadius, R, 96, 1);
    shade.rotateX(Math.PI / 2); // 表を外 (-Y) に向ける
    shade.translate(0, -H, 0);
    this._mesh(shade, cap, this.interior);
    // 窓: 薄いガラスと桟。外の星空と鏡が透けて見える
    const glass = this._mat(new THREE.ShaderMaterial({
      uniforms,
      side: THREE.BackSide,
      transparent: true,
      depthWrite: false,
      vertexShader: INTERIOR_VERT,
      fragmentShader: GLASS_FRAG,
    }));
    for (let k = 1; k < 6; k += 2) {
      const geo = new THREE.CylinderGeometry(R, R, L, 48, 32, true, k * seg - seg / 2, seg);
      this._mesh(geo, glass, this.interior);
    }
  }

  /**
   * 中を描く準備 (中が見えているときに毎フレーム呼ぶ)。
   * @param camLocal 円筒ローカル座標でのカメラ
   * @param renderQuat 円筒ローカル → 描画座標の向き (group の向き)
   */
  updateInterior(camLocal, renderQuat) {
    this.terrainView.update(camLocal);
    this.props.update(camLocal);
    this.terrainView.setRotation(renderQuat);
  }

  /**
   * 鏡による昼と夜。時刻 t (秒) から、太陽の高さに当たる値 elev (-1..1) と昼の明るさ day (0..1) を決め、
   * 鏡の開きを変える (昼は 30° 開き、夜は窓に重なるまで閉じる)。ゲームの開始は朝。
   */
  updateDay(t) {
    const phase = (t / DAY_LENGTH + 0.3) % 1;
    this.elev = Math.sin(2 * Math.PI * (phase - 0.25));
    const x = Math.min(1, Math.max(0, (this.elev + 0.08) / 0.28));
    this.day = x * x * (3 - 2 * x);
    this.dayUniforms.uDay.value = this.day;
    this.dayUniforms.uElev.value = this.elev;
    const open = MIRROR_ANGLE * (0.04 + 0.96 * this.day);
    for (const m of this.mirrors) m.mesh.quaternion.copy(m.base).multiply(_qm.setFromAxisAngle(_X, open));
  }

  /** 時刻 t (秒) の見た目の回転。中にいる間は止める。 */
  updateRotation(t) {
    if (!this.frozen) this.angle = this._a0 + this.spinRate * (t - this._t0);
    this.spin.rotation.y = this.angle;
    this.updateDay(t);
  }

  /** 中に入った: 回転を止め、陸・窓・鏡の並びを中の陸の帯にそろえる (いちばん近い 120° の倍数へ)。 */
  freeze() {
    const step = (2 * Math.PI) / 3;
    this.angle = Math.round(this.angle / step) * step;
    this.frozen = true;
    this.spin.rotation.y = this.angle;
  }

  /** 外に出た: 止めた角度から回転を続ける (角度が飛ばないように)。 */
  unfreeze(t) {
    this._a0 = this.angle;
    this._t0 = t;
    this.frozen = false;
  }

  // ---------------------------------------------------------------- 座標系の窓口 (planet.js と同じ名前)
  // 引数の点は、world と書いたもの以外は円筒ローカル座標。

  /** 世界座標の点 world が、入港口の筒の中にあるか (ここで円筒の座標系に入る)。 */
  entersAt(world) {
    const p = this.toLocal(world, _p);
    return inPort(this.def, p.x, p.y, p.z);
  }

  /** まだ円筒の中か。出るのは、入港口の筒の外の端を抜けたときだけ。 */
  containsLocal(p) {
    return inInterior(this.def, p.x, p.y, p.z);
  }

  /** 世界座標の点 world から外壁までの距離。 */
  surfaceDistance(world) {
    const p = this.toLocal(world, _p);
    return hullContact(this.def, p.x, p.y, p.z).distance;
  }

  /** 真上 = 軸の方。軸の上ではどちらでもよいので +X にする。 */
  upAt(p, out) {
    const r = Math.hypot(p.x, p.z);
    return r > 1e-6 ? out.set(-p.x / r, 0, -p.z / r) : out.set(1, 0, 0);
  }

  heightAbove(p) {
    return interiorHeight(this.def, p.x, p.y, p.z, this.terrain);
  }

  roughHeightAbove(p) {
    return this.heightAbove(p);
  }

  /** 基準面 (中の地面) からの高さ。 */
  seaLevelAt(p) {
    return this.def.radius - Math.hypot(p.x, p.z);
  }

  /** 重力: 軸から外向きに g · r / R。 */
  gravityAt(p, out) {
    return out.set(p.x, 0, p.z).multiplyScalar(interiorGravity(this.def, 1));
  }

  airDensityAt(p) {
    return interiorAir(this.def, Math.hypot(p.x, p.z));
  }

  /** 点 p と同じ向き・同じ y の、地面から alt 上の点。軸の上なら +X の側。 */
  surfacePoint(p, alt, out) {
    const H = this.def.length / 2 - 500;
    const r = Math.hypot(p.x, p.z);
    const x = r > 1e-6 ? p.x / r : 1, z = r > 1e-6 ? p.z / r : 0;
    const y = Math.min(H, Math.max(-H, p.y));
    const g = this.def.radius - this.terrain.ground(Math.atan2(x, z), y) - alt;
    return out.set(x * g, y, z * g);
  }

  /** 宇宙港のパッドの中心 (円筒ローカル座標)。 */
  get spaceport() {
    return _sp.set(...this.terrain.spaceport);
  }

  /**
   * 外にいるときの当たり判定 (外壁・鏡・骨組み・入港口の筒)。鏡は今の回転と開きの位置で調べる。
   * @param local 円筒ローカル座標の点
   * @returns { depth, normal: [x,y,z] (円筒ローカル座標), what } | null
   */
  exteriorContact(local) {
    const open = MIRROR_ANGLE * (0.04 + 0.96 * this.day);
    return exteriorContact(this.def, this.angle, open, local.x, local.y, local.z);
  }

  /** 両端の蓋との当たり (機体の中心を蓋から margin 離す)。 */
  wallContact(p, margin) {
    return capContact(this.def, p.x, p.y, p.z, margin);
  }

  /**
   * 中の点 p に差し込む鏡の光の向き (光の来る方, 円筒ローカル座標)。向かいの窓から、恒星の側へ傾いて入る。
   * 鏡の開きが小さい (朝夕) ほど低い角度から差す。シェーダーの interiorLight (habitatInterior.js) と同じ式
   */
  lightDirAt(p, out) {
    this.upAt(p, out).multiplyScalar(0.25 + 0.65 * Math.max(this.elev, 0));
    out.y += 0.6;
    return out.normalize();
  }

  /** 世界座標の点 world が、入港口の前 (筒の外の端から 8 km 以内、軸から 3 km 以内) にあるか。 */
  nearPort(world) {
    const p = this.toLocal(world, _p);
    const H = this.def.length / 2;
    return p.y < -H && p.y > -H - HABITAT.portLength - 8000 && Math.hypot(p.x, p.z) < 3000;
  }

  /** 世界座標の点 world を、円筒ローカル座標にして out に入れる。 */
  toLocal(world, out) {
    return out.copy(world).sub(this.pos).applyQuaternion(this.quatInv);
  }

  dispose() {
    for (const g of this.geometries) g.dispose();
    for (const m of this.materials) m.dispose();
    this.terrainView.dispose();
    this.props.dispose();
  }
}
