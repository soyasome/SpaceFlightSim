import { Vector3 } from 'three';
import { test, assert, near } from './harness.js';
import { Ship, makeControls } from '../src/flight/ship.js';
import { FIGHTER, RAIDER } from '../src/flight/shipParams.js';
import { leadPoint, segmentSphere, angleBetween } from '../src/combat/targeting.js';
import { BoltPool, Missile } from '../src/combat/projectiles.js';
import { Pilot } from '../src/combat/ai.js';

const H = 1 / 120;
const G = 9.81;
const W = FIGHTER.weapons;
const noSolid = () => false;

/** 弾やミサイルの的になる、最小限の機体。等速で動く。 */
function dummy(pos, vel, team = 1, radius = 7) {
  return { alive: true, team, radius, ship: { body: { pos: pos.clone(), vel: vel.clone() } } };
}
const drift = (a, dt) => a.ship.body.pos.addScaledVector(a.ship.body.vel, dt);

test('見越し: 求めた点へ撃てば、弾と的が同じ時刻に同じ場所へ着く', () => {
  const cases = [
    [new Vector3(0, 0, 0), new Vector3(0, 0, 0), new Vector3(0, 0, -1500), new Vector3(200, 0, 0)],
    [new Vector3(50, 20, 0), new Vector3(0, 0, -300), new Vector3(400, -200, -2000), new Vector3(-150, 80, -250)],
    [new Vector3(0, 0, 0), new Vector3(120, 0, 0), new Vector3(0, 900, 300), new Vector3(0, -100, 380)],
  ];
  for (const [sp, sv, tp, tv] of cases) {
    const hit = new Vector3();
    const t = leadPoint(sp, sv, tp, tv, W.gunSpeed, hit);
    assert(t > 0, '解がない');
    // 弾: 射手の速度 + 弾速。的の位置との一致を確かめる
    const dir = hit.clone().sub(sp).addScaledVector(sv, -t).normalize();
    const bolt = sp.clone().addScaledVector(sv, t).addScaledVector(dir, W.gunSpeed * t);
    const target = tp.clone().addScaledVector(tv, t);
    assert(bolt.distanceTo(target) < 0.01, `ずれ ${bolt.distanceTo(target)}`);
  }
});

test('見越し: 弾より速く逃げる的には当てられない', () => {
  const out = new Vector3();
  const t = leadPoint(new Vector3(), new Vector3(), new Vector3(0, 0, -1000), new Vector3(0, 0, -3000), W.gunSpeed, out);
  assert(t < 0, `当たることになっている: ${t}`);
});

test('線分と球: 当たる・外れる・すでに中にいる・遠ざかる', () => {
  const c = new Vector3(0, 0, -100);
  near(segmentSphere(new Vector3(0, 0, 0), new Vector3(0, 0, -200), c, 10), 0.45, 1e-9, '正面');
  assert(segmentSphere(new Vector3(20, 0, 0), new Vector3(20, 0, -200), c, 10) < 0, '横を通過');
  assert(segmentSphere(new Vector3(0, 0, 0), new Vector3(0, 0, -50), c, 10) < 0, '届かない');
  assert(segmentSphere(new Vector3(0, 0, -95), new Vector3(0, 0, -300), c, 10) === 0, '中から');
  assert(segmentSphere(new Vector3(0, 0, -120), new Vector3(0, 0, -300), c, 10) < 0, '遠ざかる');
});

test('弾: 1ステップで的を飛び越える速さでも、すり抜けない', () => {
  const pool = new BoltPool(16);
  // 弾は1ステップに 15m 進む。的の半径は 2m
  const target = dummy(new Vector3(0, 0, -1000.7), new Vector3(0, 0, 0), 1, 2);
  pool.spawn(new Vector3(0, 0, 0), new Vector3(0, 0, -1800), 0, 6, 2);
  let hits = 0, where = null;
  for (let i = 0; i < 120 && pool.count; i++) {
    pool.step(H, [target], noSolid, (a, p) => { hits++; where = p.clone(); });
  }
  assert(hits === 1, `命中数 ${hits}`);
  near(where.z, -998.7, 0.01, '命中位置');
  assert(pool.count === 0, '弾が残っている');
});

test('弾: 味方には当たらず、寿命が尽きると消え、地形に当たると知らせる', () => {
  const pool = new BoltPool(16);
  const friend = dummy(new Vector3(0, 0, -300), new Vector3(), 0);
  pool.spawn(new Vector3(), new Vector3(0, 0, -1800), 0, 6, 0.5);
  let hits = 0;
  for (let i = 0; i < 70; i++) pool.step(H, [friend], noSolid, () => hits++);
  assert(hits === 0 && pool.count === 0, `味方に当たった、または消えない (${hits}, ${pool.count})`);

  pool.spawn(new Vector3(), new Vector3(0, 0, -1800), 0, 6, 2);
  let ground = 0;
  const wall = (from, to, out) => (to.z < -500 ? (out.copy(to), true) : false);
  for (let i = 0; i < 120 && pool.count; i++) pool.step(H, [], wall, (a) => { if (!a) ground++; });
  assert(ground === 1 && pool.count === 0, `地形に当たらない (${ground})`);
});

test('弾: 見越し点へ撃つと、動いている的に命中する', () => {
  const pool = new BoltPool(16);
  const sp = new Vector3(), sv = new Vector3(0, 0, -250);
  const target = dummy(new Vector3(600, 150, -1800), new Vector3(-220, 40, -180));
  const hit = new Vector3();
  const t = leadPoint(sp, sv, target.ship.body.pos, target.ship.body.vel, W.gunSpeed, hit);
  const dir = hit.clone().sub(sp).addScaledVector(sv, -t).normalize();
  pool.spawn(sp, dir.multiplyScalar(W.gunSpeed).add(sv), 0, 6, W.gunLife);
  let hits = 0;
  for (let i = 0; i < 200 && pool.count; i++) {
    pool.step(H, [target], noSolid, () => hits++);
    drift(target, H);
  }
  assert(hits === 1, `命中数 ${hits}`);
});

test('シールド: 先に削られ、あふれた分が機体に入り、しばらくすると回復する', () => {
  const ship = new Ship(FIGHTER);
  assert(ship.takeDamage(30) === false && ship.shield === 70 && ship.hull === 100, '30 ダメージ');
  assert(ship.takeDamage(90) === true && ship.shield === 0 && ship.hull === 80, '90 ダメージ');
  for (let i = 0; i < 3 * 120; i++) ship.updateSystems(H);
  assert(ship.shield === 0, '回復が早すぎる');
  for (let i = 0; i < 4 * 120; i++) ship.updateSystems(H);
  assert(ship.shield > 20 && ship.shield < 60, `回復量 ${ship.shield}`);
  assert(ship.hull === 80, '機体が勝手に回復した');
  ship.restore();
  assert(ship.shield === 100 && ship.hull === 100 && ship.missiles === W.missiles, '全回復');
});

test('ミサイル: まっすぐ飛ぶ的を追って命中する', () => {
  const target = dummy(new Vector3(800, 300, -3500), new Vector3(180, 0, -120));
  const m = new Missile(new Vector3(), new Vector3(0, 0, -250), target, 0, 70);
  let result = null;
  for (let i = 0; i < 12 * 120 && !result; i++) {
    result = m.step(H);
    drift(target, H);
  }
  assert(result === 'hit', `結果 ${result}`);
});

test('ミサイル: 視野の外の的は追えず、曲がれる速さにも限りがある', () => {
  // 真後ろの的: 見失ってそのまま飛び去る
  const behind = dummy(new Vector3(0, 0, 2000), new Vector3());
  const m = new Missile(new Vector3(), new Vector3(0, 0, -250), behind, 0, 70);
  let result = null;
  for (let i = 0; i < 12 * 120 && !result; i++) result = m.step(H);
  assert(result === 'expired' && !m.tracking, `結果 ${result}`);

  // 1ステップで向きを変えられる角度は 曲がる力 ÷ 速さ まで
  const side = dummy(new Vector3(1500, 0, -2000), new Vector3());
  const m2 = new Missile(new Vector3(), new Vector3(0, 0, -600), side, 0, 70);
  const before = m2.vel.clone().normalize();
  m2.step(H);
  const turned = angleBetween(before, m2.vel.clone().normalize());
  assert(turned > 0 && turned < (200 / 600) * H * 1.05, `曲がりすぎ ${turned}`);
});

// --- 敵AI ---

const SPACE = { altitudeAt: () => Infinity, upAt: () => false, aeroAt: () => 0, rocks: [] };
const SPACE_ENV = { speedScale: 1, gravity: new Vector3(), rho: 0, aero: 0, onGround: false };

function makeEnemy(pos, facing, speed, seed = 7, skill = 0.9) {
  const ship = new Ship(RAIDER);
  ship.body.pos.copy(pos);
  ship.body.quat.setFromUnitVectors(new Vector3(0, 0, -1), facing.clone().normalize());
  ship.body.vel.copy(facing).normalize().multiplyScalar(speed);
  return {
    ship, team: 1, radius: 7, alive: true, controls: makeControls(),
    pilot: new Pilot({ skill, seed, home: pos }), underFire: 0, missileThreat: false, alerted: true,
  };
}

test('敵AI (宇宙): 逃げる的を追い、射線に捉えて撃つ', () => {
  const target = dummy(new Vector3(0, 0, 0), new Vector3(150, 0, 0), 0);
  target.ship.body.quat = new Ship(FIGHTER).body.quat;
  target.ship.hull = 100;
  // 3km 離れた所から、的とは逆を向いて始める
  const e = makeEnemy(new Vector3(-500, 800, 3000), new Vector3(0, 0, 1), 100);
  let shots = 0, best = Infinity;
  const fwd = new Vector3(), to = new Vector3();
  for (let i = 0; i < 45 * 120; i++) {
    if (i % 6 === 0) {
      e.pilot.update(0.05, e, target, SPACE);
      if (e.pilot.wantGun) shots++;
      fwd.set(0, 0, -1).applyQuaternion(e.ship.body.quat);
      to.subVectors(target.ship.body.pos, e.ship.body.pos).normalize();
      best = Math.min(best, angleBetween(fwd, to));
    }
    e.ship.step(H, e.controls, SPACE_ENV);
    drift(target, H);
    assert(Number.isFinite(e.ship.body.pos.x), 'NaN');
  }
  assert(best < 0.05, `機首を向けられない: 最小 ${(best * 57.3).toFixed(1)}°`);
  assert(shots > 10, `撃つ機会が少ない: ${shots}`);
});

test('敵AI (大気中): 低空の的を追っても地面に突っ込まず、失速もしない', () => {
  const R = 400e3;
  const world = {
    altitudeAt: (p) => p.length() - R,
    upAt: (p, out) => (out.copy(p).normalize(), true),
    aeroAt: () => 1,
    rocks: [],
  };
  const env = { speedScale: 1, gravity: new Vector3(), rho: 1.2, aero: 1, onGround: false };
  // 的は高度 120m を水平に飛ぶ
  const target = dummy(new Vector3(0, R + 120, 0), new Vector3(0, 0, -200), 0);
  target.ship.body.quat = new Ship(FIGHTER).body.quat;
  target.ship.hull = 100;
  const e = makeEnemy(new Vector3(300, R + 2500, 1500), new Vector3(0, -0.5, -1), 250);
  let minAlt = Infinity, minSpeed = Infinity;
  const tb = target.ship.body;
  for (let i = 0; i < 90 * 120; i++) {
    if (i % 6 === 0) e.pilot.update(0.05, e, target, world);
    const b = e.ship.body;
    env.gravity.copy(b.pos).normalize().multiplyScalar(-G);
    e.ship.step(H, e.controls, env);
    // 的は惑星の丸みに沿って高度を保つ
    drift(target, H);
    tb.pos.setLength(R + 120);
    minAlt = Math.min(minAlt, b.pos.length() - R);
    if (i > 240) minSpeed = Math.min(minSpeed, b.vel.length());
  }
  assert(minAlt > 20, `地面に近づきすぎ: ${minAlt.toFixed(1)} m`);
  assert(minSpeed > 70, `遅くなりすぎ: ${minSpeed.toFixed(0)} m/s`);
  assert(e.ship.hull === e.ship.hullMax, '加熱などで損傷した');
});

test('敵AI: 小惑星を避ける', () => {
  const rock = { pos: new Vector3(0, 0, -2500), r: 300 };
  const world = { ...SPACE, rocks: [rock] };
  // 岩の向こうにいる的へ、岩を突き抜ける進路で向かう
  const target = dummy(new Vector3(0, 0, -6000), new Vector3(), 0);
  target.ship.body.quat = new Ship(FIGHTER).body.quat;
  target.ship.hull = 100;
  const e = makeEnemy(new Vector3(0, 0, 0), new Vector3(0, 0, -1), 300);
  let closest = Infinity;
  for (let i = 0; i < 25 * 120; i++) {
    if (i % 6 === 0) e.pilot.update(0.05, e, target, world);
    e.ship.step(H, e.controls, SPACE_ENV);
    closest = Math.min(closest, e.ship.body.pos.distanceTo(rock.pos) - rock.r);
  }
  assert(closest > 7, `岩に当たった: 表面から ${closest.toFixed(1)} m`);
});

test('敵AI: 撃たれても全速で離れず、近い距離・近い速さで巴戦を続ける', () => {
  // 自機役も同じ操縦士に任せ、狙いが合うたびに敵へ「撃たれている」と知らせる
  const p = makeEnemy(new Vector3(0, 0, 0), new Vector3(0, 0, -1), 300, 11, 0.8);
  p.ship = new Ship(FIGHTER);
  p.ship.body.vel.set(0, 0, -300);
  p.controls = makeControls();
  const e = makeEnemy(new Vector3(300, 200, -5000), new Vector3(0, 0, 1), 200, 7, 0.6);
  let n = 0, inRange = 0, relSum = 0, eShots = 0, maxSpeed = 0;
  for (let i = 0; i < 90 * 120; i++) {
    if (i % 6 === 3) {
      p.pilot.update(0.05, p, e, SPACE);
      p.controls.throttle = 1; // 自機は全速で飛ぶ
      p.controls.boost = 0;
      if (p.pilot.wantGun) e.underFire = 2;
    }
    if (i % 6 === 0) {
      e.pilot.update(0.05, e, p, SPACE);
      if (e.pilot.wantGun) eShots++;
    }
    e.underFire -= H;
    p.ship.step(H, p.controls, SPACE_ENV);
    e.ship.step(H, e.controls, SPACE_ENV);
    if (i > 10 * 120 && i % 12 === 0) {
      n++;
      maxSpeed = Math.max(maxSpeed, e.ship.body.vel.length());
      if (p.ship.body.pos.distanceTo(e.ship.body.pos) < W.gunSpeed * W.gunLife) {
        inRange++;
        relSum += p.ship.body.vel.distanceTo(e.ship.body.vel);
      }
    }
  }
  assert(inRange / n > 0.8, `射程内にいる時間が短い: ${(inRange / n * 100).toFixed(0)}%`);
  assert(relSum / inRange < 300, `すれ違いが速すぎる: 平均の相対速度 ${(relSum / inRange).toFixed(0)} m/s`);
  assert(maxSpeed < RAIDER.assistMaxSpeed * 1.1, `ブーストで離れた: ${maxSpeed.toFixed(0)} m/s`);
  assert(eShots > 60, `敵が撃ち返せていない: ${eShots}`);
});

test('敵AI: 2機が互いを狙って1分間戦っても、数値が壊れない', () => {
  const a = makeEnemy(new Vector3(0, 0, 0), new Vector3(0, 0, -1), 200, 3, 0.6);
  const b = makeEnemy(new Vector3(400, 300, -4000), new Vector3(0, 0, 1), 200, 5, 0.6);
  a.team = 0;
  for (let i = 0; i < 60 * 120; i++) {
    if (i % 6 === 0) a.pilot.update(0.05, a, b, SPACE);
    if (i % 6 === 3) b.pilot.update(0.05, b, a, SPACE);
    a.ship.step(H, a.controls, SPACE_ENV);
    b.ship.step(H, b.controls, SPACE_ENV);
  }
  for (const s of [a.ship, b.ship]) {
    assert(Number.isFinite(s.body.pos.lengthSq()) && Number.isFinite(s.body.quat.x), 'NaN');
    assert(s.body.vel.length() < 3000, `速すぎる: ${s.body.vel.length()}`);
  }
});
