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
  SUPABASE_URL: '',       // 例：https://xxxxxxxx.supabase.co
  SUPABASE_ANON_KEY: '',  // 公開 anon key（不是 service_role）
};
