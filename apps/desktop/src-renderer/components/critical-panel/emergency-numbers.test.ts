/**
 * TASK-041 §19: юниты реестра номеров экстренных служб — ru → 103/112,
 * en-US → 911, неизвестная локаль → fallback (undefined — панель показывает
 * fallback-фразу каталога), базовый язык без региона (ru-RU → запись ru,
 * fr-5.9-семантика «язык интерфейса»).
 */
import { describe, expect, it } from 'vitest';

import { EMERGENCY_NUMBERS, getEmergencyNumbers } from './emergency-numbers';

describe('emergency-numbers — реестр по локали (§5/§19)', () => {
  it('ru → 103 (primary) + 112 (unified), подпись «скорая»', () => {
    expect(getEmergencyNumbers('ru')).toEqual({
      locale: 'ru',
      primary: '103',
      unified: '112',
      label: 'скорая',
    });
  });

  it('en-US → 911, без unified', () => {
    expect(getEmergencyNumbers('en-US')).toEqual({
      locale: 'en-US',
      primary: '911',
      label: 'Emergency services',
    });
  });

  it('неизвестная локаль → undefined (панель показывает fallback-фразу, §5/§20)', () => {
    expect(getEmergencyNumbers('fr-FR')).toBeUndefined();
    expect(getEmergencyNumbers('de-DE')).toBeUndefined();
    expect(getEmergencyNumbers('')).toBeUndefined();
  });

  it('региональный тег сводится к базовому языку: ru-RU → запись ru (fr-5.9)', () => {
    expect(getEmergencyNumbers('ru-RU')?.primary).toBe('103');
    expect(getEmergencyNumbers('ru-RU')?.unified).toBe('112');
  });

  it('точный тег приоритетнее базового языка: en-US → 911 (не базовый en)', () => {
    expect(getEmergencyNumbers('en-US')?.primary).toBe('911');
  });

  it('карта EMERGENCY_NUMBERS константна и содержит ровно ru и en-US (§5)', () => {
    expect(Object.keys(EMERGENCY_NUMBERS).sort()).toEqual(['en-US', 'ru']);
    expect(EMERGENCY_NUMBERS.ru?.unified).toBe('112');
    expect(EMERGENCY_NUMBERS['en-US']?.unified).toBeUndefined();
  });
});
