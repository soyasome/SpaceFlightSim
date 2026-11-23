// 地形チャンクのメッシュを裏で作る Worker。
import { makeTerrain } from './terrainFn.js';
import { buildChunk } from './chunkBuilder.js';
import { loadMaps, mapNamesOf } from './maps.js';

const terrains = new Map(); // 惑星ごとの地形関数
const MAX_TERRAINS = 16; // 星系を移り続けても増え続けないよう、これを超えたら作り直す

/**
 * 地形関数を作る。本物の地形のマップを使う天体なら、先にマップを読み込む (docs/design-earth-moon.md の 7章)。
 * メインスレッドは読み込めたマップの名前だけを渡してくるので、ここで読めないのはまれ。
 * そのときは今のノイズの地形で作り、コンソールに出す。
 */
async function terrainFor(def) {
  const names = mapNamesOf(def.terrain);
  if (names.length) {
    try {
      await loadMaps(names);
    } catch (err) {
      console.error(`地形の Worker でマップを読み込めなかった (${names.join(', ')})。ノイズの地形で作る:`, err);
      const { maps: _m, heightScale: _h, ...rest } = def.terrain;
      return makeTerrain({ ...def, terrain: rest });
    }
  }
  return makeTerrain(def);
}

self.onmessage = async (e) => {
  const { id, def, face, level, x, y } = e.data;
  const key = def.key;
  let terrain = terrains.get(key);
  if (!terrain) {
    terrain = await terrainFor(def);
    if (terrains.size >= MAX_TERRAINS) terrains.clear();
    terrains.set(key, terrain);
  }
  const r = buildChunk(terrain, face, level, x, y);
  self.postMessage({ id, ...r }, [r.positions.buffer, r.normals.buffer, r.colors.buffer]);
};
