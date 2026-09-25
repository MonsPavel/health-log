/**
 * Клиент IPC для рендерера (TASK-008 §10): типизированная обёртка над
 * `window.hl.invoke` с дженериком по реестру схем contracts — `call('app/ping', payload)`
 * возвращает `Promise<ApiResult<PingResponse>>`. Никаких прямых ipcRenderer в
 * компонентах (арх. 03 §4): компоненты импортируют только call() из этого модуля.
 *
 * Ответ моста проверяется type-guard isApiEnvelope: форма конверта и версия v —
 * контракт арх. 05 §6; несовпадение (повреждённый ответ/дрейф версий) — developer-
 * ошибка, диагностическое исключение, не пользовательский текст (§17).
 */
import {
  isApiEnvelope,
  type ApiResult,
  type ChannelName,
  type ChannelRequest,
  type ChannelResponse,
  type HlBridge,
} from '@hl/contracts';

declare global {
  interface Window {
    /** Мост из preload.cts (namespace `hl` — §5, арх. 08 §4). */
    readonly hl: HlBridge;
  }
}

/** Вызов прикладного канала: payload/ответ типизированы реестром схем (contracts, §23). */
export function call<C extends ChannelName>(
  channel: C,
  payload: ChannelRequest<C>,
): Promise<ApiResult<ChannelResponse<C>>> {
  return window.hl.invoke(channel, payload).then((raw) => {
    if (!isApiEnvelope(raw)) {
      throw new Error(
        `IPC: некорректный конверт ответа канала ${channel} (ожидался {v:1, ok, data|error})`,
      );
    }
    return raw as ApiResult<ChannelResponse<C>>;
  });
}
