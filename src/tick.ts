/**
 * CLMM tick ↔ 價格換算。
 *
 * 標準公式：price = 1.0001^tick，再依 token 小數位調整。
 * 由於不同池子的計價方向 / decimals 慣例可能不一致，這裡用「自動校準」：
 * 已知 currentPrice（由 token USD 價推得、可信），我們嘗試數種變換，
 * 選出讓區間中點（幾何平均）最接近 currentPrice 的那一種，避免方向／倍率錯誤。
 */

const BASE = 1.0001;

export interface PriceRange {
  priceLower: number;
  priceUpper: number;
}

function rawPriceFromTick(tick: number): number {
  return Math.pow(BASE, tick);
}

/**
 * 將 lowerTick/upperTick 轉成人類可讀的價格區間，並對齊 currentPrice 的計價方向。
 */
export function ticksToPriceRange(
  lowerTick: number,
  upperTick: number,
  decimalsA: number,
  decimalsB: number,
  currentPrice: number,
): PriceRange {
  const rLow = rawPriceFromTick(lowerTick);
  const rHigh = rawPriceFromTick(upperTick);

  const candidates: Array<(p: number) => number> = [
    (p) => p * Math.pow(10, decimalsA - decimalsB),
    (p) => p * Math.pow(10, decimalsB - decimalsA),
    (p) => (1 / p) * Math.pow(10, decimalsA - decimalsB),
    (p) => (1 / p) * Math.pow(10, decimalsB - decimalsA),
  ];

  // 沒有可信 currentPrice 時，退回最常見的慣例
  if (!Number.isFinite(currentPrice) || currentPrice <= 0) {
    const a = candidates[0](rLow);
    const b = candidates[0](rHigh);
    return { priceLower: Math.min(a, b), priceUpper: Math.max(a, b) };
  }

  const logTarget = Math.log(currentPrice);
  let best: PriceRange | null = null;
  let bestScore = Infinity;

  for (const f of candidates) {
    const a = f(rLow);
    const b = f(rHigh);
    if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0 || b <= 0) continue;
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    const geomean = Math.sqrt(lo * hi);
    const score = Math.abs(Math.log(geomean) - logTarget);
    if (score < bestScore) {
      bestScore = score;
      best = { priceLower: lo, priceUpper: hi };
    }
  }

  return best ?? { priceLower: 0, priceUpper: 0 };
}
