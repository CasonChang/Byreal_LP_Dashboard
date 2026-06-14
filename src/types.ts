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
  apr?: string | null;
  bonusUsd?: string;
  /** 未領取的手續費（每個 token 一筆，amount × price = USD） */
  unclaimedData?: Array<{ tokenSymbol?: string; amount?: string; price?: string; type?: number }>;
  /** 開倉至今投入的本金（USD） */
  totalDeposit?: string;
  /** 已領取的手續費 + 獎勵累計（USD） */
  totalClaimedFeesRewards?: string;
  /** 部位存在時間（毫秒） */
  positionAgeMs?: number;
  openTime?: number;
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
  earnedUsd: number; // 累計手續費（lifetime）
  earnedPct: number;
  unclaimedFeeUsd: number; // 目前未領取手續費（可領）
  /** 未領手續費的每種 token 明細（顆數 + USD） */
  unclaimedTokens: Array<{ symbol: string; amount: number; usd: number }>;
  claimedFeeUsd: number; // 已領取手續費（= 累計 − 未領）
  depositUsd: number; // 投入本金
  realApr: number; // 自開倉的實際年化（只含手續費：累計手續費 / 本金 / 持倉時間）
  totalReturnUsd: number; // 總報酬 = 累計手續費 + 持倉損益
  totalReturnApr: number; // 總報酬年化（含手續費+損益）
  ageDays: number; // 部位存在天數
  pnlUsd: number;
  pnlPct: number;
  apr: number; // 池子預估 APR（fallback）
  bonusUsd: number;

  poolTvlUsd: number;
  poolVolume24hUsd: number;
  poolFeeApr: number;
}

export type RiskLevel = 'low' | 'medium' | 'high' | 'out';

/** 已關閉部位的歷史紀錄列 */
export interface ClosedPositionRow {
  positionAddress: string;
  pair: string;
  depositUsd: number;
  earnedUsd: number;
  pnlUsd: number;
  ageDays: number;
  openTime: number;
  feeApr: number; // 此部位生命期內 (手續費/本金) 年化
  totalReturnApr: number; // (手續費+損益)/本金 年化
}

/** 策略級總覽：把「現有 + 已關閉」所有部位以「資金×時間」加權彙整 */
export interface StrategySummary {
  lifetimeFeesUsd: number; // 累計手續費（含已關閉）
  lifetimePnlUsd: number; // 累計損益（含已關閉）
  totalDepositEverUsd: number; // 歷來總投入本金（gross：開關倉會重複計入，僅供參考）
  currentDepositUsd: number; // 目前投入本金（現有部位本金合計）
  depositYears: number; // Σ(本金 × 持倉年數)，年化的分母
  feeApr: number; // 策略手續費年化 = 累計手續費 / depositYears
  totalReturnApr: number; // 策略總報酬年化 = (手續費+損益) / depositYears
  realizedFeesUsd: number; // 已關閉部位的手續費
  unrealizedFeesUsd: number; // 現有部位的累計手續費
  closedCount: number;
  activeCount: number;
  avgHoldDays: number; // 已關閉部位的平均持倉天數
}

export interface PortfolioSnapshot {
  capturedAt: string; // ISO
  wallets: string[];
  totals: {
    liquidityUsd: number;
    earnedUsd: number; // 累計手續費
    unclaimedFeeUsd: number; // 未領手續費
    claimedFeeUsd: number; // 已領手續費
    depositUsd: number; // 總投入本金
    bonusUsd: number;
    pnlUsd: number;
    positionCount: number;
    activeCount: number;
    inRangeCount: number;
    weightedApr: number; // 加權池子預估 APR
    realApr: number; // 整體實際年化（只含手續費：累計手續費 / 本金 年化）
    totalReturnApr: number; // 整體總報酬年化（含手續費+損益）
  };
  positions: PositionMetric[];
  strategy?: StrategySummary; // 策略級總覽（含已關閉部位）
  closedPositions?: ClosedPositionRow[]; // 已關閉部位歷史
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
