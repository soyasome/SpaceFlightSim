import * as THREE from 'three';
import { Ship } from './flight/ship.js';
import { FIGHTER } from './flight/shipParams.js';
import { GroundContact } from './flight/ground.js';
import { Input } from './core/input.js';
import { Loop } from './core/loop.js';
import { CameraRig } from './camera/cameraRig.js';
import { createStarfield } from './render/starfield.js';
import { Dust } from './render/dust.js';
import { AsteroidField } from './render/asteroids.js';
import { createShipModel, createCockpit, softGlowTexture } from './render/shipModel.js';
import { Hud } from './ui/hud.js';
import { Settings } from './core/settings.js';
import { Sound } from './audio/sound.js';
import { Planet } from './planet/planet.js';
import { HOME_STAR, nearestStar, LY, AU, SUN_RADIUS } from './universe/galaxy.js';
import { generateSystem } from './universe/system.js';
import { cruiseScale } from './flight/cruise.js';
import { NearStars } from './render/nearStars.js';
import { enterFrame, leaveFrame } from './physics/frame.js';
import { Combat } from './combat/combat.js';
import { SwarmView } from './render/swarm.js';
import { nearestPanel, HIT_RADIUS } from './universe/swarm.js';
import { HabitatView } from './render/habitat.js';
import { hullContact } from './universe/habitat.js';

const CAMERA_CLEARANCE = 1.2; // カメラが地面にめり込まないための最低高度 (m)
const RESPAWN_TIME = 3.5; // 機体を失ってから復帰するまで (秒)
const RESPAWN_ALTITUDE = 300; // 復帰する高さ (m)
const RECENTER = 1e7; // 機体が世界座標の原点からこれ以上離れたら、原点を機体の位置へ移す (m)
const SUN_POINT_DISTANCE = 2e12; // これより遠い恒星は球ではなく光の点として描く (m)
const JUMP_CHARGE = 4; // ジャンプの充填時間 (秒)
const JUMP_ARRIVE = 1.5; // 到着時の閃光が消えるまで (秒)

const IDENTITY = new THREE.Quaternion();
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const smoothstep = (a, b, x) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
const LADDER_STEPS = [-80, -70, -60, -50, -40, -30, -20, -10, 0, 10, 20, 30, 40, 50, 60, 70, 80];

function glowTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(128, 128, 0, 128, 128, 128);
  grad.addColorStop(0, 'rgba(255,250,235,1)');
  grad.addColorStop(0.08, 'rgba(255,240,200,0.85)');
  grad.addColorStop(0.25, 'rgba(255,210,150,0.22)');
  grad.addColorStop(1, 'rgba(255,180,120,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 256, 256);
  return new THREE.CanvasTexture(c);
}

/**
 * ゲーム全体。
 *
 * 座標系:
 * - 世界座標: 星系に固定された慣性系 (m, 倍精度)
 * - フレーム座標: 機体の物理を計算している座標。宇宙では世界座標そのもの。
 *   惑星に近づくと、その惑星と一緒に回る「惑星ローカル座標」に切り替わる
 *   (this.frame がその惑星を指す)。地表が静止して見えるので着陸できる。
 * - 描画座標: フレーム座標からカメラ位置を引いたもの (Floating Origin)。
 *   カメラは常に原点にあり、GPU に渡る数値が小さく保たれる。
 */
export class Game {
  constructor(viewCanvas, hudCanvas) {
    this.renderer = new THREE.WebGLRenderer({
      canvas: viewCanvas, antialias: true, logarithmicDepthBuffer: true,
    });
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.8;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(62, 1, 0.05, 2e14);
    this.scene.add(this.camera); // コックピットを子に持つため

    // --- 世界 ---
    this.ship = new Ship(FIGHTER);
    // 「世界座標」= 機体の近くに原点を置いた座標。恒星間を飛んでも数値が大きくならないよう、
    // 原点 (origin) を機体に合わせて動かす。天体の本来の位置は「星系座標」(恒星が原点) で持つ
    this.origin = new THREE.Vector3(); // 世界座標の原点の、星系座標での位置
    this.sunPos = new THREE.Vector3(); // 恒星の位置 (世界座標)
    this.star = null; // 今いる星系の恒星
    this.system = null;
    this.planets = [];
    this.nearPlanet = null; // いちばん近い惑星
    this.cruiseDist = Infinity; // いちばん近い天体の表面までの距離 (巡航の速さを決める)
    this.starDist = Infinity; // 恒星の中心までの距離 (m)
    this.galPos = [...HOME_STAR.pos]; // 銀河座標 (光年)
    this.nav = null; // 行き先 { type: 'planet' | 'star' | 'belt' | 'swarm' | 'habitat', planet?, star?, point? (swarm: 星系座標), habitat? }
    this.habitats = []; // オニール・シリンダーの外観 (HabitatView)
    this.habitatHit = null; // いちばん近いシリンダーの外壁との関係 { habitat, contact }
    this.swarm = null; // ダイソン・スウォームの描画 (ない星系では null)
    this.swarmHit = null; // いちばん近いパネル (nearestPanel の結果)
    this._sysPos = new THREE.Vector3();
    this._camSys = new THREE.Vector3();
    this.jump = null; // ジャンプの進行 { star, t, phase: 'charge' | 'arrive' }
    this.mapOpen = false; // 星図を開いている
    this.sunBase = 3.2;
    this._tick = 0;
    this._shift = new THREE.Vector3();
    this.frame = null; // 機体が属している惑星 (宇宙では null)
    this.simTime = 0;
    this.altitude = Infinity; // 地面からの高さ (m)
    this.altitudeSea = Infinity; // 海面からの高さ (m)
    this.grounded = false; // 機体のどこかが地面に触れている
    this.landed = false; // 3本の脚で接地して止まっている
    this.ground = new GroundContact();
    this.gLoad = 0; // 操縦席で感じる G (機体の上向きが正)
    this.verticalSpeed = 0; // 上昇率 (m/s)
    this.destroyed = false;
    this.respawnTimer = 0;
    this.flash = 0; // 損傷を受けたときの画面の光 0..1
    this.shieldFlash = 0; // シールドに被弾したときの光 0..1
    this.groundTimer = 0; // 脚が接地してからの猶予 (秒)
    this.notice = '';
    this.noticeTime = 0;

    this.starfield = createStarfield();
    this.scene.add(this.starfield);
    this.nearStars = new NearStars();
    this.scene.add(this.nearStars.points);

    this.sun = new THREE.Mesh(
      new THREE.SphereGeometry(SUN_RADIUS, 32, 16),
      new THREE.MeshBasicMaterial({ color: 0xfff4dc, toneMapped: false }),
    );
    this.sunGlow = new THREE.Sprite(new THREE.SpriteMaterial({
      map: glowTexture(), blending: THREE.AdditiveBlending,
      depthWrite: false, transparent: true, toneMapped: false,
    }));
    this.sunGlow.scale.setScalar(SUN_RADIUS * 40);
    this.scene.add(this.sun, this.sunGlow);

    this.sunLight = new THREE.DirectionalLight(0xfff2e0, 3.2);
    this.scene.add(this.sunLight);
    this.ambient = new THREE.HemisphereLight(0x7f95c0, 0x1a1c28, 0.8);
    this.scene.add(this.ambient);

    this.dust = new Dust();
    this.scene.add(this.dust.points);

    this.asteroids = new AsteroidField();
    this.scene.add(this.asteroids.mesh);

    this.shipModel = createShipModel();
    this.scene.add(this.shipModel);
    this.cockpit = createCockpit();
    this.camera.add(this.cockpit);

    this.explosion = new THREE.Sprite(new THREE.SpriteMaterial({
      map: softGlowTexture(), color: 0xffb060, blending: THREE.AdditiveBlending,
      depthWrite: false, transparent: true, toneMapped: false,
    }));
    this.explosion.visible = false;
    this.explosionPos = new THREE.Vector3(); // フレーム座標
    this.scene.add(this.explosion);

    // --- 操作・視点・表示 ---
    this.settings = new Settings();
    this.paused = false; // メニュー表示中は true
    this.input = new Input(viewCanvas, this.settings);
    this.rig = new CameraRig(this.settings);
    this.hud = new Hud(hudCanvas);
    this.sound = new Sound(this.settings);
    this.input.on('view', () => this.rig.toggle());
    this.input.on('assist', () => {
      // 巡航中に切ると、まず通常の速度まで減速してからアシストが切れる
      if (this.ship.cruise) this.ship.exitCruise(true);
      else this.ship.flightAssist = !this.ship.flightAssist;
      this.sound.click();
    });
    this.input.on('cruise', () => {
      if (!this.ship.cruise && this.ground.contacts > 0) return; // 地上では巡航に入れない
      if (this.ship.cruiseExit) {
        this.ship.cruiseExit = null; // 減速の途中でもう一度押すと巡航に戻る
      } else if (this.ship.cruise) {
        this.ship.exitCruise();
      } else {
        this.ship.cruise = true;
        this.ship.flightAssist = true;
        this.ship.gearDown = false;
      }
      this.sound.click();
    });
    this.input.on('gear', () => {
      this.ship.gearDown = !this.ship.gearDown;
      if (this.ship.gearDown) this.ship.exitCruise();
      this.sound.gear();
    });
    this.input.on('hover', () => {
      this.ship.hover = !this.ship.hover;
      this.sound.click();
    });

    // --- 戦闘 ---
    this.combat = new Combat(this);
    this.input.on('target', () => this.combat.selectTarget(false));
    this.input.on('targetNext', () => this.combat.selectTarget(true));
    this.input.on('missile', () => this.combat.fireMissile());
    this.input.on('reinforce', () => this.combat.reinforce());

    // --- 宇宙 ---
    this.input.on('nav', () => this.cycleNav());
    this.input.on('jump', () => this.toggleJump());

    this.time = 0;
    this.fps = 60;
    this.boostVisual = 0;
    this._sPos = new THREE.Vector3();
    this._sQuat = new THREE.Quaternion();
    this._v = new THREE.Vector3();
    this._v2 = new THREE.Vector3();
    this._qInv = new THREE.Quaternion();
    this._fqInv = new THREE.Quaternion();
    this._camPlanet = new THREE.Vector3();
    this._env = { speedScale: 1, gravity: new THREE.Vector3(), rho: 0, aero: 0, onGround: false };
    this._e = new THREE.Euler();
    this._shake = new THREE.Quaternion();

    this.loop = new Loop({
      hz: 120,
      beginFrame: (dt) => { if (!this.paused) this.input.update(dt); },
      step: (h) => { if (!this.paused) this.step(h); },
      frame: (alpha, dt) => this.frame_(alpha, dt),
    });

    // 出発地の星系から始める
    this.origin.set(...generateSystem(HOME_STAR).start);
    this.loadSystem(HOME_STAR);

    window.addEventListener('resize', () => this.resize());
    this.resize();
  }

  /** いちばん近い惑星 (デバッグや表示用)。 */
  get planet() {
    return this.frame || this.nearPlanet || this.planets[0];
  }

  start() {
    this.loop.start();
  }

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.hud.resize(w, h, dpr);
    this.starfield.material.uniforms.uPixelRatio.value = dpr;
    this.nearStars.material.uniforms.uPixelRatio.value = dpr;
    this.dust.material.uniforms.uPixelRatio.value = dpr;
  }

  // ---------------------------------------------------------------- 物理

  /** 物理を1ステップ進める (固定刻み)。 */
  step(h) {
    this.simTime += h;
    for (const p of this.planets) p.updateRotation(this.simTime);
    for (const h of this.habitats) h.updateRotation(this.simTime);

    if (this.destroyed) {
      this.respawnTimer -= h;
      if (this.respawnTimer <= 0) this._respawn();
      this.combat.step(h); // 自機を失っても、敵と弾は動き続ける
      return;
    }

    const ship = this.ship;
    const body = ship.body;
    const env = this._env;
    const controls = this.input.controls;

    // 居住地の中では巡航できない (壁に囲まれている)
    if (this.frame && this.frame.safe && ship.cruise) {
      ship.stopCruise();
      this.notify('居住地の中では巡航できません', 1.5);
    }
    // 巡航モード: いちばん近い天体から遠いほど速く飛べる (速度則は src/flight/cruise.js)
    env.speedScale = cruiseScale(this.cruiseDist);

    this.envAt(body.pos, env);
    env.altitude = this.frame ? this.altitude : Infinity;
    // 接地の直後は脚のばねで少し跳ねるので、3本そろって接地してからしばらくは「地上」とみなす
    if (this.ground.gearContacts === 3) this.groundTimer = 0.6;
    else this.groundTimer = Math.max(0, this.groundTimer - h);
    env.onGround = this.groundTimer > 0;

    ship.applyForces(h, controls, env);

    // 地面との接触。ホバー中かスロットルを絞っているときは車輪にブレーキをかける
    const brake = ship.hoverAuthority > 0.5 || controls.throttle <= 0.01;
    const ground = this.ground;
    if (this.frame) ground.apply(body, this.frame, ship.gear, brake, h);
    else ground.reset();

    // 操縦席で感じる G = 重力以外の力による加速度
    const felt = this._v.copy(body.force).divideScalar(body.mass).sub(ship.gravityApplied);
    const up = this._v2.set(0, 1, 0).applyQuaternion(body.quat);
    this.gLoad += (felt.dot(up) / 9.81 - this.gLoad) * 0.08;

    body.integrate(h);

    // 静止摩擦: ほぼ止まっている機体は、斜面 (約35°まで) でも滑り出さない
    if (ground.gearContacts === 3 && ground.hullContacts === 0 && brake &&
        body.vel.lengthSq() < 0.09 && body.angVel.lengthSq() < 0.0025 &&
        ground.normal.dot(this.frame.upAt(body.pos, this._v)) > 0.82) {
      const n = ground.normal;
      const vn = body.vel.dot(n);
      const slip = this._v.copy(body.vel).addScaledVector(n, -vn); // 地面に沿った速度
      body.pos.addScaledVector(slip, -h); // このステップで滑った分を戻す
      body.vel.copy(n).multiplyScalar(vn);
      body.angVel.multiplyScalar(0.8);
    }

    if (ground.impactSpeed > 0.6) this.sound.thump(ground.impactSpeed);
    if (ground.damage > 0) {
      ship.hull -= ground.damage;
      this.flash = Math.min(1, this.flash + ground.damage * 0.05);
    }
    ship.updateSystems(h);
    this.combat.step(h);
    this._updateFrame();
    this._updateUniverse(h);
    if (ship.hull <= 0 && !this.destroyed) this._destroy();
  }

  /**
   * 位置 pos (フレーム座標) での重力と空気を env に入れる。自機にも敵機にも使う。
   */
  envAt(pos, env) {
    const frame = this.frame;
    if (frame) {
      frame.gravityAt(pos, env.gravity);
      env.rho = frame.airDensityAt(pos);
      // 高度 約32km から 18km にかけて、航空機としての操縦に切り替わる
      // (それより上は空気が薄すぎて、翼では機体を支えられない)
      env.aero = smoothstep(0.01, 0.08, env.rho / 1.225);
    } else {
      env.gravity.set(0, 0, 0);
      env.rho = 0;
      env.aero = 0;
    }
    return env;
  }

  /** 自機が攻撃や衝突を受けた。hull = 機体まで届いた (シールドを抜けた)。 */
  onPlayerHit(damage, hull) {
    if (hull) {
      this.flash = Math.min(1, this.flash + 0.15 + damage * 0.02);
      this.sound.thump(10);
    } else {
      this.shieldFlash = Math.min(1, this.shieldFlash + 0.45);
      this.sound.shieldHit();
    }
  }

  /** 惑星との位置関係を調べ、座標系の切り替えと高度の計算を行う。 */
  _updateFrame() {
    const body = this.ship.body;
    this.grounded = this.ground.contacts > 0;
    this.landed = this.ground.gearContacts === 3 && body.vel.lengthSq() < 1;

    if (this.frame) {
      const frame = this.frame;
      this.nearPlanet = frame;
      if (!frame.containsLocal(body.pos)) {
        const sea = frame.seaLevelAt(body.pos);
        this.setFrame(null);
        this.altitude = this.altitudeSea = this.cruiseDist = sea;
        this.verticalSpeed = 0;
        return;
      }
      this.altitude = frame.heightAbove(body.pos);
      this.altitudeSea = frame.seaLevelAt(body.pos);
      this.cruiseDist = this.altitude;
      this.verticalSpeed = body.vel.dot(frame.upAt(body.pos, this._v));
    } else {
      this.verticalSpeed = 0;
      let nearest = Infinity;
      let enter = null;
      for (const planet of this.planets) {
        const d = planet.surfaceDistance(body.pos);
        if (d < nearest) {
          nearest = d;
          this.nearPlanet = planet;
        }
        if (planet.entersAt(body.pos)) enter = planet;
      }
      this.altitude = this.altitudeSea = nearest;
      // 巡航の速さは、惑星だけでなく恒星の表面までの距離でも抑える
      const toStar = body.pos.distanceTo(this.sunPos) - this.star.radius;
      this.cruiseDist = Math.max(0, Math.min(nearest, toStar));
      // オニール・シリンダー: 外壁までの距離で巡航を抑え、当たり判定のために覚えておく
      this.habitatHit = null;
      for (const h of this.habitats) {
        const c = hullContact(h.def, ...h.toLocal(body.pos, this._v).toArray());
        if (!this.habitatHit || c.distance < this.habitatHit.contact.distance) this.habitatHit = { habitat: h, contact: c };
        this.cruiseDist = Math.min(this.cruiseDist, c.distance);
        if (h.entersAt(body.pos)) enter = h; // 入港口の筒に入った
      }
      this.swarmHit = null;
      if (this.system.swarm) {
        const p = this.shipSysPos(this._sysPos);
        // パネルとの当たり判定に使う (巡航の速さには影響させない)
        this.swarmHit = nearestPanel(this.system.swarm, this.swarm.panels, p.x, p.y, p.z);
      }
      if (enter) this.setFrame(enter);
    }
  }

  // ---------------------------------------------------------------- 宇宙

  /** 星系を読み込む。前の星系の惑星は捨てる。origin (原点の星系座標) は呼ぶ前に決めておくこと。 */
  loadSystem(star) {
    for (const p of this.planets) {
      this.scene.remove(p.group);
      p.dispose();
    }
    if (this.swarm) {
      this.scene.remove(this.swarm.group);
      this.swarm.dispose();
      this.swarm = null;
    }
    for (const h of this.habitats) {
      this.scene.remove(h.group);
      h.dispose();
    }
    this.habitatHit = null;
    this.frame = null;
    this.star = star;
    this.system = generateSystem(star);
    const swarm = this.system.swarm;
    // スウォームの外側の惑星には、パネルにさえぎられた残りの光しか届かない
    const shade = (def) => (swarm && Math.hypot(...def.position) > swarm.radius ? 1 - 0.8 * swarm.coverage : 1);
    this.planets = this.system.planets.map((def) => new Planet(def, 22 * star.lum * shade(def)));
    if (swarm) {
      this.swarm = new SwarmView(swarm, star.color);
      this.scene.add(this.swarm.group);
    }
    this.habitats = (this.system.habitats || []).map((def) => new HabitatView(def));
    for (const h of this.habitats) {
      h.updateRotation(this.simTime);
      this.scene.add(h.group);
    }
    for (const p of this.planets) {
      p.updateRotation(this.simTime);
      this.scene.add(p.group);
    }
    this.nearPlanet = null;

    // 恒星の見た目と光
    const c = star.color;
    this.sun.scale.setScalar(star.radius / SUN_RADIUS);
    this.sun.material.color.setRGB(c[0], c[1], c[2]);
    this.sunGlow.scale.setScalar(star.radius * 40);
    this.sunGlow.material.color.setRGB(c[0], c[1], c[2]);
    this.sunLight.color.setRGB(0.5 + 0.5 * c[0], 0.5 + 0.5 * c[1], 0.5 + 0.5 * c[2]);
    this.sunBase = 3.2 * Math.sqrt(star.lum);
    this.sunColor = c;

    this.asteroids.mesh.visible = !!this.system.belt;
    this._placeWorld();
    if (this.combat) this.combat.setSystem(this.system, this.planets);
    // 前の星系の天体を指していた行き先は消す
    if (this.nav && (this.nav.type !== 'star' || this.nav.star === star)) this.nav = null;
    this._updateFrame(); // いちばん近い天体までの距離などを、新しい星系で計算し直す
  }

  /** 天体の世界座標を、星系座標と原点から計算し直す。 */
  _placeWorld() {
    this.sunPos.copy(this.origin).negate();
    for (const p of this.planets) p.pos.subVectors(p.sysPos, this.origin);
    for (const h of this.habitats) h.pos.subVectors(h.sysPos, this.origin);
    const belt = this.system.belt;
    if (belt) this.asteroids.center.set(belt.position[0], belt.position[1], belt.position[2]).sub(this.origin);
  }

  /** 機体の星系座標 (恒星が原点) を out に入れる。 */
  shipSysPos(out) {
    const b = this.ship.body;
    if (this.frame) return out.copy(b.pos).applyQuaternion(this.frame.quat).add(this.frame.sysPos);
    return out.copy(b.pos).add(this.origin);
  }

  /**
   * 原点の付け替え、いちばん近い恒星への乗り換え、ジャンプ、恒星やガス巨星の危険。
   * 毎ステップ、座標系の更新の後に呼ぶ。
   */
  _updateUniverse(h) {
    const ship = this.ship;
    const body = ship.body;
    this._tick++;

    // 機体が原点から離れたら、原点を機体の位置へ移す。
    // こうすると何光年飛んでも機体の座標は小さいままで、動きが粗くならない
    if (!this.frame && body.pos.lengthSq() > RECENTER * RECENTER) {
      const d = this._shift.copy(body.pos);
      this.origin.add(d);
      body.pos.sub(d);
      body.prevPos.sub(d);
      this.explosionPos.sub(d);
      this.combat.shift(d);
      this._placeWorld();
    }

    const sys = this.shipSysPos(this._v);
    this.starDist = sys.length();
    const sp = this.star.pos;
    this.galPos[0] = sp[0] + sys.x / LY;
    this.galPos[1] = sp[1] + sys.y / LY;
    this.galPos[2] = sp[2] + sys.z / LY;

    // 恒星に近づきすぎると焼かれる
    const hot = this.star.radius * 1.6;
    if (!this.destroyed && this.starDist < hot) {
      ship.hull -= 30 * h * (1 + 4 * (hot - this.starDist) / (0.6 * this.star.radius));
      this.flash = Math.max(this.flash, 0.3);
      this.notify('恒星に近すぎる — 機体が焼けている', 1);
    }
    // スウォームのパネルにぶつかる
    const hit = this.swarmHit;
    if (hit && !this.frame && !this.destroyed) {
      const def = this.system.swarm;
      const half = def.thickness / 2 + 4;
      if (Math.abs(hit.normal) < half && hit.lateral < def.panel * HIT_RADIUS) {
        const pp = this.swarm.panels.pos, i = hit.index * 3;
        const n = this._v2.set(-pp[i], -pp[i + 1], -pp[i + 2]).normalize(); // パネルの法線 (恒星の方)
        const side = hit.normal >= 0 ? 1 : -1;
        body.pos.addScaledVector(n, side * half - hit.normal); // 来た側の面の外へ押し戻す
        body.prevPos.copy(body.pos);
        const vn = body.vel.dot(n);
        if (vn * side < 0) {
          const impact = Math.abs(vn);
          body.vel.addScaledVector(n, -vn * 1.3); // 跳ね返る
          if (ship.driving) ship.stopCruise();
          if (impact > 15) {
            ship.hull -= Math.min(120, impact * 0.6);
            this.onPlayerHit(impact * 0.2, true);
            this.notify('パネルに衝突した', 1.5);
          }
        }
      }
    }
    // オニール・シリンダーの中: 両端の蓋にぶつかる
    if (this.frame && this.frame.wallContact && !this.destroyed) {
      const w = this.frame.wallContact(body.pos, 8);
      if (w) {
        const n = this._v2.set(...w.normal);
        body.pos.addScaledVector(n, w.depth);
        body.prevPos.copy(body.pos);
        const vn = body.vel.dot(n);
        if (vn < 0) {
          body.vel.addScaledVector(n, -vn * 1.3);
          if (-vn > 15) {
            ship.hull -= Math.min(120, -vn * 0.6);
            this.onPlayerHit(-vn * 0.2, true);
            this.notify('蓋の壁に衝突した', 1.5);
          }
        }
      }
    }
    // オニール・シリンダーの外壁にぶつかる (物理の上では外壁は止まっている)
    const hh = this.habitatHit;
    if (hh && hh.contact.inside && !this.frame && !this.destroyed) {
      const h = hh.habitat, c = hh.contact;
      const n = this._v2.set(...c.normal).applyQuaternion(h.quat); // 押し出す向き (世界座標)
      body.pos.addScaledVector(n, c.depth + 2);
      body.prevPos.copy(body.pos);
      const vn = body.vel.dot(n);
      if (vn < 0) {
        const impact = -vn;
        body.vel.addScaledVector(n, -vn * 1.3); // 跳ね返る
        if (ship.driving) ship.stopCruise();
        if (impact > 15) {
          ship.hull -= Math.min(120, impact * 0.6);
          this.onPlayerHit(impact * 0.2, true);
          this.notify(`${h.name} の外壁に衝突した`, 1.5);
        }
      }
      this.habitatHit = { habitat: h, contact: hullContact(h.def, ...h.toLocal(body.pos, this._v).toArray()) };
    }
    // ガス巨星の深い所では気圧でつぶされる
    if (!this.destroyed && this.frame && this.frame.gas && this.altitudeSea < 40e3) {
      ship.hull -= 25 * h;
      this.flash = Math.max(this.flash, 0.2);
      this.notify('気圧が高すぎる — 上昇せよ', 1);
    }

    // 別の恒星の方が近くなったら、そちらの星系に乗り換える (恒星間の真ん中あたりで起きる)
    if (!this.frame && this._tick % 30 === 0 && this.starDist > 0.2 * LY) {
      const n = nearestStar(this.galPos);
      if (n && n.star !== this.star && n.dist * LY < this.starDist * 0.95) this._enterSystem(n.star);
    }

    // ジャンプ
    const jump = this.jump;
    if (jump) {
      jump.t += h;
      if (jump.phase === 'charge') {
        if (this.frame || this.destroyed) {
          this.jump = null;
        } else if (jump.t >= JUMP_CHARGE) {
          this._doJump(jump.star);
        }
      } else if (jump.t >= JUMP_ARRIVE) {
        this.jump = null;
      }
    }
  }

  /** 飛んでいるうちに別の恒星の方が近くなった。原点をその星系の座標に付け替える。 */
  _enterSystem(star) {
    const o = this.star.pos, n = star.pos;
    this.origin.x += (o[0] - n[0]) * LY;
    this.origin.y += (o[1] - n[1]) * LY;
    this.origin.z += (o[2] - n[2]) * LY;
    this.loadSystem(star);
    this.notify(`${star.name} 星系の圏内に入った`);
  }

  /** 行き先を決める。null で解除。 */
  setNav(nav) {
    this.nav = nav;
    if (this.jump && this.jump.phase === 'charge') this.jump = null;
    this.sound.click();
  }

  /** 行き先を、今の星系の天体の中で近い順に切り替える。最後まで行くと解除。 */
  cycleNav() {
    const here = this.frame
      ? this._v.copy(this.ship.body.pos).applyQuaternion(this.frame.quat).add(this.frame.pos).clone()
      : this.ship.body.pos.clone();
    const list = this.planets
      .map((planet) => ({ nav: { type: 'planet', planet }, d: planet.pos.distanceTo(here) }));
    if (this.system.belt) list.push({ nav: { type: 'belt' }, d: this.asteroids.center.distanceTo(here) });
    if (this.system.swarm) {
      const nav = this.swarmNav();
      list.push({ nav, d: this._v.copy(nav.point).sub(this.origin).distanceTo(here) });
    }
    for (const habitat of this.habitats) list.push({ nav: { type: 'habitat', habitat }, d: habitat.pos.distanceTo(here) });
    list.sort((a, b) => a.d - b.d);
    let i = -1;
    if (this.nav) {
      i = list.findIndex((e) => e.nav.type === this.nav.type && e.nav.planet === this.nav.planet
        && e.nav.habitat === this.nav.habitat);
    }
    this.setNav(i + 1 < list.length ? list[i + 1].nav : null);
  }

  /** 行き先の名前。 */
  navName(nav = this.nav) {
    if (!nav) return '';
    if (nav.type === 'planet') return nav.planet.name;
    if (nav.type === 'star') return `${nav.star.name} 星系`;
    if (nav.type === 'swarm') return 'ダイソン・スウォーム';
    if (nav.type === 'habitat') return nav.habitat.name;
    return '小惑星帯';
  }

  /** スウォームへの行き先 (いま機体にいちばん近いパネルの表側、パネルの大きさの半分ほど手前)。 */
  swarmNav() {
    const def = this.system.swarm;
    const p = this.shipSysPos(this._sysPos);
    const hit = nearestPanel(def, this.swarm.panels, p.x, p.y, p.z);
    const i = hit.index * 3, pp = this.swarm.panels.pos;
    const c = new THREE.Vector3(pp[i], pp[i + 1], pp[i + 2]);
    const point = c.clone().multiplyScalar(1 - (def.panel * 0.5) / c.length());
    return { type: 'swarm', point };
  }

  /** ジャンプの開始 / 中止。 */
  toggleJump() {
    if (this.jump) {
      if (this.jump.phase === 'charge') {
        this.jump = null;
        this.notify('ジャンプを中止した', 1.5);
      }
      return;
    }
    if (this.destroyed) return;
    if (!this.nav || this.nav.type !== 'star') {
      this.notify('ジャンプ先の恒星が選ばれていません (M で星図を開く)');
      return;
    }
    if (this.frame) {
      this.notify('惑星に近すぎます — もっと離れてください');
      return;
    }
    this.jump = { star: this.nav.star, t: 0, phase: 'charge' };
    this.sound.click();
  }

  /** ジャンプの実行。行き先の恒星から少し離れた、元いた星系の側に出る。 */
  _doJump(star) {
    const ship = this.ship;
    const b = ship.body;
    const from = this.star.pos, to = star.pos;
    const dir = new THREE.Vector3(from[0] - to[0], from[1] - to[1], from[2] - to[2]);
    if (dir.lengthSq() < 1e-12) dir.set(1, 0, 0);
    dir.normalize();
    // 惑星のすぐそばに出ないよう、必要なら距離を伸ばす
    const system = generateSystem(star);
    let dist = 1.2 * AU * Math.sqrt(star.lum);
    const at = new THREE.Vector3();
    for (let i = 0; i < 8; i++) {
      at.copy(dir).multiplyScalar(dist);
      const clear = [...system.planets, ...(system.habitats || [])].every((p) =>
        Math.hypot(p.position[0] - at.x, p.position[1] - at.y, p.position[2] - at.z) > Math.max(p.radius * 20, 200e3));
      if (clear) break;
      dist *= 1.2;
    }
    this.combat.clearAll();
    this.origin.copy(at);
    b.pos.set(0, 0, 0);
    b.prevPos.set(0, 0, 0);
    b.vel.set(0, 0, 0);
    b.angVel.set(0, 0, 0);
    b.quat.setFromUnitVectors(new THREE.Vector3(0, 0, -1), dir.clone().negate()); // 恒星の方を向く
    b.prevQuat.copy(b.quat);
    ship.stopCruise();
    this.input.throttle = 0;
    this.rig._snap = true;
    this.loadSystem(star);
    this._updateFrame();
    this.jump = { star, t: 0, phase: 'arrive' };
    this.sound.explosion(0.4);
    this.notify(`${star.name} 星系に到着した`);
  }

  /** 機体の属する座標系を切り替える (planet = null で宇宙)。見た目は連続する。 */
  setFrame(planet) {
    if (this.frame === planet) return;
    const body = this.ship.body;
    if (this.frame) {
      leaveFrame(body, this.frame);
      this.rig.reframe(this.frame.quat, body.vel);
    }
    const left = this.frame;
    this.frame = planet;
    if (planet) {
      enterFrame(body, planet);
      this.rig.reframe(this._qInv.copy(planet.quat).invert(), body.vel);
    }
    if (this.combat) this.combat.reframe();
    // オニール・シリンダー: 中にいる間は外の見た目の回転を止める。巡航は使えない
    if (left && left.unfreeze) {
      left.unfreeze(this.simTime);
      this.notify(`${left.name} を出港した`, 2);
    }
    if (planet && planet.freeze) {
      planet.freeze();
      this.ship.stopCruise();
      this.notify(`${planet.name} に入港した — 中は安全地帯`, 3);
    }
  }

  /** 画面に短い知らせを出す。 */
  notify(text, seconds = 3) {
    this.notice = text;
    this.noticeTime = seconds;
  }

  /** 機体を失う。少し待ってから上空で復帰する。 */
  _destroy() {
    const ship = this.ship;
    const b = ship.body;
    this.destroyed = true;
    this.respawnTimer = RESPAWN_TIME;
    this.explosionPos.copy(b.pos);
    ship.hull = 0;
    ship.stopCruise();
    ship.thrustLevel = 0;
    ship.liftLevel = 0;
    b.vel.set(0, 0, 0);
    b.angVel.set(0, 0, 0);
    b.prevPos.copy(b.pos);
    b.prevQuat.copy(b.quat);
    this.flash = 1;
    this.sound.explosion();
  }

  _respawn() {
    const ship = this.ship;
    this.destroyed = false;
    ship.restore();
    if (this.frame) {
      // ガス巨星では、気圧でつぶされない高さまで戻す
      const alt = this.frame.gas ? this.frame.atmosphere.height + 60e3 : RESPAWN_ALTITUDE;
      this.placeShip(this.frame, ship.body.pos.clone(), alt);
    } else {
      this.input.throttle = 0; // 宇宙ではその場で復帰する
      // 恒星のそばで失ったときは、安全な距離まで離す
      const away = ship.body.pos.clone().sub(this.sunPos);
      const safe = this.star.radius * 6;
      if (away.length() < safe) {
        if (away.lengthSq() < 1) away.set(1, 0, 0);
        ship.body.pos.copy(this.sunPos).add(away.setLength(safe));
        ship.body.prevPos.copy(ship.body.pos);
        this.rig._snap = true;
      }
    }
  }

  /**
   * 機体を惑星の上空に、北向き・水平で置く。
   * @param up 惑星ローカル座標での方向 (この方向の地面の上に置く)
   * @param alt 地面からの高さ (m)
   * @param pitch 機首の上下 (度, 0 = 水平)
   * @param speed 前進速度 (m/s)。0 ならホバーで静止、0 より大きければ飛行状態にする
   */
  placeShip(planet, up, alt, pitch = 0, speed = 0) {
    this.setFrame(planet);
    const ship = this.ship;
    const b = ship.body;
    planet.surfacePoint(up, alt, b.pos);
    up = planet.upAt(b.pos, new THREE.Vector3());
    b.angVel.set(0, 0, 0);
    const north = new THREE.Vector3(0, 1, 0).addScaledVector(up, -up.y).normalize();
    const right = new THREE.Vector3().crossVectors(north, up);
    b.quat.setFromRotationMatrix(new THREE.Matrix4().makeBasis(right, up, north.clone().negate()));
    b.quat.multiply(
      new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), (pitch * Math.PI) / 180));
    b.vel.set(0, 0, -speed).applyQuaternion(b.quat);
    b.prevPos.copy(b.pos);
    b.prevQuat.copy(b.quat);
    this.destroyed = false;
    if (ship.hull <= 0) ship.restore();
    ship.heat = 0;
    ship.stopCruise();
    ship.hover = speed <= 0;
    ship.gearDown = false;
    ship.gear = 0;
    this.ground.prev.fill(false);
    this.ground.reset();
    this.groundTimer = 0;
    this.input.throttle = speed > 0 ? 0.5 : 0;
    this.rig._snap = true;
    this._updateFrame();
  }

  // ---------------------------------------------------------------- 描画

  /** 世界座標の点を描画座標に直す。 */
  toRender(world, out) {
    out.copy(world);
    if (this.frame) out.sub(this.frame.pos).applyQuaternion(this._fqInv);
    return out.sub(this.rig.pos);
  }

  /** カメラから見た相対ベクトルを画面座標 (CSS px) に投影する。front はカメラの前にあるか。 */
  project(rel) {
    const v = this._v.copy(rel).applyQuaternion(this._qInv);
    if (v.z >= -1e-6) return { x: 0, y: 0, visible: false, front: false };
    const t = Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2);
    const nx = v.x / (-v.z * t * this.camera.aspect);
    const ny = v.y / (-v.z * t);
    const w = window.innerWidth, h = window.innerHeight;
    return {
      x: (nx * 0.5 + 0.5) * w, y: (-ny * 0.5 + 0.5) * h,
      visible: Math.abs(nx) < 1.05 && Math.abs(ny) < 1.05,
      front: true,
    };
  }

  /** 描画 (可変フレーム)。alpha は物理ステップ間の補間係数。 */
  frame_(alpha, dt) {
    this.time += dt;
    if (dt > 0) this.fps += (1 / dt - this.fps) * 0.05;

    const ship = this.ship;
    const body = ship.body;
    body.getInterpolated(alpha, this._sPos, this._sQuat);

    this.boostVisual += ((ship.boosting ? 1 : 0) - this.boostVisual) * (1 - Math.exp(-dt * 4));
    this.rig.update(dt, this._sPos, this._sQuat, body.vel, this.input.look, this.boostVisual, ship.driving);

    // カメラが地面にもぐらないようにする。
    // 真上へ持ち上げると崖の壁の中から崖の上へ飛び出すので、機体の方へ引き寄せる
    const cam = this.rig.pos;
    if (this.frame) {
      const frame = this.frame;
      const below = (p) => frame.heightAbove(p) < CAMERA_CLEARANCE;
      if (below(cam)) {
        const ship = this._sPos;
        if (below(ship)) {
          const h = frame.heightAbove(cam);
          cam.addScaledVector(frame.upAt(cam, this._v), CAMERA_CLEARANCE - h);
        } else {
          // 機体 (t = 0) とカメラ (t = 1) を結ぶ線上で、地面より上にある最も遠い点を二分探索する
          const p = this._camProbe || (this._camProbe = new THREE.Vector3());
          let lo = 0, hi = 1;
          for (let k = 0; k < 10; k++) {
            const mid = (lo + hi) / 2;
            if (below(p.copy(ship).lerp(cam, mid))) hi = mid;
            else lo = mid;
          }
          cam.copy(ship).lerp(cam, lo);
        }
      }
    }

    // --- フレーム座標 → 描画座標 ---
    const frameQuat = this.frame ? this.frame.quat : IDENTITY;
    this._fqInv.copy(frameQuat).invert();

    this.camera.position.set(0, 0, 0);
    this.camera.quaternion.copy(this.rig.quat);
    if (Math.abs(this.camera.fov - this.rig.fov) > 0.01) {
      this.camera.fov = this.rig.fov;
      this.camera.updateProjectionMatrix();
    }

    // 揺れ: 空力加熱・失速・地上滑走・損傷
    this.flash = Math.max(0, this.flash - dt * 1.5);
    this.shieldFlash = Math.max(0, this.shieldFlash - dt * 2.5);
    if (!this.paused) this.noticeTime = Math.max(0, this.noticeTime - dt);
    const airborne = this.ground.contacts === 0;
    const shake = this.paused || this.destroyed ? 0
      : clamp(ship.driving ? 0 : ship.heat, 0, 1.5) * 0.006
        + (ship.aero.stalled && airborne ? 0.003 : 0)
        + (airborne ? 0 : Math.min(this.ground.slideSpeed, 80) * 0.00006)
        + this.flash * 0.01;
    if (shake > 0) {
      const rnd = () => (Math.random() * 2 - 1) * shake;
      this.camera.quaternion.multiply(
        this._shake.setFromEuler(this._e.set(rnd(), rnd(), rnd() * 0.5)));
    }

    const cockpitView = this.rig.mode === 'cockpit';
    this.shipModel.visible = !cockpitView && !this.destroyed;
    this.cockpit.visible = cockpitView;
    this.shipModel.position.subVectors(this._sPos, cam);
    this.shipModel.quaternion.copy(this._sQuat);
    this.shipModel.userData.setThrust(ship.thrustLevel, ship.boosting, this.time);
    this.shipModel.userData.setGear(ship.gear);
    this.shipModel.userData.setHeat(ship.driving ? 0 : ship.heat, this.time);

    // 爆発
    this.explosion.visible = this.destroyed;
    if (this.destroyed) {
      const t = RESPAWN_TIME - this.respawnTimer;
      this.explosion.position.subVectors(this.explosionPos, cam);
      this.explosion.scale.setScalar(14 + t * 40);
      this.explosion.material.opacity = clamp(1.3 - t / 1.6, 0, 1);
    }

    // 世界に固定された物は、フレームが回っていればその逆回転をかけて置く
    this.starfield.quaternion.copy(this._fqInv);
    this.toRender(this.asteroids.center, this.asteroids.mesh.position);
    this.asteroids.mesh.quaternion.copy(this._fqInv);

    this.asteroids.mesh.visible = !!this.system.belt;

    this.toRender(this.sunPos, this.sun.position);
    this.sunGlow.position.copy(this.sun.position);
    const sunDist = this.sun.position.length();
    const sunDir = this._v2.copy(this.sun.position).normalize();
    this.sunLight.position.copy(sunDir);
    // 遠い恒星は球ではなく光の点として描く (近くの他の恒星と同じ扱い)
    const sunNear = sunDist < SUN_POINT_DISTANCE;
    this.sun.visible = this.sunGlow.visible = sunNear;
    this.nearStars.points.quaternion.copy(this._fqInv);
    this.nearStars.update(dt, this.galPos, this.star, sunNear);

    // スウォームの外から見ると、恒星はパネルにさえぎられて暗く赤い
    let starDim = 1;
    const swarm = this.swarm;
    if (swarm) {
      const camSys = this._camSys.copy(cam);
      if (this.frame) camSys.applyQuaternion(this.frame.quat).add(this.frame.sysPos);
      else camSys.add(this.origin);
      const def = swarm.def;
      const out = clamp((camSys.length() - def.radius * 0.98) / (def.radius * 0.2), 0, 1);
      starDim = 1 - 0.8 * def.coverage * out;
      swarm.update(camSys, this.swarmHit ? this.swarmHit.surface : camSys.length() * 0.1);
      this.toRender(this._v.copy(swarm.anchor).sub(this.origin), swarm.group.position);
      swarm.group.quaternion.copy(this._fqInv);
      const u = swarm.material.uniforms;
      u.uSunPos.value.copy(this.sun.position);
      u.uSunI.value = 1.6 * Math.sqrt(this.star.lum);
      const pu = swarm.pointMaterial.uniforms;
      pu.uPxScale.value = window.innerHeight / 2 / Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2);
      pu.uPixelRatio.value = this.renderer.getPixelRatio();
    }
    const sc = this.sunColor;
    const red = 1 - starDim; // 暗くなるほど赤く (パネルの排熱の赤外線)
    this.sun.material.color.setRGB(sc[0] * starDim, sc[1] * starDim * (1 - red * 0.5), sc[2] * starDim * (1 - red * 0.8));
    this.sunGlow.material.color.copy(this.sun.material.color);

    // オニール・シリンダー
    for (const h of this.habitats) {
      this.toRender(h.pos, h.group.position);
      h.group.quaternion.copy(this._fqInv).multiply(h.quat);
      // 中は、その円筒の中にいるときと、入港口に近づいたとき (筒の奥に中が見える) だけ描く
      h.interior.visible = h === this.frame || (!this.frame && h.nearPort(cam)); // 宇宙ではカメラの位置 = 世界座標
    }

    // 惑星
    let starFade = 1;
    let airDensity = 0;
    let sunVisible = 1;
    for (const planet of this.planets) {
      const camPlanet = this._camPlanet;
      if (planet === this.frame) {
        planet.group.position.copy(cam).negate();
        planet.group.quaternion.identity();
        camPlanet.copy(cam);
      } else {
        this.toRender(planet.pos, planet.group.position);
        planet.group.quaternion.copy(this._fqInv).multiply(planet.quat);
        // カメラの惑星ローカル座標 = 惑星の向きの逆回転 × (カメラ − 惑星中心)
        camPlanet.copy(planet.group.position).negate()
          .applyQuaternion(this._qInv.copy(planet.group.quaternion).invert());
      }
      planet.updateRender(camPlanet, sunDir);

      // 昼の大気の中では星が見えなくなる
      const camR = camPlanet.length();
      const density = planet.densityAt(camR - planet.radius);
      const sunUp = camPlanet.dot(
        this._v.copy(sunDir).applyQuaternion(this._qInv.copy(planet.group.quaternion).invert())) / camR;
      starFade = Math.min(starFade, 1 - clamp(density * 8, 0, 1) * clamp(sunUp * 4 + 0.6, 0, 1));
      airDensity = Math.max(airDensity, density);

      // 惑星の影に入ったら機体に当たる太陽光を弱める
      const toCenter = this._v.copy(planet.group.position).add(this.shipModel.position);
      const along = toCenter.dot(sunDir);
      if (along > 0) {
        const perp = Math.sqrt(Math.max(0, toCenter.lengthSq() - along * along));
        sunVisible = Math.min(sunVisible, clamp((perp - planet.radius * 0.99) / (planet.radius * 0.04), 0, 1));
      }
    }
    this.starfield.material.uniforms.uFade.value = starFade;
    this.nearStars.material.uniforms.uFade.value = starFade;
    // 恒星から遠く離れると光が届かなくなる
    const reach = clamp(3e13 / sunDist, 0, 1);
    this.sunLight.intensity = this.sunBase * sunVisible * reach * starDim;
    this.ambient.intensity = 0.25 + 0.55 * sunVisible * reach;
    // 居住地の中では、機体は向かいの窓から差し込む鏡の光に照らされる (座標系の向き = 描画の向き)
    if (this.frame && this.frame.lightDirAt) {
      this.frame.lightDirAt(this._sPos, this.sunLight.position);
      this.sunLight.intensity = 2.4;
      this.ambient.intensity = 0.7;
    }

    // 塵は速すぎると点滅して見えるので、高速では消す
    const speed = body.vel.length();
    // 宇宙塵なので、大気の中でも消す
    this.dust.material.uniforms.uOpacity.value =
      clamp(1.5 - speed / 3000, 0, 1) * clamp(1 - airDensity * 20, 0, 1);
    this.dust.update(cam);

    this.combat.render(cam, alpha, this.time);

    this._qInv.copy(this.rig.quat).invert(); // project() 用
    this.renderer.render(this.scene, this.camera);

    const flying = !this.destroyed && !ship.driving;
    const stall = flying && ship.aero.stalled && airborne && ship.hoverAuthority < 0.5;
    this.sound.update({
      paused: this.paused,
      thrust: this.destroyed ? 0 : ship.thrustLevel,
      boosting: ship.boosting,
      lift: this.destroyed ? 0 : ship.liftLevel,
      q: flying ? ship.aero.q : 0,
      speed,
      heat: flying ? ship.heat : 0,
      stall,
      roll: airborne || this.destroyed ? 0 : Math.min(this.ground.slideSpeed / 60, 1),
      time: this.time,
      lock: this.destroyed || !this.combat.target ? 0 : this.combat.locked ? 2 : this.combat.lock > 0.05 ? 1 : 0,
      missileWarn: !this.destroyed && this.combat.player.missileThreat,
    });

    this._drawHud(speed, cam, stall);
  }

  /**
   * 水平線とピッチ目盛りの線を、画面座標で求める。
   * カメラの向きから計算するので、線は実際の地平と重なって見える。
   */
  _ladder(cam) {
    const lines = [];
    const up = this.frame.upAt(cam, new THREE.Vector3());
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(this.rig.quat);
    const head = fwd.addScaledVector(up, -fwd.dot(up));
    if (head.lengthSq() < 0.01) return lines; // 真上・真下を向いているときは描かない
    head.normalize();
    const right = new THREE.Vector3().crossVectors(head, up);
    const dir = new THREE.Vector3();
    const point = (elev, az) => {
      const ce = Math.cos(elev);
      dir.copy(head).multiplyScalar(ce * Math.cos(az))
        .addScaledVector(right, ce * Math.sin(az))
        .addScaledVector(up, Math.sin(elev));
      return this.project(dir);
    };
    for (const deg of LADDER_STEPS) {
      const e = (deg * Math.PI) / 180;
      const half = deg === 0 ? 0.55 : 0.1;
      const a = point(e, -half), b = point(e, half);
      if (!a.front || !b.front) continue;
      if (!a.visible && !b.visible && deg !== 0) continue;
      lines.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y, deg });
    }
    return lines;
  }

  _drawHud(speed, cam, stall) {
    const ship = this.ship;
    const body = ship.body;
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(this._sQuat).multiplyScalar(1000);
    const boresight = this.project(fwd.add(this._sPos).sub(cam));
    let prograde = { visible: false }, retrograde = { visible: false };
    if (speed > 1) {
      const dir = new THREE.Vector3().copy(body.vel).divideScalar(speed);
      prograde = this.project(dir);
      retrograde = this.project(dir.negate());
    }

    // 惑星の目印 (遠くて小さく見えるときだけ)
    const markers = [];
    const navPlanet = this.nav && this.nav.type === 'planet' ? this.nav.planet : null;
    for (const planet of this.planets) {
      if (planet === navPlanet) continue; // 行き先は別の目印で出す
      const dist = planet.group.position.length();
      if (dist > planet.radius * 2.5) {
        const p = this.project(planet.group.position);
        if (p.visible) markers.push({ ...p, name: planet.name, dist: dist - planet.radius });
      }
    }

    // オニール・シリンダーの目印 (組ごとに1つ。遠くて小さく見えるときだけ)
    const navHabitat = this.nav && this.nav.type === 'habitat' ? this.nav.habitat : null;
    for (const h of this.habitats) {
      if (h.def.spin < 0 || h === navHabitat) continue;
      const dist = h.group.position.length();
      if (dist > h.def.length * 3) {
        const p = this.project(h.group.position);
        if (p.visible) markers.push({ ...p, name: h.name.replace(/ I$|-A$/, ''), dist: dist - h.radius });
      }
    }

    // 行き先
    let nav = null;
    if (this.nav) {
      const rel = new THREE.Vector3();
      let dist;
      if (this.nav.type === 'planet') {
        rel.copy(this.nav.planet.group.position);
        dist = rel.length() - this.nav.planet.radius;
      } else if (this.nav.type === 'belt') {
        this.toRender(this.asteroids.center, rel);
        dist = rel.length();
      } else if (this.nav.type === 'habitat') {
        this.toRender(this.nav.habitat.pos, rel);
        dist = rel.length() - this.nav.habitat.radius;
      } else if (this.nav.type === 'swarm') {
        this.toRender(this._v2.copy(this.nav.point).sub(this.origin), rel);
        dist = rel.length();
      } else {
        // 別の恒星: 銀河座標の差から方向と距離を求める
        const s = this.nav.star.pos, g = this.galPos;
        rel.set(s[0] - g[0], s[1] - g[1], s[2] - g[2]);
        dist = rel.length() * LY;
        rel.applyQuaternion(this._fqInv);
      }
      const dirHat = rel.clone().normalize();
      const p = this.project(dirHat);
      const camLocal = dirHat.clone().applyQuaternion(this._qInv);
      const len = Math.hypot(camLocal.x, camLocal.y) || 1;
      const closing = body.vel.dot(dirHat);
      nav = {
        x: p.x, y: p.y, visible: p.visible, name: this.navName(), dist: Math.max(0, dist),
        eta: closing > 1 ? dist / closing : Infinity,
        dirX: camLocal.x / len, dirY: camLocal.y / len,
        star: this.nav.type === 'star',
      };
    }

    let jump = null;
    if (this.jump) {
      jump = {
        name: this.jump.star.name,
        charge: this.jump.phase === 'charge' ? this.jump.t / JUMP_CHARGE : 1,
        arrive: this.jump.phase === 'arrive' ? 1 - this.jump.t / JUMP_ARRIVE : 0,
      };
    }
    // 高速の巡航中に星が流れる演出の強さ (秒速100km で始まり、光速の1000倍で最大)
    const warp = ship.driving ? clamp((Math.log10(Math.max(speed, 1)) - 5) / 6.5, 0, 1) : 0;

    // 惑星の近くでは姿勢の目盛りと方位を出す
    let ladder = null;
    let heading = null;
    const nearPlanet = !!this.frame && this.altitudeSea < 150e3;
    if (nearPlanet) {
      ladder = this._ladder(cam);
      const up = this.frame.upAt(body.pos, new THREE.Vector3());
      const f = new THREE.Vector3(0, 0, -1).applyQuaternion(body.quat);
      f.addScaledVector(up, -f.dot(up));
      const north = new THREE.Vector3(0, 1, 0).addScaledVector(up, -up.y);
      if (f.lengthSq() > 1e-4 && north.lengthSq() > 1e-6) {
        const east = new THREE.Vector3().crossVectors(north, up);
        heading = ((Math.atan2(f.dot(east), f.dot(north)) * 180) / Math.PI + 360) % 360;
      }
    }

    let mode = 'SPACE';
    if (ship.driving) mode = ship.cruiseExit ? 'CRUISE END' : 'CRUISE';
    else if (!ship.flightAssist) mode = 'MANUAL';
    else if (ship.hover && this._env.aero > 0.05) mode = 'HOVER';
    else if (this._env.aero > 0.5) mode = 'AERO';

    this.hud.draw({
      speed,
      throttle: this.input.controls.throttle,
      boosting: ship.boosting,
      assist: ship.flightAssist,
      cruise: ship.cruise,
      view: this.rig.mode,
      stick: this.input.stick,
      fps: this.fps,
      boresight, prograde, retrograde, markers,
      locked: this.input.mouseActive || this.paused,
      frameName: this.frame ? this.frame.name : null,
      altitude: this.altitude,
      altitudeSea: this.altitudeSea,
      grounded: this.grounded,
      landed: this.landed,
      chunks: this.planets.reduce((n, p) => n + (p.lod ? p.lod.visibleCount : 0), 0),
      queued: (this.planets.find((p) => p.lod) || { lod: { pool: { queued: 0 } } }).lod.pool.queued,
      systemName: this.star.name,
      starDist: this.starDist,
      nav, jump, warp,
      inSpace: !this.frame,
      mode,
      gear: ship.gear,
      gearDown: ship.gearDown,
      hull: ship.hull,
      heat: ship.driving ? 0 : ship.heat,
      flash: this.flash,
      destroyed: this.destroyed,
      inAir: this._env.rho > 0.002 && !ship.driving,
      nearPlanet,
      aoa: ship.aero.aoa,
      stall,
      gLoad: this.gLoad,
      verticalSpeed: this.verticalSpeed,
      ladder, heading,
      notice: this.noticeTime > 0 ? this.notice : '',
      time: this.time,
      shieldFlash: this.shieldFlash,
      combat: this.combat.hudData(),
    });
  }
}
