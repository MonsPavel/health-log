import type { IpcRendererEvent } from 'electron';

import electron = require('electron');

/**
 * Preload-мост `window.hl` (TASK-008 §5): единственная точка доступа рендерера к main
 * (арх. 08 §4 — preload только contextBridge). Валидация payload — в main (zod, §14);
 * мост только перенаправляет вызовы и события.
 *
 * invoke уходит ЕДИНЫМ транспортным каналом `hl:invoke` с {channel, payload}: проверку
 * «канал существует?» и zod-валидацию выполняет каркас main (§11/§13), у Electron нет
 * hook на invoke незарегистрированного канала. Строка дублируется намеренно: sandbox-
 * preload не может импортировать @hl/contracts (CJS без бандлера); дрейф константы
 * даёт громкую ошибку «No handler registered» в dev (комментарий register-channel.ts).
 *
 * on(name, cb) — подписка на событие шины main→renderer (TASK-009 §5/§11): события
 * идут единым транспортным каналом `hl:event` с конвертом {name, payload} (зеркало
 * contracts.HL_EVENT_CHANNEL — та же причина дублирования строки); preload разбирает
 * конверт и вызывает слушателя только своего имени. Payload-валидация на принимающей
 * стороне — будущая работа (обе стороны одной сборки, §5/арх. 05 §6). Возвращает
 * функцию отписки.
 *
 * Файл — .cts: пакет ESM («type»: «module»), а sandbox-preload обязан быть CommonJS
 * (§22) — TypeScript компилирует .cts только в CJS (dist/main/preload.cjs). Отсюда
 * verbatim-совместимый CJS-синтаксис `import = require` (verbatimModuleSyntax,
 * TASK-002 §13, отключение запрещено).
 *
 * TASK-062 §10/§14: при env HL_BENCH=1 мост ДОПОЛНЯЕТСЯ ключом `__bench` —
 * performance-хуки bench графика (measureChannel/measureRender). Хуки — функции
 * ISOLATED-мира preload: document/performance/MutationObserver здесь — то же
 * DOM-дерево страницы, ipcRenderer — прямой транспорт. Без флага ключа нет
 * (§14: поверхность bench только под флагом; гард канала `__bench/seed` —
 * отдельный, main-сторона bootstrap). Дополнять window.hl извне нельзя
 * (contextBridge-объект не расширяется) — инъекция живёт здесь; e2e-хелпер
 * launch.ts (§6) даёт лишь типизированные обёртки вызова этих хуков.
 */
const HL_INVOKE_CHANNEL = 'hl:invoke';

/** Транспортный канал событий; близнец — contracts.HL_EVENT_CHANNEL (см. шапку). */
const HL_EVENT_CHANNEL = 'hl:event';

/** Форма запроса к транспортному каналу; схема-близнец — contracts.HL_INVOKE_REQUEST_SCHEMA. */
interface InvokeRequest {
  readonly channel: string;
  readonly payload: unknown;
}

/** Транспортный вызов (indirection — точка обёртки bench-штампа, см. ниже). */
type InvokeImpl = (request: InvokeRequest) => Promise<unknown>;

/** Конверт события на транспортном канале; близнец — broadcast.ts (§11). */
interface EventEnvelope {
  readonly name: string;
  readonly payload: unknown;
}

/** Подписка на событие main→renderer: listener получает payload без объекта event. */
type EventListener = (payload: unknown) => void;

/** Результат bench-замера канала (§5 шаг 3): длительность + факт ok-конверта. */
interface BenchChannelMeasure {
  readonly ms: number;
  readonly ok: boolean;
}

/** Результат bench-замера рендера (§5 шаг 4): «данные получены → paint завершён». */
interface BenchRenderMeasure {
  readonly ms: number;
  /** true — график уже был смонтирован (кэш React Query): прогон нечестен, скрипт повторит. */
  readonly missed: boolean;
}

/**
 * TASK-062 §10: длительность measureRender строится performance.mark/measure:
 * старт — момент разрешения trend/series (обёртка транспорта ниже), конец —
 * кадр после появления фигуры графика (двойной rAF ≈ «paint завершён»;
 * §22 риск: рендер шумный — гейт с запасом, медиана прогонов).
 */
const BENCH_RENDER_MEASURE = 'hl-bench:render';
const BENCH_RENDER_START = 'hl-bench:render-start';
const BENCH_RENDER_END = 'hl-bench:render-end';

/** Фигура графика (TrendChart §16: role="img" + data-testid) — точка «смонтирован». */
const TREND_CHART_SELECTOR = '[data-testid="trend-chart"]';

/**
 * TASK-062 §10: DOM-поверхность isolated-мира preload — минимальные ЛОКАЛЬНЫЕ
 * объявления. lib DOM в tsconfig.main.json НЕ подключается (main-зона без DOM —
 * матрица арх. 03 §4), а preload — единственный файл, исполняемый в рендерере;
 * объявления описывают ровно то, что используют bench-хуки (same-document
 * isolated-мир: querySelector/MutationObserver/rAF/location — доступны в рантайме).
 */
interface BenchDomElement {
  readonly nodeType: number;
}
interface BenchDomDocument {
  querySelector(selectors: string): BenchDomElement | null;
  readonly documentElement: BenchDomElement;
}
interface BenchMutationObserver {
  disconnect(): void;
  observe(target: BenchDomElement, options: { childList: boolean; subtree: boolean }): void;
}
declare const document: BenchDomDocument;
declare const window: { location: { hash: string } };
declare const MutationObserver: {
  new (callback: () => void): BenchMutationObserver;
};
declare function requestAnimationFrame(callback: () => void): number;

/**
 * Bench-состояние штампа: активно только между measureRender-вызовами (§14:
 * замер — осознанное действие bench-скрипта; фоновых наблюдателей в проде нет —
 * ключ __bench отсутствует без флага, а внутри bench-прогона штамп выключен вне
 * measureRender).
 */
let benchStampArmed = false;
let benchTrendReceivedMs = 0;

/**
 * Базовый invoke: прямой транспорт `hl:invoke`. Вынесен в переменную, чтобы
 * bench-режим подменял ЛОКАЛЬНУЮ ссылку (invokeImpl), а не мутировал объекты
 * electron — contextBridge/ipcRenderer для того не предназначены.
 */
const baseInvoke: InvokeImpl = (request) => electron.ipcRenderer.invoke(HL_INVOKE_CHANNEL, request);

let invokeImpl: InvokeImpl = baseInvoke;

/** Мост `hl.invoke`: каждый вызов идёт через текущий invokeImpl (обёртка видна). */
const bridgeInvoke = (channel: string, payload: unknown): Promise<unknown> =>
  invokeImpl({ channel, payload });

/**
 * Обёртка штампа точки «данные получены» (§5 шаг 4): разрешение ответа trend/series
 * отмечается mark-ом performance — длительность рендера меряется от неё до
 * paint-кадра. Штамп включается только на armed-прогон measureRender.
 */
const stampingInvoke: InvokeImpl = (request) => {
  const promise = baseInvoke(request);
  if (!benchStampArmed || request.channel !== 'trend/series') {
    return promise;
  }
  return promise.then((result) => {
    benchTrendReceivedMs = performance.now();
    performance.mark(BENCH_RENDER_START);
    return result;
  });
};

/** Фигура графика в DOM (isolated-мир видит то же DOM-дерево, что и страница). */
function queryTrendChart(): Element | null {
  return document.querySelector(TREND_CHART_SELECTOR);
}

/** Двойной rAF (§5 шаг 4: «paint завершён через requestAnimationFrame»). */
function afterPaint(callback: () => void): void {
  requestAnimationFrame(() => {
    requestAnimationFrame(callback);
  });
}

/**
 * Bench-хуки (§10). Форма measureRender(переход-хэш), а не measureRender(cb):
 * функции-аргументы из main-мира через contextBridge не проходят, а триггер
 * монтирования графика — переход маршрута (HashRouter).
 */
function createBenchBridge(): Record<string, unknown> {
  return {
    /**
     * Замер A (§5 шаг 3, РЕШЕНИЕ §5: «замер из renderer — performance.now()
     * вокруг invoke»): полный round-trip канала из рендерера; ok — факт
     * ok-конверта (скрипт отвергает прогон с отказом канала).
     */
    measureChannel(channel: string, payload: unknown): Promise<BenchChannelMeasure> {
      const startedAtMs = performance.now();
      return baseInvoke({ channel, payload }).then((raw) => ({
        ms: performance.now() - startedAtMs,
        ok: (raw as { ok?: unknown } | null)?.ok === true,
      }));
    },

    /**
     * Замер B (§5 шаг 4): точка «данные получены» → «paint завершён».
     * hash — маршрут перехода («#/dashboard?period=all»): триггер монтирования
     * РЕАЛЬНОГО графика приложения. Miss-детекция: фигура уже в DOM (кэш React
     * Query) — прогон нечестен ({missed: true}), скрипт перезапустит его на
     * свежей странице.
     */
    measureRender(hash: string): Promise<BenchRenderMeasure> {
      if (queryTrendChart() !== null) {
        return Promise.resolve({ ms: 0, missed: true });
      }
      benchTrendReceivedMs = 0;
      benchStampArmed = true;
      invokeImpl = stampingInvoke;
      return new Promise<BenchRenderMeasure>((resolve) => {
        const observer = new MutationObserver(() => {
          if (queryTrendChart() === null) {
            return;
          }
          observer.disconnect();
          afterPaint(() => {
            let ms = 0;
            if (benchTrendReceivedMs > 0) {
              performance.mark(BENCH_RENDER_END);
              ms = performance.measure(
                BENCH_RENDER_MEASURE,
                BENCH_RENDER_START,
                BENCH_RENDER_END,
              ).duration;
            }
            benchStampArmed = false;
            invokeImpl = baseInvoke;
            resolve({ ms, missed: benchTrendReceivedMs === 0 });
          });
        });
        observer.observe(document.documentElement, { childList: true, subtree: true });
        window.location.hash = hash;
      });
    },
  };
}

electron.contextBridge.exposeInMainWorld('hl', {
  invoke: bridgeInvoke,

  on: (name: string, listener: EventListener): (() => void) => {
    const wrapped = (_event: IpcRendererEvent, envelope: unknown): void => {
      // Битый/чужой конверт молча игнорируется: у моста нет лога (арх. 08 §4), а
      // неверная форма — дрейф сборок main/preload, диагностируемый в dev (§5).
      if (
        typeof envelope === 'object' &&
        envelope !== null &&
        (envelope as EventEnvelope).name === name
      ) {
        listener((envelope as EventEnvelope).payload);
      }
    };
    electron.ipcRenderer.on(HL_EVENT_CHANNEL, wrapped);
    return () => {
      electron.ipcRenderer.removeListener(HL_EVENT_CHANNEL, wrapped);
    };
  },

  // TASK-062 §10/§14: ключ __bench — только при env-флаге HL_BENCH=1 (см. шапку).
  ...(process.env['HL_BENCH'] === '1' ? { __bench: createBenchBridge() } : {}),
});
