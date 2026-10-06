/**
 * TASK-101 §5/§10/§13/§16: полноэкранный режим восстановления — показывается
 * гейтом в App, когда контейнер стартовал в recovery (повреждение БД или провал
 * миграции; причина и детали — из app/meta, §7). Рендерится ВНЕ роутера —
 * маршруты не монтируются (прецедент LockOverlay 095: БД-каналы закрыты
 * STORAGE/RECOVERY_MODE, контента с данными нет в DOM вообще).
 *
 * Варианты (§5, порядок — риск §22: восстановление первично):
 *  - «Восстановить из копии» (основное действие): файл-пикер (file/open-dialog,
 *    фильтр .hlbackup) → пароль копии → backup/restore {recovery: true} (без фазы
 *    plan и без страховки — §8) → {restarting: true} — перезапуск планирует main.
 *    Неверный пароль → инлайн-retry (§13); копия новее схемы → объяснение (§13).
 *  - «Начать с чистого дневника»: двойное подтверждение — раскрытие с текстом
 *    необратимости + чекбокс-фраза (§13); data/discard-db → unlink db/-wal/-shm
 *    (копии/ключ/логи остаются — EC-14) → перезапуск.
 *  - «Технические детали» — <details>-раскрытие (не пугать, §16): причина,
 *    вывод quick_check, версия миграции — без путей/PHI (§14); для диагпакета 103.
 *  - «Открыть папку с копиями» — app/reveal-backups (fire-and-forget, §9).
 *
 * a11y (§16): объяснение role="alert" (обнаружение стартом, не действием),
 * крупный текст, один столбец; тон спокойный — golden-тест без паник-лексики (§17).
 */
import { useMutation } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { AppErrorDto, RecoveryContext } from '@hl/contracts';

import { call } from '../../../src/lib/ipc';

/** Фильтр open-диалога (§5: выбор файла копии .hlbackup; прецедент RestoreFlow 073). */
const BACKUP_FILE_FILTERS = [{ name: 'Health Log Backup', extensions: ['hlbackup'] }];

/** Props: контекст режима (причина + детали — из app/meta, §7). */
export interface RecoveryScreenProps {
  readonly recovery: RecoveryContext;
}

/** Отказ канала с DTO (конверт ok:false) — для разбора кода в onError (§12). */
class RecoveryError extends Error {
  readonly dto: AppErrorDto;

  constructor(dto: AppErrorDto) {
    super(`${dto.code}`);
    this.name = 'RecoveryError';
    this.dto = dto;
  }
}

/**
 * Экран восстановления (§5). Состояния формы живут в компоненте и уходят только
 * в каналы (§14); пароль копии не сохраняется (§14, прецедент LockOverlay).
 */
export function RecoveryScreen({ recovery }: RecoveryScreenProps): JSX.Element {
  const { t } = useTranslation();
  const inputRef = useRef<HTMLInputElement>(null);
  const [backupPath, setBackupPath] = useState<string | null>(null);
  const [passphrase, setPassphrase] = useState('');
  const [errorText, setErrorText] = useState<string | null>(null);
  const [discardConfirmed, setDiscardConfirmed] = useState(false);
  const [discardOpen, setDiscardOpen] = useState(false);

  // «Восстановить из копии» (§5/§13): recovery-выполнение без фазы plan.
  const restore = useMutation({
    mutationFn: async (command: {
      readonly file: string;
      readonly passphrase: string;
    }): Promise<{ restarting: true }> => {
      const result = await call('backup/restore', {
        recovery: true,
        file: command.file,
        passphrase: command.passphrase,
      });
      if (!result.ok) {
        throw new RecoveryError(result.error);
      }
      // Тип ответа канала — union двух форм 071; recovery-вызов возвращает ТОЛЬКО
      // {restarting: true} (фазы plan нет — §5): защитная проверка формы.
      if (!('restarting' in result.data)) {
        throw new Error('backup/restore: plan-форма недопустима в recovery-вызове');
      }
      return result.data;
    },
    onSuccess: () => {
      setErrorText(null);
    },
    onError: (error: unknown) => {
      const dto = error instanceof RecoveryError ? error.dto : undefined;
      if (dto?.code === 'BACKUP/WRONG_PASSPHRASE') {
        setErrorText(t('recovery.wrongPass'));
        setPassphrase('');
        inputRef.current?.focus();
        return;
      }
      if (dto?.code === 'BACKUP/DB_NEWER') {
        setErrorText(t('recovery.dbNewer'));
        return;
      }
      setErrorText(t('recovery.failed'));
    },
  });

  // «Начать заново» (§5/§13): unlink db/-wal/-shm + перезапуск (двойное
  // подтверждение — раскрытие + чекбокс-фраза, гард кнопки ниже).
  const discard = useMutation({
    mutationFn: async (): Promise<{ restarting: true }> => {
      const result = await call('data/discard-db', {});
      if (!result.ok) {
        throw new RecoveryError(result.error);
      }
      return result.data;
    },
    onSuccess: () => {
      setErrorText(null);
    },
    onError: () => {
      setErrorText(t('recovery.failed'));
    },
  });

  const restarting = restore.data !== undefined || discard.data !== undefined;

  /** Выбор файла копии (§5): путь приходит из диалога main (§14); отмена — тихо. */
  async function pickBackup(): Promise<void> {
    const result = await call('file/open-dialog', { filters: BACKUP_FILE_FILTERS });
    if (!result.ok) {
      setErrorText(t('recovery.failed'));
      return;
    }
    if ('canceled' in result.data) {
      return; // отмена диалога — ожидаемый исход, не ошибка (§7)
    }
    setBackupPath(result.data.path);
    setErrorText(null);
  }

  return (
    <div
      data-testid="recovery-screen"
      className="flex min-h-screen w-full flex-col items-center justify-center bg-bg p-4"
    >
      <div className="flex w-full max-w-md flex-col gap-3">
        <h1 className="hl-large-title text-text">{t('recovery.title')}</h1>
        {/* §16: объяснение — role=alert (старт в аварийном режиме, не действие). */}
        <p role="alert" data-testid="recovery-explain" className="text-base text-text">
          {t('recovery.explain')}
        </p>

        {restarting ? (
          <p
            data-testid="recovery-restart-note"
            role="status"
            aria-live="polite"
            className="text-base font-medium text-text"
          >
            {t('recovery.restarting')}
          </p>
        ) : (
          <>
            {/* (1) Восстановление — первичное действие (риск §22: первый в порядке). */}
            <section className="mt-2 flex flex-col gap-2 rounded-[10px] bg-surface p-3">
              <h2 className="text-base font-semibold text-text">{t('recovery.restoreTitle')}</h2>
              <p className="text-sm text-accent">{t('recovery.restoreHint')}</p>
              <button
                type="button"
                data-testid="recovery-restore-pick"
                onClick={() => {
                  void pickBackup();
                }}
                className="min-h-11 rounded-xl bg-fill px-4 text-base font-medium text-text hover:bg-accent/10"
              >
                {t('recovery.restorePick')}
              </button>
              {backupPath !== null ? (
                <>
                  <p
                    data-testid="recovery-restore-picked"
                    className="break-all text-sm text-accent"
                  >
                    {t('recovery.restorePicked', { file: backupPath })}
                  </p>
                  <label htmlFor="recovery-pass" className="text-sm font-medium text-text">
                    {t('recovery.restorePassLabel')}
                  </label>
                  <input
                    id="recovery-pass"
                    ref={inputRef}
                    data-testid="recovery-restore-pass"
                    type="password"
                    autoComplete="off"
                    value={passphrase}
                    onChange={(event) => setPassphrase(event.target.value)}
                    aria-invalid={errorText === null ? undefined : 'true'}
                    className="min-h-11 rounded-[10px] bg-fill px-3 text-base text-text"
                  />
                  <button
                    type="button"
                    data-testid="recovery-restore-submit"
                    disabled={restore.isPending || passphrase.length === 0}
                    aria-busy={restore.isPending}
                    onClick={() => {
                      if (backupPath !== null) {
                        restore.mutate({ file: backupPath, passphrase });
                      }
                    }}
                    className="flex min-h-11 items-center justify-center rounded-xl bg-accent px-6 text-base font-semibold text-bg disabled:cursor-not-allowed disabled:opacity-90"
                  >
                    {restore.isPending ? t('recovery.restoreRunning') : t('recovery.restoreSubmit')}
                  </button>
                </>
              ) : null}
            </section>

            {/* (2) «Начать заново» — ниже восстановления, с двойным подтверждением. */}
            <section className="flex flex-col gap-2 rounded-[10px] bg-surface p-3">
              <h2 className="text-base font-semibold text-text">{t('recovery.discardTitle')}</h2>
              {discardOpen ? (
                <>
                  <p className="text-sm text-accent">{t('recovery.discardHint')}</p>
                  <label className="flex items-start gap-2 text-sm text-text">
                    <input
                      type="checkbox"
                      data-testid="recovery-discard-checkbox"
                      checked={discardConfirmed}
                      onChange={(event) => setDiscardConfirmed(event.target.checked)}
                      className="hl-checkbox mt-0.5 h-5 w-5"
                    />
                    <span>{t('recovery.discardCheckbox')}</span>
                  </label>
                  <button
                    type="button"
                    data-testid="recovery-discard-execute"
                    disabled={!discardConfirmed || discard.isPending}
                    aria-busy={discard.isPending}
                    onClick={() => discard.mutate()}
                    className="min-h-11 rounded-xl bg-fill px-4 text-base font-semibold text-text disabled:cursor-not-allowed disabled:opacity-90"
                  >
                    {t('recovery.discardExecute')}
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  data-testid="recovery-discard-open"
                  onClick={() => setDiscardOpen(true)}
                  className="min-h-11 rounded-xl bg-fill px-4 text-base font-medium text-text hover:bg-accent/10"
                >
                  {t('recovery.discardTitle')}
                </button>
              )}
            </section>

            {/* (3) Технические детали — collapse (§16: не пугать; материал для diag 103). */}
            <details data-testid="recovery-details" className="rounded-[10px] bg-surface p-3">
              <summary className="cursor-pointer text-sm font-medium text-text">
                {t('recovery.detailsSummary')}
              </summary>
              <pre
                data-testid="recovery-details-text"
                className="mt-2 overflow-x-auto whitespace-pre-wrap break-words text-xs text-accent"
              >
                {t('recovery.detailsReason')}
                {': '}
                {recovery.reason === 'migration_failed'
                  ? t('recovery.detailsReasonMigrationFailed', {
                      version: recovery.details.migrationVersion ?? 0,
                    })
                  : t('recovery.detailsReasonCorrupt')}
                {recovery.details.quickCheck !== undefined
                  ? `\n${t('recovery.detailsQuickCheck')}:\n${recovery.details.quickCheck}`
                  : ''}
              </pre>
            </details>

            {/* (4) Папка с копиями — fire-and-forget (§9, прецедент app/reveal-path). */}
            <button
              type="button"
              data-testid="recovery-reveal-backups"
              onClick={() => {
                void call('app/reveal-backups', {});
              }}
              className="min-h-11 rounded-md px-4 text-base text-accent underline-offset-4 hover:underline"
            >
              {t('recovery.revealBackups')}
            </button>
          </>
        )}

        {errorText !== null ? (
          <p data-testid="recovery-error" role="alert" className="text-sm font-medium text-text">
            {errorText}
          </p>
        ) : null}
      </div>
    </div>
  );
}
