import { test, assert, near } from './harness.js';
import { Vector3, Quaternion } from 'three';
import { HABITAT, inPort, inInterior, capContact, interiorHeight, interiorAir } from '../src/universe/habitat.js';
import { HabitatView } from '../src/render/habitat.js';
import { generateSystem } from '../src/universe/system.js';
import { HOME_STAR } from '../src/universe/galaxy.js';
import { enterFrame, leaveFrame } from '../src/physics/frame.js';
import { Ship, makeControls } from '../src/flight/ship.js';
import { FIGHTER } from '../src/flight/shipParams.js';
import { GroundContact } from '../src/flight/ground.js';
import { RigidBody } from '../src/physics/body.js';

// オニール・シリンダーの中 (段階2)。回らない座標系で、重力は軸から外向きに g · r / R。

const insula = () => new HabitatView(generateSystem(HOME_STAR).habitats[0]);
const R = HABITAT.radius, H = HABITAT.length / 2;

test('シリンダーの中: 重力は軸から外向きに g · r / R、空気は地面で 1.2、軸で約 0.79 倍', () => {
  const h = insula();
  const g = new Vector3(), up = new Vector3();
  for (const [x, y, z] of [[0, 0, -R], [R * 0.5, 1000, 0], [-300, -12000, 400], [0.001, 0, 0]]) {
    const p = new Vector3(x, y, z);
    const r = Math.hypot(x, z);
    h.gravityAt(p, g);
    near(g.length(), (9.81 * r) / R, 1e-9, '重力の大きさ');
    h.upAt(p, up);
    if (r > 1) near(g.clone().normalize().dot(up), -1, 1e-12, '重力は真上の反対 (軸から外向き)');
    near(h.heightAbove(p), R - r, 1e-9, '地面からの高さ');
  }
  near(h.airDensityAt(new Vector3(R, 0, 0)), 1.2, 1e-12, '地面の空気');
  const axis = interiorAir({ radius: R }, 0) / 1.2;
  assert(axis > 0.75 && axis < 0.82, `軸の空気 ${axis.toFixed(3)} 倍`);
});

test('シリンダーの中: 入るのは入港口の筒からだけで、出るのも筒の外の端からだけ', () => {
  const def = { radius: R, length: HABITAT.length };
  const PR = HABITAT.portRadius, PL = HABITAT.portLength;
  assert(inPort(def, 0, -H - PL / 2, 100), '筒の中で入れない');
  assert(!inPort(def, 0, -H - PL - 10, 0), '筒の外で入った');
  assert(!inPort(def, PR + 50, -H - PL / 2, 0), '筒の壁の外で入った');
  assert(!inPort(def, R + 500, 0, 0), '外壁の外で入った');
  assert(inInterior(def, 0, -H - PL / 2, 0) && inInterior(def, 0, 0, R - 2) && inInterior(def, 0, H - 5, 0), '中なのに外');
  assert(!inInterior(def, 0, -H - PL - 100, 0), '筒の外の端を抜けても中のまま');
  // 筒の中では、筒の壁が地面になる
  near(interiorHeight(def, 0, -H - 100, PR - 30), 30, 1e-9, '筒の壁からの高さ');
  near(interiorHeight(def, 0, -H + 100, R - 30), 30, 1e-9, '中の地面からの高さ');
  // 入って出ると元に戻る (座標系は回らないので、位置と向きだけが変わる)
  const h = insula();
  const b = new RigidBody();
  const world = h.pos.clone().add(new Vector3(0, -H - PL / 2, 50).applyQuaternion(h.quat));
  b.pos.copy(world);
  b.vel.set(10, -20, 30);
  b.quat.setFromAxisAngle(new Vector3(1, 2, 3).normalize(), 0.7);
  const q0 = b.quat.clone(), v0 = b.vel.clone();
  assert(h.entersAt(world), '入港口で座標系に入らない');
  enterFrame(b, h);
  near(b.pos.y, -H - PL / 2, 1e-3, 'ローカル座標'); // 世界座標は 1e11 m 規模なので、丸め誤差が 1e-5 m ほど出る
  leaveFrame(b, h);
  near(b.pos.distanceTo(world), 0, 1e-3, '位置が戻らない');
  near(b.vel.distanceTo(v0), 0, 1e-9, '速度が変わった');
  near(Math.abs(b.quat.dot(q0)), 1, 1e-12, '向きが戻らない');
});

test('シリンダーの中: 両端の蓋は壁。影の側は入港口の穴の外側だけ', () => {
  const def = { radius: R, length: HABITAT.length };
  const m = 8;
  let c = capContact(def, 100, H - 3, 0, m);
  assert(c && c.normal[1] === -1, '恒星側の蓋で押し戻されない');
  near(c.depth, 5, 1e-9, '恒星側の深さ');
  assert(capContact(def, 0, H - 3, 0, m), '恒星側の蓋の真ん中も壁');
  c = capContact(def, 2000, -H + 2, 0, m);
  assert(c && c.normal[1] === 1, '影の側の蓋で押し戻されない');
  assert(!capContact(def, 0, -H + 2, 100, m), '入港口の穴で止められた');
  assert(!capContact(def, 0, 0, R - 10, m), '真ん中で止められた');
});

test('シリンダーの中: 地面 (円筒の内側) に、3本の脚で静かに着陸できる', () => {
  const h = insula();
  const ship = new Ship(FIGHTER);
  ship.flightAssist = false;
  ship.gearDown = true;
  ship.gear = 1;
  const b = ship.body;
  b.pos.set(0, 2000, -(R - 3)); // 地面の 3 m 上 (真上は +Z = 軸の方)
  const up = h.upAt(b.pos, new Vector3());
  b.quat.copy(new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), up));
  const gc = new GroundContact();
  const env = { speedScale: 1, gravity: new Vector3(), rho: 0, aero: 0, onGround: false };
  const c = makeControls();
  let damage = 0;
  for (let i = 0; i < 8 * 120; i++) {
    h.gravityAt(b.pos, env.gravity);
    ship.applyForces(1 / 120, c, env);
    gc.apply(b, h, ship.gear, true, 1 / 120);
    damage += gc.damage;
    b.integrate(1 / 120);
  }
  assert(damage === 0, `損傷した: ${damage}`);
  assert(gc.gearContacts === 3 && gc.hullContacts === 0, '脚で立っていない');
  near(h.heightAbove(b.pos), 2.2 - 0.25, 0.05, '止まった高さ');
  assert(b.vel.length() < 0.02, `止まっていない: ${b.vel.length()}`);
});
