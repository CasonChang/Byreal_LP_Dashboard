/**
 * 診斷用：印出 Byreal position/list（含已關閉部位）與 pools/details 原始回傳，
 * 用來規劃「策略級」統計（含關倉後的累計手續費 / 本金 / 提領）。
 */

import { config } from './config.ts';

async function get(path: string, query: Record<string, string | number>) {
  const url = new URL(config.byrealApiUrl + path);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, String(v));
  const res = await fetch(url.toString(), { headers: { accept: 'application/json' } });
  return res.json();
}

const wallet = config.wallets[0];

for (const status of [0, 1]) {
  const label = status === 0 ? '開啟中 (active)' : '已關閉 (closed)';
  console.log(`\n======== position/list status=${status} (${label}) ========`);
  const r: any = await get('/byreal/api/dex/v2/position/list', { userAddress: wallet, page: 1, pageSize: 50, status });
  const data = r?.result?.data;
  const records = data?.positions || data?.records || [];
  console.log('total:', data?.total, '| 筆數:', records.length);
  if (records[0]) {
    console.log('單筆所有欄位 keys:', Object.keys(records[0]));
    // 重點欄位
    for (const it of records.slice(0, 5)) {
      console.log({
        pool: it.poolAddress?.slice(0, 6),
        status: it.status,
        earnedUsd: it.earnedUsd,
        totalDeposit: it.totalDeposit,
        totalClaimedFeesRewards: it.totalClaimedFeesRewards,
        pnlUsd: it.pnlUsd,
        openTime: it.openTime,
        closeTime: it.closeTime,
        positionAgeMs: it.positionAgeMs,
        unclaimedData: it.unclaimedData,
      });
    }
  }
}
