/**
 * TASK-095 §5/§10/§13/§16: полноэкранный оверлей блокировки. Показывается гейтом в
 * App, когда mode=passphrase и сессия locked (старт или lock:engaged); рендерится
 * ВНЕ роутера — маршруты при locked не монтируются (§14: контента под оверлеем нет
 * в DOM вообще — строже aria-hidden/inert, стридер не услышит ни байта данных).
 *
 * Поведение (§5/§13): поле пароля (type=password, Enter=unlock), кнопка
 * «Разблокировать» с состоянием «Проверка…» (~0,5 с Argon2 — честный индикатор);
 * неверный пароль → инлайн «Неверный пароль» (§16: aria-invalid + describedby +
 * фокус на поле); окно backoff → кнопка disabled с live-отсчётом «Подождите N с»
 * (начальный backoffSec — из vault/status при перезапуске в окне, §12; после
 * VAULT/RATE_LIMITED — params.backoffSec конверта отказа, §17 094). Esc ничего не
 * делает — безопасного действия нет, блок обязателен (§16). Данные формы живут
 * только в состоянии и уходят только в канал (§14).
 */
import { useMutation } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { APP_INTERNAL_ERROR, type AppErrorDto } from '@hl/contracts';

import { call } from '../../../src/lib/ipc';
import { useVaultStatus } from '../api/use-lock-gate';

/** Props: колбэк успеха (гейт App снимает оверлей — §13). */
export interface LockOverlayProps {
  /** Успешный unlock — переключить фазу гейта в open (мгновенно, §13). */
  readonly onUnlocked: () => void;
}

/** Оверлей блокировки (§5). Полноэкранный, непрозрачный (§10). */
export function LockOverlay({ onUnlocked }: LockOverlayProps): JSX.Element {
  const { t } = useTranslation();
  const { data: status } = useVaultStatus();
  const inputRef = useRef<HTMLInputElement>(null);
  const [pass, setPass] = useState('');
  const [errorText, setErrorText] = useState<string | null>(null);
  // Окно backoff для UI (сек); null — окна нет. Источники — статус сервера и
  // конверт VAULT/RATE_LIMITED (§12/§17); тикает локально (§14: UI-таймер не
  // доверенный — решение о разблокировке всегда за main).
  const [backoffSec, setBackoffSec] = useState<number | null>(null);

  // Перезапуск в окне backoff: начальный отсчёт — из статуса (§12/§13).
  useEffect(() => {
    if (status?.backoffSec !== undefined) {
      setBackoffSec(status.backoffSec);
    }
  }, [status?.backoffSec]);

  // Live-отсчёт (§13: disabled кнопка с «Подождите N с»): тик раз в секунду.
  useEffect(() => {
    if (backoffSec === null || backoffSec <= 0) {
      return undefined;
    }
    const timer = setTimeout(() => {
      setBackoffSec((current) => (current === null ? null : current - 1));
    }, 1_000);
    return () => clearTimeout(timer);
  }, [backoffSec]);

  const unlock = useMutation({
    mutationFn: async (pass: string): Promise<{ ok: true }> => {
      const result = await call('vault/unlock', { pass });
      if (!result.ok) {
        throw new UnlockError(result.error);
      }
      return result.data;
    },
    onSuccess: () => {
      onUnlocked();
    },
    onError: (error: unknown) => {
      const dto = error instanceof UnlockError ? error.dto : APP_INTERNAL_ERROR;
      if (dto.code === 'VAULT/RATE_LIMITED') {
        const sec = dto.params?.backoffSec;
        setBackoffSec(typeof sec === 'number' && sec >= 1 ? Math.ceil(sec) : 1);
        setErrorText(null);
      } else {
        // §5/§17: неверный пароль (и прочие отказы) — один инлайн-текст оверлея.
        setErrorText(t('lock.wrong'));
      }
      inputRef.current?.focus();
    },
  });

  const waiting = backoffSec !== null && backoffSec > 0;
  const buttonLabel = unlock.isPending
    ? t('lock.checking')
    : waiting
      ? t('lock.wait', { sec: backoffSec })
      : t('lock.unlock');

  /** Сабмит (Enter или кнопка): пустой ввод не отправляется, §5 (схема min 1). */
  function handleSubmit(event: React.FormEvent): void {
    event.preventDefault();
    if (unlock.isPending || waiting || pass.length === 0) {
      return;
    }
    unlock.mutate(pass);
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="lock-title"
      data-testid="lock-overlay"
      className="flex h-screen w-full flex-col items-center justify-center bg-bg p-4"
    >
      {/* Замок-иконка по центру (§10); декоративная — текст заголовка достаточен. */}
      <svg
        aria-hidden="true"
        viewBox="0 0 24 24"
        className="mb-3 h-10 w-10 text-accent"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
      >
        <rect x="5" y="11" width="14" height="9" rx="2" />
        <path d="M8 11V7a4 4 0 1 1 8 0v4" />
        <circle cx="12" cy="15.5" r="1.5" fill="currentColor" stroke="none" />
      </svg>
      <h1 id="lock-title" className="hl-large-title text-text">
        {t('lock.title')}
      </h1>
      <p className="mt-1 text-sm text-accent">{t('lock.subtitle')}</p>

      <form onSubmit={handleSubmit} className="mt-6 flex w-full max-w-xs flex-col gap-3">
        <label htmlFor="lock-pass" className="text-sm font-medium text-text">
          {t('lock.passLabel')}
        </label>
        <input
          id="lock-pass"
          ref={inputRef}
          data-testid="lock-pass"
          type="password"
          autoComplete="current-password"
          autoFocus
          value={pass}
          onChange={(event) => setPass(event.target.value)}
          aria-invalid={errorText === null ? undefined : 'true'}
          aria-describedby={errorText === null ? undefined : 'lock-error'}
          className="min-h-11 rounded-[10px] bg-fill px-3 text-base text-text"
        />
        {errorText !== null ? (
          <p
            id="lock-error"
            data-testid="lock-error"
            role="alert"
            className="text-sm font-medium text-text"
          >
            {errorText}
          </p>
        ) : null}
        {waiting ? (
          // §16: отсчёт — aria-live polite; текст дублирует подпись кнопки.
          <p
            data-testid="lock-wait"
            aria-live="polite"
            role="status"
            className="text-sm text-accent"
          >
            {t('lock.wait', { sec: backoffSec })}
          </p>
        ) : null}
        <button
          type="submit"
          data-testid="lock-unlock"
          disabled={unlock.isPending || waiting}
          aria-busy={unlock.isPending}
          className="mt-2 flex min-h-11 items-center justify-center gap-2 rounded-xl bg-accent px-6 text-base font-semibold text-bg disabled:cursor-not-allowed disabled:opacity-90"
        >
          {unlock.isPending ? <Spinner /> : null}
          {buttonLabel}
        </button>
      </form>
    </div>
  );
}

/** Отказ канала с DTO (конверт ok:false) — для разбора кода в onError. */
class UnlockError extends Error {
  readonly dto: AppErrorDto;

  constructor(dto: AppErrorDto) {
    super(`vault/unlock: ${dto.code}`);
    this.name = 'UnlockError';
    this.dto = dto;
  }
}

/** Спиннер кнопки «Проверка…» (§5: честный индикатор Argon2; декоративный, §16). */
function Spinner(): JSX.Element {
  return (
    <span
      aria-hidden="true"
      className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent"
    />
  );
}
