// ブラウザ上で動く最小のテストランナー。tests.html から読み込む。
const results = [];

export function test(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
  } catch (e) {
    results.push({ name, ok: false, message: e.message });
  }
}

export function assert(cond, message = 'assertion failed') {
  if (!cond) throw new Error(message);
}

export function near(actual, expected, tol, label = '') {
  if (!(Math.abs(actual - expected) <= tol)) {
    throw new Error(`${label} expected ${expected} ±${tol}, got ${actual}`);
  }
}

export function report() {
  const failed = results.filter((r) => !r.ok);
  const el = document.getElementById('out');
  el.innerHTML = '';
  const head = document.createElement('h2');
  head.textContent = `${results.length - failed.length} / ${results.length} passed`;
  head.style.color = failed.length ? '#ff6b6b' : '#7dff9a';
  el.appendChild(head);
  for (const r of results) {
    const li = document.createElement('div');
    li.textContent = `${r.ok ? '✔' : '✘'} ${r.name}${r.ok ? '' : ' — ' + r.message}`;
    li.style.color = r.ok ? '#cfe8ff' : '#ff6b6b';
    el.appendChild(li);
  }
  window.testResults = { total: results.length, failed };
}
