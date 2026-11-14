import { Vector3, Quaternion } from 'three';

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

// 接地点 (機体座標)。脚は主脚2本と前脚1本。
const GEAR_DOWN_Y = -2.2; // 脚を出したときの車輪の下端
const GEAR_UP_Y = -0.6;
const GEAR_POINTS = [
  new Vector3(0, GEAR_DOWN_Y, -3.2),
  new Vector3(2.2, GEAR_DOWN_Y, 1.8),
  new Vector3(-2.2, GEAR_DOWN_Y, 1.8),
];
// 機体そのものが地面に当たる点 (腹・翼端・機首・背中)
const HULL_POINTS = [
  new Vector3(0, -0.7, -4.5),
  new Vector3(0, -0.7, 4.5),
  new Vector3(5.4, -0.3, 3.6),
  new Vector3(-5.4, -0.3, 3.6),
  new Vector3(0, 0, -6.5),
  new Vector3(0, 1.3, 1.5),
];

export const GEAR = {
  stiffness: 157e3, // N/m (1本あたり。静止時に約0.25m沈む)
  damping: 38e3, // N·s/m
  travel: 0.7, // これ以上沈むと底突きして機体並みに硬くなる
  rollFriction: 0.02,
  brakeFriction: 0.7,
  sideFriction: 0.9,
  safeSpeed: 7, // これより速い接地は損傷 (m/s)
  damageK: 1.2,
};
export const HULL = {
  stiffness: 2e6,
  damping: 1.5e5,
  friction: 0.6,
  safeSpeed: 2.5,
  damageK: 2.0,
  scrapeK: 0.15, // 擦りながら滑ったときの損傷 (1m あたり)
};
// 低速での摩擦を滑らかにする係数 (N·s/m)。大きいほどよく止まるが、
// 大きすぎると1ステップで速度が行き過ぎて振動する (上限の目安は 1.6e5)
const VISCOUS = 1e5;
const MIN_CLEARANCE = 0.45; // 機体の中心がこれより地面に近づいたら強制的に押し戻す
const SAMPLE = 2.0; // 地面の傾きを測る間隔 (m)

const _up = new Vector3();
const _t1 = new Vector3();
const _t2 = new Vector3();
const _p0 = new Vector3();
const _p1 = new Vector3();
const _p2 = new Vector3();
const _n = new Vector3();
const _r = new Vector3();
const _rw = new Vector3();
const _v = new Vector3();
const _vt = new Vector3();
const _f = new Vector3();
const _fwd = new Vector3();
const _side = new Vector3();
const _w = new Vector3();
const _qi = new Quaternion();
const _pt = new Vector3();

/**
 * 地面との接触。脚と機体の各点を「ばね + ダンパー + 摩擦」で地面に押し返す。
 * 機体は惑星ローカル座標 (地面が静止している座標) にあること。
 * 地面は、機体の真下とその近く2点から求めた平面で近似する。
 */
export class GroundContact {
  constructor() {
    this.normal = new Vector3(0, 1, 0);
    this.prev = new Array(GEAR_POINTS.length + HULL_POINTS.length).fill(false);
    this.reset();
  }

  reset() {
    this.contacts = 0; // 接している点の数
    this.gearContacts = 0; // 接している脚の数
    this.hullContacts = 0;
    this.damage = 0; // このステップで受けた損傷
    this.impactSpeed = 0; // このステップで新たに接地した点の、地面へ向かう速さ
    this.slideSpeed = 0; // 地面に沿って動いている速さ
    this.load = 0; // 地面から受けている力の合計 (N)
  }

  /**
   * @param body 剛体 (力とトルクが積算される)
   * @param planet groundRadiusAt(local) を持つもの
   * @param gear 脚の出具合 0..1
   * @param brake ブレーキをかけているか
   */
  apply(body, planet, gear, brake, dt) {
    this.reset();
    const r = body.pos.length();
    _up.copy(body.pos).divideScalar(r);
    const g0 = planet.groundRadiusAt(body.pos);
    const alt = r - g0;
    if (alt > 30) {
      this.prev.fill(false);
      return this;
    }

    // --- 地面の平面 ---
    _t1.set(0, 1, 0);
    if (Math.abs(_up.y) > 0.9) _t1.set(1, 0, 0);
    _t1.cross(_up).normalize();
    _t2.crossVectors(_up, _t1);
    _p0.copy(_up).multiplyScalar(g0);
    _p1.copy(body.pos).addScaledVector(_t1, SAMPLE);
    _p1.multiplyScalar(planet.groundRadiusAt(_p1) / _p1.length());
    _p2.copy(body.pos).addScaledVector(_t2, SAMPLE);
    _p2.multiplyScalar(planet.groundRadiusAt(_p2) / _p2.length());
    _n.crossVectors(_p1.sub(_p0), _p2.sub(_p0)).normalize();
    if (_n.dot(_up) < 0) _n.negate();
    this.normal.copy(_n);

    _qi.copy(body.quat).invert();
    // 車輪の転がる向き: 機首方向を地面に沿わせたもの
    _fwd.set(0, 0, -1).applyQuaternion(body.quat);
    _fwd.addScaledVector(_n, -_fwd.dot(_n));
    const hasFwd = _fwd.lengthSq() > 1e-4;
    if (hasFwd) _fwd.normalize();
    _side.crossVectors(_n, _fwd);

    const gearActive = gear > 0.3;
    const total = GEAR_POINTS.length + HULL_POINTS.length;
    for (let i = 0; i < total; i++) {
      const isGear = i < GEAR_POINTS.length;
      if (isGear) {
        if (!gearActive) { this.prev[i] = false; continue; }
        _pt.copy(GEAR_POINTS[i]);
        _pt.y = GEAR_UP_Y + (GEAR_DOWN_Y - GEAR_UP_Y) * gear;
      } else {
        _pt.copy(HULL_POINTS[i - GEAR_POINTS.length]);
      }
      _rw.copy(_pt).applyQuaternion(body.quat);
      const depth = -_r.copy(body.pos).add(_rw).sub(_p0).dot(_n);
      if (depth <= 0) { this.prev[i] = false; continue; }

      // 接地点の速度 = 重心の速度 + 回転による速度
      _v.crossVectors(body.angVel, _pt).applyQuaternion(body.quat).add(body.vel);
      const vn = _v.dot(_n);
      if (!this.prev[i]) {
        const s = -vn;
        if (s > this.impactSpeed) this.impactSpeed = s;
        const lim = isGear ? GEAR : HULL;
        if (s > lim.safeSpeed) this.damage += (s - lim.safeSpeed) ** 2 * lim.damageK;
      }
      this.prev[i] = true;

      let N;
      if (isGear) {
        N = GEAR.stiffness * Math.min(depth, GEAR.travel) - GEAR.damping * vn;
        if (depth > GEAR.travel) N += HULL.stiffness * (depth - GEAR.travel);
      } else {
        N = HULL.stiffness * depth - HULL.damping * vn;
      }
      if (N < 0) N = 0;

      _vt.copy(_v).addScaledVector(_n, -vn);
      const vt = _vt.length();
      _f.copy(_n).multiplyScalar(N);
      if (isGear && hasFwd) {
        const vf = _vt.dot(_fwd), vs = _vt.dot(_side);
        const muF = (brake ? GEAR.brakeFriction : GEAR.rollFriction) * N;
        const muS = GEAR.sideFriction * N;
        _f.addScaledVector(_fwd, -clamp(VISCOUS * vf, -muF, muF));
        _f.addScaledVector(_side, -clamp(VISCOUS * vs, -muS, muS));
      } else if (vt > 1e-6) {
        const mu = (isGear ? GEAR.sideFriction : HULL.friction) * N;
        _f.addScaledVector(_vt, -Math.min(VISCOUS * vt, mu) / vt);
      }
      if (!isGear && vt > 3) this.damage += HULL.scrapeK * vt * dt;

      body.applyForce(_f);
      // トルクは機体座標で: r × F
      _w.copy(_f).applyQuaternion(_qi);
      body.applyLocalTorque(_r.crossVectors(_pt, _w));

      this.contacts++;
      if (isGear) this.gearContacts++;
      else this.hullContacts++;
      this.load += N;
      if (vt > this.slideSpeed) this.slideSpeed = vt;
    }

    // 高速で突っ込んで地面をすり抜けないための最後の砦
    if (alt < MIN_CLEARANCE) {
      const vn = body.vel.dot(_up);
      if (vn < 0) {
        if (-vn > HULL.safeSpeed) this.damage += (-vn - HULL.safeSpeed) ** 2 * HULL.damageK;
        if (-vn > this.impactSpeed) this.impactSpeed = -vn;
        body.vel.addScaledVector(_up, -vn);
      }
      body.pos.copy(_up).multiplyScalar(g0 + MIN_CLEARANCE);
      this.contacts = Math.max(this.contacts, 1);
    }
    return this;
  }
}
