/**
 * 把目前狀態輸出成靜態 JSON 給 GitHub Pages 前端讀取。
 * 寫到 docs/data/latest.json 與 docs/data/history.json。
 */

import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LpEvent, PortfolioSnapshot, PositionMetric } from './types.ts';
import { getDailyEquityHistory, getRecentEvents, saveDashboardState } from './supabase.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolve(__dirname, '..', 'docs', 'data');

/** 讀取「上一份」latest.json，回傳 positionAddress → 部位 的對照表，用於事件差分。 */
export async function readPreviousPositions(): Promise<Map<string, PositionMetric>> {
  const map = new Map<string, PositionMetric>();
  try {
    const raw = await readFile(resolve(DATA_DIR, 'latest.json'), 'utf8');
    const snap = JSON.parse(raw) as PortfolioSnapshot;
    for (const p of snap.positions || []) map.set(p.positionAddress, p);
  } catch {
    // 第一次執行還沒有 latest.json，回傳空表
  }
  return map;
}

export async function exportJson(snap: PortfolioSnapshot, recentEvents: LpEvent[]): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });

  // 最新快照（前端首頁主要資料來源）
  await writeFile(resolve(DATA_DIR, 'latest.json'), JSON.stringify(snap, null, 2));

  // 歷史：權益曲線（每日）+ 近 30 天事件。
  // 一律從 DB 撈近 30 天完整歷史（本輪偵測到的事件在呼叫此函式前已 saveEvents 寫入 DB，會被含括），
  // 避免「本輪有事件就只輸出本輪、把歷史洗掉」。DB 撈不到才退回用傳入的本輪事件。
  const equity = await getDailyEquityHistory(90);
  let events = await getRecentEvents(new Date(Date.now() - 30 * 86400_000).toISOString());
  if (events.length === 0 && recentEvents.length > 0) events = recentEvents;

  const history = {
    updatedAt: snap.capturedAt,
    equity,
    events: events.slice(0, 200),
  };
  await writeFile(resolve(DATA_DIR, 'history.json'), JSON.stringify(history, null, 2));

  // 同步寫進 Supabase（前端直讀來源；本機檔案僅作離線/退回用）
  await saveDashboardState('latest', snap);
  await saveDashboardState('history', history);
}
