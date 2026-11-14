import { Vector3 } from 'three';

const _rel = new Vector3();
const _rv = new Vector3();
const _d = new Vector3();
const _m = new Vector3();

/**
 * 見越し点: 今撃った弾が的に当たる位置を求める。
 * 弾は射手の速度に弾速を上乗せして飛ぶので、射手から見た相対運動で解く。
 *   |相対位置 + 相対速度·t| = 弾速·t  を満たす最小の t > 0
 * @returns 命中までの時間 (秒)。当てられないときは -1。out に命中位置が入る
 */
export function leadPoint(shooterPos, shooterVel, targetPos, targetVel, projSpeed, out) {
  _rel.subVectors(targetPos, shooterPos);
  _rv.subVectors(targetVel, shooterVel);
  const a = _rv.lengthSq() - projSpeed * projSpeed;
  const b = 2 * _rel.dot(_rv);
  const c = _rel.lengthSq();
  let t = -1;
  if (Math.abs(a) < 1e-9) {
    if (b < 0) t = -c / b;
  } else {
    const disc = b * b - 4 * a * c;
    if (disc >= 0) {
      const s = Math.sqrt(disc);
      const t1 = (-b - s) / (2 * a), t2 = (-b + s) / (2 * a);
      const lo = Math.min(t1, t2), hi = Math.max(t1, t2);
      t = lo > 0 ? lo : hi > 0 ? hi : -1;
    }
  }
  if (t < 0) {
    out.copy(targetPos);
    return -1;
  }
  // 弾は射手の速度も持っているので、世界での命中位置は 的の位置 + 的の速度·t
  out.copy(targetPos).addScaledVector(targetVel, t);
  return t;
}

/**
 * 線分 p0→p1 と球の交差。高速の弾が1ステップで的を飛び越えても見逃さないために使う。
 * @returns 線分上の位置 0..1。当たらなければ -1
 */
export function segmentSphere(p0, p1, center, radius) {
  _d.subVectors(p1, p0);
  _m.subVectors(p0, center);
  const c = _m.lengthSq() - radius * radius;
  if (c <= 0) return 0; // 始点がすでに球の中
  const a = _d.lengthSq();
  if (a < 1e-12) return -1;
  const b = _m.dot(_d);
  if (b > 0) return -1; // 遠ざかっている
  const disc = b * b - a * c;
  if (disc < 0) return -1;
  const t = (-b - Math.sqrt(disc)) / a;
  return t <= 1 ? t : -1;
}

/** 2つの単位ベクトルのなす角 (rad)。 */
export function angleBetween(a, b) {
  return Math.acos(Math.min(1, Math.max(-1, a.dot(b))));
}
