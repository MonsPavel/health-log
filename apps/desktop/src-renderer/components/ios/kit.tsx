/**
 * TASK-123 v2: iOS-kit — общие примитивы iPad-стиля (iPadOS Settings/HIG).
 * Все цвета — токены (классы dark: запрещены, KI-3); роли ARIA сохраняют
 * семантику: переключатель — role="switch" (не чекбокс), группы — simple div.
 *
 * Компоненты НЕ тянут состояние: обёртки над классами + controlled-props —
 * состояние остаётся в существующих сторах экранов (§12).
 */
import type { ReactNode } from 'react';

/** Заголовок экрана — iOS LargeTitle (34/700). */
export function LargeTitle({ children }: { readonly children: ReactNode }): JSX.Element {
  return <h1 className="hl-large-title mb-6">{children}</h1>;
}

/** Подпись-заголовок группы над inset-карточкой (13/600 uppercase, muted). */
export function SectionHeader({ children }: { readonly children: ReactNode }): JSX.Element {
  return <div className="hl-section-header">{children}</div>;
}

/**
 * Inset grouped card (iOS Settings): белая группа radius 10 без рамки/тени —
 * глубину даёт контраст с grouped-фоном. Дети-строки разделяются hairline
 * (правило .hl-row + .hl-row в theme.css).
 */
export function GroupCard({
  children,
  testid,
}: {
  readonly children: ReactNode;
  readonly testid?: string;
}): JSX.Element {
  return (
    <div data-testid={testid} className="rounded-[10px] bg-surface px-0 py-0">
      {children}
    </div>
  );
}

/** Строка группы: горизонталь с внутренними отступами iOS (16/12). */
export function Row({
  children,
  className = '',
  testid,
}: {
  readonly children: ReactNode;
  readonly className?: string;
  readonly testid?: string;
}): JSX.Element {
  return (
    <div
      data-testid={testid}
      className={`hl-row flex min-h-11 items-center gap-3 px-4 py-2.5 ${className}`}
    >
      {children}
    </div>
  );
}

/** Подпись под группой (iOS footer, 13px muted). */
export function GroupFooter({ children }: { readonly children: ReactNode }): JSX.Element {
  return <p className="mt-1.5 px-4 text-[13px] leading-snug text-muted">{children}</p>;
}

/**
 * iOS-switch (51×31, ползунок; role="switch"): включён — трек status-ok,
 * выключен — fill. Состояние читается ПОЛОЖЕНИЕМ ползунка (не только цветом,
 * WCAG 1.4.1), aria-checked несёт семантику.
 */
export function IoSwitch({
  checked,
  onChange,
  labelText,
  testid,
  disabled = false,
  title,
}: {
  readonly checked: boolean;
  readonly onChange: (next: boolean) => void;
  readonly labelText: string;
  readonly testid?: string;
  readonly disabled?: boolean;
  /** Tooltip (§10: title — не единственный носитель подсказки). */
  readonly title?: string;
}): JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={labelText}
      data-testid={testid}
      disabled={disabled}
      title={title}
      onClick={() => onChange(!checked)}
      className={`relative h-[31px] w-[51px] shrink-0 rounded-full border border-transparent ${
        checked ? 'bg-status-ok' : 'bg-fill'
      } ${disabled ? 'opacity-80' : ''} focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent`}
    >
      <span
        className={`absolute top-[2px] h-[27px] w-[27px] rounded-full bg-white shadow-[0_2px_4px_rgb(0_0_0/0.25)] ${
          checked ? 'left-[22px]' : 'left-[2px]'
        }`}
      />
    </button>
  );
}

/** Chevron строки-перехода (SF Symbols chevron.right — упрощённый контур). */
export function Chevron(): JSX.Element {
  return (
    <svg
      aria-hidden="true"
      width="8"
      height="14"
      viewBox="0 0 8 14"
      fill="none"
      className="shrink-0 text-muted"
    >
      <path
        d="M1 1l6 6-6 6"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * Segmented control (iOS): контейнер fill, активный сегмент — surface с
 * лёгкой тенью. options: {value, label}; управляемый.
 */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  labelText,
  testid,
}: {
  readonly options: ReadonlyArray<{ readonly value: T; readonly label: string }>;
  readonly value: T;
  readonly onChange: (next: T) => void;
  readonly labelText: string;
  readonly testid?: string;
}): JSX.Element {
  return (
    <div
      role="radiogroup"
      aria-label={labelText}
      data-testid={testid}
      className="flex rounded-[9px] bg-fill p-[2px]"
    >
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(option.value)}
            className={`min-h-11 flex-1 rounded-[7px] px-3 text-sm font-medium ${
              active ? 'bg-surface text-text shadow-sm' : 'text-muted'
            }`}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
