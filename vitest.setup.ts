/**
 * TASK-004 §13/§14: глобальный setup-хук тестового окружения (общий всем проектам).
 *
 * `globalThis.fetch` подменяется на throw-заглушку: ни один тест монорепо не может
 * «позвонить домой» (FR-7.2). Это часть модели «приложение не ходит в сеть»: если
 * сетевой код протечёт в чистые слои, тест упадёт с сообщением
 * «network is disabled in tests» — ранний детектор утечки.
 *
 * Файловая система пользователя тестами тоже не затрагивается (§13): любые tmp-пути —
 * только через fs.mkdtemp(os.tmpdir()).
 */
const blockedFetch: typeof fetch = (input) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  throw new Error(
    `network is disabled in tests (FR-7.2): fetch(${url}) отклонён — тесты не ходят в сеть`,
  );
};

globalThis.fetch = blockedFetch;
