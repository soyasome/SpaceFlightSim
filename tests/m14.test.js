// 実寸の惑星 (docs/design-real-scale.md)
import { test, assert, near } from './harness.js';
import { HOME_STAR, starById, sectorStars } from '../src/universe/galaxy.js';
import {
  generateSystem, SCALES, insideParentFrame, gravityFromDensity, FRAME_EXIT, REAL_SCALE,
} from '../src/universe/system.js';
import { Settings, SETTING_DEFS } from '../src/core/settings.js';
import { makeTerrain } from '../src/terrain/terrainFn.js';
import { Vector3, Quaternion } from 'three';
import { RigidBody } from '../src/physics/body.js';
import { enterFrame, leaveFrame, fictitiousAccel } from '../src/physics/frame.js';

// 天体の半径と位置をまとめた数。段階0 を入れる前の値で、ゲーム用の星系が変わっていないことを確かめる
const fingerprint = (sys) => sys.planets.reduce((a, p) =>
  a + p.radius + (Math.abs(p.position[0]) + Math.abs(p.position[1]) + Math.abs(p.position[2])) / 1e6, 0);
const BEFORE = [
  ['0,0,0,0', 17, 37522997.088867076], // SOL
  ['0,0,0,1', 4, 1643845.9790614902],
  ['0,0,0,2', 5, 2898130.2982111066],
  ['3,-1,2,0', 2, 1071140.4194586189],
];

test('縮尺: 省くとゲーム用になり、ゲーム用の星系は前と同じ', () => {
  for (const [id, count, fp] of BEFORE) {
    const star = id === HOME_STAR.id ? HOME_STAR : starById(id);
    assert(star, `恒星 ${id} がない`);
    const a = generateSystem(star);
    const b = generateSystem(star, { scale: 'game' });
    assert(a.scale === 'game' && b.scale === 'game', `${id}: 縮尺 ${a.scale} / ${b.scale}`);
    assert(JSON.stringify(a) === JSON.stringify(b), `${id}: 省いたときとゲーム用で星系が違う`);
    assert(a.planets.length === count, `${id}: 天体の数 ${a.planets.length}`);
    near(fingerprint(a), fp, 1e-3, `${id}: 天体の半径と位置`);
  }
});

test('縮尺: 実寸を選べて、知らない縮尺は受け付けない', () => {
  assert(SCALES.includes('game') && SCALES.includes('real'), '選べる縮尺');
  assert(generateSystem(HOME_STAR, { scale: 'real' }).scale === 'real', '実寸の星系に縮尺が書いてある');
  let threw = false;
  try {
    generateSystem(HOME_STAR, { scale: 'huge' });
  } catch {
    threw = true;
  }
  assert(threw, '知らない縮尺で星系を作れてしまう');
});

test('設定: 惑星の大きさは既定でゲーム用、保存された値がない選択肢なら既定に戻す', () => {
  const def = SETTING_DEFS.find((d) => d.key === 'planetScale');
  assert(def && def.type === 'select' && def.def === 'game', '設定項目');
  assert(def.options.every((o) => SCALES.includes(o.value)) && def.options.length === SCALES.length, '選択肢が SCALES と合う');

  const KEY = 'starwake.settings.v1';
  let saved = null;
  try {
    saved = localStorage.getItem(KEY);
  } catch {
    return; // 保存領域が使えない環境では確かめられない
  }
  try {
    localStorage.setItem(KEY, JSON.stringify({ planetScale: 'real' }));
    assert(new Settings().planetScale === 'real', '保存した実寸が読めない');
    localStorage.setItem(KEY, JSON.stringify({ planetScale: 'huge' }));
    assert(new Settings().planetScale === 'game', 'ない選択肢を読み込んでしまう');
  } finally {
    if (saved === null) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, saved);
  }
});

// --- 段階1: 地形の細かさ ---

// 球の上にほぼ均等に並べた n 個の方向 (フィボナッチ球面)
function* sphereDirs(n) {
  for (let i = 0; i < n; i++) {
    const a = i * 2.399963, y = 1 - (2 * i + 1) / n, r = Math.sqrt(1 - y * y);
    yield [Math.cos(a) * r, y, Math.sin(a) * r];
  }
}

// 地形の種類ごとの定義。段階1 を入れる前の値と比べる
const TERRAIN_CASES = [
  { seed: 2024, radius: 400e3 },
  { seed: 7, radius: 300e3, terrain: { type: 'desert', land: 0.1, cAmp: 1800, mAmp: 3000, hAmp: 250 } },
  { seed: 11, radius: 250e3, terrain: { type: 'rock', land: -0.1, cAmp: 1500, mAmp: 2500, hAmp: 200 } },
  { seed: 13, radius: 200e3, terrain: { type: 'ice', land: 0.0, cAmp: 1200, mAmp: 2000, hAmp: 150 } },
  { seed: 17, radius: 350e3, terrain: { type: 'lava', land: 0.0, cAmp: 1500, mAmp: 2500, hAmp: 200 } },
  { seed: 19, radius: 400e3, terrain: { type: 'city', land: 0.2, cAmp: 1600, mAmp: 1400, hAmp: 120 } },
];
// [標高の合計, 色の合計, 街と森の合計]
const TERRAIN_BEFORE = [
  [695973.6235671813, 1341.4150898602602, 66.18105493912192],
  [732189.7087237968, 1022.4431464009095, 0],
  [-65339.77694613669, 628.0484062364881, 0],
  [31144.899175052633, 2102.4721297960277, 0],
  [257685.17788013926, 589.9322877364233, 0],
  [447105.24273775995, 1385.865836100543, 157.61129431566832],
];

test('地形: 細かさの倍率 1 (ゲーム用) では、標高・色・森・街が前と同じ', () => {
  TERRAIN_CASES.forEach((def, i) => {
    for (const d of [def, { ...def, detailScale: 1 }]) {
      const t = makeTerrain(d);
      let sh = 0, sc = 0, su = 0;
      const c = [0, 0, 0, 0];
      for (const [x, y, z] of sphereDirs(400)) {
        for (const wl of [1, 40, 2000]) sh += t.height(x, y, z, wl);
        const h = t.height(x, y, z, 1);
        t.color(c, h, 0.95, x, y, z);
        sc += c[0] + c[1] * 2 + c[2] * 3 + c[3] * 4;
        su += t.urban(h, x, y, z) + t.forest(h, x, y, z);
      }
      const name = def.terrain ? def.terrain.type : 'terran';
      near(sh, TERRAIN_BEFORE[i][0], 1e-6, `${name}: 標高`);
      near(sc, TERRAIN_BEFORE[i][1], 1e-9, `${name}: 色`);
      near(su, TERRAIN_BEFORE[i][2], 1e-9, `${name}: 森と街`);
    }
  });
});

/**
 * 地形の大まかな性質: 陸の割合、最高点、周り 1 km の起伏 (傾きを除いた標準偏差の平均, m)。
 * 傾きを除くのは、大陸のゆるやかな傾きの差 (実寸では大陸が 16 倍に広がり、傾きが 1/16 になる) を数えないため。
 */
function terrainStats(t, R, n) {
  let land = 0, max = -Infinity, rough = 0, count = 0;
  const hs = new Array(8);
  for (const [x, y, z] of sphereDirs(n)) {
    const h = t.height(x, y, z, 1);
    max = Math.max(max, h);
    if (h <= 0) continue;
    land++;
    // 接平面の2つの向き u, v
    const ul = Math.hypot(z, x) || 1;
    const ux = -z / ul, uz = x / ul;
    const vx = y * uz, vy = z * ux - x * uz, vz = -y * ux;
    let m = 0, A = 0, B = 0;
    for (let k = 0; k < 8; k++) {
      const c = Math.cos((k * Math.PI) / 4), s = Math.sin((k * Math.PI) / 4), d = 500 / R;
      const px = x + (ux * c + vx * s) * d, py = y + vy * s * d, pz = z + (uz * c + vz * s) * d;
      const l = Math.hypot(px, py, pz);
      hs[k] = t.height(px / l, py / l, pz / l, 1);
      m += hs[k] / 8; A += (hs[k] * c) / 4; B += (hs[k] * s) / 4;
    }
    let v = 0;
    for (let k = 0; k < 8; k++) {
      const e = hs[k] - m - A * Math.cos((k * Math.PI) / 4) - B * Math.sin((k * Math.PI) / 4);
      v += (e * e) / 8;
    }
    rough += Math.sqrt(v);
    count++;
  }
  return { land: land / n, max, rough: rough / Math.max(1, count) };
}

test('地形: 実寸 (半径 16 倍・細かさ 16 倍) でも、山の高さと 1 km の起伏はゲーム用と同じくらい', () => {
  for (const def of TERRAIN_CASES.slice(0, 4)) {
    const name = def.terrain ? def.terrain.type : 'terran';
    const game = terrainStats(makeTerrain(def), def.radius, 1500);
    const R = def.radius * 16;
    const real = terrainStats(makeTerrain({ ...def, radius: R, detailScale: 16 }), R, 1500);
    // 大陸の形は球に合わせて広げるので、陸の割合はほぼ同じ
    near(real.land, game.land, 0.05, `${name}: 陸の割合`);
    const hr = real.max / game.max, rr = real.rough / game.rough;
    assert(hr > 0.7 && hr < 1.4, `${name}: 最高点 ${real.max.toFixed(0)} m (ゲーム用 ${game.max.toFixed(0)} m)`);
    assert(rr > 0.5 && rr < 2, `${name}: 1 km の起伏 ${real.rough.toFixed(1)} m (ゲーム用 ${game.rough.toFixed(1)} m)`);
    // 倍率を掛けないと、模様が 16 倍に引き伸ばされて起伏がほとんどなくなる (倍率が効いていることの確認)
    const naive = terrainStats(makeTerrain({ ...def, radius: R }), R, 300);
    assert(naive.rough < real.rough * 0.7, `${name}: 倍率なしの起伏 ${naive.rough.toFixed(1)} m が実寸と変わらない`);
  }
});

test('地形: ゲーム用の星系の天体は、細かさの倍率 1 で作る', () => {
  for (const star of [HOME_STAR, starById('0,0,0,1'), starById('0,0,0,2')]) {
    for (const p of generateSystem(star).planets) {
      assert((p.detailScale ?? 1) === 1, `${p.name}: 細かさの倍率 ${p.detailScale}`);
    }
  }
});

// --- 段階2: 回る座標系の見かけの力 ---

/**
 * 回る座標系の中で、力をかけずに t 秒進めてから世界座標に戻す。
 * withFictitious = false なら見かけの力を省く (ゲーム用の大きさの惑星と同じ)。
 * 世界から見て等速直線運動なら、戻した位置は x0 + v0 t になるはず。
 */
function driftInFrame(planet, x0, v0, t, h, withFictitious) {
  const tilt = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), 0.4);
  const yAxis = new Vector3(0, 1, 0);
  const setTime = (s) => planet.quat.copy(tilt).multiply(new Quaternion().setFromAxisAngle(yAxis, planet.omega * s));
  setTime(0);
  const b = new RigidBody();
  b.pos.copy(x0);
  b.vel.copy(v0);
  enterFrame(b, planet);
  const a = new Vector3();
  const n = Math.round(t / h);
  for (let i = 1; i <= n; i++) {
    a.set(0, 0, 0);
    if (withFictitious) fictitiousAccel(planet.omega, b.pos, b.vel, a);
    b.applyForce(a.multiplyScalar(b.mass));
    b.integrate(h);
    setTime(i * h);
  }
  leaveFrame(b, planet);
  return b;
}

test('見かけの力: 回る座標系で力をかけずに進めても、世界から見て等速直線運動のまま', () => {
  // 実寸の木星 (自転 9.93 時間) の、座標系に入るあたり (半径の 6 倍)
  const planet = { pos: new Vector3(3e9, -2e8, 1e9), quat: new Quaternion(), omega: (2 * Math.PI) / 35730 };
  const x0 = planet.pos.clone().add(new Vector3(3.2e8, 1.1e8, -2.4e8));
  const v0 = new Vector3(1200, -300, 800);
  const t = 120;
  const expect = x0.clone().addScaledVector(v0, t);
  const b = driftInFrame(planet, x0, v0, t, 1 / 120, true);
  // 座標系の中では、自転の速さ (約 7 万 m/s) で 840 万 m 動く。ずれは物理の刻み (半陰的オイラー法) によるもので、
  // 120 秒で約 7 m (動いた距離の 1e-6)。刻みを半分にすると半分になる
  const err = b.pos.distanceTo(expect);
  assert(err < 20, `位置のずれ ${err.toFixed(3)} m`);
  assert(b.vel.distanceTo(v0) < 0.05, `速度のずれ ${b.vel.distanceTo(v0).toFixed(4)} m/s`);
  const half = driftInFrame(planet, x0, v0, t, 1 / 240, true).pos.distanceTo(expect);
  near(half / err, 0.5, 0.05, '刻みを半分にしたときのずれの比');
  // 省くと、同じ時間で数十 km ずれる (足していることの確認)
  const naive = driftInFrame(planet, x0, v0, t, 1 / 120, false);
  assert(naive.pos.distanceTo(expect) > 10e3, `見かけの力を省いたときのずれ ${naive.pos.distanceTo(expect).toFixed(0)} m`);
});

test('見かけの力: 遠心力は軸から外向き ω²r、コリオリ力は −2ω × v', () => {
  const w = 1e-3;
  const a = fictitiousAccel(w, new Vector3(1000, 500, -2000), null, new Vector3());
  near(a.x, w * w * 1000, 1e-12, '遠心力 x');
  near(a.y, 0, 0, '遠心力 y (軸の向きには働かない)');
  near(a.z, w * w * -2000, 1e-12, '遠心力 z');
  // 東 (+X) へ動くと、Y 軸まわりの左回りの座標系では −2ω × v = 2ω (0, 0, vx) の向きに曲げられる
  const c = fictitiousAccel(w, new Vector3(), new Vector3(100, 0, 0), new Vector3());
  near(c.z, 2 * w * 100, 1e-12, 'コリオリ力 z');
  near(c.x, 0, 1e-12, 'コリオリ力 x');
  const s = new Vector3(3, 4, 5);
  assert(fictitiousAccel(w, new Vector3(1, 2, 3), new Vector3(0, 7, 0), s) === s, '結果は out に足す');
  near(s.y, 4, 0, '鉛直方向の速度ではコリオリ力が出ない (Y 軸と平行)');
});

test('見かけの力: ゲーム用の惑星では足さず、実寸の定義 (fictitious) でだけ足す', () => {
  for (const p of generateSystem(HOME_STAR).planets) assert(!p.fictitious, `${p.name} がゲーム用なのに見かけの力を足す`);
});

// --- 段階3〜5: 実寸の星系 ---

test('実寸の SOL: 半径・衛星までの距離・自転・重力が本物になる', () => {
  const sys = generateSystem(HOME_STAR, { scale: 'real' });
  const by = Object.fromEntries(sys.planets.map((p) => [p.name, p]));
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  // [名前, 半径 (km), 親からの距離 (km) | null, 重力 (m/s²)]
  const REAL = [
    ['TERRA', 6371, null, 9.81], ['LUNA', 1737, 384400, 1.62], ['MERCURIUS', 2440, null, 3.7],
    ['VENUS', 6052, null, 8.87], ['MARS', 3390, null, 3.72], ['PHOBOS', 11.1, 9376, 0.0057],
    ['DEIMOS', 6.2, 23463, 0.003], ['IUPPITER', 69911, null, 24.79], ['IO', 1822, 421700, 1.8],
    ['EUROPA', 1561, 671034, 1.31], ['GANYMEDES', 2634, 1070412, 1.43], ['CALLISTO', 2410, 1882709, 1.24],
    ['SATURNUS', 58232, null, 10.44], ['TITAN', 2575, 1221870, 1.35], ['URANUS', 25362, null, 8.69],
    ['NEPTUNUS', 24622, null, 11.15], ['TRITON', 1353, 354759, 0.78],
  ];
  assert(sys.planets.length === REAL.length, `天体の数 ${sys.planets.length}`);
  for (const [name, r, d, g] of REAL) {
    const p = by[name];
    near(p.radius, r * 1e3, 1, `${name}: 半径`);
    near(p.gravity, g, 1e-9, `${name}: 重力`);
    assert(p.fictitious === true, `${name}: 見かけの力を足さない`);
    if (d !== null) {
      // around() は軌道面から 5% 持ち上げるので、中心からの距離は √(1 + 0.05²) 倍 (LUNA だけは向きを決めて置くのでそのまま)
      const lift = name === 'LUNA' ? 1 : Math.hypot(1, 0.05);
      near(dist(p.position, sys.planets[p.parent].position), d * 1e3 * lift, 1e3, `${name}: 親からの距離`);
    }
  }
  near(by.TERRA.rotationPeriod, 86164, 1, 'TERRA の自転 (恒星日)');
  near(by.IUPPITER.rotationPeriod / 3600, 9.93, 0.01, '木星の自転 (時間)');
  near(by.SATURNUS.rings.outer / by.SATURNUS.radius, 2.27, 1e-9, '土星の環の外側');
  // 軌道半径 (天文単位) はゲーム用と同じ
  const game = generateSystem(HOME_STAR);
  for (const p of game.planets.filter((q) => q.parent === null && q.name !== 'TERRA')) {
    assert(dist(p.position, by[p.name].position) < 1, `${p.name}: 軌道がゲーム用と違う`);
  }
});

test('実寸の SOL: 地形の起伏と模様の大きさは、天体ごとにゲーム用と同じ', () => {
  const real = generateSystem(HOME_STAR, { scale: 'real' }).planets;
  const game = generateSystem(HOME_STAR).planets;
  real.forEach((p, i) => {
    const g = game[i];
    near(p.detailScale, p.radius / g.radius, 1e-9, `${p.name}: 細かさの倍率 = 実寸の半径 ÷ ゲーム用の半径`);
    if (p.terrain && g.terrain) {
      // 本物の地形のマップを使う天体 (TERRA) は起伏の数値を持たない (高さはマップ。倍率は m15 で確かめる)
      for (const k of ['cAmp', 'mAmp', 'hAmp']) {
        if (g.terrain[k] !== undefined) near(p.terrain[k], g.terrain[k], 1e-6, `${p.name}: ${k}`);
      }
    }
  });
});

test('実寸の SOL: 開始位置は TERRA の座標系の外で、小惑星帯がそばにある', () => {
  const sys = generateSystem(HOME_STAR, { scale: 'real' });
  const terra = sys.planets[0];
  const d = Math.hypot(...sys.start.map((v, i) => v - terra.position[i]));
  assert(d > terra.radius * FRAME_EXIT, `開始位置から TERRA まで ${(d / terra.radius).toFixed(2)} 半径`);
  near(d / terra.radius, Math.hypot(0.9e6, 0.3e6, 3.2e6) / 400e3, 0.01, 'ゲーム用と同じ比 (半径の約 8.4 倍)');
  const belt = Math.hypot(...sys.belt.position.map((v, i) => v - sys.start[i]));
  assert(belt < 20e3, `小惑星帯まで ${belt.toFixed(0)} m`);
  const beltToTerra = Math.hypot(...sys.belt.position.map((v, i) => v - terra.position[i]));
  assert(beltToTerra > terra.radius * FRAME_EXIT + 50e3, '小惑星帯が TERRA の座標系に入っている');
  near(Math.hypot(...sys.start), Math.hypot(...generateSystem(HOME_STAR).start), 0, '開始位置はゲーム用と同じ');
});

test('衛星の座標系: 実寸の SOL で親の座標系の中にあるのは IO と PHOBOS だけ', () => {
  const sys = generateSystem(HOME_STAR, { scale: 'real' });
  const inside = sys.planets.filter((p) => p.parent !== null && insideParentFrame(p, sys.planets[p.parent])).map((p) => p.name);
  assert(JSON.stringify(inside.sort()) === JSON.stringify(['IO', 'PHOBOS']), `親の座標系の中の衛星: ${inside.join(', ')}`);
  const game = generateSystem(HOME_STAR);
  assert(game.planets.every((p) => p.parent === null || !insideParentFrame(p, game.planets[p.parent])),
    'ゲーム用で親の座標系の中に衛星がある');
});

test('衛星の座標系: 親の座標系を出ずに衛星の座標系へ乗り換えても、世界座標の位置と速度は変わらない', () => {
  // game.js の setFrame と同じ順番: 親を出る (leaveFrame) → 衛星に入る (enterFrame) → 衛星を出る
  const parent = { pos: new Vector3(1e9, 0, 0), quat: new Quaternion().setFromAxisAngle(new Vector3(0.3, 1, 0).normalize(), 0.7), omega: 1.76e-4 };
  const moon = { pos: new Vector3(1e9 + 4.2e8, 2e7, 0), quat: new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), 2.1), omega: 4.1e-5 };
  const b = new RigidBody();
  b.pos.set(1e9 + 4.15e8, 1.9e7, 3e6);
  b.vel.set(-800, 120, 2500);
  const p0 = b.pos.clone(), v0 = b.vel.clone();
  enterFrame(b, parent);
  leaveFrame(b, parent);
  enterFrame(b, moon);
  leaveFrame(b, moon);
  near(b.pos.distanceTo(p0), 0, 1e-4, '位置');
  near(b.vel.distanceTo(v0), 0, 1e-6, '速度');
});

test('実寸のランダムな星系: 天体の種類と並びはゲーム用と同じで、座標系が地面に重ならない', () => {
  let systems = 0, moons = 0;
  for (let ix = -2; ix <= 2; ix++) {
    for (let iz = -2; iz <= 2; iz++) {
      for (const star of sectorStars(ix, 0, iz)) {
        if (star.home) continue;
        const g = generateSystem(star), r = generateSystem(star, { scale: 'real' });
        assert(r.planets.length === g.planets.length, `${star.name}: 天体の数`);
        r.planets.forEach((p, i) => {
          const q = g.planets[i];
          assert(p.type === q.type && p.name === q.name, `${star.name}: ${p.name} の種類`);
          near(p.radius, q.radius * REAL_SCALE, 1e-6, `${p.name}: 半径`);
          assert(p.detailScale === REAL_SCALE && p.fictitious === true, `${p.name}: 実寸の印`);
          assert(p.gravity > 0.5 && p.gravity < 30, `${p.name}: 重力 ${p.gravity.toFixed(2)}`);
          if (p.parent === null) {
            assert(Math.hypot(...p.position.map((v, k) => v - q.position[k])) < 1, `${p.name}: 軌道がゲーム用と違う`);
          } else {
            moons++;
            const par = r.planets[p.parent];
            const d = Math.hypot(...p.position.map((v, k) => v - par.position[k]));
            const ground = par.radius + (par.atmosphere ? par.atmosphere.height : 0);
            assert(d - p.radius * FRAME_EXIT > ground, `${p.name}: 衛星の座標系が親の地面か大気にかかる`);
          }
        });
        // 惑星 (衛星でない) どうしの座標系は重ならない
        const tops = r.planets.filter((p) => p.parent === null);
        for (let i = 0; i < tops.length; i++) {
          for (let j = i + 1; j < tops.length; j++) {
            const d = Math.hypot(...tops[i].position.map((v, k) => v - tops[j].position[k]));
            assert(d > (tops[i].radius + tops[j].radius) * FRAME_EXIT, `${tops[i].name} と ${tops[j].name} の座標系が重なる`);
          }
        }
        systems++;
      }
    }
  }
  assert(systems > 10 && moons > 5, `調べた星系 ${systems}、衛星 ${moons}`);
});

test('重力: 密度から計算すると、地球と同じ密度・半径で 9.8 m/s²', () => {
  near(gravityFromDensity(6371e3, 5514), 9.82, 0.01, '地球');
  near(gravityFromDensity(69911e3, 1326), 25.9, 0.1, '木星 (一様な球とみなした値。本物は 24.8)');
});
