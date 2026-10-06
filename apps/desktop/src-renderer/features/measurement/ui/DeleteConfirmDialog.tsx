/**
 * TASK-038 §5/§16: подтверждение удаления (FR-2.3 — обязательный барьер).
 * Radix AlertDialog: заголовок «Удалить запись от {дата} {время}?» (настенные
 * дата/время записи — formatDateTime из Instant, §13) + тело «Действие
 * необратимо» (US-8: «нельзя потерять случайно»). Кнопки: безопасная «Отмена»
 * (получает фокус при открытии — поведение AlertDialog из коробки, §16) и
 * разрушающая «Удалить»; Esc/оверлей = отмена.
 *
 * КОМПОНЕНТ ПРЕЗЕНТАЦИОННЫЙ (§5): measurements/delete вызывает владелец
 * (HistoryScreen) — onConfirm по «Удалить», onClose при любом закрытии
 * (Esc/«Отмена»/оверлей; Radix вызывает onOpenChange(false) и после Action).
 * «Отмена удаления сохраняет запись» из US-8 = отказ ДО подтверждения: данных
 * после подтверждения уже нет — undo-тоста нет (§5 решение).
 *
 * TASK-048 §13 (аудит крупного режима): max-height + внутренний scroll у
 * контента (перенос прецедента ConfirmFlagsDialog); кнопочный ряд flex-wrap —
 * на масштабах 112/125% кнопки переносятся, не перекрываются.
 */
import * as AlertDialog from '@radix-ui/react-alert-dialog';
import { useTranslation } from 'react-i18next';

import type { MeasurementDto } from '@hl/contracts';

import { formatDateTime } from '../../../lib/i18n-date';

/** Props диалога: цель удаления + решения пользователя. */
export interface DeleteConfirmDialogProps {
  /** Запись на удаление; null — диалог закрыт (управляемая модальность владельца). */
  readonly target: MeasurementDto | null;
  /** «Удалить» — владелец вызывает measurements/delete (§5). */
  readonly onConfirm: () => void;
  /** Любое закрытие без удаления (Esc/«Отмена»/оверлей/после Action). */
  readonly onClose: () => void;
}

/** Диалог подтверждения удаления записи (§2). */
export function DeleteConfirmDialog({
  target,
  onConfirm,
  onClose,
}: DeleteConfirmDialogProps): JSX.Element {
  const { t } = useTranslation();

  return (
    <AlertDialog.Root
      open={target !== null}
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
    >
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="fixed inset-0 bg-black/50" />
        <AlertDialog.Content
          data-testid="delete-confirm-dialog"
          className="fixed left-1/2 top-1/2 w-[min(24rem,calc(100vw-2rem))] max-h-[calc(100vh-2rem)] -translate-x-1/2 -translate-y-1/2 overflow-auto rounded-lg border border-border bg-bg p-6 shadow-lg"
        >
          <AlertDialog.Title
            data-testid="delete-confirm-title"
            className="hl-large-title text-text"
          >
            {target === null
              ? null
              : t('measurement.delete.title', {
                  date: formatDateTime(
                    { utcMs: target.takenAtUtcMs, tzOffsetMin: target.tzOffsetMin },
                    { preset: 'date' },
                  ),
                  time: formatDateTime(
                    { utcMs: target.takenAtUtcMs, tzOffsetMin: target.tzOffsetMin },
                    { preset: 'time' },
                  ),
                })}
          </AlertDialog.Title>

          <AlertDialog.Description asChild>
            <p data-testid="delete-confirm-body" className="mt-3 text-base text-text">
              {t('measurement.delete.body')}
            </p>
          </AlertDialog.Description>

          <div className="mt-6 flex flex-wrap justify-end gap-3">
            {/* Безопасное действие: фокус при открытии и первый Tab — к «Отмене» (§16). */}
            <AlertDialog.Cancel asChild>
              <button
                type="button"
                data-testid="delete-cancel"
                className="min-h-11 rounded-xl bg-fill px-6 text-base font-semibold text-text"
              >
                {t('measurement.delete.cancel')}
              </button>
            </AlertDialog.Cancel>
            <AlertDialog.Action asChild>
              <button
                type="button"
                data-testid="delete-confirm"
                onClick={onConfirm}
                className="min-h-11 rounded-xl bg-accent px-6 text-base font-semibold text-bg"
              >
                {t('measurement.delete.confirm')}
              </button>
            </AlertDialog.Action>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
