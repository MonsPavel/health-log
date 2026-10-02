/**
 * TASK-098 §2/§4/§9: PrivacyQueries — тонкая агрегация для экрана «Приватность»
 * (US-33, витрина BG-2) над данными TASK-075/096: журнал network_event (через
 * listRecent EgressGateway — индекс at_utc DESC, «новые раньше», TASK-075 §5),
 * перечень операций — ГЕНЕРАЦИЯ из карты политики ALLOWED (не ручной список, §4:
 * новая сетевая операция появляется в UI автоматически при добавлении в политику —
 * нельзя забыть; инвариант защищён тестом §13) и согласия prefs.netConsents
 * (read-only срез + запись ТОЛЬКО через этот модуль — §14: prefs direct-запись
 * согласий из UI запрещена, конвенция).
 *
 * ГРАНИЦЫ (§13): сортировку/лимит ленты гарантирует gateway.listRecent (контракт
 * TASK-075 §5 — «последние N, новые раньше», pinned его инт-тестами) — здесь без
 * дубля; desc при равных at_utc решает ORDER BY at_utc DESC, id DESC (uuid v7).
 * bytes: NULL журнала (blocked/failed/без content-length) → отсутствие поля DTO
 * (§5 «bytes?»). descriptionKey — детерминированный i18n-ключ каталога секции
 * приватности (тексты — TASK-099, без текстов в main, §9). enabled — текущее
 * состояние согласия, перечитывается на КАЖДЫЙ вызов (§14: отмена согласия
 * мгновенно отражается, прецедент consents gateway).
 *
 * PATCH (§5/§14): merge ИЗВЕСТНЫХ ключей patch поверх текущего документа
 * (defense-in-depth поверх strict-схемы каркаса: даже при Runtime-просачивании
 * чужого ключа в merged попадают только ключи согласий); пустой patch — записи
 * нет (лишнего prefs:changed не рождаем). Запись идёт через порт writeConsents —
 * контейнер проводит PreferencesService.setPrefs({netConsents}) (валидация схемы,
 * событие prefs:changed — там, §9 047).
 *
 * Зависимости (§7 — минимальные структурные поверхности, прецедент
 * PreferencesServiceDeps): подстановка в тестах — vi.fn (§19).
 */
import type {
  Consents,
  NetworkEventDto,
  NetConsents,
  OperationInfo,
  PrivacyConsentsPatch,
  PrivacyJournalResponse,
} from '@hl/contracts';

import type { EgressPolicyEntry } from '../egress/egress-policy.js';
import type { NetworkEventRow as GatewayEventRow } from '../egress/egress-gateway.js';

/**
 * i18n-ключ описания операции (§9): `privacy.ops.<op с '_' вместо '.'>` —
 * детерминированная проекция имени операции политики в каталог UI-текстов
 * (секция приватности каталога, §16-17).
 */
export function privacyOperationDescriptionKey(op: string): string {
  return `privacy.ops.${op.replaceAll('.', '_')}`;
}

/**
 * Строка политики: имя операции → {consentKey} (структурно EgressPolicy.ALLOWED,
 * §4). Порт — ради инвариант-теста §13 (мок-операция в политике → ops выросла).
 */
export type PrivacyPolicyMap = Readonly<Record<string, EgressPolicyEntry>>;

/** Зависимости агрегатора (§7): подстановочные в тестах (§19). */
export interface PrivacyQueriesDeps {
  /**
   * Последние N записей журнала, новые раньше (§5): структурно
   * EgressGateway.listRecent — контракт сортировки/лимита там (TASK-075 §5).
   */
  readonly journal: (limit: number) => GatewayEventRow[];
  /** Чтение согласий (§14): read-only срез prefs.netConsents, перечитывается. */
  readonly consents: () => Promise<NetConsents>;
  /** Запись ПОЛНОГО документа согласий (§14: контейнер — PreferencesService.setPrefs). */
  readonly writeConsents: (consents: NetConsents) => Promise<void>;
  /** Карта политики (§4): боевой — EgressPolicy.ALLOWED; подмена — тест-инвариант. */
  readonly policy: PrivacyPolicyMap;
}

/** Экран «Приватность» (§2): журнал + операции + согласия одним агрегатором. */
export class PrivacyQueries {
  private readonly deps: PrivacyQueriesDeps;

  constructor(deps: PrivacyQueriesDeps) {
    this.deps = deps;
  }

  /**
   * §2/§5: `privacy/journal {limit} → {entries, ops}` — записи desc по at_utc
   * (гарантия listRecent, TASK-075 §5) + перечень ВСЕХ операций политики
   * (генерация, §4) с текущим enabled-состоянием согласий.
   */
  async journal(limit: number): Promise<PrivacyJournalResponse> {
    const entries: NetworkEventDto[] = this.deps.journal(limit).map(toEventDto);
    const consents = await this.deps.consents();
    const ops: OperationInfo[] = Object.entries(this.deps.policy).map(([op, entry]) => ({
      op,
      consentKey: entry.consentKey,
      descriptionKey: privacyOperationDescriptionKey(op),
      enabled: consents[entry.consentKey] === true,
    }));
    return { entries, ops };
  }

  /** §5/§11: чтение согласий (ветка privacy/consents без patch). */
  async getConsents(): Promise<Consents> {
    return this.deps.consents();
  }

  /**
   * §5/§14: переключение согласий — merge ИЗВЕСТНЫХ ключей поверх текущего
   * документа, запись ПОЛНОГО документа; возвращает обновлённые согласия.
   * Пустой patch — no-op (записи и prefs:changed нет).
   */
  async patchConsents(patch: PrivacyConsentsPatch): Promise<Consents> {
    const current = await this.deps.consents();
    if (patch.updatesCheck === undefined && patch.modelsDownload === undefined) {
      return current;
    }
    const merged: NetConsents = {
      updatesCheck: patch.updatesCheck ?? current.updatesCheck,
      modelsDownload: patch.modelsDownload ?? current.modelsDownload,
    };
    await this.deps.writeConsents(merged);
    return merged;
  }
}

/**
 * Строка журнала gateway (TASK-075 §5) → DTO канала (§5): bytes NULL →
 * отсутствие поля; остальные поля — прямое зеркало метаданных (без PHI, §7 075).
 */
function toEventDto(row: GatewayEventRow): NetworkEventDto {
  return {
    kind: row.kind,
    endpoint: row.endpoint,
    status: row.status,
    ...(row.bytes === null ? {} : { bytes: row.bytes }),
    atUtc: row.atUtc,
  };
}
