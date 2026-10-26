<!-- 翻譯自 README.md -->

<div align="center">

<h1>roll</h1>

<p><strong>照片和影片放在自己的伺服器，每個人一條私人時間軸。</strong></p>

[English](README.md) | **繁體中文**

</div>

把手機裡的原檔複製到伺服器。roll 讀取原檔、做小預覽，排成一條由新到舊的時間軸。每個人用 passkey 登入，只看得到自己的照片。

## 功能

- **用 passkey 登入**：Touch ID 或 Face ID，不用密碼。
- **邀請一個人**：一次性連結替一個帳號註冊 passkey。
- **瀏覽時間軸**：依拍攝順序的瀑布牆，捲動時分頁載入。
- **一個框搜尋**：日期（`4/15`、`2026 年 4 月`）、城市（`京都`、`Kyoto`）、國家（`日本`）和類型（`自拍`、`截圖`、`影片`、`原況`、`全景`）可以一起用，按 `/` 或 Cmd+K。
- **語意搜尋**：其他字詞會找出畫面相符的照片和影片片段（`海邊`、`京都拉麵`），照片裡有這段文字的排最前面（截圖、菜單、車票）。
- **為人物命名**：同一個人的臉會自動分成一組，在搜尋框命名一次，之後用名字就找得到他的所有照片（`媽媽`、`媽媽 京都`）。
- **上傳**：選檔案或拖進頁面，原檔一個位元都不改。
- **刪除**：照片移到 `<user>/.trash/<日期>/`，從時間軸消失。
- **打開照片**：全螢幕檢視，支援方向鍵、滑動和下載原檔。
- **保留 iPhone 格式**：HEIC 照片、HEVC 影片和原況照片照原樣播放。

## 快速開始

```sh
bun install
bun run build
bun server/index.ts invite loki Loki
bun run start
```

打開印出的連結，註冊 passkey。把照片複製到 `data/library/loki/`，下一次掃描就會出現。

## 使用方式

1. 在伺服器上執行 `bun build/server.js invite <使用者 id> <名字>`。
2. 把印出的連結傳給對方。連結只能用 1 次，7 天內有效。
3. 用 rsync 把對方的原檔複製到 `/srv/roll/library/<使用者 id>/`。
4. 等下一次掃描（每 15 分鐘），或重新啟動服務。

## 設定

| 變數 | 用途 | 預設 |
|-----|------|------|
| `ROLL_ORIGIN` | 網站來源，也是 passkey 的 RP ID | `http://localhost:8080` |
| `ROLL_DATA` | 資料庫、預覽和圖庫的資料夾 | `./data` |
| `ROLL_LIBRARY` | 原檔，每人一個資料夾 | `<ROLL_DATA>/library` |
| `ROLL_DIST` | 建置好的網頁 | `./dist` |
| `ROLL_PORT` | 監聽埠 | `8080` |
| `ROLL_SCAN_MINUTES` | 兩次掃描間隔的分鐘數 | `15` |
| `ROLL_WORKERS` | 同時製作的預覽數 | `2` |
| `ROLL_GEONAMES` | GeoNames 的 `cities1000.txt`，用來查城市名稱 | `<ROLL_DATA>/geo/cities1000.txt` |
| `ROLL_RESERVE_GB` | 上傳後至少要留下的磁碟空間 | `10` |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | OTLP/HTTP JSON 記錄送往的位置 | 關閉 |

## 運作方式

掃描會走過每個人的資料夾。exiftool 讀拍攝時間和 GPS，vips 做 2048 px 和 640 px 兩種 WebP。影片先用 ffmpeg 取第一格。同名的照片和影片視為原況照片。每次 API 查詢都同時比對照片 id 和登入的使用者。

## 開發

```sh
git clone https://github.com/zyx1121/roll && cd roll
bun install
bun test server && bun run typecheck && bun run lint
```

`scripts/deploy.sh` 會測試、建置並部署到伺服器。

## 授權

[MIT](LICENSE)
