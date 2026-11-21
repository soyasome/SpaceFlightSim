import * as THREE from 'three';
import { swarmPanels } from '../universe/swarm.js';

// ダイソン・スウォームの描画。
//
// パネルは星系座標で 1e10〜1e11 m の所にあり、float32 では km 単位の誤差が出る。
// そこで「基準点」(倍精度) からの相対位置で InstancedMesh に詰め、カメラが基準点から
// 離れすぎたら詰め直す (近くのパネルほど基準点の近くにあるので、細かい所まで正確に描ける)。
// 遠くのパネルは1ピクセルより小さくなって消えてしまうので、光の点 (Points) でも描く。

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _x = new THREE.Vector3(), _y = new THREE.Vector3(), _z = new THREE.Vector3();
const _basis = new THREE.Matrix4();

/** 六角形の板 (外接円の半径 1、厚さ t)。表 (+Y) が恒星を向く。 */
function panelGeometry(t) {
  const g = new THREE.CylinderGeometry(1, 1, t, 6, 1, false);
  g.rotateY(Math.PI / 6);
  return g;
}

export class SwarmView {
  /**
   * @param def system.swarm (src/universe/swarm.js の makeSwarm)
   * @param color 恒星の色
   */
  constructor(def, color) {
    this.def = def;
    this.panels = swarmPanels(def);
    const n = def.count;
    this.group = new THREE.Group(); // 位置 = 基準点 (描画座標)
    this.anchor = new THREE.Vector3(); // 星系座標
    this.hasAnchor = false;

    // --- パネル ---
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uSunPos: { value: new THREE.Vector3() }, // 描画座標での恒星の位置
        uSunI: { value: 1 },
        uStarColor: { value: new THREE.Vector3(...color) },
      },
      vertexShader: /* glsl */ `
        #include <common>
        #include <logdepthbuf_pars_vertex>
        varying vec3 vRel;
        varying vec3 vNormal;
        varying vec3 vObj;
        varying float vSeed;
        void main() {
          vec4 wp = modelMatrix * (instanceMatrix * vec4(position, 1.0));
          vRel = wp.xyz;
          vNormal = normalize(mat3(modelMatrix) * (mat3(instanceMatrix) * normal));
          vObj = position;
          vSeed = fract(sin(float(gl_InstanceID) * 12.9898) * 43758.5453);
          gl_Position = projectionMatrix * viewMatrix * wp;
          #include <logdepthbuf_vertex>
        }`,
      fragmentShader: /* glsl */ `
        #include <common>
        #include <logdepthbuf_pars_fragment>
        uniform vec3 uSunPos;
        uniform float uSunI;
        uniform vec3 uStarColor;
        varying vec3 vRel;
        varying vec3 vNormal;
        varying vec3 vObj;
        varying float vSeed;

        // 周期 1 の六角形の格子までの近さ (0 = 線の上, 1 = 区画の中央)。遠くでは平均の 0.5 に寄せる
        float hexGrid(vec2 p) {
          vec2 r = vec2(1.0, 1.7320508);
          vec2 h = r * 0.5;
          vec2 a = mod(p, r) - h;
          vec2 b = mod(p - h, r) - h;
          vec2 g = dot(a, a) < dot(b, b) ? a : b;
          vec2 q = abs(g);
          float d = 0.5 - max(dot(q, normalize(r)), q.x); // 六角形の縁までの距離
          float w = fwidth(p.x) * 1.5;
          return mix(smoothstep(0.0, w, d), 0.6, smoothstep(0.15, 0.5, w));
        }

        void main() {
          #include <logdepthbuf_fragment>
          vec3 N = normalize(vNormal);
          vec3 V = normalize(-vRel);
          vec3 toSun = uSunPos - vRel;
          vec3 L = normalize(toSun);
          vec3 col;
          // 表 (恒星側): 暗い青の太陽電池の区画。区画を3段の大きさで重ねる
          float lit = max(dot(N, L), 0.0);
          vec2 uv = vObj.xz;
          float cells = hexGrid(uv * 6.0) * 0.5 + hexGrid(uv * 48.0) * 0.3 + hexGrid(uv * 384.0) * 0.2;
          bool sunSide = dot(N, L) > 0.0;
          if (sunSide) {
            vec3 pv = mix(vec3(0.015, 0.025, 0.06), vec3(0.04, 0.06, 0.12), cells);
            pv *= 0.85 + 0.3 * vSeed;
            vec3 H = normalize(L + V);
            float spec = pow(max(dot(N, H), 0.0), 60.0);
            col = uStarColor * uSunI * (pv * lit + vec3(0.25) * spec);
            // 区画の境目の金属の枠
            col += uStarColor * uSunI * lit * 0.05 * (1.0 - cells);
          } else {
            // 裏 (排熱板): 日は当たらず、余った熱で鈍く赤く光る
            vec3 rad = mix(vec3(0.05, 0.012, 0.006), vec3(0.09, 0.025, 0.01), cells);
            col = rad * (0.7 + 0.6 * vSeed) + vec3(0.004, 0.005, 0.008);
          }
          gl_FragColor = vec4(col, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    });
    this.mesh = new THREE.InstancedMesh(panelGeometry(def.thickness / def.panel), this.material, n);
    this.mesh.frustumCulled = false;
    this.group.add(this.mesh);

    // --- 遠くのパネルの光の点 ---
    const geo = new THREE.BufferGeometry();
    this.pointPos = new Float32Array(n * 3);
    const present = new Float32Array(n);
    for (let i = 0; i < n; i++) present[i] = this.panels.present[i];
    geo.setAttribute('position', new THREE.BufferAttribute(this.pointPos, 3));
    geo.setAttribute('aPresent', new THREE.BufferAttribute(present, 1));
    this.pointMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uSunPos: this.material.uniforms.uSunPos,
        uSunI: this.material.uniforms.uSunI,
        uStarColor: this.material.uniforms.uStarColor,
        uPanel: { value: def.panel },
        uPxScale: { value: 500 }, // 1 m 先の 1 m が何ピクセルか × 距離
        uPixelRatio: { value: 1 },
      },
      vertexShader: /* glsl */ `
        #include <common>
        #include <logdepthbuf_pars_vertex>
        attribute float aPresent;
        uniform vec3 uSunPos;
        uniform float uPanel;
        uniform float uPxScale;
        uniform float uPixelRatio;
        varying vec3 vCol;
        uniform float uSunI;
        uniform vec3 uStarColor;
        void main() {
          vec4 wp = modelMatrix * vec4(position, 1.0);
          float dist = length(wp.xyz);
          float px = uPanel / dist * uPxScale; // パネルの見かけの半径 (ピクセル)
          // 表 (恒星側) から見ているか。パネルの法線は恒星の方を向く
          vec3 n = normalize(uSunPos - wp.xyz);
          float front = dot(n, -wp.xyz) > 0.0 ? 1.0 : 0.0;
          vec3 lit = uStarColor * uSunI * 0.35;
          vec3 heat = vec3(0.12, 0.03, 0.012);
          vCol = mix(heat, lit, front) * aPresent * clamp(px * 3.0, 0.25, 1.0);
          gl_PointSize = px > 2.5 ? 0.0 : 2.0 * uPixelRatio; // 大きく見えるパネルは板として描かれている
          gl_Position = projectionMatrix * viewMatrix * wp;
          #include <logdepthbuf_vertex>
        }`,
      fragmentShader: /* glsl */ `
        #include <common>
        #include <logdepthbuf_pars_fragment>
        varying vec3 vCol;
        void main() {
          #include <logdepthbuf_fragment>
          float d = length(gl_PointCoord - 0.5) * 2.0;
          gl_FragColor = vec4(vCol * smoothstep(1.0, 0.3, d), 1.0);
        }`,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      transparent: true,
    });
    this.points = new THREE.Points(geo, this.pointMaterial);
    this.points.frustumCulled = false;
    this.group.add(this.points);
  }

  /**
   * カメラの星系座標 camSys (倍精度) を受け取り、必要なら基準点を取り直してパネルを詰め直す。
   * near: いちばん近いパネルの表面までの距離 (m)。基準点からのずれをこれに比べて小さく保つ
   */
  update(camSys, near) {
    const limit = Math.max(2e4, near * 0.05);
    if (!this.hasAnchor || this.anchor.distanceTo(camSys) > limit) {
      this.anchor.copy(camSys);
      this.hasAnchor = true;
      this._upload();
    }
  }

  _upload() {
    const { pos, tan, present } = this.panels;
    const def = this.def;
    const ax = this.anchor.x, ay = this.anchor.y, az = this.anchor.z;
    const n = def.count;
    for (let i = 0; i < n; i++) {
      const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
      this.pointPos[i * 3] = x - ax;
      this.pointPos[i * 3 + 1] = y - ay;
      this.pointPos[i * 3 + 2] = z - az;
      if (!present[i]) {
        _m.makeScale(0, 0, 0);
        this.mesh.setMatrixAt(i, _m);
        continue;
      }
      // Y = 恒星の方、X = 帯に沿った向き
      const r = Math.hypot(x, y, z);
      _y.set(-x / r, -y / r, -z / r);
      _x.set(tan[i * 3], tan[i * 3 + 1], tan[i * 3 + 2]);
      _x.addScaledVector(_y, -_x.dot(_y)).normalize();
      _z.crossVectors(_x, _y);
      _q.setFromRotationMatrix(_basis.makeBasis(_x, _y, _z));
      _p.set(x - ax, y - ay, z - az);
      _s.setScalar(def.panel);
      this.mesh.setMatrixAt(i, _m.compose(_p, _q, _s));
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    this.points.geometry.attributes.position.needsUpdate = true;
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.mesh.dispose();
    this.points.geometry.dispose();
    this.pointMaterial.dispose();
  }
}
