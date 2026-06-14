-- Byreal LP Dashboard — Supabase 資料表
-- 在 Supabase 專案的 SQL Editor 貼上並執行即可建立。

-- 每次收集的「總覽」快照
create table if not exists public.snapshots (
  id                  bigserial primary key,
  captured_at         timestamptz not null default now(),
  wallets             text[] not null default '{}',
  total_liquidity_usd numeric not null default 0,
  total_earned_usd    numeric not null default 0,
  total_bonus_usd     numeric not null default 0,
  total_pnl_usd       numeric not null default 0,
  position_count      int not null default 0,
  active_count        int not null default 0,
  in_range_count      int not null default 0,
  weighted_apr        numeric not null default 0
);
create index if not exists snapshots_captured_at_idx on public.snapshots (captured_at desc);

-- 策略級欄位（含已關閉部位的累計）；舊專案請執行下面這段 ALTER 升級
alter table public.snapshots add column if not exists strategy_fees_usd  numeric;
alter table public.snapshots add column if not exists strategy_pnl_usd   numeric;
alter table public.snapshots add column if not exists strategy_fee_apr   numeric;
alter table public.snapshots add column if not exists strategy_total_apr numeric;

-- 每個部位、每次收集的明細
create table if not exists public.position_snapshots (
  id                   bigserial primary key,
  snapshot_id          bigint references public.snapshots (id) on delete cascade,
  captured_at          timestamptz not null default now(),
  position_address     text not null,
  nft_mint             text,
  pool_address         text,
  pair                 text,
  lower_tick           int,
  upper_tick           int,
  price_lower          numeric,
  price_upper          numeric,
  current_price        numeric,
  in_range             boolean,
  nearest_boundary_pct numeric,
  risk_level           text,
  liquidity_usd        numeric,
  earned_usd           numeric,
  earned_pct           numeric,
  pnl_usd              numeric,
  pnl_pct              numeric,
  apr                  numeric,
  bonus_usd            numeric,
  status               text
);
create index if not exists pos_snap_addr_time_idx on public.position_snapshots (position_address, captured_at desc);
create index if not exists pos_snap_time_idx on public.position_snapshots (captured_at desc);

-- 偵測到的動作 / 警示事件
create table if not exists public.events (
  id               bigserial primary key,
  occurred_at      timestamptz not null default now(),
  type             text not null,
  position_address text,
  pair             text,
  message          text,
  detail           jsonb not null default '{}'
);
create index if not exists events_time_idx on public.events (occurred_at desc);

-- 每日報告
create table if not exists public.daily_reports (
  id          bigserial primary key,
  report_date date not null unique,
  summary     jsonb not null default '{}',
  message     text,
  sent_at     timestamptz not null default now()
);

-- 備註：本專案以 service_role key 從 GitHub Actions 寫入（繞過 RLS），
-- 前端不直接連 Supabase（改讀 docs/data/*.json），因此不需開啟匿名讀取。
