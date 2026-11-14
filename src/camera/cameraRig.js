import { Vector3, Quaternion, Euler } from 'three';

const SEAT = new Vector3(0, 0.62, -2.1); // 操縦席の目の位置 (機体座標)
const CHASE = new Vector3(0, 3.6, 16); // 追従視点の基準位置 (機体座標)

const _look = new Quaternion();
const _target = new Quaternion();
const _euler = new Euler(0, 0, 0, 'YXZ');
const _acc = new Vector3();
const _v = new Vector3();

/**
 * カメラの世界座標 (倍精度) と向きを決める。
 * 描画では常にカメラを原点に置くので、ここで求めた位置は「引き算の基準」として使われる。
 */
export class CameraRig {
  constructor(settings) {
    this.settings = settings;
    this.mode = 'chase'; // 'cockpit' | 'chase'
    this.pos = new Vector3(); // 世界座標
    this.quat = new Quaternion();
    this.fov = 62;
    this._lag = new Vector3();
    this._prevVel = new Vector3();
    this._snap = true;
  }

  /** 座標系が切り替わったとき、保持している向きと速度を新しい座標系に合わせる。 */
  reframe(q, newVel) {
    this.quat.premultiply(q);
    this._lag.applyQuaternion(q);
    this._prevVel.copy(newVel);
  }

  toggle() {
    this.mode = this.mode === 'cockpit' ? 'chase' : 'cockpit';
    this._snap = true;
  }

  /**
   * @param dt 描画フレームの経過秒
   * @param shipPos,shipQuat 補間済みの機体姿勢
   * @param shipVel 機体の世界速度
   * @param look {yaw, pitch} 見回し角
   * @param boost 0..1 ブーストの強さ (画角を広げる)
   */
  update(dt, shipPos, shipQuat, shipVel, look, boost) {
    _look.setFromEuler(_euler.set(look.pitch, look.yaw, 0));
    _target.copy(shipQuat).multiply(_look);

    if (this.mode === 'cockpit') {
      this.quat.copy(_target);
      this.pos.copy(SEAT).applyQuaternion(shipQuat).add(shipPos);
      this._lag.set(0, 0, 0);
    } else {
      // 向きは少し遅れて追う。機体が先に回り、カメラが後から付いてくる
      if (this._snap) this.quat.copy(_target);
      else this.quat.slerp(_target, 1 - Math.exp(-dt * 6.5));

      // 加速すると機体が前へ出る (カメラが置いていかれる) ように位置をずらす
      if (dt > 0) {
        _acc.subVectors(shipVel, this._prevVel).divideScalar(dt);
        if (this._snap) _acc.set(0, 0, 0);
        _v.copy(_acc).multiplyScalar(-0.035).clampLength(0, 5);
        this._lag.lerp(_v, 1 - Math.exp(-dt * 4));
      }
      this.pos.copy(CHASE).multiplyScalar(this.settings.chaseDistance)
        .applyQuaternion(this.quat).add(shipPos).add(this._lag);
    }
    this._prevVel.copy(shipVel);
    this._snap = false;

    // 設定の画角はコックピット視点の値。追従視点は少し狭くする
    const base = this.settings.fov - (this.mode === 'cockpit' ? 0 : 10);
    const targetFov = base + boost * 14;
    this.fov += (targetFov - this.fov) * (1 - Math.exp(-dt * 3));
  }
}
