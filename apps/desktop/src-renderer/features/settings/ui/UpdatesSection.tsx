/**
 * TASK-097 §2/§5/§10/§13/§16: секция «Обновления» экрана настроек. Статус-машина
 * снапшота (§7 096) → UI: idle — «Проверено: никогда/{время}»; checking — «Проверяем…»
 * (кнопка disabled, aria-busy); available — карточка version + «Скачать»; downloading
 * — прогресс из события update:progress (role=progressbar + процент текстом, §16 —
 * статус не только цветом); ready — «Установить и перезапустить» (§10: кнопка
 * появляется ТОЛЬКО в ready); latest/error — статус-текст, кнопка снова активна.
 *
 * СОГЛАСИЕ (§13): кнопка «Проверить» активна и без согласия, но ведёт к инлайн-
 * подсказке со ссылкой-указателем на раздел «Приватность» (§13 «не ошибка» —
 * дружелюбный маршрут включения); сам invoke — только при
 * prefs.netConsents.updatesCheck (мутации use-updates вызываются из гейта).
 * Установка — за confirm-диалогом (Radix AlertDialog, прецедент SecuritySettings:
 * «Приложение перезапустится», Esc/отмена — безопасный дефолт, AC4).
 *
 * ВЕРСИЯ (§5 упрощение): из userAgent (app-version.ts) — канал app/meta с полем
 * appVersion появится в TASK-100; нет хвоста — «—». БЕТА-КАНАЛ (§5): select disabled
 * с подписью «появится вместе с каналом beta» — включит TASK-107 (бейдж на Sidebar
 * НЕ делаем — §5 «шум», только секция). Статус-строка «Проверено: {время}» —
 * localStorage hl.updates.lastCheckAt (§5 «локальное состояние»).
 */
import * as AlertDialog from '@radix-ui/react-alert-dialog';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { formatDateTime } from '../../../lib/i18n-date';
import { readAppVersion } from '../model/app-version';
import { usePreferences } from '../model/use-preferences';
import {
  readLastCheckAtMs,
  useUpdatesCheck,
  useUpdatesDownload,
  useUpdatesInstall,
  useUpdatesStatus,
} from '../api/use-updates';

/** Секция «Обновления» (§5). */
export function UpdatesSection(): JSX.Element {
  const { t } = useTranslation();
  const { prefs } = usePreferences();
  const { data: status } = useUpdatesStatus();
  const check = useUpdatesCheck();
  const download = useUpdatesDownload();
  const install = useUpdatesInstall();
  const [hintShown, setHintShown] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const state = status?.state ?? 'idle';
  const version = status?.version;
  const progress = status?.progress ?? 0;
  const consentGiven = prefs?.netConsents.updatesCheck === true;
  // §10 статус-машина: проверка/скачивание — взаимно исключающие действия;
  // prefs ещё не загружены — гейт согласия неизвестен, кнопку ждём (disabled).
  const busy =
    state === 'checking' ||
    state === 'downloading' ||
    check.isPending ||
    download.isPending ||
    install.isPending;

  /** Клик «Проверить»: без согласия — подсказка (§13), с согласием — канал. */
  function handleCheckClick(): void {
    if (!consentGiven) {
      setHintShown(true);
      return;
    }
    check.mutate();
  }

  return (
    <section aria-labelledby="updates-section-title" data-testid="updates-section" className="mt-6">
      <h2 id="updates-section-title" className="mb-2 text-base font-medium">
        {t('updates.section')}
      </h2>
      <div className="flex flex-col gap-3 rounded-md border border-border p-3">
        {/* §5: текущая версия — UA-упрощение до app/meta (TASK-100); нет — «—». */}
        <p data-testid="updates-version" className="text-sm text-accent">
          {t('updates.version', { version: readAppVersion() ?? '—' })}
        </p>

        {/* Статус-область: aria-live — смена состояния озвучивается (§16). */}
        <div aria-live="polite" className="flex flex-col gap-3">
          {state === 'idle' || state === 'latest' || state === 'error' ? <LastCheckRow /> : null}
          {state === 'checking' ? (
            <p role="status" className="text-sm text-text">
              {t('updates.checking')}
            </p>
          ) : null}
          {state === 'latest' ? (
            <p role="status" className="text-sm text-text">
              {t('updates.latest')}
            </p>
          ) : null}
          {state === 'error' ? (
            <p role="status" className="text-sm text-red-600">
              {t('updates.error')}
            </p>
          ) : null}

          {/* Карточка доступного обновления (§5): version + «Скачать». */}
          {state === 'available' && version !== undefined ? (
            <div
              data-testid="updates-available-card"
              className="flex items-center justify-between gap-3 rounded-md border border-border p-3"
            >
              <p className="text-sm font-medium text-text">{t('updates.available', { version })}</p>
              <button
                type="button"
                data-testid="updates-download"
                disabled={download.isPending}
                aria-busy={download.isPending}
                onClick={() => download.mutate()}
                className="min-h-11 shrink-0 rounded-md border border-border bg-bg px-4 text-base font-semibold text-text"
              >
                {t('updates.download')}
              </button>
            </div>
          ) : null}

          {/* Скачивание: прогресс-бар aria (§16) + процент текстом (не только цвет). */}
          {state === 'downloading' ? (
            <div className="flex flex-col gap-1">
              <div
                role="progressbar"
                aria-label={t('updates.download')}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(progress)}
                className="h-2 w-full overflow-hidden rounded-full border border-border"
              >
                <div
                  className="h-full bg-accent"
                  style={{ width: `${Math.min(100, Math.max(0, progress))}%` }}
                />
              </div>
              <p data-testid="updates-progress-text" className="text-sm text-accent">
                {t('updates.downloading', { percent: Math.round(progress) })}
              </p>
            </div>
          ) : null}

          {/* Установка: только в ready (§10); за confirm-диалогом (§13). */}
          {state === 'ready' ? (
            <div
              data-testid="updates-ready-card"
              className="flex flex-col gap-2 rounded-md border border-border p-3"
            >
              <p className="text-sm font-medium text-text">
                {t('updates.ready', { version: version ?? '—' })}
              </p>
              <button
                type="button"
                data-testid="updates-install"
                disabled={install.isPending}
                aria-busy={install.isPending}
                onClick={() => setConfirmOpen(true)}
                className="min-h-11 rounded-md bg-accent px-4 text-base font-semibold text-bg disabled:cursor-not-allowed disabled:opacity-50"
              >
                {t('updates.install')}
              </button>
              {/* Отказ установки — инлайн-статус, повтор возможен (§10/§16). */}
              {install.isError ? (
                <p role="alert" className="text-sm text-red-600">
                  {t('updates.installError')}
                </p>
              ) : null}
            </div>
          ) : null}
        </div>

        <div>
          <button
            type="button"
            data-testid="updates-check"
            disabled={busy || prefs === undefined}
            aria-busy={busy}
            title={busy ? t('updates.busy') : undefined}
            onClick={handleCheckClick}
            className="min-h-11 rounded-md border border-border bg-bg px-4 text-base font-semibold text-text disabled:cursor-not-allowed disabled:opacity-50"
          >
            {t('updates.check')}
          </button>
          {/* §13: без согласия — подсказка (не ошибка): где включить сетевой доступ. */}
          {hintShown && !consentGiven ? (
            <p
              data-testid="updates-consent-hint"
              role="status"
              className="mt-2 text-sm text-accent"
            >
              {t('updates.consentHint')}
            </p>
          ) : null}
        </div>

        {/* §5: заготовка канала beta — TASK-107 включит select. */}
        <div>
          <label htmlFor="updates-beta-select" className="block text-sm text-accent">
            {t('updates.betaChannel')}
          </label>
          <select
            id="updates-beta-select"
            data-testid="updates-beta-select"
            disabled
            className="mt-1 min-h-11 rounded-md border border-border bg-transparent px-3 py-2 text-base text-text"
          >
            <option value="stable">{t('updates.betaStable')}</option>
            <option value="beta">{t('updates.betaBeta')}</option>
          </select>
          <p data-testid="updates-beta-soon" className="mt-1 text-sm text-accent">
            {t('updates.betaSoon')}
          </p>
        </div>
      </div>

      {confirmOpen ? (
        <InstallConfirmDialog
          pending={install.isPending}
          onConfirm={() => {
            setConfirmOpen(false);
            install.mutate();
          }}
          onClose={() => setConfirmOpen(false)}
        />
      ) : null}
    </section>
  );
}

/** Строка «Проверено: …» (§5): localStorage или «никогда». */
function LastCheckRow(): JSX.Element {
  const { t } = useTranslation();
  const lastCheckMs = readLastCheckAtMs();
  return (
    <p data-testid="updates-lastcheck" className="text-sm text-accent">
      {lastCheckMs === undefined
        ? t('updates.never')
        : t('updates.lastCheck', {
            time: formatDateTime(
              { utcMs: lastCheckMs, tzOffsetMin: -new Date(lastCheckMs).getTimezoneOffset() },
              { preset: 'datetime' },
            ),
          })}
    </p>
  );
}

/** Props confirm-диалога установки: подтверждение и закрытие (Esc/отмена). */
interface InstallConfirmDialogProps {
  readonly pending: boolean;
  readonly onConfirm: () => void;
  readonly onClose: () => void;
}

/**
 * Confirm установки (§13): «Приложение перезапустится» — приложение закроется;
 * Esc/отмена — ничего не происходит (AC4, безопасный дефолт Radix).
 */
function InstallConfirmDialog({
  pending,
  onConfirm,
  onClose,
}: InstallConfirmDialogProps): JSX.Element {
  const { t } = useTranslation();
  return (
    <AlertDialog.Root
      open
      onOpenChange={(next) => {
        if (!next) {
          onClose();
        }
      }}
    >
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="fixed inset-0 bg-black/50" />
        <AlertDialog.Content
          data-testid="updates-install-dialog"
          className="fixed left-1/2 top-1/2 w-[min(24rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-bg p-6 shadow-lg"
        >
          <AlertDialog.Title className="text-lg font-semibold text-text">
            {t('updates.restartTitle')}
          </AlertDialog.Title>
          <AlertDialog.Description asChild>
            <p className="mt-2 text-sm text-text">{t('updates.restartConfirm')}</p>
          </AlertDialog.Description>
          <div className="mt-6 flex flex-wrap justify-end gap-3">
            <AlertDialog.Cancel asChild>
              <button
                type="button"
                data-testid="updates-install-cancel"
                className="min-h-11 rounded-md border border-border bg-bg px-6 text-base font-semibold text-text"
              >
                {t('updates.cancel')}
              </button>
            </AlertDialog.Cancel>
            <button
              type="button"
              data-testid="updates-install-confirm"
              disabled={pending}
              aria-busy={pending}
              onClick={onConfirm}
              className="min-h-11 rounded-md bg-accent px-6 text-base font-semibold text-bg disabled:cursor-not-allowed disabled:opacity-50"
            >
              {t('updates.restartAccept')}
            </button>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
