/**
 * TASK-013 §5 → TASK-031 §4: маршрут /journal — вкладка ввода: форма измерения
 * (TASK-031) вместо заглушки. Успех без обработки флагов: диалоги подтверждений —
 * TASK-032 (§24 там: «add работает без диалога — флаги просто игнорируются»),
 * история и пустое состояние списка — TASK-033.
 */
import { MeasurementForm } from '../../measurement/ui/MeasurementForm';

export function JournalPage(): JSX.Element {
  return <MeasurementForm />;
}
