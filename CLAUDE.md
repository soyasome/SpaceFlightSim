# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

STARWAKE — ブラウザで動く宇宙フライトシミュレーター。素の ES モジュール + Three.js (CDN の importmap で `three@0.170.0`)。
ビルド・パッケージマネージャ・リンターはない。README.md・コメント・コミットメッセージ・UI の文言はすべて日本語で、
同じ調子 (平易な言葉、「〜する」) で書く。

## コマンド

```
npx --yes http-server@14.1.1 . -p 5173 -a 127.0.0.1 -c-1 -s   # http://localhost:5173/
python serve.py                                                # Python がある環境ではこちらでもよい
```

- この開発機には Python がない (`python` は Microsoft Store の仮のファイルで、実行すると終了コード 9009)。
  アプリのプレビュー (`.claude/launch.json`) も npx の http-server で起動する (`spaceflightsim`)。
  npx がなく Python がある開発機では `spaceflightsim-python` (`python serve.py`) を使う。
- `serve.py` は .js を必ず `text/javascript` で返し、キャッシュを無効にする。Windows では `python -m http.server` だと
  モジュールの MIME 型で失敗することがあるので、Python で立てるときはこちらを使う。Three.js を CDN から読むのでネット接続が必要。
- 単体テスト: http://localhost:5173/tests.html を開く。ブラウザの中で動く自作ランナー (`tests/harness.js` の
  `test` / `assert` / `near`)。結果はページと `window.testResults` (`{ total, failed }`) に出る。
  - 1つのファイルだけ動かす仕組みはない。絞りたいときは `tests.html` の `await import(...)` を一時的に減らす。
  - 新しいテストファイルは `tests/mN.test.js` として作り、`tests.html` に `await import` を1行足す
    (足さないと実行されない)。ファイルは機能を足した段階ごと (M1〜M16。m16 は `assets/maps` の本物のマップを読む) に分かれている。
- 技術解説ページ: http://localhost:5173/docs/ (`docs/index.html`。図と動かせるデモつき)。
- 動作確認はブラウザのコンソールの `debug.*` (`src/main.js`) を使う。`debug.goto` / `debug.near` / `debug.jumpTo` /
  `debug.spawn` / `debug.system()` / `debug.state()` など。一覧は README の「デバッグ」。

## 全体の構造

`src/main.js` が `Game` (`src/game.js`、全体の司令塔) を作り、メニュー・星図・`window.debug` をつなぐ。
`Game` が物理・宇宙・座標系・描画・HUD を1か所で回す。

### 時間
`src/core/loop.js`: 物理は 120 Hz の固定ステップ (`Game.step(h)`)、描画は可変フレーム (`Game.frame_(alpha, dt)`)
で、`alpha` で前後の物理状態を補間する。挙動を変える処理は `step` 側に置く。

### 3段の座標 (巨大スケール対策)
1. **星系座標**: 恒星が原点。天体の位置はここで持つ (`src/universe/system.js` が生成)。
2. **世界座標**: 機体を動かす座標。原点 `game.origin` を機体に合わせて動かし (Floating Origin、`RECENTER`)、
   別の恒星の方が近くなったらその星系に乗り換える。何光年飛んでも機体の座標は小さいまま。
3. **天体のローカル座標 (`game.frame`)**: 惑星やオニール・シリンダーに近づくと、機体をその天体の座標系に入れる
   (`Game.setFrame` → `src/physics/frame.js` の `enterFrame` / `leaveFrame`。惑星は自転する座標系)。

### 座標系の窓口 (重要)
接地 (`src/flight/ground.js`)、飛行、HUD、敵の操縦 (`src/combat/`) は「惑星の中心」を直接使わず、
`game.frame` の窓口だけを使う: `upAt`, `heightAbove`, `roughHeightAbove`, `seaLevelAt`, `gravityAt(p, out)`,
`airDensityAt`, `surfacePoint`, `entersAt`, `containsLocal`, `surfaceDistance`。
`Planet` (`src/planet/planet.js`) と `HabitatView` (`src/render/habitat.js`、円筒の内側。下向きは軸から外向き) が
同じ窓口を持つので、同じ処理で両方を扱える。新しい種類の地面 (例: リングワールド) もこの窓口を実装して足す。
テストの偽の惑星も窓口を持たせる (`tests/m3.test.js`, `tests/m9.test.js`)。

### 生成は決定的で、保存しない
- `src/universe/galaxy.js`: 10 光年四方の区画の番号からハッシュで種を作り、恒星を置く。同じ場所には必ず同じ星。
  ハッシュを変えると宇宙全体が変わる (過去に符号違い・鏡像の区画で重複するバグを直している)。
- `src/universe/system.js`: 恒星の種から星系 (惑星・衛星・小惑星帯・哨戒隊・スウォーム・居住地) を決める。
  出発地 `HOME_STAR` (SOL) だけは手で配置してあり、多くのテストがその配置 (TERRA など) を前提にしている。
- `src/universe/` と `src/terrain/` は **three.js に依存しない** (テストや Worker から使うため)。
  本物の地形のマップ (`src/terrain/maps.js`) は使う前に読み込んでおく (`makeTerrain` は待たない)。緯度経度の変換は `src/terrain/geo.js` だけを使う
  (東経が正。符号を間違えると地図が鏡写しになる)。マップの変換の道具は `tools/maps/` (Python)。
  特に `src/terrain/` は Web Worker (`terrainWorker.js`、`src/planet/planetLod.js` の共有 WorkerPool) からも
  読み込むので、外部ライブラリや DOM を使わない。

### 描画と論理の分け方
「どこに何があるか」を決める純粋な関数と、それを描く three.js のクラスを分ける。
例: `universe/swarm.js` ↔ `render/swarm.js`、`universe/habitat.js` (外の当たり判定) ↔ `render/habitat.js`、
`universe/habitatTerrain.js` ↔ `render/habitatInterior.js`、`planet/city.js` (ビルの配置を描画と当たり判定の両方が使う)。

### 調整値の置き場
- 機体・武器・敵機の数値: `src/flight/shipParams.js` (`FIGHTER`, `weapons`, `RAIDER`, `GUNSHIP`, `gunGimbal`)
- 巡航の速度則: `src/flight/cruise.js` の 4 つの数字
- 敵の腕前と判断: `src/combat/ai.js` (敵は自機と同じ `Ship` を、人間と同じ操縦入力で飛ばす)。哨戒隊の構成: `src/combat/combat.js` の `zones`
- 渓谷と台地の種類: `src/terrain/terrainFn.js` の `CLIFFS`
- 設定項目: `src/core/settings.js` の `SETTING_DEFS` に1行足すとメニューに出て localStorage に保存される

## 進め方の慣習

- 大きな機能は `docs/` に設計書を書いてから段階ごとに作る (例: `docs/design-oneill-cylinder.md`)。
  実装に合わせて設計書の状態・名前も更新する。機能を足したら README の該当する節も直す。
- コミットメッセージは日本語で、1行目に何をしたか、本文に理由・変えた所・足したテストを書く。
