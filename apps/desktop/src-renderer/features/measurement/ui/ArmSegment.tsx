/**
 * TASK-031 §5/§16: сегмент-контрол руки — native radio-пара «Левая»/«Правая»
 * в fieldset/legend: стрелки и checked — нативная семантика скринридеров (§16).
 * Значение — контролируемый проп (store решает форма, §12); цели нажатия ≥44px
 * (min-h-11, rem — масштаб с FR-8.2). Выбор запоминается черновиком (§20).
 */
import { useTranslation } from 'react-i18next';

import type { Arm } from '../model/form-store';

/** Props сегмента: контролируемое значение + смена (§12). */
export interface ArmSegmentProps {
  /** Текущая рука. */
  readonly value: Arm;
  /** Смена руки пользователем. */
  readonly onArm: (arm: Arm) => void;
}

/** Сегмент-контрол руки left/right (§5). */
export function ArmSegment({ value, onArm }: ArmSegmentProps): JSX.Element {
  const { t } = useTranslation();

  const options: readonly { readonly arm: Arm; readonly label: string }[] = [
    { arm: 'left', label: t('measurement.fields.armLeft') },
    { arm: 'right', label: t('measurement.fields.armRight') },
  ];

  return (
    <fieldset className="border-0 p-0">
      <legend className="text-sm text-accent">{t('measurement.fields.arm')}</legend>
      <div className="flex gap-2">
        {options.map((option) => (
          <label
            key={option.arm}
            className="flex min-h-11 min-w-11 cursor-pointer items-center justify-center gap-2 rounded-xl bg-fill px-3 text-base hover:bg-accent/10"
          >
            <input
              type="radio"
              name="arm"
              value={option.arm}
              checked={value === option.arm}
              onChange={() => onArm(option.arm)}
              className="h-5 w-5 accent-[var(--hl-accent)]"
            />
            {option.label}
          </label>
        ))}
      </div>
    </fieldset>
  );
}
