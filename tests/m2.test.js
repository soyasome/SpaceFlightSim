import { Vector3, Quaternion } from 'three';
import { test, assert, near } from './harness.js';
import { makeTerrain } from '../src/terrain/terrainFn.js';
import { buildChunk, buildIndices, faceDir, VERTEX_COUNT, GRID } from '../src/terrain/chunkBuilder.js';
import { RigidBody } from '../src/physics/body.js';
import { enterFrame, leaveFrame } from '../src/physics/frame.js';

const DEF = { seed: 2024, radius: 400e3 };

test('地形: 同じシードなら同じ標高、違うシードなら違う標高', () => {
  const a = makeTerrain(DEF), b = makeTerrain(DEF), c = makeTerrain({ ...DEF, seed: 7 });
  const d = new Vector3(0.3, 0.5, -0.8).normalize();
  assert(a.height(d.x, d.y, d.z) === b.height(d.x, d.y, d.z), '決定論的でない');
  assert(a.height(d.x, d.y, d.z) !== c.height(d.x, d.y, d.z), 'シードが効いていない');
});

test('地形: 標高は現実的な範囲に収まり、海と陸の両方がある', () => {
  const t = makeTerrain(DEF);
  let min = Infinity, max = -Infinity, land = 0;
  const N = 4000;
  for (let i = 0; i < N; i++) {
    // 球面上にほぼ均等に点を置く
    const y = 1 - (2 * (i + 0.5)) / N, r = Math.sqrt(1 - y * y), a = i * 2.399963;
    const h = t.height(Math.cos(a) * r, y, Math.sin(a) * r, 500);
    min = Math.min(min, h); max = Math.max(max, h);
    if (h > 0) land++;
  }
  assert(Number.isFinite(min) && Number.isFinite(max), 'NaN');
  assert(min > -6000 && max < 14000, `範囲外: ${min} .. ${max}`);
  const frac = land / N;
  assert(frac > 0.2 && frac < 0.8, `陸の割合が偏りすぎ: ${frac}`);
});

test('地形: 細部を省いても大きな形は変わらない (LOD間のずれが小さい)', () => {
  const t = makeTerrain(DEF);
  const d = new Vector3(-0.2, 0.4, 0.9).normalize();
  const fine = t.height(d.x, d.y, d.z, 1);
  const coarse = t.height(d.x, d.y, d.z, 40);
  assert(Math.abs(fine - coarse) < 40, `差が大きい: ${fine - coarse}`);
});

test('チャンク: 配列の大きさとインデックスの範囲が正しい', () => {
  const t = makeTerrain(DEF);
  const c = buildChunk(t, 0, 3, 2, 5);
  assert(c.positions.length === VERTEX_COUNT * 3, 'positions');
  assert(c.normals.length === VERTEX_COUNT * 3, 'normals');
  assert(c.colors.length === VERTEX_COUNT * 4, 'colors');
  assert(c.positions.every(Number.isFinite), 'NaN in positions');
  const idx = buildIndices();
  assert(idx.length === (GRID * GRID + 4 * GRID) * 6, 'index count');
  assert(idx.every((i) => i < VERTEX_COUNT), 'index out of range');
});

test('チャンク: 隣り合うチャンクの境界の頂点が一致する (継ぎ目が開かない)', () => {
  const t = makeTerrain(DEF);
  const a = buildChunk(t, 4, 5, 10, 7), b = buildChunk(t, 4, 5, 11, 7);
  const V = GRID + 1;
  for (let j = 0; j < V; j++) {
    const ia = (j * V + GRID) * 3, ib = (j * V) * 3;
    for (let k = 0; k < 3; k++) {
      const wa = a.positions[ia + k] + a.center[k], wb = b.positions[ib + k] + b.center[k];
      near(wa, wb, 0.05, `頂点 ${j} 成分 ${k}`);
    }
  }
});

test('チャンク: 立方体の面の境目でも頂点が一致する', () => {
  // 面0 (+X) の s=0 の辺と、面4 (+Z) の s=1 の辺は同じ稜線
  const p = faceDir(0, 0, 0.3, [0, 0, 0]), q = faceDir(4, 1, 0.3, [0, 0, 0]);
  for (let k = 0; k < 3; k++) near(p[k], q[k], 1e-12);
});

test('チャンク: 法線は外向きの単位ベクトル', () => {
  const t = makeTerrain(DEF);
  const c = buildChunk(t, 2, 8, 100, 100);
  for (let i = 0; i < (GRID + 1) * (GRID + 1); i++) {
    const n = new Vector3(c.normals[i * 3], c.normals[i * 3 + 1], c.normals[i * 3 + 2]);
    near(n.length(), 1, 1e-4, '|n|');
    const p = new Vector3(c.positions[i * 3] + c.center[0], c.positions[i * 3 + 1] + c.center[1],
      c.positions[i * 3 + 2] + c.center[2]).normalize();
    assert(n.dot(p) > 0, '法線が内向き');
  }
});

test('座標系: 惑星ローカル座標に入って出ると元の状態に戻る', () => {
  const planet = {
    pos: new Vector3(9e5, -3e5, -3.2e6),
    quat: new Quaternion().setFromAxisAngle(new Vector3(0.2, 1, 0.1).normalize(), 1.234),
    omega: 8.7e-4,
  };
  const b = new RigidBody();
  b.pos.set(1.1e6, -2e5, -2.9e6);
  b.vel.set(120, -40, 300);
  b.quat.setFromAxisAngle(new Vector3(1, 2, 3).normalize(), 0.7);
  const p0 = b.pos.clone(), v0 = b.vel.clone(), q0 = b.quat.clone();
  enterFrame(b, planet);
  assert(b.pos.distanceTo(p0) > 1e5, '変換されていない');
  leaveFrame(b, planet);
  near(b.pos.distanceTo(p0), 0, 1e-6, '位置');
  near(b.vel.distanceTo(v0), 0, 1e-9, '速度');
  near(Math.abs(b.quat.dot(q0)), 1, 1e-12, '姿勢');
});

test('座標系: 地表と一緒に回っている物体は、惑星ローカル座標では静止している', () => {
  const planet = { pos: new Vector3(), quat: new Quaternion(), omega: 8.7e-4 };
  const b = new RigidBody();
  b.pos.set(400e3, 0, 0);
  b.vel.set(0, 0, -planet.omega * 400e3); // Y軸まわりの自転による速度 ω × r
  enterFrame(b, planet);
  near(b.vel.length(), 0, 1e-9, 'ローカル速度');
});
