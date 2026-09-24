// TASK-002 §19: заведомо небезопасный код. ОБЯЗАН не компилироваться под строгим конфигом.
// Ожидаемые коды ошибок: TS18048/TS2532 (noUncheckedIndexedAccess + strictNullChecks),
// TS7006 (noImplicitAny из strict).
const numbers: number[] = [1, 2, 3];
const first = numbers[0];
export const total: number = first + 1;

export function unsafeImplicitAny(value) {
  return value;
}
