import { starsNear, LY } from '../universe/galaxy.js';
import { TYPE_LABEL } from '../universe/system.js';
import { formatDistance } from './hud.js';

const RANGE = 25; // 星図に載せる範囲 (光年)

/**
 * 星図。今いる星系の天体と、近くの恒星を一覧し、行き先を選ぶ。
 * 開いている間はゲームを一時停止する。開く / 閉じる: M キー。
 */
export class StarMap {
  constructor(game) {
    this.game = game;
    this.root = document.getElementById('starmap');
    this.bodies = document.getElementById('mapBodies');
    this.stars = document.getElementById('mapStars');
    this.sub = document.getElementById('mapSub');
    this.title = document.getElementById('mapSystemTitle');
    this.canvas = document.getElementById('mapCanvas');
    this.isOpen = false;

    document.getElementById('mapClose').addEventListener('click', () => this.close());
    game.input.on('map', () => this.toggle());
    // Esc でも閉じる (メニューより先に処理する)
    window.addEventListener('keydown', (e) => {
      if (this.isOpen && e.code === 'Escape') {
        e.stopImmediatePropagation();
        this.close();
      }
    }, true);
  }

  toggle() {
    if (this.isOpen) this.close();
    else if (!this.game.paused) this.open(); // メニューを開いている間は開かない
  }

  open() {
    const game = this.game;
    this.isOpen = true;
    game.mapOpen = true;
    game.paused = true;
    game.input.enabled = false;
    game.input.keys.clear();
    game.input.firing = false;
    this.root.classList.remove('hidden');
    if (document.pointerLockElement) document.exitPointerLock();
    this.refresh();
  }

  close() {
    const game = this.game;
    this.isOpen = false;
    this.root.classList.add('hidden');
    game.paused = false;
    game.input.enabled = true;
    game.input.lock();
    // メニューが「マウスが解放された」と勘違いして開かないよう、少し遅らせて戻す
    setTimeout(() => { game.mapOpen = false; }, 200);
  }

  _row(parent, name, type, dist, selected, onPick, cls = '') {
    const row = document.createElement('div');
    row.className = `maprow ${cls}`;
    const nm = document.createElement('span');
    nm.className = 'nm';
    nm.textContent = name;
    const ty = document.createElement('span');
    ty.className = 'ty';
    ty.textContent = type;
    nm.appendChild(ty);
    const ds = document.createElement('span');
    ds.className = 'ds';
    ds.textContent = dist;
    row.appendChild(nm);
    row.appendChild(ds);
    if (onPick) {
      const btn = document.createElement('button');
      btn.textContent = selected ? '解除' : '行き先にする';
      if (selected) btn.className = 'on';
      btn.addEventListener('click', onPick);
      row.appendChild(btn);
    } else {
      row.appendChild(document.createElement('span'));
    }
    parent.appendChild(row);
  }

  /** 一覧を作り直す。 */
  refresh() {
    const game = this.game;
    const nav = game.nav;
    const pick = (target) => () => {
      game.setNav(target);
      this.close();
    };

    this.sub.textContent = `現在地: ${game.star.name} 星系 ／ 行き先: ${nav ? game.navName() : 'なし'}`;
    this.title.textContent = `${game.star.name} 星系（${game.star.label}）`;

    // --- 今の星系 ---
    this.bodies.textContent = '';
    const here = game.shipSysPos(game._v).clone();
    this._row(this.bodies, game.star.name, '恒星', formatDistance(here.length()), false, null);
    // 恒星に近い惑星から順に並べ、衛星はその親のすぐ下に置く
    const isMoon = (p) => p.def.parent !== null && p.def.parent !== undefined;
    const ordered = [];
    for (const p of game.planets.filter((q) => !isMoon(q)).sort((a, b) => a.sysPos.length() - b.sysPos.length())) {
      ordered.push(p, ...game.planets.filter((q) => isMoon(q) && game.planets[q.def.parent] === p));
    }
    for (const p of ordered) {
      const selected = !!nav && nav.type === 'planet' && nav.planet === p;
      const dist = Math.max(0, p.sysPos.distanceTo(here) - p.radius);
      const air = p.gas ? '' : p.atmosphere ? ' ・大気あり' : ' ・大気なし';
      this._row(this.bodies, p.name, `${TYPE_LABEL[p.type] || p.type}${air}`, formatDistance(dist), selected,
        pick(selected ? null : { type: 'planet', planet: p }), isMoon(p) ? 'indent' : '');
    }
    for (const h of game.habitats) {
      const selected = !!nav && nav.type === 'habitat' && nav.habitat === h;
      const dist = Math.max(0, h.sysPos.distanceTo(here) - h.radius);
      this._row(this.bodies, h.name, 'オニール・シリンダー', formatDistance(dist), selected,
        pick(selected ? null : { type: 'habitat', habitat: h }));
    }
    const sw = game.system.swarm;
    if (sw) {
      const selected = !!nav && nav.type === 'swarm';
      const dist = Math.max(0, Math.abs(here.length() - sw.radius) - sw.panel);
      this._row(this.bodies, 'ダイソン・スウォーム', `集光パネル ${sw.count.toLocaleString()} 枚・被覆 ${Math.round(sw.coverage * 100)}%`,
        formatDistance(dist), selected, pick(selected ? null : game.swarmNav()));
    }
    if (game.system.belt) {
      const selected = !!nav && nav.type === 'belt';
      const b = game.system.belt.position;
      const dist = Math.hypot(b[0] - here.x, b[1] - here.y, b[2] - here.z);
      this._row(this.bodies, '小惑星帯', '', formatDistance(dist), selected, pick(selected ? null : { type: 'belt' }));
    }

    // --- 近くの恒星 ---
    this.stars.textContent = '';
    const list = starsNear(game.galPos, RANGE);
    for (const { star, dist } of list.slice(0, 40)) {
      const current = star === game.star;
      const selected = !!nav && nav.type === 'star' && nav.star === star;
      const sys = game.generateSystem(star);
      const info = `${star.label}・惑星 ${sys.planets.filter((p) => p.parent === null || p.parent === undefined).length}`
        + (sys.swarm ? '・スウォーム' : '') + (sys.planets.some((p) => p.type === 'city') ? '・都市' : '');
      this._row(this.stars, star.name, current ? `${info}・現在地` : info, formatDistance(dist * LY), selected,
        current ? null : pick(selected ? null : { type: 'star', star }), current ? 'current' : '');
    }
    this._draw(list);
  }

  /** 近くの恒星を上から見た図 (横 = X, 縦 = Z)。高さの違いは縦線で示す。 */
  _draw(list) {
    const game = this.game;
    const c = this.canvas;
    const ctx = c.getContext('2d');
    const w = c.width, h = c.height;
    ctx.clearRect(0, 0, w, h);
    const scale = Math.min(w, h) / 2 / RANGE;
    const cx = w / 2, cy = h / 2;
    ctx.strokeStyle = 'rgba(127, 224, 255, 0.2)';
    for (const r of [10, 20]) {
      ctx.beginPath();
      ctx.arc(cx, cy, r * scale, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.font = '10px Consolas, monospace';
    ctx.fillStyle = 'rgba(127, 224, 255, 0.45)';
    ctx.fillText('10 ly', cx + 10 * scale + 3, cy - 2);
    ctx.fillText('20 ly', cx + 20 * scale + 3, cy - 2);
    const g = game.galPos;
    list.forEach(({ star }, i) => {
      const x = cx + (star.pos[0] - g[0]) * scale;
      const y = cy + (star.pos[2] - g[2]) * scale;
      const stem = (star.pos[1] - g[1]) * scale * 0.5;
      const col = `rgb(${star.color.map((v) => Math.round(v * 255)).join(',')})`;
      ctx.strokeStyle = 'rgba(127, 224, 255, 0.3)';
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x, y - stem);
      ctx.stroke();
      ctx.fillStyle = col;
      ctx.beginPath();
      ctx.arc(x, y - stem, star === game.star ? 4 : 2.5, 0, Math.PI * 2);
      ctx.fill();
      const selected = game.nav && game.nav.type === 'star' && game.nav.star === star;
      if (selected) {
        ctx.strokeStyle = '#c9a6ff';
        ctx.beginPath();
        ctx.arc(x, y - stem, 7, 0, Math.PI * 2);
        ctx.stroke();
      }
      if (i < 10 || selected) {
        ctx.fillStyle = 'rgba(207, 232, 255, 0.8)';
        ctx.fillText(star.name, x + 6, y - stem + 3);
      }
    });
    // 自機
    ctx.strokeStyle = '#8dff9a';
    ctx.beginPath();
    ctx.moveTo(cx - 5, cy); ctx.lineTo(cx + 5, cy);
    ctx.moveTo(cx, cy - 5); ctx.lineTo(cx, cy + 5);
    ctx.stroke();
  }
}
