-- 前端直讀用的「成品狀態表」。
-- collector 用 service role（繞過 RLS）把算好的 latest / history 兩包 JSON upsert 進來，
-- 前端用公開 anon key 唯讀（RLS 只開放 SELECT），不再需要把 JSON commit 進 git。
--
-- 在 Supabase 的 SQL Editor 執行一次即可。

create table if not exists dashboard_state (
  key text primary key,           -- 'latest' | 'history'
  payload jsonb not null,
  updated_at timestamptz not null default now()
);

alter table dashboard_state enable row level security;

-- 唯讀：任何人（anon）都只能 SELECT，不能寫入。
-- service role 會繞過 RLS，所以 collector 仍可寫入。
drop policy if exists "public read dashboard_state" on dashboard_state;
create policy "public read dashboard_state"
  on dashboard_state for select
  using (true);
