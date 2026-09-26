/**
 * TASK-031 §11/§12/§13: api-слой формы.
 *
 * assembleAddRequest — клиентская валидация черновика ТА ЖЕ zod-схемой контракта
 * MEASUREMENT_ADD_REQUEST_SCHEMA (TASK-028 — единая истина, §4/§13: main всё равно
 * перепроверяет) + сборка MeasurementAddRequest: строки цифр → int, takenAt — на
 * момент submit (§13). Ошибки → FieldErrors: messageKey (ключ каталога из
 * zod-issue, §17) + params (min/max). Границы числовых полей для params
 * ИЗВЛЕКАЮТСЯ ИЗ САМОЙ СХЕМЫ (проверки greater_than/less_than) — числа не
 * дублируются третьей копией в renderer (sync-контракт — только main↔contracts).
 *
 * useAddMeasurement — useMutation поверх call('measurements/add') (TASK-008):
 * успешный конверт разворачивается, ok:false → IpcApiError c AppErrorDto;
 * onSuccess — инвалидация ['measurements'] (§12; событие measurement:changed
 * дублирует — двойная защита, ок); onError — dto AppErrorDto наверх.
 *
 * PROFILE_ID — seed-профиль миграции v1 (единственный в MVP): каналов профилей
 * в контрактах нет, выбор профиля — post-MVP фича.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';

import {
  APP_INTERNAL_ERROR,
  MEASUREMENT_ADD_REQUEST_SCHEMA,
  type AppErrorDto,
  type MeasurementAddRequest,
  type MeasurementAddResponse,
} from '@hl/contracts';

import { fromLocalWall, tzOffsetMinOf } from '../model/taken-at';
import type { Arm, When } from '../model/form-store';
import { call } from '../../../src/lib/ipc';

/** Профиль-владелец измерений (seed миграции v1; выбор профилей — post-MVP). */
export const PROFILE_ID = 'seed-profile-0001' as const;

/** Черновик формы, из которого собирается запрос (строки цифр store, §12). */
export interface MeasurementDraft {
  /** СДА — строка цифр. */
  readonly sys: string;
  /** ДДА — строка цифр. */
  readonly dia: string;
  /** ЧСС — строка цифр ('' — поле опущено, optional §11). */
  readonly pulse: string;
  /** Флаг «неровный пульс». */
  readonly irregular: boolean;
  /** Рука. */
  readonly arm: Arm;
  /** Заметка ('' — поле опущено, optional §11). */
  readonly note: string;
  /** «Сейчас» или заднее число {date, time}. */
  readonly when: When;
}

/** Ошибка поля: ключ каталога (§17) + подстановки params. */
export interface FieldError {
  /** messageKey: ключи errors.* из zod-схемы или клиентские measurement.errors.*. */
  readonly messageKey: string;
  /** Подстановки {{min}}/{{max}} — границы из схемы (§17). */
  readonly params?: Readonly<Record<string, unknown>>;
}

/** Карта ошибок по полям; when — поле «когда», включая futureTime (§20). */
export type FieldErrors = Partial<Record<'sys' | 'dia' | 'pulse' | 'note' | 'when', FieldError>>;

/** Успех сборки: request готов к invoke (валидация zod пройдена). */
export type AssembledRequest = { readonly ok: true; readonly request: MeasurementAddRequest };

/** Отказ сборки: ошибки полей, IPC не вызывается (§20: будущее время — без IPC). */
export type AssembleFailure = { readonly ok: false; readonly fieldErrors: FieldErrors };

/** Имя поля числовых границ — для извлечения min/max из схемы. */
type NumericPath = 'sys' | 'dia' | 'pulse';

/**
 * Границы числового поля ИЗ СХЕМЫ: unwrap optional → def.checks →
 * greater_than(min)/less_than(max). Внутренности zod v4 — единственный способ
 * прочитать границы без третьей копии чисел; поломка = undefined (params без
 * границ), это ловит тест 49 → {min:50, max:300}.
 */
function schemaBounds(path: NumericPath): { min?: number; max?: number } {
  const shape = (MEASUREMENT_ADD_REQUEST_SCHEMA as unknown as {
    shape: Record<string, { def?: { innerType?: unknown; checks?: unknown } }>;
  }).shape;
  let field: { def?: { innerType?: unknown; checks?: unknown } } | undefined = shape[path];
  while (
    field !== undefined &&
    field.def !== undefined &&
    field.def.innerType !== undefined &&
    typeof field.def.innerType === 'object'
  ) {
    field = field.def.innerType as typeof field;
  }
  const out: { min?: number; max?: number } = {};
  for (const check of (field?.def?.checks as readonly unknown[] | undefined) ?? []) {
    const def = (check as { _zod?: { def?: { check?: string; value?: number } } })._zod?.def;
    if (def?.check === 'greater_than' && typeof def.value === 'number') {
      out.min = def.value;
    }
    if (def?.check === 'less_than' && typeof def.value === 'number') {
      out.max = def.value;
    }
  }
  return out;
}

/** Подстановки числовой границы: issue несёт одну границу, пара — из схемы (§17). */
function boundParams(path: NumericPath, issue: Record<string, unknown>): FieldError['params'] {
  const bounds = schemaBounds(path);
  return {
    min: typeof issue.minimum === 'number' ? issue.minimum : bounds.min,
    max: typeof issue.maximum === 'number' ? issue.maximum : bounds.max,
  };
}

/** Разбор datetime-local компонентов ('YYYY-MM-DD', 'HH:MM') из When. */
function parseWhen(when: When): { y: number; mo: number; d: number; h: number; mi: number } | null {
  if (when === 'now') {
    return null;
  }
  const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(when.date);
  const time = /^(\d{2}):(\d{2})$/.exec(when.time);
  if (date === null || time === null) {
    return null;
  }
  return {
    y: Number(date[1]),
    mo: Number(date[2]),
    d: Number(date[3]),
    h: Number(time[1]),
    mi: Number(time[2]),
  };
}

/**
 * Сборка + клиентская валидация запроса add (§13). zod-issues → FieldErrors:
 * path поля → ошибка поля; path [] (refine sysLeDia) → dia — нарушитель инварианта.
 */
export function assembleAddRequest(draft: MeasurementDraft, nowMs: number): AssembledRequest | AssembleFailure {
  const fieldErrors: FieldErrors = {};

  // takenAt — на момент submit (§13): «сейчас» и смещение зоны берутся здесь.
  let takenAt: MeasurementAddRequest['takenAt'];
  const wall = parseWhen(draft.when);
  if (draft.when === 'now') {
    const tzOffsetMin = tzOffsetMinOf(nowMs);
    takenAt = { utcMs: nowMs, tzOffsetMin };
  } else if (wall === null) {
    fieldErrors.when = { messageKey: 'measurement.errors.whenIncomplete' };
  } else {
    const instant = fromLocalWall(wall, tzOffsetMinOf(nowMs));
    if (instant === null) {
      fieldErrors.when = { messageKey: 'measurement.errors.whenIncomplete' };
    } else {
      takenAt = instant;
      // Будущее время — клиентская ошибка без вызова IPC (§20); сверка на
      // момент submit с тем же nowMs, что пойдёт в «сейчас»-ветке.
      if (instant.utcMs > nowMs) {
        fieldErrors.when = { messageKey: 'errors.futureTime' };
      }
    }
  }

  // Обязательные числа: пустое поле — клиентский ключ (zod-текст диапазона
  // тут неуместен); пульс/заметка опциональны — пустота = отсутствие поля.
  const sys = draft.sys === '' ? undefined : Number(draft.sys);
  const dia = draft.dia === '' ? undefined : Number(draft.dia);
  const pulse = draft.pulse === '' ? undefined : Number(draft.pulse);
  if (sys === undefined) {
    fieldErrors.sys = { messageKey: 'measurement.errors.required' };
  }
  if (dia === undefined) {
    fieldErrors.dia = { messageKey: 'measurement.errors.required' };
  }

  const candidate = {
    profileId: PROFILE_ID,
    ...(sys === undefined ? {} : { sys }),
    ...(dia === undefined ? {} : { dia }),
    ...(pulse === undefined ? {} : { pulse }),
    irregularPulse: draft.irregular,
    arm: draft.arm,
    ...(draft.note === '' ? {} : { note: draft.note }),
    ...(takenAt === undefined ? {} : { takenAt }),
  };

  // Схема — единая истина границ и инвариантов (§13); если длина заметки выше
  // 500 (maxLength не сработал — программный ввод), ошибки придут отсюда.
  const parsed = MEASUREMENT_ADD_REQUEST_SCHEMA.safeParse(candidate);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const path = issue.path[0];
      const bag = issue as unknown as Record<string, unknown>;
      // Сообщения схемы — КЛЮЧИ каталога (§17); дефолтные zod-тексты (invalid_type
      // отсутствующего поля) не ключи и не перетирают клиентские ошибки полей.
      const isKeyMessage =
        issue.message.startsWith('errors.') || issue.message.startsWith('measurement.');
      if (!isKeyMessage) {
        continue;
      }
      if (path === 'sys' || path === 'dia' || path === 'pulse') {
        // too_small/too_big/invalid_type числового поля — ключ диапазона схемы
        // (issue.message — ключ каталога, §17) с params из issue/схемы.
        fieldErrors[path] = { messageKey: issue.message, params: boundParams(path, bag) };
      } else if (path === 'note') {
        const max = bag.maximum;
        fieldErrors.note = {
          messageKey: issue.message,
          ...(typeof max === 'number' ? { params: { max } } : {}),
        };
      } else if (path === undefined && issue.message === 'errors.sysLeDia') {
        // Refine на объекте: инвариант sys > dia нарушен — подсвечиваем dia.
        fieldErrors.dia = { messageKey: 'errors.sysLeDia' };
      }
    }
  }

  if (Object.keys(fieldErrors).length > 0) {
    return { ok: false, fieldErrors };
  }
  if (takenAt === undefined || sys === undefined || dia === undefined) {
    // Недостижимо при пустых fieldErrors (required уже дали) — защита типов.
    return { ok: false, fieldErrors };
  }
  return { ok: true, request: MEASUREMENT_ADD_REQUEST_SCHEMA.parse(candidate) };
}

/** Ошибка IPC-канала с dto (ok:false конверт) — данные, не технический краш. */
export class IpcApiError extends Error {
  /** DTO ошибки из конверта (code/messageKey/params — TASK-008 §7). */
  readonly dto: AppErrorDto;

  constructor(dto: AppErrorDto) {
    super(`IPC: ${dto.code} (${dto.messageKey})`);
    this.name = 'IpcApiError';
    this.dto = dto;
  }
}

/** Вызов канала add: разворот конверта; failure → IpcApiError (§11). */
async function addMeasurement(request: MeasurementAddRequest): Promise<MeasurementAddResponse> {
  const result = await call('measurements/add', request);
  if (!result.ok) {
    throw new IpcApiError(result.error);
  }
  return result.data;
}

/** Опции хука: флаги ответа прокидываются наверх (§11 — onSuccess(result)). */
export interface AddMeasurementOptions {
  /** Успех: {measurement, flags} — родитель решает про диалоги (TASK-032). */
  readonly onSuccess?: (result: MeasurementAddResponse) => void;
  /** Отказ: dto ошибки (тост с messageKey — §10). */
  readonly onError?: (error: AppErrorDto) => void;
}

/** Мутация add: инвалидация ['measurements'] на успехе (§12) + хендлеры наверх. */
export function useAddMeasurement(options?: AddMeasurementOptions): ReturnType<
  typeof useMutation<MeasurementAddResponse, Error, MeasurementAddRequest>
> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: addMeasurement,
    onSuccess: (data) => {
      // §12: инвалидация списков; событие measurement:changed дублирует — ок.
      void queryClient.invalidateQueries({ queryKey: ['measurements'] });
      options?.onSuccess?.(data);
    },
    onError: (error) => {
      // Транспорт/конверт → APP/INTERNAL; отказ домена → его dto (§10).
      options?.onError?.(error instanceof IpcApiError ? error.dto : APP_INTERNAL_ERROR);
    },
  });
}
