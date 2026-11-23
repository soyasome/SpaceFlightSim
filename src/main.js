import { Vector3 } from 'three';
import { Game } from './game.js';
import { Menu } from './ui/menu.js';
import { StarMap } from './ui/starmap.js';
import { starsNear, HOME_STAR } from './universe/galaxy.js';
import { generateSystem } from './universe/system.js';
import { geoToLocal } from './terrain/geo.js';
import { loadMap, loadMaps, mapNamesOf } from './terrain/maps.js';

/**
 * 出発地 (SOL) の本物の地形のマップを、ゲームを始める前に読み込む (docs/design-earth-moon.md の 7章)。
 * 縮尺を変えても使うマップは同じなので、待つのは最初の1回だけ。読み込めなければ false (ノイズの地形で始める)。
 */
async function preloadMaps() {
  const bodies = ['game', 'real'].flatMap((scale) => generateSystem(HOME_STAR, { scale }).planets);
  const names = bodies.flatMap((p) => mapNamesOf(p.terrain));
  // 夜の街明かりは見た目だけなので、読めなくても地形は本物のまま始める (街明かりなしで描く。atmosphere.js)
  const lights = [...new Set(bodies.map((p) => p.nightLights).filter(Boolean))];
  const lightsDone = Promise.all(lights.map((n) => loadMap(n).catch((err) => {
    console.error(`夜の街明かりのマップ ${n} を読み込めなかった:`, err);
  })));
  if (!names.length) { await lightsDone; return true; }
  const note = document.createElement('div');
  note.textContent = '地形データを読み込み中…';
  note.style.cssText = 'position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);color:#8cf;'
    + 'font:14px monospace;letter-spacing:0.1em;z-index:100;pointer-events:none';
  document.body.appendChild(note);
  try {
    await loadMaps(names);
    await lightsDone;
    return true;
  } catch (err) {
    console.error('地形データを読み込めなかった。ノイズの地形で始める:', err);
    return false;
  } finally {
    note.remove();
  }
}

const mapsOk = await preloadMaps();
const game = new Game(document.getElementById('view'), document.getElementById('hud'));
game.start();
if (!mapsOk) game.notify('地形データを読み込めなかった — 地球と月はノイズの地形になる', 6);

const menu = new Menu(game, game.settings);
const starmap = new StarMap(game);

// デバッグ用の操作。ブラウザのコンソールから debug.goto(1000) のように呼ぶ。
window.debug = {
  game,
  menu,
  starmap,
  /**
   * 惑星の上空へ瞬間移動する。
   * @param alt 地面からの高さ (m)
   * @param lat,lon 緯度・経度 (度。東経が正)
   * @param pitch 機首の上下 (度, 0 = 水平, 負 = 下向き)
   * @param speed 前進速度 (m/s)。0 ならホバーで静止、0 より大きければ飛行状態
   */
  goto(alt = 1000, lat = 20, lon = 30, pitch = 0, speed = 0, body = null) {
    const up = new Vector3(...geoToLocal(lat, lon)); // 東経が正 (src/terrain/geo.js)
    game.placeShip(body === null ? game.planet : game.planets[body], up, alt, pitch, speed);
    return this.state();
  },
  /** 機体・シールド・弾薬を回復する。 */
  repair() {
    game.ship.restore();
  },
  /**
   * 敵を自機の前方に出す。
   * @param n 数
   * @param type 'raider' | 'gunship'
   * @param dist 距離 (m)
   * @param alerted false なら自機に気づくまで哨戒する
   */
  spawn(n = 1, type = 'raider', dist = 3000, alerted = true) {
    const b = game.ship.body;
    const out = [];
    for (let i = 0; i < n; i++) {
      const pos = new Vector3((i - (n - 1) / 2) * 300, 0, -dist).applyQuaternion(b.quat).add(b.pos);
      const dir = b.pos.clone().sub(pos).normalize();
      out.push(game.combat.spawnEnemy(type, pos, dir, { home: pos, alerted }));
    }
    return out.filter(Boolean).length;
  },
  /** 敵をすべて消す。 */
  clearEnemies() {
    game.combat.clearAll();
    for (const z of game.combat.zones) z.roster = [];
  },
  /** 宇宙 (世界座標) の指定位置へ瞬間移動する。 */
  space(x = 0, y = 0, z = 0) {
    game.setFrame(null);
    const b = game.ship.body;
    b.teleport(new Vector3(x, y, z));
    b.vel.set(0, 0, 0);
    game.input.throttle = 0;
    game.rig._snap = true;
    return this.state();
  },
  /**
   * 今の星系の天体の近く (宇宙) へ瞬間移動する。
   * @param i 天体の番号 (debug.system() で一覧)
   * @param radii 中心からの距離 (天体の半径の倍数)。座標系が切り替わらないよう 7 以上にする
   */
  near(i = 0, radii = 8) {
    const p = game.planets[i];
    if (!p) return 'no such body';
    game.setFrame(null);
    const b = game.ship.body;
    const dir = new Vector3(0.6, 0.3, 0.74).normalize();
    b.pos.copy(p.pos).addScaledVector(dir, p.radius * radii);
    b.prevPos.copy(b.pos);
    b.vel.set(0, 0, 0);
    b.quat.setFromUnitVectors(new Vector3(0, 0, -1), dir.clone().negate());
    b.prevQuat.copy(b.quat);
    game.ship.stopCruise();
    game.input.throttle = 0;
    game.rig._snap = true;
    return this.state();
  },
  /** 今の星系の天体の一覧。 */
  system() {
    return {
      star: `${game.star.name} (${game.star.cls})`, scale: game.scale,
      bodies: game.planets.map((p, i) => `${i}: ${p.name} [${p.type}] R=${Math.round(p.radius / 1000)}km`),
      belt: !!game.system.belt, zones: game.combat.zones.length,
    };
  },
  /** 近くの恒星の一覧 (近い順)。 */
  stars(radius = 15) {
    return starsNear(game.galPos, radius).map((e, i) => `${i}: ${e.star.name} (${e.star.cls}) ${e.dist.toFixed(2)} ly`);
  },
  /** 近い順で n 番目の恒星へ、充填なしでジャンプする (0 は今いる星系)。 */
  jumpTo(n = 1) {
    const list = starsNear(game.galPos, 30);
    if (!list[n]) return 'no such star';
    game.setFrame(null);
    game._doJump(list[n].star);
    return this.state();
  },
  /** 速度と回転を止める。 */
  stop() {
    game.ship.body.vel.set(0, 0, 0);
    game.ship.body.angVel.set(0, 0, 0);
    game.input.throttle = 0;
  },
  /** 現在の状態を返す。 */
  state() {
    const b = game.ship.body;
    return {
      frame: game.frame ? game.frame.name : 'space',
      pos: b.pos.toArray(), speed: b.vel.length(),
      altitude: game.altitude, altitudeSea: game.altitudeSea, grounded: game.grounded,
      assist: game.ship.flightAssist, cruise: game.ship.cruise, view: game.rig.mode,
      hover: game.ship.hover, gear: game.ship.gear, hull: game.ship.hull, heat: game.ship.heat,
      aoaDeg: (game.ship.aero.aoa * 180) / Math.PI, q: game.ship.aero.q, stalled: game.ship.aero.stalled,
      gLoad: game.gLoad, verticalSpeed: game.verticalSpeed, landed: game.landed,
      gearContacts: game.ground.gearContacts, hullContacts: game.ground.hullContacts,
      destroyed: game.destroyed,
      shield: game.ship.shield, energy: game.ship.energy, missiles: game.ship.missiles,
      enemies: game.combat.enemies.length, bolts: game.combat.bolts.count,
      activeMissiles: game.combat.missiles.length, kills: game.combat.kills,
      target: game.combat.target ? game.combat.target.name : null, locked: game.combat.locked,
      throttle: game.input.throttle, fps: Math.round(game.fps),
      chunks: game.planets.reduce((n, p) => n + (p.lod ? p.lod.visibleCount : 0), 0),
      meshes: game.planets.reduce((n, p) => n + (p.lod ? p.lod.meshCount : 0), 0),
      scatter: game.planets.reduce((n, p) => n + (p.scatter ? p.scatter.count : 0), 0), // メッシュで描いている岩と木の数
      trees: game.planets.reduce((n, p) => n + (p.scatter ? p.scatter.trees : 0), 0), // 木の総数 (遠くはビルボード)
      star: game.star.name, starDist: game.starDist, galPos: [...game.galPos], cruiseDist: game.cruiseDist,
      nav: game.navName(), jump: game.jump ? game.jump.phase : null,
    };
  },
};
