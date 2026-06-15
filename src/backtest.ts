/**
 * 回測引擎（在 GitHub Actions 上跑，可連 Byreal）。
 * 用各池近 ~180 天日 K 線，模擬不同「區間寬度 / 持有期 / 是否波動率擇時」的：
 *   淨報酬、手續費、無常損失(IL)、在區間內時間比例、調倉次數，並與 HODL 比較。
 *
 * 重要假設（誠實揭露）：
 * - CLMM 部位價值、IL 用標準公式精算（完全來自價格）。
 * - 手續費無歷史流動性分布，故用「你該池目前的實際手續費年化 + 區間寬度」當錨點，
 *   依『費率 ∝ 1/區間寬度（在區間內時）』外推，再乘當日成交量/平均量。屬近似。
 * - regime 濾網為「反應式」：波動度升高後才離場，非預測，且假設當日完美成交（偏樂觀）。
 */

import { config, assertConfig } from './config.ts';
import { listPositions, getPoolDetail } from './byreal.ts';
import { ticksToPriceRange } from './tick.ts';
import { fetchDailyBars, dailyVolatility, rollingVolatility } from './kline.ts';

const CAPITAL = 10000;

function lFromCapital(C: number, p: number, pa: number, pb: number): number {
  const sp = Math.sqrt(p), spa = Math.sqrt(pa), spb = Math.sqrt(pb);
  const denom = 2 * sp - p / spb - spa; // value per unit L when in range
  return denom > 0 ? C / denom : 0;
}
function clmmValue(L: number, p: number, pa: number, pb: number): number {
  const sp = Math.sqrt(p), spa = Math.sqrt(pa), spb = Math.sqrt(pb);
  let x = 0, y = 0;
  if (p <= pa) { x = L * (1 / spa - 1 / spb); }
  else if (p >= pb) { y = L * (spb - spa); }
  else { x = L * (1 / sp - 1 / spb); y = L * (sp - spa); }
  return x * p + y;
}
function amountsAt(L: number, p: number, pa: number, pb: number): { x: number; y: number } {
  const sp = Math.sqrt(p), spa = Math.sqrt(pa), spb = Math.sqrt(pb);
  if (p <= pa) return { x: L * (1 / spa - 1 / spb), y: 0 };
  if (p >= pb) return { x: 0, y: L * (spb - spa) };
  return { x: L * (1 / sp - 1 / spb), y: L * (sp - spa) };
}

interface SimResult { label: string; net: number; fees: number; il: number; inRange: number; rebal: number; }

interface SimOpts {
  lowPct: number; upPct: number;
  rebalanceOnBreach: boolean;
  regime?: boolean;
}

function simulate(
  bars: Array<{ close: number; volume: number }>,
  startIdx: number,
  label: string,
  o: SimOpts,
  feeAprAtRefWidth: number, // 小數
  refWidth: number,
  avgVol: number,
  rollVol: number[],
  volThresh: number,
): SimResult {
  const width = o.upPct - o.lowPct; // 區間寬度（比例）
  const feeAprInRange = (w: number) => Math.min(3, (feeAprAtRefWidth * refWidth) / Math.max(0.02, w)); // cap 300%
  const p0 = bars[startIdx].close;
  let pa = p0 * (1 + o.lowPct), pb = p0 * (1 + o.upPct);
  let L = lFromCapital(CAPITAL, p0, pa, pb);
  const a0 = amountsAt(L, p0, pa, pb);
  let principal = CAPITAL; // 目前部署中的本金（regime/rebalance 時更新）
  let fees = 0;
  let inRangeDays = 0, totalDays = 0, rebal = 0;
  let state: 'LP' | 'USDC' = 'LP';

  for (let t = startIdx + 1; t < bars.length; t++) {
    const p = bars[t].close;
    totalDays++;

    if (o.regime) {
      const hi = rollVol[t] > volThresh;
      if (state === 'LP' && hi) { principal = clmmValue(L, p, pa, pb); state = 'USDC'; continue; }
      if (state === 'USDC') {
        if (!hi) { pa = p * (1 + o.lowPct); pb = p * (1 + o.upPct); L = lFromCapital(principal, p, pa, pb); state = 'LP'; }
        else continue;
      }
    }

    const inRange = p >= pa && p <= pb;
    if (inRange) {
      inRangeDays++;
      const base = clmmValue(L, p, pa, pb);
      fees += (base * feeAprInRange(width)) / 365 * (avgVol > 0 ? bars[t].volume / avgVol : 1);
    } else if (o.rebalanceOnBreach) {
      principal = clmmValue(L, p, pa, pb);
      pa = p * (1 + o.lowPct); pb = p * (1 + o.upPct);
      L = lFromCapital(principal, p, pa, pb); rebal++;
    }
  }

  const pEnd = bars[bars.length - 1].close;
  const endPos = state === 'USDC' ? principal : clmmValue(L, pEnd, pa, pb);
  const endValue = endPos + fees;
  const hodl = a0.x * pEnd + a0.y; // 持有當初投入的兩種代幣
  return {
    label,
    net: (endValue / CAPITAL - 1) * 100,
    fees: (fees / CAPITAL) * 100,
    il: ((endPos - hodl) / CAPITAL) * 100, // 部位(不含費) vs HODL
    inRange: totalDays > 0 ? (inRangeDays / totalDays) * 100 : 0,
    rebal,
  };
}

async function main() {
  assertConfig({});
  const wallet = config.wallets[0];
  const { positions, poolMap } = await listPositions(wallet, 0);
  const seen = new Set<string>();

  for (const raw of positions) {
    if (seen.has(raw.poolAddress)) continue;
    seen.add(raw.poolAddress);
    const pm = poolMap[raw.poolAddress];
    const detail = await getPoolDetail(raw.poolAddress).catch(() => null);
    const decA = detail?.decimalsA ?? pm?.decimalsA ?? 0;
    const decB = detail?.decimalsB ?? pm?.decimalsB ?? 0;
    const cur = detail?.currentPrice ?? 0;
    const pair = `${detail?.symbolA || pm?.symbolA}/${detail?.symbolB || pm?.symbolB}`;

    const bars = await fetchDailyBars(raw.poolAddress, pm?.addressA || '', 180).catch(() => []);
    if (bars.length < 30) { console.log(`\n=== ${pair} === K線不足(${bars.length})，略過`); continue; }
    const closes = bars.map((b) => b.close);
    const sigma = dailyVolatility(closes);
    const avgVol = bars.reduce((a, b) => a + b.volume, 0) / bars.length;
    const rollVol = rollingVolatility(closes, 7);
    const sortedVol = [...rollVol].filter((v) => v > 0).sort((a, b) => a - b);
    const volThresh = sortedVol[Math.floor(sortedVol.length * 0.66)] || Infinity; // 上 1/3 視為高波動

    // 校準錨點：用該部位目前實際手續費年化 + 區間寬度
    const { priceLower, priceUpper } = ticksToPriceRange(raw.lowerTick, raw.upperTick, decA, decB, cur);
    const refWidth = cur > 0 ? (priceUpper - priceLower) / cur : 0.2;
    const ageMs = raw.positionAgeMs || 0;
    const refAprPos = ageMs > 86_400_000 && parseFloat(raw.totalDeposit || '0') > 0
      ? (parseFloat(raw.earnedUsd || '0') / parseFloat(raw.totalDeposit || '0')) * (365 * 86_400_000 / ageMs)
      : (detail?.feeApr ?? 0) / 100;

    const start = 8; // 讓滾動波動度先暖機
    const band = (z: number, hdays: number) => {
      const move = sigma * Math.sqrt(hdays);
      return { low: -(z * move * 1.3), up: z * move * 0.85 };
    };
    const b1m = band(1.5, 21), b3m = band(1.5, 63), b1w = band(1.0, 5);

    const results: SimResult[] = [
      simulate(bars, start, '1月-平衡(持有)', { lowPct: b1m.low, upPct: b1m.up, rebalanceOnBreach: true }, refAprPos, refWidth, avgVol, rollVol, volThresh),
      simulate(bars, start, '3月-平衡(持有)', { lowPct: b3m.low, upPct: b3m.up, rebalanceOnBreach: true }, refAprPos, refWidth, avgVol, rollVol, volThresh),
      simulate(bars, start, '1週-積極(常調倉)', { lowPct: b1w.low, upPct: b1w.up, rebalanceOnBreach: true }, refAprPos, refWidth, avgVol, rollVol, volThresh),
      simulate(bars, start, '1月+波動率擇時', { lowPct: b1m.low, upPct: b1m.up, rebalanceOnBreach: true, regime: true }, refAprPos, refWidth, avgVol, rollVol, volThresh),
    ];
    // HODL 基準
    const pEnd = closes[closes.length - 1], pS = closes[start];
    const hodlNet = (pEnd / pS - 1) * 100 * 0.5; // 50% 在幣、50% 在 U（粗略基準）

    console.log(`\n=== ${pair} ===  σ日=${(sigma * 100).toFixed(2)}%  錨點(寬${(refWidth * 100).toFixed(0)}%→年化${(refAprPos * 100).toFixed(0)}%)  期間${closes.length}天  期間漲跌=${((pEnd / pS - 1) * 100).toFixed(1)}%`);
    console.log('策略                淨報酬%   手續費%    IL%   在內%  調倉');
    for (const r of results) {
      console.log(
        `${r.label.padEnd(18)} ${r.net.toFixed(1).padStart(7)} ${r.fees.toFixed(1).padStart(8)} ${r.il.toFixed(1).padStart(7)} ${r.inRange.toFixed(0).padStart(6)} ${String(r.rebal).padStart(5)}`,
      );
    }
    console.log(`(基準) HODL 50/50      ${hodlNet.toFixed(1).padStart(7)}`);
  }
}

main().catch((e) => { console.error('[backtest] 失敗:', e); process.exit(1); });
