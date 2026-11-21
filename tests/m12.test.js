import { test, assert, near } from './harness.js';
import { Group, Vector3, Quaternion } from 'three';
import { makeInteriorTerrain, stripAt, stripTheta, CAP_MOUNTAIN } from '../src/universe/habitatTerrain.js';
import { HABITAT } from '../src/universe/habitat.js';
import { HabitatView, DAY_LENGTH } from '../src/render/habitat.js';
import { InteriorTerrain, buildPropCell } from '../src/render/habitatInterior.js';
import { generateSystem } from '../src/universe/system.js';
import { HOME_STAR } from '../src/universe/galaxy.js';
import { Ship, makeControls } from '../src/flight/ship.js';
import { FIGHTER } from '../src/flight/shipParams.js';
import { GroundContact } from '../src/flight/ground.js';

// オニール・シリンダーの中の地形・木と家・昼と夜 (段階3)。

const R = HABITAT.radius, H = HABITAT.length / 2;
const DEF = { radius: R, length: HABITAT.length, seed: 12345 };

test('中の地形: 陸の帯と窓の帯が 60° ごとに交互で、窓と帯の縁は平ら、継ぎ目で連続', () => {
  const T = makeInteriorTerrain(DEF);
  for (let k = 0; k < 3; k++) {
    for (const a of [-0.9, 0, 0.5]) {
      const s = stripAt(stripTheta(k, a));
      assert(s.k === k && Math.abs(s.a - a) < 1e-9, '帯の位置が戻らない');
    }
    // 窓 (帯の中心から 60° = 隣の窓の帯の中心)
    near(T.ground(stripTheta(k, 2), 1234), 0, 0, '窓が平らでない');
    for (let y = -H + 3000; y < H - 3000; y += 1700) {
      assert(T.ground(stripTheta(k, 1.0), y) < 1, '帯の縁が窓とつながらない');
      assert(T.ground(stripTheta(k, -1.0), y) < 1, '帯の縁が窓とつながらない');
    }
  }
  for (const y of [-9000, 0, 7000]) near(T.ground(1e-7, y), T.ground(2 * Math.PI - 1e-7, y), 1e-3, 'θ = 0 と 2π の継ぎ目');
  // θ を負で測っても 0〜2π で測っても、同じ場所は同じ地形 (町と畑の区画も同じ)
  const out1 = [0, 0, 0, 0], out2 = [0, 0, 0, 0];
  for (let th = -1.0; th < 0; th += 0.013) {
    for (let y = -10000; y < 10000; y += 777) {
      const a = T.sample(th, y), b = T.sample(th + 2 * Math.PI, y);
      assert(Math.abs(a.h - b.h) < 1e-6 && Math.abs(a.town - b.town) < 1e-9, `θ の測り方で地形が変わる (θ = ${th.toFixed(3)})`);
      T.color(out1, th, y, 1);
      T.color(out2, th + 2 * Math.PI, y, 1);
      assert(out1.every((v, i) => Math.abs(v - out2[i]) < 1e-6), 'θ の測り方で色が変わる');
    }
  }
});

test('中の地形: 丘・水 (湖と川)・町・両端の段々畑の山がある', () => {
  const T = makeInteriorTerrain(DEF);
  let water = 0, town = 0, n = 0, maxMid = -Infinity, minMid = Infinity;
  for (let k = 0; k < 3; k++) {
    for (let a = -0.95; a <= 0.95; a += 0.05) {
      for (let y = -H + 3000; y <= H - 3000; y += 97) {
        const s = T.sample(stripTheta(k, a), y);
        n++;
        if (s.h <= 0) water++;
        if (s.town > 0.6) town++;
        maxMid = Math.max(maxMid, s.h);
        minMid = Math.min(minMid, s.h);
      }
    }
  }
  assert(water > n * 0.02 && water < n * 0.3, `水の割合 ${(water / n).toFixed(3)}`);
  assert(town > n * 0.02, `町の割合 ${(town / n).toFixed(3)}`);
  assert(maxMid < 130 && minMid > -70, `真ん中の起伏 ${minMid.toFixed(0)}..${maxMid.toFixed(0)} m`);
  // 蓋の前: 帯の中央は高い段々畑の山
  for (let k = 0; k < 3; k++) {
    for (const y of [H - 200, -H + 200]) {
      const h = T.ground(stripTheta(k, 0), y);
      assert(h > CAP_MOUNTAIN * 0.8 && h < CAP_MOUNTAIN + 20, `蓋の前の山 ${h.toFixed(0)} m`);
    }
  }
});

test('中の地形: 描いたチャンクの頂点は、当たり判定の地面の上にある', () => {
  const view = new HabitatView(generateSystem(HOME_STAR).habitats[0]);
  const group = new Group();
  const tv = new InteriorTerrain(view.def, view.terrain, view.dayUniforms, group);
  const cam = new Vector3(0, -6000, R - 300); // 陸の帯 0 の上
  tv.update(cam); // 最初は全部を粗く
  for (let i = 0; i < 40; i++) tv.update(cam); // 近くを細かくする
  const near1 = tv.chunks.filter((c) => c.seg >= 32);
  assert(near1.length > 0, 'カメラの近くのチャンクが細かくならない');
  const p = new Vector3();
  let checked = 0;
  for (const c of near1.slice(0, 3)) {
    const pos = c.mesh.geometry.attributes.position;
    const V = c.seg + 1;
    for (let i = 0; i < V * V; i += 37) {
      p.fromBufferAttribute(pos, i);
      assert(Math.abs(view.heightAbove(p)) < 0.05, `頂点が地面からずれている: ${view.heightAbove(p)}`);
      checked++;
    }
  }
  assert(checked > 50, `調べた頂点が少ない (${checked})`);
});

test('木と家: 同じ区画からは同じものができ、家は町に、木は水の外の地面に立つ', () => {
  const T = makeInteriorTerrain(DEF);
  let houses = 0, trees = 0;
  for (let i = 0; i < 126; i += 3) {
    for (let j = -70; j < 70; j += 5) {
      const a = buildPropCell(DEF, T, i, j), b = buildPropCell(DEF, T, i, j);
      assert(JSON.stringify(a) === JSON.stringify(b), '決定論的でない');
      for (const h of a.houses) {
        const s = T.sample(h.th, h.y);
        assert(s.town >= 0.6 && s.h > 1, '町の外に家がある');
        near(h.h, s.h, 1e-9, '家の地面の高さ');
        houses++;
      }
      for (const t of a.trees) {
        const s = T.sample(t.th, t.y);
        assert(s.land && s.h > 1.5, '水の中か窓の上に木がある');
        trees++;
      }
    }
  }
  assert(houses > 30 && trees > 300, `家 ${houses}, 木 ${trees}`);
});

test('昼と夜: 鏡を開いた昼は明るく、閉じた夜は暗い。光は昼ほど高い角度から差す', () => {
  const view = new HabitatView(generateSystem(HOME_STAR).habitats[0]);
  // 昼 = 太陽の高さ 1 になる時刻、夜 = -1 になる時刻
  const noon = (0.5 - 0.3) * DAY_LENGTH, midnight = (1 - 0.3) * DAY_LENGTH;
  view.updateDay(noon);
  near(view.elev, 1, 1e-9, '昼の高さ');
  near(view.day, 1, 1e-9, '昼の明るさ');
  const m = view.mirrors[0];
  const openNoon = 2 * Math.acos(Math.min(1, Math.abs(m.base.clone().invert().multiply(m.mesh.quaternion).w)));
  const p = new Vector3(0, 0, R - 10), up = view.upAt(p, new Vector3());
  const lNoon = view.lightDirAt(p, new Vector3()).dot(up);
  view.updateDay(midnight);
  near(view.elev, -1, 1e-9, '夜の高さ');
  near(view.day, 0, 1e-9, '夜の明るさ');
  const openNight = 2 * Math.acos(Math.min(1, Math.abs(m.base.clone().invert().multiply(m.mesh.quaternion).w)));
  assert(openNoon > 0.45 && openNight < 0.05, `鏡の開き 昼 ${openNoon.toFixed(2)} / 夜 ${openNight.toFixed(2)} rad`);
  view.updateDay(0.25 * DAY_LENGTH - 0.3 * DAY_LENGTH + DAY_LENGTH + 0.02 * DAY_LENGTH); // 夜明けすぐ
  const lDawn = view.lightDirAt(p, new Vector3()).dot(up);
  assert(lNoon > lDawn + 0.3, `光の角度 昼 ${lNoon.toFixed(2)} / 朝 ${lDawn.toFixed(2)}`);
  // ゲームの開始 (t = 0) は朝
  view.updateDay(0);
  assert(view.day > 0.5 && view.elev < 0.9, `開始時刻 明るさ ${view.day.toFixed(2)} 高さ ${view.elev.toFixed(2)}`);
});

test('中の地形: 町の平らな地面に、3本の脚で静かに着陸できる', () => {
  const view = new HabitatView(generateSystem(HOME_STAR).habitats[0]);
  const T = view.terrain;
  // 町の真ん中を探す
  let spot = null;
  for (let k = 0; k < 3 && !spot; k++) {
    for (let a = -0.6; a <= 0.6 && !spot; a += 0.02) {
      for (let y = -H + 3500; y < H - 3500 && !spot; y += 50) {
        const th = stripTheta(k, a);
        if (T.sample(th, y).town > 0.99 && T.sample(th + 0.01, y).town > 0.99 && T.sample(th, y + 40).town > 0.99) spot = { th, y };
      }
    }
  }
  assert(spot, '町が見つからない');
  const ship = new Ship(FIGHTER);
  ship.flightAssist = false;
  ship.gearDown = true;
  ship.gear = 1;
  const b = ship.body;
  view.surfacePoint(new Vector3(Math.sin(spot.th), spot.y, Math.cos(spot.th)), 3, b.pos);
  const up = view.upAt(b.pos, new Vector3());
  b.quat.copy(new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), up));
  const gc = new GroundContact();
  const env = { speedScale: 1, gravity: new Vector3(), rho: 0, aero: 0, onGround: false };
  const c = makeControls();
  let damage = 0;
  for (let i = 0; i < 8 * 120; i++) {
    view.gravityAt(b.pos, env.gravity);
    ship.applyForces(1 / 120, c, env);
    gc.apply(b, view, ship.gear, true, 1 / 120);
    damage += gc.damage;
    b.integrate(1 / 120);
  }
  assert(damage === 0, `損傷した: ${damage}`);
  assert(gc.gearContacts === 3 && gc.hullContacts === 0, '脚で立っていない');
  near(view.heightAbove(b.pos), 2.2 - 0.25, 0.1, '止まった高さ');
});
