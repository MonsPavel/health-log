/**
 * TASK-013 §5: маршрут /reports. TASK-065 §5 (РЕШЕНИЕ): экран «Отчёты» — дом
 * экспорта+PDF+копий; здесь живут кнопки экспорта CSV/JSON (ExportButtons:
 * save-диалог main → файл на диске пользователя, US-27) и сборка PDF-отчёта
 * (ReportScreen — TASK-068 UC-05). Data Care UI (TASK-073) появится здесь же —
 * до тех пор внизу остаётся пометка о будущем содержимом (common.wip).
 */
import { useTranslation } from 'react-i18next';

import { ExportButtons } from './ExportButtons';
import { ReportScreen } from './ReportBuilder';

export function ReportsPage(): JSX.Element {
  const { t } = useTranslation();

  return (
    <section className="mx-auto max-w-2xl p-4" aria-labelledby="reports-title">
      <h1 id="reports-title" className="mb-4 text-xl font-semibold">
        {t('common.nav.reports')}
      </h1>
      <ExportButtons />
      <ReportScreen />
      <p className="text-sm text-accent">{t('common.wip')}</p>
    </section>
  );
}
