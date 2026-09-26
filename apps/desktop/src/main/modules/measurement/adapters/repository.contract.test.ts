// TASK-021 §5/§19: контрактный набор runRepositoryContract(new RepoFactory) — параметризованный:
// один и тот же набор прогоняется на in-memory fake (здесь) и на SQLite-адаптере (TASK-026
// импортирует функцию отсюда) — доверие «fake ≈ адаптер» (§3). Группы §19:
// (1) add+getById roundtrip всех полей; (2) порядок takenAt desc + tie-break по id;
// (3) фильтры from/to/arm/hasNote по отдельности и комбинацией (+ скоуп профиля, §14);
// (4) update меняет поля, updatedAtUtc растёт; (5) delete удаляет, повторный → NOT_FOUND err
// (не exception, §20); (6) data_version 1→2→3, read не растит (§20); (7) limit/offset.
// Отдельно — dev-контракт fake: listByPeriod без profileId → TypeError (assert программиста,
// §14/§20 — задокументированное исключение из «исключения не пересекают слои»).
// Агрегаты создаются только публичными фабриками домена (create/edit) — контракт не лезет
// во внутренности, как и будущий SQLite-адаптер.
import { beforeEach, describe, expect, it } from 'vitest';

import { FixedClock, unsafeUnwrap, type AppError, type Result } from '@hl/kernel';

import type {
  BpMeasurementRepository,
  MeasurementQuery,
} from '../application/ports/bp-measurement-repository.js';
import type { Arm } from '../domain/arm.js';
import { BpMeasurement } from '../domain/bp-measurement.js';
import { InMemoryBpMeasurementRepository } from './measurement-repo.fake.js';

/** Фиксированное «сейчас» (2025-09-25T16:00:00Z, UTC+3) — детерминизм NFR-10. */
const NOW_MS = 1_758_816_000_000;
const TZ = 180;
const MINUTE_MS = 60_000;
/** База моментов измерений: за час до «сейчас» — все takenAt в прошлом (инвариант create). */
const BASE_MS = NOW_MS - 60 * MINUTE_MS;

/** Момент измерения: utcMs + общий для тестов пояс (UTC+3). */
const at = (utcMs: number) => ({ utcMs, tzOffsetMin: TZ });

/** Спецификация seed-записи: неуказанные опционалы не передаются в create («нет значения»). */
interface SeedSpec {
  readonly profileId?: string;
  readonly sys?: number;
  readonly dia?: number;
  readonly pulse?: number;
  readonly irregularPulse?: boolean;
  readonly arm?: Arm;
  readonly note?: string;
  readonly takenAtUtcMs: number;
}

/** Seed через публичную фабрику create: контракт тестирует домен как чёрный ящик (§3). */
const seed = (spec: SeedSpec): BpMeasurement =>
  unsafeUnwrap(
    BpMeasurement.create(
      {
        profileId: spec.profileId ?? 'profile-1',
        sys: spec.sys ?? 120,
        dia: spec.dia ?? 80,
        pulse: spec.pulse,
        irregularPulse: spec.irregularPulse ?? false,
        arm: spec.arm ?? 'left',
        note: spec.note,
        takenAt: at(spec.takenAtUtcMs),
      },
      new FixedClock(NOW_MS, TZ),
    ),
  );

/** Извлекает err-ветку для assert'ов; ok-ветка — ошибка теста (не молчаливый проход). */
const errOf = (result: Result<void, AppError>): AppError => {
  if (result.ok) {
    throw new Error('ожидалась err-ветка Result, получена ok');
  }
  return result.error;
};

/** Фабрика свежего репозитория: каждый тест получает чистое состояние (data_version = 1, §13). */
export type RepositoryFactory = () => BpMeasurementRepository;

/**
 * Контрактный набор (§19, 7 групп). Параметризация — фабрика репозитория: fake прогоняется
 * ниже по файлу; TASK-026 (SQLite) вызовет эту же функцию на своём адаптере (§19 TASK-026).
 */
export function runRepositoryContract(makeRepository: RepositoryFactory): void {
  describe('BpMeasurementRepository: контрактный набор (TASK-021 §19)', () => {
    let repo: BpMeasurementRepository;

    beforeEach(() => {
      repo = makeRepository();
    });

    describe('1. add + getById: roundtrip всех полей', () => {
      it('сохранённая запись читается со всеми полями агрегата (§19.1)', async () => {
        const m = seed({
          takenAtUtcMs: BASE_MS,
          sys: 128,
          dia: 82,
          pulse: 70,
          irregularPulse: true,
          arm: 'right',
          note: 'после бега',
        });
        await repo.add(m);

        const loaded = await repo.getById(m.id);
        expect(loaded).toEqual(m);
        // Каждое поле отдельно — roundtrip «всех полей» не полагается только на toEqual.
        expect(loaded?.id).toBe(m.id);
        expect(loaded?.profileId).toBe('profile-1');
        expect(loaded?.bp.sys).toBe(128);
        expect(loaded?.bp.dia).toBe(82);
        expect(loaded?.pulse).toBe(70);
        expect(loaded?.irregularPulse).toBe(true);
        expect(loaded?.arm).toBe('right');
        expect(loaded?.note).toBe('после бега');
        expect(loaded?.takenAt).toEqual(at(BASE_MS));
        expect(loaded?.source).toBe('manual');
        expect(loaded?.createdAtUtc).toBe(NOW_MS);
        expect(loaded?.updatedAtUtc).toBe(NOW_MS);
      });

      it('опциональные поля «не измерен / нет заметки» → undefined; несуществующий id → undefined', async () => {
        const m = seed({ takenAtUtcMs: BASE_MS });
        await repo.add(m);

        const loaded = await repo.getById(m.id);
        expect(loaded?.pulse).toBeUndefined();
        expect(loaded?.note).toBeUndefined();
        expect(await repo.getById('нет-такого-id')).toBeUndefined();
      });
    });

    describe('2. listByPeriod: порядок takenAt desc, tie-break по id', () => {
      it('новые записи первыми (§19.2: сортировка всегда takenAt desc, §13)', async () => {
        const older = seed({ takenAtUtcMs: BASE_MS });
        const newer = seed({ takenAtUtcMs: BASE_MS + MINUTE_MS });
        await repo.add(older);
        await repo.add(newer);

        const ids = (await repo.listByPeriod({ profileId: 'profile-1' })).map((m) => m.id);
        expect(ids).toEqual([newer.id, older.id]);
      });

      it('равный takenAt — tie-break id по убыванию (§13: стабильность; SQL TASK-026: id DESC)', async () => {
        const a = seed({ takenAtUtcMs: BASE_MS });
        const b = seed({ takenAtUtcMs: BASE_MS });
        await repo.add(a);
        await repo.add(b);

        const ids = (await repo.listByPeriod({ profileId: 'profile-1' })).map((m) => m.id);
        expect(ids).toEqual([a.id, b.id].sort().reverse());
      });
    });

    describe('3. listByPeriod: фильтры from/to/arm/hasNote — по отдельности и комбинацией', () => {
      it('from включительно: запись ровно на границе возвращается, раньше неё — нет (§13: [from, …])', async () => {
        const before = seed({ takenAtUtcMs: BASE_MS - 1 });
        const boundary = seed({ takenAtUtcMs: BASE_MS });
        const after = seed({ takenAtUtcMs: BASE_MS + MINUTE_MS });
        await repo.add(before);
        await repo.add(boundary);
        await repo.add(after);

        const ids = (await repo.listByPeriod({ profileId: 'profile-1', fromUtcMs: BASE_MS })).map(
          (m) => m.id,
        );
        expect(ids).toEqual([after.id, boundary.id]);
      });

      it('to включительно: запись ровно на границе возвращается, позже неё — нет (§13: […, to])', async () => {
        const before = seed({ takenAtUtcMs: BASE_MS - MINUTE_MS });
        const boundary = seed({ takenAtUtcMs: BASE_MS });
        const after = seed({ takenAtUtcMs: BASE_MS + 1 });
        await repo.add(before);
        await repo.add(boundary);
        await repo.add(after);

        const ids = (await repo.listByPeriod({ profileId: 'profile-1', toUtcMs: BASE_MS })).map(
          (m) => m.id,
        );
        expect(ids).toEqual([boundary.id, before.id]);
      });

      it('arm: возвращаются записи только указанной руки', async () => {
        const left = seed({ takenAtUtcMs: BASE_MS, arm: 'left' });
        const right = seed({ takenAtUtcMs: BASE_MS + MINUTE_MS, arm: 'right' });
        await repo.add(left);
        await repo.add(right);

        expect(
          (await repo.listByPeriod({ profileId: 'profile-1', arm: 'left' })).map((m) => m.id),
        ).toEqual([left.id]);
        expect(
          (await repo.listByPeriod({ profileId: 'profile-1', arm: 'right' })).map((m) => m.id),
        ).toEqual([right.id]);
      });

      it('hasNote=true: только записи с непустой заметкой (§13)', async () => {
        const withNote = seed({ takenAtUtcMs: BASE_MS + MINUTE_MS, note: 'утром' });
        const withoutNote = seed({ takenAtUtcMs: BASE_MS });
        await repo.add(withNote);
        await repo.add(withoutNote);

        const ids = (await repo.listByPeriod({ profileId: 'profile-1', hasNote: true })).map(
          (m) => m.id,
        );
        expect(ids).toEqual([withNote.id]);
      });

      it('комбинация from+to+arm+hasNote — пересечение всех условий; скоуп профиля в обе стороны (§14)', async () => {
        const match = seed({ takenAtUtcMs: BASE_MS + MINUTE_MS, arm: 'left', note: 'в окне' });
        const wrongArm = seed({
          takenAtUtcMs: BASE_MS + MINUTE_MS,
          arm: 'right',
          note: 'не та рука',
        });
        const wrongTime = seed({
          takenAtUtcMs: BASE_MS + 10 * MINUTE_MS,
          arm: 'left',
          note: 'вне окна',
        });
        const noNote = seed({ takenAtUtcMs: BASE_MS + MINUTE_MS, arm: 'left' });
        const otherProfile = seed({
          profileId: 'profile-2',
          takenAtUtcMs: BASE_MS + MINUTE_MS,
          arm: 'left',
          note: 'чужой профиль',
        });
        await repo.add(match);
        await repo.add(wrongArm);
        await repo.add(wrongTime);
        await repo.add(noNote);
        await repo.add(otherProfile);

        const ids = (
          await repo.listByPeriod({
            profileId: 'profile-1',
            fromUtcMs: BASE_MS,
            toUtcMs: BASE_MS + 5 * MINUTE_MS,
            arm: 'left',
            hasNote: true,
          })
        ).map((m) => m.id);
        expect(ids).toEqual([match.id]);

        // Запрос чужого профиля не видит записи profile-1 (принудительный скоуп, арх. 08 §3).
        const otherIds = (await repo.listByPeriod({ profileId: 'profile-2' })).map((m) => m.id);
        expect(otherIds).toEqual([otherProfile.id]);
      });
    });

    describe('4. update: полная замена агрегата, updatedAtUtc растёт', () => {
      it('update заменяет поля целиком (включая снятие пульса), updatedAtUtc растёт (§19.4/§13)', async () => {
        const m = seed({
          takenAtUtcMs: BASE_MS,
          pulse: 70,
          irregularPulse: true,
          arm: 'left',
          note: 'до правки',
        });
        await repo.add(m);
        const before = await repo.getById(m.id);

        const edited = unsafeUnwrap(
          BpMeasurement.edit(
            m,
            {
              sys: 130,
              dia: 85,
              irregularPulse: false,
              arm: 'right',
              note: 'после правки',
              takenAt: at(BASE_MS + MINUTE_MS),
            },
            new FixedClock(NOW_MS + MINUTE_MS, TZ),
          ),
        );
        await repo.update(edited);

        const loaded = await repo.getById(m.id);
        expect(loaded).toEqual(edited);
        // Полная замена, а не слияние: пульс снят, флаг и рука заменены (§13).
        expect(loaded?.bp.sys).toBe(130);
        expect(loaded?.bp.dia).toBe(85);
        expect(loaded?.pulse).toBeUndefined();
        expect(loaded?.irregularPulse).toBe(false);
        expect(loaded?.arm).toBe('right');
        expect(loaded?.note).toBe('после правки');
        expect(loaded?.takenAt).toEqual(at(BASE_MS + MINUTE_MS));
        // Наследование id/profileId/createdAtUtc и растущий штамп правки.
        expect(loaded?.id).toBe(m.id);
        expect(loaded?.profileId).toBe('profile-1');
        expect(loaded?.createdAtUtc).toBe(NOW_MS);
        expect(before?.updatedAtUtc).toBe(NOW_MS);
        expect(loaded?.updatedAtUtc).toBe(NOW_MS + MINUTE_MS);
      });

      it('update несуществующего id → err MEASUREMENT/NOT_FOUND, не throw (§13/§20)', async () => {
        const m = seed({ takenAtUtcMs: BASE_MS });

        const result = await repo.update(m);
        expect(result.ok).toBe(false);
        expect(errOf(result).code).toBe('MEASUREMENT/NOT_FOUND');
        expect(await repo.getById(m.id)).toBeUndefined();
      });
    });

    describe('5. delete: удаление; повторный → NOT_FOUND', () => {
      it('delete удаляет запись; повторный delete → err MEASUREMENT/NOT_FOUND, не exception (§19.5/§20)', async () => {
        const m = seed({ takenAtUtcMs: BASE_MS });
        await repo.add(m);

        const first = await repo.delete(m.id);
        expect(first.ok).toBe(true);
        expect(await repo.getById(m.id)).toBeUndefined();

        const second = await repo.delete(m.id);
        expect(second.ok).toBe(false);
        expect(errOf(second).code).toBe('MEASUREMENT/NOT_FOUND');
      });
    });

    describe('6. data_version: 1 → 2 → 3, read-операции не растят', () => {
      it('старт 1; каждая успешная мутация +1; getById/listByPeriod/currentDataVersion не меняют (§19.6/§20)', async () => {
        expect(await repo.currentDataVersion()).toBe(1);

        const m = seed({ takenAtUtcMs: BASE_MS });
        await repo.add(m);
        expect(await repo.currentDataVersion()).toBe(2);

        const edited = unsafeUnwrap(
          BpMeasurement.edit(
            m,
            { sys: 130, dia: 85, irregularPulse: false, arm: 'left', takenAt: at(BASE_MS) },
            new FixedClock(NOW_MS + MINUTE_MS, TZ),
          ),
        );
        await repo.update(edited);
        expect(await repo.currentDataVersion()).toBe(3);

        await repo.getById(m.id);
        await repo.listByPeriod({ profileId: 'profile-1' });
        expect(await repo.currentDataVersion()).toBe(3);
      });

      it('delete — тоже мутация: add+delete дают 1 → 3 (§13: адд/update/delete)', async () => {
        const m = seed({ takenAtUtcMs: BASE_MS });
        await repo.add(m);
        await repo.delete(m.id);
        expect(await repo.currentDataVersion()).toBe(3);
      });

      it('неудачная мутация (update/delete несуществующего) версию не двигает (§13 «успешную»)', async () => {
        const m = seed({ takenAtUtcMs: BASE_MS });

        await repo.update(m);
        await repo.delete('нет-такого-id');
        expect(await repo.currentDataVersion()).toBe(1);
      });
    });

    describe('7. limit/offset', () => {
      it('без limit/offset — все записи; limit отрезает самые новые (после сортировки desc)', async () => {
        const oldest = seed({ takenAtUtcMs: BASE_MS });
        const middle = seed({ takenAtUtcMs: BASE_MS + MINUTE_MS });
        const newest = seed({ takenAtUtcMs: BASE_MS + 2 * MINUTE_MS });
        await repo.add(oldest);
        await repo.add(middle);
        await repo.add(newest);

        expect((await repo.listByPeriod({ profileId: 'profile-1' })).map((m) => m.id)).toEqual([
          newest.id,
          middle.id,
          oldest.id,
        ]);
        expect(
          (await repo.listByPeriod({ profileId: 'profile-1', limit: 2 })).map((m) => m.id),
        ).toEqual([newest.id, middle.id]);
      });

      it('offset пропускает самые новые; limit+offset — окно; offset за пределами → []', async () => {
        const oldest = seed({ takenAtUtcMs: BASE_MS });
        const middle = seed({ takenAtUtcMs: BASE_MS + MINUTE_MS });
        const newest = seed({ takenAtUtcMs: BASE_MS + 2 * MINUTE_MS });
        await repo.add(oldest);
        await repo.add(middle);
        await repo.add(newest);

        expect(
          (await repo.listByPeriod({ profileId: 'profile-1', offset: 1 })).map((m) => m.id),
        ).toEqual([middle.id, oldest.id]);
        expect(
          (await repo.listByPeriod({ profileId: 'profile-1', offset: 1, limit: 1 })).map(
            (m) => m.id,
          ),
        ).toEqual([middle.id]);
        expect(await repo.listByPeriod({ profileId: 'profile-1', offset: 3 })).toEqual([]);
      });

      it('limit=0 → пустой список (семантика SQL LIMIT 0)', async () => {
        await repo.add(seed({ takenAtUtcMs: BASE_MS }));
        expect(await repo.listByPeriod({ profileId: 'profile-1', limit: 0 })).toEqual([]);
      });
    });

    describe('8. countByPeriod: total по тем же фильтрам, без пагинации (TASK-030 §7)', () => {
      it('считает все записи профиля; listByPeriod без limit возвращает столько же (§7: COUNT по тем же фильтрам)', async () => {
        await repo.add(seed({ takenAtUtcMs: BASE_MS }));
        await repo.add(seed({ takenAtUtcMs: BASE_MS + MINUTE_MS }));
        await repo.add(seed({ takenAtUtcMs: BASE_MS + 2 * MINUTE_MS }));

        const total = await repo.countByPeriod({ profileId: 'profile-1' });
        expect(total).toBe(3);
        expect((await repo.listByPeriod({ profileId: 'profile-1' })).length).toBe(total);
      });

      it('фильтры from/to/arm/hasNote — те же, что у listByPeriod: count совпадает с длиной выборки', async () => {
        const match = seed({ takenAtUtcMs: BASE_MS + MINUTE_MS, arm: 'left', note: 'в окне' });
        const wrongArm = seed({ takenAtUtcMs: BASE_MS + MINUTE_MS, arm: 'right', note: 'в окне' });
        const wrongTime = seed({ takenAtUtcMs: BASE_MS + 10 * MINUTE_MS, arm: 'left' });
        const noNote = seed({ takenAtUtcMs: BASE_MS + MINUTE_MS, arm: 'left' });
        await repo.add(match);
        await repo.add(wrongArm);
        await repo.add(wrongTime);
        await repo.add(noNote);

        const query: MeasurementQuery = {
          profileId: 'profile-1',
          fromUtcMs: BASE_MS,
          toUtcMs: BASE_MS + 5 * MINUTE_MS,
          arm: 'left',
          hasNote: true,
        };
        expect(await repo.countByPeriod(query)).toBe(1);
        expect((await repo.listByPeriod(query)).map((m) => m.id)).toEqual([match.id]);
      });

      it('limit/offset не влияют на total: count всех подходящих, а не размер страницы (§7)', async () => {
        await repo.add(seed({ takenAtUtcMs: BASE_MS }));
        await repo.add(seed({ takenAtUtcMs: BASE_MS + MINUTE_MS }));
        await repo.add(seed({ takenAtUtcMs: BASE_MS + 2 * MINUTE_MS }));

        // Страница limit=2/offset=1 отдаёт одну запись, total при этом — все три.
        const page = await repo.listByPeriod({
          profileId: 'profile-1',
          limit: 2,
          offset: 1,
        });
        expect(page.length).toBe(2);
        expect(await repo.countByPeriod({ profileId: 'profile-1', limit: 2, offset: 1 })).toBe(3);
      });

      it('пустой период → 0; чужой профиль не считается (§14 скоуп)', async () => {
        await repo.add(seed({ takenAtUtcMs: BASE_MS }));
        await repo.add(seed({ profileId: 'profile-2', takenAtUtcMs: BASE_MS + MINUTE_MS }));

        expect(await repo.countByPeriod({ profileId: 'profile-1', fromUtcMs: NOW_MS })).toBe(0);
        expect(await repo.countByPeriod({ profileId: 'profile-2' })).toBe(1);
        expect(await repo.countByPeriod({ profileId: 'нет-такого-профиля' })).toBe(0);
      });
    });
  });
}

// §5: прогон набора на fake. TASK-026 вызовет runRepositoryContract на SQLite-адаптере.
runRepositoryContract(() => new InMemoryBpMeasurementRepository());

describe('InMemoryBpMeasurementRepository: dev-контракт profileId (§14/§20)', () => {
  it('listByPeriod без profileId → синхронный throw TypeError: assert программиста, не AppError (§20)', () => {
    const repo = new InMemoryBpMeasurementRepository();
    // Имитация JS-вызова без обязательного поля: тип нарушен умышленно (dev-контракт, §20).
    const broken = {} as MeasurementQuery;
    expect(() => repo.listByPeriod(broken)).toThrow(TypeError);
  });

  it('listByPeriod с пустым profileId → throw TypeError: пустой скоуп недопустим (§14, арх. 08 §3)', () => {
    const repo = new InMemoryBpMeasurementRepository();
    expect(() => repo.listByPeriod({ profileId: '' })).toThrow(TypeError);
  });
});
