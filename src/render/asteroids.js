import * as THREE from 'three';
import { mulberry32 } from '../math/random.js';

/** でこぼこした岩の形状を作る (頂点位置の関数でずらすので継ぎ目は開かない)。 */
function rockGeometry() {
  const geo = new THREE.IcosahedronGeometry(1, 3);
  const p = geo.attributes.position;
  const v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    const n =
      Math.sin(v.x * 3.1 + 1.3) * Math.sin(v.y * 2.7 + 0.4) * Math.sin(v.z * 3.3 + 2.1) * 0.28 +
      Math.sin(v.x * 7.3 + v.y * 5.1) * Math.sin(v.z * 6.7 - v.x * 4.2) * 0.09;
    v.multiplyScalar(1 + n);
    p.setXYZ(i, v.x, v.y, v.z);
  }
  geo.computeVertexNormals();
  return geo;
}

/**
 * 小惑星帯。中心は世界座標 (倍精度) で持ち、個々の岩は中心からの相対位置で置く。
 */
export class AsteroidField {
  constructor({ count = 450, radius = 14000, thickness = 2500, seed = 9 } = {}) {
    this.center = new THREE.Vector3(); // 世界座標
    const rand = mulberry32(seed);
    const mat = new THREE.MeshStandardMaterial({
      color: 0x8a8178, roughness: 0.95, metalness: 0.05, flatShading: true,
    });
    this.mesh = new THREE.InstancedMesh(rockGeometry(), mat, count);
    this.mesh.frustumCulled = false;
    this.rocks = []; // 当たり判定用の球 { x, y, z (中心からの相対位置), r }

    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3();
    const t = new THREE.Vector3();
    const color = new THREE.Color();
    for (let i = 0; i < count; i++) {
      const r = 300 + Math.sqrt(rand()) * radius;
      const a = rand() * Math.PI * 2;
      t.set(Math.cos(a) * r, (rand() - 0.5) * thickness, Math.sin(a) * r);
      q.setFromEuler(new THREE.Euler(rand() * 6.28, rand() * 6.28, rand() * 6.28));
      const size = 8 + Math.pow(rand(), 3) * 380;
      s.set(size * (0.7 + rand() * 0.6), size * (0.6 + rand() * 0.5), size * (0.7 + rand() * 0.6));
      this.mesh.setMatrixAt(i, m.compose(t, q, s));
      this.rocks.push({ x: t.x, y: t.y, z: t.z, r: ((s.x + s.y + s.z) / 3) * 0.9 });
      const shade = 0.75 + rand() * 0.4;
      this.mesh.setColorAt(i, color.setRGB(shade, shade * 0.97, shade * 0.93));
    }
  }
}
