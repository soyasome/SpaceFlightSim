import * as THREE from 'three';
import { softGlowTexture } from '../render/shipModel.js';

const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _p = new THREE.Vector3();
const _z = new THREE.Vector3(0, 0, 1);
const _d = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _col = new THREE.Color();

const TEAM_COLOR = [new THREE.Color(0.35, 1.0, 0.75), new THREE.Color(1.0, 0.35, 0.2)];

/**
 * 戦闘の見た目: 光の粒 (爆発・火花・煙) と弾の光跡。
 * 位置はフレーム座標で持ち、描くときにカメラ位置を引く。
 */
export class Effects {
  constructor(scene, maxSprites = 160, maxBolts = 600) {
    const tex = softGlowTexture();
    this.sprites = [];
    for (let i = 0; i < maxSprites; i++) {
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
        map: tex, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, toneMapped: false,
      }));
      sprite.visible = false;
      scene.add(sprite);
      this.sprites.push({
        sprite, pos: new THREE.Vector3(), vel: new THREE.Vector3(),
        age: 0, life: 0, size0: 1, size1: 1, alpha: 1,
      });
    }
    this.next = 0;

    // 弾: 細長い箱を1回の描画命令でまとめて描く
    const geo = new THREE.BoxGeometry(0.22, 0.22, 1);
    this.bolts = new THREE.InstancedMesh(
      geo,
      new THREE.MeshBasicMaterial({
        blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, toneMapped: false,
      }),
      maxBolts,
    );
    this.bolts.frustumCulled = false;
    this.bolts.count = 0;
    this.bolts.setColorAt(0, TEAM_COLOR[0]);
    scene.add(this.bolts);
  }

  /** 光の粒を1つ出す。size0 → size1 へ大きさが変わり、life 秒で消える。 */
  spawn(pos, { size0 = 2, size1 = 6, life = 0.4, color = 0xffffff, vel = null, alpha = 1 } = {}) {
    const e = this.sprites[this.next];
    this.next = (this.next + 1) % this.sprites.length;
    e.pos.copy(pos);
    if (vel) e.vel.copy(vel);
    else e.vel.set(0, 0, 0);
    e.age = 0;
    e.life = life;
    e.size0 = size0;
    e.size1 = size1;
    e.alpha = alpha;
    e.sprite.material.color.set(color);
    e.sprite.visible = true;
  }

  explosion(pos, vel, scale = 1) {
    this.spawn(pos, { size0: 12 * scale, size1: 90 * scale, life: 1.1, color: 0xffb060, vel });
    this.spawn(pos, { size0: 30 * scale, size1: 45 * scale, life: 0.35, color: 0xffffff, vel });
    for (let i = 0; i < 6; i++) {
      _d.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(90 * scale);
      if (vel) _d.add(vel);
      this.spawn(pos, { size0: 8 * scale, size1: 22 * scale, life: 0.9 + Math.random() * 0.7, color: 0xff7a30, vel: _d });
    }
  }

  spark(pos, shield) {
    this.spawn(pos, {
      size0: shield ? 7 : 3, size1: shield ? 16 : 9, life: shield ? 0.22 : 0.3,
      color: shield ? 0x66bbff : 0xffc070,
    });
  }

  step(dt) {
    for (const e of this.sprites) {
      if (!e.sprite.visible) continue;
      e.age += dt;
      if (e.age >= e.life) {
        e.sprite.visible = false;
        continue;
      }
      e.pos.addScaledVector(e.vel, dt);
    }
  }

  /** 描画の直前に呼ぶ。cam はカメラのフレーム座標。 */
  render(cam, boltPool) {
    for (const e of this.sprites) {
      if (!e.sprite.visible) continue;
      const k = e.age / e.life;
      e.sprite.position.subVectors(e.pos, cam);
      e.sprite.scale.setScalar(e.size0 + (e.size1 - e.size0) * k);
      e.sprite.material.opacity = e.alpha * (1 - k) * (1 - k);
    }

    const n = boltPool.count;
    const mesh = this.bolts;
    for (let i = 0; i < n; i++) {
      const k = i * 3;
      _d.set(boltPool.vel[k], boltPool.vel[k + 1], boltPool.vel[k + 2]);
      const speed = _d.length();
      _d.divideScalar(speed || 1);
      _p.set(boltPool.pos[k] - cam.x, boltPool.pos[k + 1] - cam.y, boltPool.pos[k + 2] - cam.z);
      // 遠くの弾も見えるよう、距離に応じて太くする
      const dist = _p.length();
      const thick = Math.max(1, dist / 250);
      _q.setFromUnitVectors(_z, _d);
      _s.set(thick, thick, 26);
      _p.addScaledVector(_d, -13);
      mesh.setMatrixAt(i, _m.compose(_p, _q, _s));
      mesh.setColorAt(i, _col.copy(TEAM_COLOR[boltPool.team[i]]));
    }
    mesh.count = n;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }
}
