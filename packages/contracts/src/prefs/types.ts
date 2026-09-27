/**
 * TASK-047 §5/§23: типы настроек выводятся из zod-схем (z.infer) — никакой ручной
 * синхронизации. Потребители: PreferencesService и хендлеры prefs/* (main),
 * use-preferences и ThemeProvider (renderer).
 */
import type { z } from 'zod';

import type {
  NET_CONSENTS_SCHEMA,
  PREFS_PATCH_SCHEMA,
  PREFS_SCHEMA,
} from './schemas.js';

/** Документ настроек (§5): иммутабельный VO на проводе и в хранилище (§7). */
export type Prefs = z.infer<typeof PREFS_SCHEMA>;

/** Patch prefs/set (§7): подмножество полей верхнего уровня; netConsents — целиком. */
export type PrefsPatch = z.infer<typeof PREFS_PATCH_SCHEMA>;

/** Согласия на сеть (§5/§14): редактор UI — TASK-099, читает EgressGateway TASK-075. */
export type NetConsents = z.infer<typeof NET_CONSENTS_SCHEMA>;
