/**
 * 常駐程式（給 Zeabur 之類的長時間運行主機用）。
 *
 * 取代「不可靠的 GitHub Actions 排程」：
 *   - 每 COLLECT_INTERVAL_MIN 分鐘跑一次收集（抓 Byreal → 算 → 寫 Supabase → Telegram）
 *   - 每天 DAILY_REPORT_UTC_HOUR:00 (UTC) 跑一次每日報告
 *   - 開一個極簡 HTTP 健康檢查端點（Zeabur 會給網址，打開可看「上次更新時間」確認還活著）
 *
 * 啟動方式：`npm start` 或 `npm run daemon`。
 * 環境變數跟 GitHub Secrets 同一批（WALLET_ADDRESS / SUPABASE_URL /
 * SUPABASE_SERVICE_ROLE_KEY / TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID）。
 */

import { createServer } from 'node:http';
import { runCollectOnce } from './collect.ts';
import { runDailyReport } from './daily-report.ts';

const INTERVAL_MIN = Math.max(1, Number(process.env.COLLECT_INTERVAL_MIN || '10'));
const REPORT_HOUR_UTC = Number(process.env.DAILY_REPORT_UTC_HOUR ?? '0'); // 0 UTC = 台北 08:00
const PORT = Number(process.env.PORT || '8080');

const state = {
  startedAt: new Date().toISOString(),
  intervalMin: INTERVAL_MIN,
  reportHourUtc: REPORT_HOUR_UTC,
  lastCollectAt: null as string | null,
  lastCollectOk: null as boolean | null,
  lastError: null as string | null,
  collectCount: 0,
  lastReportDate: '' as string, // 已處理過的 UTC 日期，避免同一天重複發報告
};

function utcDate(d = new Date()): string {
  return d.toISOString().slice(0, 10);
}

let firstCycle = true;

async function tick(): Promise<void> {
  const now = new Date();
  try {
    // 首輪只建立基準快照、不做事件偵測：
    // 剛(重新)部署時本地 latest.json 是 git 裡的舊快照，差分會把現有部位全誤判成新開倉。
    await runCollectOnce({ emitEvents: !firstCycle });
    state.lastCollectAt = now.toISOString();
    state.lastCollectOk = true;
    state.lastError = null;
    state.collectCount += 1;
  } catch (err) {
    state.lastCollectOk = false;
    state.lastError = err instanceof Error ? err.message : String(err);
    console.error('[daemon] collect 失敗（不影響下一輪）:', err);
  }
  firstCycle = false;

  // 每日報告：進入報告時段，且今天還沒發過
  if (now.getUTCHours() === REPORT_HOUR_UTC && state.lastReportDate !== utcDate(now)) {
    state.lastReportDate = utcDate(now);
    try {
      await runDailyReport();
      console.log('[daemon] 每日報告已送出');
    } catch (err) {
      console.error('[daemon] 每日報告失敗:', err);
    }
  }
}

function startHealthServer(): void {
  createServer((_req, res) => {
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ service: 'byreal-lp-daemon', ...state }, null, 2));
  }).listen(PORT, () => {
    console.log(`[daemon] 健康檢查端點已啟動，PORT=${PORT}`);
  });
}

async function main(): Promise<void> {
  const taipeiHour = (REPORT_HOUR_UTC + 8) % 24;
  console.log(
    `[daemon] 啟動｜每 ${INTERVAL_MIN} 分鐘收集一次、每日報告 ${REPORT_HOUR_UTC}:00 UTC（台北 ${taipeiHour}:00）`,
  );
  // 首次部署當天不補發每日報告（避免重啟即重發），隔天報告時段起正常運作。
  state.lastReportDate = utcDate();
  startHealthServer();
  await tick();
  setInterval(() => {
    void tick();
  }, INTERVAL_MIN * 60_000);
}

void main();
