/**
 * TASK-095 §5/§13/§14/§16/§17: секция «Защита паролем» экрана настроек. Состояние —
 * из vault/status (единый источник §12; общий ключ с гейтом App): выключено → кнопка
 * «Включить» с диалогом (новый пароль ×2 + обязательный чекбокс-предупреждение —
 * без него кнопка мертва, NFR-2/AC-1); включено → смена (старый+новый), снять
 * (старый), выбор автоблока (5/15/60/выкл — prefs.autoLockMin, §5).
 *
 * Диалоги — Radix AlertDialog (прецедент BackupDialog 073: опасное действие, Esc/
 * отмена — безопасный дефолт). Ошибки канала — инлайн в диалоге (§10): неверный
 * старый пароль (VAULT/WRONG_PASSPHRASE) → «Неверный текущий пароль» (§13); прочие —
 * общий текст повтора. Предупреждение о невосстановимости — обязательный текст
 * (NFR-2, golden-тест «невосстановим»). После set/remove — инвалидация ['vault-status']:
 * секция перечитывает режим (§12 — сервер-источник). Пароли живут только в состоянии
 * формы и уходят только в канал (§14).
 */
import * as AlertDialog from '@radix-ui/react-alert-dialog';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { APP_INTERNAL_ERROR, type AppErrorDto, type Prefs } from '@hl/contracts';

import { call } from '../../../src/lib/ipc';
import { usePreferences } from '../../settings/model/use-preferences';
import { VAULT_STATUS_QUERY_KEY, useVaultStatus } from '../api/use-lock-gate';

/** Род действий диалога (§5: включение/смена/снятие). */
type PassphraseDialogKind = 'set' | 'change' | 'remove';

/** Значения select автоблока — порог prefs (мин; 0 — выкл, §5/§13 094). */
const AUTOLOCK_OPTIONS: readonly {
  readonly value: Prefs['autoLockMin'];
  readonly labelKey: string;
}[] = [
  { value: 5, labelKey: 'security.autolock.min' },
  { value: 15, labelKey: 'security.autolock.min' },
  { value: 60, labelKey: 'security.autolock.min' },
  { value: 0, labelKey: 'security.autolock.off' },
];

/** Секция «Защита паролем» (§5). */
export function SecuritySettings(): JSX.Element {
  const { t } = useTranslation();
  const { data: status } = useVaultStatus();
  const { prefs, setPreferences } = usePreferences();
  const [dialog, setDialog] = useState<PassphraseDialogKind | null>(null);
  const mode = status?.mode;

  return (
    <section
      aria-labelledby="security-section-title"
      data-testid="security-section"
      className="mt-6"
    >
      <h2 id="security-section-title" className="mb-2 text-base font-medium">
        {t('security.sectionTitle')}
      </h2>
      {mode === 'none' ? (
        <div className="flex items-center justify-between gap-4 rounded-md border border-border p-3">
          <p className="text-sm text-accent">{t('security.statusOff')}</p>
          <button
            type="button"
            data-testid="security-enable"
            onClick={() => setDialog('set')}
            className="min-h-11 shrink-0 rounded-md border border-border bg-bg px-4 text-base font-semibold text-text"
          >
            {t('security.enable')}
          </button>
        </div>
      ) : mode === 'passphrase' ? (
        <div className="flex flex-col gap-3 rounded-md border border-border p-3">
          <p className="text-sm text-accent">{t('security.statusOn')}</p>
          <div className="flex flex-wrap gap-3">
            <button
              type="button"
              data-testid="security-change"
              onClick={() => setDialog('change')}
              className="min-h-11 rounded-md border border-border bg-bg px-4 text-base font-semibold text-text"
            >
              {t('security.change')}
            </button>
            <button
              type="button"
              data-testid="security-remove"
              onClick={() => setDialog('remove')}
              className="min-h-11 rounded-md border border-border bg-bg px-4 text-base font-semibold text-text"
            >
              {t('security.remove')}
            </button>
          </div>
          <div>
            <label htmlFor="security-autolock" className="block text-sm text-accent">
              {t('security.autolock.label')}
            </label>
            <select
              id="security-autolock"
              value={prefs?.autoLockMin ?? 5}
              onChange={(event) => {
                // Значение — только из реестра опций (порог 0|5|15|60, §5).
                const next = AUTOLOCK_OPTIONS.find(
                  (option) => option.value === Number(event.target.value),
                )?.value;
                if (next !== undefined) {
                  setPreferences.mutate({ autoLockMin: next });
                }
              }}
              className="mt-1 min-h-11 rounded-md border border-border bg-transparent px-3 py-2 text-base text-text"
            >
              {AUTOLOCK_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {t(option.labelKey, { min: option.value })}
                </option>
              ))}
            </select>
            <p className="mt-1 text-sm text-accent">{t('security.autolock.hint')}</p>
          </div>
        </div>
      ) : null}
      {dialog !== null ? <PassphraseDialog kind={dialog} onClose={() => setDialog(null)} /> : null}
    </section>
  );
}

/** Props диалога управления паролем: род действия + закрытие владельцем. */
interface PassphraseDialogProps {
  readonly kind: PassphraseDialogKind;
  readonly onClose: () => void;
}

/** Форма диалога (§5: set — новый ×2 + чекбокс; change — старый+новый; remove — старый). */
interface DialogForm {
  readonly newPass: string;
  readonly newRepeat: string;
  readonly old: string;
  readonly confirmed: boolean;
}

/** Диалог включения/смены/снятия пароля (§5, прецедент BackupDialog). */
function PassphraseDialog({ kind, onClose }: PassphraseDialogProps): JSX.Element {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [form, setForm] = useState<DialogForm>({
    newPass: '',
    newRepeat: '',
    old: '',
    confirmed: false,
  });
  const [formError, setFormError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: async (): Promise<{ mode: 'none' | 'passphrase' }> => {
      const payload =
        kind === 'set'
          ? { action: 'set' as const, pass: form.newPass }
          : kind === 'change'
            ? { action: 'change' as const, old: form.old, new: form.newPass }
            : { action: 'remove' as const, old: form.old };
      const result = await call('vault/set-passphrase', payload);
      if (!result.ok) {
        throw new PassphraseError(result.error);
      }
      return result.data;
    },
    onSuccess: () => {
      // Режим сменился — секция перечитывает vault/status (§12, сервер-источник).
      void queryClient.invalidateQueries({ queryKey: VAULT_STATUS_QUERY_KEY });
      onClose();
    },
    onError: (error: unknown) => {
      const dto = error instanceof PassphraseError ? error.dto : APP_INTERNAL_ERROR;
      setFormError(
        dto.code === 'VAULT/WRONG_PASSPHRASE'
          ? t('security.passphrase.wrongOld')
          : t('security.passphrase.saveError'),
      );
    },
  });

  /** Сабмит: клиентские проверки ДО канала (§19-прецедент BackupDialog). */
  function handleSubmit(event: React.FormEvent): void {
    event.preventDefault();
    setFormError(null);
    if (kind === 'set') {
      if (form.newPass.length === 0 || form.newRepeat.length === 0) {
        setFormError(t('security.passphrase.emptyError'));
        return;
      }
      if (form.newPass !== form.newRepeat) {
        setFormError(t('security.passphrase.mismatchError'));
        return;
      }
    }
    if (kind !== 'set' && form.old.length === 0) {
      setFormError(t('security.passphrase.emptyError'));
      return;
    }
    mutation.mutate();
  }

  // Чекбокс-гейт включения (§5/AC-1): без подтверждения предупреждения кнопка мертва.
  const submitDisabled =
    mutation.isPending ||
    (kind === 'set' && form.newPass.length === 0) ||
    (kind === 'set' && !form.confirmed);

  const title =
    kind === 'set'
      ? t('security.passphrase.setTitle')
      : kind === 'change'
        ? t('security.passphrase.changeTitle')
        : t('security.passphrase.removeTitle');

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
          data-testid="security-dialog"
          className="fixed left-1/2 top-1/2 w-[min(26rem,calc(100vw-2rem))] max-h-[calc(100vh-2rem)] -translate-x-1/2 -translate-y-1/2 overflow-auto rounded-lg border border-border bg-bg p-6 shadow-lg"
        >
          <AlertDialog.Title className="text-lg font-semibold text-text">{title}</AlertDialog.Title>
          <AlertDialog.Description asChild>
            <p className="mt-2 text-sm text-text">
              {kind === 'set'
                ? t('security.passphrase.setDescription')
                : kind === 'change'
                  ? t('security.passphrase.changeDescription')
                  : t('security.passphrase.removeDescription')}
            </p>
          </AlertDialog.Description>

          <div className="mt-4 flex flex-col gap-3">
            {kind !== 'set' ? (
              <div className="flex flex-col gap-1">
                <label htmlFor="security-pass-old" className="text-sm font-medium text-text">
                  {t('security.passphrase.oldLabel')}
                </label>
                <input
                  id="security-pass-old"
                  type="password"
                  autoComplete="current-password"
                  value={form.old}
                  onChange={(event) => setForm({ ...form, old: event.target.value })}
                  className="min-h-11 rounded-md border border-border bg-bg px-3 text-base text-text"
                />
              </div>
            ) : null}
            {kind !== 'remove' ? (
              <>
                <div className="flex flex-col gap-1">
                  <label htmlFor="security-pass-new" className="text-sm font-medium text-text">
                    {t('security.passphrase.newLabel')}
                  </label>
                  <input
                    id="security-pass-new"
                    type="password"
                    autoComplete="new-password"
                    value={form.newPass}
                    onChange={(event) => setForm({ ...form, newPass: event.target.value })}
                    className="min-h-11 rounded-md border border-border bg-bg px-3 text-base text-text"
                  />
                </div>
                {kind === 'set' ? (
                  <div className="flex flex-col gap-1">
                    <label htmlFor="security-pass-repeat" className="text-sm font-medium text-text">
                      {t('security.passphrase.newRepeatLabel')}
                    </label>
                    <input
                      id="security-pass-repeat"
                      type="password"
                      autoComplete="new-password"
                      value={form.newRepeat}
                      onChange={(event) => setForm({ ...form, newRepeat: event.target.value })}
                      className="min-h-11 rounded-md border border-border bg-bg px-3 text-base text-text"
                    />
                  </div>
                ) : null}
              </>
            ) : null}

            {/* Обязательное предупреждение о невосстановимости (NFR-2, §14; golden-тест). */}
            {kind === 'set' ? (
              <>
                <p
                  data-testid="security-warning"
                  className="rounded-md border border-border bg-accent/10 p-3 text-sm font-medium text-text"
                  role="note"
                >
                  {t('security.passphrase.warning')}
                </p>
                <div className="flex items-start gap-2">
                  <input
                    id="security-pass-confirm"
                    type="checkbox"
                    checked={form.confirmed}
                    onChange={(event) => setForm({ ...form, confirmed: event.target.checked })}
                    className="mt-1 h-4 w-4"
                  />
                  <label htmlFor="security-pass-confirm" className="text-sm font-medium text-text">
                    {t('security.passphrase.checkbox')}
                  </label>
                </div>
              </>
            ) : null}

            {formError !== null ? (
              <p
                data-testid="security-dialog-error"
                role="alert"
                className="text-sm font-medium text-text"
              >
                {formError}
              </p>
            ) : null}
          </div>

          <div className="mt-6 flex flex-wrap justify-end gap-3">
            <AlertDialog.Cancel asChild>
              <button
                type="button"
                data-testid="security-dialog-cancel"
                className="min-h-11 rounded-md border border-border bg-bg px-6 text-base font-semibold text-text"
              >
                {t('security.passphrase.cancel')}
              </button>
            </AlertDialog.Cancel>
            <button
              type="button"
              data-testid="security-dialog-submit"
              disabled={submitDisabled}
              aria-busy={mutation.isPending}
              onClick={handleSubmit}
              className="min-h-11 rounded-md bg-accent px-6 text-base font-semibold text-bg disabled:cursor-not-allowed disabled:opacity-80"
            >
              {t('security.passphrase.submit')}
            </button>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}

/** Отказ канала с DTO (конверт ok:false) — для разбора кода в onError. */
class PassphraseError extends Error {
  readonly dto: AppErrorDto;

  constructor(dto: AppErrorDto) {
    super(`vault/set-passphrase: ${dto.code}`);
    this.name = 'PassphraseError';
    this.dto = dto;
  }
}
