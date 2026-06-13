/**
 * 共用型別。對應 Byreal dex/v2 API 回傳結構。
 */

/** Byreal API 通用包裝 */
export interface ByrealEnvelope<T> {
  retCode: number;
  retMsg: string;
  result: {
    success: boolean;
    data: T;
  };
}

/** position/list 回傳的單筆原始資料 */
export interface RawPosition {
  poolAddress: string;
  positionAddress: string;
  nftMintAddress: string;
  upperTick: number;
  lowerTick: number;
  status: number; // 0=active, 1=closed
  liquidityUsd?: string;
  earnedUsd?: string;
  earnedUsdPercent?: string;
  pnlUsd?: string;
  pnlUsdPercent?: string;
  apr?: string;
  bonusUsd?: string;
}

export interface PoolMapEntry {
  mintA?: { symbol?: string; decimals?: number; address?: string };
  mintB?: { symbol?: string; decimals?: number; address?: string };
}

export interface RawPositionListData {
  total: number;
  positions?: RawPosition[];
  records?: RawPosition[];
  poolMap?: Record<string, PoolMapEntry>;
}

/** pools/details 回傳（節錄我們用得到的欄位） */
export interface RawPoolDetail {
  poolId?: string;
  id?: string;
  price?: number | string; // 目前價格 tokenA/tokenB
  tvl?: number | string;
  day?: { volume?: number | string; apr?: number | string; feeApr?: number | string };
  week?: { volume?: number | string };
  feeRate?: number | string;
  mintA?: { symbol?: string; decimals?: number; address?: string };
  mintB?: { symbol?: string; decimals?: number; address?: string };
  [k: string]: unknown;
}

/** 經過運算後、給儀表板/推播用的部位資料 */
export interface PositionMetric {
  positionAddress: string;
  nftMint: string;
  poolAddress: string;
  pair: string;
  symbolA: string;
  symbolB: string;
  status: 'active' | 'closed';

  lowerTick: number;
  upperTick: number;
  priceLower: number;
  priceUpper: number;
  currentPrice: number;

  inRange: boolean;
  /** 距離最近邊界的百分比（正=還在內，負=已出界） */
  nearestBoundaryPct: number;
  distanceToLowerPct: number;
  distanceToUpperPct: number;
  rangeWidthPct: number;
  /** low | medium | high | out */
  riskLevel: RiskLevel;

  liquidityUsd: number;
  earnedUsd: number;
  earnedPct: number;
  pnlUsd: number;
  pnlPct: number;
  apr: number;
  bonusUsd: number;

  poolTvlUsd: number;
  poolVolume24hUsd: number;
  poolFeeApr: number;
}

export type RiskLevel = 'low' | 'medium' | 'high' | 'out';

export interface PortfolioSnapshot {
  capturedAt: string; // ISO
  wallets: string[];
  totals: {
    liquidityUsd: number;
    earnedUsd: number;
    bonusUsd: number;
    pnlUsd: number;
    positionCount: number;
    activeCount: number;
    inRangeCount: number;
    weightedApr: number;
  };
  positions: PositionMetric[];
}

export type EventType =
  | 'open'
  | 'close'
  | 'fee_claim'
  | 'add_liquidity'
  | 'remove_liquidity'
  | 'rebalance'
  | 'out_of_range'
  | 'range_warning'
  | 'back_in_range';

export interface LpEvent {
  type: EventType;
  occurredAt: string;
  positionAddress: string;
  pair: string;
  message: string;
  detail: Record<string, unknown>;
}
