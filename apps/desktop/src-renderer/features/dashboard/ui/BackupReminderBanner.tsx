/**
 * TASK-074 §10/§16/§17: ненавязчивый баннер-подсказка «пора сделать копию» на
 * дашборде. Тон — мягкий, без упрёков (FR-4.4-стиль, golden-тест §17: в текстах
 * нет «забыли»/«не делали»); цвет — жёлто-нейтральный (amber), НЕ красный.
 *
 * Доступность (§16): role="status" — регион озвучивается, но НЕ модальный (фокус
 * не перехватывает — мягкость); кнопки стандартные (минимальная зона касания —
 * прецедент BackupDialog). Показ/скрытие — решение владельца (SummaryScreen):
 * компонент чисто презентационный, событие job:backup-reminder → props-колбэки.
 */
import { useTranslation } from 'react-i18next';

/** Props баннера (§10): кнопки «Создать копию» (диалог 073) и «Позже» (скрыть). */
export interface BackupReminderBannerProps {
  /** «Создать копию» — владелец открывает BackupDialog (073). */
  readonly onCreate: () => void;
  /** «Позже» — владелец скрывает баннер (пауза недели — scheduler, lastShown). */
  readonly onLater: () => void;
}

/** Баннер-подсказка о резервной копии (§2/§10). */
export function BackupReminderBanner({
  onCreate,
  onLater,
}: BackupReminderBannerProps): JSX.Element {
  const { t } = useTranslation();

  return (
    <div
      role="status"
      data-testid="backup-reminder-banner"
      className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-md bg-status-warn/10 px-4 py-3"
    >
      <div className="min-w-0">
        <p data-testid="backup-reminder-title" className="text-sm font-semibold text-text">
          {t('dashboard.banner.backup.title')}
        </p>
        <p data-testid="backup-reminder-body" className="mt-0.5 text-sm text-muted">
          {t('dashboard.banner.backup.body')}
        </p>
      </div>
      <div className="flex shrink-0 gap-3">
        <button
          type="button"
          data-testid="backup-reminder-create"
          onClick={onCreate}
          className="min-h-11 rounded-xl bg-accent px-4 text-sm font-semibold text-bg hover:opacity-90"
        >
          {t('dashboard.banner.backup.create')}
        </button>
        <button
          type="button"
          data-testid="backup-reminder-later"
          onClick={onLater}
          className="min-h-11 rounded-xl bg-fill px-4 text-sm font-semibold text-text hover:bg-accent/10"
        >
          {t('dashboard.banner.backup.later')}
        </button>
      </div>
    </div>
  );
}
