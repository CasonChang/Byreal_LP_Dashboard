/**
 * 抓取池子日 K 線並計算波動度，用於「區間建議」。
 * 端點：GET /byreal/api/dex/v2/kline/query-ui?poolAddress&tokenAddress&klineType=1d&startTime&endTime
 */

import { config } from './config.ts';

/** 取得近 days 天的日收盤價（uiPrice）。失敗時回傳空陣列（不影響主流程）。 */
export async function fetchDailyCloses(poolAddress: string, tokenAddress: string, days = 30): Promise<number[]> {
  if (!poolAddress || !tokenAddress) return [];
  const end = Math.floor(Date.now() / 1000);
  const start = end - days * 86400;
  const url = new URL(config.byrealApiUrl + '/byreal/api/dex/v2/kline/query-ui');
  url.searchParams.set('poolAddress', poolAddress);
  url.searchParams.set('tokenAddress', tokenAddress);
  url.searchParams.set('klineType', '1d');
  url.searchParams.set('startTime', String(start));
  url.searchParams.set('endTime', String(end));

  const res = await fetch(url.toString(), { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`kline ${res.status}`);
  const j: any = await res.json();
  const data: any[] = j?.result?.data || [];
  return data
    .map((k) => parseFloat(k.c ?? k.close ?? '0'))
    .filter((x) => Number.isFinite(x) && x > 0);
}

/** 由日收盤價算「日對數報酬的標準差」= 日波動度。資料不足回傳 0。 */
export function dailyVolatility(closes: number[]): number {
  if (closes.length < 4) return 0;
  const rets: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    if (closes[i - 1] > 0 && closes[i] > 0) rets.push(Math.log(closes[i] / closes[i - 1]));
  }
  if (rets.length < 3) return 0;
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const variance = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length - 1);
  return Math.sqrt(variance);
}

export interface RangeSuggestion {
  low: number;
  high: number;
  lowPct: number; // 相對現價（負值）
  upPct: number; // 相對現價（正值）
  stayProb: number; // 風格的名目「在區間內機率」估計
}

// 風格 → z（覆蓋幾倍「持有期波動」）與名目在內機率
const STYLES: Record<string, { z: number; prob: number }> = {
  conservative: { z: 2.0, prob: 85 },
  balanced: { z: 1.5, prob: 75 },
  aggressive: { z: 1.0, prob: 65 },
};
const HORIZON_DAYS = 7; // 預估持有/重置週期（接近實測平均持倉）
// 不對稱：下限拉寬、上限收窄（超下限才是真痛點 → 給下方更多緩衝）
const LOWER_MULT = 1.3;
const UPPER_MULT = 0.85;

/** 依現價、日波動度、風格給出建議區間（含不對稱）。 */
export function suggestRange(currentPrice: number, sigmaDaily: number, style: keyof typeof STYLES): RangeSuggestion | null {
  if (!(currentPrice > 0) || !(sigmaDaily > 0)) return null;
  const { z, prob } = STYLES[style];
  const move = sigmaDaily * Math.sqrt(HORIZON_DAYS); // 持有期內的波動幅度（比例）
  const lowPct = -(z * move * LOWER_MULT);
  const upPct = z * move * UPPER_MULT;
  return {
    low: currentPrice * (1 + lowPct),
    high: currentPrice * (1 + upPct),
    lowPct: lowPct * 100,
    upPct: upPct * 100,
    stayProb: prob,
  };
}

export function allSuggestions(currentPrice: number, sigmaDaily: number) {
  const c = suggestRange(currentPrice, sigmaDaily, 'conservative');
  const b = suggestRange(currentPrice, sigmaDaily, 'balanced');
  const a = suggestRange(currentPrice, sigmaDaily, 'aggressive');
  if (!c || !b || !a) return undefined;
  return { conservative: c, balanced: b, aggressive: a };
}
