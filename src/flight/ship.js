import { Vector3, Quaternion } from 'three';
import { RigidBody } from '../physics/body.js';
import { computeAero, makeAeroState } from './aero.js';

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const mix = (a, b, t) => a + (b - a) * t;

/** 操縦入力。すべて -1..1 (boost は 0/1)。 */
export function makeControls() {
  return {
    pitch: 0, // + で機首上げ
    yaw: 0, // + で機首右
    roll: 0, // + で右ロール
    strafeX: 0, // + で右
    strafeY: 0, // + で上
    throttle: 0, // -1..1
    boost: 0,
  };
}

const ZERO = new Vector3();
/**
 * 機体のまわりの環境。
 * speedScale: 巡航モード時に速度と加速度に掛ける倍率
 * gravity: 重力加速度 (フレーム座標, m/s²)
 * rho: 空気密度 (kg/m³)
 * aero: 0..1。空気が十分に濃く、航空機として飛べる度合い
 * onGround: 3本の脚がすべて接地しているか
 * altitude: 地面からの高さ (m)。省略可
 */
export const DEFAULT_ENV = { speedScale: 1, gravity: ZERO, rho: 0, aero: 0, onGround: false };
export const SEA_LEVEL_DENSITY = 1.225;

const _vLocal = new Vector3();
const _gLocal = new Vector3();
const _f = new Vector3();
const _t = new Vector3();
const _qi = new Quaternion();

/**
 * 機体。入力から推力とトルクを決め、剛体を進める。
 *
 * フライトアシスト (FA) ON のとき、場所によって操縦の仕方が変わる:
 *   宇宙 / ホバー … スロットルが「目標速度」。手を離すと止まり、重力も打ち消す
 *   大気中 (航空機) … スロットルが「推力」。翼の揚力で飛ぶ。回転は指示した向きを保つ
 * FA OFF … 入力がそのまま推力・トルクになる。慣性も重力もそのまま
 */
export class Ship {
  constructor(params) {
    this.params = params;
    this.body = new RigidBody({ mass: params.mass, inertia: params.inertia });
    this.flightAssist = true;
    this.cruise = false; // 巡航モード (地表から遠いほど速く飛べる。重力と空気を無視する)
    this.cruiseExit = null; // 巡航をやめる途中の減速 { t, v0, assistOff }
    this.hover = false; // 大気中でもホバー (VTOL) 制御を使う
    this.gearDown = false;
    this.gear = 0; // 着陸装置の出具合 0..1
    this.hullMax = params.hullMax ?? 100;
    this.hull = this.hullMax; // 機体の耐久。0 で失われる。自然には回復しない
    this.shieldMax = params.shieldMax ?? 100;
    this.shield = this.shieldMax; // シールド。しばらく被弾しなければ回復する
    this.shieldTimer = 0; // 回復が始まるまでの残り時間 (秒)
    this.energy = params.weapons.energyMax; // 機関砲のエネルギー
    this.missiles = params.weapons.missiles; // ミサイルの残数
    this.heat = 0; // 空力加熱 (1 で限界)
    this.thrustLevel = 0; // 主エンジンの噴射量 0..1 (見た目・音用)
    this.liftLevel = 0; // 姿勢制御スラスターの使用量 0..1 (音用)
    this.boosting = false;
    this.aero = makeAeroState();
    this.hoverAuthority = 1; // 0 = 航空機として飛んでいる, 1 = ホバー / 宇宙の制御
    this.idle = false; // 接地してエンジンを絞っている
    this.gravityApplied = new Vector3(); // このステップでかけた重力加速度
  }

  /** 巡航ドライブが働いているか。 */
  get driving() {
    return this.cruise && this.flightAssist;
  }

  /**
   * 巡航をやめる。巡航中の速さはドライブが生んだもので、そのまま大気にさらすと機体が持たない。
   * そこで、初速によらず決まった時間 (cruiseExitTime) をかけて通常の速度まで落とす。
   * 減速が終わるまではドライブが働き続け、重力と空気を無視する。
   * @param assistOff 減速が終わったらフライトアシストを切る
   */
  exitCruise(assistOff = false) {
    if (!this.cruise) return;
    if (this.cruiseExit) {
      this.cruiseExit.assistOff = this.cruiseExit.assistOff || assistOff;
      return;
    }
    const v0 = this.body.vel.length();
    if (v0 <= this.params.assistMaxSpeed) {
      this.cruise = false;
      if (assistOff) this.flightAssist = false;
      return;
    }
    this.cruiseExit = { t: 0, v0, assistOff };
  }

  /** 巡航を即座に止める (機体を置き直すとき用)。 */
  stopCruise() {
    this.cruise = false;
    this.cruiseExit = null;
  }

  /**
   * 攻撃や衝突による損傷を受ける。まずシールドが受け、あふれた分が機体に入る。
   * @returns 機体まで届いたか
   */
  takeDamage(amount) {
    this.shieldTimer = this.params.shieldDelay;
    const absorbed = Math.min(this.shield, amount);
    this.shield -= absorbed;
    this.hull -= amount - absorbed;
    return amount > absorbed;
  }

  /** シールドと武器エネルギーの回復。毎ステップ呼ぶ。 */
  updateSystems(dt) {
    const p = this.params;
    this.shieldTimer -= dt;
    if (this.shieldTimer <= 0) this.shield = Math.min(this.shieldMax, this.shield + p.shieldRegen * dt);
    this.energy = Math.min(p.weapons.energyMax, this.energy + p.weapons.energyRegen * dt);
  }

  /** 機体・シールド・弾薬を満タンに戻す。 */
  restore() {
    this.hull = this.hullMax;
    this.shield = this.shieldMax;
    this.shieldTimer = 0;
    this.heat = 0;
    this.energy = this.params.weapons.energyMax;
    this.missiles = this.params.weapons.missiles;
  }

  /** 1ステップ進める (力をかけて積分する)。 */
  step(dt, c, env = DEFAULT_ENV) {
    this.applyForces(dt, c, env);
    this.body.integrate(dt);
  }

  /** 推力・重力・空気力を剛体にかける。積分は呼び出し側で行う。 */
  applyForces(dt, c, env = DEFAULT_ENV) {
    const p = this.params;
    const b = this.body;
    let drive = this.driving;
    let scale = drive ? env.speedScale : 1;

    // 巡航をやめる途中: 速さを v0 から通常速度まで、対数的に (毎秒同じ比率で) 落とす
    if (drive && this.cruiseExit) {
      const e = this.cruiseExit;
      e.t += dt;
      const vEnd = p.assistMaxSpeed;
      const k = Math.min(1, e.t / p.cruiseExitTime);
      const vNow = e.v0 * Math.pow(vEnd / e.v0, k);
      const v = b.vel.length();
      if (v > vNow) b.vel.multiplyScalar(vNow / v);
      scale = Math.max(1, Math.min(scale, vNow / vEnd));
      if (k >= 1) {
        this.cruise = false;
        this.cruiseExit = null;
        if (e.assistOff) this.flightAssist = false;
        drive = false;
        scale = 1;
      }
    }
    const rho = drive ? 0 : env.rho;
    const A = drive ? 0 : env.aero;

    // 着陸装置の出し入れ
    const gearDir = this.gearDown ? 1 : -1;
    this.gear = clamp(this.gear + (gearDir * dt) / p.gearTime, 0, 1);

    // --- 重力 ---
    this.gravityApplied.copy(drive ? ZERO : env.gravity);
    b.applyForce(_f.copy(this.gravityApplied).multiplyScalar(b.mass));
    _qi.copy(b.quat).invert();
    _gLocal.copy(this.gravityApplied).applyQuaternion(_qi);

    // --- 空気力 ---
    b.localVelocity(_vLocal);
    const aero = computeAero(_vLocal, b.angVel, rho, p.aero, this.gear * p.aero.gearDrag, this.aero);
    b.applyLocalForce(aero.force);
    b.applyLocalTorque(aero.torque);

    // 空力加熱
    const speed = _vLocal.length();
    const heatTarget = Math.sqrt(rho / SEA_LEVEL_DENSITY) * speed * speed * speed / p.heat.ref;
    this.heat += (heatTarget - this.heat) * (1 - Math.exp(-dt / p.heat.tau));
    if (this.heat > 1) this.hull -= (this.heat - 1) * p.heat.damageRate * dt;

    // --- 回転 ---
    // 機体座標での回転軸の向き: +X まわり = 機首上げ, +Y まわり = 機首左, +Z まわり = 左ロール
    const inX = c.pitch;
    const inY = -c.yaw;
    const inZ = -c.roll;
    const I = b.inertia;
    let tx, ty, tz;
    if (this.flightAssist) {
      // 指示した角速度に合わせる。空気が機首を振ろうとする力も打ち消す (向きを保つ)。
      // ただしスラスターの力には限りがあるので、高速では引ける迎角 (= G) に上限が生まれる
      const g = p.assistAngularGain;
      const lx = p.maxAngAccel.x * I.x, ly = p.maxAngAccel.y * I.y, lz = p.maxAngAccel.z * I.z;
      tx = clamp((inX * p.maxAngRate.x - b.angVel.x) * g * I.x - aero.torque.x, -lx, lx);
      ty = clamp((inY * p.maxAngRate.y - b.angVel.y) * g * I.y - aero.torque.y, -ly, ly);
      tz = clamp((inZ * p.maxAngRate.z - b.angVel.z) * g * I.z - aero.torque.z, -lz, lz);
    } else {
      tx = inX * p.maxAngAccel.x * I.x;
      ty = inY * p.maxAngAccel.y * I.y;
      tz = inZ * p.maxAngAccel.z * I.z;
    }
    b.applyLocalTorque(_t.set(tx, ty, tz));

    // --- 並進 ---
    const boost = c.boost > 0.5;
    const mainMax = p.mainAccel * (boost ? p.boostMultiplier : 1) * scale;
    let fx, fy, fz; // 機体座標の加速度。前進は -Z
    let fwdAcc;
    this.idle = false;
    if (this.flightAssist) {
      // 航空機としての操縦: スロットル = 推力
      const aFx = c.strafeX * p.strafeAccel;
      const aFy = c.strafeY * p.strafeAccel;
      const aFwd = c.throttle >= 0 ? c.throttle * mainMax : c.throttle * p.retroAccel;

      // ホバー / 宇宙の操縦: スロットル = 目標速度。重力も打ち消す
      const h = this.hover ? 1 : 1 - A;
      this.hoverAuthority = h;
      // 大気中のホバーと、着陸装置を出しているとき (大気のない天体への着陸) は、低速で細かく動かす
      const vtol = Math.max(this.hover ? A : 0, this.gear);
      const maxFwd = boost
        ? mix(p.assistBoostSpeed, p.vtolBoostSpeed, vtol)
        : mix(p.assistMaxSpeed, p.vtolSpeed, vtol);
      const fwdTarget = scale *
        (c.throttle >= 0 ? c.throttle * maxFwd : c.throttle * mix(p.assistReverseSpeed, p.vtolReverseSpeed, vtol));
      const strafeSpeed = mix(p.assistStrafeSpeed, p.vtolStrafeSpeed, vtol);
      let hFx = 0, hFy = 0, hFwd = 0;
      // 接地して何も指示していなければ、エンジンを絞って脚に重さを預ける
      this.idle = env.onGround && h > 0.5 && c.strafeY <= 0.05 &&
        Math.abs(c.strafeX) < 0.05 && Math.abs(fwdTarget) < 1;
      if (!this.idle && h > 0) {
        const g = p.assistLinearGain;
        // 高速からの減速と横滑りの打ち消しは、速度に見合った強さで行う
        // (巡航を切った直後に、通常の推力では止まれない速度が残るため)
        const strong = Math.max(scale, b.vel.length() / p.assistMaxSpeed);
        const lat = p.assistLateralAccel * strong;
        hFx = clamp((c.strafeX * strafeSpeed - _vLocal.x) * g - _gLocal.x, -lat, lat);
        // 着陸装置を出していると、地面の近くでは降下が自動で抑えられる
        // (高度 100m で毎秒 15m、20m 以下で毎秒 3m まで。安全な接地は毎秒 7m 以下)
        let vy = c.strafeY * strafeSpeed;
        if (this.gear > 0.5 && vy < 0 && env.altitude !== undefined) {
          vy = Math.max(vy, -Math.max(3, env.altitude * 0.15));
        }
        hFy = clamp((vy - _vLocal.y) * g - _gLocal.y, -lat, lat);
        // 前方向の速度は -vLocal.z、前方向の重力は -gLocal.z
        // 巡航中の減速は巡航ドライブが行う。速さに比例した強さで止められるので、
        // 地表へ向かって上限速度が急に下がっても遅れずに付いていける
        let brake = p.retroAccel * strong;
        let push = mainMax;
        if (drive) {
          brake = Math.max(brake, b.vel.length() / p.cruiseBrakeTime);
          // 加速も同じ: 天体から離れると上限速度が急に上がるので、それに付いていける強さにする
          push = Math.max(push, Math.abs(fwdTarget) / p.cruiseBrakeTime);
        }
        hFwd = clamp((fwdTarget - -_vLocal.z) * g + _gLocal.z, -brake, push);
      }
      fx = mix(aFx, hFx, h);
      fy = mix(aFy, hFy, h);
      fwdAcc = mix(aFwd, hFwd, h);
      this.liftLevel = clamp(Math.hypot(fx, fy) / p.assistLateralAccel, 0, 1);
    } else {
      this.hoverAuthority = 0;
      fx = c.strafeX * p.strafeAccel;
      fy = c.strafeY * p.strafeAccel;
      fwdAcc = c.throttle >= 0 ? c.throttle * mainMax : c.throttle * p.retroAccel;
      this.liftLevel = clamp(Math.hypot(fx, fy) / p.assistLateralAccel, 0, 1);
    }
    fz = -fwdAcc;
    this.thrustLevel = clamp(fwdAcc / (p.mainAccel * scale), 0, p.boostMultiplier) / p.boostMultiplier;
    this.boosting = boost && this.thrustLevel > 0.05;
    b.applyLocalForce(_f.set(fx, fy, fz).multiplyScalar(b.mass));
  }
}
