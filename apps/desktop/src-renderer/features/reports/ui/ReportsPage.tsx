/**
 * TASK-013 §5: маршрут /reports. TASK-065 §5 (РЕШЕНИЕ): экран «Отчёты» — дом
 * экспорта+PDF+копий; здесь живут кнопки экспорта CSV/JSON (ExportButtons:
 * save-диалог main → файл на диске пользователя, US-27), сборка PDF-отчёта
 * (ReportScreen — TASK-068 UC-05) и секция «Данные» (DataSection — TASK-073:
 * копия/восстановление/полное удаление, §2 — секция на «Отчётах»).
 */
import { useTranslation } from 'react-i18next';

import { DataSection } from './data/DataSection';
import { ExportButtons } from './ExportButtons';
import { ReportScreen } from './ReportBuilder';

export function ReportsPage(): JSX.Element {
  const { t } = useTranslation();

  return (
    <section className="mx-auto max-w-2xl p-4" aria-labelledby="reports-title">
      <h1 id="reports-title" className="hl-large-title mb-4">
        {t('common.nav.reports')}
      </h1>
      <ExportButtons />
      <ReportScreen />
      <DataSection />
    </section>
  );
}
