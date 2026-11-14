// 地形チャンクのメッシュを裏で作る Worker。
import { makeTerrain } from './terrainFn.js';
import { buildChunk } from './chunkBuilder.js';

const terrains = new Map(); // 惑星ごとの地形関数

self.onmessage = (e) => {
  const { id, def, face, level, x, y } = e.data;
  const key = def.key;
  let terrain = terrains.get(key);
  if (!terrain) {
    terrain = makeTerrain(def);
    terrains.set(key, terrain);
  }
  const r = buildChunk(terrain, face, level, x, y);
  self.postMessage({ id, ...r }, [r.positions.buffer, r.normals.buffer, r.colors.buffer]);
};
