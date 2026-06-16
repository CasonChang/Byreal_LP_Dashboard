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
    unclaimedFeeUsd: snap.totals.unclaimedFeeUsd,
    depositUsd: snap.totals.depositUsd,
    bonusUsd: snap.totals.bonusUsd,
    pnlUsd: snap.totals.pnlUsd,
    weightedApr: snap.totals.weightedApr,
    realApr: snap.totals.realApr,
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

  // 今日手續費收益 = 累計手續費的日差（earnedUsd 為累計值，領取不會歸零，故差值即當日實賺）
  const dailyFee = last ? summary.earnedUsd - last.earnedUsd : undefined;

  const lines: string[] = [];
  lines.push(`📊 <b>Byreal LP 每日報告</b>｜${summary.date}`);
  lines.push('');
  lines.push(deltaLine('💵 總倉位', summary.liquidityUsd, last?.liquidityUsd));
  if (dailyFee !== undefined) {
    lines.push(`💰 今日手續費收益：${usd(dailyFee)}`);
  } else {
    lines.push('💰 今日手續費收益：（明日起開始計算）');
  }
  lines.push(`📐 實際年化(自開倉)：${summary.realApr.toFixed(1)}%`);
  lines.push(deltaLine('🪙 累計手續費', summary.earnedUsd, last?.earnedUsd));
  lines.push(`🟢 未領手續費(可領)：${usd(summary.unclaimedFeeUsd)}`);
  if (summary.bonusUsd > 0) lines.push(`🎁 未領獎勵：${usd(summary.bonusUsd)}`);
  lines.push(deltaLine('📉 損益(不含手續費)', summary.pnlUsd, last?.pnlUsd));
  lines.push(`💎 總報酬(含手續費)：${usd(summary.earnedUsd + summary.pnlUsd)}`);
  lines.push(`⚡ 加權池子 APR：${pct(summary.weightedApr)}`);
  lines.push(`📍 部位：${summary.positionCount} 個，區間內 ${summary.inRangeCount} 個`);
  if (snap.strategy) {
    lines.push('');
    lines.push('<b>策略總覽（含已關閉）</b>');
    lines.push(`🏆 手續費年化 ${pct(snap.strategy.feeApr)}｜總報酬年化 ${pct(snap.strategy.totalReturnApr)}`);
    lines.push(`📚 累計手續費 ${usd(snap.strategy.lifetimeFeesUsd)}（已關閉 ${snap.strategy.closedCount} 筆 + 現有 ${snap.strategy.activeCount} 筆）`);
  }
  lines.push('');

  // 各部位明細
  const active = snap.positions.filter((p) => p.status === 'active');
  if (active.length > 0) {
    lines.push('<b>部位明細</b>');
    for (const p of active) {
      const flag = !p.inRange ? '🚨出界' : p.riskLevel === 'high' ? '⚠️快出界' : p.riskLevel === 'medium' ? '🟡偏離' : '🟢';
      lines.push(
        `${flag} <b>${p.pair}</b>｜${usd(p.liquidityUsd)}｜實際年化 ${p.realApr.toFixed(1)}%`,
      );
      lines.push(`    累計手續費 ${usd(p.earnedUsd)}｜未領 ${usd(p.unclaimedFeeUsd)}｜區間 ${price(p.priceLower)}~${price(p.priceUpper)}（價 ${price(p.currentPrice)}）`);
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
