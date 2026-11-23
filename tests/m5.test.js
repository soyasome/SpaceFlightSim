import { test, assert, near } from './harness.js';
import {
  sectorStars, sectorSeed, starsNear, nearestStar, starById, HOME_STAR, LY, AU, SECTOR, MIN_SPACING,
} from '../src/universe/galaxy.js';
import { generateSystem, FRAME_EXIT, FRAME_ENTER } from '../src/universe/system.js';
import { cruiseScale, CRUISE } from '../src/flight/cruise.js';
import { makeTerrain } from '../src/terrain/terrainFn.js';
import { formatDistance, formatSpeed, formatTime } from '../src/ui/hud.js';
import { FIGHTER } from '../src/flight/shipParams.js';

const dist3 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

test('銀河: 同じ区画からは必ず同じ恒星ができ、出発地の恒星が含まれる', () => {
  const a = JSON.stringify(sectorStars(3, -7, 12));
  const b = JSON.stringify(sectorStars(3, -7, 12));
  assert(a === b, '決定論的でない');
  assert(sectorStars(0, 0, 0)[0] === HOME_STAR, '出発地がない');
  assert(starById(HOME_STAR.id) === HOME_STAR, 'id で引けない');
  // どこまで行っても星がある (遠い区画でも同じ密度)
  let count = 0;
  for (let i = 0; i < 300; i++) count += sectorStars(100000 + i, -50000 + i * 3, 7 * i).length;
  assert(count > 200 && count < 500, `遠くの密度がおかしい: ${count}`);
});

test('銀河: 符号違いや鏡像の区画でも、同じ恒星が複製されない', () => {
  // 以前は -1,-1,-1 / -1,1,1 / 1,-1,1 が同じ種になり、同じ恒星 (SORANCE) が 3 つできていた
  const seeds = new Map();
  const starSeeds = new Map();
  const clones = new Map();
  for (let ix = -3; ix <= 3; ix++) for (let iy = -3; iy <= 3; iy++) for (let iz = -3; iz <= 3; iz++) {
    const key = `${ix},${iy},${iz}`;
    const seed = sectorSeed(ix, iy, iz);
    assert(!seeds.has(seed), `区画 ${key} と ${seeds.get(seed)} の種が同じ: ${seed}`);
    seeds.set(seed, key);
    for (const s of sectorStars(ix, iy, iz)) {
      if (s.home) continue;
      assert(!starSeeds.has(s.seed), `恒星 ${s.id} と ${starSeeds.get(s.seed)} の種が同じ: ${s.seed}`);
      starSeeds.set(s.seed, s.id);
      // 名前と区画内の位置が同じ = 複製された恒星
      const local = s.pos.map((v, i) => (v - s.sector[i] * SECTOR).toFixed(6)).join(',');
      const sig = `${s.name}@${local}`;
      assert(!clones.has(sig), `恒星 ${s.id} と ${clones.get(sig)} が同じ (${s.name})`);
      clones.set(sig, s.id);
    }
  }
  assert(starSeeds.size > 150, `星が少ない: ${starSeeds.size}`);
});

test('銀河: 恒星どうしは近づきすぎず、区画をまたいでも守られる', () => {
  let stars = [];
  for (let ix = -3; ix <= 3; ix++) for (let iy = -2; iy <= 2; iy++) for (let iz = -3; iz <= 3; iz++) {
    const list = sectorStars(ix, iy, iz);
    for (const s of list) {
      assert(Math.floor(s.pos[0] / SECTOR) === ix && Math.floor(s.pos[1] / SECTOR) === iy && Math.floor(s.pos[2] / SECTOR) === iz,
        '区画の外に置かれている');
    }
    stars = stars.concat(list);
  }
  let min = Infinity;
  for (let i = 0; i < stars.length; i++) for (let j = i + 1; j < stars.length; j++) {
    min = Math.min(min, dist3(stars[i].pos, stars[j].pos));
  }
  assert(stars.length > 150, `星が少ない: ${stars.length}`);
  assert(min >= MIN_SPACING - 1e-9, `近すぎる組がある: ${min} 光年`);
  assert(new Set(stars.map((s) => s.id)).size === stars.length, 'id が重複している');
});

test('銀河: 近くの恒星の検索は、総当たりと同じ結果を近い順に返す', () => {
  const pos = [13.2, -4.7, 28.9];
  const found = starsNear(pos, 18);
  let brute = [];
  for (let ix = -2; ix <= 4; ix++) for (let iy = -3; iy <= 2; iy++) for (let iz = 0; iz <= 5; iz++) {
    brute = brute.concat(sectorStars(ix, iy, iz).filter((s) => dist3(s.pos, pos) <= 18));
  }
  assert(found.length === brute.length && found.length > 5, `数が違う: ${found.length} / ${brute.length}`);
  for (let i = 1; i < found.length; i++) assert(found[i].dist >= found[i - 1].dist, '近い順でない');
  assert(nearestStar(pos).star === found[0].star, 'いちばん近い恒星が違う');
});

test('星系: 何度作っても同じで、天体の座標系が重ならず、数値が範囲に収まる', () => {
  let systems = 0, bodies = 0;
  const types = new Set();
  for (const { star } of starsNear([5, 5, 5], 60)) {
    const sys = generateSystem(star);
    assert(JSON.stringify(sys) === JSON.stringify(generateSystem(star)), `${star.name}: 決定論的でない`);
    const ps = sys.planets;
    assert(ps.length >= 2 && ps.length <= 24, `${star.name}: 天体の数 ${ps.length}`);
    assert(new Set(ps.map((p) => p.key)).size === ps.length, `${star.name}: key が重複`);
    for (let i = 0; i < ps.length; i++) {
      const p = ps[i];
      types.add(p.type);
      assert(p.radius >= 50e3 && p.radius <= 4000e3, `${p.name}: 半径 ${p.radius}`);
      assert(p.gravity > 1 && p.gravity < 30, `${p.name}: 重力 ${p.gravity}`);
      assert(p.rotationPeriod > 1000, `${p.name}: 自転`);
      assert(p.type === 'gas' ? !!p.gas && !p.terrain : !!p.terrain || star.home, `${p.name}: 地形の定義`);
      // 恒星に近すぎない
      assert(Math.hypot(...p.position) > star.radius * 10, `${p.name}: 恒星に近すぎる`);
      for (let j = i + 1; j < ps.length; j++) {
        const gap = dist3(p.position, ps[j].position);
        assert(gap > (p.radius + ps[j].radius) * FRAME_EXIT, `${p.name} と ${ps[j].name} の座標系が重なる`);
      }
    }
    for (const z of sys.zones) {
      assert(z.roster.length >= 1 && z.roster.length <= 5, '哨戒隊の数');
      if (z.kind === 'belt') assert(!!sys.belt, '小惑星帯がないのに哨戒隊がいる');
      else assert(!!ps[z.planet] && !ps[z.planet].gas, '哨戒隊の惑星が不正');
    }
    systems++;
    bodies += ps.length;
  }
  assert(systems > 500, `調べた星系が少ない: ${systems}`);
  for (const t of ['terran', 'desert', 'ice', 'lava', 'rock', 'gas']) assert(types.has(t), `${t} が一度も出ない`);
});

test('星系: 出発地は M1〜M4 と同じ配置 (TERRA と小惑星帯が開始位置のそばにある)', () => {
  const sys = generateSystem(HOME_STAR);
  const a = sys.planets[0];
  assert(a.name === 'TERRA' && a.seed === 2024 && a.radius === 400e3 && a.terrain.maps.height === 'earth-height', 'TERRA が変わった');
  near(dist3(a.position, sys.start), Math.hypot(0.9e6, 0.3e6, 3.2e6), 1, '開始位置から TERRA まで');
  near(dist3(sys.belt.position, sys.start), Math.hypot(600, 9000), 1, '開始位置から小惑星帯まで');
  near(Math.hypot(...sys.start), Math.hypot(0.5e11, 0.45e11, 1.3e11), 1, '恒星までの距離');
});

test('星系: 出発地は太陽系に似せてある (8つの惑星が本物と同じ順に並び、土星に環がある)', () => {
  const sys = generateSystem(HOME_STAR);
  assert(HOME_STAR.name === 'SOL', '恒星の名前');
  const order = sys.planets.filter((p) => p.parent === null)
    .sort((a, b) => Math.hypot(...a.position) - Math.hypot(...b.position)).map((p) => p.name);
  const expect = ['MERCURIUS', 'VENUS', 'TERRA', 'MARS', 'IUPPITER', 'SATURNUS', 'URANUS', 'NEPTUNUS'];
  assert(JSON.stringify(order) === JSON.stringify(expect), `惑星の並び: ${order.join(', ')}`);
  const byName = Object.fromEntries(sys.planets.map((p) => [p.name, p]));
  const parentOf = (n) => sys.planets[byName[n].parent].name;
  for (const [m, p] of [['LUNA', 'TERRA'], ['PHOBOS', 'MARS'], ['DEIMOS', 'MARS'], ['IO', 'IUPPITER'], ['EUROPA', 'IUPPITER'],
    ['GANYMEDES', 'IUPPITER'], ['CALLISTO', 'IUPPITER'], ['TITAN', 'SATURNUS'], ['TRITON', 'NEPTUNUS']]) {
    assert(parentOf(m) === p, `${m} の親が ${parentOf(m)}`);
  }
  const rings = byName.SATURNUS.rings;
  assert(rings && rings.inner > byName.SATURNUS.radius && rings.outer < byName.SATURNUS.radius * FRAME_ENTER, '土星の環');
  assert(byName.IUPPITER.gas.spot, '木星の大赤斑');
});

test('巡航: 倍率は距離とともに途切れなく増え、近くでは距離に比例する', () => {
  near(cruiseScale(0), CRUISE.min, 1e-9, '下限');
  near(cruiseScale(300e3), 300e3 / CRUISE.nearDiv, 1e-9, '高度300km (距離÷nearDiv)');
  const d0 = CRUISE.farFrom;
  assert(Math.abs(cruiseScale(d0 * 1.000001) - cruiseScale(d0)) < 0.01, '切り替わりで段差がある');
  let prev = 0;
  for (let e = 0; e <= 17; e += 0.25) {
    const s = cruiseScale(10 ** e);
    assert(s >= prev, '距離が増えたのに遅くなった');
    prev = s;
  }
  assert(cruiseScale(LY) * FIGHTER.assistMaxSpeed > 1e5 * 2.998e8, '恒星間で十分な速さが出ない');
});

/** 速度則どおりに一直線に飛んだときの所要時間 (秒)。出発点と到着点の天体の半径は r0。 */
function travelTime(distance, boost = false) {
  const top = boost ? FIGHTER.assistBoostSpeed : FIGHTER.assistMaxSpeed;
  const r0 = 15e3; // 出発・到着とも、地表から 15km の所まで
  let x = r0, t = 0;
  const end = distance - r0;
  while (x < end && t < 1e5) {
    const v = cruiseScale(Math.min(x, distance - x)) * top;
    // 速さは距離に比例するので、刻みを距離に合わせて進める
    const dt = Math.min(0.05, (end - x) / v);
    x += v * dt;
    t += dt;
  }
  return t;
}

test('巡航: 惑星間は約1分、恒星間は約2分で飛べる (ブーストでその半分以下)', () => {
  const planet = travelTime(0.5 * AU);
  const star = travelTime(5 * LY);
  assert(planet > 40 && planet < 90, `惑星間 ${planet.toFixed(0)} 秒`);
  assert(star > 80 && star < 150, `恒星間 ${star.toFixed(0)} 秒`);
  assert(travelTime(0.5 * AU, true) < planet * 0.5, 'ブーストで短くならない');
  assert(travelTime(5 * LY, true) < star * 0.5, `恒星間 (ブースト) ${travelTime(5 * LY, true).toFixed(0)} 秒`);
});

test('地形: 種類ごとに、海・乾いた地面・光る溶岩が正しく塗り分けられる', () => {
  const sample = (terrain) => {
    const t = makeTerrain({ seed: 99, radius: 300e3, terrain });
    const out = { water: 0, glow: 0, land: 0, low: 0, n: 0 };
    const col = [0, 0, 0, 0];
    const N = 3000;
    for (let i = 0; i < N; i++) {
      const y = 1 - (2 * (i + 0.5)) / N, r = Math.sqrt(1 - y * y), a = i * 2.399963;
      const x = Math.cos(a) * r, z = Math.sin(a) * r;
      const h = t.height(x, y, z, 400);
      assert(Number.isFinite(h) && h > -9000 && h < 20000, `標高が範囲外: ${h}`);
      t.color(col, h, 1, x, y, z);
      assert(col.every((v) => Number.isFinite(v) && v >= 0), '色が不正');
      if (col[3] === 1) out.water++;
      else if (col[3] === 0.5) out.glow++;
      if (h > 0) out.land++;
      else out.low++;
      out.n++;
    }
    return out;
  };
  const terran = sample({ type: 'terran', land: 0.05, cAmp: 2800, mAmp: 6500, hAmp: 320 });
  assert(terran.water > 300 && terran.land > 300 && terran.glow === 0, `海洋: ${JSON.stringify(terran)}`);
  for (const type of ['desert', 'ice', 'rock']) {
    const s = sample({ type, land: 0.3, cAmp: 2400, mAmp: 6000, hAmp: 380 });
    assert(s.water === 0 && s.glow === 0, `${type}: 水や溶岩がある ${JSON.stringify(s)}`);
  }
  const lava = sample({ type: 'lava', land: 0, cAmp: 2200, mAmp: 6000, hAmp: 420 });
  assert(lava.water === 0 && lava.glow > 100 && lava.glow <= lava.low, `溶岩: ${JSON.stringify(lava)}`);
});

test('地形: 定義を省いた惑星は M2 と同じ地形になる (TERRA が変わらない)', () => {
  const a = makeTerrain({ seed: 2024, radius: 400e3 });
  const b = makeTerrain({ seed: 2024, radius: 400e3, terrain: null });
  const c = makeTerrain({ seed: 2024, radius: 400e3, terrain: { type: 'terran', land: 0.05, cAmp: 2800, mAmp: 6500, hAmp: 320 } });
  for (const [x, y, z] of [[0.3, 0.5, -0.81], [-0.6, 0.1, 0.79], [0, 1, 0]]) {
    assert(a.height(x, y, z) === b.height(x, y, z) && a.height(x, y, z) === c.height(x, y, z), '標高が違う');
  }
});

test('表示: 距離と速さの単位が、大きさに合わせて切り替わる', () => {
  assert(formatDistance(850) === '850 m', formatDistance(850));
  assert(formatDistance(12345) === '12.35 km', formatDistance(12345));
  assert(formatDistance(3.2e7) === '32,000 km', formatDistance(3.2e7));
  assert(formatDistance(2.998e9) === '10.00 ls', formatDistance(2.998e9));
  assert(formatDistance(1.496e11) === '1.000 AU', formatDistance(1.496e11));
  assert(formatDistance(4.2 * LY) === '4.200 ly', formatDistance(4.2 * LY));
  assert(formatSpeed(420) === '420 m/s', formatSpeed(420));
  assert(formatSpeed(2.998e8 * 3) === '3.00 c', formatSpeed(2.998e8 * 3));
  assert(formatSpeed(LY * 0.5) === '0.50 ly/s', formatSpeed(LY * 0.5));
  assert(formatTime(75) === '1:15' && formatTime(3725) === '1:02:05' && formatTime(Infinity) === '--:--', '時間');
});
