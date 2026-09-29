// TASK-075 §19/§20: зона-исключение линт-правила — каталог egress (здесь живёт боевой
// исполнитель EgressGateway, §4/§5): и импорт node:https, и глобальный fetch ОБЯЗАНЫ
// быть чистыми (контраст к violation-net-import/violation-net-fetch-global).
import { request } from 'node:https';

export const gatewayTransport = {
  netRequest: request,
  fallback: (url: string): Promise<Response> => fetch(url),
};
