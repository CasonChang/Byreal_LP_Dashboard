import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * 判斷這個模組是否被「直接執行」(例如 `tsx src/collect.ts`)，
 * 而不是被別的檔案 import（例如 daemon.ts 匯入 collect）。
 * 用來讓 collect.ts / daily-report.ts 仍可單獨 CLI 執行，
 * 但被 daemon import 時不會自動跑一次。
 */
export function isDirectRun(moduleUrl: string): boolean {
  try {
    const entry = process.argv[1];
    if (!entry) return false;
    return realpathSync(entry) === fileURLToPath(moduleUrl);
  } catch {
    return false;
  }
}
