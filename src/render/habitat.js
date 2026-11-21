import * as THREE from 'three';
import { HABITAT } from '../universe/habitat.js';

// オニール・シリンダーの外観。円筒ローカル座標 (Y = 軸、+Y が恒星の側) で組み立てる。
//
// 回るもの (spin): 外壁、窓、補強の輪、両端の蓋、鏡、農業の環
// 回らないもの: 影の側の入港口の筒、2本をつなぐ骨組み (組の1本目だけが持つ)
//
// 外壁は 6 本の帯に分かれる: 陸の帯 (金属の外板) と窓の帯 (ガラス) が 60° ごとに交互に並ぶ。
// 窓の外には鏡が開いている。鏡は影の側の端に蝶番があり、恒星の方へ花びらのように開いて、
// 恒星の光を窓の中へ跳ね返す。

const MIRROR_ANGLE = (30 * Math.PI) / 180; // 鏡の開き (外壁からの角度)

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
    this.omega = (def.spin * 2 * Math.PI) / HABITAT.spinPeriod;

    this.group = new THREE.Group(); // 位置と向きは game が毎フレーム置く
    this.spin = new THREE.Group(); // 見た目の回転
    this.group.add(this.spin);
    this.materials = [];
    this.geometries = [];
    this._build();
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

    // --- 両端の蓋 ---
    for (const s of [1, -1]) {
      const cap = new THREE.CircleGeometry(R, 96);
      cap.rotateX(-Math.PI / 2 * s); // 外向きの面
      cap.translate(0, H * s, 0);
      this._mesh(cap, hullMat);
      // 蓋の段々 (同心円の段)
      for (const rr of [0.35, 0.6, 0.82]) {
        const step = new THREE.TorusGeometry(R * rr, 40, 6, 96);
        step.rotateX(Math.PI / 2);
        step.translate(0, H * s + 20 * s, 0);
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
      const width = 2 * R * Math.sin(seg / 2) * 1.05;
      const geo = new THREE.PlaneGeometry(width, L);
      geo.translate(0, L / 2, 0); // 蝶番 (下の辺) を原点に
      const m = this._mesh(geo, mirrorMat);
      // 外壁に沿って立て (面の法線を外向き)、外へ MIRROR_ANGLE 倒す
      const out = new THREE.Vector3(Math.sin(a), 0, Math.cos(a));
      m.position.set(out.x * (R + 60), -H, out.z * (R + 60));
      m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), out);
      m.rotateX(MIRROR_ANGLE); // 上 (恒星側) の端を外へ
    }

    // --- 影の側: 入港口 (回らない) ---
    const port = new THREE.CylinderGeometry(420, 520, 1400, 32, 1, false);
    port.translate(0, -H - 700, 0);
    this._mesh(port, darkMat, this.group);
    const mouth = new THREE.TorusGeometry(430, 40, 8, 48);
    mouth.rotateX(Math.PI / 2);
    mouth.translate(0, -H - 1400, 0);
    this._mesh(mouth, lightMat, this.group);
    for (let k = 0; k < 8; k++) {
      const a = (k * Math.PI) / 4;
      const lamp = new THREE.SphereGeometry(45, 8, 6);
      lamp.translate(Math.cos(a) * 560, -H - 1300, Math.sin(a) * 560);
      this._mesh(lamp, lightMat, this.group);
    }

    // --- 2本をつなぐ骨組み (組の1本目だけ。もう1本はローカル X の +gap にある) ---
    if (this.def.spin > 0) {
      const gap = this.def.pair.gap;
      const trussMat = this._mat(metal(0x6f747b, 0.65));
      for (const s of [1, -1]) {
        const yy = (H + (s > 0 ? 2600 : 2000)) * s;
        const beam = new THREE.BoxGeometry(gap, 260, 260);
        beam.translate(gap / 2, yy, 0);
        this._mesh(beam, trussMat, this.group);
        // 軸受け: 蓋から骨組みまでの軸 (両方の円筒)
        for (const x of [0, gap]) {
          const shaft = new THREE.CylinderGeometry(160, 160, Math.abs(yy) - H, 16);
          shaft.translate(x, (H + (Math.abs(yy) - H) / 2) * s, 0);
          this._mesh(shaft, trussMat, this.group);
        }
      }
    }
  }

  /** 時刻 t (秒) の見た目の回転。 */
  updateRotation(t) {
    this.spin.rotation.y = this.omega * t;
  }

  /** 世界座標の点 world を、円筒ローカル座標にして out に入れる。 */
  toLocal(world, out) {
    return out.copy(world).sub(this.pos).applyQuaternion(this.quatInv);
  }

  dispose() {
    for (const g of this.geometries) g.dispose();
    for (const m of this.materials) m.dispose();
  }
}
