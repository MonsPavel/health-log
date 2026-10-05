// Уборка залоченных asar (TASK-106 дожим): raw \\?\-пути минуют резолв имени.
const fs = require('node:fs');
const paths = [
  'apps/desktop/dist-audit/win-unpacked/resources/app.asar',
  'apps/desktop/dist/win-unpacked/resources/app.asar',
  'apps/desktop/dist/win-unpacked.tmp/resources/default_app.asar',
];
for (const p of paths) {
  const raw = '\\\\?\\D:\\repositories\\health-log\\' + p.replaceAll('/', '\\');
  try {
    fs.unlinkSync(raw);
    console.log('unlinked', p);
  } catch (e) {
    console.log('FAIL', p, e.code);
  }
}
