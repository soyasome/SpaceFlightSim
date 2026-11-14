import { Vector3, Quaternion } from 'three';
import { mulberry32 } from '../math/random.js';
import { leadPoint, angleBetween } from './targeting.js';

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

const _fwd = new Vector3();
const _up = new Vector3();
const _dir = new Vector3();
const _lead = new Vector3();
const _rel = new Vector3();
const _local = new Vector3();
const _v = new Vector3();
const _v2 = new Vector3();
const _qi = new Quaternion();

/**
 * 敵の操縦士。人間と同じ操縦入力 (ピッチ・ヨー・ロール・スロットル) を出すだけで、
 * 機体の動きそのものは自機と同じ飛行モデルが決める。
 *
 * world (まわりの世界を調べる手段):
 *   altitudeAt(pos) 地面からの高さ (宇宙では Infinity)
 *   upAt(pos, out)  真上の向き。宇宙では false を返す
 *   aeroAt(pos)     0..1 空気の濃さ (1 = 航空機として飛ぶ高度)
 *   rocks           小惑星 [{ pos, r }]
 */
export class Pilot {
  /**
   * @param skill 0..1 腕前 (狙いの正確さ、撃ち始める角度)
   * @param home 哨戒の中心 (フレーム座標)
   */
  constructor({ skill = 0.6, seed = 1, home = new Vector3(), patrolRadius = 3000, detectRange = 5000 } = {}) {
    this.skill = skill;
    this.detectRange = detectRange; // 哨戒中、この距離まで近づいた相手に気づく (m)
    this.rand = mulberry32(seed);
    this.home = home.clone();
    this.patrolRadius = patrolRadius;
    this.state = 'patrol'; // patrol | attack | break | evade
    this.timer = 0; // 今の状態の残り時間
    this.waypoint = home.clone();
    this.waypointTimer = 0;
    this.jink = new Vector3();
    this.jinkTimer = 0;
    this.aimError = new Vector3();
    this.aimTimer = 0;
    this.intPitch = 0; // 狙いの定常ずれを消すための積分
    this.intYaw = 0;
    this.wantGun = false;
    this.wantMissile = false;
    this.avoiding = false; // 地形や小惑星を避けている最中
  }

  _randomUnit(out) {
    const r = this.rand;
    out.set(r() * 2 - 1, r() * 2 - 1, r() * 2 - 1);
    if (out.lengthSq() < 1e-4) out.set(1, 0, 0);
    return out.normalize();
  }

  /** 機首に垂直な、でたらめな向き。 */
  _randomLateral(out) {
    this._randomUnit(out);
    out.addScaledVector(_fwd, -out.dot(_fwd));
    if (out.lengthSq() < 1e-4) out.set(_fwd.y, _fwd.z, _fwd.x).cross(_fwd);
    return out.normalize();
  }

  /**
   * 判断を1回行い、me.controls を書き換える。毎秒20回ほど呼ぶ。
   * @param me { ship, controls, underFire, missileThreat, alerted }
   * @param target 狙う相手 { alive, ship } または null
   */
  update(dt, me, target, world) {
    const ship = me.ship;
    const b = ship.body;
    const c = me.controls;
    const pos = b.pos;
    const speed = b.vel.length();
    _fwd.set(0, 0, -1).applyQuaternion(b.quat);
    const hasUp = world.upAt(pos, _up);
    const altitude = world.altitudeAt(pos);
    const aero = world.aeroAt(pos);
    const hasTarget = !!target && target.alive;

    this.timer -= dt;
    this.wantGun = false;
    this.wantMissile = false;
    let throttle = 0.6;
    let boost = false;
    let aiming = false;

    let dist = Infinity;
    if (hasTarget) dist = _rel.subVectors(target.ship.body.pos, pos).length();

    // --- 状態の切り替え ---
    if (!hasTarget) {
      this.state = 'patrol';
    } else if (this.state === 'patrol' && (dist < this.detectRange || me.alerted)) {
      this.state = 'attack';
    } else if ((this.state === 'break' || this.state === 'evade') && this.timer <= 0) {
      this.state = 'attack';
    }
    if (hasTarget && this.state === 'attack') {
      const tb = target.ship.body;
      // 相手がこちらを向いて後ろに付いている、または撃たれている → 回避
      const behind = _rel.dot(_fwd) < 0;
      _v.set(0, 0, -1).applyQuaternion(tb.quat);
      const aimedAt = -_rel.dot(_v) / Math.max(dist, 1) > 0.94;
      // 損傷が大きいほど回避に入りやすい
      const nervous = ship.hull < ship.hullMax * 0.4 ? 0.5 : 0.25;
      if (me.missileThreat || ((me.underFire > 0 || (behind && aimedAt && dist < 1500)) && this.rand() < nervous)) {
        this.state = 'evade';
        this.timer = 1.5 + this.rand() * 1.5;
        this.jinkTimer = 0;
      } else if (dist < 300 && _rel.dot(_v2.subVectors(b.vel, tb.vel)) > 0) {
        // 近すぎる: すれ違って距離を取り直す
        this.state = 'break';
        this.timer = 1.2 + this.rand() * 1.3;
        this._randomLateral(this.jink).multiplyScalar(0.7).add(_fwd).normalize();
      }
    }

    // --- 状態ごとの行き先 ---
    if (this.state === 'patrol') {
      this.waypointTimer -= dt;
      if (this.waypointTimer <= 0 || pos.distanceToSquared(this.waypoint) < 400 * 400) {
        this.waypointTimer = 25;
        this._randomUnit(_v).multiplyScalar(this.patrolRadius);
        this.waypoint.copy(this.home).add(_v);
        // 惑星の上では、哨戒の中心と同じ高さを保つ
        if (hasUp) this.waypoint.setLength(this.home.length());
      }
      _dir.subVectors(this.waypoint, pos).normalize();
      throttle = aero > 0.5 ? this._holdSpeed(speed, 260) : 0.5;
    } else if (this.state === 'attack') {
      const tb = target.ship.body;
      const w = ship.params.weapons;
      const t = leadPoint(pos, b.vel, tb.pos, tb.vel, w.gunSpeed, _lead);
      // 狙いのぶれ (腕前が低いほど大きい)
      this.aimTimer -= dt;
      if (this.aimTimer <= 0) {
        this.aimTimer = 0.4 + this.rand() * 0.4;
        this._randomUnit(this.aimError).multiplyScalar((1 - this.skill) * 0.02);
      }
      _dir.subVectors(_lead, pos).normalize();
      const off = angleBetween(_fwd, _dir);
      _dir.addScaledVector(this.aimError, 1).normalize();
      aiming = true;

      const fireCone = 0.02 + (1 - this.skill) * 0.03;
      if (t > 0 && dist < w.gunSpeed * w.gunLife * 0.85 && off < fireCone) this.wantGun = true;
      if (ship.missiles > 0 && dist > 900 && dist < w.lockRange * 0.9 && off < 0.25) this.wantMissile = true;

      // 速さは相手に合わせる: 相手の速度 (自分の機首方向の成分) に、距離に応じた詰める速さを足す。
      // 速いまま突っ込むと一瞬ですれ違い、曲がり切れずに何kmも離れてしまう
      const tFwd = tb.vel.dot(_fwd);
      const close = clamp((dist - 700) * 0.15, -80, 260);
      if (aero > 0.5) {
        // 大気中は失速しない速さ以上で
        const want = dist > 4000 ? 330 : clamp(tFwd + close, 150, 330);
        throttle = this._holdSpeed(speed, off > 0.6 ? Math.min(want, 220) : want);
      } else {
        // 宇宙ではスロットルが目標速度。遅いほど進路が早く曲がる (横滑りを打ち消す力に限りがあるため)
        const vmax = ship.params.assistMaxSpeed;
        let want = dist > 4000 ? vmax : clamp(tFwd + close, 110, vmax);
        // 的が正面にないときは、さらに速度を落として小さく回る
        if (off > 0.6) want = Math.min(want, 160);
        throttle = want / vmax;
        boost = dist > 8000 && off < 0.3;
      }
    } else if (this.state === 'break') {
      _dir.copy(this.jink);
      // 全速で離れず、横へ逃げながら回り込む (遠くへ行くと、また正面からの撃ち合いになる)
      throttle = aero > 0.5 ? this._holdSpeed(speed, 230) : 0.45;
    } else if (this.state === 'evade') {
      this.jinkTimer -= dt;
      if (this.jinkTimer <= 0) {
        this.jinkTimer = 0.5 + this.rand() * 0.5;
        this._randomLateral(this.jink).multiplyScalar(1.3).add(_fwd).normalize();
      }
      _dir.copy(this.jink);
      // 振り切るのはミサイルのときだけ。弾を避けるだけなら速さより向きの変化で
      if (me.missileThreat) {
        throttle = 1;
        boost = aero < 0.5;
      } else {
        throttle = aero > 0.5 ? this._holdSpeed(speed, 280) : 0.65;
      }
    }

    // --- 何よりも優先: ぶつからない ---
    this.avoiding = false;
    if (hasUp && Number.isFinite(altitude)) {
      const vs = b.vel.dot(_up);
      const down = -_dir.dot(_up);
      // 低いほど、下へ向かう行き先を許さない
      const maxDown = clamp((altitude - 400) / 2000, -0.25, 0.8);
      if (down > maxDown) _dir.addScaledVector(_up, down - maxDown).normalize();
      // 引き起こしに必要な高さ: 速いほど、降下が急なほど大きい (約6G で回る円弧の落差)
      const sink = speed > 1 ? clamp(-vs / speed, 0, 1) : 0;
      // 曲がりにくい機体ほど余裕を大きく取る
      const agility = 60 * (ship.params.maxAngAccel.x / 4.5);
      const pullout = aero > 0.3
        ? (speed * speed / agility) * (1 - Math.sqrt(1 - sink * sink)) * 1.4 + 250
        : 0;
      // 進む先の高さも調べる (前方で地面がせり上がっている場合に備える)。
      // 速くて曲がりにくいほど、遠くまで見る
      const lookTime = clamp((1.2 * speed) / agility, 3, 12);
      const ahead = Math.min(
        world.altitudeAt(_v.copy(pos).addScaledVector(b.vel, lookTime)),
        world.altitudeAt(_v.copy(pos).addScaledVector(b.vel, lookTime * 0.5)));
      if (altitude < 300 || ahead < 250 || (vs < 0 && (altitude < -vs * 7 || altitude < pullout))) {
        // このままだと地面に当たる: 水平に進みながら上を向く
        _v.copy(b.vel).addScaledVector(_up, -vs);
        if (_v.lengthSq() < 1) _v.copy(_fwd).addScaledVector(_up, -_fwd.dot(_up));
        _dir.copy(_v.normalize()).addScaledVector(_up, altitude < 150 ? 1.5 : 0.8).normalize();
        // 大気中で速すぎるときは、絞った方が小さく回れる
        throttle = aero > 0.5 && speed > 320 ? 0.1 : 1;
        this.avoiding = true;
      }
      // 大気中では失速しない速度を保つ
      if (aero > 0.5 && speed < 110) throttle = 1;
    }
    if (world.rocks.length && speed > 5) {
      const look = speed * 3;
      let nearest = Infinity;
      _v.copy(b.vel).divideScalar(speed);
      for (const rock of world.rocks) {
        _v2.subVectors(rock.pos, pos);
        const along = _v2.dot(_v);
        const reach = rock.r + 60;
        if (along < -reach || along > look + reach || along > nearest) continue;
        const perp2 = _v2.lengthSq() - along * along;
        if (perp2 > reach * reach) continue;
        nearest = along;
        // 岩の中心から遠ざかる横方向へ逃げる
        _local.copy(_v2).addScaledVector(_v, -along).negate();
        if (_local.lengthSq() < 1) this._randomLateral(_local);
        _dir.copy(_v).multiplyScalar(0.4).add(_local.normalize()).normalize();
        this.avoiding = true;
      }
    }
    if (this.avoiding) {
      this.wantGun = false;
      aiming = false;
    }

    // --- 行き先 → 操縦入力 ---
    _qi.copy(b.quat).invert();
    _local.copy(_dir).applyQuaternion(_qi); // 機体座標: 右 +X, 上 +Y, 前 -Z
    const off = Math.atan2(Math.hypot(_local.x, _local.y), -_local.z);
    const pitchErr = Math.atan2(_local.y, Math.hypot(_local.x, _local.z)) * (_local.z > 0 ? 1.5 : 1);
    const yawErr = Math.atan2(_local.x, -_local.z);

    // 狙っているときだけ積分を効かせ、動く的への追従遅れを消す
    if (aiming && off < 0.3) {
      this.intPitch = clamp(this.intPitch + pitchErr * dt * 5, -0.4, 0.4);
      this.intYaw = clamp(this.intYaw + yawErr * dt * 5, -0.4, 0.4);
    } else {
      this.intPitch *= 0.8;
      this.intYaw *= 0.8;
    }
    c.pitch = clamp(pitchErr * 3 + this.intPitch, -1, 1);
    c.yaw = clamp(yawErr * 2.5 + this.intYaw, -1, 1);

    // ロール: 大きく向きを変えるときは、行き先が機体の真上に来るよう傾けてから引く
    if (off > 0.35) {
      const rollErr = Math.atan2(_local.x, _local.y);
      c.roll = clamp(rollErr * 2, -1, 1);
      // 傾きが合うほど強く引く (行き先が真後ろでも、宙返りで向き直れる)
      c.pitch = clamp(off * 3, 0, 1) * Math.max(0, Math.cos(rollErr));
      c.yaw = clamp(_local.x * 1.5, -1, 1) * 0.4;
    } else if (hasUp && aero > 0.5) {
      // 大気中でほぼ正面に捉えているときは翼を水平に戻す
      _v.set(1, 0, 0).applyQuaternion(b.quat);
      _v2.set(0, 1, 0).applyQuaternion(b.quat);
      const bank = Math.atan2(-_v.dot(_up), _v2.dot(_up)); // 右翼が下がっていると正
      c.roll = clamp(-bank * 1.5, -1, 1);
    } else {
      c.roll = 0;
    }

    c.throttle = throttle;
    c.boost = boost ? 1 : 0;
    c.strafeX = 0;
    c.strafeY = 0;
  }

  /** 大気中ではスロットルが推力なので、速度を見て加減する。 */
  _holdSpeed(speed, want) {
    return clamp(0.3 + (want - speed) / 120, 0, 1);
  }
}
