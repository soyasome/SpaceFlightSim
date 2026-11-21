import { Vector3 } from 'three';
import { test, assert, near } from './harness.js';
import { Ship, makeControls } from '../src/flight/ship.js';
import { FIGHTER } from '../src/flight/shipParams.js';
import { computeAero, makeAeroState } from '../src/flight/aero.js';
import { GroundContact } from '../src/flight/ground.js';

const H = 1 / 120;
const RHO = 1.225;
const G = 9.81;
const ZERO = new Vector3();
const DEG = Math.PI / 180;

/** 速さ V, 迎角 alpha (rad) で飛んでいるときの機体座標の速度。 */
const flow = (V, alpha, vx = 0) => new Vector3(vx, -V * Math.sin(alpha), -V * Math.cos(alpha));
const aeroAt = (v, rho = RHO, w = ZERO) => computeAero(v, w, rho, FIGHTER.aero, 0, makeAeroState());

/** 平らな地面 (+Y が上) の上で、重力と空気のある環境を作る。 */
function env(over = {}) {
  return { speedScale: 1, gravity: new Vector3(0, -G, 0), rho: RHO, aero: 1, onGround: false, ...over };
}

test('空力: 真空では力もトルクも生じない', () => {
  const a = aeroAt(flow(300, 5 * DEG), 0);
  assert(a.force.length() === 0 && a.torque.length() === 0, '真空なのに力がある');
});

test('空力: 揚力は上向きで、空気の密度に比例する', () => {
  const a = aeroAt(flow(200, 5 * DEG), RHO);
  const b = aeroAt(flow(200, 5 * DEG), RHO / 2);
  assert(a.force.y > 0, '揚力が上向きでない');
  near(b.force.y / a.force.y, 0.5, 1e-9, '密度比');
  // 揚力 = 動圧 × 翼面積 × 揚力係数 (迎角が小さいので、ほぼ機体の上向き)
  const expected = 0.5 * RHO * 200 * 200 * FIGHTER.aero.wingArea * FIGHTER.aero.clAlpha * 5 * DEG;
  near(a.force.y, expected, expected * 0.03, '揚力の大きさ');
});

test('空力: 失速角を超えると揚力が落ち、抗力が急に増える', () => {
  const before = aeroAt(flow(100, 17 * DEG));
  const after = aeroAt(flow(100, 30 * DEG));
  const lift = (a, alpha) => a.force.y * Math.cos(alpha) + a.force.z * Math.sin(alpha);
  const drag = (a, alpha) => -(a.force.z * -Math.cos(alpha) + a.force.y * -Math.sin(alpha));
  assert(!before.stalled && after.stalled, '失速の判定');
  assert(lift(after, 30 * DEG) < lift(before, 17 * DEG), '失速しても揚力が落ちない');
  assert(drag(after, 30 * DEG) > drag(before, 17 * DEG) * 2, '失速しても抗力が増えない');
});

test('空力: どの向きに進んでも、空気力は速度を増やさない', () => {
  for (let i = 0; i < 200; i++) {
    const v = new Vector3(Math.sin(i * 1.7), Math.sin(i * 2.3 + 1), Math.cos(i * 0.9)).multiplyScalar(150);
    const a = aeroAt(v);
    assert(Number.isFinite(a.force.length()), 'NaN');
    assert(a.force.dot(v) < 0, `空気力が機体を加速している (${v.toArray()})`);
  }
});

test('空力: 機首は進行方向へ戻ろうとする (風見安定)', () => {
  // 機首より下へ進んでいる (迎角 +) → 機首下げ (X軸まわり負)
  assert(aeroAt(flow(200, 10 * DEG)).torque.x < 0, 'ピッチの復元力が逆');
  assert(aeroAt(flow(200, -10 * DEG)).torque.x > 0, 'ピッチの復元力が逆');
  // 機首より右へ進んでいる → 機首を右へ (Y軸まわり負)
  assert(aeroAt(flow(200, 0, 30)).torque.y < 0, 'ヨーの復元力が逆');
});

test('重力: アシストOFFなら自由落下する', () => {
  const ship = new Ship(FIGHTER);
  ship.flightAssist = false;
  const c = makeControls();
  for (let i = 0; i < 240; i++) ship.step(H, c, env({ rho: 0, aero: 0 }));
  near(ship.body.vel.y, -G * 2, 0.05, '2秒後の落下速度');
});

test('重力: 宇宙のアシストONは重力を打ち消して静止する', () => {
  const ship = new Ship(FIGHTER);
  const c = makeControls();
  for (let i = 0; i < 600; i++) ship.step(H, c, env({ rho: 0, aero: 0 }));
  assert(ship.body.vel.length() < 0.01, `動いている: ${ship.body.vel.length()}`);
  assert(Math.abs(ship.body.pos.y) < 0.05, `落ちている: ${ship.body.pos.y}`);
});

test('大気中: 翼の揚力が重さと釣り合って飛び続ける', () => {
  const ship = new Ship(FIGHTER);
  ship.body.vel.set(0, 0, -200);
  const c = makeControls();
  c.throttle = 0.06;
  let vyPrev = 0;
  for (let i = 0; i < 20 * 120; i++) {
    if (i === 19 * 120) vyPrev = ship.body.vel.y;
    ship.step(H, c, env());
  }
  const vy = ship.body.vel.y;
  assert(Math.abs(vy - vyPrev) < 0.3, `沈下率が落ち着かない: ${vyPrev} → ${vy}`);
  assert(vy > -15, `沈みすぎ: ${vy}`);
  assert(ship.aero.aoa > 0 && ship.aero.aoa < 8 * DEG, `迎角が不自然: ${ship.aero.aoa / DEG}`);
  assert(ship.hoverAuthority === 0, '航空機としての操縦になっていない');
});

test('大気中: 遅すぎると失速して落ちる', () => {
  const ship = new Ship(FIGHTER);
  ship.body.vel.set(0, 0, -40);
  const c = makeControls();
  let stalled = false;
  for (let i = 0; i < 5 * 120; i++) {
    ship.step(H, c, env());
    stalled = stalled || ship.aero.stalled;
  }
  assert(stalled, '失速しなかった');
  assert(ship.body.vel.y < -15, `落ちていない: ${ship.body.vel.y}`);
});

test('ホバー: 大気中でも空中で静止できる', () => {
  const ship = new Ship(FIGHTER);
  ship.hover = true;
  const c = makeControls();
  for (let i = 0; i < 600; i++) ship.step(H, c, env());
  assert(ship.body.vel.length() < 0.05, `動いている: ${ship.body.vel.length()}`);
  assert(Math.abs(ship.body.pos.y) < 0.1, `高さが変わった: ${ship.body.pos.y}`);
});

// --- 着陸 ---

const R = 400e3;
const FLAT = { groundRadiusAt: () => R };

/** 平らな惑星の上で、エンジンを使わずに seconds 秒進める。受けた損傷の合計を返す。 */
function ground(ship, seconds, brake, planet = FLAT, onStep = null) {
  const gc = new GroundContact();
  const c = makeControls();
  const e = env({ rho: 0, aero: 0 });
  let damage = 0;
  for (let i = 0; i < Math.round(seconds / H); i++) {
    e.gravity.copy(ship.body.pos).normalize().multiplyScalar(-G);
    ship.applyForces(H, c, e);
    gc.apply(ship.body, planet, ship.gear, brake, H);
    damage += gc.damage;
    ship.body.integrate(H);
    if (onStep) onStep(ship);
  }
  return { damage, gc };
}

/** z = zWall より先 (-Z 側) に、高さ wall (m) の崖がそびえる惑星。崖の水平方向の幅は width (m)。 */
function cliffPlanet(zWall, wall, width) {
  return {
    groundRadiusAt(p) {
      const t = Math.min(1, Math.max(0, (zWall - p.z) / width));
      return R + wall * t * t * (3 - 2 * t);
    },
  };
}

function parked(height) {
  const ship = new Ship(FIGHTER);
  ship.flightAssist = false;
  ship.gearDown = true;
  ship.gear = 1;
  ship.body.pos.set(0, R + height, 0);
  return ship;
}

test('着陸: 静かに降ろすと、3本の脚で無傷のまま止まる', () => {
  const ship = parked(3); // 車輪は地面の 0.8m 上
  const { damage, gc } = ground(ship, 8, true);
  assert(damage === 0, `損傷した: ${damage}`);
  assert(gc.gearContacts === 3 && gc.hullContacts === 0, '脚で立っていない');
  assert(ship.body.vel.length() < 0.02, `止まっていない: ${ship.body.vel.length()}`);
  // 脚が約 0.25m 沈んだ高さで釣り合う
  near(ship.body.pos.length() - R, 2.2 - 0.25, 0.05, '止まった高さ');
  const up = new Vector3(0, 1, 0).applyQuaternion(ship.body.quat);
  assert(up.y > 0.999, '機体が傾いた');
});

test('着陸: 速すぎる接地は機体を壊す', () => {
  const ship = parked(30); // 約 23 m/s で接地
  const { damage } = ground(ship, 4, true);
  assert(damage > 100, `損傷が小さい: ${damage}`);
});

test('着陸: 脚を出さずに降りると機体をこする', () => {
  const ship = parked(3);
  ship.gearDown = false;
  ship.gear = 0;
  ship.body.vel.set(0, 0, -40);
  const { damage, gc } = ground(ship, 3, true);
  assert(gc.hullContacts > 0, '胴体が接地していない');
  assert(damage > 5, `損傷していない: ${damage}`);
});

test('着陸: ブレーキをかけると短い距離で止まり、かけなければ転がり続ける', () => {
  const run = (brake) => {
    const ship = parked(1.95);
    ship.body.vel.set(0, 0, -30);
    ground(ship, 8, brake);
    return { dist: -ship.body.pos.z, speed: ship.body.vel.length() };
  };
  const braked = run(true), rolling = run(false);
  assert(braked.speed < 0.1, `止まらない: ${braked.speed}`);
  assert(braked.dist > 40 && braked.dist < 110, `制動距離が不自然: ${braked.dist}`);
  assert(rolling.speed > 20, `ブレーキなしで止まった: ${rolling.speed}`);
});

test('接地: 崖の壁に水平に突っ込むと、崖の上へ飛び移らずに壁で止まって壊れる', () => {
  for (const speed of [30, 120, 400]) {
    const ship = parked(15); // 地面から 15 m の高さを水平に飛ぶ
    ship.gearDown = false;
    ship.gear = 0;
    ship.body.vel.set(0, 0, -speed);
    const planet = cliffPlanet(-60, 400, 30);
    let highest = 0, farthest = 0;
    const { damage } = ground(ship, 3, false, planet, (s) => {
      highest = Math.max(highest, s.body.pos.length() - R);
      farthest = Math.min(farthest, s.body.pos.z);
    });
    assert(highest < 60, `${speed} m/s: 崖の上へ飛び移った (高さ ${highest.toFixed(0)} m)`);
    assert(farthest > -100, `${speed} m/s: 壁を突き抜けた (z = ${farthest.toFixed(0)} m)`);
    assert(ship.body.vel.z > -5, `${speed} m/s: 壁で止まらない (${ship.body.vel.z.toFixed(1)} m/s)`);
    assert(damage > (speed > 50 ? 100 : 1), `${speed} m/s: 損傷が小さい (${damage.toFixed(1)})`);
  }
});

test('接地: 平らな崖の上には普通に着陸できる (崖の際の判定が地面全体を壊さない)', () => {
  const ship = parked(3);
  const planet = cliffPlanet(-15, 400, 30); // 機首の 12 m 先から崖がそびえる。足元は平ら
  const { damage, gc } = ground(ship, 6, true, planet);
  assert(damage === 0 && gc.gearContacts === 3, `着陸できない: 損傷 ${damage} 脚 ${gc.gearContacts}`);
});

test('空力: 音速付近で抗力が跳ね上がり、低空ではスロットル全開でも速度に上限がある', () => {
  // 抗力係数 = 抗力 ÷ (動圧 × 翼面積)
  const cdAt = (V) => { const a = aeroAt(flow(V, 0)); return a.force.z / (a.q * FIGHTER.aero.wingArea); };
  near(cdAt(200), FIGHTER.aero.cd0, 1e-6, '亜音速の抗力係数');
  assert(cdAt(400) > 4 * cdAt(200), `音速を超えても抗力が増えない: ${cdAt(200)} → ${cdAt(400)}`);

  // 海面を水平に全開で飛び続けたときの速さ
  const topSpeed = (boost) => {
    const ship = new Ship(FIGHTER);
    ship.body.vel.set(0, 0, -300);
    const c = makeControls();
    c.throttle = 1;
    c.boost = boost;
    for (let i = 0; i < 60 * 120; i++) {
      ship.body.vel.y = 0; // 高度を保ったまま推力と抗力の釣り合いだけを見る
      ship.body.quat.identity();
      ship.body.angVel.set(0, 0, 0);
      ship.step(H, c, env({ gravity: ZERO }));
    }
    return ship.body.vel.length();
  };
  const normal = topSpeed(0), boost = topSpeed(1);
  assert(normal > 350 && normal < 450, `通常の最高速度: ${normal.toFixed(0)} m/s`);
  assert(boost > 650 && boost < 800, `ブーストの最高速度: ${boost.toFixed(0)} m/s`);
});

test('大気中: 高速でも操縦桿いっぱいで 12G 以上引いて曲がれる', () => {
  const ship = new Ship(FIGHTER);
  ship.body.vel.set(0, 0, -400);
  const c = makeControls();
  c.pitch = 1;
  c.throttle = 1;
  let gMax = 0;
  for (let i = 0; i < 3 * 120; i++) {
    ship.step(H, c, env({ gravity: ZERO }));
    gMax = Math.max(gMax, ship.aero.force.y / FIGHTER.mass / G);
  }
  assert(gMax > 12, `引ける G が小さい: ${gMax.toFixed(1)} G`);
});

test('加熱: 濃い空気の中を速く飛ぶほど熱くなり、限界を超えると損傷する', () => {
  const heatAt = (speed) => {
    const ship = new Ship(FIGHTER);
    ship.flightAssist = false;
    const c = makeControls();
    for (let i = 0; i < 10 * 120; i++) {
      ship.body.vel.set(0, 0, -speed); // 速度を保ったまま加熱だけを見る
      ship.applyForces(H, c, env({ gravity: ZERO }));
      ship.body.force.set(0, 0, 0);
      ship.body.torque.set(0, 0, 0);
    }
    return ship;
  };
  const slow = heatAt(300), fast = heatAt(2000);
  assert(slow.heat < 0.05 && slow.hull === 100, `低速で熱い: ${slow.heat}`);
  assert(fast.heat > 1 && fast.hull < 100, `高速で熱くならない: ${fast.heat}`);
});

// --- 巡航 ---

test('巡航: 地表へ真下に降りても、速さは高度で決まる上限に遅れず付いていく', () => {
  for (const boost of [0, 1]) {
    const ship = new Ship(FIGHTER);
    ship.cruise = true;
    const c = makeControls();
    c.throttle = 1;
    c.boost = boost;
    const top = boost ? FIGHTER.assistBoostSpeed : FIGHTER.assistMaxSpeed;
    const e = env({ gravity: ZERO, rho: 0, aero: 0 });
    let alt = 3000e3; // 機体は -Z へ進み、その分だけ高度が減る
    let worst = 0;
    for (let i = 0; i < 60 * 120 && alt > 20e3; i++) {
      e.speedScale = Math.min(5000, Math.max(5, alt / 3000));
      const z = ship.body.pos.z;
      ship.step(H, c, e);
      alt += ship.body.pos.z - z;
      if (i > 240) worst = Math.max(worst, ship.body.vel.length() / (e.speedScale * top));
    }
    assert(alt <= 20e3, `降りきれない (boost ${boost}): ${alt}`);
    assert(worst < 1.25, `上限を超えすぎ (boost ${boost}): ${worst.toFixed(2)} 倍`);
  }
});

test('巡航: 高速でも進行方向がすぐ機首に付いてくる (目的の天体を回り込まない)', () => {
  for (const scale of [10, 1e4, 1e7]) {
    const ship = new Ship(FIGHTER);
    ship.cruise = true;
    const v = FIGHTER.assistMaxSpeed * scale;
    ship.body.vel.set(v, 0, 0); // 機首 (-Z) に対して真横へ進んでいる
    const c = makeControls();
    c.throttle = 1;
    const e = env({ speedScale: scale, gravity: ZERO, rho: 0, aero: 0 });
    for (let i = 0; i < 1.5 * 120; i++) ship.step(H, c, e);
    const vel = ship.body.vel;
    assert(Math.abs(vel.x) < v * 0.05, `scale=${scale}: 横滑りが残った ${(vel.x / v).toFixed(3)}`);
    assert(-vel.z > v * 0.9, `scale=${scale}: 機首の向きに進んでいない ${(-vel.z / v).toFixed(3)}`);
  }
});

test('巡航: 解除すると、初速によらず決まった時間で通常の速度に落ちる', () => {
  const T = FIGHTER.cruiseExitTime, vEnd = FIGHTER.assistMaxSpeed;
  for (const v0 of [2000, 150e3, 2e6]) {
    const ship = new Ship(FIGHTER);
    ship.cruise = true;
    ship.body.vel.set(0, 0, -v0);
    const c = makeControls();
    c.throttle = 1;
    const e = env({ speedScale: 5000, rho: RHO, aero: 1 }); // 濃い大気の中で解除する
    ship.exitCruise();
    assert(ship.cruise && ship.driving, '減速中はドライブが働いているはず');
    let half = 0;
    const n = Math.round(T / H);
    for (let i = 0; i < n + 2; i++) {
      ship.step(H, c, e);
      if (i === Math.round(n / 2) - 1) half = ship.body.vel.length();
    }
    // 途中の速さは初速と終速の相乗平均 (対数で見て真ん中)
    near(half, Math.sqrt(v0 * vEnd), Math.sqrt(v0 * vEnd) * 0.03, `v0=${v0} の中間`);
    assert(!ship.cruise && !ship.cruiseExit, `v0=${v0}: 解除が終わっていない`);
    assert(ship.body.vel.length() < vEnd * 1.05, `v0=${v0}: 速さが残った ${ship.body.vel.length()}`);
    assert(ship.hull === 100 && ship.heat < 0.2, `v0=${v0}: 減速中に機体が焼けた (heat ${ship.heat})`);
  }
});

test('巡航: 遅いときの解除は即座に終わり、減速中にもう一度入れば巡航に戻れる', () => {
  const ship = new Ship(FIGHTER);
  ship.cruise = true;
  ship.body.vel.set(0, 0, -200);
  ship.exitCruise();
  assert(!ship.cruise && !ship.cruiseExit, '遅いのに減速に入った');

  ship.cruise = true;
  ship.body.vel.set(0, 0, -50000);
  ship.exitCruise(true);
  assert(ship.cruiseExit && ship.flightAssist, '減速に入っていない');
  ship.cruiseExit = null; // J をもう一度押した状態
  assert(ship.driving && ship.flightAssist, '巡航に戻れない');
});
