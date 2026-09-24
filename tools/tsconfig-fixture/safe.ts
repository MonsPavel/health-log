// TASK-002: позитивный контроль. Безопасный код ОБЯЗАН компилироваться без ошибок.
// Если здесь есть диагностика — базовый конфиг сломан (например, битые lib/extends),
// и «отбраковка» unsafe.ts ничего не доказывает.
export function safeFirst(values: readonly number[]): number | undefined {
  return values[0];
}
