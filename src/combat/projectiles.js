import { Vector3 } from 'three';
import { segmentSphere } from './targeting.js';

const SLOW_CHECK_EVERY = 6; // 地形・小惑星との判定は 6 ステップに1回 (重いので間引く)

const _p0 = new Vector3();
const _p1 = new Vector3();
const _c = new Vector3();
const _hit = new Vector3();

/**
 * 機関砲の弾。数が多いので、1発ずつオブジェクトにせず配列にまとめて持つ。
 * 位置はフレーム座標 (倍精度)。
 */
export class BoltPool {
  constructor(max = 600) {
    this.max = max;
    this.count = 0;
    this.pos = new Float64Array(max * 3);
    this.vel = new Float64Array(max * 3);
    this.check = new Float64Array(max * 3); // 前回、地形との判定をした位置
    this.life = new Float32Array(max);
    this.damage = new Float32Array(max);
    this.team = new Int8Array(max);
    this.tick = new Uint8Array(max);
    this.owner = new Array(max).fill(null);
  }

  spawn(pos, vel, team, damage, life, owner = null) {
    if (this.count >= this.max) return;
    const i = this.count++, k = i * 3;
    this.pos[k] = this.check[k] = pos.x;
    this.pos[k + 1] = this.check[k + 1] = pos.y;
    this.pos[k + 2] = this.check[k + 2] = pos.z;
    this.vel[k] = vel.x;
    this.vel[k + 1] = vel.y;
    this.vel[k + 2] = vel.z;
    this.team[i] = team;
    this.damage[i] = damage;
    this.life[i] = life;
    this.tick[i] = i % SLOW_CHECK_EVERY; // 判定の重い処理が同じステップに集中しないようにずらす
    this.owner[i] = owner;
  }

  clear() {
    this.count = 0;
  }

  _remove(i) {
    const j = --this.count;
    if (i === j) return;
    const a = i * 3, b = j * 3;
    for (let n = 0; n < 3; n++) {
      this.pos[a + n] = this.pos[b + n];
      this.vel[a + n] = this.vel[b + n];
      this.check[a + n] = this.check[b + n];
    }
    this.life[i] = this.life[j];
    this.damage[i] = this.damage[j];
    this.team[i] = this.team[j];
    this.tick[i] = this.tick[j];
    this.owner[i] = this.owner[j];
  }

  /**
   * 弾を進め、当たり判定をする。
   * @param actors 的になりうる機体 { alive, team, radius, ship }
   * @param solidHit (from, to, out) => boolean  地形や小惑星に当たったか (当たった位置を out に)
   * @param onHit (actor|null, point, damage, owner)  actor が null なら地形・小惑星
   */
  step(dt, actors, solidHit, onHit) {
    for (let i = this.count - 1; i >= 0; i--) {
      const k = i * 3;
      _p0.set(this.pos[k], this.pos[k + 1], this.pos[k + 2]);
      const vx = this.vel[k], vy = this.vel[k + 1], vz = this.vel[k + 2];
      _p1.set(_p0.x + vx * dt, _p0.y + vy * dt, _p0.z + vz * dt);

      // 機体との判定。的も動いているので、的から見た弾の動きで調べる
      let hitActor = null, best = 2;
      const reach = Math.sqrt(vx * vx + vy * vy + vz * vz) * dt;
      for (const a of actors) {
        if (!a.alive || a.team === this.team[i]) continue;
        const b = a.ship.body;
        const lim = reach + a.radius + b.vel.length() * dt;
        if (_p0.distanceToSquared(b.pos) > lim * lim) continue;
        _c.copy(_p1).addScaledVector(b.vel, -dt);
        const t = segmentSphere(_p0, _c, b.pos, a.radius);
        if (t >= 0 && t < best) {
          best = t;
          hitActor = a;
        }
      }
      if (hitActor) {
        _hit.lerpVectors(_p0, _p1, best);
        onHit(hitActor, _hit, this.damage[i], this.owner[i]);
        this._remove(i);
        continue;
      }

      this.pos[k] = _p1.x;
      this.pos[k + 1] = _p1.y;
      this.pos[k + 2] = _p1.z;
      this.life[i] -= dt;
      if (this.life[i] <= 0) {
        this._remove(i);
        continue;
      }

      if (++this.tick[i] >= SLOW_CHECK_EVERY) {
        this.tick[i] = 0;
        _c.set(this.check[k], this.check[k + 1], this.check[k + 2]);
        if (solidHit(_c, _p1, _hit)) {
          onHit(null, _hit, this.damage[i], this.owner[i]);
          this._remove(i);
          continue;
        }
        this.check[k] = _p1.x;
        this.check[k + 1] = _p1.y;
        this.check[k + 2] = _p1.z;
      }
    }
  }
}

// ---------------------------------------------------------------- ミサイル

export const MISSILE = {
  accel: 170, // 加速 (m/s²)
  burn: 6, // 燃焼時間 (秒)。燃え尽きると惰性で飛ぶ
  maxSpeed: 1300, // m/s
  turnAccel: 200, // 曲がる力 (m/s²)。約20G
  life: 11, // 秒
  seekerCone: 1.05, // 的を見失わない角度 (rad, 約60°)
  fuse: 6, // 的の半径に足す、起爆する距離 (m)
};

const _rel = new Vector3();
const _want = new Vector3();
const _dir = new Vector3();
const _axis = new Vector3();
const _q0 = new Vector3();
const _q1 = new Vector3();

export class Missile {
  constructor(pos, vel, target, team, damage, owner = null) {
    this.pos = pos.clone();
    this.vel = vel.clone();
    this.target = target;
    this.team = team;
    this.damage = damage;
    this.owner = owner;
    this.age = 0;
    this.tracking = true;
    this.tick = 0;
    this.check = pos.clone();
    this.smoke = 0;
  }

  /**
   * 1ステップ進める。的を追って向きを変え、当たれば 'hit'、寿命が尽きれば 'expired' を返す。
   * 誘導: 「残り時間で的に届く速度の向き」へ、曲がれる範囲で進行方向を回す。
   */
  step(dt) {
    this.age += dt;
    const speed = this.vel.length();
    const t = this.target;
    if (this.tracking && (!t || !t.alive)) this.tracking = false;

    if (this.tracking && speed > 1) {
      const tb = t.ship.body;
      _rel.subVectors(tb.pos, this.pos);
      const dist = _rel.length();
      _dir.copy(this.vel).divideScalar(speed);
      if (Math.acos(Math.min(1, Math.max(-1, _rel.dot(_dir) / Math.max(dist, 1e-6)))) > MISSILE.seekerCone) {
        this.tracking = false; // 的が視野から外れた
      } else {
        const closing = Math.max(150, speed - tb.vel.dot(_rel) / Math.max(dist, 1e-6));
        const tgo = dist / closing;
        _want.copy(_rel).divideScalar(Math.max(tgo, 1e-3)).add(tb.vel).normalize();
        const angle = Math.acos(Math.min(1, Math.max(-1, _want.dot(_dir))));
        const maxTurn = (MISSILE.turnAccel / speed) * dt;
        if (angle > 1e-6) {
          _axis.crossVectors(_dir, _want).normalize();
          _dir.applyAxisAngle(_axis, Math.min(angle, maxTurn));
        }
        this.vel.copy(_dir).multiplyScalar(speed);
      }
    }
    if (this.age < MISSILE.burn && speed < MISSILE.maxSpeed) {
      this.vel.multiplyScalar((speed + MISSILE.accel * dt) / Math.max(speed, 1e-6));
    }

    _q0.copy(this.pos);
    this.pos.addScaledVector(this.vel, dt);
    if (t && t.alive) {
      const tb = t.ship.body;
      _q1.copy(this.pos).addScaledVector(tb.vel, -dt);
      if (segmentSphere(_q0, _q1, tb.pos, t.radius + MISSILE.fuse) >= 0) return 'hit';
    }
    return this.age > MISSILE.life ? 'expired' : null;
  }
}
