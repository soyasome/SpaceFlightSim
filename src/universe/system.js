import { mulberry32 } from '../math/random.js';
import { AU } from './galaxy.js';

// 恒星から、その星系の惑星・小惑星帯・敵の哨戒隊を決める。three.js には依存しない。
// 位置はすべて「星系座標」= 恒星の中心を原点とした m。

const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'];
const lerp = (a, b, t) => a + (b - a) * t;

/** 惑星の種類ごとの呼び名 (星図に出す)。 */
export const TYPE_LABEL = {
  terran: '海洋惑星', desert: '砂漠惑星', ice: '氷惑星', lava: '溶岩惑星', rock: '岩石天体', gas: 'ガス巨星',
  city: '都市惑星',
};

/** 文明の栄えた星系の割合。その星系の住みやすい惑星が1つ、表面を街に覆われた都市惑星 (エキュメノポリス) になる。 */
export const CITY_CHANCE = 0.15;

/**
 * 海洋惑星・砂漠惑星を都市惑星に作り変える。
 * 起伏は低く (造成された平地)、海は狭く、空はスモッグで少しかすむ。
 */
function makeCity(body, rand) {
  const k = body.radius / 400e3; // makeBody と同じく、小さな天体ほど起伏を低くする
  body.type = 'city';
  body.terrain = {
    type: 'city', land: lerp(0.12, 0.3, rand()),
    cAmp: 1600 * k, mAmp: 1400 * k, hAmp: 120 * k, tint: null,
  };
  body.atmosphere = {
    ...AIR_EARTH, surfaceDensity: lerp(1.0, 1.4, rand()), scaleHeightM: 1800,
    betaM: lerp(8e-6, 12e-6, rand()), // スモッグ
  };
  body.skyLight = [0.36, 0.41, 0.52];
  return body;
}

/** 機体をその座標系で動かし始める距離 (惑星半径の倍数)。planet.js と揃えること。 */
export const FRAME_ENTER = 6;
export const FRAME_EXIT = 6.6;

// 大気の基準値 (TERRA と同じ、地球に似た空)
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

/** makeBody で作った天体の値を、手で決めた値で上書きする (terrain は項目ごとに混ぜる)。 */
function customize(body, { terrain, ...rest }) {
  if (terrain) body.terrain = { ...body.terrain, ...terrain };
  return Object.assign(body, rest);
}

const NO_AIR = { atmosphere: null, skyLight: [0.02, 0.02, 0.025] };
// ガス巨星の大気。既定の青い空のままだと縞の色が白くかすむので、惑星の色に合わせて薄く色を付ける
const gasAir = (betaR) => ({
  atmosphere: {
    surfaceDensity: 4, height: 220e3, scaleHeightR: 28e3, scaleHeightM: 9000,
    betaR: betaR.map((b) => b * 1e-6), betaM: 0.3e-6,
  },
});

/**
 * 出発地の星系 (太陽系に似せたもの)。名前はラテン語。
 * TERRA (planets[0]) と小惑星帯の位置関係は M1〜M4 のまま。
 * 大きさは TERRA (半径 400 km) を基準に本物の比率へ寄せ、木星だけは上限に収まるよう少し小さくしてある。
 * 軌道半径は本物と同じ天文単位。
 */
function homeSystem(star) {
  const start = [0.5e11, -0.45e11, -1.3e11]; // 開始位置 (恒星から約1天文単位)
  const rand = mulberry32(star.seed);
  const terraPos = [start[0] + 0.9e6, start[1] - 0.3e6, start[2] - 3.2e6];
  // 恒星のまわり: 軌道半径 au、方位 deg、軌道面からの傾き incl (rad)
  const orbit = (au, deg, incl = 0) => {
    const r = au * AU, a = (deg * Math.PI) / 180;
    return [Math.cos(a) * r, Math.sin(incl) * r, Math.sin(a) * r];
  };
  // 親の天体のまわり: 中心からの距離 dist (m)、方位 deg
  const around = (p, dist, deg, up = 0.05) => {
    const a = (deg * Math.PI) / 180;
    return [p[0] + Math.cos(a) * dist, p[1] + dist * up, p[2] + Math.sin(a) * dist];
  };

  const planets = [];
  const add = (name, type, seed, radius, position, parent, opts) => {
    const body = makeBody(`home:${planets.length}`, name, type, seed, radius, position, rand, parent);
    planets.push(customize(body, opts));
    return planets.length - 1;
  };

  // 0: 地球。地形は M2 から変えていない既定のもの (terrain: null)
  planets.push({
    key: 'home:0', name: 'TERRA', type: 'terran', seed: 2024, radius: 400e3, position: terraPos, parent: null,
    rotationPeriod: 7200, axialTilt: 0.3, gravity: 9.81,
    terrain: null,
    atmosphere: { ...AIR_EARTH, sunIntensity: 22 },
    skyLight: [0.3, 0.42, 0.62],
  });
  // 月: 大気がなく、近いので着陸の練習になる
  add('LUNA', 'rock', 77, 110e3, [terraPos[0] - 5.2e6, terraPos[1] + 1.4e6, terraPos[2] - 6.4e6], 0,
    { ...NO_AIR, gravity: 1.62, terrain: { tint: [1, 1, 1.02] } });

  // 水星: 灰色の岩の天体
  add('MERCURIUS', 'rock', 311, 152e3, orbit(0.39, 40, 0.06), null,
    { ...NO_AIR, gravity: 3.7, rotationPeriod: 16000, axialTilt: 0.01, terrain: { tint: [1.05, 1, 0.95] } });

  // 金星: 黄色い濃い雲に包まれた乾いた惑星。自転軸がほぼ逆さ (= 逆向きに自転する)
  add('VENUS', 'desert', 512, 380e3, orbit(0.72, -120, 0.03), null, {
    gravity: 8.9, rotationPeriod: 20000, axialTilt: 3.1,
    terrain: { tint: [1.2, 1.05, 0.78] },
    atmosphere: {
      surfaceDensity: 2.4, height: 80e3, scaleHeightR: 10000, scaleHeightM: 4000,
      betaR: [10e-6, 8.5e-6, 4e-6], betaM: 20e-6,
    },
    skyLight: [0.62, 0.5, 0.28],
  });

  // 火星: 赤い砂漠と薄い大気、小さな衛星が2つ
  const mars = add('MARS', 'desert', 640, 212e3, orbit(1.52, -30, 0.02), null, {
    gravity: 3.7, rotationPeriod: 7400, axialTilt: 0.44,
    terrain: { tint: [1.38, 0.7, 0.48] },
    atmosphere: {
      surfaceDensity: 0.15, height: 45e3, scaleHeightR: 9000, scaleHeightM: 2500,
      betaR: [9e-6, 7.5e-6, 5.5e-6], betaM: 8e-6,
    },
    skyLight: [0.55, 0.4, 0.3],
  });
  const mp = planets[mars].position;
  add('PHOBOS', 'rock', 641, 55e3, around(mp, 2.4e6, 30), mars, { ...NO_AIR, gravity: 1.1, terrain: { tint: [0.78, 0.7, 0.62] } });
  add('DEIMOS', 'rock', 642, 50e3, around(mp, 4.2e6, 200), mars, { ...NO_AIR, gravity: 1.05, terrain: { tint: [0.82, 0.74, 0.66] } });

  // 木星: 茶色と白の縞と大赤斑、ガリレオ衛星
  const iup = add('IUPPITER', 'gas', 901, 3600e3, orbit(5.2, 150, 0.02), null, {
    gravity: 22, rotationPeriod: 3000, axialTilt: 0.05, ...gasAir([0.9, 0.75, 0.5]),
    gas: {
      bands: [[0.9, 0.76, 0.58], [0.66, 0.45, 0.32], [0.95, 0.9, 0.82], [0.78, 0.6, 0.45]], count: 16,
      spot: { lat: -0.38, lon: 1.2, w: 0.22, h: 0.09, color: [0.78, 0.36, 0.22] },
    },
  });
  const jp = planets[iup].position;
  add('IO', 'rock', 902, 115e3, around(jp, 28e6, 10), iup, { ...NO_AIR, gravity: 1.8, terrain: { tint: [1.7, 1.5, 0.6] } });
  add('EUROPA', 'ice', 903, 100e3, around(jp, 38e6, 100), iup, { ...NO_AIR, gravity: 1.3, terrain: { tint: [1, 0.93, 0.84] } });
  add('GANYMEDES', 'rock', 904, 165e3, around(jp, 50e6, 190), iup, { ...NO_AIR, gravity: 1.43, terrain: { tint: [1.08, 1.03, 0.98] } });
  add('CALLISTO', 'rock', 905, 150e3, around(jp, 66e6, 285), iup, { ...NO_AIR, gravity: 1.24, terrain: { tint: [0.7, 0.67, 0.64] } });

  // 土星: 淡い黄色の縞と環、オレンジ色のもやに包まれた衛星
  const sat = add('SATURNUS', 'gas', 1100, 3000e3, orbit(9.5, -150, 0.04), null, {
    gravity: 10.4, rotationPeriod: 3200, axialTilt: 0.47, ...gasAir([0.9, 0.8, 0.55]),
    gas: { bands: [[0.88, 0.72, 0.46], [0.72, 0.56, 0.34], [0.95, 0.86, 0.64]], count: 12 },
    rings: { inner: 3000e3 * 1.24, outer: 3000e3 * 2.27, color: [0.86, 0.78, 0.62] },
  });
  add('TITAN', 'ice', 1101, 160e3, around(planets[sat].position, 30e6, 60), sat, {
    gravity: 1.35,
    terrain: { tint: [0.8, 0.62, 0.42] },
    atmosphere: {
      surfaceDensity: 1.5, height: 60e3, scaleHeightR: 15000, scaleHeightM: 4000,
      betaR: [9e-6, 6e-6, 2.5e-6], betaM: 18e-6,
    },
    skyLight: [0.5, 0.35, 0.18],
  });

  // 天王星: 縞の目立たない水色。自転軸が横倒し
  add('URANUS', 'gas', 1300, 1600e3, orbit(19.2, 60, 0.01), null, {
    gravity: 8.9, rotationPeriod: 5000, axialTilt: 1.71, ...gasAir([0.5, 1.0, 1.15]),
    gas: { bands: [[0.64, 0.86, 0.9], [0.6, 0.82, 0.87], [0.68, 0.89, 0.92]], count: 4 },
  });

  // 海王星: 深い青と、大きな衛星
  const nep = add('NEPTUNUS', 'gas', 1500, 1550e3, orbit(30, -100, 0.03), null, {
    gravity: 11.2, rotationPeriod: 4800, axialTilt: 0.49, ...gasAir([0.2, 0.4, 1.1]),
    gas: { bands: [[0.2, 0.36, 0.95], [0.14, 0.26, 0.85], [0.32, 0.5, 1]], count: 6 },
  });
  add('TRITON', 'ice', 1501, 85e3, around(planets[nep].position, 16e6, 140), nep,
    { ...NO_AIR, gravity: 1.2, terrain: { tint: [1.05, 0.95, 0.92] } });

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

  // 都市惑星。ほかの天体の配置を変えないよう、別の乱数で決める
  const crand = mulberry32((star.seed ^ 0x6c8e9cf5) >>> 0);
  if (crand() < CITY_CHANCE) {
    const home = planets.find((p) => p.parent === null && (p.type === 'terran' || p.type === 'desert'));
    if (home) makeCity(home, crand);
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
    const r = rand(); // 都市惑星は必ず守られているが、乱数は同じ数だけ引く (ほかの哨戒隊が変わらないように)
    if (p.type === 'city' || r < 0.35) {
      zones.push({ kind: 'planet', planet: i, lat: (rand() - 0.5) * 100, lon: rand() * 360, altitude: 5000, roster: roster() });
    }
  });

  return { star, planets, belt, zones };
}
