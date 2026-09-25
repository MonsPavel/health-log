import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App';

/**
 * Входная точка рендерера (TASK-007 §10): React 18 root, `<div id="root">` из index.html.
 */
const container = document.getElementById('root');
if (container === null) {
  throw new Error('#root не найден в index.html');
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
