# TASK-028: Определить contracts: каналы измерений

## 1. Метаданные

| Поле | Значение |
|---|---|
| ID | TASK-028 |
| Название | Определить contracts: каналы измерений (DTO + zod + коды ошибок) |
| Фаза | P1 — Вертикальный срез журнала |
| Эпик | 1.3 — Ввод и список (первый UI-вертикаль) |
| Веха | M-1.3 — Первый вертикальный срез |
| Приоритет | Must (MVP) |
| Сложность | M |
| Оценка времени | 1–1,5 ч |
| Зависимости | TASK-008 |
| Блокирует | TASK-029, TASK-030, TASK-031, TASK-033, TASK-037 |
| Блокируется | TASK-008 |
| Исходная задача дорожной карты | T-1.3.1 (`docs/roadmap/02-phase-1.md`) |

## 2. Цель

В `@hl/contracts`: zod-схемы и типы для каналов `measurements/add|update|delete|list` — DTO запросов/ответов, флаги эвристик, критический флаг; числа границ синхронизированы с доменом.

## 3. Бизнес-контекст

Контракт первичен (D6): UI и use case'ы пишутся против него одновременно; агент-кодировщик получает точную форму данных без чтения чужого кода. Ошибки валидации приходят с params для дружественных подсказок формы (П1 вводит 49 → видит «от 50 до 300»).

## 4. Технический контекст

- **Архитектура:** каналы — `docs/architecture/05-api-ipc.md` §2–3; конверт — TASK-008.
- **Пакет:** `@hl/contracts`.
- **Обоснование:** дублирование границ домена в zod — осознанное (renderer не импортирует main-домен, арх. 03 §4); контрактный тест (§19) ловит расхождение.

## 5. Объём

- **Включено:** схемы: `MeasurementAddRequest {profileId: string, sys: int 50–300, dia: int 20–200, pulse?: int 20–300, irregularPulse: boolean, arm: enum, note?: string ≤500, takenAt: {utcMs: int, tzOffsetMin: int -720..840}}`; `MeasurementDto` (ответные поля, мгновенно-читаемая форма агрегата); флаги в ответе add: `{typo?: TypoFlagDto, duplicate?: boolean, criticalValue?: 'high'|'low'}`; каналы list/delete/update (схемы: query из TASK-021-порта; delete: `{id}`; update: dto+id); регистрация в CHANNEL_SCHEMAS; типизированные имена каналов.
- **Не включено:** FTS-поиск (TASK-045), статистика (TASK-054).
- **Будущая работа:** пагинация-курсор (расширение list response).

## 6. Файлы

- **Создать:** `packages/contracts/src/measurement/{schemas.ts,types.ts,index.ts}`; schema-тесты.
- **Изменить:** `packages/contracts/src/channels.ts` (+4 канала), `src-renderer/i18n/ru/errors.json` (ключи ошибок валидации).

## 7. Модель предметной области

DTO — плоские формы агрегата TASK-017: `MeasurementDto {id, profileId, sys, dia, pulse?, irregularPulse, arm, note?, takenAtUtcMs, tzOffsetMin, source, createdAtUtcMs, updatedAtUtcMs}`. Правило: DTO ≠ агрегат; маппинг — в main (адаптер контракта).

## 8. База данных

N/A.

## 9. Бэкенд

N/A (use cases TASK-029/030 потребляют схемы через `z.infer`).

## 10. Фронтенд

Форма (TASK-031) валидирует теми же zod-схемами (импорт из contracts — разрешённая зависимость renderer). Дружественные сообщения: zod `message` — ключи i18n (`errors.rangeSys` и т.п.), не тексты.

## 11. API

Полный перечень каналов (запрос → ответ):
- `measurements/add`: MeasurementAddRequest → `{measurement: MeasurementDto, flags: {typo?, duplicate?, criticalValue?}}`.
- `measurements/list`: `{profileId, fromUtcMs?, toUtcMs?, arm?, hasNote?, limit=200, offset=0}` → `{items: MeasurementDto[], total: number}`.
- `measurements/update`: `{id, …те же поля, что add}` → `{measurement}`.
- `measurements/delete`: `{id}` → `{deleted: true}`.
Ошибки: VALIDATION/FAILED (params zod), MEASUREMENT/NOT_FOUND, APP/INTERNAL.

## 12. Управление состоянием

N/A.

## 13. Бизнес-логика

tzOffsetMin диапазон [-720, +840] (реальные смещения UTC−12…+14); takenAt.utcMs — int, ограничение «не будущее» — НЕ в схеме (нужен Clock — проверяет домен TASK-017; схема проверяет тип/диапазон разумный: ≤ now+5 мин на случай рассинхрона часов — НЕТ: оставляем только тип, домен вердикт; документируется).

## 14. Безопасность

`.strict()` на всех объектах (запрет лишних полей — IPC-гигиена TASK-008); note — `z.string().max(500)`; profileId — uuid-подобная строка (regex, seeded `seed-profile-0001` валиден — префикс-альтернатива: z.string().min(1).max(64) — принято простое ограничение длины, не uuid-regex, т.к. seed-идентификаторы не UUID).

## 15. Производительность

N/A (схемы — микросекунды).

## 16–17. Доступность / i18n

Ключи ошибок валидации: `errors.rangeSys`, `errors.rangeDia`, `errors.rangePulse`, `errors.sysLeDia`, `errors.noteTooLong`, `errors.futureTime` — с params-подстановками; каталог пополняется (потребители — TASK-031).

## 18. Телеметрия

N/A.

## 19. Стратегия тестирования

Schema-тесты: валидные payload проходят; каждое нарушение (границы, sys≤dia, длинная note, лишнее поле strict, плохой arm) → конкретная ошибка zod; **контрактный тест синхронизации**: подмножество случаев прогоняется и через zod, и через доменные фабрики (TASK-016/017) — вердикты совпадают (ловит дрейф чисел).

## 20. Критерии приёмки

- [ ] 4 канала зарегистрированы в CHANNEL_SCHEMAS; типизированы имена.
- [ ] Schema-тесты: все нарушения §19 дают ожидаемые ошибки; `.strict()` отбрасывает лишние поля.
- [ ] Синхронизационный контракт-тест домен↔схема зелёный.
- [ ] Ключи ошибок §17 присутствуют в каталоге.

## 21. Definition of Done

Шаблонный §21.

## 22. Риски

- Дрейф границ домен↔схема при правке констант — mitig: синхронизационный тест обязателен к прогону при любом изменении границ (пункт в комментарии констант TASK-016).

## 23. Будущие соображения

Пагинация-курсор: `nextOffset`-поле ответа — аддитивно без breaking.

## 24. Проверка

Автоматически: schema-тесты + синхронизационный тест зелёные. Ручная: нет. Откат: revert; TASK-029/031 не начаты.
