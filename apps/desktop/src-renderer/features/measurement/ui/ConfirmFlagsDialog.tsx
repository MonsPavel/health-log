/**
 * TASK-032 §5/§10/§13/§16: модальный поток «Проверьте значения» после сохранения
 * с флагами (UC-01 A1/A2): подсказки из флагов ответа add — typo («Обычно около
 * {{median}}…»), duplicate («Такая запись уже есть…»); кнопки «Оставить» (безопасное)
 * / «Удалить и исправить» (удаление + возврат в форму — оркестрация в MeasurementForm).
 *
 * TASK-041 §5: при criticalValue сокращённая секция срочности ЗАМЕНЕНА компонентом
 * CriticalPanel (полный текст FR-7.4 + номера служб по локали): значения записи
 * приходят через criticalValues (из ответа add — measurement.sys/dia); «Понятно,
 * скрыть» скрывает панель в пределах ЭТОЙ записи (локальный state диалога — §10/§12;
 * диалог монтируется заново на новую запись — панель показывается каждый раз, §13).
 *
 * КОМБИНАЦИИ (§13): typo+duplicate — одна карточка с двумя строками (не два диалога);
 * criticalValue + typo — обе секции, срочность первой.
 *
 * ДОСТУПНОСТЬ (§10/§16): примитив Radix Dialog — фокус-ловушка и возврат фокуса из
 * коробки (арх. 06: «Модальности — Radix Dialog с ловушкой фокуса»); role="dialog" +
 * aria-labelledby (Dialog.Title) + aria-describedby (Dialog.Description → блок
 * подсказок); Esc/оверлей = закрытие → onKeep — безопасное действие по умолчанию
 * (§22: привычка «жать Enter/Esc» проскакивает диалог — лучше лишняя запись, чем
 * потерянная); опасная кнопка не получает автофокус (Radix фокусирует контейнер,
 * первый Tab ведёт к «Оставить» — она первая в таб-порядке).
 *
 * ПРОПСЫ (§19): компонент презентационный — delete-вызов и возврат значений в форму
 * делает владелец (MeasurementForm): onKeep — запись остаётся; onDeleteFix —
 * «Удалить и исправить».
 *
 * TASK-048 §13 (аудит крупного режима): контент уже с max-height + внутренним
 * scroll (прецедент для DeleteConfirmDialog/discard); кнопочный ряд flex-wrap —
 * на масштабах 112/125% кнопки переносятся, не перекрываются.
 */
import * as Dialog from '@radix-ui/react-dialog';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { MeasurementFlags } from '@hl/contracts';

import { CriticalPanel } from '../../../components/critical-panel/CriticalPanel';

/** Props диалога: флаги ответа add + решения пользователя. */
export interface ConfirmFlagsDialogProps {
  /** Управляемая модальность (владеет форма — открывается при флагах в onSuccess). */
  readonly open: boolean;
  /** Флаги из ответа measurements/add (§5: typo/duplicate/criticalValue). */
  readonly flags: MeasurementFlags;
  /** «Оставить» — также Esc/клик по оверлею (безопасное действие по умолчанию). */
  readonly onKeep: () => void;
  /** «Удалить и исправить» — владелец вызывает measurements/delete и возвращает ввод. */
  readonly onDeleteFix: () => void;
  /** TASK-041 §5/§13: значения записи для панели критических ({sys}/{dia} в тексте). */
  readonly criticalValues?: { readonly sys: number; readonly dia: number };
}

/** Подписи полей typo-подсказки — литералы (§22: динамические ключи запрещены). */
const FIELD_LABEL_KEY: Readonly<
  Record<'sys' | 'dia', 'measurement.fields.sys' | 'measurement.fields.dia'>
> = {
  sys: 'measurement.fields.sys',
  dia: 'measurement.fields.dia',
};

/** Диалог подтверждений ввода (§2). */
export function ConfirmFlagsDialog({
  open,
  flags,
  onKeep,
  onDeleteFix,
  criticalValues,
}: ConfirmFlagsDialogProps): JSX.Element {
  const { t } = useTranslation();
  // TASK-041 §10/§12: dismiss панели — локальный state в пределах этой записи;
  // размонтирование диалога (закрытие/новая запись) сбрасывает его.
  const [criticalDismissed, setCriticalDismissed] = useState(false);

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        // Esc и клик по оверлею закрывают модальность → трактуем как «Оставить» (§10).
        if (!next) {
          onKeep();
        }
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/50" />
        <Dialog.Content
          data-testid="confirm-flags-dialog"
          className="fixed left-1/2 top-1/2 w-[min(28rem,calc(100vw-2rem))] max-h-[calc(100vh-2rem)] -translate-x-1/2 -translate-y-1/2 overflow-auto rounded-lg border border-border bg-bg p-6 shadow-lg"
        >
          <Dialog.Title className="text-lg font-semibold text-text">
            {t('measurement.dialog.flags.title')}
          </Dialog.Title>

          {/* §10: aria-describedby на блок подсказок — Radix связывает Description. */}
          <Dialog.Description asChild>
            <div className="mt-3 flex flex-col gap-2 text-base text-text">
              {flags.criticalValue !== undefined && !criticalDismissed && (
                <CriticalPanel
                  flag={flags.criticalValue}
                  onDismiss={() => setCriticalDismissed(true)}
                  sys={criticalValues?.sys}
                  dia={criticalValues?.dia}
                />
              )}
              {flags.typo !== undefined && (
                <p data-testid="hint-typo">
                  {t('measurement.dialog.typo.hint', {
                    median: flags.typo.median,
                    value: flags.typo.value,
                    field: t(FIELD_LABEL_KEY[flags.typo.field]),
                  })}
                </p>
              )}
              {flags.duplicate === true && (
                <p data-testid="hint-duplicate">{t('measurement.dialog.duplicate.hint')}</p>
              )}
            </div>
          </Dialog.Description>

          <div className="mt-6 flex flex-wrap justify-end gap-3">
            {/* Безопасное действие первым (§22): первый Tab и Enter-привычка ведут к нему. */}
            <button
              type="button"
              data-testid="dialog-keep"
              onClick={onKeep}
              className="min-h-11 rounded-md bg-accent px-6 text-base font-semibold text-bg"
            >
              {t('measurement.dialog.flags.keep')}
            </button>
            <button
              type="button"
              data-testid="dialog-delete-fix"
              onClick={onDeleteFix}
              className="min-h-11 rounded-md border border-border bg-bg px-6 text-base font-semibold text-text"
            >
              {t('measurement.dialog.flags.deleteFix')}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
