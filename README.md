# Byreal LP 績效儀表板 🌊

每天自動整理你在 [Byreal](https://byreal.io)（Solana CLMM DEX）的流動性池績效，
記錄倉位、手續費、年化、區間健康度，並在**快出界 / 已出界 / 領手續費 / 調倉 / 加減倉**時
透過 **Telegram 推播**，外加**每日收益報告**。前端以 **GitHub Pages** 呈現。

> **完全唯讀、零授權。** 只用你提供的錢包地址向 Byreal 公開 API 查詢，
> 不需要、也不會碰你的私鑰或任何錢包授權。所有實際操作（領費 / 調倉 / 加減倉）由你自己在錢包執行。

追蹤錢包：`FPa1NnUpG89LpHLnKAPrNrxksVZWrjcpNAqnXiwpoqYn`

---

## 架構

```
GitHub Actions (每小時 / 每日)         Supabase            GitHub Pages
┌─────────────────────────┐      ┌──────────────┐     ┌──────────────┐
│ 1. 查 Byreal position API│─────▶│ snapshots    │     │ 靜態儀表板    │
│ 2. 算區間健康度 / APR    │      │ position_…   │◀────│ 讀 data/*.json│
│ 3. 與上次快照比對偵測事件 │      │ events       │     │ (繁中, 圖表)  │
│ 4. 寫入 Supabase         │      │ daily_reports│     └──────────────┘
│ 5. Telegram 推播         │      └──────────────┘            ▲
│ 6. 輸出 docs/data/*.json │───────────────────────────────────┘
└─────────────────────────┘──▶ Telegram 📱
```

- **資料收集只在 GitHub Actions 執行**（egress 不受限，能連 Byreal API）。GitHub Pages 是純靜態，只讀 JSON。
- **Supabase** 存長期歷史（快照 / 部位明細 / 事件 / 每日報告），同時驅動 Telegram 與權益曲線。
- **事件偵測用「快照差分」**：不碰鏈、只比較前後兩次查詢結果來推測你做了什麼動作。

### 用到的 Byreal API（公開、免授權）
| 用途 | 端點 |
|------|------|
| 查錢包所有部位 | `GET /byreal/api/dex/v2/position/list?userAddress=<wallet>` |
| 查池子價格/TVL/APR | `GET /byreal/api/dex/v2/pools/details?poolAddress=<pool>` |

區間價格由部位的 `lowerTick`/`upperTick` 以 `1.0001^tick` 換算（含自動校準計價方向）。

---

## 一次性設定

### 1. Telegram Bot
1. Telegram 找 **@BotFather** → `/newbot` → 取得 **bot token**。
2. 找 **@userinfobot** → 取得你的 **chat id**（數字）。
3. 先對你的 bot 送一句話（例如 `/start`），否則 bot 無法主動傳訊給你。

### 2. Supabase
1. 到 [supabase.com](https://supabase.com) 建立專案。
2. 開 **SQL Editor**，貼上 [`supabase/schema.sql`](supabase/schema.sql) 全部內容並執行。
3. **Settings → API** 取得：
   - `Project URL` → `SUPABASE_URL`
   - `service_role` key（⚠️ 私密，只放 GitHub Secrets）→ `SUPABASE_SERVICE_ROLE_KEY`

### 3. GitHub Secrets
Repo → **Settings → Secrets and variables → Actions → New repository secret**，新增：

| Secret | 值 |
|--------|----|
| `WALLET_ADDRESS` | `FPa1NnUpG89LpHLnKAPrNrxksVZWrjcpNAqnXiwpoqYn`（可逗號分隔多個） |
| `TELEGRAM_BOT_TOKEN` | BotFather 給的 token |
| `TELEGRAM_CHAT_ID` | 你的 chat id |
| `SUPABASE_URL` | Supabase Project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service_role key |

（選填）**Variables** 分頁可加 `RANGE_WARN_PCT`（快出界門檻 %，預設 `8`）。

### 4. 啟用 GitHub Pages
Repo → **Settings → Pages** → Source 選 **Deploy from a branch** → Branch `main` / 資料夾 `/docs` → Save。
網址會是 `https://<帳號>.github.io/<repo>/`。

### 5. 啟用並執行 Actions
- Repo → **Actions** 分頁，啟用 workflows。
- 先手動跑一次：**收集 LP 資料（每小時）** → **Run workflow**，確認有資料與推播。
- 之後會：每小時收集一次、每天台北 08:00（UTC 00:00）送每日報告。

---

## 本地預覽 / 開發

```bash
npm install

# 產生示範資料（不需任何金鑰，先看畫面）
npm run mock
npx serve docs        # 或任意靜態伺服器，開 http://localhost:3000

# 用真實 API 試跑（需設定 .env，但不寫 DB、不推播）
cp .env.example .env   # 填入金鑰
npm run collect:dry    # DRY_RUN：印出結果，不寫 Supabase、不送 Telegram
npm run report:dry

# 正式執行（會寫 Supabase + 推播）
npm run collect
npm run daily-report

npm run typecheck
```

> 注意：部分網路環境（含本專案的雲端開發容器）可能封鎖 `api2.byreal.io`，
> 因此真正的資料收集設計成在 **GitHub Actions** 上跑。本地若連不到 API 屬正常。

---

## 偵測到的事件類型

| 類型 | 觸發條件（快照差分） | 推播 |
|------|---------------------|------|
| `out_of_range` 已出界 | 價格離開區間（之前在內） | 🚨 |
| `range_warning` 快出界 | 距最近邊界 < `RANGE_WARN_PCT`% | ⚠️ |
| `back_in_range` 回區間 | 價格回到區間內 | ✅ |
| `fee_claim` 領手續費 | 未領手續費大幅掉到趨近 0 | 💰 |
| `add_liquidity` 加倉 | 倉位金額 +>5% | ➕ |
| `remove_liquidity` 減倉 | 倉位金額 −>5% | ➖ |
| `rebalance` 調倉 | tick 區間改變 | 🔄 |
| `open` / `close` 開/關倉 | 部位出現 / 消失 | 🆕 / 📕 |

> 因為是差分推測，金額為估計值；以你錢包實際交易為準。可調整 `src/events.ts` 內門檻。

---

## 檔案結構

```
src/
  collect.ts       每小時主流程（查詢→偵測→存→推播→輸出 JSON）
  daily-report.ts  每日報告
  byreal.ts        Byreal API client（position/list, pools/details）
  tick.ts          tick↔價格換算（自動校準計價方向）
  metrics.ts       組裝部位指標 + 區間健康度
  events.ts        快照差分事件偵測
  supabase.ts      資料庫讀寫
  telegram.ts      推播
  export.ts        輸出 docs/data/*.json
  mock.ts          產生示範資料
docs/              GitHub Pages 靜態前端（index.html / app.js / styles.css / data/）
supabase/schema.sql 資料表 DDL
.github/workflows/  collect.yml（每小時）、daily-report.yml（每日）
```

---

## 隱私與安全
- 只查詢公開鏈上資料，**不需任何錢包授權或私鑰**。
- `service_role` key 與 Telegram token 只存在 GitHub Secrets，不會出現在前端或 commit。
- 前端不直接連 Supabase，僅讀取由 Actions 產生的靜態 JSON。
