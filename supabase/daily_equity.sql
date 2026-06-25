-- 每日權益聚合表：一天只存一筆彙總，給折線圖看「長期歷史」用。
--
-- 為什麼需要它：daemon 每 10 分鐘存一筆 snapshots（一天 ~144 筆），
-- 放幾個月就上萬筆，前端讀取會撞到 PostgREST 預設 1000 筆上限、且浪費頻寬。
-- 改成「一天一筆」後，一年也才 365 筆，讀取永遠輕鬆、可保存數年。
--
-- daemon 每輪會 upsert「今天」這筆（持續更新，跨日後定格）。
-- 在 Supabase 的 SQL Editor 執行一次即可（含把現有 snapshots 回填進來）。

create table if not exists daily_equity (
  date date primary key,            -- 台北日期 YYYY-MM-DD
  liquidity_usd numeric,            -- 當天總倉位（收盤值）
  lifetime_fees_usd numeric,        -- 累計手續費（策略級，含已關閉）
  pnl_usd numeric,                  -- 累計損益（不含手續費）
  fee_apr numeric,                  -- 策略手續費年化
  total_apr numeric,                -- 策略總報酬年化
  updated_at timestamptz not null default now()
);

alter table daily_equity enable row level security;
drop policy if exists "public read daily_equity" on daily_equity;
create policy "public read daily_equity"
  on daily_equity for select
  using (true);

-- 回填：把現有 snapshots「每天最後一筆」灌進 daily_equity。
-- 這段在 DB 端執行，不受 PostgREST 1000 筆讀取上限影響，會涵蓋全部歷史。
insert into daily_equity (date, liquidity_usd, lifetime_fees_usd, pnl_usd, fee_apr, total_apr)
select distinct on ((captured_at at time zone 'Asia/Taipei')::date)
  (captured_at at time zone 'Asia/Taipei')::date as d,
  total_liquidity_usd,
  coalesce(strategy_fees_usd, total_earned_usd, 0),
  coalesce(strategy_pnl_usd, total_pnl_usd, 0),
  coalesce(strategy_fee_apr, weighted_apr, 0),
  coalesce(strategy_total_apr, 0)
from snapshots
order by (captured_at at time zone 'Asia/Taipei')::date, captured_at desc
on conflict (date) do nothing;
