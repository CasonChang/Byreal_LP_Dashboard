# Zeabur 部署 SOP（常駐收集器）

把資料收集從「不可靠的 GitHub Actions 排程」搬到 Zeabur 常駐服務，
真正每 N 分鐘準時更新、Telegram 警報即時，且 git 維持乾淨。

> 它跑的就是 `npm start`（= `src/daemon.ts`）：每 10 分鐘抓 Byreal → 算指標 →
> 寫進 Supabase；每天台北 08:00 發每日報告。**前端不用改，照樣讀 Supabase。**

---

## 0. 前置確認（只需一次）

- [x] Supabase 已建好 `dashboard_state` 表（已跑 `supabase/dashboard_state.sql`）。
- [x] 前端 `docs/config.js` 已填 Supabase URL + anon key。
- 準備好這些值（跟你的 GitHub Secrets 同一批）：
  - `WALLET_ADDRESS`
  - `SUPABASE_URL`
  - `SUPABASE_SERVICE_ROLE_KEY` ⚠️ 是 **service_role**（後端寫入用），不是 anon
  - `TELEGRAM_BOT_TOKEN`
  - `TELEGRAM_CHAT_ID`

  > service_role key 位置：Supabase → Project Settings → API → `service_role`（secret）。
  > 這把只放 Zeabur 環境變數，**絕不可**進前端 / repo。

---

## 1. 在 Zeabur 建立服務

1. 登入 [zeabur.com](https://zeabur.com) → 進你的專案（或新建一個）。
2. **Add Service → Deploy from GitHub** → 選 `CasonChang/Byreal_LP_Dashboard`。
3. 分支選 **`main`**。
4. Zeabur 會自動辨識 Node 專案，安裝依賴並執行 `npm start`（已在 `package.json` 設好 = 啟動 daemon）。
   - 不需要 Dockerfile，也不需要 build 步驟（用 tsx 直接跑 TypeScript）。

---

## 2. 設定環境變數

服務頁面 → **Variables / Environment Variables**，逐一加入：

| 變數 | 值 | 必填 |
|---|---|---|
| `WALLET_ADDRESS` | 你的 Solana 錢包地址 | ✅ |
| `SUPABASE_URL` | `https://djcebqribkmtrhkoytaq.supabase.co` | ✅ |
| `SUPABASE_SERVICE_ROLE_KEY` | service_role 金鑰 | ✅ |
| `TELEGRAM_BOT_TOKEN` | 你的 bot token | ✅ |
| `TELEGRAM_CHAT_ID` | 你的 chat id | ✅ |
| `TZ` | `Asia/Taipei` | 建議 |
| `COLLECT_INTERVAL_MIN` | `10`（要更頻繁可改 `5`） | 可選，預設 10 |
| `DAILY_REPORT_UTC_HOUR` | `0`（= 台北 08:00） | 可選，預設 0 |

存檔後 Zeabur 會自動重新部署。

---

## 3. 部署並驗證

1. 等部署完成，看 **Logs**，應該出現：
   ```
   [daemon] 啟動｜每 10 分鐘收集一次、每日報告 0:00 UTC（台北 8:00）
   [daemon] 健康檢查端點已啟動，PORT=...
   [collect] 部位 N 個 …｜總倉位 $...
   [collect] 完成
   ```
2. （可選）服務頁 **Networking → Generate Domain** 取得公開網址，
   用瀏覽器打開會看到 JSON 狀態，可隨時確認「還活著、上次何時更新」：
   ```json
   { "lastCollectAt": "2026-06-16T...Z", "lastCollectOk": true, "collectCount": 12 }
   ```
3. 開你的 Dashboard 網頁，「更新於」時間應該每 10 分鐘往前跳。

> 首輪不會推 Telegram（只同步狀態，避免重啟洗版），第二輪起才會即時推播事件。

---

## 4. 關掉 GitHub Actions 排程（確認 Zeabur 正常後再做）

避免 Zeabur 與 Actions **重複寫入 / 重複發 Telegram**。二擇一：

- **方法 A（簡單）**：GitHub repo → Actions 分頁 → 分別點開
  「收集 LP 資料」與「每日收益報告」→ 右上 `···` → **Disable workflow**。
- **方法 B（改檔）**：把兩個 workflow 檔的 `schedule:` 區塊註解掉，保留 `workflow_dispatch`
  當手動備援。要我幫你改、push 上去也可以，說一聲即可。

> 保留 `workflow_dispatch` 的好處：Zeabur 萬一掛了，你還能在 GitHub 手動點一下補跑。

---

## 5. 日後修改程式怎麼更新（重點：很輕鬆）

Zeabur 預設**綁定 GitHub 分支自動部署**：

- 我（或你）把改動 push 到 `main` → **Zeabur 自動重新部署**，環境變數不用重設。
- 或在 Zeabur 服務頁手動按 **Redeploy**。
- 想回滾：Zeabur 的 Deployments 列表可一鍵切回舊版本。

就這樣 —— 跟你現在的開發流程一致（改 code → push），只是多了個會自動跟著更新的常駐服務。

---

## 疑難排解

| 症狀 | 可能原因 / 處理 |
|---|---|
| Logs 出現 `缺少 WALLET_ADDRESS 環境變數` | 環境變數沒設或打錯，回 步驟 2 檢查 |
| `寫入 dashboard_state… 失敗` | `dashboard_state.sql` 還沒在 Supabase 跑 |
| 網頁時間沒更新，但 Logs 顯示 `[collect] 完成` | 多半是瀏覽器快取，強制重新整理（Ctrl/Cmd+Shift+R） |
| Telegram 一次湧出很多則 | 多半是 Actions 排程還開著跟 Zeabur 打架 → 做步驟 4 關掉 |
| 想暫停 | Zeabur 服務頁可 Suspend；恢復後 daemon 會接續跑 |
