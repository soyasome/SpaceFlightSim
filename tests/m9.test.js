import { test, assert, near } from './harness.js';
import { Vector3 } from 'three';
import { Planet } from '../src/planet/planet.js';
import { makeTerrain } from '../src/terrain/terrainFn.js';
import { cityPlan } from '../src/planet/city.js';
import { Ship, makeControls } from '../src/flight/ship.js';
import { FIGHTER } from '../src/flight/shipParams.js';
import { GroundContact } from '../src/flight/ground.js';
import { FRAME_ENTER, FRAME_EXIT } from '../src/universe/system.js';

// 座標系の窓口 (Planet の upAt, heightAbove, gravityAt など)。
// 接地・飛行・敵の操縦が「下 = 惑星の中心の方」を自分で仮定しないよう、これだけを使うようにした。
// 惑星については、以前の計算 (中心からの距離) とまったく同じ値になることを確かめる。

/** メッシュやシェーダーを作らずに、窓口だけを使える惑星を作る。 */
function lightPlanet({ radius = 300e3, terrain, gravity = 7.5, atmosphere = null } = {}) {
  const p = Object.create(Planet.prototype);
  p.radius = radius;
  p.gas = false;
  p.terrain = makeTerrain({ seed: 41, radius, terrain });
  p.city = p.terrain.type === 'city' ? cityPlan(p.terrain) : null;
  p.gravity = gravity;
  p.atmosphere = atmosphere;
  p.surfaceDensity = atmosphere ? atmosphere.surfaceDensity : 0;
  p.pos = new Vector3(1e9, -2e8, 5e8);
  p.frameEnter = radius * FRAME_ENTER;
  p.frameExit = radius * FRAME_EXIT;
  return p;
}

/** 惑星のまわりに、高さのいろいろな点を並べる。 */
function samplePoints(radius, n = 60) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const a = i * 2.399, y = 1 - (2 * (i + 0.5)) / n, r = Math.sqrt(1 - y * y);
    const alt = [-300, 5, 800, 20e3, 2e6][i % 5];
    pts.push(new Vector3(Math.cos(a) * r, y, Math.sin(a) * r).multiplyScalar(radius + alt));
  }
  return pts;
}

test('座標系の窓口: 惑星の値は、中心からの距離で求めていた以前の計算と同じ', () => {
  const air = { surfaceDensity: 1.1, height: 60e3, scaleHeightR: 7000 };
  for (const terrain of [undefined, { type: 'desert', land: 0.4, cAmp: 2400, mAmp: 7000, hAmp: 380 }]) {
    const planet = lightPlanet({ terrain, atmosphere: air });
    const out = new Vector3();
    for (const p of samplePoints(planet.radius)) {
      const r = p.length();
      near(planet.heightAbove(p), r - planet.groundRadiusAt(p), 1e-6, '地面からの高さ');
      near(planet.seaLevelAt(p), r - planet.radius, 1e-6, '海面からの高さ');
      planet.upAt(p, out);
      near(out.distanceTo(p.clone().divideScalar(r)), 0, 1e-12, '真上');
      planet.gravityAt(p, out);
      const k = planet.radius / Math.max(r, planet.radius);
      near(out.distanceTo(p.clone().multiplyScalar(-planet.gravity * k * k / r)), 0, 1e-9, '重力');
      near(planet.airDensityAt(p), planet.densityAt(r - planet.radius) * air.surfaceDensity, 1e-12, '空気の密度');
      const h20 = planet.terrain.height(p.x / r, p.y / r, p.z / r, 20);
      near(planet.roughHeightAbove(p), r - planet.radius - Math.max(0, h20), 1e-6, '軽い版の高さ');
    }
  }
});

test('座標系の窓口: 地面の上の点、出入りの範囲、いちばん近い天体までの距離', () => {
  const planet = lightPlanet();
  const out = new Vector3();
  for (const dir of [new Vector3(1, 2, 3), new Vector3(-4, 0.5, 1), new Vector3(0, -1, 0)]) {
    for (const alt of [0, 12, 3000]) {
      planet.surfacePoint(dir, alt, out);
      near(planet.heightAbove(out), alt, 1e-6, '地面からの高さ');
      near(out.clone().normalize().dot(dir.clone().normalize()), 1, 1e-12, '向き');
    }
  }
  const R = planet.radius;
  assert(planet.containsLocal(new Vector3(0, R * FRAME_EXIT * 0.999, 0)), '出る範囲の内側');
  assert(!planet.containsLocal(new Vector3(0, R * FRAME_EXIT * 1.001, 0)), '出る範囲の外側');
  const w = planet.pos.clone().add(new Vector3(R * FRAME_ENTER * 0.999, 0, 0));
  assert(planet.entersAt(w), '入る範囲の内側');
  assert(!planet.entersAt(planet.pos.clone().add(new Vector3(0, 0, R * FRAME_ENTER * 1.001))), '入る範囲の外側');
  near(planet.surfaceDistance(planet.pos.clone().add(new Vector3(0, R + 5000, 0))), 5000, 1e-6, '表面までの距離');
});

test('座標系の窓口: 都市惑星では、ビルの屋上が地面になる', () => {
  const planet = lightPlanet({ radius: 400e3, terrain: { type: 'city', land: 0.2, cAmp: 1600, mAmp: 1400, hAmp: 120 } });
  const plan = planet.city;
  // 塔のある敷地を探し、その中心の真上で比べる
  let checked = 0;
  for (let i = 0; i < plan.N && checked < 3; i += 37) {
    for (let j = 0; j < plan.N && checked < 3; j += 41) {
      const b = plan.lot(4, i, j);
      if (!b || b.height < 30) continue;
      // 敷地の中心の方向 (キューブ球の面 4 は +Z の面)
      const s = (i + b.cs) / plan.N * 2 - 1, t = (j + b.ct) / plan.N * 2 - 1;
      const dir = new Vector3(s, t, 1).normalize();
      const p = dir.clone().multiplyScalar(planet.radius + b.ground + b.height + 20);
      near(planet.heightAbove(p), 20, 0.5, '屋上からの高さ');
      checked++;
    }
  }
  assert(checked > 0, '塔が見つからない');
});

test('接地: 窓口だけで地面を調べるので、下の向きが中心の方でない座標系でも着陸できる', () => {
  // 平らな地面 (y = 0) がどこまでも続く座標系。真上は常に +Y
  const plane = { upAt: (p, out) => out.set(0, 1, 0), heightAbove: (p) => p.y };
  const ship = new Ship(FIGHTER);
  ship.flightAssist = false;
  ship.gearDown = true;
  ship.gear = 1;
  ship.body.pos.set(0, 3, 0);
  const gc = new GroundContact();
  const env = {
    speedScale: 1, gravity: new Vector3(0, -9.81, 0), rho: 0, aero: 0, onGround: false, altitude: 3,
  };
  const controls = makeControls();
  let damage = 0;
  for (let i = 0; i < 8 * 120; i++) {
    ship.applyForces(1 / 120, controls, env);
    gc.apply(ship.body, plane, ship.gear, true, 1 / 120);
    damage += gc.damage;
    ship.body.integrate(1 / 120);
  }
  assert(damage === 0, `損傷した: ${damage}`);
  assert(gc.gearContacts === 3 && gc.hullContacts === 0, '脚で立っていない');
  near(ship.body.pos.y, 2.2 - 0.25, 0.05, '止まった高さ');
});
