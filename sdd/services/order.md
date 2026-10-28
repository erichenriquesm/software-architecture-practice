# Serviço `order` — Gestão de Ordens

> Status: **spec** · Subdomínio: **Core (suporte ao matching)** · Modelagem: **rica (máquina de estados)**

## 1. Responsabilidade

- Receber ordens limitadas de compra e venda (`PlaceOrder`) e pedidos de cancelamento (`CancelOrder`).
- Conduzir a saga até a ordem entrar no livro: aguardar a reserva de saldo no `wallet`, depois aceitar.
- Manter o ciclo de vida da ordem visto pelo usuário: fills, preço médio, status.
- Responder o histórico de ordens por conta e a consulta de ordem por id.

**Fora do escopo:** casar ordens (é do `matching`), saldo (é do `wallet`), ordem a mercado ([Q8](../99-decisoes.md#q8)).

## 2. Workload

HTTP de escrita (criar/cancelar) e de leitura (histórico), mais uma máquina de estados alimentada por eventos. Sem contenção forte: cada ordem só é alterada por eventos dela mesma. Escala horizontal (`api` e `worker` separados).

## 3. Modelo de domínio

**Agregado `Order`**: `orderId`, `marketId`, `accountId`, `side`, `quantity`, `price` (limite), `fillQuantity`, `fillValue` (Σ `qty × price` dos fills), `reservation` (`pending` \| `reserved` \| `rejected` \| `voided`), `voidReason` (`EXPIRED` \| `CANCELLED`, quando `voided`), `cancelRequested`, `removedQuantity` (quanto saiu do livro sem executar; `null` até o `matching` remover), `removalReason` (`CANCELLED` \| `SELF_TRADE_PREVENTION`, como no contrato de `matching.orderRemoved`), `createdAt`, `version`.

| Value Object | Regra |
|---|---|
| `MarketId` | Formato `BASE-QUOTE` e presente no catálogo `src/infra/contracts/markets.json` (cópia do original da infra) ([Q5](../99-decisoes.md#q5)) |
| `Side` | `buy` \| `sell` |
| `Quantity`, `Price` | `> 0`, decimal, escala 8 |
| `MarketFilters` | Do catálogo. **Preço múltiplo do tick** (`0.01`), **quantidade múltipla do step** (`0.00001`), **`qty × price ≥ minNotional`** (`5 USD`). Fora do filtro → rejeita, nunca arredonda ([Q11](../99-decisoes.md#q11)). |

**Status é derivado**, nunca atribuído à mão. Isso torna a ordem tolerante a eventos fora de ordem:

| Status | Condição (avaliada nesta ordem) |
|---|---|
| `rejected` | `reservation = rejected` |
| `expired` | `reservation = voided` e `voidReason = EXPIRED` (timeout da saga S2) |
| `cancelled` | `reservation = voided` e `voidReason = CANCELLED` (cancelada antes de entrar no livro) |
| `pending` | `reservation = pending` |
| `filled` | `fillQuantity = quantity` |
| `cancelled` | `removedQuantity ≠ null` e `fillQuantity + removedQuantity = quantity` (motivo em `removalReason`) |
| `cancelling` | `cancelRequested`, mas ainda sem `removedQuantity`, ou com fills atrasados para chegar |
| `partiallyFilled` | `fillQuantity > 0` |
| `open` | caso contrário |

`fillPrice = fillValue / fillQuantity` (preço médio ponderado; `null` sem fills).

**Comportamentos e invariantes**

| Método | Regra |
|---|---|
| `Order.place(...)` | Cria em `pending`; emite `OrderPlaced`. |
| `markReserved()` | Em `pending` → emite `OrderAccepted` (**pivot** da saga S2). Em `rejected`/`voided` → ignora (evento atrasado). |
| `markRejected(reason)` | Em `pending` → status final. Em `voided` → ignora. |
| `void(reason, now)` | Só em `pending`. `EXPIRED` exige `now − createdAt > ORDER_PENDING_TIMEOUT`. Emite `OrderVoided(reason)` (compensação da S2). |
| `applyFill(tradeId, qty, price)` | Só depois de `reserved`. `fillQuantity + qty ≤ quantity`. Aceito mesmo em `cancelling` (fill atrasado). |
| `requestCancel()` | Em `pending` → `void(CANCELLED)`: termina na hora, sem passar pelo `matching` ([Q7](../99-decisoes.md#q7)). Em `open`/`partiallyFilled` → `cancelRequested = true` e emite `OrderCancelRequested`. Em outro status → `InvalidOrderTransitionError`. |
| `markRemoved(remainingQty, reason)` | Registra `removedQuantity` e `removalReason`. Também chega sem pedido do usuário, quando o `matching` aplica STP ([Q9](../99-decisoes.md#q9)). |
| `cancelRejected()` | `cancelRequested = false` (a ordem já tinha sido totalmente executada). |

Transição inválida → `InvalidOrderTransitionError`.

## 4. Casos de uso

Os casos de uso têm nome de **intenção**, não de evento: nenhum sabe se foi chamado por HTTP, por fila ou por job. Quem liga o gatilho ao caso de uso é o adapter de entrada. Regra de DTO ([princípios §3.2](../01-principios.md#32-conven%C3%A7%C3%B5es-de-nomes)): até 2 valores entram e saem direto; 3 ou mais viram DTO.

| Caso de uso | Assinatura | Adapter de entrada (gatilho) | Passos |
|---|---|---|---|
| `PlaceOrder` | `execute(input: PlaceOrderInput): string` (o `orderId`) | REST `POST /place_order` | Valida VOs e `MarketFilters` → `Order.place` → salva → despacha `OrderPlaced`. A ordem nasce `pending`. |
| `CancelOrder` | `execute(orderId, accountId): OrderStatus` | REST `POST /cancel_order` | Carrega → confere o dono (`NotOrderOwnerError` → `403`) → `requestCancel` → salva → despacha `OrderVoided` (estava `pending`) ou `OrderCancelRequested` (estava no livro). Devolve o status novo (`cancelled` ou `cancelling`). |
| `AcceptOrder` | `execute(orderId): void` | consumer `order.fundsReservation` (`wallet.fundsReserved`) | `markReserved` → despacha `OrderAccepted` (pivot da S2). |
| `RejectOrder` | `execute(orderId, reason): void` | consumer `order.fundsReservation` (`wallet.fundsReservationRejected`) | `markRejected`. |
| `ExpireOrder` | `execute(orderId): void` | job `expirePendingOrders` (a cada `EXPIRE_PENDING_ORDERS_INTERVAL`) | O job lista as ordens `pending` vencidas (`OrderDao`) e chama `ExpireOrder` **uma vez por ordem**. O caso de uso faz `void(EXPIRED)` → despacha `OrderVoided`. |
| `ApplyFill` | `execute(input: ApplyFillInput): void` | consumer `order.matchingResults` (`matching.tradeExecuted`) | O consumer chama `ApplyFill` **duas vezes** (ordem de compra e de venda), cada uma na sua transação, inbox `eventId:orderId`. |
| `RegisterRemoval` | `execute(input: RegisterRemovalInput): void` | consumer `order.matchingResults` (`matching.orderRemoved`) | `markRemoved`. |
| `RevertCancelRequest` | `execute(orderId): void` | consumer `order.matchingResults` (`matching.orderCancelRejected`) | `cancelRejected`. |
| `GetOrders` | `execute(accountId, status?): OrderView[]` | REST `GET /accounts/:id/orders` | `OrderDao.listByAccount`. |
| `GetOrder` | `execute(orderId): OrderView` | REST `GET /orders/:id` | `OrderDao.findById`; `404` se não existir. |

DTOs (`application/dtos/`):

| DTO | Campos | Usado por |
|---|---|---|
| `PlaceOrderInput` | `accountId, marketId, side, quantity, price` | `PlaceOrder` |
| `ApplyFillInput` | `orderId, tradeId, quantity, price` | `ApplyFill` |
| `RegisterRemovalInput` | `orderId, remainingQuantity, reason` | `RegisterRemoval` |
| `OrderView` | `orderId, accountId, marketId, side, quantity, price, fillQuantity, fillPrice, timestamp, status, statusReason` | `GetOrders`, `GetOrder` (modelo de leitura do DAO) |

**Projeção síncrona.** O `KyselyOrderRepository.save` grava a tabela `order` **e** a `order_view` na mesma transação (o `OrderViewProjector` é chamado por ele). Assim toda mudança de estado chega à leitura, inclusive as que não geram evento (rejeição, fill, remoção), sem um handler por tipo de evento.

**Reações aos eventos de domínio:** o `orderIntegrationEvents` (handler transacional) grava no outbox `order.placed` (`OrderPlaced`), `order.accepted.<m>` (`OrderAccepted`), `order.cancelRequested.<m>` (`OrderCancelRequested`) e `order.voided` (`OrderVoided`).

**Concorrência:** cada ordem tem `version` (lock otimista), porque o evento do `wallet` e o cancelamento do usuário podem chegar juntos. Conflito → recarrega e tenta de novo (`retryOnConflict`, até 3×); persistindo, `409` no HTTP e retry na fila.

**Preço médio:** `fillPrice = fillValue / fillQuantity` é a única conta que pode não ser exata (`302 / 3`). Ela só existe na leitura (`order_view`), arredondada em 8 casas (meio para o par). O agregado guarda `fillValue` exato e nunca decide nada pelo preço médio.

As regras "conta existe" e "saldo suficiente considerando ordens em aberto" do objetivo são garantidas pelo `wallet` na reserva (§5.2 do [design estratégico](../02-design-estrategico.md#52-placeorder-saga-coreografada)). Por isso o `PlaceOrder` responde `pending`, e não `open`.

Contratos (interfaces em `application/contracts/`): `OrderRepository` (`findById`, `save` com `version`), `OrderDao` (`findById`, `listByAccount`, `listPendingCreatedBefore`), `MarketCatalog` (filtros do mercado lidos do `markets.json`), `TransactionRunner`, `DomainEventDispatcher`, `IdGenerator`, `Clock`. O health check fica em `infra/http/health.ts`.

Sagas em que este serviço participa: **S2** (dono), **S3** (fills), **S4** (dono). Ver [06-sagas.md](../06-sagas.md).

## 5. API pública (REST)

| Método | Rota | Entrada | Saída | Erros |
|---|---|---|---|---|
| POST | `/place_order` | `marketId, accountId, side, quantity, price` (`quantity` e `price` como string decimal) | `202 { orderId, status: "pending" }` | `422` |
| POST | `/cancel_order` | `orderId, accountId` | `202 { orderId, status }` (`cancelled` se estava `pending`; `cancelling` se estava no livro) | `404` · `403` não é dono · `409` status não permite ou conflito de concorrência persistente |
| GET | `/accounts/:accountId/orders?status=` | — | `200 [{ orderId, marketId, side, quantity, price, fillQuantity, fillPrice, timestamp, status, statusReason }]` | — |
| GET | `/orders/:orderId` | — | `200 { ...mesmos campos }` | `404` |

`POST /place_order` e `POST /cancel_order` aceitam `Idempotency-Key` ([Q13](../99-decisoes.md#q13)). `statusReason` explica status finais não óbvios: `INSUFFICIENT_FUNDS`, `WALLET_NOT_FOUND`, `EXPIRED`, `SELF_TRADE_PREVENTION`.

## 6. Mensageria

| Direção | Evento | Fila / Exchange |
|---|---|---|
| Publica | `order.placed`, `order.accepted.<marketId>`, `order.cancelRequested.<marketId>`, `order.voided` | `order.events` |
| Consome | `wallet.fundsReserved`, `wallet.fundsReservationRejected` | `order.fundsReservation` |
| Consome | `matching.tradeExecuted`, `matching.orderRemoved`, `matching.orderCancelRejected` | `order.matchingResults` |

O relay do outbox publica em ordem de `id`. Isso garante que `order.accepted` sempre sai antes do `order.cancelRequested` da mesma ordem.

Payloads publicados ([mensageria §3](../03-mensageria.md#3-cat%C3%A1logo-de-eventos-v1)): os schemas de `order.placed` e `order.voided` são **os mesmos bytes** das cópias que o `wallet` já guarda (o `order` vira o dono). `order.accepted` e `order.cancelRequested` ainda não têm consumidor construído (o `matching`); quando ele existir, guarda cópia deles.

A fila `order.matchingResults` recebe três tipos de evento num consumer só, que decide pelo `type`. O `tradeExecuted` vira duas partes (ordem de compra e de venda), cada uma com sua transação e chave de inbox `eventId:orderId`; os outros, uma parte.

## 7. Dados (`order-db`)

```sql
-- write model (aggregate state)
create table "order" (
  order_id          uuid primary key,
  market_id         text not null,
  account_id        uuid not null,
  side              text not null,
  quantity          numeric(36,8) not null,
  price             numeric(36,8) not null,
  fill_quantity     numeric(36,8) not null default 0,
  fill_value        numeric(36,8) not null default 0,
  reservation       text not null,          -- pending | reserved | rejected | voided
  void_reason       text,                   -- EXPIRED | CANCELLED
  reject_reason     text,                   -- INSUFFICIENT_FUNDS | WALLET_NOT_FOUND
  removal_reason    text,                   -- CANCELLED | SELF_TRADE_PREVENTION
  cancel_requested  boolean not null default false,
  removed_quantity  numeric(36,8),
  created_at        timestamptz not null,
  version           bigint not null default 0
);
create index order_pending on "order" (created_at) where reservation = 'pending';   -- saga timeout scan

-- sync projection (same transaction), shaped for GetOrders
create table order_view (
  order_id       uuid primary key,
  account_id     uuid not null,
  market_id      text not null,
  side           text not null,
  quantity       numeric(36,8) not null,
  price          numeric(36,8) not null,
  fill_quantity  numeric(36,8) not null,
  fill_price     numeric(36,8),
  status         text not null,             -- already derived
  status_reason  text,
  timestamp      timestamptz not null,
  updated_at     timestamptz not null
);
create index order_view_account on order_view (account_id, status, timestamp desc);

-- outbox, inbox: see 03-mensageria.md §5
```

Por que duas tabelas: a de escrita guarda o que o agregado precisa para decidir (`fill_value`, `removed_quantity`, `reservation`). A `order_view` guarda o que a tela mostra (status já derivado, `fill_price` calculado) e é indexada pela consulta por conta. Atualizar as duas na mesma transação mantém a leitura sem atraso.

## 8. Estrutura

```
backend/order/
  .env.example  .env.test.example  Makefile (migrações e testes)
  docker/                           Dockerfile  Dockerfile.dockerignore  docker-compose.yml  docker-compose.platform.yml  docker-compose.test.yml
  package.json  package-lock.json  tsconfig.json  eslint.config.mjs  .dependency-cruiser.cjs  vitest.config.ts
  src/
    domain/
      entities/                     order.ts  aggregateRoot.ts
      valueObjects/                 orderId.ts  accountId.ts  marketId.ts  side.ts  quantity.ts  price.ts  marketFilters.ts  orderStatus.ts
      domainEvents/                 domainEvent.ts  orderPlaced.ts  orderAccepted.ts  orderCancelRequested.ts  orderVoided.ts
      domainServices/               (vazio por enquanto: toda regra cabe no agregado Order)
      errors.ts
    application/
      usecases/                     placeOrder.ts  cancelOrder.ts  acceptOrder.ts  rejectOrder.ts  expireOrder.ts  applyFill.ts
                                    registerRemoval.ts  revertCancelRequest.ts  getOrders.ts  getOrder.ts
                                    useCase.ts  retryOnConflict.ts  orderStore.ts (carregar e salvar+despachar, comum aos comandos)
      dtos/                         placeOrderDto.ts  applyFillDto.ts  registerRemovalDto.ts  orderView.ts
      contracts/                    orderRepository.ts  orderDao.ts  marketCatalog.ts  transactionRunner.ts
                                    domainEventDispatcher.ts  idGenerator.ts  clock.ts
    infra/
      http/                         orderRoutes.ts (place, cancel, consultas, rate limit)  health.ts
      messaging/
        consumers/                  fundsReservationConsumer.ts  matchingResultsConsumer.ts  consumedEvent.ts
        orderIntegrationEvents.ts   domain event → outbox
      scheduler/expirePendingOrders.ts
      database/                     kyselyOrderRepository.ts  orderViewProjector.ts  kyselyOrderDao.ts
                                    kyselyTransactionRunner.ts  postgres.ts  database.ts  migrator.ts  migrationFiles.ts
        migrations/                 outbox, inbox, idempotency_key, order, order_view
      catalog/jsonMarketCatalog.ts  lê e valida o markets.json na subida
      platform/                     copiados do wallet (inclui Consumer com partes e reconexão ao RabbitMQ); sem gRPC
      contracts/
        published/events/           order.placed.v1  order.accepted.v1  order.cancelRequested.v1  order.voided.v1
        consumed/events/            wallet.fundsReserved.v1  wallet.fundsReservationRejected.v1
                                    matching.tradeExecuted.v1  matching.orderRemoved.v1  matching.orderCancelRejected.v1
        envelope.schema.json  markets.json  markets.schema.json
      composition.ts  settings.ts  system.ts
      api.ts  worker.ts  migrate.ts
  test/
    unit/  integration/             espelham src/
    fakes/  support/
```

O `order` não tem gRPC: não expõe nem chama nenhum método síncrono.

### `.env.example`

```bash
API_PORT=3000
HEALTH_PORT=3001
DATABASE_HOST=order-db
DATABASE_PORT=5432
DATABASE_NAME=order
DATABASE_USER=order
DATABASE_PASSWORD=order-db-dev
RABBITMQ_HOST=rabbitmq
RABBITMQ_USER=order
RABBITMQ_PASSWORD=order-rabbitmq-dev
REDIS_HOST=redis
REDIS_USER=order
REDIS_PASSWORD=order-redis-dev
ORDER_PENDING_TIMEOUT=2m
EXPIRE_PENDING_ORDERS_INTERVAL=10s
RATE_LIMITS_ORDERS_PER_IP=100/10s
RATE_LIMITS_ORDERS_PER_ACCOUNT=50/10s
RATE_LIMITS_ORDERS_PER_ACCOUNT_DAILY=100000/24h
RATE_LIMITS_PRIVATE_READ_PER_IP=600/1m
RATE_LIMITS_PRIVATE_READ_PER_ACCOUNT=300/1m
LOG_LEVEL=debug
```

## 9. Testes principais

| Nível | Casos |
|---|---|
| Unidade | Cada linha da tabela de status · preço médio com vários fills · fill acima da quantidade é recusado · `requestCancel` em `filled`/`rejected` é recusado · **cancelamento com fill atrasado**: `removed` antes do último `trade` termina em `cancelled` com os números certos · `cancelRejected` volta a `filled` · `void(EXPIRED)` só em `pending` e depois do timeout · cancelar em `pending` termina `cancelled` e publica `order.voided` · `fundsReserved` depois de `voided` é ignorado · preço fora do tick, quantidade fora do step e valor abaixo do mínimo são rejeitados · remoção por STP termina `cancelled` com motivo · `PlaceOrder` despacha `OrderPlaced` · `AcceptOrder` despacha `OrderAccepted`, e o `IntegrationEventMapper` grava `order.accepted.<m>` no outbox · `PlaceOrder` não conhece nenhum outro caso de uso (teste de arquitetura) |
| Integração | `order` e `order_view` gravadas na mesma transação (falha no meio não deixa nenhuma) · `OrderDao` filtra por status e ordena por data · inbox `eventId:orderId` impede fill duplicado · outbox publica `accepted` antes de `cancelRequested` · HTTP: `202`, `403` de quem não é dono, `409` de status que não permite cancelar · job de expiração publica `order.voided` · migrações sobem e descem |
| Contrato | Eventos publicados e consumidos validam nos schemas · `order.placed` e `order.voided` publicados são idênticos às cópias do `wallet` (`make check`) |
