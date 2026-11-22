import * as THREE from 'three';
import { faceDir, chunkSize, buildIndices, GRID } from '../terrain/chunkBuilder.js';

const SPLIT_K = 1.3; // チャンクの大きさの何倍まで近づいたら細分化するか
const MERGE_HYSTERESIS = 1.15; // 細分化と統合の境目で行ったり来たりしないための余裕
const TARGET_SPACING = 1.2; // 最も細かいレベルでの頂点間隔 (m)
const GAS_SPACING = 200; // ガス巨星の最も細かいレベルでの頂点間隔 (m)

let sharedIndex = null;

/** 地形生成 Worker の集まり。近くのチャンクから先に作る。 */
class WorkerPool {
  constructor() {
    this.pending = []; // { id, node, priority }
    this.jobs = new Map(); // id → { node, callback }
    this.nextId = 1;
    const count = Math.max(2, Math.min(6, (navigator.hardwareConcurrency || 4) - 2));
    this.workers = [];
    for (let i = 0; i < count; i++) {
      const w = new Worker(new URL('../terrain/terrainWorker.js', import.meta.url), { type: 'module' });
      w.busy = false;
      w.onmessage = (e) => {
        w.busy = false;
        const job = this.jobs.get(e.data.id);
        this.jobs.delete(e.data.id);
        if (job && !job.node.disposed) job.callback(e.data);
        this.dispatch();
      };
      w.onerror = (e) => console.error('terrain worker error:', e.message);
      this.workers.push(w);
    }
  }

  request(node, callback) {
    const id = this.nextId++;
    this.jobs.set(id, { node, callback });
    this.pending.push({ id, node });
  }

  dispatch() {
    for (const w of this.workers) {
      if (w.busy) continue;
      // 捨てられたノードの仕事は飛ばし、最も優先度の高い (priority が小さい) ものを選ぶ
      let best = -1;
      for (let i = this.pending.length - 1; i >= 0; i--) {
        const p = this.pending[i];
        if (p.node.disposed) {
          this.jobs.delete(p.id);
          this.pending.splice(i, 1);
          if (best > i) best--;
          continue;
        }
        if (best < 0 || p.node.priority < this.pending[best].node.priority) best = i;
      }
      if (best < 0) return;
      const { id, node } = this.pending.splice(best, 1)[0];
      w.busy = true;
      w.postMessage({ id, def: node.def, face: node.face, level: node.level, x: node.x, y: node.y });
    }
  }

  get queued() {
    return this.pending.length + this.workers.filter((w) => w.busy).length;
  }
}

/** Worker の集まりは全惑星で1つだけ持つ (惑星ごとに作ると、惑星の数だけスレッドが増えてしまう)。 */
let sharedPool = null;
function getPool() {
  if (!sharedPool) sharedPool = new WorkerPool();
  return sharedPool;
}

class Node {
  constructor(face, level, x, y, radius, terrain, def) {
    this.def = def; // Worker に渡す地形の定義
    this.face = face;
    this.level = level;
    this.x = x;
    this.y = y;
    this.size = chunkSize(radius, level);
    this.children = null;
    this.mesh = null;
    this.requested = false;
    this.disposed = false;
    this.priority = 0;
    // メッシュができるまでの仮の中心 (粗い地形から求める)
    const cell = 1 / (1 << level);
    const d = faceDir(face, (x + 0.5) * cell, (y + 0.5) * cell, [0, 0, 0]);
    const h = Math.max(0, terrain.height(d[0], d[1], d[2], this.size / GRID * 2));
    this.center = new THREE.Vector3(d[0], d[1], d[2]).multiplyScalar(radius + h);
  }
}

/**
 * 惑星の地表メッシュ。キューブ球の各面を四分木にして、カメラに近い所ほど細かくする。
 * メッシュはすべて group の子で、位置は惑星ローカル座標 (倍精度)。
 */
export class PlanetLod {
  constructor(def, terrain, material, group) {
    this.def = def;
    this.terrain = terrain;
    this.material = material;
    this.group = group;
    this.pool = getPool();
    // Worker に渡す地形の定義。key は Worker 側で地形関数を使い回すための名前。
    // 惑星の大きさの設定を変えると、同じ天体 (同じ def.key) でも半径と細かさが変わるので、key に含める
    const detailScale = def.detailScale ?? 1;
    this.workerDef = {
      key: `${def.key || def.seed}:${def.radius}:${detailScale}`,
      seed: def.seed, radius: def.radius, terrain: def.terrain || null, detailScale, gas: def.gas || null,
    };
    // ガス巨星は雲の頂きの 40 km 上より下へは行けない (気圧でつぶれる) ので、頂点の間隔は 200 m で十分
    const spacing = def.gas ? GAS_SPACING : TARGET_SPACING;
    this.maxLevel = Math.max(1, Math.round(
      Math.log2((Math.PI / 2) * def.radius / GRID / spacing)));
    this.roots = [];
    for (let f = 0; f < 6; f++) this.roots.push(new Node(f, 0, 0, 0, def.radius, terrain, this.workerDef));
    this.visibleCount = 0;
    this.meshCount = 0;
    if (!sharedIndex) sharedIndex = new THREE.BufferAttribute(buildIndices(), 1);
  }

  /** camLocal: 惑星ローカル座標でのカメラ位置。毎フレーム呼ぶ。 */
  update(camLocal) {
    this.cam = camLocal;
    this.visibleCount = 0;
    for (const root of this.roots) this._visit(root);
    this.pool.dispatch();
  }

  _distance(node) {
    return Math.max(1, node.center.distanceTo(this.cam) - node.size * 0.5);
  }

  _request(node) {
    if (node.requested) return;
    node.requested = true;
    this.pool.request(node, (data) => this._onChunk(node, data));
  }

  _onChunk(node, data) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(data.normals, 3));
    geo.setAttribute('aColor', new THREE.BufferAttribute(data.colors, 4, true));
    geo.setIndex(sharedIndex);
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), data.boundRadius);
    const mesh = new THREE.Mesh(geo, this.material);
    mesh.position.set(data.center[0], data.center[1], data.center[2]);
    mesh.visible = false;
    node.center.copy(mesh.position);
    node.mesh = mesh;
    this.group.add(mesh);
    this.meshCount++;
  }

  _visit(node) {
    const d = this._distance(node);
    node.priority = d / node.size;
    if (!node.mesh) {
      this._request(node);
      return;
    }
    const k = SPLIT_K * (node.children ? MERGE_HYSTERESIS : 1);
    const wantSplit = node.level < this.maxLevel && d < node.size * k;

    if (wantSplit) {
      if (!node.children) {
        const l = node.level + 1, x = node.x * 2, y = node.y * 2;
        node.children = [
          new Node(node.face, l, x, y, this.def.radius, this.terrain, this.workerDef),
          new Node(node.face, l, x + 1, y, this.def.radius, this.terrain, this.workerDef),
          new Node(node.face, l, x, y + 1, this.def.radius, this.terrain, this.workerDef),
          new Node(node.face, l, x + 1, y + 1, this.def.radius, this.terrain, this.workerDef),
        ];
      }
      let ready = true;
      for (const c of node.children) {
        if (!c.mesh) {
          c.priority = this._distance(c) / c.size;
          this._request(c);
          ready = false;
        }
      }
      if (ready) {
        // 子が4枚そろってから切り替える (穴が開かないように)
        node.mesh.visible = false;
        for (const c of node.children) this._visit(c);
        return;
      }
      this._hideDescendants(node);
    } else if (node.children) {
      this._disposeChildren(node);
    }
    node.mesh.visible = true;
    this.visibleCount++;
  }

  _hideDescendants(node) {
    if (!node.children) return;
    for (const c of node.children) {
      if (c.mesh) c.mesh.visible = false;
      this._hideDescendants(c);
    }
  }

  /** すべてのメッシュを捨てる (星系を離れたとき)。作りかけの仕事も取り消される。 */
  dispose() {
    for (const root of this.roots) {
      if (root.children) this._disposeChildren(root);
      root.disposed = true;
      if (root.mesh) {
        this.group.remove(root.mesh);
        root.mesh.geometry.dispose();
        root.mesh = null;
        this.meshCount--;
      }
    }
    this.roots = [];
    this.visibleCount = 0;
    this.material.dispose();
  }

  _disposeChildren(node) {
    for (const c of node.children) {
      if (c.children) this._disposeChildren(c);
      c.disposed = true;
      if (c.mesh) {
        this.group.remove(c.mesh);
        c.mesh.geometry.dispose();
        c.mesh = null;
        this.meshCount--;
      }
    }
    node.children = null;
  }
}
