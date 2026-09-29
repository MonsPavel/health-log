// TASK-065 §5/§19: юниты FileOpQueue — общая очередь файловых операций данных
// (копии TASK-070 + экспорты TASK-065 идут через ОДИН инстанс в контейнере, §9).
//
// Семантика serialize (§13): вторая операция во время первой — ЖДЁТ (не
// отклоняется); сбой одной операции не ломает очередь — следующие выполняются,
// ошибка доставляется вызвавшему (пробрасывается, §5). Таймаутов нет (§13:
// большие экспорты легитимны).
//
// Примечание TDD: реализация очереди появилась в TASK-070 (смержена); эти тесты —
// обязательные §19-юниты TASK-065, фиксирующие контракт очереди для экспортов
// (GREEN с первого прогона — RED-шаг невозможен без поломки смерженного кода).
import { describe, expect, it } from 'vitest';

import { FileOpQueue } from './file-op-queue.js';

/** Отложенный резолвер: операция завершается вручную (детерминизм порядка, §19). */
interface Deferred {
  readonly promise: Promise<void>;
  resolve(): void;
  reject(cause: unknown): void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('FileOpQueue — сериализация файловых операций (TASK-065 §19)', () => {
  it('две операции → вторая стартует строго ПОСЛЕ завершения первой (§19 serialize)', async () => {
    const queue = new FileOpQueue();
    const first = deferred();
    const events: string[] = [];

    const op1 = queue.run(() => {
      events.push('start:1');
      return first.promise.then(() => {
        events.push('end:1');
      });
    });
    const op2 = queue.run(() => {
      events.push('start:2');
      events.push('end:2');
      return Promise.resolve();
    });

    // Вторая поставлена в очередь, но ещё не началась: первая в полёте.
    await Promise.resolve();
    expect(events).toEqual(['start:1']);

    first.resolve();
    await Promise.all([op1, op2]);
    // Порядок строгий: start:2 только после end:1 (§13 — экспорт ↔ копия не пересекаются).
    expect(events).toEqual(['start:1', 'end:1', 'start:2', 'end:2']);
  });

  it('исключение операции НЕ ломает очередь: ошибка доставляется вызвавшему, третья задача выполняется (§19)', async () => {
    const queue = new FileOpQueue();
    const boom = new Error('запись не удалась (read-only каталог)');

    const failed = queue.run(() => Promise.reject(boom));
    // Третья операция сразу за упавшей — должна выполниться (§20: очередь живая).
    const after = queue.run(() => Promise.resolve('ок'));

    await expect(failed).rejects.toBe(boom);
    await expect(after).resolves.toBe('ок');
  });

  it('результат операции возвращается вызвавшему как есть (значение без потерь)', async () => {
    const queue = new FileOpQueue();
    const result = await queue.run(() => Promise.resolve({ path: 'C:/tmp/x.csv' }));
    expect(result).toEqual({ path: 'C:/tmp/x.csv' });
  });

  it('сбой промежуточной операции не задерживает хвост цепочки: следующая стартует (§5: очередь не ломается)', async () => {
    const queue = new FileOpQueue();
    const first = deferred();
    const events: string[] = [];

    const op1 = queue.run(() => first.promise);
    const op2 = queue.run(() => {
      events.push('second-start');
      return Promise.resolve();
    });
    const op3 = queue.run(() => {
      events.push('third-start');
      return Promise.resolve();
    });

    first.reject(new Error('ENOSPC'));
    await expect(op1).rejects.toThrow('ENOSPC');
    await Promise.all([op2, op3]);
    expect(events).toEqual(['second-start', 'third-start']);
  });
});
