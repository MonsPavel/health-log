/**
 * TASK-047 §5/§23: типы настроек выводятся из zod-схем (z.infer) — никакой ручной
 * синхронизации. Потребители: PreferencesService и хендлеры prefs/* (main),
 * use-preferences и ThemeProvider (renderer).
 */
import type { z } from 'zod';

import type {
  JOB_LAST_BACKUP_SCHEMA,
  JOB_STATE_SCHEMA,
  NET_CONSENTS_SCHEMA,
  PREFS_GET_REQUEST_SCHEMA,
  PREFS_GET_RESPONSE_SCHEMA,
  PREFS_PATCH_SCHEMA,
  PREFS_SCHEMA,
  PREFS_SET_REQUEST_SCHEMA,
  PREFS_SET_RESPONSE_SCHEMA,
} from './schemas.js';

/** Документ настроек (§5): иммутабельный VO на проводе и в хранилище (§7). */
export type Prefs = z.infer<typeof PREFS_SCHEMA>;

/** Patch prefs/set (§7): подмножество полей верхнего уровня; netConsents — целиком. */
export type PrefsPatch = z.infer<typeof PREFS_PATCH_SCHEMA>;

/** Согласия на сеть (§5/§14): редактор UI — TASK-099, читает EgressGateway TASK-075. */
export type NetConsents = z.infer<typeof NET_CONSENTS_SCHEMA>;

/** TASK-074 §5: состояние каркасных задач (JobScheduler) в документе prefs. */
export type JobState = z.infer<typeof JOB_STATE_SCHEMA>;

/** TASK-074 §5: метаданные последней копии (путь/дата). */
export type JobLastBackup = z.infer<typeof JOB_LAST_BACKUP_SCHEMA>;

/** §11: запрос/ответ prefs/get (полный документ без параметров). */
export type PrefsGetRequest = z.infer<typeof PREFS_GET_REQUEST_SCHEMA>;
export type PrefsGetResponse = z.infer<typeof PREFS_GET_RESPONSE_SCHEMA>;

/** §11: запрос/ответ prefs/set ({patch} → обновлённый полный документ). */
export type PrefsSetRequest = z.infer<typeof PREFS_SET_REQUEST_SCHEMA>;
export type PrefsSetResponse = z.infer<typeof PREFS_SET_RESPONSE_SCHEMA>;
