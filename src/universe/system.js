import { mulberry32 } from '../math/random.js';
import { AU } from './galaxy.js';

// 恒星から、その星系の惑星・小惑星帯・敵の哨戒隊を決める。three.js には依存しない。
// 位置はすべて「星系座標」= 恒星の中心を原点とした m。

const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'];
const lerp = (a, b, t) => a + (b - a) * t;

/** 惑星の種類ごとの呼び名 (星図に出す)。 */
export const TYPE_LABEL = {
  terran: '海洋惑星', desert: '砂漠惑星', ice: '氷惑星', lava: '溶岩惑星', rock: '岩石天体', gas: 'ガス巨星',
};

/** 機体をその座標系で動かし始める距離 (惑星半径の倍数)。planet.js と揃えること。 */
export const FRAME_ENTER = 6;
export const FRAME_EXIT = 6.6;

// 大気の基準値 (AURELIA と同じ、地球に似た空)
const AIR_EARTH = {
  surfaceDensity: 1.225, height: 60e3, scaleHeightR: 7000, scaleHeightM: 1400,
  betaR: [5.2e-6, 12.1e-6, 29.6e-6], betaM: 5e-6,
};

/** 種類ごとの地形・大気・空の色を決める。 */
function bodyLook(type, rand) {
  const v = () => 0.85 + rand() * 0.3; // 個体差
  switch (type) {
    case 'terran':
      return {
        terrain: { type, land: lerp(-0.08, 0.16, rand()), cAmp: 2800 * v(), mAmp: 6500 * v(), hAmp: 320 },
        atmosphere: { ...AIR_EARTH, surfaceDensity: lerp(0.9, 1.5, rand()) },
        skyLight: [0.3, 0.42, 0.62],
      };
    case 'desert': {
      const red = rand();
      return {
        terrain: {
          type, land: lerp(0.3, 0.6, rand()), cAmp: 2400 * v(), mAmp: 7500 * v(), hAmp: 380,
          tint: [lerp(1, 1.15, red), lerp(1, 0.85, red), lerp(1, 0.72, red)],
        },
        // 砂ぼこりで黄土色にかすむ薄い空
        atmosphere: {
          surfaceDensity: lerp(0.15, 0.6, rand()), height: 55e3, scaleHeightR: 8500, scaleHeightM: 2500,
          betaR: [11e-6, 9e-6, 6.5e-6], betaM: 9e-6,
        },
        skyLight: [0.55, 0.42, 0.3],
      };
    }
    case 'ice':
      return {
        terrain: { type, land: lerp(-0.05, 0.2, rand()), cAmp: 2000 * v(), mAmp: 5200 * v(), hAmp: 260 },
        atmosphere: {
          surfaceDensity: lerp(0.3, 0.9, rand()), height: 50e3, scaleHeightR: 6000, scaleHeightM: 1200,
          betaR: [4.2e-6, 10e-6, 26e-6], betaM: 3e-6,
        },
        skyLight: [0.34, 0.46, 0.66],
      };
    case 'lava':
      return {
        terrain: { type, land: lerp(-0.1, 0.12, rand()), cAmp: 2200 * v(), mAmp: 6000 * v(), hAmp: 420 },
        // 噴煙で赤茶色にくすんだ濃い空
        atmosphere: {
          surfaceDensity: lerp(1.2, 2.4, rand()), height: 70e3, scaleHeightR: 9000, scaleHeightM: 3000,
          betaR: [16e-6, 8e-6, 5e-6], betaM: 14e-6,
        },
        skyLight: [0.5, 0.3, 0.22],
      };
    case 'gas': {
      // 縞の色: 2〜3色を緯度方向に並べる
      const palettes = [
        [[0.78, 0.62, 0.42], [0.6, 0.42, 0.28], [0.86, 0.78, 0.62]],
        [[0.5, 0.62, 0.8], [0.32, 0.44, 0.7], [0.7, 0.8, 0.9]],
        [[0.75, 0.72, 0.55], [0.55, 0.6, 0.45], [0.86, 0.84, 0.7]],
        [[0.7, 0.48, 0.5], [0.5, 0.3, 0.4], [0.85, 0.7, 0.66]],
      ];
      return {
        gas: { bands: palettes[Math.floor(rand() * palettes.length)], count: 6 + Math.floor(rand() * 8) },
        atmosphere: {
          surfaceDensity: 4, height: 220e3, scaleHeightR: 28e3, scaleHeightM: 9000,
          betaR: [1.2e-6, 2.4e-6, 5e-6], betaM: 0.6e-6,
        },
        skyLight: [0.4, 0.42, 0.5],
      };
    }
    default: { // rock: 大気のない岩の天体
      const hue = rand();
      const tint = hue < 0.5 ? [1, 1, 1] : hue < 0.8 ? [1.1, 0.98, 0.84] : [1.15, 0.88, 0.76];
      return {
        terrain: { type: 'rock', land: lerp(0.15, 0.45, rand()), cAmp: 2200 * v(), mAmp: 5000 * v(), hAmp: 520, tint },
        atmosphere: null,
        skyLight: [0.02, 0.02, 0.025],
      };
    }
  }
}

function makeBody(key, name, type, seed, radius, position, rand, parent = null) {
  const look = bodyLook(type, rand);
  const gas = type === 'gas';
  // 小さな天体ほど起伏を低くする。地形の模様は天体の大きさに合わせて縮むので、
  // 高さをそのままにすると小さな天体は崖だらけになり、着陸できる場所がなくなる
  if (look.terrain) {
    const k = radius / 400e3;
    look.terrain.cAmp *= k;
    look.terrain.mAmp *= k;
    look.terrain.hAmp *= k;
  }
  return {
    key, name, type, seed, radius, position, parent,
    rotationPeriod: gas ? lerp(2500, 6000, rand()) : lerp(4000, 16000, rand()),
    axialTilt: lerp(0, 0.5, rand()),
    gravity: gas ? lerp(13, 22, rand()) : lerp(2.5, 6, rand()) + radius / 80e3,
    ...look,
  };
}

/** 出発地の星系。AURELIA と小惑星帯の位置関係は M1〜M4 のまま。 */
function homeSystem(star) {
  const start = [0.5e11, -0.45e11, -1.3e11]; // 開始位置 (恒星から約1天文単位)
  const rand = mulberry32(star.seed);
  const aureliaPos = [start[0] + 0.9e6, start[1] - 0.3e6, start[2] - 3.2e6];
  const aurelia = {
    key: 'home:0', name: 'AURELIA', type: 'terran', seed: 2024, radius: 400e3, position: aureliaPos, parent: null,
    rotationPeriod: 7200, axialTilt: 0.3, gravity: 9.81,
    terrain: null, // null = M2 から変えていない既定の地形
    atmosphere: { ...AIR_EARTH, sunIntensity: 22 },
    skyLight: [0.3, 0.42, 0.62],
  };
  const planets = [
    aurelia,
    // AURELIA の衛星: 大気がなく、近いので着陸の練習になる
    makeBody('home:1', 'AURELIA a', 'rock', 77, 110e3, [aureliaPos[0] - 5.2e6, aureliaPos[1] + 1.4e6, aureliaPos[2] - 6.4e6], rand, 0),
    makeBody('home:2', 'HELIA I', 'lava', 311, 260e3, [0.42 * AU, 0.01 * AU, 0.2 * AU], rand),
    makeBody('home:3', 'HELIA III', 'desert', 512, 330e3, [1.1 * AU, -0.05 * AU, -1.25 * AU], rand),
    makeBody('home:4', 'HELIA IV', 'gas', 901, 2600e3, [-2.6 * AU, 0.1 * AU, -2.2 * AU], rand),
    makeBody('home:5', 'HELIA V', 'ice', 1203, 300e3, [-5.5 * AU, -0.3 * AU, 4.2 * AU], rand),
  ];
  planets.push(makeBody('home:6', 'HELIA IV a', 'ice', 1204, 120e3,
    [planets[4].position[0] + 22e6, planets[4].position[1] + 3e6, planets[4].position[2] - 14e6], rand, 4));
  return {
    star, planets, start,
    belt: { position: [start[0], start[1] - 600, start[2] - 9000], seed: 9 },
    zones: [
      { kind: 'belt', roster: ['raider', 'raider'] },
      { kind: 'planet', planet: 0, lat: 20, lon: 30, altitude: 5000, roster: ['raider', 'raider', 'gunship'] },
    ],
  };
}

/**
 * 星系を作る。
 * @returns { star, planets: [天体の定義], belt: { position, seed } | null, zones: [敵の哨戒隊], start? }
 */
export function generateSystem(star) {
  if (star.home) return homeSystem(star);
  const rand = mulberry32(star.seed);
  const planets = [];
  const count = 2 + Math.floor(rand() * 6);
  const hz = Math.sqrt(star.lum); // 明るい星ほど、住みやすい帯が外側になる
  let a = (0.25 + rand() * 0.3) * hz; // 軌道半径 (天文単位)

  for (let i = 0; i < count; i++) {
    const rel = a / hz;
    const t = rand();
    let type;
    if (rel < 0.55) type = t < 0.4 ? 'lava' : t < 0.8 ? 'rock' : 'desert';
    else if (rel < 1.7) type = t < 0.45 ? 'terran' : t < 0.75 ? 'desert' : t < 0.9 ? 'rock' : 'ice';
    else type = t < 0.45 ? 'gas' : t < 0.8 ? 'ice' : 'rock';

    const radius = type === 'gas' ? lerp(1800e3, 3400e3, rand()) : lerp(180e3, 620e3, rand());
    const angle = rand() * Math.PI * 2;
    const position = [Math.cos(angle) * a * AU, (rand() - 0.5) * 0.06 * a * AU, Math.sin(angle) * a * AU];
    const index = planets.length;
    const name = `${star.name} ${ROMAN[i] || i + 1}`;
    planets.push(makeBody(`${star.id}:${index}`, name, type, (star.seed + i * 7919) >>> 0, radius, position, rand));

    // 衛星: ガス巨星は持ちやすい。互いの座標系が重ならない距離に置く
    const moons = type === 'gas' ? Math.floor(rand() * 3) : rand() < 0.3 ? 1 : 0;
    let dist = 0;
    for (let m = 0; m < moons; m++) {
      const mr = lerp(60e3, 170e3, rand());
      dist = Math.max(dist, radius * FRAME_EXIT) + mr * FRAME_EXIT + lerp(1e6, 6e6, rand());
      const ma = rand() * Math.PI * 2;
      const mpos = [position[0] + Math.cos(ma) * dist, position[1] + (rand() - 0.5) * dist * 0.2, position[2] + Math.sin(ma) * dist];
      planets.push(makeBody(`${star.id}:${planets.length}`, `${name} ${'abc'[m]}`, rand() < 0.5 ? 'rock' : 'ice',
        (star.seed + i * 7919 + (m + 1) * 104729) >>> 0, mr, mpos, rand, index));
      dist += mr * FRAME_EXIT;
    }
    a *= 1.45 + rand() * 0.5;
  }

  // 小惑星帯: 惑星から十分離れた場所に1つ置くことがある
  let belt = null;
  if (rand() < 0.6) {
    const ba = (0.4 + rand() * 2.5) * hz;
    const angle = rand() * Math.PI * 2;
    const position = [Math.cos(angle) * ba * AU, 0, Math.sin(angle) * ba * AU];
    const clear = planets.every((p) =>
      Math.hypot(p.position[0] - position[0], p.position[1] - position[1], p.position[2] - position[2]) > p.radius * 12 + 1e5);
    if (clear) belt = { position, seed: (star.seed ^ 0x5bd1e995) >>> 0 };
  }

  // 敵の哨戒隊: 出発地から遠い星系ほど数が増え、重戦闘機が混ざる
  const far = Math.hypot(star.pos[0] - 5, star.pos[1] - 5, star.pos[2] - 5);
  const danger = Math.min(3, Math.floor(far / 20));
  const roster = () => {
    const list = [];
    const n = 2 + Math.floor(rand() * (1 + danger));
    for (let i = 0; i < Math.min(n, 4); i++) list.push('raider');
    if (rand() < 0.25 + danger * 0.25) list.push('gunship');
    return list;
  };
  const zones = [];
  if (belt && rand() < 0.6) zones.push({ kind: 'belt', roster: roster() });
  planets.forEach((p, i) => {
    if (p.type === 'gas' || !p.atmosphere || p.atmosphere.surfaceDensity < 0.5) return;
    if (rand() < 0.35) {
      zones.push({ kind: 'planet', planet: i, lat: (rand() - 0.5) * 100, lon: rand() * 360, altitude: 5000, roster: roster() });
    }
  });

  return { star, planets, belt, zones };
}
