/**
 * 事件偵測：比對「本次快照」與「上次每個部位的狀態」推論發生了什麼動作。
 * 因為我們不碰錢包、只讀資料，所以用快照差分來推測動作（非鏈上精準，但足以記錄策略行為）。
 */

import { config } from './config.ts';
import type { LpEvent, PortfolioSnapshot, PositionMetric } from './types.ts';
import type { PrevPositionState } from './supabase.ts';
import { usd, pct, price } from './format.ts';

// 變動判定門檻
const LIQ_CHANGE_PCT = 5; // 倉位金額變動超過 5% 視為加/減倉
const FEE_CLAIM_MIN_USD = 0.2; // 未領手續費掉到接近 0 且原本 > 此值 → 視為領取
const FEE_CLAIM_DROP_RATIO = 0.4; // 掉到原本的 40% 以下

export function detectEvents(
  snap: PortfolioSnapshot,
  prev: Map<string, PrevPositionState>,
): LpEvent[] {
  const events: LpEvent[] = [];
  const now = snap.capturedAt;
  const seen = new Set<string>();

  for (const p of snap.positions) {
    seen.add(p.positionAddress);
    const before = prev.get(p.positionAddress);

    if (!before) {
      // 第一次看到 → 開倉（但若 prev 整個是空的（首次執行），不要洗版）
      if (prev.size > 0) {
        events.push(mk('open', now, p, `🆕 新開倉 <b>${p.pair}</b>｜倉位 ${usd(p.liquidityUsd)}｜區間 ${price(p.priceLower)}~${price(p.priceUpper)}`, {
          liquidityUsd: p.liquidityUsd,
          priceLower: p.priceLower,
          priceUpper: p.priceUpper,
        }));
      }
      continue;
    }

    // 調倉：tick 區間改變
    if (before.lowerTick !== p.lowerTick || before.upperTick !== p.upperTick) {
      events.push(mk('rebalance', now, p, `🔄 調倉 <b>${p.pair}</b>｜新區間 ${price(p.priceLower)}~${price(p.priceUpper)}｜倉位 ${usd(p.liquidityUsd)}`, {
        oldTicks: [before.lowerTick, before.upperTick],
        newTicks: [p.lowerTick, p.upperTick],
        priceLower: p.priceLower,
        priceUpper: p.priceUpper,
      }));
    }

    // 領取手續費：未領手續費由有變到趨近 0
    if (
      before.earnedUsd >= FEE_CLAIM_MIN_USD &&
      p.earnedUsd <= before.earnedUsd * FEE_CLAIM_DROP_RATIO &&
      p.earnedUsd < before.earnedUsd - FEE_CLAIM_MIN_USD / 2
    ) {
      const claimed = before.earnedUsd - p.earnedUsd;
      events.push(mk('fee_claim', now, p, `💰 領取手續費 <b>${p.pair}</b>｜約 ${usd(claimed)}`, {
        claimedUsd: claimed,
        before: before.earnedUsd,
        after: p.earnedUsd,
      }));
    }

    // 加 / 減倉：流動性金額顯著變動（排除純價格波動造成的小幅變化）
    if (before.liquidityUsd > 0) {
      const changePct = ((p.liquidityUsd - before.liquidityUsd) / before.liquidityUsd) * 100;
      if (changePct > LIQ_CHANGE_PCT) {
        events.push(mk('add_liquidity', now, p, `➕ 添加流動性 <b>${p.pair}</b>｜${usd(before.liquidityUsd)} → ${usd(p.liquidityUsd)} (+${changePct.toFixed(1)}%)`, {
          before: before.liquidityUsd,
          after: p.liquidityUsd,
          changePct,
        }));
      } else if (changePct < -LIQ_CHANGE_PCT && p.status === 'active') {
        events.push(mk('remove_liquidity', now, p, `➖ 移除部分流動性 <b>${p.pair}</b>｜${usd(before.liquidityUsd)} → ${usd(p.liquidityUsd)} (${changePct.toFixed(1)}%)`, {
          before: before.liquidityUsd,
          after: p.liquidityUsd,
          changePct,
        }));
      }
    }

    // 區間警示（含去重：只在狀態變化時提醒）
    const rangeEvt = rangeAlert(p, before, now);
    if (rangeEvt) events.push(rangeEvt);
  }

  // 關倉：上次有、這次不在 active 清單
  for (const [addr, before] of prev) {
    if (seen.has(addr)) continue;
    if (before.status !== 'active') continue;
    events.push({
      type: 'close',
      occurredAt: now,
      positionAddress: addr,
      pair: '',
      message: `📕 關閉部位（已不在 active 清單）｜原倉位 ${usd(before.liquidityUsd)}`,
      detail: { lastLiquidityUsd: before.liquidityUsd },
    });
  }

  return events;
}

function rangeAlert(p: PositionMetric, before: PrevPositionState, now: string): LpEvent | null {
  // 已出界（之前還在內）
  if (!p.inRange && before.inRange) {
    return mk('out_of_range', now, p, `🚨 <b>${p.pair}</b> 已出界！目前價格 ${price(p.currentPrice)}，區間 ${price(p.priceLower)}~${price(p.priceUpper)}（已停止賺取手續費）`, {
      currentPrice: p.currentPrice,
      priceLower: p.priceLower,
      priceUpper: p.priceUpper,
    });
  }
  // 回到區間內
  if (p.inRange && !before.inRange) {
    return mk('back_in_range', now, p, `✅ <b>${p.pair}</b> 回到區間內，目前價格 ${price(p.currentPrice)}`, {
      currentPrice: p.currentPrice,
    });
  }
  // 快出界：由非 high/out 升級到 high（距邊界 < warnPct 由 medium 進到 high，或剛進入 medium）
  const warnLevels = ['high'];
  if (p.inRange && warnLevels.includes(p.riskLevel) && before.riskLevel !== p.riskLevel && before.riskLevel !== 'out') {
    return mk('range_warning', now, p, `⚠️ <b>${p.pair}</b> 快出界！距最近邊界僅 ${Math.abs(p.nearestBoundaryPct).toFixed(1)}%（價格 ${price(p.currentPrice)}，區間 ${price(p.priceLower)}~${price(p.priceUpper)}）`, {
      nearestBoundaryPct: p.nearestBoundaryPct,
      currentPrice: p.currentPrice,
    });
  }
  return null;
}

function mk(type: LpEvent['type'], now: string, p: PositionMetric, message: string, detail: Record<string, unknown>): LpEvent {
  return { type, occurredAt: now, positionAddress: p.positionAddress, pair: p.pair, message, detail };
}
