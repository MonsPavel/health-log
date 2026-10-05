/**
 * TASK-073 §2/§5/§22: секция «Данные» на экране «Отчёты» (решение §2: секция на
 * «Отчётах», не отдельный маршрут). Тонкий оркестратор: три обособленные операции —
 * «Создать копию» (BackupDialog), «Восстановить из копии» (RestoreFlow), «Удалить
 * все данные» (WipeFlow); опасное удаление — визуально отделено от бытовых
 * настроек (§22: копирайт спокойный, операции обособлены). Состояния операций —
 * внутри потоков (§12: локальные state-машины диалогов).
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { BackupDialog } from './BackupDialog';
import { RestoreFlow } from './RestoreFlow';
import { WipeFlow } from './WipeFlow';

/** Секция «Данные» (§5): копия / восстановление / полное удаление. */
export function DataSection(): JSX.Element {
  const { t } = useTranslation();
  const [backupOpen, setBackupOpen] = useState(false);
  const [restoreOpen, setRestoreOpen] = useState(false);
  const [wipeOpen, setWipeOpen] = useState(false);

  return (
    <section
      data-testid="data-care"
      aria-labelledby="data-care-title"
      className="mb-6 rounded-[10px] bg-surface p-3"
    >
      <h2 id="data-care-title" className="hl-large-title text-text">
        {t('data.title')}
      </h2>
      <p className="mt-1 text-sm text-accent">{t('data.lead')}</p>

      <div className="mt-3 flex flex-col items-start gap-3">
        <button
          type="button"
          data-testid="data-backup-button"
          onClick={() => setBackupOpen(true)}
          className="min-h-11 rounded-xl bg-fill px-4 text-base font-medium text-text hover:bg-accent/10"
        >
          {t('data.backup.button')}
        </button>
        <button
          type="button"
          data-testid="data-restore-button"
          onClick={() => setRestoreOpen(true)}
          className="min-h-11 rounded-xl bg-fill px-4 text-base font-medium text-text hover:bg-accent/10"
        >
          {t('data.restore.button')}
        </button>
        {/* Опасная операция — обособлена от остальных (§22). */}
        <button
          type="button"
          data-testid="data-wipe-button"
          onClick={() => setWipeOpen(true)}
          className="min-h-11 rounded-xl bg-fill px-4 text-base font-semibold text-text hover:bg-accent/10"
        >
          {t('data.wipe.button')}
        </button>
      </div>

      <BackupDialog open={backupOpen} onClose={() => setBackupOpen(false)} />
      <RestoreFlow open={restoreOpen} onClose={() => setRestoreOpen(false)} />
      <WipeFlow open={wipeOpen} onClose={() => setWipeOpen(false)} />
    </section>
  );
}
