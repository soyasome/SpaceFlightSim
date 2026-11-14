import { Vector3 } from 'three';

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const smoothstep = (a, b, x) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

/** 空気力の計算結果を入れる入れ物。 */
export function makeAeroState() {
  return {
    force: new Vector3(), // 機体座標の力 (N)
    torque: new Vector3(), // 機体座標のトルク (N·m)
    airspeed: 0, // 対気速度 (m/s)
    q: 0, // 動圧 (Pa) = 1/2 ρ V²
    mach: 0, // マッハ数
    aoa: 0, // 迎角 (rad)。機首より下へ進んでいるとき正
    slip: 0, // 横滑り角 (rad)。機首より右へ進んでいるとき正
    stalled: false,
  };
}

/**
 * 造波抵抗の係数。音速の手前 (machCrit) から急に増え、machPeak で最大 (waveCd) になる。
 * それより速いと衝撃波が後ろへ寝るため、1/√M で緩やかに減っていく。
 */
export function waveDragCoef(mach, a) {
  if (mach <= a.machCrit) return 0;
  const rise = smoothstep(a.machCrit, a.machPeak, mach);
  return a.waveCd * rise * Math.sqrt(a.machPeak / Math.max(mach, a.machPeak));
}

/**
 * 機体にかかる空気力を求める。
 *
 * 揚力係数は、失速角までは迎角に比例し、それを超えると「平板」の特性
 * (sin 2α に比例) へ移る。こうすると背面・後ろ向きを含む全姿勢で破綻しない。
 * トルクは、機首を進行方向へ向けようとする復元力 (風見安定) と、回転を弱める減衰。
 *
 * @param vLocal 機体座標での対気速度 (前 = -Z, 上 = +Y, 右 = +X)
 * @param angVel 機体座標での角速度
 * @param rho 空気密度 (kg/m³)
 * @param a 機体の空力係数 (shipParams.js の aero)
 * @param extraCd 追加の抗力係数 (着陸装置など)
 */
export function computeAero(vLocal, angVel, rho, a, extraCd, out) {
  out.force.set(0, 0, 0);
  out.torque.set(0, 0, 0);
  const V2 = vLocal.lengthSq();
  const V = Math.sqrt(V2);
  out.airspeed = V;
  out.q = 0.5 * rho * V2;
  out.mach = V / a.soundSpeed;
  out.stalled = false;
  if (V < 0.5) {
    out.aoa = 0;
    out.slip = 0;
    return out;
  }
  const alpha = Math.atan2(-vLocal.y, -vLocal.z);
  out.aoa = alpha;
  out.slip = Math.asin(clamp(vLocal.x / V, -1, 1));
  if (rho <= 0) return out;

  const q = out.q;
  const S = a.wingArea;

  // --- 揚力と抗力 ---
  const sigma = smoothstep(a.stallAngle, a.stallAngle + a.stallWidth, Math.abs(alpha));
  const clLin = a.cl0 + a.clAlpha * alpha;
  const clPlate = a.plateLift * Math.sin(2 * alpha);
  const cl = clLin * (1 - sigma) + clPlate * sigma;
  const sa = Math.sin(alpha);
  const cdLin = a.cd0 + a.inducedK * clLin * clLin;
  const cdPlate = a.cd0 + a.plateDrag * sa * sa;
  const cd = cdLin * (1 - sigma) + cdPlate * sigma + extraCd + waveDragCoef(out.mach, a);
  out.stalled = sigma > 0.5 && q > 150;

  // 揚力は、速度に垂直で機体の対称面内の向き。横向きに進む成分は揚力を生まない
  const planar2 = vLocal.y * vLocal.y + vLocal.z * vLocal.z;
  if (planar2 > 1e-6) {
    const planar = Math.sqrt(planar2);
    const lift = 0.5 * rho * planar2 * S * cl;
    out.force.y += lift * (-vLocal.z / planar);
    out.force.z += lift * (vLocal.y / planar);
  }
  // 抗力は速度と逆向き
  out.force.addScaledVector(vLocal, (-q * S * cd) / V);
  // 横力: 横滑りを打ち消す向き
  out.force.x += -q * S * a.sideCoef * (vLocal.x / V);

  // --- トルク ---
  const qm = Math.min(q, a.maxMomentQ);
  out.torque.x = a.pitchStiffness * qm * (vLocal.y / V);
  out.torque.y = -a.yawStiffness * qm * (vLocal.x / V);
  const rhoV = Math.min(rho * V, 5000);
  out.torque.x -= a.damping.x * rhoV * angVel.x;
  out.torque.y -= a.damping.y * rhoV * angVel.y;
  out.torque.z -= a.damping.z * rhoV * angVel.z;
  return out;
}
