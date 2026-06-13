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

async function main() {
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
  for (const e of toPush) {
    await sendTelegram(e.message);
  }

  console.log('[collect] 完成');
}

main().catch((err) => {
  console.error('[collect] 失敗:', err);
  process.exit(1);
});
