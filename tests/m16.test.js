// 本物の地球と月 (docs/design-earth-moon.md の 11章): assets/maps の本物のマップを読み込んで確かめる
import { test, assert, near } from './harness.js';
import { Vector3, Quaternion } from 'three';
import { geoToLocal } from '../src/terrain/geo.js';
import { loadMaps, getMap, mapNamesOf } from '../src/terrain/maps.js';
import { makeTerrain } from '../src/terrain/terrainFn.js';
import { generateSystem } from '../src/universe/system.js';
import { HOME_STAR } from '../src/universe/galaxy.js';
import { Planet } from '../src/planet/planet.js';

// SOL のマップを先に読み込む (ゲームの main.js と同じ)。読めなければ下のテストがすべて失敗する
const SYS = { game: generateSystem(HOME_STAR), real: generateSystem(HOME_STAR, { scale: 'real' }) };
let loadError = null;
try {
  await loadMaps([
    ...SYS.game.planets.flatMap((p) => mapNamesOf(p.terrain)),
    ...SYS.game.planets.map((p) => p.nightLights).filter(Boolean),
  ]);
} catch (err) {
  loadError = err;
}
const loaded = () => assert(!loadError, `マップを読み込めない: ${loadError && loadError.message}`);

const body = (scale, name) => SYS[scale].planets.find((p) => p.name === name);
const terrains = {};
function terrainOf(scale, name) {
  const key = `${scale}:${name}`;
  return terrains[key] || (terrains[key] = makeTerrain(body(scale, name)));
}
/**
 * 緯度経度 (度) の地点の標高。細かさは半径の 1/600 (地球のマップの約 2 画素) にして、マップの値をおもに見る。
 * 半径に対する割合で決めるので、両方の縮尺で同じ縮小版を読む
 */
function heightAt(scale, name, lat, lon) {
  const t = terrainOf(scale, name), R = body(scale, name).radius;
  const [x, y, z] = geoToLocal(lat, lon);
  return t.height(x * R, y * R, z * R, R / 600);
}
function colorAt(scale, name, lat, lon) {
  const t = terrainOf(scale, name), R = body(scale, name).radius;
  const [x, y, z] = geoToLocal(lat, lon).map((v) => v * R);
  const out = [0, 0, 0, 0];
  t.color(out, t.height(x, y, z, R / 600), 0.05, x, y, z);
  return (out[0] + out[1] + out[2]) / 3;
}

test('地球: 本物の標高のマップで、エベレストは高く、太平洋は深く、日本は陸', () => {
  loaded();
  for (const scale of ['game', 'real']) {
    const h = (lat, lon) => heightAt(scale, 'TERRA', lat, lon);
    assert(h(27.99, 86.93) > 5000, `${scale}: エベレスト付近 ${h(27.99, 86.93).toFixed(0)} m`);
    assert(h(0, -150) < -3000, `${scale}: 太平洋の真ん中 ${h(0, -150).toFixed(0)} m`);
    assert(h(36.2, 138.2) > 300, `${scale}: 本州の中部 ${h(36.2, 138.2).toFixed(0)} m`);
    assert(h(-80, 0) > 1500, `${scale}: 南極の氷床 ${h(-80, 0).toFixed(0)} m`);
    assert(h(40, -40) < -2000, `${scale}: 大西洋 ${h(40, -40).toFixed(0)} m`);
  }
});

test('地球: 両方の縮尺で、同じ地点の標高がそろっている (倍率 1)', () => {
  loaded();
  for (const [lat, lon] of [[27.99, 86.93], [36.2, 138.2], [-15, -70], [0, -150], [64, -20]]) {
    const g = heightAt('game', 'TERRA', lat, lon), r = heightAt('real', 'TERRA', lat, lon);
    assert(Math.abs(g - r) < 0.15 * Math.abs(g) + 300, `${lat}, ${lon}: ゲーム用 ${g.toFixed(0)} m・実寸 ${r.toFixed(0)} m`);
  }
});

test('月: 表側の海は低くて暗く、ゲーム用の起伏は実寸の 0.4 倍', () => {
  loaded();
  const sea = [8.5, 31.4], high = [-30, 10]; // 静かの海、南の高地
  for (const scale of ['game', 'real']) {
    assert(colorAt(scale, 'LUNA', ...sea) < 0.6 * colorAt(scale, 'LUNA', ...high), `${scale}: 静かの海が高地より暗くない`);
    assert(heightAt(scale, 'LUNA', ...sea) < heightAt(scale, 'LUNA', ...high), `${scale}: 静かの海が高地より高い`);
  }
  // 起伏の大きいヘルツシュプルング盆地のまわりで、倍率を比べる (細かい模様のぶれを含めて 10% の幅)
  const g = heightAt('game', 'LUNA', -2, -129) - heightAt('game', 'LUNA', -2, -150);
  const r = heightAt('real', 'LUNA', -2, -129) - heightAt('real', 'LUNA', -2, -150);
  near(g / r, 0.4, 0.04, '高さの差の比');
});

test('地球: 開始時に日本が開始地点の真下の昼側にあり、TERRA 上空の哨戒隊は関東平野の上 (両方の縮尺)', () => {
  loaded();
  for (const scale of ['game', 'real']) {
    const sys = SYS[scale], terra = sys.planets[0];
    const q = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), terra.rotationPhase)
      .premultiply(new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), terra.axialTilt));
    const p = { tilt: new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), terra.axialTilt),
      omega: 0, rotationPhase: terra.rotationPhase, quat: new Quaternion() };
    Planet.prototype.updateRotation.call(p, 0);
    assert(p.quat.angleTo(q) < 1e-9, `${scale}: 自転の向きの計算が planet.js と違う`);
    const japan = new Vector3(...geoToLocal(36, 138)).applyQuaternion(p.quat);
    const toStart = new Vector3(...sys.start).sub(new Vector3(...terra.position)).normalize();
    const toSun = new Vector3(...terra.position).negate().normalize();
    // 自転では経度しか選べないので、北緯 36° の日本は自転軸の傾きのぶん真下からずれる (約 26°)
    assert(japan.dot(toStart) > 0.85,`${scale}: 日本が開始地点の方を向いていない (${japan.dot(toStart).toFixed(3)})`);
    assert(japan.dot(toSun) > 0.9, `${scale}: 日本が昼側の真ん中にない (${japan.dot(toSun).toFixed(3)})`);
    const zone = sys.zones.find((z) => z.kind === 'planet' && z.planet === 0);
    assert(heightAt(scale, 'TERRA', zone.lat, zone.lon) > 0, `${scale}: 哨戒隊の下が海`);
    near(zone.lat, 36, 1, '哨戒隊の緯度');
    near(zone.lon, 139.7, 1, '哨戒隊の経度');
  }
});

test('街明かり: 東京とニューヨークは明るく、太平洋とサハラの真ん中は暗い', () => {
  loaded();
  const m = getMap('earth-lights');
  const v = (lat, lon) => m.nearest(lat * Math.PI / 180, lon * Math.PI / 180);
  assert(v(35.68, 139.77) > 0.8, `東京 ${v(35.68, 139.77)}`);
  assert(v(40.71, -74.0) > 0.8, `ニューヨーク ${v(40.71, -74.0)}`);
  assert(v(0, -150) < 0.02, `太平洋 ${v(0, -150)}`);
  assert(v(23, 13) < 0.02, `サハラ ${v(23, 13)}`);
  assert(SYS.game.planets[0].nightLights === 'earth-lights' && SYS.real.planets[0].nightLights === 'earth-lights',
    'TERRA に街明かりのマップがない');
});
