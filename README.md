# Checkmate｜Phase 1

iPad Safari 與電腦瀏覽器的 2D 西洋棋。支援同機面對面、好友房、每人獨立計時、棋局續玩、合法走法提示、升變與 PGN 匯出。

## 本機啟動

使用 Node.js 24 和 pnpm。

```powershell
pnpm install --store-dir .pnpm-store --node-linker=hoisted
node --env-file-if-exists=.env server.mjs
```

開啟 http://127.0.0.1:5173。沒有雲端設定時，可用訪客身分試玩同機對弈。訪客棋局存在當前瀏覽器，切換頁籤或離開時自動暫停。回到頁面後按「繼續」。

用 iPad 連到同網路的開發電腦時，在 .env 設定 HOST=0.0.0.0，並開啟電腦的區域網路位址與連接埠。正式環境使用 HTTPS。

## 雲端設定

1. 在 Firebase 專案啟用 Realtime Database，保存該資料庫完整網址。用 firebase/database.rules.json 拒絕公開存取。所有房間讀寫都經過 Node 後端的 Firebase Admin SDK。
2. 啟用 Google Sheets API。建立私人試算表，新增 Players 分頁，在 A1:F1 填入 playerId、username、nickname、salt、passwordHash、createdAt。
3. 讓服務帳戶能存取 Firebase Realtime Database，並將試算表以編輯者權限分享給該服務帳戶。正式環境優先使用託管平台提供的 Application Default Credentials。本機若使用金鑰檔，放在專案外。
4. 複製 .env.example 為 .env，設定 GOOGLE_SHEET_ID、FIREBASE_DATABASE_URL、SESSION_SECRET，以及本機金鑰的 GOOGLE_APPLICATION_CREDENTIALS 路徑。SESSION_SECRET 使用至少 32 字元的隨機值，可用下方指令產生。正式 HTTPS 站台設定 SECURE_COOKIES=1。
5. 使用支援 Node.js 常駐程序與 SSE 的 HTTPS 主機。第一版維持單一 Node 實例，讓 Google Sheets 的註冊查重與新增依序執行。反向代理需轉送原始 Host 並停用 SSE 緩衝。公開部署前，在代理層依訪客 IP 限制登入與註冊請求。

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

線上房主執白，第二位加入者執黑。開局後以邀請連結或房間碼重連。只在雙方同意時暫停，有計時的對局在斷線期間照常消耗時間。至少一位玩家連線時，會在倒數歸零後提交超時檢查。雙方都離線時，重連後確認勝負。

## 驗收

執行 node --test 跑棋規、時鐘、續局及暫停同意測試。雲端服務設定後，用 iPad Safari 和另一台電腦各註冊一名玩家，再驗證以下流程。

- 同機登入兩個帳號，確認棋盤固定、兩端名稱朝向各自座位，且關頁重開後剩餘時間停在離開時。
- 開房、加入、走棋、重新整理並回到同一房間。兩端應各以自己的棋色朝下。
- 先由一方要求暫停，確認時鐘繼續，對方同意後再確認兩端同時停錶。
- 以短時間開局後斷線，確認重連時仍採原有時鐘，歸零後判定超時。
- 完成棋局並下載 PGN。

## 實作範圍

第一版採固定淺咖啡與黑色棋盤。商店、金幣、配件及自訂配色留到後續版本。規則引擎採 chess.js，三次重複及五十步規則會自動判和。計時超時判定對手獲勝，第一版尚未涵蓋 FIDE 對於個別超時局面是否可能將死的例外。裝置若強制結束瀏覽器且未送出頁面離開事件，下次開啟時才會凍結本機時鐘。
