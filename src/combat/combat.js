import * as THREE from 'three';
import { Ship, makeControls } from '../flight/ship.js';
import { RAIDER, GUNSHIP } from '../flight/shipParams.js';
import { createShipModel } from '../render/shipModel.js';
import { BoltPool, Missile } from './projectiles.js';
import { Pilot } from './ai.js';
import { Effects } from './effects.js';
import { leadPoint, segmentSphere, angleBetween } from './targeting.js';

const MAX_ENEMIES = 8;
const AI_EVERY = 6; // 敵の判断は 6 ステップに1回 (毎秒20回)
const AI_DT = AI_EVERY / 120;
const DESPAWN_DISTANCE = 60e3; // 自機からこれ以上離れた敵は消える
const AUTO_TARGET_RANGE = 10e3;
const REARM_TIME = 3; // 着陸してから修理・補給が始まるまで (秒)
const DEG = Math.PI / 180;

// 機関砲の砲口 (機体座標)
const MUZZLES = [new THREE.Vector3(1.7, -0.15, -2.5), new THREE.Vector3(-1.7, -0.15, -2.5)];

const TYPES = {
  raider: { params: RAIDER, colors: { hull: 0x6e5a5a, accent: 0xff4028 }, scale: 1 },
  gunship: { params: GUNSHIP, colors: { hull: 0x4f4a55, accent: 0xff2a50 }, scale: 1.45 },
};

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _lead = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _m4 = new THREE.Matrix4();
const _scratchEnv = { speedScale: 1, gravity: new THREE.Vector3(), rho: 0, aero: 0, onGround: false };

/**
 * 戦闘の管理: 敵機、弾、ミサイル、ロックオン、敵の出現。
 * 敵と弾は自機と同じフレーム座標で動かす。
 */
export class Combat {
  constructor(game) {
    this.game = game;
    this.enemies = [];
    this.bolts = new BoltPool(600);
    this.missiles = [];
    this.effects = new Effects(game.scene);
    this.rand = Math.random;

    // 自機も「機体」の1つとして扱う
    this.player = {
      ship: game.ship, team: 0, radius: game.ship.params.radius, controls: game.input.controls,
      alive: true, isPlayer: true, gunTimer: 0, gunSide: 0, missileTimer: 0,
      underFire: 0, missileThreat: false,
    };
    this.actors = [this.player];

    this.target = null; // ロックの対象
    this.lock = 0; // ロックオンの進み具合 0..1
    this.locked = false;
    this.kills = 0;
    this.wave = 0;
    this.tick = 0;
    this.hitMarker = 0; // 命中を知らせる表示の残り時間
    this.rearmTimer = 0;
    this.rearmed = true;
    this.firedGun = false; // このステップで自機が撃ったか (音用)
    this._rocks = []; // 小惑星 (フレーム座標)
    this._rockCenter = new THREE.Vector3(NaN, 0, 0);
    this._leadAim = new THREE.Vector3(); // 機首を向けるべき点 (フレーム座標)
    this._leadValid = false;

    // 敵の哨戒隊。星系ごとに決まる (setSystem)。自機が近づくと現れ、遠ざかると引っ込む
    // (残っていた分は次回また現れる)
    this.zones = [];

    // 敵の操縦士がまわりを調べるための窓口
    const self = this;
    this.world = {
      altitudeAt: (pos) => self.altitudeAt(pos),
      upAt: (pos, out) => {
        if (!game.frame) return false;
        game.frame.upAt(pos, out);
        return true;
      },
      aeroAt: (pos) => game.envAt(pos, _scratchEnv).aero,
      get rocks() { return self._rocks; },
    };
    this._solidHit = (from, to, out) => this.solidHit(from, to, out);
    this._onBoltHit = (actor, point, damage, owner) => this._hit(actor, point, damage, owner);
  }

  // ---------------------------------------------------------------- 世界との関係

  /** 地面からのおおよその高さ。細かい凹凸は省く (呼ぶ回数が多いので軽くする)。 */
  altitudeAt(pos) {
    const frame = this.game.frame;
    if (!frame) return Infinity;
    return frame.roughHeightAbove(pos);
  }

  /** 線分 from→to が地形か小惑星に当たるか。当たった位置を out に入れる。 */
  solidHit(from, to, out) {
    const frame = this.game.frame;
    if (frame) {
      if (frame.seaLevelAt(to) < 12000) {
        const alt = frame.roughHeightAbove(to);
        if (alt < 0) {
          // 真下の地面の上へ戻した点
          frame.upAt(to, out).multiplyScalar(-alt).add(to);
          return true;
        }
      }
      return false;
    }
    const len = from.distanceTo(to);
    for (const rock of this._rocks) {
      const lim = rock.r + len;
      if (from.distanceToSquared(rock.pos) > lim * lim) continue;
      const t = segmentSphere(from, to, rock.pos, rock.r);
      if (t >= 0) {
        out.lerpVectors(from, to, t);
        return true;
      }
    }
    return false;
  }

  /**
   * 星系が変わった。敵と弾を片付け、その星系の哨戒隊を用意する。
   * @param system src/universe/system.js が作った星系
   * @param planets その星系の Planet の配列 (system.planets と同じ順)
   */
  setSystem(system, planets) {
    this.clearAll();
    this._rocks = [];
    this._rockCenter.x = NaN;
    this.zones = system.zones.map((z) => {
      const zone = {
        label: 'HOSTILES', roster: [...z.roster], members: 0, spawned: false, cleared: false,
        world: new THREE.Vector3(),
      };
      if (z.kind === 'belt') {
        zone.kind = 'space';
        zone.radius = 30e3;
        zone.sysPos = new THREE.Vector3(...system.belt.position);
      } else {
        const planet = planets[z.planet];
        const la = z.lat * DEG, lo = z.lon * DEG;
        zone.kind = 'planet';
        zone.radius = 40e3;
        zone.planet = planet;
        zone.local = new THREE.Vector3(Math.cos(la) * Math.cos(lo), Math.sin(la), Math.cos(la) * Math.sin(lo))
          .multiplyScalar(planet.radius + z.altitude);
      }
      return zone;
    });
  }

  /** 世界座標の原点が d だけ動いた。宇宙にある物の座標を合わせる。 */
  shift(d) {
    for (const e of this.enemies) {
      e.ship.body.pos.sub(d);
      e.ship.body.prevPos.sub(d);
      e.pilot.home.sub(d);
      e.pilot.waypoint.sub(d);
    }
    for (const m of this.missiles) {
      m.pos.sub(d);
      m.check.sub(d);
    }
    const b = this.bolts;
    for (let i = 0; i < b.count * 3; i += 3) {
      b.pos[i] -= d.x; b.pos[i + 1] -= d.y; b.pos[i + 2] -= d.z;
      b.check[i] -= d.x; b.check[i + 1] -= d.y; b.check[i + 2] -= d.z;
    }
    for (const e of this.effects.sprites) e.pos.sub(d);
    this._rocks = [];
    this._rockCenter.x = NaN;
  }

  /** 小惑星の位置をフレーム座標で用意する (宇宙で、小惑星帯の近くにいるときだけ当たり判定がある)。 */
  _updateRocks() {
    const field = this.game.asteroids;
    const near = !this.game.frame && field.mesh.visible &&
      field.center.distanceToSquared(this.game.ship.body.pos) < 45e3 ** 2;
    if (!near) {
      if (this._rocks.length) this._rocks = [];
      this._rockCenter.x = NaN;
      return;
    }
    if (this._rockCenter.equals(field.center) && this._rocks.length) return;
    this._rockCenter.copy(field.center);
    this._rocks = field.rocks.map((k) => ({
      pos: new THREE.Vector3(k.x, k.y, k.z).add(field.center), r: k.r,
    }));
  }

  /** 哨戒隊の中心をフレーム座標で返す。今の座標系で表せないときは null。 */
  _zoneCenter(zone) {
    const frame = this.game.frame;
    if (zone.kind === 'space') return frame ? null : zone.world.copy(zone.sysPos).sub(this.game.origin);
    return frame === zone.planet ? zone.local : null;
  }

  // ---------------------------------------------------------------- 敵の出し入れ

  /** 向きを作る。up があれば水平飛行の姿勢、なければ dir を向くだけ。 */
  _orient(dir, up, out) {
    if (!up) return out.setFromUnitVectors(_v.set(0, 0, -1), dir);
    const fwd = _v.copy(dir).addScaledVector(up, -dir.dot(up));
    if (fwd.lengthSq() < 1e-6) fwd.set(up.y, up.z, up.x).cross(up);
    fwd.normalize();
    const right = _v2.crossVectors(fwd, up);
    return out.setFromRotationMatrix(_m4.makeBasis(right, up, _v3.copy(fwd).negate()));
  }

  spawnEnemy(type, pos, dir, { home = pos, alerted = false, zone = null, speed = 200 } = {}) {
    if (this.enemies.length >= MAX_ENEMIES) return null;
    const def = TYPES[type] || TYPES.raider;
    const ship = new Ship(def.params);
    const b = ship.body;
    const frame = this.game.frame;
    const up = frame ? frame.upAt(pos, new THREE.Vector3()) : null;
    b.pos.copy(pos);
    // 地面の中や地面すれすれには出さない
    if (up) {
      const alt = this.altitudeAt(b.pos);
      if (alt < 500) b.pos.addScaledVector(up, 500 - alt);
    }
    this._orient(dir, up, b.quat);
    b.vel.set(0, 0, -speed).applyQuaternion(b.quat);
    b.prevPos.copy(b.pos);
    b.prevQuat.copy(b.quat);

    const model = createShipModel(def.colors);
    model.scale.setScalar(def.scale);
    this.game.scene.add(model);

    const enemy = {
      ship, team: 1, radius: def.params.radius, type, name: def.params.name,
      controls: makeControls(), alive: true, model,
      pilot: new Pilot({
        skill: type === 'gunship' ? 0.6 : 0.4 + this.rand() * 0.35,
        seed: Math.floor(this.rand() * 1e9), home, patrolRadius: 3000,
      }),
      env: { speedScale: 1, gravity: new THREE.Vector3(), rho: 0, aero: 0, onGround: false },
      gunTimer: 0, gunSide: 0, missileTimer: 4 + this.rand() * 6,
      underFire: 0, missileThreat: false, alerted, zone,
      phase: this.enemies.length % AI_EVERY,
      renderPos: new THREE.Vector3(),
    };
    this.enemies.push(enemy);
    this.actors.push(enemy);
    if (zone) zone.members++;
    return enemy;
  }

  _removeEnemy(enemy) {
    enemy.alive = false;
    this.game.scene.remove(enemy.model);
    this.enemies.splice(this.enemies.indexOf(enemy), 1);
    this.actors.splice(this.actors.indexOf(enemy), 1);
    if (enemy.zone) enemy.zone.members--;
    if (this.target === enemy) {
      this.target = null;
      this.lock = 0;
      this.locked = false;
    }
  }

  /** 敵を撃墜する。 */
  _destroyEnemy(enemy, byPlayer) {
    if (!enemy.alive) return;
    const b = enemy.ship.body;
    this.effects.explosion(b.pos, b.vel, enemy.type === 'gunship' ? 1.4 : 1);
    const dist = b.pos.distanceTo(this.game.ship.body.pos);
    this.game.sound.explosion(Math.min(1, 600 / Math.max(dist, 1)));
    const zone = enemy.zone;
    this._removeEnemy(enemy);
    if (byPlayer) this.kills++;
    if (zone && zone.members === 0 && zone.roster.length === 0 && !zone.cleared) {
      zone.cleared = true;
      this.game.notify('敵の哨戒隊を全滅させた');
    }
  }

  /** 敵を静かに引っ込める (遠く離れた、座標系が変わった)。哨戒隊の敵は次回また現れる。 */
  _despawn(enemy) {
    if (enemy.zone) enemy.zone.roster.push(enemy.type);
    const zone = enemy.zone;
    this._removeEnemy(enemy);
    if (zone && zone.members === 0) zone.spawned = false;
  }

  clearAll() {
    while (this.enemies.length) this._despawn(this.enemies[0]);
    this.bolts.clear();
    this.missiles.length = 0;
  }

  /** 自機の座標系が切り替わった。敵と弾はいったん片付ける (切り替わるのは惑星から遠い場所)。 */
  reframe() {
    this.clearAll();
    this._updateRocks();
  }

  _updateZones() {
    const game = this.game;
    const playerPos = game.ship.body.pos;
    const enabled = game.settings.enemies !== false;

    for (const e of [...this.enemies]) {
      if (!enabled || e.ship.body.pos.distanceToSquared(playerPos) > DESPAWN_DISTANCE ** 2) this._despawn(e);
    }
    if (!enabled) return;

    for (const zone of this.zones) {
      if (zone.spawned || zone.roster.length === 0) continue;
      const center = this._zoneCenter(zone);
      if (!center || center.distanceToSquared(playerPos) > zone.radius ** 2) continue;
      const roster = zone.roster;
      zone.roster = [];
      zone.spawned = true;
      roster.forEach((type, i) => {
        const pos = this._randomDir(_v3).multiplyScalar(800 + 600 * i).add(center).clone();
        if (zone.kind === 'planet') pos.setLength(center.length() + (i - 1) * 300);
        const made = this.spawnEnemy(type, pos, this._randomDir(new THREE.Vector3()), { home: center, zone });
        if (!made) zone.roster.push(type); // 上限で出せなかった分は次回に回す
      });
    }
  }

  _randomDir(out) {
    out.set(this.rand() * 2 - 1, this.rand() * 2 - 1, this.rand() * 2 - 1);
    if (out.lengthSq() < 1e-4) out.set(1, 0, 0);
    return out.normalize();
  }

  /** 増援を呼ぶ。回を重ねるごとに数が増える。 */
  reinforce() {
    const game = this.game;
    if (game.settings.enemies === false) {
      game.notify('敵の出現は設定で OFF になっています');
      return;
    }
    if (game.destroyed) return;
    if (game.frame && game.frame.safe) {
      game.notify('居住地の中では敵を呼べません');
      return;
    }
    const room = MAX_ENEMIES - this.enemies.length;
    if (room <= 0) {
      game.notify('これ以上は呼べません');
      return;
    }
    this.wave++;
    const types = [];
    const n = Math.min(1 + this.wave, 4);
    for (let i = 0; i < n; i++) types.push('raider');
    if (this.wave % 3 === 0) types.push('gunship');
    types.length = Math.min(types.length, room);

    const pb = game.ship.body;
    const up = game.frame ? game.frame.upAt(pb.pos, new THREE.Vector3()) : null;
    // 自機の前方、やや横にずれた 5〜7km 先に出す
    const ahead = new THREE.Vector3(0, 0, -1).applyQuaternion(pb.quat);
    if (up) ahead.addScaledVector(up, -ahead.dot(up));
    if (ahead.lengthSq() < 1e-4) this._randomDir(ahead);
    ahead.normalize();
    types.forEach((type, i) => {
      const side = this._randomDir(new THREE.Vector3());
      if (up) side.addScaledVector(up, -side.dot(up));
      const pos = pb.pos.clone().addScaledVector(ahead, 5000 + this.rand() * 2000).addScaledVector(side, 600 + 400 * i);
      if (up) {
        // 地面から十分な高さを確保する
        const alt = this.altitudeAt(pos);
        if (alt < 1500) pos.addScaledVector(game.frame.upAt(pos, new THREE.Vector3()), 1500 - alt);
      }
      const dir = pb.pos.clone().sub(pos).normalize();
      this.spawnEnemy(type, pos, dir, { home: pb.pos, alerted: true });
    });
    game.notify(`増援 第${this.wave}波: ${types.length}機`);
    game.sound.click();
  }

  // ---------------------------------------------------------------- 武器

  /**
   * 機関砲を撃つ。ロック中の的の見越し点が砲の首振り範囲に入っていれば、そちらへ向ける。
   * @returns 撃ったか
   */
  _fireGun(actor, target) {
    const ship = actor.ship;
    const w = ship.params.weapons;
    if (actor.gunTimer > 0 || ship.energy < w.gunEnergy) return false;
    ship.energy -= w.gunEnergy;
    actor.gunTimer = 1 / w.gunRate;
    actor.gunSide ^= 1;
    const b = ship.body;
    const muzzle = _v.copy(MUZZLES[actor.gunSide]).applyQuaternion(b.quat).add(b.pos);
    const dir = _fwd.set(0, 0, -1).applyQuaternion(b.quat);
    if (target && target.alive && w.gunGimbal > 0) {
      const tb = target.ship.body;
      const t = leadPoint(muzzle, b.vel, tb.pos, tb.vel, w.gunSpeed, _lead);
      if (t > 0 && t < w.gunLife) {
        // 弾は自機の速度も持つので、その分を引いた向きへ撃つ
        _v2.copy(_lead).sub(muzzle).addScaledVector(b.vel, -t).normalize();
        if (angleBetween(dir, _v2) < w.gunGimbal * DEG) dir.copy(_v2);
      }
    }
    const vel = _v3.copy(dir).multiplyScalar(w.gunSpeed).add(b.vel);
    this.bolts.spawn(muzzle, vel, actor.team, w.gunDamage, w.gunLife, actor);
    return true;
  }

  _fireMissile(actor, target) {
    const ship = actor.ship;
    if (ship.missiles <= 0 || actor.missileTimer > 0 || !target || !target.alive) return false;
    ship.missiles--;
    actor.missileTimer = ship.params.weapons.missileCooldown;
    const b = ship.body;
    const pos = _v.set(0, -1.6, 0).applyQuaternion(b.quat).add(b.pos);
    const vel = _v2.set(0, 0, -80).applyQuaternion(b.quat).add(b.vel);
    this.missiles.push(new Missile(pos, vel, target, actor.team, ship.params.weapons.missileDamage, actor));
    const dist = b.pos.distanceTo(this.game.ship.body.pos);
    this.game.sound.missile(actor.isPlayer ? 1 : Math.min(1, 300 / Math.max(dist, 1)));
    return true;
  }

  /** 弾やミサイルが何かに当たった。actor が null なら地形・小惑星。 */
  _hit(actor, point, damage, owner) {
    if (!actor) {
      this.effects.spark(point, false);
      return;
    }
    const reachedHull = actor.ship.takeDamage(damage);
    this.effects.spark(point, !reachedHull);
    actor.underFire = 2;
    if (actor.isPlayer) {
      this.game.onPlayerHit(damage, reachedHull);
      return;
    }
    // 撃たれたら、近くの仲間も含めて戦闘に入る
    for (const e of this.enemies) {
      if (e === actor || e.ship.body.pos.distanceToSquared(actor.ship.body.pos) < 6000 ** 2) e.alerted = true;
    }
    if (owner && owner.isPlayer) {
      this.hitMarker = 0.18;
      this.game.sound.hit(reachedHull);
    }
    if (actor.ship.hull <= 0) this._destroyEnemy(actor, !!(owner && owner.isPlayer));
  }

  // ---------------------------------------------------------------- ロックオン

  /** 的を選ぶ。next = false: 機首に最も近い敵。next = true: 今の的の次に近い敵。 */
  selectTarget(next = false) {
    if (!this.enemies.length) {
      this.target = null;
      return;
    }
    const pb = this.game.ship.body;
    let pick = null;
    if (next) {
      const sorted = [...this.enemies].sort(
        (a, b) => a.ship.body.pos.distanceToSquared(pb.pos) - b.ship.body.pos.distanceToSquared(pb.pos));
      pick = sorted[(sorted.indexOf(this.target) + 1) % sorted.length];
    } else {
      _fwd.set(0, 0, -1).applyQuaternion(pb.quat);
      let best = Infinity;
      for (const e of this.enemies) {
        _v.subVectors(e.ship.body.pos, pb.pos);
        const dist = _v.length();
        const angle = angleBetween(_fwd, _v.divideScalar(Math.max(dist, 1)));
        // 機首に近いものを優先し、同じくらいなら近い方
        const score = angle + dist / 40000;
        if (score < best) {
          best = score;
          pick = e;
        }
      }
    }
    if (pick !== this.target) {
      this.target = pick;
      this.lock = 0;
      this.locked = false;
      this.game.sound.click();
    }
  }

  _updateLock(dt) {
    const game = this.game;
    const pb = game.ship.body;
    const w = game.ship.params.weapons;
    this._leadValid = false;

    if (!this.target && this.tick % 60 === 0) {
      // 的がいなければ、近くの敵を自動で選ぶ
      let best = AUTO_TARGET_RANGE ** 2, pick = null;
      for (const e of this.enemies) {
        const d = e.ship.body.pos.distanceToSquared(pb.pos);
        if (d < best) {
          best = d;
          pick = e;
        }
      }
      this.target = pick;
    }
    const t = this.target;
    if (!t) {
      this.lock = 0;
      this.locked = false;
      return;
    }
    const tb = t.ship.body;
    _v.subVectors(tb.pos, pb.pos);
    const dist = _v.length();
    _fwd.set(0, 0, -1).applyQuaternion(pb.quat);
    const angle = angleBetween(_fwd, _v.divideScalar(Math.max(dist, 1)));
    const can = !this.player.alive ? false
      : dist < w.lockRange && angle < w.lockCone * DEG && !game.ship.driving;
    this.lock = Math.min(1, Math.max(0, this.lock + (can ? dt / w.lockTime : -dt * 0.8)));
    if (this.lock >= 1) this.locked = true;
    else if (this.lock < 0.6) this.locked = false;

    // 見越し点: 機首をここへ向ければ弾が当たる
    const time = leadPoint(pb.pos, pb.vel, tb.pos, tb.vel, w.gunSpeed, _lead);
    if (time > 0 && time < w.gunLife) {
      this._leadAim.copy(_lead).addScaledVector(pb.vel, -time);
      this._leadValid = true;
    }
  }

  // ---------------------------------------------------------------- 毎ステップ

  step(h) {
    const game = this.game;
    const player = this.player;
    const pship = game.ship;
    this.tick++;
    player.alive = !game.destroyed;
    this.firedGun = false;
    this.hitMarker = Math.max(0, this.hitMarker - h);

    if (this.tick % 60 === 1) {
      this._updateRocks();
      this._updateZones();
    }

    // --- 自機の武器 ---
    player.gunTimer -= h;
    player.missileTimer -= h;
    player.underFire -= h;
    const canShoot = player.alive && !pship.driving && !game.paused;
    if (canShoot && game.input.firing) {
      this.firedGun = this._fireGun(player, this.target);
      if (this.firedGun) game.sound.gun();
    }
    this._updateLock(h);

    // --- 敵機 ---
    for (let i = this.enemies.length - 1; i >= 0; i--) {
      const e = this.enemies[i];
      const ship = e.ship;
      const b = ship.body;
      game.envAt(b.pos, e.env, b.vel);
      e.gunTimer -= h;
      e.missileTimer -= h;
      e.underFire -= h;

      if ((this.tick + e.phase) % AI_EVERY === 0) {
        e.missileThreat = this.missiles.some((m) => m.target === e && m.tracking);
        e.pilot.update(AI_DT, e, player.alive ? player : null, this.world);
        // 地面や小惑星にぶつかったら墜落
        if (this.altitudeAt(b.pos) < 4 || this._insideRock(b.pos, e.radius)) {
          this._destroyEnemy(e, false);
          continue;
        }
        // 損傷した機体は火を引く
        if (ship.hull < ship.hullMax * 0.4) {
          this.effects.spawn(b.pos, { size0: 5, size1: 12, life: 0.7, color: 0xff7030, vel: _v.copy(b.vel).multiplyScalar(0.9) });
        }
      }

      ship.applyForces(h, e.controls, e.env);
      b.integrate(h);
      ship.updateSystems(h);

      if (player.alive) {
        if (e.pilot.wantGun) this._fireGun(e, player);
        if (e.pilot.wantMissile) this._fireMissile(e, player);
      }
      if (ship.hull <= 0) this._destroyEnemy(e, false);
    }

    // --- 弾とミサイル ---
    this.bolts.step(h, this.actors, this._solidHit, this._onBoltHit);

    let threat = false;
    for (let i = this.missiles.length - 1; i >= 0; i--) {
      const m = this.missiles[i];
      const result = m.step(h);
      if (m.target === player && m.tracking) threat = true;
      // 煙と炎
      m.smoke += h;
      if (m.smoke > 0.03) {
        m.smoke = 0;
        const burning = m.age < 6;
        this.effects.spawn(m.pos, burning
          ? { size0: 4, size1: 9, life: 0.7, color: 0xaab0c0, alpha: 0.35 }
          : { size0: 2, size1: 2, life: 0.1, color: 0x8890a0, alpha: 0.3 });
        if (burning) this.effects.spawn(m.pos, { size0: 9, size1: 5, life: 0.06, color: 0xffd090 });
      }
      let done = result === 'expired';
      if (result === 'hit') {
        this.effects.explosion(m.pos, m.target.ship.body.vel, 0.35);
        this._hit(m.target, m.pos, m.damage, m.owner);
        game.sound.explosion(m.target === player ? 0.8 : Math.min(0.6, 300 / Math.max(m.pos.distanceTo(pship.body.pos), 1)));
        done = true;
      } else if (!done && ++m.tick >= AI_EVERY) {
        m.tick = 0;
        if (this.solidHit(m.check, m.pos, _v)) {
          this.effects.explosion(_v, null, 0.35);
          done = true;
        }
        m.check.copy(m.pos);
      }
      if (done) this.missiles.splice(i, 1);
    }
    player.missileThreat = threat;

    // --- 衝突 ---
    if (player.alive) {
      this._collideShips();
      this._collideRocks();
    }

    this._updateRearm(h);
    this.effects.step(h);
  }

  /** 自機がミサイルを撃つ (キーを押したとき)。 */
  fireMissile() {
    const game = this.game;
    if (game.destroyed || game.ship.driving) return;
    if (game.ship.missiles <= 0) {
      game.notify('ミサイル残数 0 — 着陸すると補給される', 2);
      return;
    }
    if (!this.locked) {
      game.notify(this.target ? 'ロックオンしていません' : '的がいません (T で選ぶ)', 1.5);
      return;
    }
    this._fireMissile(this.player, this.target);
  }

  _insideRock(pos, radius) {
    for (const rock of this._rocks) {
      const lim = rock.r + radius;
      if (pos.distanceToSquared(rock.pos) < lim * lim) return true;
    }
    return false;
  }

  /** 自機と敵機の衝突。双方が損傷し、はじき合う。 */
  _collideShips() {
    const game = this.game;
    const pb = game.ship.body;
    for (const e of [...this.enemies]) {
      const eb = e.ship.body;
      const lim = this.player.radius + e.radius;
      if (pb.pos.distanceToSquared(eb.pos) > lim * lim) continue;
      const n = _v.subVectors(pb.pos, eb.pos);
      const d = n.length();
      n.divideScalar(Math.max(d, 1e-3));
      const vn = _v2.subVectors(pb.vel, eb.vel).dot(n);
      if (vn >= 0) continue; // すでに離れつつある
      const damage = 25 + -vn * 0.15;
      pb.vel.addScaledVector(n, -vn * 0.6);
      eb.vel.addScaledVector(n, vn * 0.6);
      pb.pos.addScaledVector(n, lim - d);
      const reached = game.ship.takeDamage(damage);
      game.onPlayerHit(damage, reached);
      game.sound.thump(Math.min(30, -vn));
      e.ship.takeDamage(damage);
      e.alerted = true;
      this.effects.spark(_v3.copy(eb.pos).addScaledVector(n, e.radius), false);
      if (e.ship.hull <= 0) this._destroyEnemy(e, true);
    }
  }

  /** 自機と小惑星の衝突。 */
  _collideRocks() {
    const game = this.game;
    const pb = game.ship.body;
    const radius = 5;
    for (const rock of this._rocks) {
      const lim = rock.r + radius;
      if (pb.pos.distanceToSquared(rock.pos) > lim * lim) continue;
      const n = _v.subVectors(pb.pos, rock.pos);
      const d = n.length();
      n.divideScalar(Math.max(d, 1e-3));
      const vn = pb.vel.dot(n);
      pb.pos.addScaledVector(n, lim - d);
      if (vn >= 0) continue;
      const s = -vn;
      pb.vel.addScaledVector(n, -vn * 1.3);
      if (s > 3) {
        const damage = Math.min(500, (s - 3) ** 2 * 0.5);
        const reached = game.ship.takeDamage(damage);
        game.onPlayerHit(damage, reached);
      }
      if (s > 0.6) game.sound.thump(Math.min(30, s));
    }
  }

  /** 着陸して止まっていると、機体が修理されミサイルが補給される。 */
  _updateRearm(h) {
    const game = this.game;
    const ship = game.ship;
    const need = ship.hull < ship.hullMax || ship.missiles < ship.params.weapons.missiles;
    if (!game.landed || game.destroyed) {
      this.rearmTimer = 0;
      return;
    }
    if (!need) {
      this.rearmTimer = 0;
      return;
    }
    this.rearmTimer += h;
    if (this.rearmTimer < REARM_TIME) return;
    ship.hull = Math.min(ship.hullMax, ship.hull + 25 * h);
    if (ship.hull >= ship.hullMax) {
      ship.missiles = ship.params.weapons.missiles;
      this.rearmTimer = 0;
      game.notify('修理・補給が完了した');
      game.sound.click();
    }
  }

  // ---------------------------------------------------------------- 描画

  /** 描画の直前に呼ぶ。cam はカメラのフレーム座標。 */
  render(cam, alpha, time) {
    for (const e of this.enemies) {
      const b = e.ship.body;
      b.getInterpolated(alpha, _v, _q);
      e.renderPos.subVectors(_v, cam);
      e.model.position.copy(e.renderPos);
      e.model.quaternion.copy(_q);
      e.model.userData.setThrust(e.ship.thrustLevel, e.ship.boosting, time);
    }
    this.effects.render(cam, this.bolts);
  }

  /** HUD に渡す情報。game.project が使える状態 (カメラ確定後) で呼ぶこと。 */
  hudData() {
    const game = this.game;
    const ship = game.ship;
    const w = ship.params.weapons;
    const selfRel = game.shipModel.position; // 自機の、カメラから見た位置
    _q.copy(game._sQuat).invert();

    const enemies = [];
    const radar = [];
    for (const e of this.enemies) {
      const p = game.project(e.renderPos);
      const dist = _v.subVectors(e.renderPos, selfRel).length();
      enemies.push({ x: p.x, y: p.y, visible: p.visible, dist, isTarget: e === this.target, heavy: e.type === 'gunship' });
      const local = _v.applyQuaternion(_q);
      radar.push({ x: local.x, y: local.y, z: local.z, kind: e === this.target ? 2 : 1 });
    }
    for (const m of this.missiles) {
      const local = _v.subVectors(m.pos, game.rig.pos).sub(selfRel).applyQuaternion(_q);
      radar.push({ x: local.x, y: local.y, z: local.z, kind: m.team === 0 ? 3 : 4 });
    }

    let target = null;
    const t = this.target;
    if (t) {
      const p = game.project(t.renderPos);
      const rel = _v.subVectors(t.renderPos, selfRel);
      const dist = rel.length();
      const closing = -_v2.subVectors(t.ship.body.vel, ship.body.vel).dot(rel) / Math.max(dist, 1);
      // 画面外にいるときに方向を示すため、カメラから見た向き (右 +x, 上 +y) を求める
      const camLocal = _v3.copy(t.renderPos).applyQuaternion(game._qInv);
      const len = Math.hypot(camLocal.x, camLocal.y) || 1;
      let lead = null;
      if (this._leadValid && dist < w.gunSpeed * w.gunLife) {
        const lp = game.project(_v2.subVectors(this._leadAim, ship.body.pos).add(selfRel));
        if (lp.front) lead = lp;
      }
      target = {
        x: p.x, y: p.y, visible: p.visible, dist, closing, name: t.name,
        shield: t.ship.shield / t.ship.shieldMax, hull: Math.max(0, t.ship.hull / t.ship.hullMax),
        dirX: camLocal.x / len, dirY: camLocal.y / len, lead,
        inRange: dist < w.gunSpeed * w.gunLife,
      };
    }

    const zones = [];
    for (const zone of this.zones) {
      if (zone.spawned || zone.roster.length === 0) continue;
      const center = this._zoneCenter(zone);
      if (!center) continue;
      const rel = _v.subVectors(center, game.rig.pos);
      const p = game.project(rel);
      if (p.visible) zones.push({ x: p.x, y: p.y, label: zone.label, dist: rel.length() });
    }

    return {
      enemies, radar, target, zones,
      lock: this.lock, locked: this.locked,
      missiles: ship.missiles, energy: ship.energy / w.energyMax,
      shield: ship.shield / ship.shieldMax,
      missileWarning: this.player.missileThreat,
      kills: this.kills, count: this.enemies.length,
      hitMarker: this.hitMarker > 0,
      rearm: this.rearmTimer > 0 ? Math.min(1, this.rearmTimer / REARM_TIME) : 0,
    };
  }
}
