import { Vector3 } from 'three';
import { Game } from './game.js';
import { Menu } from './ui/menu.js';
import { StarMap } from './ui/starmap.js';
import { starsNear } from './universe/galaxy.js';

const game = new Game(document.getElementById('view'), document.getElementById('hud'));
game.start();

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
   * @param lat,lon 緯度・経度 (度)
   * @param pitch 機首の上下 (度, 0 = 水平, 負 = 下向き)
   * @param speed 前進速度 (m/s)。0 ならホバーで静止、0 より大きければ飛行状態
   */
  goto(alt = 1000, lat = 20, lon = 30, pitch = 0, speed = 0, body = null) {
    const la = (lat * Math.PI) / 180, lo = (lon * Math.PI) / 180;
    const up = new Vector3(Math.cos(la) * Math.cos(lo), Math.sin(la), Math.cos(la) * Math.sin(lo));
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
