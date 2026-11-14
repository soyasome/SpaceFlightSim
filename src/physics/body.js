import { Vector3, Quaternion } from 'three';

// 注: THREE.Vector3 / Quaternion の成分は JS の Number (float64) なので、
// 物理の座標はそのまま倍精度で扱える。float32 になるのは GPU に送る瞬間だけで、
// その前にカメラ位置を引く (Floating Origin) ことで精度を保つ。

const _v = new Vector3();
const _dq = new Quaternion();

/**
 * 6自由度の剛体。
 * - 位置・速度は世界座標 (m, m/s)
 * - 角速度・トルクは機体座標 (rad/s, N·m)
 * - 機体座標の向き: 前 = -Z, 上 = +Y, 右 = +X
 */
export class RigidBody {
  constructor({ mass = 1, inertia = new Vector3(1, 1, 1) } = {}) {
    this.mass = mass;
    this.inertia = inertia.clone(); // 主慣性モーメント (対角成分のみ)

    this.pos = new Vector3();
    this.vel = new Vector3();
    this.quat = new Quaternion();
    this.angVel = new Vector3();

    this.force = new Vector3(); // 世界座標で積算
    this.torque = new Vector3(); // 機体座標で積算

    // 描画補間用に1ステップ前の状態を持つ
    this.prevPos = new Vector3();
    this.prevQuat = new Quaternion();
  }

  applyForce(fWorld) {
    this.force.add(fWorld);
  }

  applyLocalForce(fLocal) {
    this.force.add(_v.copy(fLocal).applyQuaternion(this.quat));
  }

  applyLocalTorque(tLocal) {
    this.torque.add(tLocal);
  }

  /** 世界速度を機体座標に直す。 */
  localVelocity(out) {
    return out.copy(this.vel).applyQuaternion(_dq.copy(this.quat).invert());
  }

  /** 補間なしで瞬間移動する (デバッグ・ワープ用)。 */
  teleport(pos) {
    this.pos.copy(pos);
    this.prevPos.copy(pos);
  }

  /** 半陰的オイラー法で dt 秒進める。積算した力とトルクは消費される。 */
  integrate(dt) {
    this.prevPos.copy(this.pos);
    this.prevQuat.copy(this.quat);

    // 並進
    this.vel.addScaledVector(this.force, dt / this.mass);
    this.pos.addScaledVector(this.vel, dt);

    // 回転。ジャイロ項 (ω × Iω) は操縦系が常に角速度を制御するため省略している。
    this.angVel.x += (this.torque.x / this.inertia.x) * dt;
    this.angVel.y += (this.torque.y / this.inertia.y) * dt;
    this.angVel.z += (this.torque.z / this.inertia.z) * dt;

    const w = this.angVel.length();
    if (w > 1e-12) {
      _dq.setFromAxisAngle(_v.copy(this.angVel).divideScalar(w), w * dt);
      this.quat.multiply(_dq).normalize(); // 機体座標の回転なので右から掛ける
    }

    this.force.set(0, 0, 0);
    this.torque.set(0, 0, 0);
  }

  /** 物理ステップ間を補間した描画用の姿勢を得る (alpha: 0..1)。 */
  getInterpolated(alpha, outPos, outQuat) {
    outPos.lerpVectors(this.prevPos, this.pos, alpha);
    outQuat.slerpQuaternions(this.prevQuat, this.quat, alpha);
  }
}
