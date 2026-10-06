/**
 * TASK-099 §5/§10/§13/§16/§17: список сетевых операций «Приватности» — чистая
 * презентация ops канала privacy/journal (098: генерация main'ом из
 * EgressPolicy.ALLOWED — «ops == политике»). Строка: название + описание
 * «зачем» (описание — по descriptionKey из DTO через белый словарь литералов:
 * динамические ключи запрещены §22, прецедент ModelCard ERROR_TEXT_KEYS) и
 * переключатель согласия — switch-паттерн aria-checked (§16).
 *
 * ПЕРЕКЛЮЧЕНИЕ (§5/§10): включение — мгновенно onToggle (optimistic); отключение —
 * за confirm-диалогом (Radix AlertDialog, прецедент UpdatesSection):
 * «Загрузка моделей станет недоступна» (golden §5); отмена/Esc — безопасный
 * дефолт (ничего не меняется). БЛОКИРОВКА (§13/§10): при активной загрузке
 * модели переключатель modelsDownload disabled с tooltip «идёт загрузка» —
 * согласие не отзывается до конца загрузки (владелец считает состояние из
 * ModelStore — use-ai-models, ai:progress).
 *
 * ЗНАЧЕНИЕ ПЕРЕКЛЮЧАТЕЛЯ (§12): документ согласий privacy/consents (optimistic-
 * кэш мутации use-privacy — мгновенное применение и откат), op.enabled —
 * фолбэк до загрузки документа. Неизвестные op/consentKey (политика расширена
 * раньше каталога) — честный raw-name, описания нет, patch — no-op {}
 * (strict-схема 098 отвергла бы неизвестный ключ, §14).
 */
import * as AlertDialog from '@radix-ui/react-alert-dialog';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { Consents, OperationInfo, PrivacyConsentsPatch } from '@hl/contracts';

/** Белый словарь op → литеральный ключ названия каталога (§22; прецедент ModelCard). */
const OP_TITLE_KEYS: Readonly<Record<string, string>> = {
  'models.download': 'privacy.ops.models_download_title',
  'updates.check': 'privacy.ops.updates_check_title',
};

/** Литеральный ключ названия операции (§22); неизвестная — undefined (UI покажет raw-op). */
export function operationTitleKey(op: string): string | undefined {
  return OP_TITLE_KEYS[op];
}

/** Белый словарь descriptionKey из DTO → литеральный ключ описания «зачем» (§22). */
const OP_DESCRIPTION_KEYS: Readonly<Record<string, string>> = {
  'privacy.ops.models_download': 'privacy.ops.models_download',
  'privacy.ops.updates_check': 'privacy.ops.updates_check',
};

/** Белый словарь consentKey → литеральный ключ предупреждения отключения (§5 confirm). */
const OP_OFF_WARNING_KEYS: Readonly<Record<string, string>> = {
  modelsDownload: 'privacy.ops.models_download_offWarning',
  updatesCheck: 'privacy.ops.updates_check_offWarning',
};

/** Patch канала privacy/consents строго по известным ключам (§14 098); неизвестный — no-op. */
export function toConsentPatch(consentKey: string, value: boolean): PrivacyConsentsPatch {
  if (consentKey === 'modelsDownload') {
    return { modelsDownload: value };
  }
  if (consentKey === 'updatesCheck') {
    return { updatesCheck: value };
  }
  return {};
}

/** Значение согласия: документ (optimistic, §12); до загрузки — фолбэк op.enabled. */
function consentEnabled(consents: Consents | undefined, op: OperationInfo): boolean {
  if (consents === undefined) {
    return op.enabled;
  }
  if (op.consentKey === 'modelsDownload') {
    return consents.modelsDownload;
  }
  if (op.consentKey === 'updatesCheck') {
    return consents.updatesCheck;
  }
  return op.enabled;
}

/** Props списка: ops канала, документ согласий, блокировка загрузкой, применение. */
export interface OperationsListProps {
  /** Операции политики (§4: генерация main'а из EgressPolicy.ALLOWED — не ручной список). */
  readonly ops: readonly OperationInfo[];
  /** Документ согласий канала privacy/consents (§12); до загрузки — undefined. */
  readonly consents: Consents | undefined;
  /** Идёт загрузка модели (ModelStore, §13): переключатель modelsDownload заблокирован. */
  readonly downloadInProgress: boolean;
  /** Применение согласия (§5): мутация privacy/consents (optimistic с откатом — use-privacy). */
  readonly onToggle: (patch: PrivacyConsentsPatch) => void;
}

/** Список операций с переключателями согласий (§5.2). */
export function OperationsList({
  ops,
  consents,
  downloadInProgress,
  onToggle,
}: OperationsListProps): JSX.Element {
  const { t } = useTranslation();
  const [pendingOp, setPendingOp] = useState<OperationInfo | undefined>(undefined);

  /** Клик переключателя: включение — сразу; отключение — за confirm (§5). */
  function handleSwitch(op: OperationInfo): void {
    if (!consentEnabled(consents, op)) {
      onToggle(toConsentPatch(op.consentKey, true));
      return;
    }
    setPendingOp(op);
  }

  /** Подтверждение отключения: patch=false; отмена/Esc — ничего не меняется. */
  function acceptDisable(): void {
    const op = pendingOp;
    setPendingOp(undefined);
    if (op !== undefined) {
      onToggle(toConsentPatch(op.consentKey, false));
    }
  }

  return (
    <div data-testid="privacy-operations" className="mt-4">
      <h3 className="mb-2 text-base font-medium">{t('privacy.opsTitle')}</h3>
      <div className="flex flex-col gap-3">
        {ops.map((op) => {
          const enabled = consentEnabled(consents, op);
          const titleKey = operationTitleKey(op.op);
          const descriptionKey = OP_DESCRIPTION_KEYS[op.descriptionKey];
          // §13: блокируется только согласие загрузки моделей, и только пока идёт загрузка.
          const blocked = downloadInProgress && op.consentKey === 'modelsDownload';
          const labelId = `privacy-op-${op.op.replaceAll('.', '_')}-label`;
          return (
            <div
              key={op.op}
              className="flex items-start justify-between gap-4 rounded-[10px] bg-surface p-3"
            >
              <div className="min-w-0">
                <p id={labelId} className="text-base font-medium text-text">
                  {titleKey === undefined ? op.op : t(titleKey)}
                </p>
                {descriptionKey === undefined ? null : (
                  <p className="text-sm text-accent">{t(descriptionKey)}</p>
                )}
              </div>
              {/* §16: switch-паттерн с aria-checked и подписью; имя switch — из label по id.
                  §22: ключи в t() — через белые словари литералов (прецедент ModelCard). */}
              <button
                type="button"
                role="switch"
                aria-checked={enabled}
                aria-labelledby={labelId}
                disabled={blocked}
                title={blocked ? t('privacy.downloadBlock') : undefined}
                onClick={() => handleSwitch(op)}
                className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border transition-colors ${
                  enabled ? 'border-accent bg-accent/30' : 'border-border bg-transparent'
                } disabled:cursor-not-allowed disabled:opacity-50`}
              >
                <span
                  aria-hidden="true"
                  className={`inline-block h-4 w-4 rounded-full bg-accent transition-transform ${
                    enabled ? 'translate-x-1' : 'translate-x-6'
                  }`}
                />
              </button>
            </div>
          );
        })}
      </div>

      {pendingOp !== undefined ? (
        <AlertDialog.Root
          open
          onOpenChange={(next) => {
            if (!next) {
              setPendingOp(undefined);
            }
          }}
        >
          <AlertDialog.Portal>
            <AlertDialog.Overlay className="fixed inset-0 bg-black/50" />
            <AlertDialog.Content
              data-testid="privacy-confirm-dialog"
              className="fixed left-1/2 top-1/2 w-[min(24rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-bg p-6 shadow-lg"
            >
              <AlertDialog.Title className="hl-large-title text-text">
                {t('privacy.confirmTitle')}
              </AlertDialog.Title>
              <AlertDialog.Description asChild>
                <p className="mt-2 text-sm text-text">
                  {t(OP_OFF_WARNING_KEYS[pendingOp.consentKey] ?? 'privacy.ops.genericOffWarning')}
                </p>
              </AlertDialog.Description>
              <div className="mt-6 flex flex-wrap justify-end gap-3">
                <AlertDialog.Cancel asChild>
                  <button
                    type="button"
                    data-testid="privacy-confirm-cancel"
                    className="min-h-11 rounded-xl bg-fill px-6 text-base font-semibold text-text"
                  >
                    {t('privacy.confirmCancel')}
                  </button>
                </AlertDialog.Cancel>
                <button
                  type="button"
                  data-testid="privacy-confirm-accept"
                  onClick={acceptDisable}
                  className="min-h-11 rounded-xl bg-accent px-6 text-base font-semibold text-bg"
                >
                  {t('privacy.confirmConfirm')}
                </button>
              </div>
            </AlertDialog.Content>
          </AlertDialog.Portal>
        </AlertDialog.Root>
      ) : null}
    </div>
  );
}
