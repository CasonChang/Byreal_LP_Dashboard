/**
 * 事件偵測：比對「本次快照」與「上一次快照（前一份 latest.json）」推論發生了什麼動作。
 * 因為我們不碰錢包、只讀資料，所以用快照差分來推測動作（非鏈上精準，但足以記錄策略行為）。
 *
 * prev 直接用上一份 PortfolioSnapshot 的 positions（由 collect 從 docs/data/latest.json 載入），
 * 不依賴資料庫，較穩定。
 */

import type { LpEvent, PortfolioSnapshot, PositionMetric } from './types.ts';
import { usd, price } from './format.ts';

// 變動判定門檻
const LIQ_CHANGE_PCT = 15; // 倉位 USD 金額變動超過此值才視為加/減倉（避免價格波動誤報）
const FEE_CLAIM_MIN_USD = 0.5; // 未領手續費至少下降此金額才算領取
const FEE_CLAIM_DROP_RATIO = 0.5; // 未領手續費掉到原本的 50% 以下才算領取

export function detectEvents(
  snap: PortfolioSnapshot,
  prev: Map<string, PositionMetric>,
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

    // 領取手續費：未領手續費（unclaimedFeeUsd，精確值）大幅下降 → 判定為領取
    const beforeUnclaimed = before.unclaimedFeeUsd ?? 0;
    if (
      beforeUnclaimed >= FEE_CLAIM_MIN_USD &&
      p.unclaimedFeeUsd <= beforeUnclaimed * FEE_CLAIM_DROP_RATIO &&
      beforeUnclaimed - p.unclaimedFeeUsd >= FEE_CLAIM_MIN_USD
    ) {
      const claimed = beforeUnclaimed - p.unclaimedFeeUsd;
      events.push(mk('fee_claim', now, p, `💰 領取手續費 <b>${p.pair}</b>｜約 ${usd(claimed)}`, {
        claimedUsd: claimed,
        before: beforeUnclaimed,
        after: p.unclaimedFeeUsd,
      }));
    }

    // 加 / 減倉：流動性金額顯著變動。注意 liquidityUsd 會隨價格波動，故門檻設高一點。
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
      pair: before.pair,
      message: `📕 關閉部位 <b>${before.pair}</b>（已不在 active 清單）｜原倉位 ${usd(before.liquidityUsd)}`,
      detail: { lastLiquidityUsd: before.liquidityUsd },
    });
  }

  return events;
}

function rangeAlert(p: PositionMetric, before: PositionMetric, now: string): LpEvent | null {
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
  // 快出界：剛升級到 high（距邊界 < warnPct）
  if (p.inRange && p.riskLevel === 'high' && before.riskLevel !== 'high' && before.riskLevel !== 'out') {
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
