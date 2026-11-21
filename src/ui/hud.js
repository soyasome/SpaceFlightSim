import { drawCombat } from './hudCombat.js';

const COLOR = '#7fe0ff';
const DIM = 'rgba(127, 224, 255, 0.45)';
const WARN = '#ffb347';

const C = 2.998e8; // 光速 (m/s) = 1光秒 (m)
const AU = 1.496e11;
const LY = 9.4607e15;
const group = (x) => Math.round(x).toLocaleString('en-US');

/** 速さ。m/s → km/s → 光速の何倍 (c) → 光年毎秒 と単位が上がる。 */
export function formatSpeed(v) {
  if (v < 1000) return `${v.toFixed(0)} m/s`;
  if (v < 1e5) return `${(v / 1000).toFixed(2)} km/s`;
  if (v < 0.01 * C) return `${group(v / 1000)} km/s`;
  if (v < 10 * C) return `${(v / C).toFixed(2)} c`;
  if (v < 0.01 * LY) return `${group(v / C)} c`;
  return `${(v / LY).toFixed(2)} ly/s`;
}

/** 距離。m → km → 光秒 (ls) → 天文単位 (AU) → 光年 (ly) と単位が上がる。 */
export function formatDistance(d) {
  if (d < 1000) return `${d.toFixed(0)} m`;
  if (d < 1e6) return `${(d / 1000).toFixed(2)} km`;
  if (d < 1e8) return `${group(d / 1000)} km`;
  if (d < 0.05 * AU) return `${(d / C).toFixed(2)} ls`;
  if (d < 10 * AU) return `${(d / AU).toFixed(3)} AU`;
  if (d < 0.05 * LY) return `${group(d / AU)} AU`;
  return `${(d / LY).toFixed(d < 10 * LY ? 3 : 1)} ly`;
}

/** 残り時間。 */
export function formatTime(t) {
  if (!Number.isFinite(t) || t > 359999) return '--:--';
  const s = Math.max(0, Math.round(t));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}` : `${m}:${String(s % 60).padStart(2, '0')}`;
}

/** 2Dキャンバスに描くHUD。3D側から渡された画面座標と数値を表示するだけ。 */
export class Hud {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.w = 0;
    this.h = 0;
  }

  resize(w, h, dpr) {
    this.w = w;
    this.h = h;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /**
   * s = { speed, throttle, thrust, boosting, assist, view, stick:{x,y}, originDist, fps,
   *       boresight:{x,y,visible}, prograde:{x,y,visible}, retrograde:{x,y,visible}, locked }
   * 画面座標は CSS ピクセル。
   */
  draw(s) {
    const { ctx, w, h } = this;
    ctx.clearRect(0, 0, w, h);
    ctx.shadowBlur = 0;
    ctx.lineWidth = 1.5;
    ctx.font = '13px Consolas, "Courier New", monospace';
    ctx.textBaseline = 'middle';

    // 空力加熱: 画面の縁が赤くなる
    if (s.heat > 0.15) {
      const k = Math.min(1, (s.heat - 0.15) / 0.85);
      const grad = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.3, w / 2, h / 2, Math.hypot(w, h) * 0.55);
      grad.addColorStop(0, 'rgba(255,90,20,0)');
      grad.addColorStop(1, `rgba(255,90,20,${(0.55 * k).toFixed(3)})`);
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, w, h);
    }
    if (s.flash > 0.01) {
      ctx.fillStyle = `rgba(255,220,180,${(s.flash * 0.5).toFixed(3)})`;
      ctx.fillRect(0, 0, w, h);
    }

    // 高速の巡航: 進行方向から星が流れる
    if (s.warp > 0.02) {
      const cx = s.prograde.visible ? s.prograde.x : w / 2;
      const cy0 = s.prograde.visible ? s.prograde.y : h / 2;
      const reach = Math.hypot(w, h);
      ctx.lineWidth = 1;
      for (let i = 0; i < 70; i++) {
        // 線ごとに決まった向きと速さを持たせ、時間で外へ流す
        const a = i * 2.399963;
        const speed = 0.25 + ((i * 0.6180339) % 1) * 0.9;
        const t = (s.time * speed * (0.4 + s.warp * 1.6) + i * 0.137) % 1;
        const r0 = 30 + t * t * reach * 0.7;
        const len = (8 + t * 160) * s.warp;
        ctx.strokeStyle = `rgba(190, 225, 255, ${(0.5 * s.warp * (1 - t) * Math.min(1, t * 6)).toFixed(3)})`;
        ctx.beginPath();
        ctx.moveTo(cx + Math.cos(a) * r0, cy0 + Math.sin(a) * r0);
        ctx.lineTo(cx + Math.cos(a) * (r0 + len), cy0 + Math.sin(a) * (r0 + len));
        ctx.stroke();
      }
      ctx.lineWidth = 1.5;
    }
    // ジャンプ: 充填中は画面が白んでいき、到着の瞬間に閃光が走る
    if (s.jump) {
      const k = s.jump.arrive > 0 ? s.jump.arrive : s.jump.charge * s.jump.charge * 0.55;
      ctx.fillStyle = `rgba(215, 235, 255, ${Math.min(1, k).toFixed(3)})`;
      ctx.fillRect(0, 0, w, h);
    }

    // 明るい地表の上でも読めるよう、線と文字に暗い縁をつける
    ctx.shadowColor = 'rgba(0, 10, 20, 0.75)';
    ctx.shadowBlur = 3;

    // 水平線とピッチ目盛り
    if (s.ladder) {
      ctx.font = '11px Consolas, "Courier New", monospace';
      for (const l of s.ladder) {
        ctx.strokeStyle = l.deg === 0 ? 'rgba(127, 224, 255, 0.7)' : 'rgba(127, 224, 255, 0.32)';
        ctx.setLineDash(l.deg < 0 ? [6, 5] : []);
        ctx.beginPath();
        ctx.moveTo(l.x1, l.y1);
        ctx.lineTo(l.x2, l.y2);
        ctx.stroke();
        if (l.deg !== 0) {
          ctx.fillStyle = DIM;
          ctx.textAlign = 'left';
          ctx.fillText(`${l.deg}`, l.x2 + 6, l.y2);
        }
      }
      ctx.setLineDash([]);
      ctx.font = '13px Consolas, "Courier New", monospace';
    }

    // 機首方向の照準
    if (s.boresight.visible) {
      const { x, y } = s.boresight;
      ctx.strokeStyle = COLOR;
      ctx.beginPath();
      ctx.moveTo(x - 16, y); ctx.lineTo(x - 5, y);
      ctx.moveTo(x + 5, y); ctx.lineTo(x + 16, y);
      ctx.moveTo(x, y - 16); ctx.lineTo(x, y - 5);
      ctx.moveTo(x, y + 5); ctx.lineTo(x, y + 16);
      ctx.stroke();

      // マウス仮想スティックの位置
      const R = 70;
      ctx.strokeStyle = 'rgba(127, 224, 255, 0.18)';
      ctx.beginPath();
      ctx.arc(x, y, R, 0, Math.PI * 2);
      ctx.stroke();
      if (Math.hypot(s.stick.x, s.stick.y) > 0.02) {
        ctx.fillStyle = COLOR;
        ctx.beginPath();
        ctx.arc(x + s.stick.x * R, y + s.stick.y * R, 3, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = DIM;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x + s.stick.x * R, y + s.stick.y * R);
        ctx.stroke();
      }
    }

    // 進行方向 (速度ベクトル) マーカー
    if (s.speed > 1) {
      if (s.prograde.visible) this._vectorMarker(s.prograde.x, s.prograde.y, false);
      if (s.retrograde.visible) this._vectorMarker(s.retrograde.x, s.retrograde.y, true);
    }

    // 左: 速度とスロットル
    const lx = Math.max(40, w * 0.5 - 330);
    const cy = h * 0.5;
    ctx.fillStyle = COLOR;
    ctx.textAlign = 'right';
    ctx.font = '22px Consolas, "Courier New", monospace';
    ctx.fillText(formatSpeed(s.speed), lx + 110, cy - 14);
    ctx.font = '12px Consolas, "Courier New", monospace';
    ctx.fillStyle = DIM;
    ctx.fillText(s.inAir ? 'AIRSPEED' : 'SPD', lx + 110, cy - 36);
    // 惑星の近く: 上昇率・G・迎角
    if (s.nearPlanet) {
      ctx.font = '13px Consolas, "Courier New", monospace';
      const vs = s.verticalSpeed;
      ctx.fillStyle = s.altitude < 300 && vs < -8 ? WARN : COLOR;
      ctx.fillText(`V/S ${vs >= 0 ? '+' : ''}${Math.abs(vs) < 1000 ? vs.toFixed(1) : (vs / 1000).toFixed(2) + 'k'}`, lx + 110, cy + 12);
      ctx.fillStyle = Math.abs(s.gLoad) > 7 ? WARN : COLOR;
      ctx.fillText(`G ${s.gLoad.toFixed(1)}`, lx + 110, cy + 30);
      if (s.inAir && s.speed > 5) {
        ctx.fillStyle = s.stall ? WARN : COLOR;
        ctx.fillText(`AoA ${(s.aoa * 180 / Math.PI).toFixed(0)}°`, lx + 110, cy + 48);
      }
      ctx.font = '12px Consolas, "Courier New", monospace';
    }

    // スロットルの棒 (-100%..100%)
    const bx = lx + 130, bh = 160, by = cy - bh / 2;
    ctx.strokeStyle = DIM;
    ctx.strokeRect(bx, by, 10, bh);
    const zero = by + bh * 0.5;
    ctx.beginPath();
    ctx.moveTo(bx - 4, zero); ctx.lineTo(bx + 14, zero);
    ctx.stroke();
    ctx.fillStyle = s.boosting ? WARN : COLOR;
    const th = -s.throttle * bh * 0.5;
    ctx.fillRect(bx + 2, Math.min(zero, zero + th), 6, Math.abs(th));
    ctx.fillStyle = DIM;
    ctx.textAlign = 'left';
    ctx.fillText(`THR ${(s.throttle * 100).toFixed(0)}%`, bx - 14, by + bh + 14);

    // 右: 状態
    const rx = Math.min(w - 40, w * 0.5 + 330);
    ctx.textAlign = 'left';
    ctx.font = '13px Consolas, "Courier New", monospace';
    ctx.fillStyle = s.assist ? COLOR : WARN;
    ctx.fillText(`FA  ${s.assist ? 'ON' : 'OFF'}`, rx - 110, cy - 26);
    ctx.fillStyle = COLOR;
    ctx.fillText(`VIEW ${s.view === 'cockpit' ? 'COCKPIT' : 'CHASE'}`, rx - 110, cy - 6);
    let ry = cy + 14;
    ctx.fillStyle = s.mode.startsWith('CRUISE') || s.mode === 'HOVER' ? '#8dff9a' : s.mode === 'MANUAL' ? WARN : COLOR;
    ctx.fillText(`MODE ${s.mode}`, rx - 110, ry);
    ry += 20;
    if (s.gear > 0) {
      const moving = s.gear < 1 || !s.gearDown;
      ctx.fillStyle = moving ? WARN : '#8dff9a';
      ctx.fillText(moving ? 'GEAR ...' : 'GEAR DOWN', rx - 110, ry);
      ry += 20;
    }
    ctx.fillStyle = s.hull < 35 ? '#ff6b6b' : s.hull < 70 ? WARN : COLOR;
    ctx.fillText(`HULL ${Math.max(0, s.hull).toFixed(0)}%`, rx - 110, ry);
    ry += 20;
    if (s.heat > 0.1) {
      ctx.fillStyle = s.heat > 1 ? '#ff6b6b' : s.heat > 0.6 ? WARN : COLOR;
      ctx.fillText(`HEAT ${(s.heat * 100).toFixed(0)}%`, rx - 110, ry);
      ry += 20;
    }
    if (s.boosting) {
      ctx.fillStyle = WARN;
      ctx.fillText('BOOST', rx - 110, ry);
      ry += 20;
    }
    if (s.grounded) {
      ctx.fillStyle = '#8dff9a';
      ctx.fillText(s.landed ? 'LANDED' : 'GROUND', rx - 110, ry);
    }

    // 上: 方位
    if (s.heading !== null && s.heading !== undefined) {
      const names = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
      ctx.textAlign = 'center';
      ctx.fillStyle = COLOR;
      ctx.fillText(`${String(Math.round(s.heading) % 360).padStart(3, '0')}° ${names[Math.round(s.heading / 45) % 8]}`, w * 0.5, 22);
      ctx.textAlign = 'left';
    }

    // 警告
    ctx.textAlign = 'center';
    ctx.font = '20px Consolas, "Courier New", monospace';
    if (s.destroyed) {
      ctx.fillStyle = '#ff6b6b';
      ctx.fillText('機体喪失 — 上空で復帰します', w * 0.5, h * 0.36);
    } else if (s.stall) {
      ctx.fillStyle = WARN;
      ctx.fillText('STALL', w * 0.5, h * 0.36);
    } else if (s.heat > 1) {
      ctx.fillStyle = '#ff6b6b';
      ctx.fillText('OVERHEAT', w * 0.5, h * 0.36);
    } else if (s.nearPlanet && !s.grounded && s.altitude < 150 && s.verticalSpeed < -8 && s.gear < 1) {
      ctx.fillStyle = WARN;
      ctx.fillText('GEAR', w * 0.5, h * 0.36);
    }
    if (s.notice && !s.destroyed) {
      ctx.font = '15px "Segoe UI", "Yu Gothic UI", sans-serif';
      ctx.fillStyle = WARN;
      ctx.fillText(s.notice, w * 0.5, h * 0.36 + 28);
    }
    ctx.textAlign = 'left';
    ctx.font = '13px Consolas, "Courier New", monospace';

    // 惑星の目印
    for (const m of s.markers) {
      ctx.strokeStyle = COLOR;
      ctx.beginPath();
      ctx.moveTo(m.x, m.y - 9); ctx.lineTo(m.x + 9, m.y);
      ctx.lineTo(m.x, m.y + 9); ctx.lineTo(m.x - 9, m.y);
      ctx.closePath();
      ctx.stroke();
      ctx.fillStyle = COLOR;
      ctx.fillText(m.name, m.x + 16, m.y - 8);
      ctx.fillStyle = DIM;
      ctx.fillText(formatDistance(m.dist), m.x + 16, m.y + 8);
    }

    // 下: 位置
    ctx.textAlign = 'center';
    ctx.fillStyle = DIM;
    if (s.frameName) {
      ctx.fillStyle = COLOR;
      ctx.font = '16px Consolas, "Courier New", monospace';
      ctx.fillText(`ALT ${formatDistance(Math.max(0, s.altitude))}`, w * 0.5, h - 46);
      ctx.font = '12px Consolas, "Courier New", monospace';
      ctx.fillStyle = DIM;
      const detail = s.frameDetail || `SEA LEVEL ${formatDistance(Math.max(0, s.altitudeSea))}`;
      ctx.fillText(`${s.frameName}   ${detail}`, w * 0.5, h - 26);
    } else {
      ctx.fillText(`${s.systemName} 星系   恒星まで ${formatDistance(s.starDist)}`, w * 0.5, h - 26);
    }

    // 行き先
    if (s.nav) {
      const n = s.nav;
      const color = n.star ? '#c9a6ff' : '#8dff9a';
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      if (n.visible) {
        ctx.beginPath();
        ctx.arc(n.x, n.y, 13, 0, Math.PI * 2);
        ctx.moveTo(n.x - 20, n.y); ctx.lineTo(n.x - 13, n.y);
        ctx.moveTo(n.x + 13, n.y); ctx.lineTo(n.x + 20, n.y);
        ctx.moveTo(n.x, n.y - 20); ctx.lineTo(n.x, n.y - 13);
        ctx.moveTo(n.x, n.y + 13); ctx.lineTo(n.x, n.y + 20);
        ctx.stroke();
        ctx.textAlign = 'left';
        ctx.fillText(n.name, n.x + 26, n.y - 8);
        ctx.fillText(formatDistance(n.dist), n.x + 26, n.y + 8);
      } else {
        // 画面の外: 方向を矢印で示す
        const R = Math.min(w, h) * 0.42;
        const ax = w / 2 + n.dirX * R, ay = h / 2 - n.dirY * R;
        const a = Math.atan2(-n.dirY, n.dirX);
        ctx.beginPath();
        ctx.moveTo(ax + Math.cos(a) * 14, ay + Math.sin(a) * 14);
        ctx.lineTo(ax + Math.cos(a + 2.5) * 11, ay + Math.sin(a + 2.5) * 11);
        ctx.lineTo(ax + Math.cos(a - 2.5) * 11, ay + Math.sin(a - 2.5) * 11);
        ctx.closePath();
        ctx.stroke();
      }
      ctx.textAlign = 'center';
      ctx.fillText(`NAV ${n.name}   ${formatDistance(n.dist)}   ETA ${formatTime(n.eta)}`, w * 0.5, 44);
      if (n.star && s.inSpace && !s.jump) {
        ctx.fillStyle = DIM;
        ctx.fillText('K でジャンプ', w * 0.5, 62);
      }
    }
    if (s.jump && s.jump.arrive <= 0) {
      ctx.textAlign = 'center';
      ctx.font = '18px Consolas, "Courier New", monospace';
      ctx.fillStyle = '#c9a6ff';
      ctx.fillText(`JUMP → ${s.jump.name}   ${Math.round(s.jump.charge * 100)}%`, w * 0.5, h * 0.28);
      ctx.font = '12px Consolas, "Courier New", monospace';
    }
    ctx.textAlign = 'center';
    ctx.fillStyle = DIM;

    drawCombat(ctx, w, h, s);
    ctx.fillStyle = DIM;

    // 左上: fps
    ctx.textAlign = 'left';
    ctx.fillText(`${s.fps.toFixed(0)} fps   chunks ${s.chunks}${s.queued ? '  loading ' + s.queued : ''}`, 12, 16);

    if (!s.locked) {
      ctx.textAlign = 'center';
      ctx.fillStyle = WARN;
      ctx.fillText('画面をクリックするとマウス操縦を開始', w * 0.5, h - 72);
    }
  }

  _vectorMarker(x, y, retro) {
    const ctx = this.ctx;
    ctx.strokeStyle = retro ? WARN : '#8dff9a';
    ctx.beginPath();
    ctx.arc(x, y, 7, 0, Math.PI * 2);
    if (retro) {
      ctx.moveTo(x - 5, y - 5); ctx.lineTo(x + 5, y + 5);
      ctx.moveTo(x + 5, y - 5); ctx.lineTo(x - 5, y + 5);
    } else {
      ctx.moveTo(x - 7, y); ctx.lineTo(x - 14, y);
      ctx.moveTo(x + 7, y); ctx.lineTo(x + 14, y);
      ctx.moveTo(x, y - 7); ctx.lineTo(x, y - 13);
    }
    ctx.stroke();
  }
}
