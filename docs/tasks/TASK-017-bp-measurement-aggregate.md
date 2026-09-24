# TASK-017: Реализовать агрегат BpMeasurement

## 1. Метаданные

| Поле | Значение |
|---|---|
| ID | TASK-017 |
| Название | Реализовать агрегат BpMeasurement |
| Фаза | P1 — Вертикальный срез журнала |
| Эпик | 1.1 — Домен измерений |
| Веха | M-1.1 — Доменные правила измерений |
| Приоритет | Must (MVP) |
| Сложность | M |
| Оценка времени | 1–2 ч |
| Зависимости | TASK-016 |
| Блокирует | TASK-018, TASK-019, TASK-020, TASK-021, TASK-029 |
| Блокируется | TASK-016 |
| Исходная задача дорожной карты | T-1.1.2 (`docs/roadmap/02-phase-1.md`) |

## 2. Цель

Агрегат `BpMeasurement`: создание (`create`) и правка (`edit`) через фабрики, проверяющие все инварианты SRS (FR-1.1: обязательные поля, время не в будущем, заметка ≤500 символов); структура данных готова к репозиторию и контракту.

## 3. Бизнес-контекст

Агрегат — точка консистентности журнала: нет способа создать измерение с будущим временем, пустым давлением или заметкой-романом. Ввод задним числом (US-3) при этом полностью разрешён — ограничение только на будущее.

## 4. Технический контекст

- **Архитектура:** агрегат — `docs/architecture/02-domain-model.md` §3.1; Instant/Clock — kernel (TASK-006).
- **Модуль:** `measurement/domain`.
- **Обоснование:** Clock инъекция (не Date.now()) — детерминизм тестов (NFR-10) и корректность «не в будущем» относительно часов машины.

## 5. Объём

- **Включено:** тип `BpMeasurement` (иммутабельный), фабрики `create(cmd, clock)` и `edit(existing, cmd, clock)`; типы команд `CreateMeasurementCommand`, `EditMeasurementCommand` (поля из §7); генерация `id` (uuid v7 — зависимость uuid); код `MEASUREMENT/FUTURE_TIME`, `MEASUREMENT/NOTE_TOO_LONG`; юнит-тесты с FixedClock.
- **Не включено:** персистентность (TASK-026), эвристики (018/019 — работают над готовыми записями).
- **Будущая работа:** поле `source` ('manual'|'import') уже в структуре — импорт (post-MVP) переиспользует `create`.

## 6. Файлы

- **Создать:** `apps/desktop/src/main/modules/measurement/domain/bp-measurement.ts` (+ `measurement-commands.ts`), тесты.
- **Изменить:** `packages/kernel/src/error-codes.ts` (+2 кода).

## 7. Модель предметной области

`BpMeasurement { id: string(uuid v7); profileId: string; bp: BloodPressure; pulse: Pulse|undefined; irregularPulse: boolean; arm: Arm; note: string|undefined; takenAt: Instant; source: 'manual'|'import'; createdAtUtc: number; updatedAtUtc: number }`. Команды: `{profileId, sys, dia, pulse?, irregularPulse, arm, note?, takenAt: {utcMs, tzOffsetMin}, now?: через clock}`. Порядок валидации: BloodPressure (TASK-016) → Pulse → note length → takenAt ≤ clock.nowMs() (равенство «сейчас» валидно — допуск 0 мс). `edit` пересобирает immutable-копию, `updatedAtUtc = clock.nowMs()`.

## 8. База данных

Структура маппится 1:1 на `bp_measurement` (DDL — TASK-025): `id TEXT PK, profile_id, taken_at_utc INTEGER, tz_offset_minutes INTEGER, sys, dia, pulse NULL, irregular_pulse 0|1, arm, note NULL, source, created_at_utc, updated_at_utc`. Сериализатор/десериализатор — в TASK-026.

## 9. Бэкенд

N/A (используется use case'ами TASK-029/037).

## 10. Фронтенд

N/A (форма получает/проверяет те же правила через contracts — TASK-028).

## 11. API

N/A (DTO команд — TASK-028, зеркалят CreateMeasurementCommand минус внутренние поля).

## 12. Управление состоянием

N/A.

## 13. Бизнес-логика

Пограничные случаи: takenAt ровно now — валидно; takenAt на 1 мс в будущем — FUTURE_TIME; заметка 500 символов — ок, 501 — NOTE_TOO_LONG; whitespace-заметка → trim, пустая после trim → undefined. irрegularPulse — boolean, без валидации-ограничений (флаг тонометра, EC-10). Конкурентность: агрегат не решает (дубли — TASK-019, атомарность — TASK-026).

## 14. Безопасность

Заметка — свободный текст пользователя: на этом уровне без санитизации (хранится как есть, вывод экранируется React; для ИИ-контекста — отдельные правила TASK-083). Ограничение длины — и защита от мусора, и ограничение инъекционного материала.

## 15. Производительность

Фабрика O(1); uuid v7 генерация ~мкс — приемлемо на частоте ввода человека.

## 16–17. Доступность / i18n

N/A напрямую; ключи ошибок: `errors.MEASUREMENT_FUTURE_TIME`, `errors.MEASUREMENT_NOTE_TOO_LONG` (params `{max}`) — каталог TASK-031.

## 18. Телеметрия

N/A (логирование — в use case TASK-029).

## 19. Стратегия тестирования

Юниты с FixedClock: полный happy-path create/edit; каждый инвариант — отдельный кейс с точным кодом ошибки; иммутабельность (edit не мутирует existing); trim-заметки; равенство now; будущее на +1 мс. Покрытие ≥95%.

## 20. Критерии приёмки

- [ ] `create` с валидными полями возвращает агрегат с uuid v7 id (regex-проверка версии).
- [ ] takenAt = clock.nowMs()+1 → err FUTURE_TIME; = clock.nowMs() → ok.
- [ ] Заметка 501 символ → err NOTE_TOO_LONG params `{max:500}`; 500 — ok; «   » → note undefined.
- [ ] `edit` не мутирует существующий объект (deep-freeze тест).
- [ ] `irregularPulse` сохраняется без искажений; pulse undefined — валидно.
- [ ] Покрытие ≥95%.

## 21. Definition of Done

Шаблонный §21.

## 22. Риски

- Расхождение правил домена и zod-схем контракта (TASK-028) — mitig: числа границ дублируются явно с комментарием-синхронизацией; контрактный тест (TASK-028) ловит расхождение.

## 23. Будущие соображения

Пост-MVP структурированные теги самочувствия — новое поле команд/агрегата + миграция v+1, edit-семантика не меняется.

## 24. Проверка

Автоматически: `pnpm test -- measurement` зелёный; покрытие ≥95%. Ручная: `grep -n "Date.now()" domain/` — пусто (только Clock). Откат: revert; TASK-018+ не начаты.
