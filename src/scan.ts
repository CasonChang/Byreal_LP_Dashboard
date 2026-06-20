/**
 * 熱門池掃描（由 Zeabur daemon 每 SCAN_INTERVAL_HOURS 小時跑一次；輸出給研究頁面）。
 * 目標：找「適合長期 LP 刷手續費」的池子，而非被單日行情灌分的池子。
 *
 * 作法：除了當天 24h，另外抓該池近 95 天日 K 線，算 1週/1月/3月 的窗口指標：
 *  - 手續費年化(估)：feeApr ∝ 量/TVL。用「窗口平均日量 ÷ 最近一天量」的比值(無單位、
 *    可自我修正單日暴量)去調整當前 feeApr24h → 估出該窗口的平均手續費年化。
 *  - 年化波動：由窗口內日收盤算。
 *  - 效率分 = 手續費年化 ÷ 年化波動（每承受一單位波動換到多少手續費）。
 *  - 量穩定度：窗口內日量的變異係數(CV)，越低越穩。
 *  綜合分 = 長期效率加權(1月 50% + 3月 35% + 1週 15%) × 量穩定度，挑長期穩定標的。
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, assertConfig } from './config.ts';
import { fetchDailyBars, dailyVolatility } from './kline.ts';
import { saveDashboardState } from './supabase.ts';
import { isDirectRun } from './runtime.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolve(__dirname, '..', 'docs', 'data');

async function apiGet(path: string, q: Record<string, string | number>) {
  const url = new URL(config.byrealApiUrl + path);
  for (const [k, v] of Object.entries(q)) url.searchParams.set(k, String(v));
  const res = await fetch(url.toString(), { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`api ${res.status}`);
  return res.json();
}

interface BasePool {
  poolAddress: string; pair: string; symbolA: string; symbolB: string; addressA: string;
  tvlUsd: number; vol24hUsd: number; feeApr: number;
}

interface WindowStat { days: number; feeApr: number; annVol: number; effScore: number; volCv: number; }
type WinKey = '1w' | '1m' | '3m';

interface PoolRow {
  poolAddress: string; pair: string; symbolA: string; symbolB: string;
  tvlUsd: number; vol24hUsd: number; feeApr24h: number;
  historyDays: number; sigmaDaily: number;
  win: Record<WinKey, WindowStat>;
  compositeScore: number;
}

const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const std = (a: number[]) => {
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
};

const WINDOWS: Array<[WinKey, number]> = [['1w', 7], ['1m', 30], ['3m', 90]];

function windowStat(bars: Array<{ close: number; volume: number }>, w: number, feeApr24h: number, anchorVol: number): WindowStat {
  const slice = bars.slice(-w);
  const closes = slice.map((b) => b.close);
  const vols = slice.map((b) => b.volume).filter((v) => Number.isFinite(v) && v >= 0);
  const avgVol = mean(vols);
  // 比值無單位；clamp 避免單日雜訊爆掉
  let ratio = anchorVol > 0 ? avgVol / anchorVol : 1;
  ratio = Math.max(0.25, Math.min(4, ratio));
  const feeApr = feeApr24h * ratio;
  const annVol = dailyVolatility(closes) * Math.sqrt(365) * 100;
  const effScore = annVol > 5 ? feeApr / annVol : 0;
  const volCv = avgVol > 0 ? std(vols) / avgVol : 0;
  return { days: slice.length, feeApr, annVol, effScore, volCv };
}

export async function runScanOnce(): Promise<void> {
  assertConfig({});
  // 抓量最大的前 200 個池子
  const raws: any[] = [];
  for (const page of [1, 2]) {
    const env: any = await apiGet('/byreal/api/dex/v2/pools/info/list', { page, pageSize: 100, sortField: 'volumeUsd24h', sortType: 'desc' });
    const recs = env?.result?.data?.records || env?.result?.data?.positions || [];
    raws.push(...recs);
  }

  const base: BasePool[] = [];
  for (const p of raws) {
    const mintA = p.mintA?.mintInfo || p.mintA || {};
    const mintB = p.mintB?.mintInfo || p.mintB || {};
    const tvl = parseFloat(p.tvl || '0');
    const vol = parseFloat(p.volumeUsd1d || p.volumeUsd24h || '0');
    const feeApr = parseFloat(p.feeApr24h || '0') * 100;
    if (tvl < 30000 || vol < 5000) continue; // 排除過小/沒量的池子
    base.push({
      poolAddress: p.poolAddress, pair: `${mintA.symbol || '?'}/${mintB.symbol || '?'}`,
      symbolA: mintA.symbol || '', symbolB: mintB.symbol || '', addressA: mintA.address || '',
      tvlUsd: tvl, vol24hUsd: vol, feeApr,
    });
  }

  // 取當前手續費年化前 30 名去算長期窗口指標
  base.sort((a, b) => b.feeApr - a.feeApr);
  const candidates = base.slice(0, 30);
  const out: PoolRow[] = [];
  for (const c of candidates) {
    let bars: Array<{ close: number; volume: number }> = [];
    try { bars = await fetchDailyBars(c.poolAddress, c.addressA, 95); } catch { bars = []; }
    if (bars.length < 5) continue; // 歷史太少不評

    // 錨定量：最近一天的日量（對應 feeApr24h 的量規模）；為 0 時退用近 3 日平均
    const lastVol = bars[bars.length - 1]?.volume || 0;
    const anchorVol = lastVol > 0 ? lastVol : mean(bars.slice(-3).map((b) => b.volume));

    const win = Object.fromEntries(
      WINDOWS.map(([k, d]) => [k, windowStat(bars, d, c.feeApr, anchorVol)]),
    ) as Record<WinKey, WindowStat>;

    // 綜合分：長期效率加權 × 量穩定度（3 月量越穩、CV 越低，分數越高）
    const base3 = 0.5 * win['1m'].effScore + 0.35 * win['3m'].effScore + 0.15 * win['1w'].effScore;
    const cv = win['3m'].volCv || win['1m'].volCv || 0;
    const stability = 1 / (1 + Math.min(cv, 3));
    const compositeScore = base3 * stability;

    out.push({
      poolAddress: c.poolAddress, pair: c.pair, symbolA: c.symbolA, symbolB: c.symbolB,
      tvlUsd: c.tvlUsd, vol24hUsd: c.vol24hUsd, feeApr24h: c.feeApr,
      historyDays: bars.length, sigmaDaily: dailyVolatility(bars.slice(-30).map((b) => b.close)),
      win, compositeScore,
    });
  }

  const ranked = out.filter((c) => c.compositeScore > 0).sort((a, b) => b.compositeScore - a.compositeScore);

  console.log('排名 交易對              綜合分  1月年化  1月波動  1月效率  3月效率  資料天');
  ranked.slice(0, 18).forEach((c, i) => {
    const m = c.win['1m'], t = c.win['3m'];
    console.log(
      `${String(i + 1).padStart(2)}. ${c.pair.padEnd(18)} ${c.compositeScore.toFixed(2).padStart(6)} ${m.feeApr.toFixed(0).padStart(7)}% ${m.annVol.toFixed(0).padStart(6)}% ${m.effScore.toFixed(2).padStart(7)} ${t.effScore.toFixed(2).padStart(7)} ${String(c.historyDays).padStart(6)}`,
    );
  });

  const payload = { updatedAt: new Date().toISOString(), pools: ranked };
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(resolve(DATA_DIR, 'scan.json'), JSON.stringify(payload, null, 2));
  await saveDashboardState('scan', payload); // 前端直讀
  console.log(`\n[scan] 已更新（${ranked.length} 個池子，含 1週/1月/3月 長期指標）`);
}

// 直接以 `tsx src/scan.ts` 執行時才自動跑；被 daemon import 時不執行。
if (isDirectRun(import.meta.url)) {
  runScanOnce().catch((e) => {
    console.error('[scan] 失敗:', e);
    process.exit(1);
  });
}
