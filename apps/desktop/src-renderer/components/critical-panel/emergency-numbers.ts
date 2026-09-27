/**
 * TASK-041 §4/§5/§7: реестр номеров экстренных служб — ДАННЫЕ по локали, не
 * хардкод в тексте (§4: «реестр номеров служб — данные по локали»). Ключ — язык
 * интерфейса (fr-5.9-семантика; страна ОС-локали — будущая работа §5).
 *
 * Контракт записи (§7): {locale, primary, unified?, label} — label — локализованная
 * подпись основной службы («скорая»); единый номер в RU-семантике подписывается
 * каталогом (critical.panel.numbers.unifiedLabel — «единый»), слова — ключи §17,
 * числа — отсюда.
 *
 * Неизвестная локаль → undefined: панель показывает fallback-фразу каталога
 * (critical.panel.numbers.fallback — «Номер местной службы экстренной помощи», §5).
 * Никаких сетевых вызовов — статические данные (§14).
 */

/** Запись реестра номеров экстренных служб (§7). */
export interface EmergencyNumbers {
  /** Локаль записи (язык интерфейса, fr-5.9). */
  readonly locale: string;
  /** Основной номер (скорая/местная служба). */
  readonly primary: string;
  /** Единый номер экстренных служб (если в локали он есть и отличается). */
  readonly unified?: string;
  /** Локализованная подпись основной службы (данные реестра, §4/§7). */
  readonly label: string;
}

/** Реестр (§5): ru — 103/112, en-US — 911. Расширение — новая запись + тест §19. */
export const EMERGENCY_NUMBERS: Readonly<Record<string, EmergencyNumbers>> = {
  ru: { locale: 'ru', primary: '103', unified: '112', label: 'скорая' },
  'en-US': { locale: 'en-US', primary: '911', label: 'Emergency services' },
};

/**
 * Номера для локали интерфейса: точный тег → базовый язык (ru-RU → ru).
 * Неизвестная локаль → undefined (fallback-фраза каталога, §5/§20).
 */
export function getEmergencyNumbers(locale: string): EmergencyNumbers | undefined {
  const direct = EMERGENCY_NUMBERS[locale];
  if (direct !== undefined) {
    return direct;
  }
  const base = locale.split('-')[0] ?? '';
  return EMERGENCY_NUMBERS[base];
}
