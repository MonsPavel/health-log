/**
 * TASK-017 §5/§7: команды создания и правки измерения — плоские DTO намерения
 * пользователя ДО валидации. Числа и строки здесь сырые: инварианты проверяет агрегат
 * (bp-measurement.ts); zod-зеркала для IPC — contracts (TASK-028), числа границ
 * дублируются там с комментарием-ссылкой на constants.ts (§22 TASK-017).
 *
 * Времени «сейчас» в команде нет — оно приходит из инъекционного Clock (§4/§7:
 * детерминизм NFR-10, «не в будущем» относительно часов машины).
 */
import type { Instant } from '@hl/kernel';

import type { Arm } from './arm.js';

/** Команда создания измерения (поля §7). */
export interface CreateMeasurementCommand {
  /** Профиль-владелец записи. */
  readonly profileId: string;
  /** Сырое СДА, мм рт. ст. — валидирует BloodPressure.create (TASK-016). */
  readonly sys: number;
  /** Сырое ДДА, мм рт. ст. */
  readonly dia: number;
  /** Сырой пульс, уд/мин; undefined = «не измерен» (FR-1.1: ЧСС опциональна). */
  readonly pulse?: number;
  /** Флаг тонометра «нерегулярный пульс» (EC-10) — без ограничений-валидации (§13). */
  readonly irregularPulse: boolean;
  /** Рука измерения. */
  readonly arm: Arm;
  /** Заметка пользователя; хранится trim-нутой, пустая после trim → undefined (§13). */
  readonly note?: string;
  /** Момент измерения: UTC мс + смещение пояса записи (арх. 04 §2). */
  readonly takenAt: Instant;
}

/**
 * Команда правки (поля §7): измеримые поля совпадают с create; id, profileId и source
 * наследуются от существующей записи — перенос между профилями и смена источника
 * правкой не выражаются.
 */
export interface EditMeasurementCommand {
  readonly sys: number;
  readonly dia: number;
  readonly pulse?: number;
  readonly irregularPulse: boolean;
  readonly arm: Arm;
  readonly note?: string;
  readonly takenAt: Instant;
}
