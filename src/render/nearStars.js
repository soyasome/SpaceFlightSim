import * as THREE from 'three';
import { starsNear, LY } from '../universe/galaxy.js';

const MAX = 160;
const RANGE = 25; // 光年。これより近い恒星を「実物」として描く

/**
 * 近くの恒星。背景の星空とは別に、実際にある恒星を本当の方向に描く。
 * 飛ぶと位置がずれて見え、近づいた恒星はそのまま太陽になる。
 * 背景と同じく無限遠の点として描く (カメラと一緒に動く)。
 */
export class NearStars {
  constructor() {
    this.pos = new Float32Array(MAX * 3);
    this.col = new Float32Array(MAX * 3);
    this.size = new Float32Array(MAX);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(this.col, 3));
    geo.setAttribute('size', new THREE.BufferAttribute(this.size, 1));
    geo.setDrawRange(0, 0);
    this.material = new THREE.ShaderMaterial({
      uniforms: { uPixelRatio: { value: 1 }, uFade: { value: 1 } },
      vertexShader: /* glsl */ `
        attribute float size;
        attribute vec3 color;
        uniform float uPixelRatio;
        varying vec3 vColor;
        void main() {
          vColor = color;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = size * uPixelRatio;
        }`,
      fragmentShader: /* glsl */ `
        varying vec3 vColor;
        uniform float uFade;
        void main() {
          float d = length(gl_PointCoord - 0.5) * 2.0;
          // 中心が明るく、まわりに淡い光がにじむ
          float a = smoothstep(1.0, 0.0, d);
          a = a * a * 0.6 + smoothstep(0.35, 0.0, d);
          gl_FragColor = vec4(vColor * a * uFade, 1.0);
        }`,
      blending: THREE.AdditiveBlending,
      depthTest: false,
      depthWrite: false,
      transparent: false,
    });
    this.points = new THREE.Points(geo, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = -9;
    this.list = []; // [{ star, dist }]
    this.timer = 0;
  }

  /**
   * @param galPos 自機の銀河座標 [x,y,z] (光年)
   * @param current 今いる星系の恒星
   * @param hideCurrent 今の恒星を点として描かない (近くにいて、太陽の球として見えている)
   */
  update(dt, galPos, current, hideCurrent) {
    this.timer -= dt;
    if (this.timer <= 0) {
      this.timer = 0.25;
      this.list = starsNear(galPos, RANGE);
      if (this.list.length > MAX) this.list.length = MAX;
    }
    let n = 0;
    for (const { star } of this.list) {
      if (star === current && hideCurrent) continue;
      const dx = star.pos[0] - galPos[0], dy = star.pos[1] - galPos[1], dz = star.pos[2] - galPos[2];
      const d = Math.hypot(dx, dy, dz);
      if (d < 1e-9) continue;
      const k = 1000 / d;
      this.pos[n * 3] = dx * k;
      this.pos[n * 3 + 1] = dy * k;
      this.pos[n * 3 + 2] = dz * k;
      // 近いほど大きく明るい。遠い星は背景の星と同じくらいになる
      const near = Math.min(1, 0.6 / (d + 0.05));
      const b = (0.55 + 0.9 * Math.min(1, 3 / (d + 0.3))) * (0.7 + 0.3 * star.lum);
      this.col[n * 3] = star.color[0] * b;
      this.col[n * 3 + 1] = star.color[1] * b;
      this.col[n * 3 + 2] = star.color[2] * b;
      this.size[n] = 3 + 4.5 * Math.min(1, 4 / (d + 0.5)) + 14 * near;
      n++;
    }
    const geo = this.points.geometry;
    geo.setDrawRange(0, n);
    geo.attributes.position.needsUpdate = true;
    geo.attributes.color.needsUpdate = true;
    geo.attributes.size.needsUpdate = true;
  }
}

export { LY };
