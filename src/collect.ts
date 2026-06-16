/**
 * 主流程（每小時由 GitHub Actions 執行）：
 * 1) 查 Byreal 取得目前所有部位
 * 2) 算指標（區間健康度、加權 APR…）
 * 3) 讀上次狀態 → 偵測事件（領費 / 調倉 / 加減倉 / 出界）
 * 4) 寫入 Supabase
 * 5) 對重要事件做 Telegram 推播
 * 6) 輸出 JSON 給前端
 */

import { config, assertConfig } from './config.ts';
import { buildSnapshot } from './metrics.ts';
import { detectEvents } from './events.ts';
import { saveSnapshot, saveEvents } from './supabase.ts';
import { sendTelegram } from './telegram.ts';
import { exportJson, readPreviousPositions } from './export.ts';
import { isDirectRun } from './runtime.ts';
import { usd } from './format.ts';
import type { LpEvent } from './types.ts';

// 這些事件類型會即時推播
const PUSH_TYPES = new Set<LpEvent['type']>([
  'out_of_range',
  'range_warning',
  'back_in_range',
  'fee_claim',
  'add_liquidity',
  'remove_liquidity',
  'rebalance',
  'open',
  'close',
]);

/**
 * 跑一次完整收集流程。可被 CLI(`npm run collect`)或常駐程式(daemon)重複呼叫。
 * @param pushEvents 是否推播 Telegram（daemon 首輪設 false，只同步狀態、不洗版）
 */
export async function runCollectOnce({ pushEvents = true }: { pushEvents?: boolean } = {}): Promise<void> {
  assertConfig({ needSupabase: true, needTelegram: true });
  console.log(`[collect] 錢包: ${config.wallets.join(', ')}${config.dryRun ? ' (DRY_RUN)' : ''}`);

  // 先讀上一份快照（用於事件差分），再覆寫
  const prev = await readPreviousPositions();

  const snap = await buildSnapshot(config.wallets);
  console.log(
    `[collect] 部位 ${snap.totals.positionCount} 個（active ${snap.totals.activeCount}，區間內 ${snap.totals.inRangeCount}）｜總倉位 ${usd(snap.totals.liquidityUsd)}｜累計手續費 ${usd(snap.totals.earnedUsd)}｜未領 ${usd(snap.totals.unclaimedFeeUsd)}`,
  );

  const events = detectEvents(snap, prev);
  console.log(`[collect] 偵測到 ${events.length} 個事件`);

  // 先寫資料，再推播（推播失敗不影響資料）
  await saveSnapshot(snap);
  await saveEvents(events);
  await exportJson(snap, events);

  // 推播重要事件
  const toPush = events.filter((e) => PUSH_TYPES.has(e.type));
  if (pushEvents) {
    for (const e of toPush) {
      await sendTelegram(e.message);
    }
  } else if (toPush.length > 0) {
    console.log(`[collect] 首輪略過 ${toPush.length} 則推播（僅同步狀態，避免重啟洗版）`);
  }

  console.log('[collect] 完成');
}

// 直接以 `tsx src/collect.ts` 執行時才自動跑一次；被 import 時不執行。
if (isDirectRun(import.meta.url)) {
  runCollectOnce().catch((err) => {
    console.error('[collect] 失敗:', err);
    process.exit(1);
  });
}
