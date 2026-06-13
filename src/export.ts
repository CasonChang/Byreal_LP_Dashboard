/**
 * 把目前狀態輸出成靜態 JSON 給 GitHub Pages 前端讀取。
 * 寫到 docs/data/latest.json 與 docs/data/history.json。
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LpEvent, PortfolioSnapshot } from './types.ts';
import { getDailyEquityHistory, getRecentEvents } from './supabase.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolve(__dirname, '..', 'docs', 'data');

export async function exportJson(snap: PortfolioSnapshot, recentEvents: LpEvent[]): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });

  // 最新快照（前端首頁主要資料來源）
  await writeFile(resolve(DATA_DIR, 'latest.json'), JSON.stringify(snap, null, 2));

  // 歷史：權益曲線（每日）+ 近 30 天事件
  const equity = await getDailyEquityHistory(90);
  const events = recentEvents.length > 0 ? recentEvents : await getRecentEvents(new Date(Date.now() - 30 * 86400_000).toISOString());

  const history = {
    updatedAt: snap.capturedAt,
    equity,
    events: events.slice(0, 200),
  };
  await writeFile(resolve(DATA_DIR, 'history.json'), JSON.stringify(history, null, 2));
}
