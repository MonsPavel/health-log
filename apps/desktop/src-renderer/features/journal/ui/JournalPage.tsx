/**
 * TASK-033 §2/§5: маршрут /journal — экран «Журнал»: список записей по дням
 * (HistoryScreen: пустое состояние с CTA, «Показать ещё», live-обновление) с
 * переключением на форму ввода (TASK-031) по кнопке «Добавить»/CTA. Форма как
 * вкладка «ввода» (TASK-031) заменена переключателем внутри HistoryScreen.
 */
import { HistoryScreen } from '../../measurement/ui/HistoryScreen';

export function JournalPage(): JSX.Element {
  return <HistoryScreen />;
}
