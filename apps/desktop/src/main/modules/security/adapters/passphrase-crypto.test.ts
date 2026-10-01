/**
 * TASK-093 §19: тесты крипто-примитивов двойной обёртки (passphrase-crypto):
 *  - deriveKek: Argon2id(passphrase, salt, params) → 32 байта (KEK); детерминирован
 *    при тех же входах, меняет выход при смене пароля/соли/параметров;
 *  - wrap/unwrap: AES-256-GCM(dbKey, KEK) — roundtrip; подмена любого байта
 *    шифртекста/тега/IV или чужой KEK → PassphraseWrapIntegrityError (auth-tag,
 *    §2: «неверный пароль обнаруживается по auth-tag GCM»);
 *  - calibrate: детерминизм на подставляемых hashFn+Clock (§19 «калибровка-
 *    детерминизм») и параметры в бюджете на реальном Argon2id (замер < 1 с, §19).
 *
 * Скорость (§19): крипто-тесты гоняются с МАЛЫМИ параметрами Argon2id
 * (8 МБ × 1 итерация — миллисекунды); боевые параметры даёт calibrate (§15),
 * их стоимость проверяется отдельным замером (один derive < 1 с).
 */
import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { type Clock } from '@hl/kernel';

import {
  KEK_BYTES,
  PASSPHRASE_SALT_BYTES,
  WRAP_IV_BYTES,
  WRAP_TAG_BYTES,
  PassphraseWrapIntegrityError,
  calibrate,
  deriveKek,
  unwrapDbKey,
  wrapDbKey,
  type Argon2Params,
} from './passphrase-crypto.js';

/** Малые параметры тестов: 8 МБ × 1 итерация × 1 поток — миллисекунды (§19). */
const FAST_PARAMS: Argon2Params = { iterations: 1, memoryKib: 8192, parallelism: 1 };

/** Пароль и соль фиксурой; dbKey — случайный 32 байта (как у ключа БД, §7). */
const PASS = 'пароль-теста-093';
const SALT = randomBytes(PASSPHRASE_SALT_BYTES);
const DB_KEY = randomBytes(32);

describe('deriveKek — KEK = Argon2id(passphrase, salt, params) (TASK-093 §2)', () => {
  it('возвращает 32 байта; те же входы — тот же KEK (детерминизм KDF)', async () => {
    const kek1 = await deriveKek(PASS, SALT, FAST_PARAMS);
    const kek2 = await deriveKek(PASS, SALT, FAST_PARAMS);

    expect(kek1.length).toBe(KEK_BYTES);
    expect(kek1.equals(kek2)).toBe(true);
  });

  it('смена пароля, соли или параметров меняет KEK (офлайн-перебор привязан к salt+params)', async () => {
    const base = await deriveKek(PASS, SALT, FAST_PARAMS);
    const otherPass = await deriveKek('другой-пароль', SALT, FAST_PARAMS);
    const otherSalt = await deriveKek(PASS, randomBytes(PASSPHRASE_SALT_BYTES), FAST_PARAMS);
    const otherParams = await deriveKek(PASS, SALT, { ...FAST_PARAMS, iterations: 2 });

    expect(otherPass.equals(base)).toBe(false);
    expect(otherSalt.equals(base)).toBe(false);
    expect(otherParams.equals(base)).toBe(false);
  });

  it('соль короче минимума Argon2id (8 байт) — TypeError (программная ошибка вызова)', () => {
    expect(() => deriveKek(PASS, Buffer.alloc(7), FAST_PARAMS)).toThrow(TypeError);
  });
});

describe('wrapDbKey/unwrapDbKey — AES-256-GCM(dbKey, KEK) (TASK-093 §2)', () => {
  it('roundtrip: unwrap(wrap(dbKey, kek), kek) = dbKey; формат блоба iv||ct||tag', async () => {
    const kek = await deriveKek(PASS, SALT, FAST_PARAMS);
    const blob = wrapDbKey(DB_KEY, kek);

    // Формат: IV (12) + шифртекст (32) + тег (16) — никаких полей открытым текстом.
    expect(blob.length).toBe(WRAP_IV_BYTES + DB_KEY.length + WRAP_TAG_BYTES);
    expect(blob.subarray(WRAP_IV_BYTES).includes(DB_KEY)).toBe(false);

    expect(unwrapDbKey(blob, kek).equals(DB_KEY)).toBe(true);
  });

  it('два вызова wrap дают разные блобы (случайный IV), оба разворачиваются', async () => {
    const kek = await deriveKek(PASS, SALT, FAST_PARAMS);
    const blob1 = wrapDbKey(DB_KEY, kek);
    const blob2 = wrapDbKey(DB_KEY, kek);

    expect(blob1.equals(blob2)).toBe(false);
    expect(unwrapDbKey(blob1, kek).equals(DB_KEY)).toBe(true);
    expect(unwrapDbKey(blob2, kek).equals(DB_KEY)).toBe(true);
  });

  it('неверный KEK (неверный пароль) → PassphraseWrapIntegrityError (auth-tag GCM, §2)', async () => {
    const kek = await deriveKek(PASS, SALT, FAST_PARAMS);
    const wrongKek = await deriveKek('неверный-пароль', SALT, FAST_PARAMS);
    const blob = wrapDbKey(DB_KEY, kek);

    expect(() => unwrapDbKey(blob, wrongKek)).toThrow(PassphraseWrapIntegrityError);
  });

  it('подмена любого байта шифртекста/тега/IV → PassphraseWrapIntegrityError (целостность)', async () => {
    const kek = await deriveKek(PASS, SALT, FAST_PARAMS);
    const blob = wrapDbKey(DB_KEY, kek);

    for (const at of [0, WRAP_IV_BYTES, blob.length - 1]) {
      const tampered = Buffer.from(blob);
      tampered[at] ^= 0xff;
      expect(() => unwrapDbKey(tampered, kek), `подмена байта ${at}`).toThrow(
        PassphraseWrapIntegrityError,
      );
    }
  });

  it('обрезанный блоб — PassphraseWrapIntegrityError (порча обёртки, не мусор-ключ)', async () => {
    const kek = await deriveKek(PASS, SALT, FAST_PARAMS);
    const blob = wrapDbKey(DB_KEY, kek);

    expect(() => unwrapDbKey(blob.subarray(0, WRAP_IV_BYTES + WRAP_TAG_BYTES), kek)).toThrow(
      PassphraseWrapIntegrityError,
    );
  });
});

describe('calibrate — подбор iterations под бюджет (TASK-093 §5/§15)', () => {
  /**
   * Step-часы: каждый nowMs() продвигает время на stepMs — «длительность» замера
   * (два чтения вокруг hashFn) равна шагу. Детерминизм калибровки (§19).
   */
  class StepClock implements Clock {
    private currentMs = 0;

    constructor(private readonly stepMs: number) {}

    nowMs(): number {
      const current = this.currentMs;
      this.currentMs += this.stepMs;
      return current;
    }

    tzOffsetMin(): number {
      return 0;
    }
  }

  /** Fake-hash: мгновенный — длительность создаёт StepClock шагом. */
  const fakeHash = async (): Promise<Buffer> => Buffer.alloc(KEK_BYTES);

  it('детерминизм: budget 500 / 100 мс-итерация → 5 итераций, повторный вызов — тот же результат', async () => {
    const first = await calibrate({ hashFn: fakeHash, clock: new StepClock(100) });
    const second = await calibrate({ hashFn: fakeHash, clock: new StepClock(100) });

    expect(first.iterations).toBe(5);
    expect(first.memoryKib).toBe(65536);
    expect(first.parallelism).toBe(4);
    expect(second).toEqual(first);
  });

  it('границы: медленная итерация (бюджет меньше одной) → минимум 1; быстрая → не больше максимума', async () => {
    const slow = await calibrate({ hashFn: fakeHash, clock: new StepClock(10_000) });
    expect(slow.iterations).toBe(1);

    const fast = await calibrate({ hashFn: fakeHash, clock: new StepClock(1) });
    expect(fast.iterations).toBe(16);
  });

  it('реальный Argon2id: параметры в бюджете — derive с калиброванными параметрами < 1 с (§19/§20)', async () => {
    const params = await calibrate();
    expect(params.iterations).toBeGreaterThanOrEqual(1);

    const salt = randomBytes(PASSPHRASE_SALT_BYTES);
    const start = performance.now();
    const kek = await deriveKek('пароль-калибровки', salt, params);
    const elapsedMs = performance.now() - start;

    expect(kek.length).toBe(KEK_BYTES);
    expect(elapsedMs).toBeLessThan(1000);
  }, 10_000);
});
