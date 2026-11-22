import { Quaternion, Vector3 } from 'three';

const _qInv = new Quaternion();
const _spin = new Vector3();

// 回転している惑星の座標系 (惑星ローカル座標) と世界座標の間で、剛体の状態を変換する。
// 惑星は { pos, quat, omega } を持ち、ローカルの Y 軸まわりに角速度 omega で自転している。
//
// 注: ゲーム用の大きさの惑星では、惑星ローカル座標の中で遠心力とコリオリ力を省いている。
// 惑星が小さく自転のずれも小さいので、省くことで「地表に対して止まる」操作が素直になる。
// 実寸の惑星 (def.fictitious) では、座標系に入る所 (半径の 6 倍) で木星の遠心力が重力の約 20 倍になり、
// 省くと世界から見てありえない曲がり方をするので、fictitiousAccel で足す (docs/design-real-scale.md の 4.2)。

/** ω × r (ω = ローカルY軸まわり omega) */
function spinVelocity(omega, r, out) {
  return out.set(omega * r.z, 0, -omega * r.x);
}

/**
 * 回る座標系 (ローカルY軸まわりに角速度 omega) での見かけの加速度を out に足す。
 *   遠心力 −ω × (ω × r) = ω² (x, 0, z)、コリオリ力 −2 ω × v = 2ω (−vz, 0, vx)
 * vel を省くと遠心力だけを足す。
 */
export function fictitiousAccel(omega, pos, vel, out) {
  const w2 = omega * omega;
  out.x += w2 * pos.x;
  out.z += w2 * pos.z;
  if (vel) {
    out.x -= 2 * omega * vel.z;
    out.z += 2 * omega * vel.x;
  }
  return out;
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
