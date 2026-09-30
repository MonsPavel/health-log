/**
 * TASK-081 §5/§13/§14: диалог согласия на загрузку модели — показывается ДО
 * первого сетевого запроса (UI-перехват раньше gateway-блока, §14). Текст —
 * честный объём ({{size}}) и РЕАЛЬНЫЙ домен из URL манифеста ({{host}}, §14:
 * не «интернет»); пометка об отзыве согласия в Приватности (согласие —
 * prefs.netConsents.modelsDownload, редактор — TASK-099).
 *
 * Radix Dialog (§16: фокус-ловушка и возврат фокуса из коробки); Esc/оверлей =
 * отказ — безопасное действие по умолчанию (сети не будет, §13). «Отмена» —
 * первая в таб-порядке; решение принимает владелец (ModelsScreen) — компонент
 * презентационный (§5).
 */
import * as Dialog from '@radix-ui/react-dialog';
import { useTranslation } from 'react-i18next';

import type { ModelDescriptor } from '@hl/contracts';

import { formatModelSize } from './ModelCard';

/** Props диалога: целевая модель (null — закрыт) + решения пользователя. */
export interface ConsentDialogProps {
  /** Модель, на загрузку которой запрашивается согласие; null — диалог закрыт. */
  readonly target: ModelDescriptor | null;
  /** «Разрешить и скачать» — владелец пишет согласие в prefs и запускает download. */
  readonly onConfirm: () => void;
  /** Любое закрытие без согласия (Esc/«Отмена»/оверлей) — сети не будет (§13). */
  readonly onClose: () => void;
}

/** Диалог согласия на загрузку модели (§14). */
export function ConsentDialog({ target, onConfirm, onClose }: ConsentDialogProps): JSX.Element {
  const { t } = useTranslation();

  return (
    <Dialog.Root
      open={target !== null}
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/50" />
        <Dialog.Content
          data-testid="consent-dialog"
          className="fixed left-1/2 top-1/2 w-[min(24rem,calc(100vw-2rem))] max-h-[calc(100vh-2rem)] -translate-x-1/2 -translate-y-1/2 overflow-auto rounded-lg border border-border bg-bg p-6 shadow-lg"
        >
          <Dialog.Title className="text-lg font-semibold text-text">
            {t('ai.models.consent.title')}
          </Dialog.Title>

          <Dialog.Description asChild>
            <p data-testid="consent-body" className="mt-3 text-base text-text">
              {target === null
                ? null
                : t('ai.models.consent.body', {
                    size: formatModelSize(target.sizeBytes),
                    host: new URL(target.url).host,
                  })}
            </p>
          </Dialog.Description>

          <p className="mt-2 text-sm text-accent">{t('ai.models.consent.revoke')}</p>

          <div className="mt-6 flex flex-wrap justify-end gap-3">
            {/* Безопасное действие — «Отмена»: первая в таб-порядке (§16). */}
            <Dialog.Close asChild>
              <button
                type="button"
                data-testid="consent-cancel"
                className="min-h-11 rounded-md border border-border bg-bg px-6 text-base font-semibold text-text"
              >
                {t('ai.models.consent.cancel')}
              </button>
            </Dialog.Close>
            <button
              type="button"
              data-testid="consent-confirm"
              onClick={onConfirm}
              className="min-h-11 rounded-md bg-accent px-6 text-base font-semibold text-bg"
            >
              {t('ai.models.consent.confirm')}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
