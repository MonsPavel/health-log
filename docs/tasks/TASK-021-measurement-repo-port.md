# TASK-021: Определить порт репозитория измерений и in-memory fake

## 1. Метаданные

| Поле | Значение |
|---|---|
| ID | TASK-021 |
| Название | Определить порт BpMeasurementRepository и in-memory fake |
| Фаза | P1 — Вертикальный срез журнала |
| Эпик | 1.1 — Домен измерений |
| Веха | M-1.1 — Доменные правила измерений |
| Приоритет | Must (MVP) |
| Сложность | S |
| Оценка времени | 0,5–1 ч |
| Зависимости | TASK-017 |
| Блокирует | TASK-026 (SQLite-адаптер реализует порт), TASK-029 (use case зависит от порта) |
| Блокируется | TASK-017 |
| Исходная задача дорожной карты | T-1.1.6 (`docs/roadmap/02-phase-1.md`) |

## 2. Цель

Интерфейс `BpMeasurementRepository` в application-слое + in-memory fake, проходящий тот же контрактный тест-набор, что и будущий SQLite-адаптер (TASK-026).

## 3. Бизнес-контекст

Use case'ы (TASK-029) обязаны тестироваться без SQLite — миллисекундно и без окружения (арх. 10 §1). Это возможно только если зависимость — порт, а fake и SQLite-адаптер взаимозаменяемы. Доверие «fake ≈ адаптер» обеспечивает общий контрактный тест-набор, написанный здесь.

## 4. Технический контекст

- **Архитектура:** порты application — арх. 02 §5, 03 §2 (модуль measurement публикует use cases, скрывает адаптеры).
- **Модуль:** `measurement/application` (порт), `measurement/adapters` (fake).
- **Обоснование:** порт в application (не в domain): репозиторий — инфраструктурная потребность use case'ов; домен не знает о хранении. Fake рядом с портом (не в SQLite-файле) — общий контракт-тест импортирует обе реализации.

## 5. Объём

- **Включено:** интерфейс `BpMeasurementRepository` (методы §7); типы `MeasurementQuery` (фильтры); `InMemoryBpMeasurementRepository` (Map по id, полная семантика); контрактный тест-набор `runRepositoryContract(new RepoFactory)` — параметризованный: оба репозитория (fake сейчас, SQLite в TASK-026) прогоняют один и тот же набор; общие тесты: CRUD, listByPeriod-фильтры, порядок, data_version-интерфейс.
- **Не включено:** SQLite-адаптер (TASK-026), интерфейс data_version-хранилища (входит в порт — см. §7: `currentDataVersion()` и автоинкремент при мутациях — часть контракта репозитория, чтобы «запись+версия атомарны» был фактом порта).
- **Будущая работа:** пагинация listByPeriod (курсорная) — при >5k записей на экран; сейчас — лимит/offset простым числом.

## 6. Файлы

- **Создать:** `apps/desktop/src/main/modules/measurement/application/ports/bp-measurement-repository.ts`; `apps/desktop/src/main/modules/measurement/adapters/measurement-repo.fake.ts`; `apps/desktop/src/main/modules/measurement/adapters/repository.contract.test.ts` (набор-функция + прогон fake).
- **Изменить:** нет.

## 7. Модель предметной области

```
interface BpMeasurementRepository {
  add(m: BpMeasurement): Promise<void>;            // мутация: data_version+1, атомарно
  update(m: BpMeasurement): Promise<void>;
  delete(id: string): Promise<void>;               // отсутствие id → MEASUREMENT/NOT_FOUND
  getById(id: string): Promise<BpMeasurement | undefined>;
  listByPeriod(q: MeasurementQuery): Promise<BpMeasurement[]>; // сортировка: takenAt.desc
  currentDataVersion(): Promise<number>;
}
type MeasurementQuery = { profileId: string; fromUtcMs?: number; toUtcMs?: number; arm?: Arm; hasNote?: boolean; limit?: number; offset?: number };
```
Семантика: все методы асинхронные (SQLite-адаптер синхронный внутри — Promise.resolve-обёртка; контракт единый); `delete` несуществующего → Result err `MEASUREMENT/NOT_FOUND` (не throw).

## 8. База данных

N/A здесь; DDL TASK-025; контракт задаёт требования к ней (индекс profile+takenAt для listByPeriod).

## 9. Бэкенд

Fake: `Map<string, BpMeasurement>`, локальный счётчик data_version; потокобезопасность не требуется (однопоточный Node, вызовы из use case'ов последовательны).

## 10. Фронтенд

N/A.

## 11. API

N/A.

## 12. Управление состоянием

N/A.

## 13. Бизнес-логика

Семантика update: полная замена агрегата (edit из TASK-017 готовит целую запись); несуществующий id при update → NOT_FOUND. listByPeriod: границы периода включительные [from, to]; сортировка всегда takenAt desc, tie-break по id (стабильность для тестов); hasNote=true → только с непустой заметкой. data_version: стартует 1, +1 за каждую успешную мутацию (адд/update/delete), никогда не откатывается.

## 14. Безопасность

profileId обязателен в каждом запросе (принудительный скоуп — арх. 08 §3): fake валидирует наличие profileId (метод без него — программная ошибка, assert).

## 15. Производительность

Fake — не производительный контур; SQLite-адаптер отвечает за NFR-4/9.

## 16–17. Доступность / i18n

N/A.

## 18. Телеметрия

N/A.

## 19. Стратегия тестирования

Контрактный набор (функция): (1) add+getById roundtrip всех полей; (2) add+listByPeriod порядок desc, tie-break; (3) фильтры from/to/arm/hasNote по отдельности и комбинацией; (4) update меняет поля, updatedAtUtc растёт; (5) delete удаляет, повторный → NOT_FOUND; (6) data_version: 1→2→3, не растёт на read; (7) limit/offset. Запуск: на fake. TASK-026 вызовет ту же функцию на SQLite-адаптере.

## 20. Критерии приёмки

- [ ] Контрактный набор зелёный на fake (7 групп).
- [ ] delete несуществующего → Result err NOT_FOUND (не exception).
- [ ] profileId-обязательность: query без profileId → assert-ошибка программиста (throw TypeError — допустим в dev-контракте, документировано).
- [ ] read-операции не меняют data_version (тест).

## 21. Definition of Done

Шаблонный §21.

## 22. Риски

- Расхождение fake и SQLite-семантики (SQLite-строки vs типы) — снято общим контрактом; особое внимание boolean↔0/1 в TASK-026.

## 23. Будущие соображения

Курсорная пагинация (по id.takenAt-композиту) при >5k записей на экран —接口 расширяем опциональным `cursor` без breaking.

## 24. Проверка

Автоматически: контрактный тест на fake зелёный. Ручная: не требуется. Откат: revert; TASK-026 не начат.
