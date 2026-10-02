/**
 * TASK-103 §12/§19: api-слой секции «Диагностика» поверх каналов `diag/preview|
 * diag/save`. СОСТОЯНИЕ (§12): обе операции — useMutation (сборка и сохранение —
 * явные действия пользователя, никаких фоновых запросов; кэш-запрос не нужен —
 * содержимое собирается main-стороной на каждый клик). Отказ конверта —
 * IpcApiError с DTO (§11, прецедент use-privacy).
 */
import { useMutation } from '@tanstack/react-query';

import type { DiagContent, DiagSaveResponse } from '@hl/contracts';

import { call } from '../../../src/lib/ipc';
import { IpcApiError } from '../model/use-preferences';
import type { ApiResult } from '@hl/contracts';

/** Разворот конверта: ok:false — IpcApiError с DTO (§11, прецедент use-privacy). */
function unwrap<T>(result: ApiResult<T>): T {
  if (!result.ok) {
    throw new IpcApiError(result.error);
  }
  return result.data;
}

/** Сборка содержимого пакета для предпросмотра (§5: явное действие). */
async function collectPreview(): Promise<DiagContent> {
  return unwrap(await call('diag/preview', {}));
}

/** Сохранение zip (§11: путь выбирает save-диалог main; отмена — {canceled}). */
async function saveBundle(): Promise<DiagSaveResponse> {
  return unwrap(await call('diag/save', {}));
}

/** Сборка пакета (мутация: содержимое предпросмотра — данные мутации). */
export function useDiagCollect() {
  return useMutation<DiagContent, Error, void>({ mutationFn: collectPreview });
}

/** Сохранение пакета (мутация: {path} | {canceled: true}). */
export function useDiagSave() {
  return useMutation<DiagSaveResponse, Error, void>({ mutationFn: saveBundle });
}
