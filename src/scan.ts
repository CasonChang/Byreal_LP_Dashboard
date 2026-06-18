/**
 * 熱門池掃描（在 GitHub Actions 上跑）。
 * 找「適合 LP 刷手續費」的池子：高手續費年化、高週轉率(量/TVL)、波動度適中、TVL 足夠(不易被操縱)。
 * 輸出 docs/data/scan.json 給研究頁面，並印出前幾名。
 *
 * 「刷單效率分」= 手續費年化 ÷ 年化波動度：每承受一單位波動(IL 風險)能換到多少手續費，越高越甜。
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, assertConfig } from './config.ts';
import { fetchDailyCloses, dailyVolatility } from './kline.ts';
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

interface PoolRow {
  poolAddress: string; pair: string; symbolA: string; symbolB: string; addressA: string;
  tvlUsd: number; vol24hUsd: number; feeApr: number; turnover: number;
  sigmaDaily: number; annVol: number; effScore: number;
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

  const base: PoolRow[] = [];
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
      tvlUsd: tvl, vol24hUsd: vol, feeApr, turnover: tvl > 0 ? (vol / tvl) * 100 : 0,
      sigmaDaily: 0, annVol: 0, effScore: 0,
    });
  }

  // 取手續費年化前 25 名去算波動度
  base.sort((a, b) => b.feeApr - a.feeApr);
  const candidates = base.slice(0, 25);
  for (const c of candidates) {
    try {
      const closes = await fetchDailyCloses(c.poolAddress, c.addressA, 30);
      c.sigmaDaily = dailyVolatility(closes);
    } catch { c.sigmaDaily = 0; }
    c.annVol = c.sigmaDaily * Math.sqrt(365) * 100;
    c.effScore = c.annVol > 5 ? c.feeApr / c.annVol : 0; // 波動太低(可能無資料)就不給分
  }

  const ranked = candidates.filter((c) => c.effScore > 0).sort((a, b) => b.effScore - a.effScore);

  console.log('排名 交易對              手續費年化  TVL       24h量     週轉%  日波動  年化波動  效率分');
  ranked.slice(0, 18).forEach((c, i) => {
    console.log(
      `${String(i + 1).padStart(2)}. ${c.pair.padEnd(18)} ${c.feeApr.toFixed(0).padStart(7)}% ${('$' + (c.tvlUsd / 1e6).toFixed(2) + 'M').padStart(9)} ${('$' + (c.vol24hUsd / 1e6).toFixed(2) + 'M').padStart(9)} ${c.turnover.toFixed(0).padStart(6)} ${(c.sigmaDaily * 100).toFixed(2).padStart(6)}% ${c.annVol.toFixed(0).padStart(7)}% ${c.effScore.toFixed(2).padStart(7)}`,
    );
  });

  const payload = { updatedAt: new Date().toISOString(), pools: ranked };
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(resolve(DATA_DIR, 'scan.json'), JSON.stringify(payload, null, 2));
  // 寫進 Supabase 給前端直讀（免 commit）
  await saveDashboardState('scan', payload);
  console.log(`\n[scan] 已更新（${ranked.length} 個池子）`);
}

// 直接以 `tsx src/scan.ts` 執行時才自動跑；被 daemon import 時不執行。
if (isDirectRun(import.meta.url)) {
  runScanOnce().catch((e) => {
    console.error('[scan] 失敗:', e);
    process.exit(1);
  });
}
