/**
 * 設定讀取：所有環境變數集中在這裡。
 */

export const config = {
  wallets: (process.env.WALLET_ADDRESS || '')
    .split(',')
    .map((w) => w.trim())
    .filter(Boolean),

  byrealApiUrl: process.env.BYREAL_API_URL || 'https://api2.byreal.io',

  telegram: {
    token: process.env.TELEGRAM_BOT_TOKEN || '',
    chatId: process.env.TELEGRAM_CHAT_ID || '',
  },

  supabase: {
    url: process.env.SUPABASE_URL || '',
    key: process.env.SUPABASE_SERVICE_ROLE_KEY || '',
  },

  /** 距離最近區間邊界小於此百分比 → 發出「快出界」警示 */
  rangeWarnPct: Number(process.env.RANGE_WARN_PCT || '8'),

  tz: process.env.TZ || 'Asia/Taipei',

  dryRun: String(process.env.DRY_RUN || 'false').toLowerCase() === 'true',
};

export function assertConfig(opts: { needSupabase?: boolean; needTelegram?: boolean } = {}) {
  if (config.wallets.length === 0) {
    throw new Error('缺少 WALLET_ADDRESS 環境變數');
  }
  if (opts.needTelegram && !config.dryRun) {
    if (!config.telegram.token || !config.telegram.chatId) {
      throw new Error('缺少 TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID');
    }
  }
  if (opts.needSupabase && !config.dryRun) {
    if (!config.supabase.url || !config.supabase.key) {
      throw new Error('缺少 SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY');
    }
  }
}
