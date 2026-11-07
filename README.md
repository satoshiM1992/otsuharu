# 推しVTuberを落とせ！ 〜新人VTuber・天音ハル攻略作戦〜

新人VTuber・天音ハルとの恋愛シミュレーションゲーム。スマホのブラウザで遊べます（10〜15分の短編）。
サーバー不要の HTML / JavaScript だけで動き、GitHub Pages で公開できます。

## ローカルで遊ぶ

`index.html` を直接開くとシナリオを読み込めないので、ローカルサーバー経由で開きます。

```powershell
powershell -ExecutionPolicy Bypass -File tools/serve.ps1
```

- ゲーム: http://localhost:8080/
- テスト: http://localhost:8080/test/

### 開発用のURLオプション

| オプション | 内容 |
|---|---|
| `?debug=1` | 好感度・気分・選択肢の種類を表示 |
| `?seed=123` | 乱数を固定（同じ展開を再現） |
| `?rare=all` / `?rare=cat,pin` | レアイベントを必ず発生させる |
| `?rare=neochi` / `?rare=gyaku` | 超レアエンド（寝落ち／逆告白）を必ず発生させる（逆告白は好感度95以上のとき） |
| `?vrm=0` | 3Dモデルを使わず、SVGのアバターで表示 |

## GitHub Pages で公開する

1. GitHub にリポジトリを push する
2. リポジトリの Settings → Pages → Source を「Deploy from a branch」、ブランチを `main`、フォルダを `/ (root)` にする
3. 数分後に `https://<ユーザー名>.github.io/<リポジトリ名>/` で遊べる

## シナリオの編集

会話・選択肢・エンディングはすべて `data/scenario.json` にあります。編集したら `/test/` を開いて「すべて成功」になることを確認してください。
設計の全体像は `docs/scenario-outline.md` を参照。

- 選択肢の種類: 💗好印象 / 🙂普通 / 💀ダメ / 💣地雷（良さそうに見えて重い・押しつけがましい） / 🤪ギャグ / ☠️一発アウト
- 1回に4つ表示（💗・🤪・💣は必ず1つずつ、☠️は30%）
- テストページの mostlyGood（4回に1回まちがえる人）の恋人エンド率を、難易度の目安にしています

## 音

BGMと効果音は、音声ファイルを使わず `js/sound.js` でブラウザ内で合成しています。最初のタップで鳴りはじめ、🔊ボタンでミュートできます。

## 3Dモデル（VRM）

- VTuber版（天音ハル）: `models/Vtuber_red.vrm`（VRoidで作成、作者 SatoshiM）
- リアル版（春川ひなの）: `models/Human_red.vrm`（VRoidで作成、作者 SatoshiM）
- `models/sample.vrm` はpixiv公式のサンプル（VRM1_Constraint_Twist_Sample、© 2022 pixiv Inc.、再配布可・クレジット不要）で、今はゲームでは使っていません。
- 差し替えるときは、VRMファイルを `models/` に置き、`js/main.js` の `VRM_MODELS` を書き換えます。
- VRMが読み込めないとき（オフラインなど）は、SVGの仮アバターで表示されます。`?vrm=0` を付けると、SVGで表示されます。
- 表情と口パクの見た目は http://localhost:8080/test/vrm-check.html で一覧できます。

## 背景

- リアル編の背景（駅前・カフェ・夕焼けの川沿い）は `img/bg/station.svg` / `cafe.svg` / `sunset.svg` のイラストです。
- 同じフォルダに同じ名前の画像（`station.jpg` など。jpg → webp → png → svg の順で探します）を置くと、そちらが優先して使われます。フリー素材や写真に差し替えるときは、ファイルを置くだけでOKです。
- 縦長の画面に合わせて切り抜かれます（横長の画像なら中央付近が使われます）。人物の後ろになる中央より、左右に見せたいものがある画像が向いています。
- フリー素材を使うときは、利用規約（クレジット表記、公開リポジトリに置いてよいか）を確認してください。
