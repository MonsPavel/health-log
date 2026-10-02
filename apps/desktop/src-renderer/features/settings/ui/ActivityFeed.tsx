/**
 * TASK-099 §5/§13/§15/§16: лента последних сетевых активностей «Приватности» —
 * чистая презентация записей канала privacy/journal (DTO 098): строки (дата-время
 * Intl, название операции, статус, объём КБ/МБ) и empty-состояние «Сетевых
 * активностей не было» (§5). Живость обеспечивает владелец (PrivacyScreen):
 * событие net:activity инвалидирует запрос — записи появляются мгновенно (§4,
 * эффект доверия BG-2); aria-live polite — на обёртке экрана (§16).
 *
 * СТАТУСЫ (§13/§16): ok (зелёная галочка), blocked (нейтральное «запрещено»),
 * failed (красная ошибка), running («выполняется» — жизненный цикл 075) —
 * различны текст, глиф и цвет (дальтонизм: не только цветом); aria-label —
 * полная формулировка статуса.
 *
 * НАЗВАНИЕ ОПЕРАЦИИ: по kind через белый словарь литералов (§22, прецедент
 * ModelCard ERROR_TEXT_KEYS; словарь — в OperationsList, projection каталога
 * одна); неизвестная операция — честный raw-kind, без выдуманных текстов.
 */
import { useTranslation } from 'react-i18next';

import type { NetworkEventDto, NetworkEventStatusDto } from '@hl/contracts';

import { formatDateTime } from '../../../lib/i18n-date';
import { operationTitleKey } from './OperationsList';

/** Вид статуса ленты (§13): глиф различен, цвет — класс, aria — полная метка (§16). */
const STATUS_VIEW: Readonly<
  Record<
    NetworkEventStatusDto,
    { readonly glyph: string; readonly className: string; readonly textKey: string; readonly labelKey: string }
  >
> = {
  ok: {
    glyph: '✓',
    className: 'text-green-700',
    textKey: 'privacy.feed.statusOk',
    labelKey: 'privacy.feed.statusOkFull',
  },
  blocked: {
    glyph: '⊘',
    className: 'text-accent',
    textKey: 'privacy.feed.statusBlocked',
    labelKey: 'privacy.feed.statusBlockedFull',
  },
  failed: {
    glyph: '✕',
    className: 'text-red-600',
    textKey: 'privacy.feed.statusFailed',
    labelKey: 'privacy.feed.statusFailedFull',
  },
  running: {
    glyph: '…',
    className: 'text-accent',
    textKey: 'privacy.feed.statusRunning',
    labelKey: 'privacy.feed.statusRunningFull',
  },
};

/** Байт → КБ/МБ (Intl ru, §5; лента — тела ответов, ГБ не бывает; прецедент formatModelSize). */
export function formatVolume(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  if (mb >= 1) {
    return `${new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 }).format(mb)} МБ`;
  }
  return `${new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 }).format(bytes / 1024)} КБ`;
}

/** Props ленты: записи канала privacy/journal (desc по at_utc — сортирует main, 075). */
export interface ActivityFeedProps {
  readonly entries: readonly NetworkEventDto[];
}

/** Лента сетевых активностей (§5): строки либо empty-состояние. */
export function ActivityFeed({ entries }: ActivityFeedProps): JSX.Element {
  const { t } = useTranslation();

  return (
    <section aria-labelledby="privacy-feed-title" data-testid="privacy-feed" className="mt-6">
      <h3 id="privacy-feed-title" className="mb-2 text-base font-medium">
        {t('privacy.feed.title')}
      </h3>
      {entries.length === 0 ? (
        <p
          data-testid="feed-empty"
          className="rounded-md border border-border p-3 text-sm text-accent"
        >
          {t('privacy.feed.empty')}
        </p>
      ) : (
        <ul data-testid="privacy-feed-list" className="flex flex-col gap-2">
          {entries.map((entry, index) => {
            const status = STATUS_VIEW[entry.status];
            const titleKey = operationTitleKey(entry.kind);
            return (
              <li
                key={`${entry.atUtc}-${index}`}
                data-testid="feed-row"
                className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-border p-3 text-sm"
              >
                {/* Настенное время строки журнала до минут (Intl, прецедент LastCheckRow). */}
                <span data-testid="feed-time" className="text-accent">
                  {formatDateTime(
                    { utcMs: entry.atUtc, tzOffsetMin: -new Date(entry.atUtc).getTimezoneOffset() },
                    { preset: 'datetime' },
                  )}
                </span>
                <span data-testid="feed-op" className="font-medium text-text">
                  {titleKey === undefined ? entry.kind : t(titleKey)}
                </span>
                <span
                  role="img"
                  data-testid="feed-status"
                  aria-label={t(status.labelKey)}
                  title={t(status.labelKey)}
                  className={`inline-flex items-center gap-1 font-medium ${status.className}`}
                >
                  <span aria-hidden="true">{status.glyph}</span>
                  {t(status.textKey)}
                </span>
                <span data-testid="feed-volume" className="text-accent">
                  {entry.bytes === undefined
                    ? t('privacy.feed.volumeNone')
                    : formatVolume(entry.bytes)}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
