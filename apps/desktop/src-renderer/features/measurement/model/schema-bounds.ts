/**
 * TASK-031 §13/§17: извлечение границ ИЗ СХЕМ контрактов (TASK-028) — единственная
 * копия чисел: renderer не повторяет NOTE_MAX/границы домена третьей копией, а
 * читает их из zod-схемы (внутренности проверок greater_than/less_than/max_length).
 * Поломка интроспекции → undefined: потребители обязаны деградировать явно, что
 * ловят тесты (49 → {min:50, max:300}; счётчик «/500»).
 *
 * Альтернатива (дублирование чисел константами) отвергнута: sync-контракт
 * contracts-sync.test.ts защищает только пару main↔contracts.
 */
import { MEASUREMENT_ADD_REQUEST_SCHEMA } from '@hl/contracts';

/** Числовые поля, границы которых нужны форме. */
export type NumericPath = 'sys' | 'dia' | 'pulse';

/** Границы числового поля из схемы: greater_than → min, less_than → max. */
export function numberBounds(path: NumericPath): { min?: number; max?: number } {
  const shape = (
    MEASUREMENT_ADD_REQUEST_SCHEMA as unknown as {
      shape: Record<string, { def?: { innerType?: unknown; checks?: unknown } }>;
    }
  ).shape;
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

/** Максимум заметки из схемы: max_length → NOTE_MAX (500, TASK-028). */
export function noteMaxLength(): number | undefined {
  const shape = (
    MEASUREMENT_ADD_REQUEST_SCHEMA as unknown as {
      shape: Record<string, { def?: { innerType?: unknown; checks?: unknown } }>;
    }
  ).shape;
  let field: { def?: { innerType?: unknown; checks?: unknown } } | undefined = shape['note'];
  while (
    field !== undefined &&
    field.def !== undefined &&
    field.def.innerType !== undefined &&
    typeof field.def.innerType === 'object'
  ) {
    field = field.def.innerType as typeof field;
  }
  for (const check of (field?.def?.checks as readonly unknown[] | undefined) ?? []) {
    const def = (check as { _zod?: { def?: { check?: string; maximum?: number } } })._zod?.def;
    if (def?.check === 'max_length' && typeof def.maximum === 'number') {
      return def.maximum;
    }
  }
  return undefined;
}
