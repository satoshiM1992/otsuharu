# おつハル！ 〜画面の向こうの恋〜

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

## GitHub Pages で公開する

1. GitHub にリポジトリを push する
2. リポジトリの Settings → Pages → Source を「Deploy from a branch」、ブランチを `main`、フォルダを `/ (root)` にする
3. 数分後に `https://<ユーザー名>.github.io/<リポジトリ名>/` で遊べる

## シナリオの編集

会話・選択肢・エンディングはすべて `data/scenario.json` にあります。編集したら `/test/` を開いて「すべて成功」になることを確認してください。
設計の全体像は `docs/scenario-outline.md` を参照。

## 3Dモデル（VRM）

- 今は仮モデルとして、pixiv公式のサンプル `models/sample.vrm`（VRM1_Constraint_Twist_Sample、© 2022 pixiv Inc.、再配布可・クレジット不要）を VTuber版・リアル版の両方に使っています。
- 差し替えるときは、VRMファイルを `models/` に置き、`js/main.js` の `VRM_MODELS` を書き換えます。
- VRMが読み込めないとき（オフラインなど）は、SVGの仮アバターで表示されます。`?vrm=0` を付けると、SVGで表示されます。
- 表情と口パクの見た目は http://localhost:8080/test/vrm-check.html で一覧できます。
