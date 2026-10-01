// TASK-118 §19: юнит silentLogger — все 6 методов HlLogger callable no-op
// (вызов не бросает, возвращает void, полный интерфейс).
import { describe, expect, it } from 'vitest';

import { silentLogger } from './silent-logger.js';

describe('silentLogger — фабрика молчаливого HlLogger (§5)', () => {
  it('все шесть методов — функции, вызов не бросает и возвращает undefined', () => {
    const logger = silentLogger();
    const meta = { key: 'значение' };

    expect(logger.trace('t')).toBeUndefined();
    expect(logger.debug('d')).toBeUndefined();
    expect(logger.info('i', meta)).toBeUndefined();
    expect(logger.warn('w', meta)).toBeUndefined();
    expect(logger.error('e', meta)).toBeUndefined();
    expect(logger.fatal('f')).toBeUndefined();
  });
});
