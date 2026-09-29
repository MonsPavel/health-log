/**
 * TASK-072 §10/AC-5: юнит-тесты хелпера очистки localStorage при полном удалении
 * данных. Хелпер вызывается рендерером ПОСЛЕ подтверждённого execute канала
 * `data/wipe` и ПЕРЕД relaunch (подключение к UI — TASK-073).
 */
import { describe, expect, it } from 'vitest';

import { clearWipeLocalStorage, WIPE_LOCAL_STORAGE_PREFIX } from './wipe-local-storage.js';

/** Очищенный jsdom-storage с засеянными ключами приложения и чужими. */
const seededStorage = (keys: string[]): Storage => {
  const map = new Map<string, string>();
  for (const key of keys) {
    map.set(key, `value-${key}`);
  }
  return {
    get length(): number {
      return map.size;
    },
    clear: (): void => map.clear(),
    getItem: (key: string): string | null => map.get(key) ?? null,
    key: (index: number): string | null => [...map.keys()][index] ?? null,
    removeItem: (key: string): void => {
      map.delete(key);
    },
    setItem: (key: string, value: string): void => {
      map.set(key, value);
    },
  };
};

describe('clearWipeLocalStorage (TASK-072 §10/AC-5)', () => {
  it('очищает все ключи префикса hl.* — formDraft, formPrefs, theme, textScale (§10 «всё»)', () => {
    const storage = seededStorage([
      'hl.formDraft',
      'hl.formPrefs',
      'hl.theme',
      'hl.textScale',
      'чужой-ключ',
    ]);
    expect(storage.length).toBe(5);

    expect(clearWipeLocalStorage(storage)).toEqual([
      'hl.formDraft',
      'hl.formPrefs',
      'hl.theme',
      'hl.textScale',
    ]);
    expect(storage.length).toBe(1);
    expect(storage.getItem('чужой-ключ')).toBe('value-чужой-ключ');
  });

  it('приложение «как после установки» (§2): ни одного hl.* не осталось', () => {
    const storage = seededStorage(['hl.formDraft', 'hl.a.b', 'not-hl', 'hlx']);
    clearWipeLocalStorage(storage);
    const remaining: string[] = [];
    for (let i = 0; i < storage.length; i += 1) {
      remaining.push(storage.key(i) as string);
    }
    expect(remaining).toEqual(['not-hl', 'hlx']);
    expect(remaining.some((key) => key.startsWith(WIPE_LOCAL_STORAGE_PREFIX))).toBe(false);
  });

  it('пустой storage — пустой список удалённых, без исключения (идемпотентно)', () => {
    const storage = seededStorage([]);
    expect(clearWipeLocalStorage(storage)).toEqual([]);
    expect(storage.length).toBe(0);
  });
});
