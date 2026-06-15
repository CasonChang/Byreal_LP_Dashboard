/**
 * 回測引擎（在 GitHub Actions 上跑）。
 * 為了涵蓋「一輪牛熊」，對應的 xStocks 改用底層美股的多年歷史（Stooq 免費日線，含 2022 熊市）；
 * 找不到底層的（如 SPCX）退回 Byreal 近 180 天 K 線。
 *
 * 區間採「自適應」：每次開倉用當下 30 日波動度 σ 設寬度（z×σ×√持有天數，下限×1.3、上限×0.85）。
 *
 * 假設揭露：CLMM 部位價值 / IL 用標準公式精算（純價格）。手續費無歷史流動性分布，
 * 以「你該池目前實際手續費年化 + 區間寬度」為錨點，依『費率 ∝ 1/區間寬度』外推，再乘當日量/均量。屬近似。
 */

import { config, assertConfig } from './config.ts';
import { listPositions, getPoolDetail } from './byreal.ts';
import { ticksToPriceRange } from './tick.ts';
import { fetchDailyBars, rollingVolatility } from './kline.ts';

const CAPITAL = 10000;
// xStock 代號 → 底層美股代號（Yahoo Finance）
const YHOO: Record<string, string> = { QQQx: 'QQQ', TSLAx: 'TSLA', NVDAx: 'NVDA', AAPLx: 'AAPL', MSFTx: 'MSFT', GOOGLx: 'GOOGL', AMZNx: 'AMZN', METAx: 'META', SPYx: 'SPY' };

interface Bar { date: string; close: number; volume: number; }

async function fetchYahoo(sym: string): Promise<Bar[]> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${sym}?range=5y&interval=1d`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120 Safari/537.36' } });
  if (!res.ok) throw new Error(`yahoo ${res.status}`);
  const j: any = await res.json();
  const r = j?.chart?.result?.[0];
  const ts: number[] = r?.timestamp || [];
  const q = r?.indicators?.quote?.[0] || {};
  const closes: number[] = q.close || [];
  const vols: number[] = q.volume || [];
  const bars: Bar[] = [];
  for (let i = 0; i < ts.length; i++) {
    const c = closes[i];
    if (c && c > 0) bars.push({ date: new Date(ts[i] * 1000).toISOString().slice(0, 10), close: c, volume: vols[i] || 0 });
  }
  return bars;
}

function lFromCapital(C: number, p: number, pa: number, pb: number): number {
  const sp = Math.sqrt(p), spa = Math.sqrt(pa), spb = Math.sqrt(pb);
  const denom = 2 * sp - p / spb - spa;
  return denom > 0 ? C / denom : 0;
}
function clmmValue(L: number, p: number, pa: number, pb: number): number {
  const sp = Math.sqrt(p), spa = Math.sqrt(pa), spb = Math.sqrt(pb);
  let x = 0, y = 0;
  if (p <= pa) x = L * (1 / spa - 1 / spb);
  else if (p >= pb) y = L * (spb - spa);
  else { x = L * (1 / sp - 1 / spb); y = L * (sp - spa); }
  return x * p + y;
}
function amountsAt(L: number, p: number, pa: number, pb: number): { x: number; y: number } {
  const sp = Math.sqrt(p), spa = Math.sqrt(pa), spb = Math.sqrt(pb);
  if (p <= pa) return { x: L * (1 / spa - 1 / spb), y: 0 };
  if (p >= pb) return { x: 0, y: L * (spb - spa) };
  return { x: L * (1 / sp - 1 / spb), y: L * (sp - spa) };
}

interface Cfg { z: number; hdays: number; rebalanceOnBreach: boolean; regime?: boolean; }
interface Res { label: string; annNet: number; periodNet: number; fees: number; il: number; inRange: number; rebal: number; }

function simulate(
  bars: Bar[], s: number, e: number, label: string, cfg: Cfg,
  feeAprRef: number, refWidth: number, avgVol: number,
  roll30: number[], roll7: number[], volThresh: number,
): Res {
  const feeAprInRange = (w: number) => Math.min(3, (feeAprRef * refWidth) / Math.max(0.02, w));
  const bandAt = (i: number) => { const sg = roll30[i] || 0.02; const m = sg * Math.sqrt(cfg.hdays); return { low: -(cfg.z * m * 1.3), up: cfg.z * m * 0.85 }; };

  let bnd = bandAt(s);
  let p0 = bars[s].close;
  let pa = p0 * (1 + bnd.low), pb = p0 * (1 + bnd.up);
  let curWidth = bnd.up - bnd.low;
  let L = lFromCapital(CAPITAL, p0, pa, pb);
  const a0 = amountsAt(L, p0, pa, pb);
  let principal = CAPITAL, fees = 0, inR = 0, tot = 0, rebal = 0;
  let state: 'LP' | 'USDC' = 'LP';

  for (let t = s + 1; t <= e; t++) {
    const p = bars[t].close; tot++;
    if (cfg.regime) {
      const hi = roll7[t] > volThresh;
      if (state === 'LP' && hi) { principal = clmmValue(L, p, pa, pb); state = 'USDC'; continue; }
      if (state === 'USDC') {
        if (!hi) { bnd = bandAt(t); pa = p * (1 + bnd.low); pb = p * (1 + bnd.up); curWidth = bnd.up - bnd.low; L = lFromCapital(principal, p, pa, pb); state = 'LP'; }
        else continue;
      }
    }
    if (p >= pa && p <= pb) {
      inR++;
      const base = clmmValue(L, p, pa, pb);
      fees += (base * feeAprInRange(curWidth)) / 365 * (avgVol > 0 ? bars[t].volume / avgVol : 1);
    } else if (cfg.rebalanceOnBreach) {
      principal = clmmValue(L, p, pa, pb);
      bnd = bandAt(t); pa = p * (1 + bnd.low); pb = p * (1 + bnd.up); curWidth = bnd.up - bnd.low;
      L = lFromCapital(principal, p, pa, pb); rebal++;
    }
  }
  const pEnd = bars[e].close;
  const endPos = state === 'USDC' ? principal : clmmValue(L, pEnd, pa, pb);
  const endValue = endPos + fees;
  const hodl = a0.x * pEnd + a0.y;
  const days = e - s;
  return {
    label,
    annNet: (Math.pow(endValue / CAPITAL, 365 / Math.max(1, days)) - 1) * 100,
    periodNet: (endValue / CAPITAL - 1) * 100,
    fees: (fees / CAPITAL) * 100,
    il: ((endPos - hodl) / CAPITAL) * 100,
    inRange: tot > 0 ? (inR / tot) * 100 : 0,
    rebal,
  };
}

function idxAfter(bars: Bar[], date: string) { for (let i = 0; i < bars.length; i++) if (bars[i].date >= date) return i; return -1; }
function idxBefore(bars: Bar[], date: string) { for (let i = bars.length - 1; i >= 0; i--) if (bars[i].date <= date) return i; return -1; }

function runWindow(name: string, bars: Bar[], s: number, e: number, feeAprRef: number, refWidth: number) {
  if (s < 8 || e <= s + 20) { console.log(`  ${name}: 資料不足`); return; }
  const closes = bars.map((b) => b.close);
  const avgVol = bars.slice(s, e + 1).reduce((a, b) => a + b.volume, 0) / Math.max(1, e - s);
  const roll30 = rollingVolatility(closes, 30);
  const roll7 = rollingVolatility(closes, 7);
  const seg = roll7.slice(s, e + 1).filter((v) => v > 0).sort((a, b) => a - b);
  const volThresh = seg[Math.floor(seg.length * 0.66)] || Infinity;
  const chg = ((closes[e] / closes[s] - 1) * 100).toFixed(0);
  console.log(`  ${name}  (${bars[s].date}~${bars[e].date}, ${e - s}天, 底層漲跌 ${chg}%)`);
  console.log('    策略              年化淨%  期間淨%  手續費%   IL%   在內% 調倉');
  const cfgs: [string, Cfg][] = [
    ['1月-平衡(自適應)', { z: 1.5, hdays: 21, rebalanceOnBreach: true }],
    ['3月-平衡(自適應)', { z: 1.5, hdays: 63, rebalanceOnBreach: true }],
    ['1週-積極(常調倉)', { z: 1.0, hdays: 5, rebalanceOnBreach: true }],
    ['1月+波動率擇時', { z: 1.5, hdays: 21, rebalanceOnBreach: true, regime: true }],
  ];
  for (const [label, cfg] of cfgs) {
    const r = simulate(bars, s, e, label, cfg, feeAprRef, refWidth, avgVol, roll30, roll7, volThresh);
    console.log(`    ${label.padEnd(16)} ${r.annNet.toFixed(1).padStart(7)} ${r.periodNet.toFixed(1).padStart(7)} ${r.fees.toFixed(1).padStart(7)} ${r.il.toFixed(1).padStart(6)} ${r.inRange.toFixed(0).padStart(6)} ${String(r.rebal).padStart(4)}`);
  }
  const hodlAnn = (Math.pow(closes[e] / closes[s], 365 / (e - s)) - 1) * 100;
  console.log(`    ${'HODL(100%幣)'.padEnd(16)} ${hodlAnn.toFixed(1).padStart(7)} ${((closes[e] / closes[s] - 1) * 100).toFixed(1).padStart(7)}`);
}

async function main() {
  assertConfig({});
  const wallet = config.wallets[0];
  const { positions, poolMap } = await listPositions(wallet, 0);
  const seen = new Set<string>();
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');

  for (const raw of positions) {
    if (seen.has(raw.poolAddress)) continue;
    seen.add(raw.poolAddress);
    const pm = poolMap[raw.poolAddress];
    const detail = await getPoolDetail(raw.poolAddress).catch(() => null);
    const decA = detail?.decimalsA ?? pm?.decimalsA ?? 0;
    const decB = detail?.decimalsB ?? pm?.decimalsB ?? 0;
    const cur = detail?.currentPrice ?? 0;
    const symA = detail?.symbolA || pm?.symbolA || '';
    const pair = `${symA}/${detail?.symbolB || pm?.symbolB}`;

    // 校準錨點
    const { priceLower, priceUpper } = ticksToPriceRange(raw.lowerTick, raw.upperTick, decA, decB, cur);
    const refWidth = cur > 0 ? (priceUpper - priceLower) / cur : 0.2;
    const ageMs = raw.positionAgeMs || 0;
    const feeAprRef = ageMs > 86_400_000 && parseFloat(raw.totalDeposit || '0') > 0
      ? (parseFloat(raw.earnedUsd || '0') / parseFloat(raw.totalDeposit || '0')) * (365 * 86_400_000 / ageMs)
      : (detail?.feeApr ?? 0) / 100;

    const yhooSym = YHOO[symA];
    let bars: Bar[] = [];
    let src = '';
    if (yhooSym) {
      bars = await fetchYahoo(yhooSym).catch((e) => { console.log(`  (Yahoo ${yhooSym} 失敗: ${(e as Error).message})`); return []; });
      src = `Yahoo ${yhooSym}`;
    }
    if (bars.length < 60) {
      const bb = await fetchDailyBars(raw.poolAddress, pm?.addressA || '', 180).catch(() => []);
      bars = bb.map((b, i) => ({ date: String(i), close: b.close, volume: b.volume }));
      src = 'Byreal 180d';
    }
    console.log(`\n══════ ${pair}  (來源 ${src}, ${bars.length} 天, 錨點 寬${(refWidth * 100).toFixed(0)}%→年化${(feeAprRef * 100).toFixed(0)}%) ══════`);
    if (bars.length < 40) { console.log('  資料不足，略過'); continue; }

    // 全期間
    runWindow('全期間', bars, 8, bars.length - 1, feeAprRef, refWidth);
    // 2022 熊市段
    const b22s = idxAfter(bars, '2022-01-01'), b22e = idxBefore(bars, '2022-12-31');
    if (b22s > 0 && b22e > b22s) runWindow('2022熊市', bars, b22s, b22e, feeAprRef, refWidth);
    // 2023-2024 復甦段
    const b23s = idxAfter(bars, '2023-01-01'), b24e = idxBefore(bars, '2024-12-31');
    if (b23s > 0 && b24e > b23s) runWindow('2023-24復甦', bars, b23s, b24e, feeAprRef, refWidth);
  }
}

main().catch((e) => { console.error('[backtest] 失敗:', e); process.exit(1); });
