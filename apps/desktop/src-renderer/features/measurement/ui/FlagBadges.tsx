/**
 * TASK-042 §5/§10/§13/§16: бейджи флагов записи в строке журнала — компактные
 * «иконка + сокращение» с полным текстом в tooltip/aria-label:
 *  - critical ('high'|'low' — server-computed поле DTO TASK-042/политика TASK-020):
 *    кнопка (! для high, ↓ для low), клик открывает CriticalPanel (TASK-041)
 *    модально над списком — Radix Dialog (ловушка фокуса, арх. 06) со значениями
 *    записи и dismiss («Понятно, скрыть»/Esc закрывают, §10);
 *  - irregularPulse (поле записи): не-кнопка (~), tooltip «Неровный пульс:
 *    измерение может быть неточным» (EC-10) — панели нет (§5).
 *
 * ПУСТОЙ КЕЙС (§13): без флагов компонент не рендерит ничего (место не
 * резервируется — компактность; скринридер молчит). НЕ ТОЛЬКО ЦВЕТ (§13/§16):
 * иконки-формы попарно различны (! / ↓ / ~) — дальтонизм, паттерн TASK-057
 * заранее; критический бейдж — акцентная рамка (спокойный тон панели TASK-041,
 * не красный), irregular — нейтральный приглушённый.
 *
 * FLAGLEGEND (§5): легенда флагов — tooltip-обучающая строка над списком,
 * показывается владельцем (HistoryScreen) при наличии хоть одного флага.
 *
 * I18N (§17): ключи measurement.flags.* каталога фичи measurement; значения
 * записи — подстановки {sys}/{dia} в aria-label. Динамических ключей нет (§22)
 * — литеральные карты, прецедент FIELD_LABEL_KEY (TASK-032).
 */
import { useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useTranslation } from 'react-i18next';

import type { MeasurementDto } from '@hl/contracts';

import { CriticalPanel } from '../../../components/critical-panel/CriticalPanel';

/**
 * Props бейджей: флаги и значения читаются с записи (critical/irregularPulse/sys/dia).
 * TASK-059: структурное подмножество (Pick), а не полный MeasurementDto — таблица
 * динамики строит бейджи из сырой точки тренда (RawPoint несёт только эти поля);
 * полный DTO (журнал) удовлетворяет Pick без изменений вызовов.
 */
export interface FlagBadgesProps {
  readonly measurement: Pick<MeasurementDto, 'sys' | 'dia' | 'critical' | 'irregularPulse'>;
}

/** Сокращения критического бейджа — литералы (§22: динамических ключей нет). */
const CRITICAL_LABEL_KEY: Readonly<
  Record<'high' | 'low', 'measurement.flags.criticalHigh' | 'measurement.flags.criticalLow'>
> = {
  high: 'measurement.flags.criticalHigh',
  low: 'measurement.flags.criticalLow',
};

/** Полные aria-label'ы критического бейджа с подстановкой значений (§16/§17). */
const CRITICAL_ARIA_KEY: Readonly<
  Record<'high' | 'low', 'measurement.flags.criticalHighAria' | 'measurement.flags.criticalLowAria'>
> = {
  high: 'measurement.flags.criticalHighAria',
  low: 'measurement.flags.criticalLowAria',
};

/** Заголовки модальной панели по варианту — литералы (§22). */
const PANEL_TITLE_KEY: Readonly<
  Record<'high' | 'low', 'measurement.flags.panelTitleHigh' | 'measurement.flags.panelTitleLow'>
> = {
  high: 'measurement.flags.panelTitleHigh',
  low: 'measurement.flags.panelTitleLow',
};

/** Иконки-формы (§16: ! high, ↓ low — различимы без цвета, дальтонизм §13). */
const CRITICAL_ICON: Readonly<Record<'high' | 'low', string>> = {
  high: '!',
  low: '↓',
};

/**
 * Бейджи флагов записи (§5). Презентационный: флаги — с DTO; панель — CriticalPanel
 * со значениями записи; решение о скрытии — у пользователя через dismiss (§10).
 */
export function FlagBadges({ measurement }: FlagBadgesProps): JSX.Element | null {
  const { t } = useTranslation();
  const [panelOpen, setPanelOpen] = useState(false);
  const critical = measurement.critical;

  // §13: запись без флагов — бейджей нет, место не резервируется.
  if (critical === undefined && !measurement.irregularPulse) {
    return null;
  }

  return (
    <>
      {critical !== undefined && (
        <button
          type="button"
          data-testid="flag-critical"
          aria-label={t(CRITICAL_ARIA_KEY[critical], {
            sys: measurement.sys,
            dia: measurement.dia,
          })}
          title={t(CRITICAL_ARIA_KEY[critical], { sys: measurement.sys, dia: measurement.dia })}
          onClick={() => setPanelOpen(true)}
          className="flex min-h-11 shrink-0 items-center gap-1 rounded border border-accent px-2 text-xs font-semibold text-text hover:bg-accent/10"
        >
          <span aria-hidden="true" data-testid="flag-icon-critical" className="font-semibold">
            {CRITICAL_ICON[critical]}
          </span>
          {t(CRITICAL_LABEL_KEY[critical])}
        </button>
      )}
      {measurement.irregularPulse && (
        <span
          data-testid="flag-irregular"
          aria-label={t('measurement.flags.irregularAria')}
          title={t('measurement.flags.irregularAria')}
          className="flex items-center gap-1 text-xs text-muted"
        >
          <span aria-hidden="true" data-testid="flag-icon-irregular" className="font-semibold">
            ~
          </span>
          {t('measurement.flags.irregular')}
        </span>
      )}

      {/* §10: клик high/low-бейджа → CriticalPanel модально над списком, с dismiss. */}
      {critical !== undefined && (
        <Dialog.Root open={panelOpen} onOpenChange={setPanelOpen}>
          <Dialog.Portal>
            <Dialog.Overlay className="fixed inset-0 bg-black/50" />
            <Dialog.Content
              data-testid="flag-panel-dialog"
              className="fixed left-1/2 top-1/2 w-[min(28rem,calc(100vw-2rem))] max-h-[calc(100vh-2rem)] -translate-x-1/2 -translate-y-1/2 overflow-auto rounded-lg border border-border bg-bg p-6 shadow-lg"
            >
              <Dialog.Title className="hl-large-title text-text">
                {t(PANEL_TITLE_KEY[critical])}
              </Dialog.Title>
              <div className="mt-3">
                <CriticalPanel
                  flag={critical}
                  onDismiss={() => setPanelOpen(false)}
                  sys={measurement.sys}
                  dia={measurement.dia}
                />
              </div>
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>
      )}
    </>
  );
}

/**
 * Легенда флагов (§5): tooltip-обучающая строка над списком — расшифровка отметок
 * без открытия записей; title дублирует текст (§16: tooltip не единственный
 * носитель). Показывает владелец (HistoryScreen) при наличии хоть одного флага.
 */
export function FlagLegend(): JSX.Element {
  const { t } = useTranslation();

  return (
    <p
      data-testid="flag-legend"
      title={t('measurement.flags.legendTooltip')}
      className="mb-2 text-xs text-muted"
    >
      {t('measurement.flags.legend')}
    </p>
  );
}
