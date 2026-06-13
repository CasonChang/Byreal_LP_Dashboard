/** Telegram 推播。 */

import { config } from './config.ts';

export async function sendTelegram(text: string): Promise<void> {
  if (config.dryRun) {
    console.log('\n──── [DRY_RUN] Telegram 訊息 ────\n' + text + '\n────────────────────────────────\n');
    return;
  }
  if (!config.telegram.token || !config.telegram.chatId) {
    console.warn('未設定 Telegram，略過推播');
    return;
  }
  const url = `https://api.telegram.org/bot${config.telegram.token}/sendMessage`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      chat_id: config.telegram.chatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    console.error(`Telegram 推播失敗 ${res.status}: ${body.slice(0, 300)}`);
  }
}

export function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
