/**
 * 診斷用：印出 Byreal position/list 與 pools/details 的「原始」回傳，
 * 用來確認是否有未領手續費（unclaimed fee）等欄位。只在 GitHub Actions 手動觸發時用。
 */

import { config } from './config.ts';

async function get(path: string, query: Record<string, string | number>) {
  const url = new URL(config.byrealApiUrl + path);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, String(v));
  const res = await fetch(url.toString(), { headers: { accept: 'application/json' } });
  return res.json();
}

const wallet = config.wallets[0];
console.log('=== position/list 原始回傳 ===');
const list: any = await get('/byreal/api/dex/v2/position/list', { userAddress: wallet, page: 1, pageSize: 50 });
const data = list?.result?.data;
const records = data?.positions || data?.records || [];
console.log('total:', data?.total, '| 筆數:', records.length);
console.log('單筆部位所有欄位 keys:', records[0] ? Object.keys(records[0]) : '(無)');
console.log('前兩筆完整內容:');
console.log(JSON.stringify(records.slice(0, 2), null, 2));
console.log('poolMap 第一筆:', JSON.stringify(Object.values(data?.poolMap || {})[0], null, 2));

const firstPool = records[0]?.poolAddress;
if (firstPool) {
  console.log('\n=== pools/details 原始回傳 (', firstPool, ') ===');
  const detail: any = await get('/byreal/api/dex/v2/pools/details', { poolAddress: firstPool });
  const pd = detail?.result?.data;
  console.log('pool 頂層 keys:', pd ? Object.keys(pd) : '(無)');
  console.log(JSON.stringify(pd, null, 2).slice(0, 2500));
}
