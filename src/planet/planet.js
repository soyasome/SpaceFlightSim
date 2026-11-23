import * as THREE from 'three';
import { makeTerrain } from '../terrain/terrainFn.js';
import { PlanetLod } from './planetLod.js';
import { makeAtmosphereUniforms, createTerrainMaterial, createSkyMaterial, createRingMaterial, TILE, TILE2 } from './atmosphere.js';
import { Scatter } from './scatter.js';
import { FRAME_ENTER, FRAME_EXIT } from '../universe/system.js';
import { cityPlan } from './city.js';
import { usableTerrain } from '../terrain/maps.js';

const Y_AXIS = new THREE.Vector3(0, 1, 0);
const CLOUD_WIND = [80, -50]; // 雲の大きな模様と細かい模様を流す速さ (m/s)
const _q = new THREE.Quaternion();
const _m4 = new THREE.Matrix4();

/**
 * カメラのいる立方体の面での敷地の座標を、倍精度で計算してシェーダーに渡す (atmosphere.js の cityStreet)。
 * シェーダーはここからの差だけを計算するので、実寸の惑星でも道路の線がちらつかない。
 */
export function setCamLot(u, c, N) {
  const ax = Math.abs(c.x), ay = Math.abs(c.y), az = Math.abs(c.z);
  let axis, s, t, a;
  if (ax >= ay && ax >= az) { axis = 0; s = c.z; t = c.y; a = c.x; }
  else if (ay >= az) { axis = 1; s = c.x; t = c.z; a = c.y; }
  else { axis = 2; s = c.x; t = c.y; a = c.z; }
  if (a === 0) return; // 惑星の中心 (起こらない)
  const gx = (s / Math.abs(a) * 0.5 + 0.5) * N, gy = (t / Math.abs(a) * 0.5 + 0.5) * N;
  const ix = Math.floor(gx), iy = Math.floor(gy);
  const wrap = (i) => ((i % 4096) + 4096) % 4096;
  u.uCamLot.value.set(gx - ix, gy - iy, axis, Math.sign(a));
  u.uCamLotInt.value.set(wrap(ix), wrap(iy));
  u.uCamFace.value.set(s, t, a);
}

/**
 * 惑星・衛星。位置と自転、地形、大気を持つ。
 * 「惑星ローカル座標」= 惑星中心が原点で、惑星と一緒に回る座標。地表はこの座標で静止している。
 *
 * def (src/universe/system.js が作る):
 *   { key, name, type, seed, radius, position (星系座標), rotationPeriod, axialTilt, gravity,
 *     terrain, atmosphere | null, skyLight, gas?, rings?, tidalLock?, rotationPhase?, clouds? }
 * sunIntensity: 恒星の明るさ (地表と空の明るさに効く)
 */
export class Planet {
  constructor(def, sunIntensity = 22) {
    // 本物の地形のマップを読み込めなかった天体は、今のノイズの地形で作る (Worker にもこの定義が渡る)
    if (def.terrain) def = { ...def, terrain: usableTerrain(def.terrain) };
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
    // 自転の角速度 (rad/s, ローカルY軸まわり)。潮汐ロックの天体は、公転しないこのゲームでは自転もしない
    // (いつも同じ面を親に向ける。docs/design-earth-moon.md の 6章)
    this.omega = def.tidalLock ? 0 : (2 * Math.PI) / def.rotationPeriod;
    this.rotationPhase = def.rotationPhase ?? 0; // 時刻 0 での自転の角度 (rad)
    this.fictitious = !!def.fictitious; // ローカル座標で遠心力とコリオリ力を足すか (実寸の惑星。frame.js の注)

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

    // ガス巨星も岩の惑星と同じ LOD のチャンクで描く (標高 0 の球に縞の色。terrainFn.js の makeGasTerrain)
    this.terrain = makeTerrain(def);
    this.lod = new PlanetLod(def, this.terrain, material, this.group);
    if (this.gas) {
      this.city = null;
      this.scatter = null;
    } else {
      // 都市惑星: ビルにも当たる (屋上に着陸できる)
      this.city = this.terrain.type === 'city' ? cityPlan(this.terrain) : null;
      if (this.city) this.uniforms.uLotN.value = this.city.N;
      this.scatter = new Scatter(this.terrain, this.uniforms, this.group); // 岩と木
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
    this.quat.copy(this.tilt).multiply(_q.setFromAxisAngle(Y_AXIS, this.rotationPhase + this.omega * t));
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
  gravityAtRadius(r) {
    const k = this.radius / Math.max(r, this.radius);
    return this.gravity * k * k;
  }

  /** 高度 h における大気密度 (その惑星の海面を1とした比)。大気がなければ 0。 */
  densityAt(altitude) {
    const a = this.atmosphere;
    if (!a || altitude > a.height) return 0;
    return Math.exp(-Math.max(0, altitude) / a.scaleHeightR);
  }

  // ---------------------------------------------------------------- 座標系の窓口
  // 機体が属する座標系 (game.frame) に求めるもの。接地 (ground.js)・飛行 (game.js)・敵 (combat.js) は
  // これだけを使い、「下 = 惑星の中心の方」を自分では仮定しない。
  // 円筒の居住地など、下の向きが違う座標系も同じ名前で持つ。引数の点はすべてこの座標系のローカル座標。

  /** 世界座標の点 world が、この座標系に入る範囲にあるか。 */
  entersAt(world) {
    return world.distanceTo(this.pos) < this.frameEnter;
  }

  /** ローカル座標の点 p が、まだこの座標系の中にあるか (出たら宇宙に戻す)。 */
  containsLocal(p) {
    return p.length() <= this.frameExit;
  }

  /** 世界座標の点 world から表面 (海面) までの距離。いちばん近い天体を選ぶのに使う。 */
  surfaceDistance(world) {
    return world.distanceTo(this.pos) - this.radius;
  }

  /** 点 p での真上の向き (単位ベクトル) を out に入れる。 */
  upAt(p, out) {
    return out.copy(p).divideScalar(p.length());
  }

  /** 点 p の、真下の地面 (水面・ビルの屋上を含む) からの高さ (m)。負なら地面の下。 */
  heightAbove(p) {
    return p.length() - this.groundRadiusAt(p);
  }

  /** heightAbove の軽い版 (細かい凹凸とビルを省く)。敵の操縦など、呼ぶ回数が多い所で使う。 */
  roughHeightAbove(p) {
    const r = p.length();
    const h = this.terrain.height(p.x / r, p.y / r, p.z / r, 20);
    return r - this.radius - Math.max(0, h);
  }

  /** 点 p の、基準面 (海面) からの高さ (m)。 */
  seaLevelAt(p) {
    return p.length() - this.radius;
  }

  /** 点 p での重力加速度 (ベクトル, m/s²) を out に入れる。 */
  gravityAt(p, out) {
    const r = p.length();
    return out.copy(p).multiplyScalar(-this.gravityAtRadius(r) / r);
  }

  /** 点 p での空気の密度 (kg/m³)。 */
  airDensityAt(p) {
    return this.densityAt(p.length() - this.radius) * this.surfaceDensity;
  }

  /** 方向 dir (単位ベクトルでなくてよい) の真上、地面から alt (m) の点を out に入れる。 */
  surfacePoint(dir, alt, out) {
    out.copy(dir).normalize();
    return out.multiplyScalar(this.groundRadiusAt(out) + alt);
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
    u.uTime.value = this.time % 4096;
    if (u.uCloudRot) {
      // 雲の模様を自転軸まわりに流す。速さは m/s で決める (実寸でも風の速さが変わらないように)
      const a1 = (this.time * CLOUD_WIND[0] / u.uCloudR.value) % (2 * Math.PI);
      const a2 = (this.time * CLOUD_WIND[1] / u.uCloudR.value) % (2 * Math.PI);
      u.uCloudRot.value.set(Math.cos(a1), Math.sin(a1), Math.cos(a2), Math.sin(a2));
    } // 波を動かす時刻 (float の精度が落ちないよう折り返す)
    if (this.city) setCamLot(u, camLocal, this.city.N);
    if (this.lod) this.lod.update(camLocal);
    if (this.scatter) this.scatter.update(camLocal);
  }

  /** メッシュとシェーダーを捨てる (星系を離れたとき)。 */
  dispose() {
    if (this.lod) this.lod.dispose();
    if (this.scatter) this.scatter.dispose();
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
