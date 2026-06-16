/**
 * 把原始部位 + 池子詳情組合成可用的 PortfolioSnapshot（含區間健康度）。
 */

import { config } from './config.ts';
import { listPositions, getPoolDetail, type PoolDetail, type PoolMapFlat } from './byreal.ts';
import { ticksToPriceRange } from './tick.ts';
import { fetchDailyCloses, dailyVolatility, allSuggestions } from './kline.ts';
import type { PortfolioSnapshot, PositionMetric, RiskLevel, ClosedPositionRow, StrategySummary } from './types.ts';

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
  // 每個池子的 tokenA mint（用來查 K 線）
  const poolTokenA = new Map<string, string>();
  for (const { raw, poolMap } of rawAll) {
    const a = poolMap[raw.poolAddress]?.addressA;
    if (a && !poolTokenA.has(raw.poolAddress)) poolTokenA.set(raw.poolAddress, a);
  }
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

  // 抓 K 線算波動度（給區間建議用）；失敗不影響主流程
  const poolSigma = new Map<string, number>();
  await Promise.all(
    uniquePools.map(async (addr) => {
      try {
        const tokenA = poolTokenA.get(addr) || '';
        const closes = await fetchDailyCloses(addr, tokenA, 30);
        poolSigma.set(addr, dailyVolatility(closes));
      } catch (e) {
        console.warn(`K 線抓取失敗 ${addr}:`, (e as Error).message);
        poolSigma.set(addr, 0);
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

    // 未領手續費（精確）：unclaimedData 各 token amount × price 加總，並保留每 token 明細
    const unclaimedTokens = (raw.unclaimedData || []).map((t) => ({
      symbol: t.tokenSymbol || '',
      amount: parseFloat(t.amount || '0'),
      usd: parseFloat(t.amount || '0') * parseFloat(t.price || '0'),
    }));
    const unclaimedFee = unclaimedTokens.reduce((s, t) => s + t.usd, 0);
    const earnedUsdVal = parseFloat(raw.earnedUsd || '0');
    const pnlUsdVal = parseFloat(raw.pnlUsd || '0');
    const depositUsd = parseFloat(raw.totalDeposit || '0');
    // 部位存在時間 → 年化
    const ageMs = raw.positionAgeMs || (raw.openTime ? Date.now() - raw.openTime : 0);
    const ageDays = ageMs > 0 ? ageMs / 86_400_000 : 0;
    const YEAR_MS = 365 * 86_400_000;
    const annualize = (value: number) =>
      ageMs > 0 && depositUsd > 0 ? (value / depositUsd) * (YEAR_MS / ageMs) * 100 : 0;
    const realApr = annualize(earnedUsdVal); // 只含手續費
    // ⚠️ Byreal 的 pnlUsd 是「總報酬(已含手續費)」= (倉位現值−本金) + 手續費
    const totalReturnUsd = pnlUsdVal; // 總報酬(含手續費) = Byreal pnlUsd
    const pricePnlUsd = pnlUsdVal - earnedUsdVal; // 純價格/IL 損益(不含手續費) = 倉位現值 − 本金
    const totalReturnApr = annualize(totalReturnUsd);

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
      unclaimedFeeUsd: unclaimedFee,
      unclaimedTokens,
      claimedFeeUsd: Math.max(0, earnedUsdVal - unclaimedFee),
      depositUsd,
      realApr,
      totalReturnUsd,
      totalReturnApr,
      ageDays,
      pnlUsd: pricePnlUsd, // 損益(不含手續費)
      pnlPct: depositUsd > 0 ? (pricePnlUsd / depositUsd) * 100 : 0,
      // position/list 的部位 APR 多半為 null，退回池子 24h 手續費 APR 作為預估
      apr: (() => {
        const posApr = parseFloat(raw.apr || '0') * 100;
        return posApr > 0 ? posApr : (detail?.feeApr ?? 0);
      })(),
      bonusUsd: parseFloat(raw.bonusUsd || '0'),
      poolTvlUsd: detail?.tvlUsd ?? 0,
      poolVolume24hUsd: detail?.volume24hUsd ?? 0,
      poolFeeApr: detail?.feeApr ?? 0,
      volatilityDaily: poolSigma.get(raw.poolAddress) ?? 0,
      suggestions:
        currentPrice > 0 && (poolSigma.get(raw.poolAddress) ?? 0) > 0
          ? allSuggestions(currentPrice, poolSigma.get(raw.poolAddress)!)
          : undefined,
    });
  }

  const totalLiquidity = sum(positions.map((p) => p.liquidityUsd));
  const totalDeposit = sum(positions.map((p) => p.depositUsd));
  const totalEarned = sum(positions.map((p) => p.earnedUsd));
  // 整體年化：以本金加權各部位的年化
  const realApr =
    totalDeposit > 0 ? sum(positions.map((p) => p.realApr * p.depositUsd)) / totalDeposit : 0;
  const totalReturnApr =
    totalDeposit > 0 ? sum(positions.map((p) => p.totalReturnApr * p.depositUsd)) / totalDeposit : 0;
  const totals = {
    liquidityUsd: totalLiquidity,
    earnedUsd: totalEarned,
    unclaimedFeeUsd: sum(positions.map((p) => p.unclaimedFeeUsd)),
    claimedFeeUsd: sum(positions.map((p) => p.claimedFeeUsd)),
    depositUsd: totalDeposit,
    bonusUsd: sum(positions.map((p) => p.bonusUsd)),
    pnlUsd: sum(positions.map((p) => p.pnlUsd)),
    positionCount: positions.length,
    activeCount: positions.filter((p) => p.status === 'active').length,
    inRangeCount: positions.filter((p) => p.inRange).length,
    weightedApr:
      totalLiquidity > 0
        ? sum(positions.map((p) => p.apr * p.liquidityUsd)) / totalLiquidity
        : 0,
    realApr,
    totalReturnApr,
  };

  // ===== 策略級總覽（含已關閉部位）=====
  const closedPositions: ClosedPositionRow[] = [];
  for (const wallet of wallets) {
    const { positions: closedRaw, poolMap } = await listPositions(wallet, 1);
    for (const raw of closedRaw) {
      const pm = poolMap[raw.poolAddress];
      const pair = pm?.symbolA && pm?.symbolB ? `${pm.symbolA}/${pm.symbolB}` : raw.poolAddress.slice(0, 6);
      const dUsd = parseFloat(raw.totalDeposit || '0');
      const eUsd = parseFloat(raw.earnedUsd || '0');
      const plUsd = parseFloat(raw.pnlUsd || '0'); // Byreal pnl = 總報酬(已含手續費)
      const pricePnl = plUsd - eUsd; // 損益(不含手續費)
      const ageMs = raw.positionAgeMs || 0;
      const ageDays = ageMs > 0 ? ageMs / 86_400_000 : 0;
      const annualFactor = ageMs > 0 ? (365 * 86_400_000) / ageMs : 0;
      closedPositions.push({
        positionAddress: raw.positionAddress,
        pair,
        depositUsd: dUsd,
        earnedUsd: eUsd,
        pnlUsd: pricePnl,
        ageDays,
        openTime: raw.openTime || 0,
        feeApr: dUsd > 0 && annualFactor > 0 ? (eUsd / dUsd) * annualFactor * 100 : 0,
        totalReturnApr: dUsd > 0 && annualFactor > 0 ? (plUsd / dUsd) * annualFactor * 100 : 0,
      });
    }
  }
  closedPositions.sort((a, b) => b.openTime - a.openTime);

  // 資金 × 時間 加權（自動處理不同大小、不同持倉時間、開關倉）
  const yearsOf = (days: number) => days / 365;
  const depositYears =
    sum(positions.map((p) => p.depositUsd * yearsOf(p.ageDays))) +
    sum(closedPositions.map((r) => r.depositUsd * yearsOf(r.ageDays)));
  const realizedFees = sum(closedPositions.map((r) => r.earnedUsd));
  const unrealizedFees = sum(positions.map((p) => p.earnedUsd));
  const lifetimeFees = realizedFees + unrealizedFees;
  const lifetimePnl = sum(positions.map((p) => p.pnlUsd)) + sum(closedPositions.map((r) => r.pnlUsd));
  const totalDepositEver =
    sum(positions.map((p) => p.depositUsd)) + sum(closedPositions.map((r) => r.depositUsd));

  const strategy: StrategySummary = {
    lifetimeFeesUsd: lifetimeFees,
    lifetimePnlUsd: lifetimePnl,
    totalDepositEverUsd: totalDepositEver,
    currentDepositUsd: sum(positions.map((p) => p.depositUsd)),
    depositYears,
    feeApr: depositYears > 0 ? (lifetimeFees / depositYears) * 100 : 0,
    totalReturnApr: depositYears > 0 ? ((lifetimeFees + lifetimePnl) / depositYears) * 100 : 0,
    realizedFeesUsd: realizedFees,
    unrealizedFeesUsd: unrealizedFees,
    closedCount: closedPositions.length,
    activeCount: positions.length,
    avgHoldDays: closedPositions.length
      ? sum(closedPositions.map((r) => r.ageDays)) / closedPositions.length
      : 0,
  };

  return {
    capturedAt: new Date().toISOString(),
    wallets,
    totals,
    positions,
    strategy,
    closedPositions,
  };
}

function sum(arr: number[]): number {
  return arr.reduce((a, b) => a + b, 0);
}
