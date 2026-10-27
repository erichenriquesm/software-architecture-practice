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
| `MarketId` | Formato `BASE-QUOTE` e presente no catálogo `contracts/markets.json` ([Q5](../99-decisoes.md#q5)) |
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

Os casos de uso têm nome de **intenção**, não de evento: nenhum sabe se foi chamado por HTTP, por fila ou por job. Quem liga o gatilho ao caso de uso é o adapter de entrada.

| Caso de uso | Input → Output | Adapter de entrada (gatilho) | Passos |
|---|---|---|---|
| `PlaceOrder` | `PlaceOrderInput` → `PlaceOrderOutput { orderId, status }` | REST `POST /place_order` | Valida VOs e `MarketFilters` → `Order.place` → salva → despacha `OrderPlaced`. |
| `CancelOrder` | `CancelOrderInput` → `CancelOrderOutput { orderId, status }` | REST `POST /cancel_order` | Carrega → confere `accountId` dono → `requestCancel` → salva → despacha `OrderVoided` (estava `pending`) ou `OrderCancelRequested` (estava no livro). |
| `AcceptOrder` | `AcceptOrderInput { orderId }` → `void` | consumer `order.fundsReservation` (`wallet.fundsReserved`) | `markReserved` → despacha `OrderAccepted`. |
| `RejectOrder` | `RejectOrderInput { orderId, reason }` → `void` | consumer `order.fundsReservation` (`wallet.fundsReservationRejected`) | `markRejected`. |
| `ExpireOrder` | `ExpireOrderInput { orderId }` → `void` | job `expirePendingOrdersJob` (a cada 10 s) | O job lista as ordens `pending` vencidas (`OrderDao`) e chama `ExpireOrder` **uma vez por ordem**. O caso de uso faz `void(EXPIRED)` → despacha `OrderVoided`. |
| `ApplyFill` | `ApplyFillInput { orderId, tradeId, quantity, price }` → `void` | consumer `order.matchingResults` (`matching.tradeExecuted`) | O consumer chama `ApplyFill` **duas vezes** (ordem de compra e de venda), cada uma na sua transação, inbox `eventId:orderId`. |
| `RegisterRemoval` | `RegisterRemovalInput { orderId, remainingQuantity, reason }` → `void` | consumer `order.matchingResults` (`matching.orderRemoved`) | `markRemoved`. |
| `RevertCancelRequest` | `RevertCancelRequestInput { orderId }` → `void` | consumer `order.matchingResults` (`matching.orderCancelRejected`) | `cancelRejected`. |
| `GetOrders` | `GetOrdersInput { accountId, status? }` → `GetOrdersOutput` | REST `GET /accounts/:id/orders` | `OrderDao.listByAccount` → `OrderView[]` → Output. |
| `GetOrder` | `GetOrderInput { orderId }` → `GetOrderOutput` | REST `GET /orders/:id` | `OrderDao.findById`. |

Reações aos eventos de domínio (registradas no composition root, [princípios §2.1](../01-principios.md#21-eventos-entre-casos-de-uso-event-driven-interno)):

| Evento de domínio | Handler transacional (mesma transação) |
|---|---|
| Todos os eventos de `Order` | `OrderViewProjector` atualiza a `order_view` (projeção síncrona) |
| `OrderPlaced`, `OrderAccepted`, `OrderCancelRequested`, `OrderVoided` | `IntegrationEventMapper` grava `order.placed`, `order.accepted.<m>`, `order.cancelRequested.<m>`, `order.voided` no outbox |

As regras "conta existe" e "saldo suficiente considerando ordens em aberto" do objetivo são garantidas pelo `wallet` na reserva (§5.2 do [design estratégico](../02-design-estrategico.md#52-placeorder-saga-coreografada)). Por isso o `PlaceOrder` responde `pending`, e não `open`.

Portas: `OrderRepository`, `OrderDao`, `MarketCatalog`, `TransactionRunner`, `DomainEventDispatcher`, `IdGenerator`, `Clock`.

Sagas em que este serviço participa: **S2** (dono), **S3** (fills), **S4** (dono). Ver [06-sagas.md](../06-sagas.md).

## 5. API pública (REST)

| Método | Rota | Entrada | Saída | Erros |
|---|---|---|---|---|
| POST | `/place_order` | `marketId, accountId, side, quantity, price` | `202 { orderId, status }` | `422` |
| POST | `/cancel_order` | `orderId, accountId` | `202 { orderId, status }` (`cancelled` se estava `pending`; `cancelling` se estava no livro) | `404` · `403` não é dono · `409` status não permite |
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

## 7. Dados (`order-db`, schema `orders`)

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
backend/order/src/
  domain/        order.ts, orderStatus.ts, valueObjects/{marketId, side, quantity, price}.ts, events.ts, errors.ts
  application/   usecases/{placeOrder, cancelOrder, acceptOrder, rejectOrder, expireOrder, applyFill, registerRemoval, revertCancelRequest, getOrders, getOrder}/
                   (cada pasta: <useCase>.ts, <useCase>Input.ts, <useCase>Output.ts)
                 repositories/orderRepository.ts · daos/orderDao.ts · ports/{marketCatalog, transactionRunner, domainEventDispatcher, idGenerator, clock}.ts
  infra/         adapters/inbound/{http, messaging/{fundsReservation, matchingResults}Consumer, scheduler/expirePendingOrdersJob}
                 adapters/outbound/{persistence/{repositories, daos, projections/orderViewWriter}, messaging/outboxEventPublisher,
                                    catalog/jsonMarketCatalog}
                 main/{api, worker, migrate}.ts
```

## 9. Testes principais

| Nível | Casos |
|---|---|
| Unidade | Cada linha da tabela de status · preço médio com vários fills · fill acima da quantidade é recusado · `requestCancel` em `filled`/`rejected` é recusado · **cancelamento com fill atrasado**: `removed` antes do último `trade` termina em `cancelled` com os números certos · `cancelRejected` volta a `filled` · `void(EXPIRED)` só em `pending` e depois do timeout · cancelar em `pending` termina `cancelled` e publica `order.voided` · `fundsReserved` depois de `voided` é ignorado · preço fora do tick, quantidade fora do step e valor abaixo do mínimo são rejeitados · remoção por STP termina `cancelled` com motivo · `PlaceOrder` despacha `OrderPlaced` · `AcceptOrder` despacha `OrderAccepted`, e o `IntegrationEventMapper` grava `order.accepted.<m>` no outbox · `PlaceOrder` não conhece nenhum outro caso de uso (teste de arquitetura) |
| Integração | `order` e `order_view` gravadas na mesma transação (falha no meio não deixa nenhuma) · `OrderDao` filtra por status e ordena por data · inbox `eventId:orderId` impede fill duplicado · outbox publica `accepted` antes de `cancelRequested` |
| Contrato | Eventos publicados e consumidos validam nos schemas |
