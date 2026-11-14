import * as THREE from 'three';
import { mulberry32 } from '../math/random.js';

const SIZE = 400; // 塵を敷き詰める立方体の一辺 (m)

/**
 * 機体のまわりに漂う宇宙塵。何もない空間でも速度と向きが分かるようにする。
 * 粒は世界に固定されていて、一辺 SIZE の立方体でカメラのまわりに繰り返す。
 * 繰り返しの位相 (カメラ位置 mod SIZE) は CPU の倍精度で計算して渡す。
 */
export class Dust {
  constructor(count = 1400, seed = 77) {
    const rand = mulberry32(seed);
    const pos = new Float32Array(count * 3);
    for (let i = 0; i < pos.length; i++) pos[i] = rand() * SIZE;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uOffset: { value: new THREE.Vector3() },
        uSize: { value: SIZE },
        uPixelRatio: { value: 1 },
        uOpacity: { value: 1 },
      },
      vertexShader: /* glsl */ `
        #include <common>
        #include <logdepthbuf_pars_vertex>
        uniform vec3 uOffset;
        uniform float uSize;
        uniform float uPixelRatio;
        varying float vAlpha;
        void main() {
          // カメラを中心とした立方体の中に折り返す
          vec3 p = mod(position - uOffset, uSize) - uSize * 0.5;
          vec4 mv = viewMatrix * vec4(p, 1.0);
          gl_Position = projectionMatrix * mv;
          float dist = length(p);
          vAlpha = smoothstep(uSize * 0.5, uSize * 0.2, dist) * smoothstep(2.0, 12.0, dist);
          gl_PointSize = clamp(260.0 / max(-mv.z, 1.0), 1.0, 3.5) * uPixelRatio;
          #include <logdepthbuf_vertex>
        }`,
      fragmentShader: /* glsl */ `
        #include <common>
        #include <logdepthbuf_pars_fragment>
        uniform float uOpacity;
        varying float vAlpha;
        void main() {
          #include <logdepthbuf_fragment>
          float d = length(gl_PointCoord - 0.5) * 2.0;
          float a = smoothstep(1.0, 0.0, d) * vAlpha * uOpacity * 0.55;
          gl_FragColor = vec4(vec3(0.75, 0.85, 1.0) * a, 1.0);
        }`,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      transparent: true,
    });

    this.points = new THREE.Points(geo, this.material);
    this.points.frustumCulled = false;
  }

  /** camWorld: カメラの世界座標 (倍精度)。 */
  update(camWorld) {
    const m = (x) => ((x % SIZE) + SIZE) % SIZE;
    this.material.uniforms.uOffset.value.set(m(camWorld.x), m(camWorld.y), m(camWorld.z));
  }
}
