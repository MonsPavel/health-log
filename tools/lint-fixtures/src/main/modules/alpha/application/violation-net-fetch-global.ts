// TASK-075 §19/§20: глобальный fetch вне каталога egress ОБЯЗАН давать error
// (no-restricted-globals) — трафик приложения только через EgressGateway (D11).
export const runQuery = (url: string): Promise<Response> => fetch(url);
