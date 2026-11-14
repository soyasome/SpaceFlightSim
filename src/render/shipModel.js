import * as THREE from 'three';

// 機体はすべてコードで作る。機体座標: 前 = -Z, 上 = +Y, 右 = +X。全長 約13m。

function hullMaterial(color = 0x7c8ea6) {
  return new THREE.MeshStandardMaterial({ color, metalness: 0.65, roughness: 0.42 });
}

/** XZ平面の板 (翼)。points は [x, z] の配列 (z は後ろが +)。 */
function plate(points, thickness) {
  const shape = new THREE.Shape(points.map(([x, z]) => new THREE.Vector2(x, z)));
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: thickness, bevelEnabled: true, bevelThickness: 0.03, bevelSize: 0.03, bevelSegments: 1,
  });
  geo.translate(0, 0, -thickness / 2);
  geo.rotateX(Math.PI / 2); // shape の y → +Z (後方)
  return geo;
}

/** 中心が明るく外へ向かって消える円 (光の表現用)。 */
export function softGlowTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.3, 'rgba(255,255,255,0.45)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}

/** colors = { hull, accent } で色を変えられる (敵機用)。 */
export function createShipModel(colors = {}) {
  const group = new THREE.Group();
  const hull = hullMaterial(colors.hull);
  const dark = new THREE.MeshStandardMaterial({ color: 0x2a313c, metalness: 0.7, roughness: 0.5 });
  const accent = new THREE.MeshStandardMaterial({ color: colors.accent ?? 0xd9682a, metalness: 0.4, roughness: 0.5 });
  const sideMat = (m) => { m.side = THREE.DoubleSide; return m; };

  // 胴体: 回転体を上下に少しつぶす
  const profile = [
    [0.0, 6.6], [0.22, 5.9], [0.55, 4.2], [0.85, 2.0], [1.0, -0.5],
    [1.0, -3.6], [0.85, -5.2], [0.7, -5.8], [0.0, -5.8],
  ].map(([r, y]) => new THREE.Vector2(r, y));
  const fuselageGeo = new THREE.LatheGeometry(profile, 20);
  fuselageGeo.rotateX(-Math.PI / 2); // +Y (機首) → -Z
  fuselageGeo.scale(1.05, 0.68, 1);
  group.add(new THREE.Mesh(fuselageGeo, hull));

  // 主翼 (デルタ翼)
  const wingPts = [[0.7, -0.8], [5.6, 3.3], [5.6, 4.3], [0.7, 4.7]];
  const wingGeo = plate(wingPts, 0.16);
  const wingR = new THREE.Mesh(wingGeo, sideMat(hull.clone()));
  wingR.position.y = -0.12;
  const wingL = wingR.clone();
  wingL.scale.x = -1;
  group.add(wingR, wingL);

  // 翼端の帯
  const tipGeo = plate([[5.0, 2.8], [5.6, 3.3], [5.6, 4.3], [5.0, 4.34]], 0.18);
  const tipR = new THREE.Mesh(tipGeo, sideMat(accent.clone()));
  tipR.position.y = -0.12;
  const tipL = tipR.clone();
  tipL.scale.x = -1;
  group.add(tipR, tipL);

  // 垂直尾翼 (外側に傾けた2枚)
  const finGeo = plate([[0, 0], [1.9, 1.5], [1.9, 2.5], [0, 2.9]], 0.12);
  for (const side of [1, -1]) {
    const fin = new THREE.Mesh(finGeo, sideMat(hull.clone()));
    fin.rotation.z = Math.PI / 2 - side * 0.42; // 板を立てて外へ倒す
    fin.position.set(side * 0.95, 0.35, 2.4);
    group.add(fin);
  }

  // キャノピー
  const canopyGeo = new THREE.SphereGeometry(1, 20, 14);
  canopyGeo.scale(0.56, 0.46, 1.75);
  const canopy = new THREE.Mesh(
    canopyGeo,
    new THREE.MeshStandardMaterial({ color: 0x0b1a2c, metalness: 0.9, roughness: 0.12 }),
  );
  canopy.position.set(0, 0.5, -2.1);
  group.add(canopy);

  // エンジンと噴射炎
  const nozzleGeo = new THREE.CylinderGeometry(0.5, 0.62, 1.3, 16, 1, true);
  nozzleGeo.rotateX(Math.PI / 2);
  const flameGeo = new THREE.ConeGeometry(0.42, 1, 16, 1, true);
  flameGeo.translate(0, -0.5, 0); // 根元を原点に
  flameGeo.rotateX(-Math.PI / 2); // 先端を +Z (後方) へ
  const flames = [];
  for (const side of [1, -1]) {
    const nozzle = new THREE.Mesh(nozzleGeo, sideMat(dark.clone()));
    nozzle.position.set(side * 0.62, 0, 6.0);
    group.add(nozzle);

    const glow = new THREE.Mesh(
      new THREE.CircleGeometry(0.46, 16),
      new THREE.MeshBasicMaterial({ color: 0x66bbff }),
    );
    glow.position.set(side * 0.62, 0, 6.1);
    group.add(glow);

    const flame = new THREE.Mesh(
      flameGeo,
      new THREE.MeshBasicMaterial({
        color: 0x7fc8ff, transparent: true, opacity: 0.75,
        blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
      }),
    );
    flame.position.set(side * 0.62, 0, 6.5);
    group.add(flame);
    flames.push({ flame, glow });
  }

  // 着陸装置: 前脚1本と主脚2本。付け根を軸に後ろへ畳む
  const strutGeo = new THREE.CylinderGeometry(0.07, 0.07, 1.5, 8);
  strutGeo.translate(0, -0.75, 0);
  const wheelGeo = new THREE.CylinderGeometry(0.3, 0.3, 0.22, 14);
  wheelGeo.rotateZ(Math.PI / 2);
  const legs = [];
  for (const [x, z] of [[0, -3.2], [2.2, 1.8], [-2.2, 1.8]]) {
    const leg = new THREE.Group();
    leg.position.set(x, -0.4, z);
    leg.add(new THREE.Mesh(strutGeo, dark));
    const wheel = new THREE.Mesh(wheelGeo, dark);
    wheel.position.y = -1.5;
    leg.add(wheel);
    leg.visible = false;
    group.add(leg);
    legs.push(leg);
  }
  /** t: 着陸装置の出具合 0..1 */
  group.userData.setGear = (t) => {
    for (const leg of legs) {
      leg.visible = t > 0.02;
      leg.rotation.x = -(1 - t) * 1.45;
    }
  };

  // 空力加熱の光 (機首を包む)
  const heatGlow = new THREE.Sprite(new THREE.SpriteMaterial({
    map: softGlowTexture(), color: 0xff7a30, blending: THREE.AdditiveBlending,
    depthWrite: false, transparent: true, opacity: 0,
  }));
  heatGlow.position.set(0, 0, -3.5);
  group.add(heatGlow);
  /** heat: 空力加熱 (1 で限界) */
  group.userData.setHeat = (heat, time) => {
    const k = Math.min(1, Math.max(0, (heat - 0.15) / 0.85));
    heatGlow.visible = k > 0.01;
    heatGlow.material.opacity = k * (0.75 + 0.25 * Math.sin(time * 40));
    heatGlow.scale.setScalar(10 + k * 16);
    hull.emissive.setRGB(0.9 * k * k, 0.25 * k * k, 0.05 * k * k);
  };

  /** level: 噴射量 0..1, boosting: ブースト中か。 */
  group.userData.setThrust = (level, boosting, time) => {
    const flicker = 0.92 + 0.08 * Math.sin(time * 70);
    for (const { flame, glow } of flames) {
      const len = (0.3 + level * 9) * flicker;
      flame.scale.set(1, 1, len);
      flame.visible = level > 0.01;
      flame.material.color.setHex(boosting ? 0xffc890 : 0x7fc8ff);
      const g = 0.15 + level * 1.6;
      glow.material.color.setRGB(0.4 * g, 0.75 * g, 1.0 * g);
    }
  };

  return group;
}

/**
 * コックピットの内装。カメラの子として置く (カメラ座標: 視線 = -Z)。
 */
export function createCockpit() {
  const group = new THREE.Group();
  const frame = new THREE.MeshStandardMaterial({ color: 0x1c2129, metalness: 0.6, roughness: 0.6 });
  const panel = new THREE.MeshStandardMaterial({ color: 0x10141a, metalness: 0.3, roughness: 0.8 });

  // 計器盤
  const dash = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.42, 0.5), panel);
  dash.position.set(0, -0.5, -1.0);
  dash.rotation.x = -0.28;
  group.add(dash);
  const hood = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.035, 0.62), panel);
  hood.position.set(0, -0.285, -1.0);
  hood.rotation.x = -0.05;
  group.add(hood);

  // 計器盤の画面 (発光)
  const screenColors = [0x0f4a68, 0x0f6848, 0x0f4a68];
  [-0.5, 0, 0.5].forEach((x, i) => {
    const s = new THREE.Mesh(
      new THREE.PlaneGeometry(0.3, 0.13),
      new THREE.MeshBasicMaterial({ color: screenColors[i] }),
    );
    s.position.set(x, -0.43, -0.752);
    s.rotation.x = -0.28;
    group.add(s);
  });

  // キャノピーの枠
  const bowGeo = new THREE.TorusGeometry(0.82, 0.018, 6, 28, Math.PI);
  const front = new THREE.Mesh(bowGeo, frame);
  front.position.set(0, -0.33, -1.3);
  group.add(front);
  const rear = new THREE.Mesh(bowGeo, frame);
  rear.position.set(0, -0.33, 0.1);
  rear.scale.setScalar(1.08);
  group.add(rear);
  const railGeo = new THREE.BoxGeometry(0.07, 0.07, 1.7);
  for (const side of [1, -1]) {
    const rail = new THREE.Mesh(railGeo, frame);
    rail.position.set(side * 0.83, -0.33, -0.6);
    group.add(rail);
    const console_ = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.3, 1.2), panel);
    console_.position.set(side * 0.72, -0.55, -0.3);
    group.add(console_);
  }

  // 前方に見える機首
  const noseGeo = new THREE.ConeGeometry(0.62, 4.2, 20);
  noseGeo.rotateX(-Math.PI / 2);
  noseGeo.scale(1.05, 0.5, 1);
  const nose = new THREE.Mesh(noseGeo, hullMaterial());
  nose.position.set(0, -0.68, -3.1);
  group.add(nose);

  // 室内灯 (太陽が後ろにあっても計器盤が見えるように)
  const lamp = new THREE.PointLight(0x9fc4ff, 1.2, 5, 2);
  lamp.position.set(0, 0.25, -0.3);
  group.add(lamp);

  return group;
}
