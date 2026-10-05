import { _electron } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const userData = mkdtempSync(join(tmpdir(), 'probe-'));
const app = await _electron.launch({
  args: ['dist/main/app/bootstrap.js'],
  env: { ...process.env, HL_TEST_USER_DATA: userData, HL_TEST_HOOKS: '1' },
});
app.process().stderr?.on('data', (d) => process.stdout.write('[stderr] ' + d));
const timeout = setTimeout(() => {
  console.log('NO WINDOW in 20s; processes:', app.process().killed ? 'dead' : 'alive');
}, 20000);
try {
  const win = await app.firstWindow();
  clearTimeout(timeout);
  console.log('WINDOW OK:', win.url());
} catch (e) {
  clearTimeout(timeout);
  console.log('WINDOW FAIL:', String(e).slice(0, 200));
}
await app.close();
