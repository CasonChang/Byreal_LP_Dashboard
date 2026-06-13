/**
 * 把原始部位 + 池子詳情組合成可用的 PortfolioSnapshot（含區間健康度）。
 */

import { config } from './config.ts';
import { listPositions, getPoolDetail, type PoolDetail, type PoolMapFlat } from './byreal.ts';
import { ticksToPriceRange } from './tick.ts';
import type { PortfolioSnapshot, PositionMetric, RiskLevel } from './types.ts';

function riskFromDistance(inRange: boolean, nearestPct: number): RiskLevel {
  if (!inRange) return 'out';
  if (nearestPct < 2) return 'high';
  if (nearestPct < config.rangeWarnPct) return 'medium';
  return 'low';
}

export async function buildSnapshot(wallets: string[]): Promise<PortfolioSnapshot> {
  const positions: PositionMetric[] = [];

  // 收集所有錢包的 active 部位
  const rawAll: Array<{ raw: import('./types.ts').RawPosition; poolMap: Record<string, PoolMapFlat> }> = [];
  for (const wallet of wallets) {
    const { positions: raws, poolMap } = await listPositions(wallet, 0);
    for (const raw of raws) rawAll.push({ raw, poolMap });
  }

  // 預先抓取每個獨特池子的詳情（含目前價格）
  const uniquePools = [...new Set(rawAll.map((r) => r.raw.poolAddress))];
  const poolDetails = new Map<string, PoolDetail | null>();
  await Promise.all(
    uniquePools.map(async (addr) => {
      try {
        poolDetails.set(addr, await getPoolDetail(addr));
      } catch (e) {
        console.warn(`池子詳情抓取失敗 ${addr}:`, (e as Error).message);
        poolDetails.set(addr, null);
      }
    }),
  );

  for (const { raw, poolMap } of rawAll) {
    const detail = poolDetails.get(raw.poolAddress) || null;
    const pm = poolMap[raw.poolAddress];

    const symbolA = detail?.symbolA || pm?.symbolA || 'TokenA';
    const symbolB = detail?.symbolB || pm?.symbolB || 'TokenB';
    const decimalsA = detail?.decimalsA ?? pm?.decimalsA ?? 0;
    const decimalsB = detail?.decimalsB ?? pm?.decimalsB ?? 0;
    const currentPrice = detail?.currentPrice ?? 0;

    const { priceLower, priceUpper } = ticksToPriceRange(
      raw.lowerTick,
      raw.upperTick,
      decimalsA,
      decimalsB,
      currentPrice,
    );

    const inRange = currentPrice > 0 && currentPrice >= priceLower && currentPrice <= priceUpper;
    const distanceToLowerPct = currentPrice > 0 ? ((currentPrice - priceLower) / currentPrice) * 100 : 0;
    const distanceToUpperPct = currentPrice > 0 ? ((priceUpper - currentPrice) / currentPrice) * 100 : 0;
    const rangeWidthPct = currentPrice > 0 ? ((priceUpper - priceLower) / currentPrice) * 100 : 0;
    // 在區間內：取距最近邊界的百分比（正值）；出界：用負值表示偏離程度
    const nearestBoundaryPct = inRange
      ? Math.min(distanceToLowerPct, distanceToUpperPct)
      : -Math.min(Math.abs(distanceToLowerPct), Math.abs(distanceToUpperPct));

    positions.push({
      positionAddress: raw.positionAddress,
      nftMint: raw.nftMintAddress,
      poolAddress: raw.poolAddress,
      pair: symbolA && symbolB ? `${symbolA}/${symbolB}` : raw.poolAddress.slice(0, 6),
      symbolA,
      symbolB,
      status: raw.status === 0 ? 'active' : 'closed',
      lowerTick: raw.lowerTick,
      upperTick: raw.upperTick,
      priceLower,
      priceUpper,
      currentPrice,
      inRange,
      nearestBoundaryPct,
      distanceToLowerPct,
      distanceToUpperPct,
      rangeWidthPct,
      riskLevel: riskFromDistance(inRange, Math.abs(nearestBoundaryPct)),
      liquidityUsd: parseFloat(raw.liquidityUsd || '0'),
      earnedUsd: parseFloat(raw.earnedUsd || '0'),
      earnedPct: parseFloat(raw.earnedUsdPercent || '0') * 100,
      pnlUsd: parseFloat(raw.pnlUsd || '0'),
      pnlPct: parseFloat(raw.pnlUsdPercent || '0') * 100,
      // position/list 多半不回傳部位 APR，退回池子 24h 手續費 APR 作為年化參考
      apr: (() => {
        const posApr = parseFloat(raw.apr || '0') * 100;
        return posApr > 0 ? posApr : (detail?.feeApr ?? 0);
      })(),
      bonusUsd: parseFloat(raw.bonusUsd || '0'),
      poolTvlUsd: detail?.tvlUsd ?? 0,
      poolVolume24hUsd: detail?.volume24hUsd ?? 0,
      poolFeeApr: detail?.feeApr ?? 0,
    });
  }

  const totalLiquidity = sum(positions.map((p) => p.liquidityUsd));
  const totals = {
    liquidityUsd: totalLiquidity,
    earnedUsd: sum(positions.map((p) => p.earnedUsd)),
    bonusUsd: sum(positions.map((p) => p.bonusUsd)),
    pnlUsd: sum(positions.map((p) => p.pnlUsd)),
    positionCount: positions.length,
    activeCount: positions.filter((p) => p.status === 'active').length,
    inRangeCount: positions.filter((p) => p.inRange).length,
    // 以倉位金額加權的平均 APR
    weightedApr:
      totalLiquidity > 0
        ? sum(positions.map((p) => p.apr * p.liquidityUsd)) / totalLiquidity
        : 0,
  };

  return {
    capturedAt: new Date().toISOString(),
    wallets,
    totals,
    positions,
  };
}

function sum(arr: number[]): number {
  return arr.reduce((a, b) => a + b, 0);
}
