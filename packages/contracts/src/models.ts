/**
 * TASK-079 §2/§7: zod-схема дескриптора модели ModelDescriptor и манифеста
 * MODELS_MANIFEST_SCHEMA — реестр GGUF, комплектуемый с приложением
 * (apps/desktop/resources/models-manifest.json; смена списка = обновление
 * приложения, §4: не требует доверенного канала в рантайме).
 *
 * Манифест — единственный источник «что можно поставить» (§3, FR-5.8): размер/
 * язык/версия видны ДО загрузки; целостность файла — sha256 до запуска (080 не
 * грузит без него, §14). ОТБОР моделей (каких включить) — внешний процесс
 * (PM-план, спринт 7): схема фиксирует ФОРМУ, пустой список валиден (§2).
 *
 * Инварианты §13 (тест-таблица models.test.ts):
 *  - url — абсолютный https (zod refine; http запрещён — §14 безопасность);
 *  - sha256 — ровно 64 hex-символа;
 *  - sizeBytes — целое > 0;
 *  - languages — непустой список непустых кодов;
 *  - minRamGb > 0; обязательные строки непустые; неизвестные поля запрещены
 *    (strict, §14 IPC-гигиены — тот же принцип для статического ресурса);
 *  - дубликаты id → отказ (манифест-уровень, MODELS_MANIFEST_SCHEMA).
 *
 * Сообщения схем — технические метки причин (попадают в cause отказа реестра
 * и лог main, TASK-006 §14: наружу не сериализуются), не пользовательские
 * тексты; notesKey записи — ключ i18n особой пометки (§16–17).
 */
import { z } from 'zod';

/** sha256: ровно 64 hex-символа (§13; 080 сверяет до запуска модели). */
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

/**
 * Дескриптор модели (§7). name — продуктовое имя латиницей (§16–17, не
 * переводится); file — имя файла в каталоге моделей (не путь: путь строит
 * main); url — абсолютный https прямого хостинга (§4); license — лицензия
 * GGUF/базовой модели (юр. чистота дистрибуции, §14).
 */
export const MODEL_DESCRIPTOR_SCHEMA = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    version: z.string().min(1),
    file: z.string().min(1),
    url: z
      .url('models.urlFormat')
      .refine((url) => url.startsWith('https://'), 'models.urlHttpsOnly'),
    sha256: z.string().regex(SHA256_PATTERN, 'models.sha256Hex64'),
    sizeBytes: z.number().int('models.sizeBytesInt').positive('models.sizeBytesPositive'),
    languages: z.array(z.string().min(1)).min(1, 'models.languagesNonEmpty'),
    minRamGb: z.number().positive('models.minRamGbPositive'),
    license: z.string().min(1),
    notesKey: z.string().min(1).optional(),
  })
  .strict();

/**
 * Манифест — список дескрипторов с инвариантом уникальности id (§13: дубликаты
 * id → отказ: неоднозначность «что ставить» недопустима). Пустой список валиден —
 * форма фиксируется схемой, состав определяет внешний процесс отбора (§2).
 */
export const MODELS_MANIFEST_SCHEMA = z
  .array(MODEL_DESCRIPTOR_SCHEMA)
  .superRefine((models, ctx) => {
    const seen = new Set<string>();
    for (const [index, model] of models.entries()) {
      if (seen.has(model.id)) {
        ctx.addIssue({ code: 'custom', message: 'models.duplicateId', path: [index, 'id'] });
        continue;
      }
      seen.add(model.id);
    }
  });

/** Дескриптор модели (§7) — форма записи манифеста и ответа `ai/models/list` (§11 079/081). */
export type ModelDescriptor = z.infer<typeof MODEL_DESCRIPTOR_SCHEMA>;

/** Манифест моделей — валидированное содержимое ресурса models-manifest.json. */
export type ModelsManifest = z.infer<typeof MODELS_MANIFEST_SCHEMA>;
