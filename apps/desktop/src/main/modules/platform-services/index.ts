/**
 * platform-services — публичный API модуля (арх. 03 §4: чужой модуль импортируется
 * ТОЛЬКО через этот index — правило module-public-api TASK-005; прецеденты
 * analytics/measurement/reporting index.ts).
 *
 * Минимальная поверхность для межмодульных потребителей: EgressGateway — шлюз
 * egress (tmp-БД + consent-гварды + broadcast-мост + fetch), нужен потребителям
 * вне модуля (первый — int-тест адаптера model-store в ai-insight, TASK-080:
 * реальный шлюз с tmp-БД, прецедент egress-gateway.int.test.ts). Composition
 * root (container.ts) импортирует напрямую — он вне правил межмодульных границ
 * (собирает граф целиком). Расширять список экспорта осознанно.
 */
export { EgressGateway } from './egress/egress-gateway.js';
export type { EgressNotify } from './egress/egress-gateway.js';
