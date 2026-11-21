import * as THREE from 'three';
import { makeTerrain } from '../terrain/terrainFn.js';
import { PlanetLod } from './planetLod.js';
import { makeAtmosphereUniforms, createTerrainMaterial, createSkyMaterial, createRingMaterial, TILE, TILE2 } from './atmosphere.js';
import { Scatter } from './scatter.js';
import { mulberry32 } from '../math/random.js';
import { FRAME_ENTER, FRAME_EXIT } from '../universe/system.js';
import { cityPlan } from './city.js';

const Y_AXIS = new THREE.Vector3(0, 1, 0);
const _q = new THREE.Quaternion();
const _m4 = new THREE.Matrix4();

/** ガス巨星の見た目: 緯度ごとに色の違う縞を持つ球。地形と同じシェーダーで描く。 */
function gasGeometry(def) {
  const geo = new THREE.SphereGeometry(def.radius, 128, 64);
  const pos = geo.attributes.position;
  const colors = new Uint8Array(pos.count * 4);
  const rand = mulberry32(def.seed);
  const { bands, count } = def.gas;
  // 縞ごとの色と、境目の位置
  const stripes = [];
  for (let i = 0; i <= count; i++) {
    const c = bands[Math.floor(rand() * bands.length)];
    const k = (0.8 + rand() * 0.4) * 0.5; // 明るい日差しで白く飛ばないよう、暗めにしておく
    stripes.push([c[0] * k, c[1] * k, c[2] * k]);
  }
  const phase = rand() * 10;
  // 大きな渦 (木星の大赤斑のようなもの)。spot = { lat, lon (rad), w, h (経度・緯度方向の半径, rad), color }
  const spot = def.gas.spot;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i) / def.radius, y = pos.getY(i) / def.radius, z = pos.getZ(i) / def.radius;
    const lon = Math.atan2(z, x);
    const lat = Math.asin(Math.max(-1, Math.min(1, y)));
    // 縞を少し波打たせる
    const wobble = Math.sin(lon * 5 + y * 9 + phase) * 0.012 + Math.sin(lon * 11 - phase) * 0.006;
    const t = (lat / Math.PI + 0.5 + wobble) * count;
    const i0 = Math.max(0, Math.min(count - 1, Math.floor(t)));
    let f = t - i0;
    f = f * f * (3 - 2 * f);
    const a = stripes[i0], b = stripes[i0 + 1];
    let r = a[0] + (b[0] - a[0]) * f, g = a[1] + (b[1] - a[1]) * f, bl = a[2] + (b[2] - a[2]) * f;
    if (spot) {
      let dl = lon - spot.lon;
      dl -= Math.round(dl / (2 * Math.PI)) * 2 * Math.PI;
      const e = Math.hypot((dl * Math.cos(lat)) / spot.w, (lat - spot.lat) / spot.h);
      if (e < 1.4) {
        // 中心ほど濃く、縁は明るい輪で縞から切り離す
        const core = 1 - Math.min(1, Math.max(0, (e - 0.55) / 0.45));
        const rim = Math.max(0, 1 - Math.abs(e - 1.05) / 0.25) * 0.35;
        const k = 0.5;
        r = r + (spot.color[0] * k - r) * core + rim * 0.25;
        g = g + (spot.color[1] * k - g) * core + rim * 0.22;
        bl = bl + (spot.color[2] * k - bl) * core + rim * 0.18;
      }
    }
    colors[i * 4] = Math.round(Math.min(1, r) * 255);
    colors[i * 4 + 1] = Math.round(Math.min(1, g) * 255);
    colors[i * 4 + 2] = Math.round(Math.min(1, bl) * 255);
    colors[i * 4 + 3] = 0;
  }
  geo.setAttribute('aColor', new THREE.BufferAttribute(colors, 4, true));
  return geo;
}

/**
 * 惑星・衛星。位置と自転、地形、大気を持つ。
 * 「惑星ローカル座標」= 惑星中心が原点で、惑星と一緒に回る座標。地表はこの座標で静止している。
 *
 * def (src/universe/system.js が作る):
 *   { key, name, type, seed, radius, position (星系座標), rotationPeriod, axialTilt, gravity,
 *     terrain, atmosphere | null, skyLight, gas?, rings? }
 * sunIntensity: 恒星の明るさ (地表と空の明るさに効く)
 */
export class Planet {
  constructor(def, sunIntensity = 22) {
    this.def = def;
    this.name = def.name;
    this.type = def.type;
    this.radius = def.radius;
    this.gas = !!def.gas; // ガス巨星 (降りられる地面がない)
    this.atmosphere = def.atmosphere || null;
    this.atmoRadius = def.radius + (this.atmosphere ? this.atmosphere.height : 0);
    this.gravity = def.gravity ?? 9.81;
    this.surfaceDensity = this.atmosphere ? this.atmosphere.surfaceDensity ?? 1.225 : 0;
    this.sysPos = new THREE.Vector3(...def.position); // 星系座標 (恒星が原点)
    this.pos = this.sysPos.clone(); // 世界座標。原点が動くたびに game が計算し直す
    this.quat = new THREE.Quaternion(); // 世界座標での向き
    this.tilt = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), def.axialTilt);
    this.omega = (2 * Math.PI) / def.rotationPeriod; // 自転の角速度 (rad/s, ローカルY軸まわり)

    // この距離より内側では、機体を惑星ローカル座標で動かす
    this.frameEnter = def.radius * FRAME_ENTER;
    this.frameExit = def.radius * FRAME_EXIT;

    this.group = new THREE.Group();
    this.uniforms = makeAtmosphereUniforms({
      ...def,
      atmosphere: this.atmosphere ? { ...this.atmosphere, sunIntensity: this.atmosphere.sunIntensity ?? sunIntensity } : null,
    });
    if (!this.atmosphere) this.uniforms.uSunI.value = sunIntensity;
    const material = createTerrainMaterial(this.uniforms);

    if (this.gas) {
      this.terrain = { radius: def.radius, type: 'gas', height: () => 0 };
      this.lod = null;
      this.scatter = null;
      this.body = new THREE.Mesh(gasGeometry(def), material);
      this.body.frustumCulled = false;
      this.group.add(this.body);
    } else {
      this.terrain = makeTerrain(def);
      // 都市惑星: ビルにも当たる (屋上に着陸できる)
      this.city = this.terrain.type === 'city' ? cityPlan(this.terrain) : null;
      if (this.city) this.uniforms.uLotN.value = this.city.N;
      this.lod = new PlanetLod(def, this.terrain, material, this.group);
      this.scatter = new Scatter(this.terrain, this.uniforms, this.group); // 岩と木
      this.body = null;
    }
    this.time = 0;

    // 大気の殻。多角形で近似した球が本来の球の内側に入り込まないよう、少し大きくする
    this.sky = null;
    if (this.atmosphere) {
      this.sky = new THREE.Mesh(
        new THREE.SphereGeometry(this.atmoRadius * 1.03, 64, 32),
        createSkyMaterial(this.uniforms),
      );
      this.sky.frustumCulled = false;
      this.group.add(this.sky);
    }

    // 環 (赤道面の円盤)。惑星と一緒に回るが、模様は同心円なので見た目は変わらない。
    // 当たり判定はない (機体はすり抜ける)
    this.rings = null;
    if (def.rings) {
      const geo = new THREE.RingGeometry(def.rings.inner, def.rings.outer, 256, 1);
      geo.rotateX(-Math.PI / 2); // XY 平面 → 赤道面 (XZ 平面)。自転軸はローカル Y
      this.rings = new THREE.Mesh(geo, createRingMaterial(this.uniforms, def.rings));
      this.rings.frustumCulled = false;
      this.rings.renderOrder = 1; // 大気の殻より後に重ねる
      this.group.add(this.rings);
    }

    this.updateRotation(0);
  }

  /** 時刻 t (秒) での自転を反映する。 */
  updateRotation(t) {
    this.time = t;
    this.quat.copy(this.tilt).multiply(_q.setFromAxisAngle(Y_AXIS, this.omega * t));
  }

  /** 惑星ローカル座標の点の真下の標高 (m, 海面 = 0)。 */
  heightAt(local) {
    const inv = 1 / local.length();
    return this.terrain.height(local.x * inv, local.y * inv, local.z * inv, 1);
  }

  /** その点の地面 (または水面・ビルの屋上) の、惑星中心からの距離。 */
  groundRadiusAt(local) {
    if (this.gas) return this.radius;
    const ground = Math.max(0, this.heightAt(local));
    if (!this.city) return this.radius + ground;
    const inv = 1 / local.length();
    return this.radius + Math.max(ground, this.city.roofAt(local.x * inv, local.y * inv, local.z * inv));
  }

  /** 惑星中心から距離 r での重力加速度の大きさ (m/s²)。 */
  gravityAt(r) {
    const k = this.radius / Math.max(r, this.radius);
    return this.gravity * k * k;
  }

  /** 高度 h における大気密度 (その惑星の海面を1とした比)。大気がなければ 0。 */
  densityAt(altitude) {
    const a = this.atmosphere;
    if (!a || altitude > a.height) return 0;
    return Math.exp(-Math.max(0, altitude) / a.scaleHeightR);
  }

  /**
   * 描画の準備。group の位置と向きは呼び出し側が設定済みであること。
   * @param camLocal 惑星ローカル座標でのカメラ位置
   * @param sunDirRender 描画座標での太陽方向
   */
  updateRender(camLocal, sunDirRender) {
    const u = this.uniforms;
    u.uPlanetCenter.value.copy(this.group.position);
    u.uSunDir.value.copy(sunDirRender);
    _m4.makeRotationFromQuaternion(_q.copy(this.group.quaternion).invert());
    u.uPlanetRotInv.value.setFromMatrix4(_m4);
    const m = (x, per) => ((x % per) + per) % per;
    u.uCamTile.value.set(m(camLocal.x, TILE), m(camLocal.y, TILE), m(camLocal.z, TILE));
    u.uCamTile2.value.set(m(camLocal.x, TILE2), m(camLocal.y, TILE2), m(camLocal.z, TILE2));
    u.uTime.value = this.time % 4096; // 波を動かす時刻 (float の精度が落ちないよう折り返す)
    if (this.lod) this.lod.update(camLocal);
    if (this.scatter) this.scatter.update(camLocal);
  }

  /** メッシュとシェーダーを捨てる (星系を離れたとき)。 */
  dispose() {
    if (this.lod) this.lod.dispose();
    if (this.scatter) this.scatter.dispose();
    if (this.body) {
      this.body.geometry.dispose();
      this.body.material.dispose();
    }
    if (this.sky) {
      this.sky.geometry.dispose();
      this.sky.material.dispose();
    }
    if (this.rings) {
      this.rings.geometry.dispose();
      this.rings.material.dispose();
    }
  }
}
