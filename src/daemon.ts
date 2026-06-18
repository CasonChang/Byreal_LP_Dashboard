/**
 * 常駐程式（給 Zeabur 之類的長時間運行主機用）。
 *
 * 取代「不可靠的 GitHub Actions 排程」：
 *   - 每 COLLECT_INTERVAL_MIN 分鐘跑一次收集（抓 Byreal → 算 → 寫 Supabase → Telegram）
 *   - 每天台北 DAILY_REPORT_TAIPEI_HOUR 點過後送一次每日報告（用資料庫判斷今天是否已發，支援補發）
 *   - 每 SCAN_INTERVAL_HOURS 小時跑一次熱門池掃描（寫進 Supabase 給研究頁面）
 *   - 開一個極簡 HTTP 健康檢查端點（Zeabur 會給網址，打開可看「上次更新時間」確認還活著）
 *
 * 啟動方式：`npm start` 或 `npm run daemon`。
 */

import { createServer } from 'node:http';
import { runCollectOnce } from './collect.ts';
import { runDailyReport } from './daily-report.ts';
import { runScanOnce } from './scan.ts';
import { getLastReportDate } from './supabase.ts';

const INTERVAL_MIN = Math.max(1, Number(process.env.COLLECT_INTERVAL_MIN || '10'));
const SCAN_INTERVAL_HOURS = Math.max(1, Number(process.env.SCAN_INTERVAL_HOURS || '12'));
// 每日報告時間（台北小時）。相容舊變數 DAILY_REPORT_UTC_HOUR（會自動 +8 換成台北）。
const REPORT_TAIPEI_HOUR =
  process.env.DAILY_REPORT_TAIPEI_HOUR != null
    ? Number(process.env.DAILY_REPORT_TAIPEI_HOUR)
    : (Number(process.env.DAILY_REPORT_UTC_HOUR ?? '0') + 8) % 24;
const PORT = Number(process.env.PORT || '8080');

const state = {
  startedAt: new Date().toISOString(),
  intervalMin: INTERVAL_MIN,
  reportTaipeiHour: REPORT_TAIPEI_HOUR,
  lastCollectAt: null as string | null,
  lastCollectOk: null as boolean | null,
  lastError: null as string | null,
  collectCount: 0,
  lastScanAt: null as string | null,
  lastReportDate: '' as string, // 已發過報告的台北日期（YYYY-MM-DD），開機時由資料庫帶入
};

/** 取得「現在」的台北日期與小時。 */
function taipeiNow(d = new Date()): { date: string; hour: number } {
  const s = d.toLocaleString('sv-SE', { timeZone: 'Asia/Taipei' }); // "2026-06-17 08:30:00"
  return { date: s.slice(0, 10), hour: Number(s.slice(11, 13)) };
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

  // 每日報告：台北時間過了報告時間、且今天還沒發過 → 送出（支援補發；用資料庫去重）
  const tp = taipeiNow(now);
  if (tp.hour >= REPORT_TAIPEI_HOUR && state.lastReportDate !== tp.date) {
    try {
      await runDailyReport();
      state.lastReportDate = tp.date;
      console.log(`[daemon] 每日報告已送出（${tp.date}）`);
    } catch (err) {
      console.error('[daemon] 每日報告失敗（下一輪會再試）:', err);
    }
  }
}

async function scanTick(): Promise<void> {
  try {
    await runScanOnce();
    state.lastScanAt = new Date().toISOString();
  } catch (err) {
    console.error('[daemon] 熱門池掃描失敗:', err);
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
  console.log(
    `[daemon] 啟動｜每 ${INTERVAL_MIN} 分鐘收集、每日報告 台北 ${REPORT_TAIPEI_HOUR}:00、每 ${SCAN_INTERVAL_HOURS} 小時掃描`,
  );
  // 開機時從資料庫帶入「上次報告日期」，避免重啟重發、也能在錯過時補發。
  state.lastReportDate = (await getLastReportDate()) ?? '';
  startHealthServer();

  await tick();
  setInterval(() => {
    void tick();
  }, INTERVAL_MIN * 60_000);

  // 掃描：啟動先跑一次，之後固定間隔
  void scanTick();
  setInterval(() => {
    void scanTick();
  }, SCAN_INTERVAL_HOURS * 3600_000);
}

void main();
