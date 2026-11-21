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
// 機体の中心が真下の地面からこれより高ければ、どの点も地面に届かないとみなす。
// 崖の壁は真下の地面よりずっと高くそびえるので、地形の最大の段差より大きくしておく
const REACH_ALT = 4000;
const DEEP = 2; // 真下の地面からこれより深くめり込んだ点は、壁を抜けたものとして扱う (m)
// ばねの力を計算するときのめり込みの上限 (m)。高速で突っ込んだときに、
// 一瞬で何百 m も弾き飛ばされないようにする (止めるのは MIN_CLEARANCE の押し戻しの役目)
const MAX_DEPTH = 2;
const MAX_POINT_ACCEL = 400; // 1点が機体に与える力の上限 (機体の質量 × この加速度, m/s²)

const _t1 = new Vector3();
const _t2 = new Vector3();
const _p0 = new Vector3();
const _p1 = new Vector3();
const _p2 = new Vector3();
const _upQ = new Vector3();
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
const _pw = new Vector3();
const _upP = new Vector3();
const _np = new Vector3();
const _nv = new Vector3();

/** 点 q を、その真下の地面の上へ下ろす (q を書き換える)。 */
function dropToGround(frame, q) {
  const h = frame.heightAbove(q);
  return q.addScaledVector(frame.upAt(q, _upQ), -h);
}

/**
 * 点 p の真下の地面の法線を out に入れる。h: p の地面からの高さ (呼び出し側で求めたもの)。
 * p のまわり SAMPLE (m) の2点との高さの差から求める。
 * _upP に p での真上の向き、_p0 に p の真下の地面の点が残る (呼び出し側が使う)。
 */
function groundNormal(frame, p, h, out) {
  frame.upAt(p, _upP);
  _t1.set(0, 1, 0);
  if (Math.abs(_upP.y) > 0.9) _t1.set(1, 0, 0);
  _t1.cross(_upP).normalize();
  _t2.crossVectors(_upP, _t1);
  _p0.copy(p).addScaledVector(_upP, -h);
  dropToGround(frame, _p1.copy(_p0).addScaledVector(_t1, SAMPLE));
  dropToGround(frame, _p2.copy(_p0).addScaledVector(_t2, SAMPLE));
  out.crossVectors(_p1.sub(_p0), _p2.sub(_p0)).normalize();
  if (out.dot(_upP) < 0) out.negate();
  return out;
}

/**
 * 地面との接触。脚と機体の各点を「ばね + ダンパー + 摩擦」で地面に押し返す。
 * 機体は座標系 (地面が静止している座標) のローカル座標にあること。
 * 地面は座標系の upAt (真上の向き) と heightAbove (地面からの高さ) だけで調べるので、
 * 球の惑星でも、下の向きが違う座標系 (円筒の内側など) でも同じ処理で済む。
 * 地面は点ごとに、その点の真下とその近く2点から求めた平面で近似する。
 * (崖の壁に機首から突っ込んだときも、壁に当たった点が壁から押し返される)
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
   * @param frame upAt(p, out) と heightAbove(p) を持つ座標系 (Planet など)
   * @param gear 脚の出具合 0..1
   * @param brake ブレーキをかけているか
   */
  apply(body, frame, gear, brake, dt) {
    this.reset();
    const alt = frame.heightAbove(body.pos);
    if (alt > REACH_ALT) {
      this.prev.fill(false);
      return this;
    }
    // 機体の真下の地面の向き (静止摩擦の判定などに使う)
    groundNormal(frame, body.pos, alt, this.normal);

    _qi.copy(body.quat).invert();
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
      // この点の真下の地面より下にあるか
      _pw.copy(body.pos).add(_rw);
      const hp = frame.heightAbove(_pw);
      if (hp >= 0) { this.prev[i] = false; continue; }
      let depth;
      if (-hp > DEEP && alt > 0) {
        // 深くめり込んだ (崖の壁を抜けて、台地の下に入った)。真下の地面 (台地の上面) を基準にすると
        // 上へ大きく弾き出されてしまうので、機体の中心からこの点へ向かう線が地面を横切る所を探し、
        // そこの面 (= 壁) を基準にする
        let lo = 0, hi = 1;
        for (let k = 0; k < 10; k++) {
          const mid = (lo + hi) / 2;
          _np.copy(body.pos).addScaledVector(_rw, mid);
          if (frame.heightAbove(_np) < 0) hi = mid;
          else lo = mid;
        }
        _np.copy(body.pos).addScaledVector(_rw, hi);
        groundNormal(frame, _np, frame.heightAbove(_np), _n);
        depth = _r.copy(_p0).sub(_pw).dot(_n); // _p0: 横切った所の真下の地面の点
      } else {
        // 地面を、この点の真下の接平面で近似する。めり込みはその平面までの距離
        groundNormal(frame, _pw, hp, _n);
        depth = -hp * _n.dot(_upP);
      }
      if (depth <= 0) { this.prev[i] = false; continue; }
      depth = Math.min(depth, MAX_DEPTH);

      // 車輪の転がる向き: 機首方向を地面に沿わせたもの
      _fwd.set(0, 0, -1).applyQuaternion(body.quat);
      _fwd.addScaledVector(_n, -_fwd.dot(_n));
      const hasFwd = _fwd.lengthSq() > 1e-4;
      if (hasFwd) _fwd.normalize();
      _side.crossVectors(_n, _fwd);

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
      // 高速で壁に当たったとき、ダンパーの力で機体が弾き飛ばされないよう上限を設ける
      // (それ以上の減速は MIN_CLEARANCE の押し戻しが受け持つ)
      N = Math.min(N, body.mass * MAX_POINT_ACCEL);

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

    // 高速で突っ込んで地面をすり抜けないための最後の砦。
    // 真上ではなく地面の法線の向きに押し出す (崖の壁にめり込んだら、崖の上ではなく壁の外へ出す)
    if (alt < MIN_CLEARANCE) {
      _n.copy(this.normal);
      let h = alt; // 機体の中心の、地面からの高さ
      const prev = body.prevPos;
      if (-alt > DEEP && prev.distanceToSquared(body.pos) < 400 * 400 && frame.heightAbove(prev) > 0) {
        // 1ステップで壁の奥まで入った。前のステップの位置からの経路が地面を横切る所を探し、
        // そこから壁の外へ出す (真下の地面を基準にすると崖の上へ持ち上がってしまう)
        let lo = 0, hi = 1;
        for (let k = 0; k < 12; k++) {
          const mid = (lo + hi) / 2;
          _np.copy(prev).lerp(body.pos, mid);
          if (frame.heightAbove(_np) < 0) hi = mid;
          else lo = mid;
        }
        _np.copy(prev).lerp(body.pos, hi);
        groundNormal(frame, _np, frame.heightAbove(_np), _n);
        body.pos.copy(prev).lerp(body.pos, lo).addScaledVector(_n, MIN_CLEARANCE);
        h = frame.heightAbove(body.pos);
      }
      _nv.copy(_n); // 速度を消す向き: 最初に押し出した面の法線
      for (let k = 0; k < 4; k++) {
        frame.upAt(body.pos, _upP);
        const need = (MIN_CLEARANCE - h) * _n.dot(_upP); // 接平面から MIN_CLEARANCE 離すのに要る距離
        if (need <= 1e-3) break;
        body.pos.addScaledVector(_n, need + 1e-3);
        h = frame.heightAbove(body.pos);
        groundNormal(frame, body.pos, h, _n);
      }
      // まだ地面の下なら (ありえない形の地面)、真上へ戻す
      if (h < MIN_CLEARANCE * 0.5) {
        frame.upAt(body.pos, _nv);
        body.pos.addScaledVector(_nv, MIN_CLEARANCE - h);
      }
      const vn = body.vel.dot(_nv);
      if (vn < 0) {
        if (-vn > HULL.safeSpeed) this.damage += (-vn - HULL.safeSpeed) ** 2 * HULL.damageK;
        if (-vn > this.impactSpeed) this.impactSpeed = -vn;
        body.vel.addScaledVector(_nv, -vn);
        // 摩擦の力積: 面に沿った速度も、ぶつかった勢いに比例して削る
        // (なければ、急な斜面に高速で当たったとき斜面に沿って上へ跳ね上がる)
        _vt.copy(body.vel).addScaledVector(_nv, -body.vel.dot(_nv));
        const vt = _vt.length();
        if (vt > 1e-6) body.vel.addScaledVector(_vt, -Math.min(1, (HULL.friction * -vn) / vt));
      }
      this.contacts = Math.max(this.contacts, 1);
    }
    return this;
  }
}
