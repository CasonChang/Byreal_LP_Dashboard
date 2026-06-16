/*
 * 前端 Supabase 設定（唯讀直讀用）。
 *
 * 填入你的 Supabase 專案 URL 與「anon / public」金鑰（不是 service_role！）。
 * anon key 搭配唯讀 RLS（見 supabase/dashboard_state.sql），可安全公開放在前端。
 *
 * 兩格都填好之後，前端會直接讀 Supabase（即時、免 commit）；
 * 留空則自動退回讀 ./data/*.json 舊檔，不會壞。
 */
window.BYREAL_CONFIG = {
  SUPABASE_URL: 'https://djcebqribkmtrhkoytaq.supabase.co',
  SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRqY2VicXJpYmttdHJoa295dGFxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODExMDk4NDgsImV4cCI6MjA5NjY4NTg0OH0.c6UqSS7MZHbGIOsjqqSYqP4Z3eCRxFL_BwPUlyzoEcA',
};
