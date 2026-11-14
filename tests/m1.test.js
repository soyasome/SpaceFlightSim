import { Vector3 } from 'three';
import { test, assert, near } from './harness.js';
import { Ship, makeControls } from '../src/flight/ship.js';
import { FIGHTER } from '../src/flight/shipParams.js';
import { mulberry32 } from '../src/math/random.js';

const H = 1 / 120;
const run = (ship, c, seconds) => {
  for (let i = 0; i < Math.round(seconds / H); i++) ship.step(H, c);
};

test('FA OFF: 推力を切っても速度が保たれる (慣性)', () => {
  const ship = new Ship(FIGHTER);
  ship.flightAssist = false;
  const c = makeControls();
  c.throttle = 1;
  run(ship, c, 2);
  const v1 = ship.body.vel.length();
  near(v1, FIGHTER.mainAccel * 2, 0.5, '2秒加速後の速度');
  c.throttle = 0;
  run(ship, c, 10);
  near(ship.body.vel.length(), v1, 1e-9, '10秒後の速度');
});

test('FA ON: スロットル0で停止する', () => {
  const ship = new Ship(FIGHTER);
  const c = makeControls();
  c.throttle = 1;
  run(ship, c, 15);
  near(ship.body.vel.length(), FIGHTER.assistMaxSpeed, 2, '最高速');
  c.throttle = 0;
  run(ship, c, 25);
  assert(ship.body.vel.length() < 0.5, `止まらない: ${ship.body.vel.length()}`);
});

test('FA ON: 前進は機首方向 (-Z)', () => {
  const ship = new Ship(FIGHTER);
  const c = makeControls();
  c.throttle = 1;
  run(ship, c, 3);
  assert(ship.body.vel.z < -50, 'Z方向に進んでいない');
  near(ship.body.vel.x, 0, 1e-9);
  near(ship.body.vel.y, 0, 1e-9);
});

test('FA ON: 入力を離すと回転が止まる', () => {
  const ship = new Ship(FIGHTER);
  const c = makeControls();
  c.pitch = 1;
  run(ship, c, 1.5);
  near(ship.body.angVel.x, FIGHTER.maxAngRate.x, 0.02, 'ピッチ角速度');
  c.pitch = 0;
  run(ship, c, 2);
  assert(ship.body.angVel.length() < 1e-3, '回転が残っている');
});

test('FA OFF: 入力を離しても回転が続く', () => {
  const ship = new Ship(FIGHTER);
  ship.flightAssist = false;
  const c = makeControls();
  c.roll = 1;
  run(ship, c, 0.3);
  const w = ship.body.angVel.length();
  assert(w > 0.5, '回転していない');
  c.roll = 0;
  run(ship, c, 5);
  near(ship.body.angVel.length(), w, 1e-9, '角速度');
});

test('操作の向き: ピッチ+で機首が上、ヨー+で右、ロール+で右翼が下がる', () => {
  const fwd = (s) => new Vector3(0, 0, -1).applyQuaternion(s.body.quat);
  const right = (s) => new Vector3(1, 0, 0).applyQuaternion(s.body.quat);
  let ship = new Ship(FIGHTER);
  let c = makeControls();
  c.pitch = 1;
  run(ship, c, 0.5);
  assert(fwd(ship).y > 0.1, 'ピッチの向きが逆');

  ship = new Ship(FIGHTER);
  c = makeControls();
  c.yaw = 1;
  run(ship, c, 0.5);
  assert(fwd(ship).x > 0.05, 'ヨーの向きが逆');

  ship = new Ship(FIGHTER);
  c = makeControls();
  c.roll = 1;
  run(ship, c, 0.5);
  assert(right(ship).y < -0.1, 'ロールの向きが逆');
});

test('姿勢クォータニオンは長時間回しても正規化されたまま', () => {
  const ship = new Ship(FIGHTER);
  const c = makeControls();
  c.pitch = 0.7; c.yaw = -0.4; c.roll = 1;
  run(ship, c, 120);
  near(ship.body.quat.length(), 1, 1e-12, '|q|');
});

test('原点から1億kmでも位置の刻みが失われない (倍精度)', () => {
  const ship = new Ship(FIGHTER);
  ship.flightAssist = false;
  ship.body.teleport(new Vector3(1e11, 2e10, -3e10));
  ship.body.vel.set(0, 0, -1); // 1 m/s
  const c = makeControls();
  const z0 = ship.body.pos.z;
  run(ship, c, 1);
  // 3e10 m での float64 の最小刻みは約 4e-6 m。1ステップごとの丸めが積もるので
  // 0.1% 程度の誤差は出る (M5 で星系ローカル座標にすると更に小さくなる)。
  near(ship.body.pos.z - z0, -1, 1e-3, '1秒間の移動量');
});

test('カメラ相対座標は float32 に落としても正確 (Floating Origin)', () => {
  const shipPos = new Vector3(1e11 + 12.345, 2e10 - 3.21, -3e10 + 16.5);
  const camPos = new Vector3(1e11, 2e10, -3e10);
  const rel = new Vector3().subVectors(shipPos, camPos);
  const f32 = new Float32Array([rel.x, rel.y, rel.z]);
  near(f32[0], 12.345, 1e-4);
  near(f32[1], -3.21, 1e-4);
  near(f32[2], 16.5, 1e-4);
  // 比較: 引き算をせずに float32 にすると数千m単位でずれる
  const naive = new Float32Array([shipPos.x]);
  assert(Math.abs(naive[0] - shipPos.x) > 1, '比較対象が想定と違う');
});

test('同じ入力なら結果が完全に一致する (決定論)', () => {
  const sim = () => {
    const ship = new Ship(FIGHTER);
    const rand = mulberry32(42);
    const c = makeControls();
    for (let i = 0; i < 3000; i++) {
      if (i % 60 === 0) {
        c.pitch = rand() * 2 - 1; c.yaw = rand() * 2 - 1; c.roll = rand() * 2 - 1;
        c.throttle = rand() * 2 - 1; c.strafeX = rand() * 2 - 1;
        ship.flightAssist = rand() > 0.3;
      }
      ship.step(H, c);
    }
    return [...ship.body.pos.toArray(), ...ship.body.quat.toArray()];
  };
  const a = sim(), b = sim();
  assert(a.every((x, i) => x === b[i]), '結果が一致しない');
  assert(a.every(Number.isFinite), 'NaN が出た');
});
