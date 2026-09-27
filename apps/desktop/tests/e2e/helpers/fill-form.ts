/**
 * TASK-043 §5/§6: helper заполнения числовых полей формы ввода (act-фаза
 * сценариев). Поля формы — readonly-инпуты со скрытой клавиатурной обработкой
 * (TASK-031 §5/§16): заполнение — клик в поле (фокус + activeField) и
 * посимвольный keyboard.press — тот же путь ввода, что у пользователя
 * (клавиатурность попутно проверяется, §16). После третьей цифры sys фокус сам
 * переходит в dia (§13 TASK-031) — повторный клик ниже идемпотентен.
 *
 * Enter/клик «Сохранить» ЗДЕСЬ НЕ делается — момент сохранения и ожидаемая ветка
 * (ошибка/диалог/список) — решение сценария (act/assert по §19).
 */

import type { Page } from '@playwright/test';

/** Значения числовых полей формы (строки цифр — как в store черновика TASK-031). */
export interface FormValues {
  /** СДА (обязательна). */
  readonly sys: string;
  /** ДДА (обязательна). */
  readonly dia: string;
  /** ЧСС (опциональна — сценарии давления её не задают). */
  readonly pulse?: string;
}

/** Числовые поля формы — testid `input-<поле>` (TASK-031 §5). */
type NumericField = 'sys' | 'dia' | 'pulse';

/** Вводит цифры одного поля: клик-фокус + посимвольный keyboard.press (§16). */
async function typeInto(page: Page, field: NumericField, digits: string): Promise<void> {
  await page.getByTestId(`input-${field}`).click();
  for (const digit of digits) {
    await page.keyboard.press(digit);
  }
}

/** Заполняет числовые поля формы: sys и dia обязательны, пульс — опционален. */
export async function fillForm(page: Page, values: FormValues): Promise<void> {
  await typeInto(page, 'sys', values.sys);
  await typeInto(page, 'dia', values.dia);
  if (values.pulse !== undefined) {
    await typeInto(page, 'pulse', values.pulse);
  }
}
