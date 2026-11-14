import * as THREE from 'three';
import { mulberry32, gaussian } from '../math/random.js';

/**
 * 背景の星空。カメラと一緒に動く (常に原点に置く) ので、無限遠にあるように見える。
 * 一部の星を銀河面に集めて天の川の帯を作る。
 */
export function createStarfield(seed = 1234, count = 9000) {
  const rand = mulberry32(seed);
  const pos = new Float32Array(count * 3);
  const col = new Float32Array(count * 3);
  const size = new Float32Array(count);

  // 恒星の色 (高温の青白 〜 低温の赤)
  const palette = [
    [0.62, 0.72, 1.0], [0.8, 0.86, 1.0], [1.0, 1.0, 1.0],
    [1.0, 0.96, 0.84], [1.0, 0.84, 0.62], [1.0, 0.66, 0.46],
  ];
  // 銀河面の向き (適当に傾ける)
  const tilt = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.9, 0.3, 0.4));
  const v = new THREE.Vector3();

  for (let i = 0; i < count; i++) {
    const inBand = rand() < 0.6;
    const lon = rand() * Math.PI * 2;
    const lat = inBand ? gaussian(rand) * 0.16 : Math.asin(rand() * 2 - 1);
    v.set(Math.cos(lat) * Math.cos(lon), Math.sin(lat), Math.cos(lat) * Math.sin(lon));
    v.applyQuaternion(tilt).multiplyScalar(1000);
    pos.set([v.x, v.y, v.z], i * 3);

    // 明るい星ほど少ない
    const mag = Math.pow(rand(), inBand ? 5 : 3.2);
    const c = palette[Math.floor(rand() * palette.length)];
    const b = 0.25 + mag * 1.1;
    col.set([c[0] * b, c[1] * b, c[2] * b], i * 3);
    size[i] = 1.0 + mag * 2.6;
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.setAttribute('size', new THREE.BufferAttribute(size, 1));

  const mat = new THREE.ShaderMaterial({
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
        float a = smoothstep(1.0, 0.1, d);
        gl_FragColor = vec4(vColor * a * uFade, 1.0);
      }`,
    blending: THREE.AdditiveBlending,
    depthTest: false,
    depthWrite: false,
    transparent: false, // 不透明パスの最初に描き、機体やコックピットで隠れるようにする
  });

  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  points.renderOrder = -10;
  return points;
}
