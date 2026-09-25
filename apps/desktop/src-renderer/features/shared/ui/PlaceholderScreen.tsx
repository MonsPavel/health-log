/**
 * TASK-013 §5/§10: PlaceholderScreen — одна экранная заглушка на все маршруты:
 * проп-ключ заголовка (общий компонент, разделы различаются ключом каталога) +
 * обучающий пустой текст common.wip (FR-9.2) + иконка, ничего больше (§10).
 *
 * titleKey — строковый ключ каталога («с пропом-ключом», §6); литерал ключа
 * остаётся в вызывающей странице-маршруте — конвенция §22 против динамических
 * ключей: check:i18n видит литерал в странице.
 */
import { useTranslation } from 'react-i18next';

/** Props заглушки: ключ заголовка из каталога и декоративная иконка. */
export interface PlaceholderScreenProps {
  /** Ключ заголовка раздела, например 'common.nav.dashboard'. */
  readonly titleKey: string;
  /** Иконка пустого состояния; декоративная — скрыта от скринридера (§16). */
  readonly icon: string;
}

/** Экран-заглушка маршрута до появления фичи (§5). */
export function PlaceholderScreen({ titleKey, icon }: PlaceholderScreenProps): JSX.Element {
  const { t } = useTranslation();

  return (
    <section className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
      <span aria-hidden="true" className="text-6xl">
        {icon}
      </span>
      <h1 className="text-2xl font-semibold">{t(titleKey)}</h1>
      <p className="text-accent">{t('common.wip')}</p>
    </section>
  );
}
