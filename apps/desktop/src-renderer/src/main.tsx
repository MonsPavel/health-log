import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { applyPersistedAppearance } from '../app/theme/ThemeProvider';
import '../app/theme/tokens.css';
import '../app/theme/theme.css';
import { App } from './App';

/**
 * Входная точка рендерера (TASK-007 §10; TASK-013 §13): React 18 root, `<div id="root">`
 * из index.html. Сохранённые тема и rem-масштаб текста применяются ДО первого рендера
 * (applyPersistedAppearance — защита от FOUC §13; inline-скрипт в index.html невозможен
 * при prod-CSP script-src 'self', TASK-008 §14). CSS токенов — до рендера (§6).
 */
applyPersistedAppearance();

const container = document.getElementById('root');
if (container === null) {
  throw new Error('#root не найден в index.html');
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
