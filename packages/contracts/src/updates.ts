/**
 * TASK-096 §5/§11: контракты каналов обновлений `updates/*` — electron-updater в
 * ручном режиме (NFR-11): проверка только по согласию, скачивание покрывается тем
 * же согласием updatesCheck (§5 РЕШЕНИЕ: один флаг, текст согласия упоминает и
 * загрузку — документируется), установка — только по явному действию (кнопка UI
 * 097). Все схемы strict (§14 IPC-гигиены); типы выводятся из схем (§23).
 *
 * Ответы check/download — ЕДИНАЯ форма статуса (§23: одна схема на оба канала,
 * прецедент report/export-*): check отвечает available|latest|error, download —
 * ready|error; ход загрузки — событием update:progress (§11), не ответом канала.
 * version — версия обновления из фида (метаданные, без PHI, §14).
 */
import { z } from 'zod';

/** §11: запрос updates/check — {} (согласие/журнал/канал — решает main, §9). */
export const UPDATES_CHECK_REQUEST_SCHEMA = z.object({}).strict();

/** Запрос updates/check. */
export type UpdatesCheckRequest = z.infer<typeof UPDATES_CHECK_REQUEST_SCHEMA>;

/**
 * Единая форма статуса операции обновления (§5/§11): {status, version?}.
 * status: available — есть обновление; latest — версия актуальна; ready —
 * обновление скачано (финал download); error — сетевая неудача (НЕ креш и не
 * тост-спам — исход канала, §9).
 */
export const UPDATES_STATUS_RESPONSE_SCHEMA = z
  .object({
    status: z.enum(['available', 'latest', 'ready', 'error']),
    version: z.string().min(1).optional(),
  })
  .strict();

/** Ответ каналов updates/check и updates/download. */
export type UpdatesStatusResponse = z.infer<typeof UPDATES_STATUS_RESPONSE_SCHEMA>;

/** §11: запрос updates/download — {} (согласие то же — updatesCheck, §5 РЕШЕНИЕ). */
export const UPDATES_DOWNLOAD_REQUEST_SCHEMA = z.object({}).strict();

/** Запрос updates/download. */
export type UpdatesDownloadRequest = z.infer<typeof UPDATES_DOWNLOAD_REQUEST_SCHEMA>;

/** §11: запрос updates/install — {} (явное действие пользователя; consent не нужен — локальная операция). */
export const UPDATES_INSTALL_REQUEST_SCHEMA = z.object({}).strict();

/** Запрос updates/install. */
export type UpdatesInstallRequest = z.infer<typeof UPDATES_INSTALL_REQUEST_SCHEMA>;

/** §11: ответ updates/install — {restarting: true}: quitAndInstall ушёл (updater сам перезапускает, §13). */
export const UPDATES_INSTALL_RESPONSE_SCHEMA = z.object({ restarting: z.literal(true) }).strict();

/** Ответ updates/install. */
export type UpdatesInstallResponse = z.infer<typeof UPDATES_INSTALL_RESPONSE_SCHEMA>;
