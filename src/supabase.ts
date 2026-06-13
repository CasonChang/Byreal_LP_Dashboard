/**
 * Supabase 存取層：寫入快照 / 部位 / 事件 / 每日報告，並讀取前一次狀態與歷史。
 * DRY_RUN 或未設定時自動降級為「記憶體模式」（不寫入），方便本地測試。
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { config } from './config.ts';
import type { LpEvent, PortfolioSnapshot, PositionMetric } from './types.ts';

let client: SupabaseClient | null = null;
function db(): SupabaseClient | null {
  if (config.dryRun || !config.supabase.url || !config.supabase.key) return null;
  if (!client) client = createClient(config.supabase.url, config.supabase.key, { auth: { persistSession: false } });
  return client;
}

export interface PrevPositionState {
  positionAddress: string;
  lowerTick: number;
  upperTick: number;
  liquidityUsd: number;
  earnedUsd: number;
  inRange: boolean;
  riskLevel: string;
  status: string;
}

/** 讀取每個部位「最近一次」的狀態，用來做事件偵測與警示去重。 */
export async function getPreviousStates(): Promise<Map<string, PrevPositionState>> {
  const map = new Map<string, PrevPositionState>();
  const d = db();
  if (!d) return map;

  // 取最近 500 筆 position_snapshots，每個 position 只留最新一筆
  const { data, error } = await d
    .from('position_snapshots')
    .select('position_address,lower_tick,upper_tick,liquidity_usd,earned_usd,in_range,risk_level,status,captured_at')
    .order('captured_at', { ascending: false })
    .limit(500);
  if (error) {
    console.warn('讀取前次狀態失敗:', error.message);
    return map;
  }
  for (const row of data || []) {
    if (map.has(row.position_address)) continue;
    map.set(row.position_address, {
      positionAddress: row.position_address,
      lowerTick: row.lower_tick,
      upperTick: row.upper_tick,
      liquidityUsd: Number(row.liquidity_usd),
      earnedUsd: Number(row.earned_usd),
      inRange: row.in_range,
      riskLevel: row.risk_level,
      status: row.status,
    });
  }
  return map;
}

/** 寫入一次完整快照（總覽 + 每個部位）。 */
export async function saveSnapshot(snap: PortfolioSnapshot): Promise<void> {
  const d = db();
  if (!d) return;

  const { data: snapRow, error: e1 } = await d
    .from('snapshots')
    .insert({
      captured_at: snap.capturedAt,
      wallets: snap.wallets,
      total_liquidity_usd: snap.totals.liquidityUsd,
      total_earned_usd: snap.totals.earnedUsd,
      total_bonus_usd: snap.totals.bonusUsd,
      total_pnl_usd: snap.totals.pnlUsd,
      position_count: snap.totals.positionCount,
      active_count: snap.totals.activeCount,
      in_range_count: snap.totals.inRangeCount,
      weighted_apr: snap.totals.weightedApr,
    })
    .select('id')
    .single();
  if (e1) {
    console.error('寫入 snapshot 失敗:', e1.message);
    return;
  }

  const rows = snap.positions.map((p) => positionRow(snapRow!.id, snap.capturedAt, p));
  const { error: e2 } = await d.from('position_snapshots').insert(rows);
  if (e2) console.error('寫入 position_snapshots 失敗:', e2.message);
}

function positionRow(snapshotId: number, capturedAt: string, p: PositionMetric) {
  return {
    snapshot_id: snapshotId,
    captured_at: capturedAt,
    position_address: p.positionAddress,
    nft_mint: p.nftMint,
    pool_address: p.poolAddress,
    pair: p.pair,
    lower_tick: p.lowerTick,
    upper_tick: p.upperTick,
    price_lower: p.priceLower,
    price_upper: p.priceUpper,
    current_price: p.currentPrice,
    in_range: p.inRange,
    nearest_boundary_pct: p.nearestBoundaryPct,
    risk_level: p.riskLevel,
    liquidity_usd: p.liquidityUsd,
    earned_usd: p.earnedUsd,
    earned_pct: p.earnedPct,
    pnl_usd: p.pnlUsd,
    pnl_pct: p.pnlPct,
    apr: p.apr,
    bonus_usd: p.bonusUsd,
    status: p.status,
  };
}

export async function saveEvents(events: LpEvent[]): Promise<void> {
  const d = db();
  if (!d || events.length === 0) return;
  const rows = events.map((e) => ({
    type: e.type,
    occurred_at: e.occurredAt,
    position_address: e.positionAddress,
    pair: e.pair,
    message: e.message,
    detail: e.detail,
  }));
  const { error } = await d.from('events').insert(rows);
  if (error) console.error('寫入 events 失敗:', error.message);
}

export async function saveDailyReport(reportDate: string, summary: unknown, message: string): Promise<void> {
  const d = db();
  if (!d) return;
  const { error } = await d
    .from('daily_reports')
    .upsert({ report_date: reportDate, summary, message, sent_at: new Date().toISOString() }, { onConflict: 'report_date' });
  if (error) console.error('寫入 daily_reports 失敗:', error.message);
}

/** 讀取最後一次每日報告的快照值，用來算「日變化」。 */
export async function getLastDailySummary(): Promise<any | null> {
  const d = db();
  if (!d) return null;
  const { data, error } = await d
    .from('daily_reports')
    .select('summary,report_date')
    .order('report_date', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    console.warn('讀取上次每日報告失敗:', error.message);
    return null;
  }
  return data?.summary ?? null;
}

/** 取得近 N 天的事件（給每日報告與前端用）。 */
export async function getRecentEvents(sinceIso: string): Promise<LpEvent[]> {
  const d = db();
  if (!d) return [];
  const { data, error } = await d
    .from('events')
    .select('*')
    .gte('occurred_at', sinceIso)
    .order('occurred_at', { ascending: false });
  if (error) return [];
  return (data || []).map((r) => ({
    type: r.type,
    occurredAt: r.occurred_at,
    positionAddress: r.position_address,
    pair: r.pair,
    message: r.message,
    detail: r.detail || {},
  }));
}

/** 取得每日總覽歷史（給前端權益曲線）。回傳每天最後一筆。 */
export async function getDailyEquityHistory(days = 90): Promise<
  Array<{ date: string; liquidityUsd: number; earnedUsd: number; pnlUsd: number; weightedApr: number }>
> {
  const d = db();
  if (!d) return [];
  const since = new Date(Date.now() - days * 86400_000).toISOString();
  const { data, error } = await d
    .from('snapshots')
    .select('captured_at,total_liquidity_usd,total_earned_usd,total_pnl_usd,weighted_apr')
    .gte('captured_at', since)
    .order('captured_at', { ascending: true });
  if (error || !data) return [];

  const byDay = new Map<string, any>();
  for (const r of data) {
    const day = new Date(r.captured_at).toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' });
    byDay.set(day, r); // 後面的覆蓋前面 → 留當天最後一筆
  }
  return [...byDay.entries()].map(([date, r]) => ({
    date,
    liquidityUsd: Number(r.total_liquidity_usd),
    earnedUsd: Number(r.total_earned_usd),
    pnlUsd: Number(r.total_pnl_usd),
    weightedApr: Number(r.weighted_apr),
  }));
}
