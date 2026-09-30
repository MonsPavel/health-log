/**
 * TASK-081 §10/§16/§17: карточка модели экрана «Модель» — презентационный
 * компонент (прецедент BackupReminderBanner: решение — владелец, ModelsScreen).
 *
 * СОСТОЯНИЯ (§5, машина 080 — тест-таблица §20 AC1): not_installed → «Скачать»;
 * downloading → «Пауза» + прогрессбар (aria-valuenow, §16); paused → «Продолжить»
 * + «Выбрать» и note-предложение продолжить (§13); verifying → «Проверка файла…»
 * (disabled); installed → «Выбрать» или бейдж «Выбрана»; error → текст по errorKey
 * каталога errors + «Сбросить ошибку» (reset → not_installed, §7 080). Удаление
 * модели — НЕТ в MVP (§5 РЕШЕНИЕ: диск чистится wipe'ом).
 *
 * ПРЕДУПРЕЖДЕНИЯ (§20 AC4, объясняющие — не пугающие/не блокирующие, §10):
 * язык модели ≠ язык интерфейса (FR-5.9) и ОЗУ машины < minRamGb (NFR-5) —
 * role="note", карточка остаётся рабочей.
 *
 * ДОСТУПНОСТЬ (§16): aria-label кнопок — полные («Продолжить загрузку модели
 * „N“, загружено 40%»); прогрессбар — roleprogressbar + valuenow/min/max.
 *
 * i18n (§17): ключи ai.models.*; размеры — Intl NumberFormat ru (ГБ/МБ, §17);
 * динамические ключи запрещены (§22) — errorKey из данных идёт через белый
 * словарь литералов, неизвестное — errors.internal.
 */
import { useTranslation } from 'react-i18next';

import type { ModelView } from '@hl/contracts';

/** Байт в ГиБ/МиБ (размеры моделей — степени двойки, как показывает ОС). */
const GIB = 2 ** 30;
const MIB = 2 ** 20;

/** Белый словарь errorKey → литеральные ключи каталога (§22: без динамических t()). */
const ERROR_TEXT_KEYS = {
  'errors.AI_DISK_FULL': 'errors.AI_DISK_FULL',
  'errors.AI_HASH_MISMATCH': 'errors.AI_HASH_MISMATCH',
  'errors.AI_DOWNLOAD_BUSY': 'errors.AI_DOWNLOAD_BUSY',
} as const;

/** Человекочитаемый размер (§17 Intl): ≥1 ГиБ — «2 ГБ» (1 знак), иначе целые «205 МБ». */
export function formatModelSize(bytes: number): string {
  const isGb = bytes >= GIB;
  const value = isGb ? bytes / GIB : bytes / MIB;
  const formatted = new Intl.NumberFormat('ru-RU', {
    maximumFractionDigits: isGb ? 1 : 0,
  }).format(value);
  return isGb ? `${formatted} ГБ` : `${formatted} МБ`;
}

/** Props карточки: витрина list-ответа + машина/язык + флаг выбора + колбэки владельца. */
export interface ModelCardProps {
  readonly view: ModelView;
  /** ОЗУ машины в ГБ (list-ответ §7) — для предупреждения NFR-5. */
  readonly ramTotalGb: number;
  /** Язык интерфейса (list-ответ §7) — для предупреждения FR-5.9. */
  readonly uiLanguage: string;
  /** Модель выбрана (prefs.aiSettings.modelId) — бейдж вместо кнопки «Выбрать». */
  readonly selected: boolean;
  /** Мутация в полёте — кнопки состояния отключены (двойной клик не двойнит). */
  readonly busy?: boolean;
  readonly onDownload: () => void;
  readonly onPause: () => void;
  readonly onResume: () => void;
  readonly onReset: () => void;
  readonly onSelect: () => void;
}

/** Карточка модели (§5). */
export function ModelCard({
  view,
  ramTotalGb,
  uiLanguage,
  selected,
  busy = false,
  onDownload,
  onPause,
  onResume,
  onReset,
  onSelect,
}: ModelCardProps): JSX.Element {
  const { t } = useTranslation();
  const { descriptor, state } = view;
  const size = formatModelSize(descriptor.sizeBytes);
  const percent =
    view.bytesLoaded === undefined || descriptor.sizeBytes === 0
      ? 0
      : Math.min(100, Math.round((view.bytesLoaded / descriptor.sizeBytes) * 100));
  const languages = descriptor.languages.join(', ');

  const warnLanguage = !descriptor.languages.includes(uiLanguage);
  const warnRam = ramTotalGb < descriptor.minRamGb;

  return (
    <article
      data-testid="model-card"
      aria-label={descriptor.name}
      className="mb-4 rounded-md border border-border p-4"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 data-testid="model-name" className="text-lg font-semibold text-text">
          {descriptor.name}
        </h3>
        <p className="text-sm text-accent">
          {t('ai.models.card.version', { version: descriptor.version })}
        </p>
      </div>

      <dl className="mt-2 grid gap-x-6 gap-y-1 text-sm text-neutral-700 sm:grid-cols-2 dark:text-neutral-300">
        <div className="flex gap-2">
          <dt className="sr-only">{t('ai.models.card.languages', { languages })}</dt>
          <dd data-testid="model-languages">{t('ai.models.card.languages', { languages })}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="sr-only">{t('ai.models.card.ram', { gb: descriptor.minRamGb })}</dt>
          <dd data-testid="model-ram">{t('ai.models.card.ram', { gb: descriptor.minRamGb })}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="sr-only">{size}</dt>
          <dd data-testid="model-size">{size}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="sr-only">
            {t('ai.models.card.license', { license: descriptor.license })}
          </dt>
          <dd data-testid="model-license">
            {t('ai.models.card.license', { license: descriptor.license })}
          </dd>
        </div>
      </dl>

      {/* Предупреждения — role=note, объясняющие, НЕ блокируют (§20 AC4, §16). */}
      {warnLanguage ? (
        <p
          data-testid="model-warn-language"
          role="note"
          className="mt-3 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-text dark:border-amber-500/40 dark:bg-amber-500/10"
        >
          {t('ai.models.warnings.language', { languages, uiLanguage })}
        </p>
      ) : null}
      {warnRam ? (
        <p
          data-testid="model-warn-ram"
          role="note"
          className="mt-3 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-text dark:border-amber-500/40 dark:bg-amber-500/10"
        >
          {t('ai.models.warnings.ram', { ram: ramTotalGb, required: descriptor.minRamGb })}
        </p>
      ) : null}

      {/* Прогресс (§10/§16): только для идущих состояний; aria-valuenow — процент. */}
      {state === 'downloading' || state === 'verifying' ? (
        <div className="mt-3">
          <div
            data-testid="model-progress"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
            aria-label={t('ai.models.progress.label', { name: descriptor.name })}
            className="h-2 w-full overflow-hidden rounded-full bg-neutral-200 dark:bg-neutral-700"
          >
            <div className="h-full bg-accent" style={{ width: `${String(percent)}%` }} />
          </div>
          <p className="mt-1 text-sm text-accent">
            <span data-testid="model-progress-percent">
              {t('ai.models.progress.percent', { percent })}
            </span>
            {state === 'downloading' && view.bytesLoaded !== undefined ? (
              <>
                {' · '}
                <span data-testid="model-progress-bytes">
                  {t('ai.models.progress.of', {
                    loaded: formatModelSize(view.bytesLoaded),
                    total: formatModelSize(descriptor.sizeBytes),
                  })}
                </span>
              </>
            ) : null}
          </p>
        </div>
      ) : null}

      {/* §13: paused — предложение продолжить перед выбором (note, не модальный). */}
      {state === 'paused' ? (
        <p
          data-testid="model-paused-note"
          role="note"
          className="mt-3 text-sm text-neutral-600 dark:text-neutral-300"
        >
          {t('ai.models.card.pausedNote')}
        </p>
      ) : null}

      {/* Текст терминальной ошибки — по errorKey каталога errors (§16–17). */}
      {state === 'error' ? (
        <p
          data-testid="model-error"
          role="note"
          className="mt-3 rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-text dark:border-red-500/40 dark:bg-red-500/10"
        >
          {t(ERROR_TEXT_KEYS[view.errorKey as keyof typeof ERROR_TEXT_KEYS] ?? 'errors.internal')}
        </p>
      ) : null}

      <div className="mt-4 flex flex-wrap gap-3">
        {state === 'not_installed' ? (
          <button
            type="button"
            data-testid="model-download"
            disabled={busy}
            aria-label={t('ai.models.aria.download', { name: descriptor.name, size })}
            onClick={onDownload}
            className="min-h-11 rounded-md bg-accent px-4 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50"
          >
            {t('ai.models.card.download')}
          </button>
        ) : null}
        {state === 'downloading' ? (
          <button
            type="button"
            data-testid="model-pause"
            disabled={busy}
            aria-label={t('ai.models.aria.pause', {
              name: descriptor.name,
              percent,
            })}
            onClick={onPause}
            className="min-h-11 rounded-md border border-border bg-bg px-4 text-sm font-semibold text-text hover:bg-neutral-100 disabled:opacity-50 dark:hover:bg-neutral-800"
          >
            {t('ai.models.card.pause')}
          </button>
        ) : null}
        {state === 'paused' ? (
          <button
            type="button"
            data-testid="model-resume"
            disabled={busy}
            aria-label={t('ai.models.aria.resume', {
              name: descriptor.name,
              percent,
            })}
            onClick={onResume}
            className="min-h-11 rounded-md bg-accent px-4 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50"
          >
            {t('ai.models.card.resume')}
          </button>
        ) : null}
        {state === 'verifying' ? (
          <button
            type="button"
            data-testid="model-checking"
            disabled
            className="min-h-11 rounded-md border border-border bg-bg px-4 text-sm font-semibold text-text opacity-70"
          >
            {t('ai.models.card.checking')}
          </button>
        ) : null}
        {state === 'error' ? (
          <button
            type="button"
            data-testid="model-reset"
            disabled={busy}
            aria-label={t('ai.models.aria.reset', { name: descriptor.name })}
            onClick={onReset}
            className="min-h-11 rounded-md border border-border bg-bg px-4 text-sm font-semibold text-text hover:bg-neutral-100 disabled:opacity-50 dark:hover:bg-neutral-800"
          >
            {t('ai.models.card.reset')}
          </button>
        ) : null}
        {state === 'installed' ? (
          selected ? (
            <span
              data-testid="model-selected-badge"
              className="inline-flex min-h-11 items-center rounded-md border border-accent bg-accent/10 px-4 text-sm font-semibold text-text"
            >
              {t('ai.models.card.selected')}
            </span>
          ) : (
            <button
              type="button"
              data-testid="model-select"
              disabled={busy}
              aria-label={t('ai.models.aria.select', { name: descriptor.name })}
              onClick={onSelect}
              className="min-h-11 rounded-md bg-accent px-4 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50"
            >
              {t('ai.models.card.select')}
            </button>
          )
        ) : null}
        {/* paused: «Выбрать» рядом с «Продолжить» — выбор возможен, но §13 предлагает
            сначала продолжить (note выше); удаление модели — НЕТ в MVP (§5). */}
        {state === 'paused' ? (
          <button
            type="button"
            data-testid="model-select"
            disabled={busy || selected}
            aria-label={t('ai.models.aria.select', { name: descriptor.name })}
            onClick={onSelect}
            className="min-h-11 rounded-md border border-border bg-bg px-4 text-sm font-semibold text-text hover:bg-neutral-100 disabled:opacity-50 dark:hover:bg-neutral-800"
          >
            {t('ai.models.card.select')}
          </button>
        ) : null}
      </div>
    </article>
  );
}
