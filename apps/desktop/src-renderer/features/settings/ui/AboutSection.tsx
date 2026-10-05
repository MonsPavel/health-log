/**
 * TASK-100 §2/§5/§10/§16: секция «О приложении» экрана настроек. Строки версий —
 * приложение/схема БД/активная шкала code+version/модель id+version если есть —
 * definition-list семантика (§16); время старта — startupMs из снимка сампроверки.
 * Статус-блок self-check: зелёный (healthy) / красный бейдж с деталями
 * (dbOk=false и др. — §10: повреждение видно явно, NFR-3) / нейтральный «ещё не
 * выполнялась» (null — locked-старт, §11). Кнопка «Полная проверка БД» — мутация
 * app/integrity-full (§4: full — по кнопке, стартовый снимок не мутирует §7).
 *
 * СОСТОЯНИЕ (§12): useQuery ['selfcheck']/['app-meta'] — статичны за сессию
 * (staleTime Infinity); полная проверка — useMutation, результат в компоненте.
 *
 * RECOVERY (§10): ссылка на восстановление появится с экраном TASK-101 — red-статус
 * сейчас только сигнализирует деталями (доступ к «строке состояния» честный: текст
 * + иконка §16, live-область).
 */
import { useTranslation } from 'react-i18next';

import { formatDateTime } from '../../../lib/i18n-date';
import { useAppMeta, useIntegrityFull, useSelfcheck } from '../api/use-about';

/** Строка версий (§16: dl — dt/dd пары). */
function Row(props: {
  readonly label: string;
  readonly value: string;
  readonly testId: string;
}): JSX.Element {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-sm text-accent">{props.label}</dt>
      <dd data-testid={props.testId} className="text-sm font-medium text-text">
        {props.value}
      </dd>
    </div>
  );
}

/** Секция «О приложении» (§5). */
export function AboutSection(): JSX.Element {
  const { t } = useTranslation();
  const { data: meta } = useAppMeta();
  const { data: report } = useSelfcheck();
  const full = useIntegrityFull();

  // Нормализация: null (канал недоступен/не отвечал данными) трактуем как «нет
  // данных» — секция рендерится с «—» и не падает (защитный рендер).
  const metaSnapshot = meta ?? undefined;
  const reportSnapshot = report ?? undefined;

  // §5/§10: зелёный — все факты healthy; красный — любой сбой; нейтральный —
  // самчек ещё не выполнялся (locked-старт, снимка нет — не выдумываем статус).
  const state: 'ok' | 'failed' | 'pending' =
    reportSnapshot === undefined
      ? 'pending'
      : reportSnapshot.dbOk && reportSnapshot.prefsOk && reportSnapshot.worker?.state !== 'failed'
        ? 'ok'
        : 'failed';

  return (
    <section aria-labelledby="about-title" data-testid="about-section" className="mt-6">
      <h2 id="about-title" className="mb-2 text-base font-medium">
        {t('about.title')}
      </h2>
      <div className="flex flex-col gap-3 rounded-md border border-border p-3">
        {/* §16: таблица версий — definition-list семантика. Защитный рендер:
            ответ без ожидаемых полей — «—», секция настроек не падает. */}
        <dl data-testid="about-versions" className="flex flex-col gap-2">
          <Row
            label={t('about.version.app')}
            value={typeof metaSnapshot?.appVersion === 'string' ? metaSnapshot.appVersion : '—'}
            testId="about-version-app"
          />
          <Row
            label={t('about.version.schema')}
            value={
              typeof metaSnapshot?.schemaVersion === 'number'
                ? String(metaSnapshot.schemaVersion)
                : '—'
            }
            testId="about-version-schema"
          />
          <Row
            label={t('about.version.scale')}
            value={
              metaSnapshot?.scale !== undefined &&
              typeof metaSnapshot.scale.code === 'string' &&
              typeof metaSnapshot.scale.version === 'string'
                ? t('about.value.scale', {
                    code: metaSnapshot.scale.code,
                    version: metaSnapshot.scale.version,
                  })
                : '—'
            }
            testId="about-version-scale"
          />
          {/* §5: модель — «id+version если есть»; не выбрана — строки нет. */}
          {metaSnapshot?.model !== undefined &&
          typeof metaSnapshot.model.id === 'string' &&
          typeof metaSnapshot.model.version === 'string' ? (
            <Row
              label={t('about.version.model')}
              value={t('about.value.model', {
                id: metaSnapshot.model.id,
                version: metaSnapshot.model.version,
              })}
              testId="about-version-model"
            />
          ) : null}
          <Row
            label={t('about.startup')}
            value={reportSnapshot ? t('about.startupMs', { ms: reportSnapshot.startupMs }) : '—'}
            testId="about-startup"
          />
        </dl>

        {/* §16: live-область статуса — смена состояния озвучивается. */}
        <div aria-live="polite" className="flex flex-col gap-1">
          <p className="text-sm font-medium text-text">{t('about.selfcheck.title')}</p>
          <div
            data-testid="about-selfcheck-status"
            role="status"
            data-state={state}
            className={`flex items-center gap-2 rounded-md border p-3 text-sm font-medium ${
              state === 'ok'
                ? 'border-border bg-transparent text-status-ok'
                : state === 'failed'
                  ? 'border-status-fail bg-transparent text-status-fail'
                  : 'border-border bg-transparent text-accent'
            }`}
          >
            {/* §16: статус — текст + иконка (не только цветом). */}
            <span aria-hidden="true">{state === 'ok' ? '✓' : state === 'failed' ? '✕' : '–'}</span>
            <span>
              {state === 'ok'
                ? t('about.selfcheck.ok')
                : state === 'failed'
                  ? t('about.selfcheck.failed')
                  : t('about.selfcheck.pending')}
            </span>
          </div>
          {/* §5: красный статус — с деталями (какая проверка не прошла). */}
          {state === 'failed' && reportSnapshot ? (
            <ul
              data-testid="about-selfcheck-details"
              className="list-disc space-y-1 pl-5 text-sm text-status-fail"
            >
              {!reportSnapshot.dbOk ? <li>{t('about.selfcheck.dbCorrupt')}</li> : null}
              {!reportSnapshot.prefsOk ? <li>{t('about.selfcheck.prefsFailed')}</li> : null}
              {reportSnapshot.worker?.state === 'failed' ? (
                <li>{t('about.selfcheck.workerFailed')}</li>
              ) : null}
            </ul>
          ) : null}
          {state === 'ok' && reportSnapshot ? (
            <p className="text-sm text-accent">
              {t('about.selfcheck.checkedAt', {
                time: formatDateTime(
                  {
                    utcMs: reportSnapshot.checkedAtUtc,
                    tzOffsetMin: -new Date(reportSnapshot.checkedAtUtc).getTimezoneOffset(),
                  },
                  { preset: 'datetime' },
                ),
              })}
            </p>
          ) : null}
        </div>

        {/* §4: полная проверка — по кнопке (quick_check на старте — компромисс
            скорости; full тяжелее, отдельный запрос §7/§11). */}
        <div className="flex flex-col gap-2">
          <button
            type="button"
            data-testid="about-full-check"
            disabled={full.isPending}
            aria-busy={full.isPending}
            onClick={() => full.mutate()}
            className="min-h-11 rounded-md border border-border bg-bg px-4 text-base font-semibold text-text disabled:cursor-not-allowed disabled:opacity-80"
          >
            {t('about.fullCheck.title')}
          </button>
          <p className="text-sm text-accent">{t('about.fullCheck.hint')}</p>
          {full.isPending ? (
            <p role="status" data-testid="about-full-check-running" className="text-sm text-text">
              {t('about.fullCheck.running')}
            </p>
          ) : null}
          {/* §7: результат отдельный — стартовый снимок не перечитывается. */}
          {full.data !== undefined ? (
            full.data.ok ? (
              <p
                role="status"
                data-testid="about-full-check-result"
                data-state="ok"
                className="text-sm text-status-ok"
              >
                {t('about.fullCheck.ok')}
              </p>
            ) : (
              <div
                data-testid="about-full-check-result"
                data-state="failed"
                role="alert"
                className="flex flex-col gap-1"
              >
                <p className="text-sm font-medium text-status-fail">
                  {t('about.fullCheck.failed')}
                </p>
                <p
                  data-testid="about-full-check-details"
                  className="break-words text-sm text-status-fail"
                >
                  {full.data.details}
                </p>
              </div>
            )
          ) : null}
          {full.isError ? (
            <p role="alert" className="text-sm text-status-fail">
              {t('about.fullCheck.error')}
            </p>
          ) : null}
        </div>
      </div>
    </section>
  );
}
