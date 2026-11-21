import { test, assert, near } from './harness.js';
import { Vector3 } from 'three';
import { HABITAT, MIRROR, mirrorFrame, trussParts, exteriorContact } from '../src/universe/habitat.js';
import { makeInteriorTerrain, SPACEPORT } from '../src/universe/habitatTerrain.js';
import { HabitatView } from '../src/render/habitat.js';
import { buildPropCell } from '../src/render/habitatInterior.js';
import { generateSystem } from '../src/universe/system.js';
import { HOME_STAR } from '../src/universe/galaxy.js';

// オニール・シリンダーの仕上げ (段階4): 宇宙港、鏡・骨組み・入港口の筒の当たり判定、2本目。

const pair = () => generateSystem(HOME_STAR).habitats;
const H = HABITAT.length / 2;

test('宇宙港: パッドは平らで、木も家もない。2本とも同じ場所にある', () => {
  for (const def of pair()) {
    const T = makeInteriorTerrain(def);
    const [, cy, cz] = T.spaceport;
    near(cz, def.radius - SPACEPORT.height, 1e-9, 'パッドの高さ');
    // パッドの上はどこも同じ標高
    for (let i = 0; i < 60; i++) {
      const ang = i * 2.4, d = (SPACEPORT.radius - 10) * Math.sqrt((i + 0.5) / 60);
      const s = Math.cos(ang) * d, y = cy + Math.sin(ang) * d;
      const smp = T.sample(s / def.radius, y);
      near(smp.h, SPACEPORT.height, 1e-6, `パッドの標高 (${s.toFixed(0)}, ${y.toFixed(0)})`);
      assert(smp.pad > 0.99, 'パッドの印がない');
    }
    // パッドとそのまわりの区画に、木も家もない
    const R = def.radius, N = Math.round((2 * Math.PI * R) / 200);
    for (let di = -3; di <= 3; di++) {
      for (let dj = -3; dj <= 3; dj++) {
        const i = ((di % N) + N) % N, j = Math.floor(cy / 200) + dj;
        const cell = buildPropCell(def, T, i, j);
        for (const p of [...cell.trees, ...cell.houses]) {
          const s = (p.th > Math.PI ? p.th - 2 * Math.PI : p.th) * R;
          assert(Math.hypot(s, p.y - cy) > SPACEPORT.radius, `パッドの上に木か家がある (${s.toFixed(0)}, ${p.y.toFixed(0)})`);
        }
      }
    }
  }
});

test('外の当たり判定: 鏡は開いた角度の位置で、表からも裏からも押し返す', () => {
  const def = pair()[0];
  const open = MIRROR.angle;
  for (const spin of [0, 1.234]) {
    for (let k = 0; k < 3; k++) {
      const m = mirrorFrame(def, k, spin, open);
      // 鏡の真ん中あたりの、面のすぐ表と裏
      const at = (along, across, dist) => m.hinge.map((v, i) => v + m.along[i] * along + m.across[i] * across + m.normal[i] * dist);
      for (const side of [1, -1]) {
        const p = at(def.length * 0.6, 100, side * 5);
        const c = exteriorContact(def, spin, open, ...p);
        assert(c && c.what === '鏡', `鏡 ${k} に当たらない (向き ${side})`);
        near(c.normal[0] * m.normal[0] + c.normal[1] * m.normal[1] + c.normal[2] * m.normal[2], side, 1e-9, '押し返す向き');
      }
      // 鏡の外 (幅の外、長さの先) には当たらない
      assert(!exteriorContact(def, spin, open, ...at(def.length * 0.5, m.width, 0)), '鏡の幅の外で当たった');
      assert(!exteriorContact(def, spin, open, ...at(def.length + 500, 0, 0)), '鏡の先で当たった');
    }
  }
  // 鏡は回転と一緒に動く: 回転 0 で鏡があった所は、別の角度では空いている
  const m0 = mirrorFrame(def, 0, 0, open);
  const p0 = m0.hinge.map((v, i) => v + m0.along[i] * def.length * 0.5);
  assert(exteriorContact(def, 0, open, ...p0), '回転 0 で当たらない');
  assert(!exteriorContact(def, Math.PI / 3, open, ...p0), '回転したのに同じ所で当たった');
});

test('外の当たり判定: 骨組みと入港口の筒に当たり、筒の中の通り道は空いている', () => {
  const [a, b] = pair();
  const parts = trussParts(a);
  assert(parts.length > 0 && trussParts(b).length === 0, '骨組みは組の1本目だけが持つ');
  for (const p of parts) {
    const c = exteriorContact(a, 0, MIRROR.angle, ...p.center);
    assert(c && c.what === '骨組み', `骨組みの真ん中で当たらない (${p.center.map((v) => v.toFixed(0))})`);
  }
  const PR = HABITAT.portRadius, PL = HABITAT.portLength;
  // 筒の殻
  let c = exteriorContact(a, 0, MIRROR.angle, PR + 50, -H - PL / 2, 0);
  assert(c && c.what === '入港口', '筒の殻に当たらない');
  // 筒の口の正面 (殻の縁)
  c = exteriorContact(a, 0, MIRROR.angle, 0, -H - PL - 3, PR + 50);
  assert(c && c.normal[1] === -1, '筒の口の縁で前へ押し返さない');
  // 筒の中の軸の上と、口の前は空いている
  for (const y of [-H - PL - 500, -H - PL + 10, -H - PL / 2]) {
    assert(!exteriorContact(a, 0, MIRROR.angle, 0, y, 50), `筒の通り道で当たった (y = ${y})`);
  }
  // 外壁
  c = exteriorContact(a, 0, MIRROR.angle, a.radius + a.hull + 2, 0, 0);
  assert(c && c.what === '外壁' && c.normal[0] > 0.99, '外壁に当たらない');
});

test('2本目: INSULA II にも入港口から入れ、宇宙港がある', () => {
  const [, defB] = pair();
  const h = new HabitatView(defB);
  const world = h.pos.clone().add(new Vector3(0, -H - HABITAT.portLength / 2, 30).applyQuaternion(h.quat));
  assert(h.entersAt(world), 'INSULA II の入港口で座標系に入らない');
  const sp = h.spaceport;
  near(h.heightAbove(sp.clone().setZ(sp.z - 20)), 20, 1e-6, '宇宙港の上の高さ');
});
