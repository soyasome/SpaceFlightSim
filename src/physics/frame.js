import { Quaternion, Vector3 } from 'three';

const _qInv = new Quaternion();
const _spin = new Vector3();

// 回転している惑星の座標系 (惑星ローカル座標) と世界座標の間で、剛体の状態を変換する。
// 惑星は { pos, quat, omega } を持ち、ローカルの Y 軸まわりに角速度 omega で自転している。
//
// 注: 惑星ローカル座標の中では遠心力とコリオリ力を省いている。自転が遅い (周期2時間) ので
// 影響は小さく、省くことで「地表に対して止まる」操作が素直になる。

/** ω × r (ω = ローカルY軸まわり omega) */
function spinVelocity(omega, r, out) {
  return out.set(omega * r.z, 0, -omega * r.x);
}

/** 世界座標の状態を惑星ローカル座標に変換する。 */
export function enterFrame(body, planet) {
  _qInv.copy(planet.quat).invert();
  body.pos.sub(planet.pos).applyQuaternion(_qInv);
  body.vel.applyQuaternion(_qInv).sub(spinVelocity(planet.omega, body.pos, _spin));
  body.quat.premultiply(_qInv).normalize();
  body.prevPos.copy(body.pos);
  body.prevQuat.copy(body.quat);
}

/** 惑星ローカル座標の状態を世界座標に戻す。 */
export function leaveFrame(body, planet) {
  body.vel.add(spinVelocity(planet.omega, body.pos, _spin)).applyQuaternion(planet.quat);
  body.pos.applyQuaternion(planet.quat).add(planet.pos);
  body.quat.premultiply(planet.quat).normalize();
  body.prevPos.copy(body.pos);
  body.prevQuat.copy(body.quat);
}
