/**
 * TASK-038 §5/§16: меню-кнопка строки журнала (⋮): «Изменить» → форма в режиме
 * edit, «Удалить» → диалог подтверждения. Компонент презентационный — решение о
 * правке/удалении принимает владелец (HistoryScreen через MeasurementRow).
 *
 * ДОСТУПНОСТЬ (§16): Radix DropdownMenu — триггер сам ставит aria-haspopup="menu"
 * и aria-expanded; радиофокус-возврат в строку из коробки (закрытие меню возвращает
 * фокус триггеру). data-row-menu — якорь для фокус-возврата экрана после
 * edit/удаления (§16/§20: «фокус возвращается в строку списка»).
 *
 * Иконки (§22 TASK-033): библиотеки иконок в MVP нет — глиф «⋮» текстом, имя
 * кнопки — aria-label (ключ row.menu.label).
 */
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { useTranslation } from 'react-i18next';

/** Props меню: id записи (якорь фокуса) + решения пользователя. */
export interface RowMenuProps {
  /** id записи — data-row-menu триггера (фокус-возврат экрана, §16). */
  readonly measurementId: string;
  /** «Изменить» — владелец открывает форму в режиме edit (§5). */
  readonly onEdit: () => void;
  /** «Удалить» — владелец открывает подтверждение удаления (§5). */
  readonly onDelete: () => void;
}

/** Меню действий строки журнала (§2). */
export function RowMenu({ measurementId, onEdit, onDelete }: RowMenuProps): JSX.Element {
  const { t } = useTranslation();

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          data-testid={`row-menu-${measurementId}`}
          data-row-menu={measurementId}
          aria-label={t('measurement.row.menu.label')}
          className="min-h-11 shrink-0 rounded px-2 text-base text-muted hover:bg-accent/10 hover:text-text"
        >
          ⋮
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          data-testid="row-menu-content"
          align="end"
          sideOffset={4}
          className="min-w-40 rounded-md border border-border bg-bg p-1 shadow-lg"
        >
          <DropdownMenu.Item
            data-testid="row-menu-edit"
            onSelect={onEdit}
            className="cursor-pointer rounded px-3 py-2 text-sm text-text outline-none data-highlighted:bg-accent/10"
          >
            {t('measurement.row.menu.edit')}
          </DropdownMenu.Item>
          <DropdownMenu.Item
            data-testid="row-menu-delete"
            onSelect={onDelete}
            className="cursor-pointer rounded px-3 py-2 text-sm text-text outline-none data-highlighted:bg-accent/10"
          >
            {t('measurement.row.menu.delete')}
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
