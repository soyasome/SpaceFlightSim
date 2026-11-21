import { Vector3, Quaternion, Euler } from 'three';

const SEAT = new Vector3(0, 0.62, -2.1); // 操縦席の目の位置 (機体座標)
const CHASE = new Vector3(0, 3.6, 16); // 追従視点の基準位置 (機体座標)

const _look = new Quaternion();
const _target = new Quaternion();
const _euler = new Euler(0, 0, 0, 'YXZ');
const _acc = new Vector3();
const _v = new Vector3();
const _qi = new Quaternion();

// 追従視点の揺れ。設定の「追従カメラの揺れ」(0..1) を掛けて使う
const SWAY_GAIN = 0.035; // 加速度 (m/s²) → カメラのずれ (m)
const SWAY_MAX = 5; // ずれの上限 (m)
const SWAY_SIDE = 0.5; // 横・上下の加速に対するずれの割合 (前後の加速を 1 として)
const TURN_RATE_STIFF = 12; // 揺れ 0 のときの、向きを追う速さ (1/s)
const TURN_RATE_LOOSE = 6.5; // 揺れ 1 のときの、向きを追う速さ (1/s)

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
    this._accF = new Vector3(); // なめらかにした加速度
    this._snap = true;
  }

  /** 座標系が切り替わったとき、保持している向きと速度を新しい座標系に合わせる。 */
  reframe(q, newVel) {
    this.quat.premultiply(q);
    this._lag.applyQuaternion(q);
    this._accF.applyQuaternion(q);
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
   * @param cruising 巡航中か (巡航中は加速度でカメラをずらさない)
   */
  update(dt, shipPos, shipQuat, shipVel, look, boost, cruising = false) {
    _look.setFromEuler(_euler.set(look.pitch, look.yaw, 0));
    _target.copy(shipQuat).multiply(_look);

    if (this.mode === 'cockpit') {
      this.quat.copy(_target);
      this.pos.copy(SEAT).applyQuaternion(shipQuat).add(shipPos);
      this._lag.set(0, 0, 0);
    } else {
      const sway = this.settings.cameraSway ?? 0.4;
      // 向きは少し遅れて追う。機体が先に回り、カメラが後から付いてくる
      const turnRate = TURN_RATE_STIFF + (TURN_RATE_LOOSE - TURN_RATE_STIFF) * sway;
      if (this._snap) this.quat.copy(_target);
      else this.quat.slerp(_target, 1 - Math.exp(-dt * turnRate));

      // 加速すると機体が前へ出る (カメラが置いていかれる) ように位置をずらす。
      // 進行方向が急に反転しても一気に振れないよう、加速度をなめらかにしてから使う。
      // 横・上下の加速は控えめにし、巡航中 (加速度が桁違いに大きい) はずらさない
      if (dt > 0) {
        _acc.subVectors(shipVel, this._prevVel).divideScalar(dt);
        if (this._snap || cruising) _acc.set(0, 0, 0);
        this._accF.lerp(_acc, 1 - Math.exp(-dt * 2.5));
        if (this._snap) this._accF.set(0, 0, 0);
        _qi.copy(this.quat).invert();
        _v.copy(this._accF).applyQuaternion(_qi); // カメラ座標の加速度
        _v.x *= SWAY_SIDE;
        _v.y *= SWAY_SIDE;
        _v.applyQuaternion(this.quat).multiplyScalar(-SWAY_GAIN * sway).clampLength(0, SWAY_MAX * sway);
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
