import { formatDistance } from './hud.js';

const HOSTILE = '#ff6b5a';
const TARGET = '#ffd24a';
const FRIEND = '#7fe0ff';
const DIM = 'rgba(127, 224, 255, 0.45)';
const RADAR_RANGE = 6000; // レーダーの半径が表す距離 (m)

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

function brackets(ctx, x, y, r) {
  const k = r * 0.45;
  ctx.beginPath();
  for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
    ctx.moveTo(x + sx * r, y + sy * (r - k));
    ctx.lineTo(x + sx * r, y + sy * r);
    ctx.lineTo(x + sx * (r - k), y + sy * r);
  }
  ctx.stroke();
}

function bar(ctx, x, y, width, value, color) {
  ctx.strokeStyle = DIM;
  ctx.strokeRect(x, y - 4, width, 8);
  ctx.fillStyle = color;
  ctx.fillRect(x + 1, y - 3, Math.max(0, (width - 2) * clamp(value, 0, 1)), 6);
}

/**
 * 戦闘用の表示: 敵の枠、ロックオン、見越し点、レーダー、自機のシールドと武器。
 * s は Hud.draw に渡されたもの (s.combat が戦闘の情報)。
 */
export function drawCombat(ctx, w, h, s) {
  const c = s.combat;
  if (!c) return;
  const blink = Math.floor(s.time * 6) % 2 === 0;
  ctx.lineWidth = 1.5;
  ctx.font = '12px Consolas, "Courier New", monospace';
  ctx.textBaseline = 'middle';

  // シールドに被弾: 画面の縁が青く光る
  if (s.shieldFlash > 0.01) {
    const grad = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.35, w / 2, h / 2, Math.hypot(w, h) * 0.55);
    grad.addColorStop(0, 'rgba(80,170,255,0)');
    grad.addColorStop(1, `rgba(80,170,255,${(0.5 * s.shieldFlash).toFixed(3)})`);
    ctx.save();
    ctx.shadowBlur = 0;
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);
    ctx.restore();
  }

  // 敵の哨戒隊がいる場所
  ctx.textAlign = 'left';
  for (const z of c.zones) {
    ctx.strokeStyle = HOSTILE;
    ctx.beginPath();
    ctx.moveTo(z.x, z.y - 8);
    ctx.lineTo(z.x + 8, z.y + 6);
    ctx.lineTo(z.x - 8, z.y + 6);
    ctx.closePath();
    ctx.stroke();
    ctx.fillStyle = HOSTILE;
    ctx.fillText(z.label, z.x + 14, z.y - 6);
    ctx.fillStyle = 'rgba(255, 107, 90, 0.6)';
    ctx.fillText(formatDistance(z.dist), z.x + 14, z.y + 8);
  }

  // 敵機の枠
  for (const e of c.enemies) {
    if (!e.visible || e.isTarget) continue;
    ctx.strokeStyle = HOSTILE;
    brackets(ctx, e.x, e.y, clamp(7000 / e.dist, 7, 34) * (e.heavy ? 1.4 : 1));
  }

  // ロック中の的
  const t = c.target;
  if (t) {
    if (t.visible) {
      const r = clamp(7000 / t.dist, 12, 44);
      ctx.strokeStyle = c.locked ? HOSTILE : TARGET;
      brackets(ctx, t.x, t.y, r);
      // ロックオンの進み具合
      if (c.locked) {
        ctx.beginPath();
        ctx.moveTo(t.x, t.y - r - 7); ctx.lineTo(t.x + r + 7, t.y);
        ctx.lineTo(t.x, t.y + r + 7); ctx.lineTo(t.x - r - 7, t.y);
        ctx.closePath();
        ctx.stroke();
      } else if (c.lock > 0.02) {
        ctx.beginPath();
        ctx.arc(t.x, t.y, r + 8, -Math.PI / 2, -Math.PI / 2 + c.lock * Math.PI * 2);
        ctx.stroke();
      }
      ctx.textAlign = 'left';
      ctx.fillStyle = c.locked ? HOSTILE : TARGET;
      const tx = t.x + r + 12;
      ctx.fillText(`${t.name}${c.locked ? '  LOCK' : ''}`, tx, t.y - 16);
      ctx.fillStyle = TARGET;
      ctx.fillText(`${formatDistance(t.dist)}  ${t.closing >= 0 ? '+' : ''}${t.closing.toFixed(0)} m/s`, tx, t.y - 2);
      bar(ctx, tx, t.y + 12, 60, t.shield, '#66bbff');
      bar(ctx, tx, t.y + 24, 60, t.hull, '#ffb347');
    } else {
      // 画面の外にいる: 方向を矢印で示す
      const R = Math.min(w, h) * 0.36;
      const ax = w / 2 + t.dirX * R, ay = h / 2 - t.dirY * R;
      const a = Math.atan2(-t.dirY, t.dirX);
      ctx.fillStyle = c.locked ? HOSTILE : TARGET;
      ctx.beginPath();
      ctx.moveTo(ax + Math.cos(a) * 14, ay + Math.sin(a) * 14);
      ctx.lineTo(ax + Math.cos(a + 2.5) * 11, ay + Math.sin(a + 2.5) * 11);
      ctx.lineTo(ax + Math.cos(a - 2.5) * 11, ay + Math.sin(a - 2.5) * 11);
      ctx.closePath();
      ctx.fill();
      ctx.textAlign = 'center';
      ctx.fillText(formatDistance(t.dist), ax - Math.cos(a) * 26, ay - Math.sin(a) * 26);
    }

    // 見越し点: 機首 (十字) をここへ重ねて撃つ
    if (t.lead && t.lead.visible) {
      ctx.strokeStyle = t.inRange ? '#8dff9a' : DIM;
      ctx.beginPath();
      ctx.arc(t.lead.x, t.lead.y, 9, 0, Math.PI * 2);
      ctx.moveTo(t.lead.x + 2, t.lead.y);
      ctx.arc(t.lead.x, t.lead.y, 2, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  // 命中の印
  if (c.hitMarker && s.boresight.visible) {
    const { x, y } = s.boresight;
    ctx.strokeStyle = '#ffffff';
    ctx.beginPath();
    for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      ctx.moveTo(x + sx * 7, y + sy * 7);
      ctx.lineTo(x + sx * 13, y + sy * 13);
    }
    ctx.stroke();
  }

  // 左: 自機のシールド・武器
  const lx = Math.max(40, w * 0.5 - 330);
  const cy = h * 0.5;
  ctx.textAlign = 'right';
  ctx.fillStyle = c.shield < 0.25 ? HOSTILE : FRIEND;
  ctx.fillText('SHLD', lx + 26, cy + 72);
  bar(ctx, lx + 32, cy + 72, 78, c.shield, c.shield < 0.25 ? HOSTILE : '#66bbff');
  ctx.fillStyle = c.energy < 0.1 ? '#ffb347' : FRIEND;
  ctx.fillText('GUN', lx + 26, cy + 88);
  bar(ctx, lx + 32, cy + 88, 78, c.energy, c.energy < 0.1 ? '#ffb347' : '#8dff9a');
  ctx.fillStyle = c.missiles === 0 ? DIM : FRIEND;
  ctx.fillText(`MSL ${c.missiles}`, lx + 110, cy + 106);

  // 左下: レーダー (上が機首方向。縦線は上下のずれ)
  const R = 74;
  const rx = 24 + R, ry = h - 24 - R;
  ctx.strokeStyle = 'rgba(127, 224, 255, 0.35)';
  ctx.beginPath();
  ctx.arc(rx, ry, R, 0, Math.PI * 2);
  ctx.moveTo(rx + R * 0.5, ry);
  ctx.arc(rx, ry, R * 0.5, 0, Math.PI * 2);
  ctx.moveTo(rx - R, ry); ctx.lineTo(rx + R, ry);
  ctx.moveTo(rx, ry - R); ctx.lineTo(rx, ry + R);
  ctx.stroke();
  ctx.fillStyle = FRIEND;
  ctx.beginPath();
  ctx.moveTo(rx, ry - 5); ctx.lineTo(rx + 4, ry + 4); ctx.lineTo(rx - 4, ry + 4);
  ctx.closePath();
  ctx.fill();
  for (const p of c.radar) {
    let px = p.x / RADAR_RANGE, py = p.z / RADAR_RANGE;
    const len = Math.hypot(px, py);
    if (len > 1) { px /= len; py /= len; }
    const bx = rx + px * R, by = ry + py * R;
    const stem = clamp(p.y / RADAR_RANGE, -1, 1) * R * 0.6;
    const color = p.kind === 2 ? TARGET : p.kind === 3 ? FRIEND : p.kind === 4 ? '#ffb347' : HOSTILE;
    if (p.kind === 4 && !blink) continue;
    ctx.strokeStyle = color;
    ctx.globalAlpha = len > 1 ? 0.5 : 1;
    ctx.beginPath();
    ctx.moveTo(bx, by);
    ctx.lineTo(bx, by - stem);
    ctx.stroke();
    ctx.fillStyle = color;
    const size = p.kind >= 3 ? 2 : 3;
    ctx.fillRect(bx - size, by - stem - size, size * 2, size * 2);
    ctx.globalAlpha = 1;
  }
  ctx.textAlign = 'left';
  ctx.fillStyle = DIM;
  ctx.fillText(`${formatDistance(RADAR_RANGE)}`, rx + R * 0.72, ry + R * 0.86);
  ctx.fillStyle = c.count ? HOSTILE : DIM;
  ctx.fillText(`HOSTILES ${c.count}`, rx - R, ry - R - 12);
  ctx.fillStyle = FRIEND;
  ctx.fillText(`KILLS ${c.kills}`, rx + 10, ry - R - 12);

  // 警告
  ctx.textAlign = 'center';
  if (c.missileWarning && blink && !s.destroyed) {
    ctx.font = '20px Consolas, "Courier New", monospace';
    ctx.fillStyle = HOSTILE;
    ctx.fillText('MISSILE', w * 0.5, h * 0.3);
  }
  if (c.rearm > 0) {
    ctx.font = '14px "Segoe UI", "Yu Gothic UI", sans-serif';
    ctx.fillStyle = '#8dff9a';
    ctx.fillText(c.rearm < 1 ? '修理・補給の準備中…' : '修理・補給中…', w * 0.5, h * 0.36 + 54);
  }
  ctx.textAlign = 'left';
  ctx.font = '13px Consolas, "Courier New", monospace';
}
