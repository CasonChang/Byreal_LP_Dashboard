/**
 * 每日收益報告（GitHub Actions 每天 00:00 UTC = 台北 08:00 執行）。
 * 彙整目前部位、與上次報告比較日變化，推播 Telegram 並存進 Supabase。
 */

import { config, assertConfig } from './config.ts';
import { buildSnapshot } from './metrics.ts';
import { saveSnapshot, saveDailyReport, getLastDailySummary, getRecentEvents } from './supabase.ts';
import { sendTelegram } from './telegram.ts';
import { exportJson } from './export.ts';
import { usd, pct, price, taipeiDate } from './format.ts';
import type { PortfolioSnapshot } from './types.ts';

function buildSummary(snap: PortfolioSnapshot) {
  return {
    date: taipeiDate(snap.capturedAt),
    liquidityUsd: snap.totals.liquidityUsd,
    earnedUsd: snap.totals.earnedUsd,
    bonusUsd: snap.totals.bonusUsd,
    pnlUsd: snap.totals.pnlUsd,
    weightedApr: snap.totals.weightedApr,
    positionCount: snap.totals.positionCount,
    inRangeCount: snap.totals.inRangeCount,
  };
}

function deltaLine(label: string, now: number, prev: number | undefined, isUsd = true): string {
  if (prev === undefined || prev === null) return `${label}：${isUsd ? usd(now) : pct(now)}`;
  const diff = now - prev;
  const arrow = diff > 0 ? '🔺' : diff < 0 ? '🔻' : '➖';
  const diffStr = isUsd ? usd(Math.abs(diff)) : `${Math.abs(diff).toFixed(2)}%`;
  return `${label}：${isUsd ? usd(now) : pct(now)}（${arrow}${diffStr}）`;
}

async function main() {
  assertConfig({ needSupabase: true, needTelegram: true });
  console.log(`[daily] 產生每日報告${config.dryRun ? ' (DRY_RUN)' : ''}`);

  const snap = await buildSnapshot(config.wallets);
  const summary = buildSummary(snap);
  const last = await getLastDailySummary();

  const since = new Date(Date.now() - 24 * 3600_000).toISOString();
  const recentEvents = await getRecentEvents(since);
  const claims = recentEvents.filter((e) => e.type === 'fee_claim');
  const claimedUsd = claims.reduce((a, e) => a + (Number(e.detail?.claimedUsd) || 0), 0);

  const lines: string[] = [];
  lines.push(`📊 <b>Byreal LP 每日報告</b>｜${summary.date}`);
  lines.push('');
  lines.push(deltaLine('💵 總倉位', summary.liquidityUsd, last?.liquidityUsd));
  lines.push(deltaLine('🪙 未領手續費', summary.earnedUsd, last?.earnedUsd));
  if (summary.bonusUsd > 0) lines.push(`🎁 未領獎勵：${usd(summary.bonusUsd)}`);
  lines.push(deltaLine('📈 持倉損益(PnL)', summary.pnlUsd, last?.pnlUsd));
  lines.push(deltaLine('⚡ 加權 APR', summary.weightedApr, last?.weightedApr, false));
  if (claims.length > 0) lines.push(`💰 過去 24h 領取手續費：${usd(claimedUsd)}（${claims.length} 次）`);
  lines.push(`📍 部位：${summary.positionCount} 個，區間內 ${summary.inRangeCount} 個`);
  lines.push('');

  // 各部位明細
  const active = snap.positions.filter((p) => p.status === 'active');
  if (active.length > 0) {
    lines.push('<b>部位明細</b>');
    for (const p of active) {
      const flag = !p.inRange ? '🚨出界' : p.riskLevel === 'high' ? '⚠️快出界' : p.riskLevel === 'medium' ? '🟡偏離' : '🟢';
      lines.push(
        `${flag} <b>${p.pair}</b>｜${usd(p.liquidityUsd)}｜手續費 ${usd(p.earnedUsd)}｜APR ${p.apr.toFixed(1)}%`,
      );
      lines.push(`    價格 ${price(p.currentPrice)}｜區間 ${price(p.priceLower)}~${price(p.priceUpper)}`);
    }
  } else {
    lines.push('（目前沒有 active 部位）');
  }

  const message = lines.join('\n');
  await sendTelegram(message);

  // 寫入報告 + 一份快照（讓權益曲線有當天資料點）
  await saveSnapshot(snap);
  await saveDailyReport(summary.date, summary, message);
  await exportJson(snap, recentEvents);

  console.log('[daily] 完成');
}

main().catch((err) => {
  console.error('[daily] 失敗:', err);
  process.exit(1);
});
