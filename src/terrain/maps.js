// 本物の地形のマップ (標高・土地被覆・明るさ) を読み込んで、緯度経度で値を読む。
// three.js にも DOM にも依存しない (地形の Worker からも読むため)。設計: docs/design-earth-moon.md の 2.3、3.2、7章。
//
// マップは正距円筒図法の格子 (横が経度、縦が緯度。横:縦 = 2:1)。画素の並びは北から南へ、各行は経度 −180° から東へ。
// ファイル (assets/maps/<名前>.bin.gz) は、32 バイトの見出しと画素の並びを gzip したもの:
//   0  'SFMP' (4 バイト)
//   4  u16 版 (1)
//   6  u16 型 (1 = Int16, 2 = Uint8)
//   8  u32 幅、12 u32 高さ
//   16 f32 倍率、20 f32 足す値 (本当の値 = 画素の値 × 倍率 + 足す値)
//   24〜31 予備
// 数値はすべてリトルエンディアン。

const HEADER = 32;
const TYPES = { 1: Int16Array, 2: Uint8Array };
const TWO_PI = Math.PI * 2;

const maps = new Map(); // 名前 → 読み込み済みのマップ
const loading = new Map(); // 名前 → 読み込み中の Promise
const failed = new Set(); // 読み込めなかった名前

/**
 * 画素の並びからマップを作る。縮小版 (1/2、1/4、…) を前もって平均して作っておく。
 * @param data Int16Array | Uint8Array | Float32Array (幅 × 高さ)
 * @param opts { scale, offset, mips } mips: false なら縮小版を作らない (区分の番号のマップ)
 */
export function makeMap(name, width, height, data, { scale = 1, offset = 0, mips = true } = {}) {
  if (data.length !== width * height) throw new Error(`マップ ${name}: 画素の数が合わない`);
  const levels = [{ w: width, h: height, data }];
  if (mips) {
    let prev = levels[0];
    while (prev.w >= 32 && prev.h >= 16 && prev.w % 2 === 0 && prev.h % 2 === 0) {
      const w = prev.w / 2, h = prev.h / 2;
      const out = new Float32Array(w * h);
      for (let j = 0; j < h; j++) {
        const r0 = 2 * j * prev.w, r1 = r0 + prev.w;
        for (let i = 0; i < w; i++) {
          const c = 2 * i;
          out[j * w + i] = (prev.data[r0 + c] + prev.data[r0 + c + 1] + prev.data[r1 + c] + prev.data[r1 + c + 1]) * 0.25;
        }
      }
      prev = { w, h, data: out };
      levels.push(prev);
    }
  }
  return new TerrainMap(name, levels, scale, offset);
}

/** 緯度経度で値を読めるマップ。値は「画素の値 × 倍率 + 足す値」。 */
class TerrainMap {
  constructor(name, levels, scale, offset) {
    this.name = name;
    this.levels = levels;
    this.width = levels[0].w;
    this.height = levels[0].h;
    this.scale = scale;
    this.offset = offset;
    /** 1 画素の経度方向の大きさ (rad)。 */
    this.pixelAngle = TWO_PI / this.width;
  }

  /** 欲しい細かさ cell (rad) に合う縮小版の番号。 */
  levelFor(cell) {
    if (!(cell > this.pixelAngle)) return 0;
    return Math.min(this.levels.length - 1, Math.floor(Math.log2(cell / this.pixelAngle)));
  }

  /** 縮小版 L の画素 (i, j) の値。経度方向はつなぎ、緯度方向は端で止める。 */
  _px(L, i, j) {
    const lv = this.levels[L];
    i %= lv.w;
    if (i < 0) i += lv.w;
    if (j < 0) j = 0; else if (j >= lv.h) j = lv.h - 1;
    return lv.data[j * lv.w + i];
  }

  _uv(L, lat, lon) {
    const lv = this.levels[L];
    return [((lon + Math.PI) / TWO_PI) * lv.w - 0.5, ((Math.PI / 2 - lat) / Math.PI) * lv.h - 0.5];
  }

  /** 最も近い画素の値 (補間しない。区分の番号に使う)。lat, lon は rad。 */
  nearest(lat, lon) {
    const [u, v] = this._uv(0, lat, lon);
    return this._px(0, Math.round(u), Math.round(v)) * this.scale + this.offset;
  }

  /** 2×2 の画素から直線補間した値。cell: 欲しい細かさ (rad、省くと最も細かい版)。 */
  linear(lat, lon, cell = 0) {
    const L = this.levelFor(cell);
    const [u, v] = this._uv(L, lat, lon);
    const i = Math.floor(u), j = Math.floor(v);
    const fx = u - i, fy = v - j;
    const a = this._px(L, i, j), b = this._px(L, i + 1, j);
    const c = this._px(L, i, j + 1), d = this._px(L, i + 1, j + 1);
    const top = a + (b - a) * fx, bot = c + (d - c) * fx;
    return (top + (bot - top) * fy) * this.scale + this.offset;
  }

  /**
   * 4×4 の画素から滑らかにつないだ値 (Catmull-Rom の双三次補間)。標高に使う。
   * 直線補間だと、低空で画素の格子に沿った折れ目が見えるため。cell は linear と同じ。
   */
  cubic(lat, lon, cell = 0) {
    const L = this.levelFor(cell);
    const [u, v] = this._uv(L, lat, lon);
    const i = Math.floor(u), j = Math.floor(v);
    const fx = u - i, fy = v - j;
    let sum = 0;
    for (let m = -1; m <= 2; m++) {
      const wy = catmull(m, fy);
      const r = j + m;
      sum += wy * (catmull(-1, fx) * this._px(L, i - 1, r) + catmull(0, fx) * this._px(L, i, r)
        + catmull(1, fx) * this._px(L, i + 1, r) + catmull(2, fx) * this._px(L, i + 2, r));
    }
    return sum * this.scale + this.offset;
  }
}

/** Catmull-Rom の重み。k: 画素の位置 (−1, 0, 1, 2)、t: 0..1。 */
function catmull(k, t) {
  const t2 = t * t, t3 = t2 * t;
  switch (k) {
    case -1: return 0.5 * (-t3 + 2 * t2 - t);
    case 0: return 0.5 * (3 * t3 - 5 * t2 + 2);
    case 1: return 0.5 * (-3 * t3 + 4 * t2 + t);
    default: return 0.5 * (t3 - t2);
  }
}

/** ファイルの中身 (展開済み) からマップを作る。 */
export function parseMap(name, buffer, { mips = true } = {}) {
  const dv = new DataView(buffer);
  const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
  if (magic !== 'SFMP') throw new Error(`マップ ${name}: 形式が違う`);
  const Type = TYPES[dv.getUint16(6, true)];
  if (!Type) throw new Error(`マップ ${name}: 知らない型`);
  const width = dv.getUint32(8, true), height = dv.getUint32(12, true);
  const scale = dv.getFloat32(16, true), offset = dv.getFloat32(20, true);
  const count = width * height;
  // ArrayBuffer の途中から型付き配列を作るには位置が揃っている必要があるので、写す
  const data = new Type(count);
  data.set(new Type(buffer.slice(HEADER, HEADER + count * Type.BYTES_PER_ELEMENT)));
  return makeMap(name, width, height, data, { scale, offset, mips });
}

/** マップのファイルの場所。このファイルからの相対で決めるので、メインスレッドと Worker で同じになる。 */
export function mapUrl(name) {
  return new URL(`../../assets/maps/${name}.bin.gz`, import.meta.url).href;
}

/**
 * 縮小版を作らないマップかどうか。名前の決まり:
 * 〜-cover は区分の番号 (平均すると意味がなくなる)、〜-lights は GPU のテクスチャにするだけ (縮小版は GPU が作る)、
 * 〜-relief はいつも元の細かさで読む (terrainFn.js の mapHeight)。
 */
const isCategorical = (name) => name.endsWith('-cover') || name.endsWith('-lights') || name.endsWith('-relief');

/**
 * マップを読み込む (同じ名前は使い回す)。読み込めなければ例外になり、その名前は「読み込めなかった」として覚える。
 * サーバーが gzip を展開して返すこともあるので、先頭の 2 バイトで gzip かどうかを見分ける。
 */
export function loadMap(name) {
  if (maps.has(name)) return Promise.resolve(maps.get(name));
  if (loading.has(name)) return loading.get(name);
  const p = (async () => {
    const res = await fetch(mapUrl(name));
    if (!res.ok) throw new Error(`マップ ${name}: ${res.status}`);
    let buf = await res.arrayBuffer();
    const b = new Uint8Array(buf, 0, 2);
    if (b[0] === 0x1f && b[1] === 0x8b) {
      const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'));
      buf = await new Response(stream).arrayBuffer();
    }
    const map = parseMap(name, buf, { mips: !isCategorical(name) });
    maps.set(name, map);
    return map;
  })();
  loading.set(name, p);
  p.catch(() => failed.add(name)).finally(() => loading.delete(name));
  return p;
}

/** 名前の一覧をまとめて読み込む。1 つでも読めなければ例外。 */
export function loadMaps(names) {
  return Promise.all([...new Set(names)].map(loadMap));
}

/** 読み込み済みならそのマップ、まだなら null。 */
export function getMap(name) {
  return maps.get(name) || null;
}

/** テスト用: 作ったマップを名前で登録する。 */
export function registerMap(map) {
  maps.set(map.name, map);
  failed.delete(map.name);
}

/** テスト用: その名前を「読み込めなかった」ことにする。 */
export function markMapFailed(name) {
  maps.delete(name);
  failed.add(name);
}

/** テスト用: 登録したマップを消す。 */
export function unregisterMap(name) {
  maps.delete(name);
  failed.delete(name);
}

/** 地形の定義 (terrain) が使うマップの名前の一覧。 */
export function mapNamesOf(terrain) {
  return terrain && terrain.maps ? Object.values(terrain.maps).filter(Boolean) : [];
}

/**
 * 地形の定義から、読み込めなかったマップを使う部分を外したもの。
 * マップが1つでも読めなかった天体は、今のノイズの地形で作る (接地判定と見た目が食い違わないよう、
 * メインスレッドでこれを通した定義を Worker に渡す)。
 */
export function usableTerrain(terrain) {
  const names = mapNamesOf(terrain);
  if (!names.length || names.every((n) => !failed.has(n))) return terrain;
  const { maps: _m, heightScale: _h, ...rest } = terrain;
  return rest;
}

/** 地形の定義が使うマップを取り出す。読み込まれていなければ例外 (読み忘れにすぐ気づけるように)。 */
export function requireMap(name) {
  const m = maps.get(name);
  if (!m) throw new Error(`地形のマップ ${name} がまだ読み込まれていない (loadMaps を先に呼ぶ)`);
  return m;
}
