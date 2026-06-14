/**
 * 產生示範用的 docs/data/latest.json 與 history.json，
 * 讓 GitHub Pages 在第一次真實執行前就有畫面可看，也方便本地預覽前端。
 * 執行：npm run mock
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PortfolioSnapshot, PositionMetric, LpEvent } from './types.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolve(__dirname, '..', 'docs', 'data');

function pos(partial: Partial<PositionMetric>): PositionMetric {
  return {
    positionAddress: 'demoPos' + Math.random().toString(36).slice(2, 8),
    nftMint: 'demoNft' + Math.random().toString(36).slice(2, 8),
    poolAddress: 'demoPool' + Math.random().toString(36).slice(2, 8),
    pair: 'SOL/USDC',
    symbolA: 'SOL',
    symbolB: 'USDC',
    status: 'active',
    lowerTick: -1000,
    upperTick: 1000,
    priceLower: 140,
    priceUpper: 165,
    currentPrice: 152,
    inRange: true,
    nearestBoundaryPct: 7.9,
    distanceToLowerPct: 7.9,
    distanceToUpperPct: 8.6,
    rangeWidthPct: 16.5,
    riskLevel: 'medium',
    liquidityUsd: 5000,
    earnedUsd: 42.5,
    earnedPct: 0.85,
    unclaimedFeeUsd: 18.3,
    unclaimedTokens: [
      { symbol: 'USDC', amount: 9.1, usd: 9.1 },
      { symbol: 'SOL', amount: 0.06, usd: 9.2 },
    ],
    claimedFeeUsd: 24.2,
    depositUsd: 5100,
    realApr: 31.5,
    totalReturnUsd: 4.5,
    totalReturnApr: 3.2,
    ageDays: 12,
    pnlUsd: -38,
    pnlPct: -0.76,
    apr: 62.4,
    bonusUsd: 8.2,
    poolTvlUsd: 1_200_000,
    poolVolume24hUsd: 3_400_000,
    poolFeeApr: 62.4,
    ...partial,
  };
}

const positions: PositionMetric[] = [
  pos({ pair: 'SOL/USDC', symbolA: 'SOL', symbolB: 'USDC', currentPrice: 152, priceLower: 140, priceUpper: 165, inRange: true, riskLevel: 'low', nearestBoundaryPct: 7.9, liquidityUsd: 5200, earnedUsd: 42.5, apr: 62.4 }),
  pos({ pair: 'JUP/SOL', symbolA: 'JUP', symbolB: 'SOL', currentPrice: 0.0072, priceLower: 0.0071, priceUpper: 0.0095, inRange: true, riskLevel: 'high', nearestBoundaryPct: 1.4, distanceToLowerPct: 1.4, distanceToUpperPct: 24, liquidityUsd: 3100, earnedUsd: 18.9, apr: 88.1, bonusUsd: 0 }),
  pos({ pair: 'WIF/USDC', symbolA: 'WIF', symbolB: 'USDC', currentPrice: 2.35, priceLower: 2.4, priceUpper: 3.1, inRange: false, riskLevel: 'out', nearestBoundaryPct: -2.1, distanceToLowerPct: -2.1, distanceToUpperPct: 24, liquidityUsd: 1800, earnedUsd: 5.1, apr: 0, pnlUsd: -120 }),
];

const totalLiq = positions.reduce((a, p) => a + p.liquidityUsd, 0);
const snap: PortfolioSnapshot = {
  capturedAt: new Date().toISOString(),
  wallets: ['FPa1NnUpG89LpHLnKAPrNrxksVZWrjcpNAqnXiwpoqYn'],
  totals: {
    liquidityUsd: totalLiq,
    earnedUsd: positions.reduce((a, p) => a + p.earnedUsd, 0),
    unclaimedFeeUsd: positions.reduce((a, p) => a + p.unclaimedFeeUsd, 0),
    claimedFeeUsd: positions.reduce((a, p) => a + p.claimedFeeUsd, 0),
    depositUsd: positions.reduce((a, p) => a + p.depositUsd, 0),
    bonusUsd: positions.reduce((a, p) => a + p.bonusUsd, 0),
    pnlUsd: positions.reduce((a, p) => a + p.pnlUsd, 0),
    positionCount: positions.length,
    activeCount: positions.length,
    inRangeCount: positions.filter((p) => p.inRange).length,
    weightedApr: positions.reduce((a, p) => a + p.apr * p.liquidityUsd, 0) / totalLiq,
    realApr: positions.reduce((a, p) => a + p.realApr * p.depositUsd, 0) / positions.reduce((a, p) => a + p.depositUsd, 0),
    totalReturnApr: positions.reduce((a, p) => a + p.totalReturnApr * p.depositUsd, 0) / positions.reduce((a, p) => a + p.depositUsd, 0),
  },
  positions,
};

const equity = Array.from({ length: 30 }, (_, i) => {
  const date = new Date(Date.now() - (29 - i) * 86400_000).toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' });
  return {
    date,
    liquidityUsd: 9000 + Math.round(Math.sin(i / 3) * 600 + i * 30),
    earnedUsd: Math.round((i + 1) * 4.2 * 100) / 100,
    pnlUsd: Math.round((Math.sin(i / 4) * 150 - 40) * 100) / 100,
    weightedApr: Math.round((60 + Math.sin(i / 2) * 15) * 10) / 10,
  };
});

const events: LpEvent[] = [
  { type: 'fee_claim', occurredAt: new Date(Date.now() - 3 * 3600_000).toISOString(), positionAddress: 'demo', pair: 'SOL/USDC', message: '💰 領取手續費 SOL/USDC｜約 $38.20', detail: { claimedUsd: 38.2 } },
  { type: 'range_warning', occurredAt: new Date(Date.now() - 8 * 3600_000).toISOString(), positionAddress: 'demo', pair: 'JUP/SOL', message: '⚠️ JUP/SOL 快出界！距最近邊界僅 1.4%', detail: {} },
  { type: 'out_of_range', occurredAt: new Date(Date.now() - 20 * 3600_000).toISOString(), positionAddress: 'demo', pair: 'WIF/USDC', message: '🚨 WIF/USDC 已出界！', detail: {} },
  { type: 'rebalance', occurredAt: new Date(Date.now() - 36 * 3600_000).toISOString(), positionAddress: 'demo', pair: 'SOL/USDC', message: '🔄 調倉 SOL/USDC｜新區間 140~165', detail: {} },
];

const history = { updatedAt: snap.capturedAt, equity, events };

await mkdir(DATA_DIR, { recursive: true });
await writeFile(resolve(DATA_DIR, 'latest.json'), JSON.stringify(snap, null, 2));
await writeFile(resolve(DATA_DIR, 'history.json'), JSON.stringify(history, null, 2));
console.log('已寫入示範資料到 docs/data/ (latest.json, history.json)');
