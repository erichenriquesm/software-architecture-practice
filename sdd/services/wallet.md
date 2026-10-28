# Serviço `wallet` — Carteira

> Status: **spec** · Subdomínio: **Supporting (crítico: dinheiro)** · Modelagem: **rica**

## 1. Responsabilidade

- Guardar o saldo de cada conta por ativo, separado em **disponível** e **reservado**.
- Depósito e saque.
- **Reservar** saldo quando uma ordem é criada (é isso que impede vender ou comprar duas vezes o mesmo saldo).
- **Liquidar** cada negociação nas carteiras do comprador e do vendedor.
- **Liberar** a reserva restante quando uma ordem sai do livro por cancelamento.
- Publicar o estado do saldo para projeções de outros contextos.

**Fora do escopo:** integração com banco/blockchain real para depósito e saque ([Q14](../99-decisoes.md#q14)), taxas ([Q10](../99-decisoes.md#q10)).

## 2. Workload

Escrita concorrente **na mesma conta** (depósito + reserva + liquidação podem chegar juntos). Precisa de **consistência forte por conta** e trilha de auditoria. Leitura pública não há: os saldos chegam ao `account` por `wallet.balanceChanged`.

## 3. Modelo de domínio

**Agregado `Wallet`** (raiz), um por conta: `accountId`, `version`, `balances: Map<AssetId, Balance>`, `reservations: Map<OrderId, Reservation>` (só as abertas).

| Elemento | Conteúdo |
|---|---|
| `Balance` (VO) | `available`, `reserved` (`Quantity`) |
| `Reservation` (entidade interna) | `orderId`, `assetId`, `side`, `limitPrice`, `remaining` (no ativo reservado) |
| `AssetId` (VO) | `BTC` \| `USD` |
| `Quantity`, `Price` (VO) | Decimais não negativos, escala interna 8. Os filtros do mercado garantem que `qty × price` cabe em 8 casas: **não há arredondamento** em reserva nem liquidação ([Q11](../99-decisoes.md#q11)). |
| `AssetPrecision` | Do catálogo: `BTC` 8 casas, `USD` 2. Vale para depósito e saque. |
| `MarketId` (VO) | `BASE-QUOTE`, ex.: `BTC-USD` |

**Invariantes**
1. `available ≥ 0` e `reserved ≥ 0` para todo ativo.
2. `reserved(ativo) = Σ reservation.remaining` das reservas abertas daquele ativo.
3. Uma reserva por `orderId` (reserva repetida é ignorada: idempotência de domínio).
4. Ordem anulada (lápide) **nunca** ganha reserva, mesmo que o `order.placed` chegue depois.

**Comportamentos**

| Método | Regra |
|---|---|
| `deposit(asset, qty)` | `qty > 0`; `asset ∈ {BTC, USD}`; `qty` respeita a precisão do ativo → `available += qty` |
| `withdraw(asset, qty)` | `qty > 0`; precisão do ativo; `qty ≤ available` — o reservado não é sacável ([Q1](../99-decisoes.md#q1)) → `available -= qty` |
| `reserve(orderId, market, side, qty, price)` | Compra: reserva `qty × price` do **quote** (`USD`). Venda: reserva `qty` do **base** (`BTC`). Se `available < valor` → `InsufficientFundsError`. Move `available → reserved`. |
| `settleAsBuyer(trade)` | Consome da reserva `qty × limitPrice`; debita `qty × trade.price` do reservado; **devolve a diferença** `qty × (limitPrice − trade.price)` ao disponível; credita `qty` de `BTC` no disponível. |
| `settleAsSeller(trade)` | Consome `qty` de `BTC` da reserva e do reservado; credita `qty × trade.price` de `USD` no disponível. |
| `releaseRemaining(orderId, remainingQty)` | Compra: libera `remainingQty × limitPrice`. Venda: libera `remainingQty`. Fecha a reserva se `remaining = 0`. |
| `voidReservation(orderId)` | **Compensação da saga S2.** Reserva aberta → libera tudo o que resta e marca `void`. Reserva inexistente → nada a liberar; o caso de uso grava a lápide. |

Por que a diferença é devolvida: quem compra reserva pelo **seu** limite, mas a negociação sai pelo preço do **maker** (a ordem mais antiga), que pode ser menor.

`settle*` e `releaseRemaining` consomem **exatamente** a parte que lhes cabe, então o resultado é o mesmo em qualquer ordem de chegada ([mensageria §5](../03-mensageria.md#handlers-comutativos)).

Cada mudança de saldo emite `BalanceChanged(accountId, assetId, available, reserved, version)` e um lançamento no ledger.

## 4. Casos de uso

Nomes de intenção; o gatilho é do adapter de entrada. Regra de Input/Output ([princípios §3.2](../01-principios.md#32-conven%C3%A7%C3%B5es-de-nomes)): até 2 valores entram e saem direto; 3 ou mais viram objeto, no arquivo do caso de uso; nada de alias.

| Caso de uso | Assinatura | Adapter de entrada (gatilho) | Passos |
|---|---|---|---|
| `OpenWallet` | `execute(accountId): void` | consumer `wallet.accountCreated` | Cria carteira vazia se não existir (`Wallet.open`). |
| `Deposit` | `execute(input: DepositInput): void` | REST `POST /deposit` | Garante a carteira (§7) → `deposit` → salva → publica `BalanceChanged`. |
| `Withdraw` | `execute(input: WithdrawInput): void` | REST `POST /withdraw` | Garante a carteira → `withdraw` → salva → publica `BalanceChanged`. |
| `ReserveFunds` | `execute(input: ReserveFundsInput): void` | consumer `wallet.orderPlaced` | Ordem com lápide → nada. Garante a carteira; sem conta → publica `FundsReservationRejected(WALLET_NOT_FOUND)`. `reserve` → publica `FundsReserved` + `BalanceChanged`. `InsufficientFundsError` → publica `FundsReservationRejected(INSUFFICIENT_FUNDS)` (é evento, não retry). |
| `SettleTradeSide` | `execute(input: SettleTradeSideInput): void` | consumer `wallet.tradeExecuted` | O consumer chama **duas vezes** (lado comprador e lado vendedor), cada uma na sua transação, inbox `eventId:accountId:role`. Comprador e vendedor são sempre contas diferentes: o `matching` aplica prevenção de self-trade ([Q9](../99-decisoes.md#q9)). |
| `ReleaseReservation` | `execute(input: ReleaseReservationInput): void` | consumer `wallet.orderRemoved` | `releaseRemaining` → publica `BalanceChanged`. |
| `CompensateReservation` | `execute(orderId, accountId): void` | consumer `wallet.orderVoided` | Grava a lápide (`VoidedOrders`) → se houver reserva aberta, `voidReservation` → publica `BalanceChanged`. |

Inputs (cada um no arquivo do seu caso de uso):

| Input | Campos | Usado por |
|---|---|---|
| `DepositInput`, `WithdrawInput` | `accountId, assetId, quantity` | `Deposit`, `Withdraw` |
| `ReserveFundsInput` | `orderId, accountId, marketId, side, quantity, price` | `ReserveFunds` |
| `SettleTradeSideInput` | `tradeId, orderId, accountId, role (buyer \| seller), marketId, quantity, price` | `SettleTradeSide` |
| `ReleaseReservationInput` | `orderId, accountId, remainingQuantity` | `ReleaseReservation` |

**"Garante a carteira"** não é chamar o `OpenWallet`: um caso de uso nunca chama outro. É o mesmo passo de domínio (`Wallet.open`) usado dentro da transação do caso de uso atual, depois que a porta `AccountGateway` confirma que a conta existe (§7).

Eventos de domínio: o caso de uso os entrega ao `EventPublisher` dentro da transação; o `OutboxEventPublisher` grava `wallet.fundsReserved`, `wallet.fundsReservationRejected` e `wallet.balanceChanged` no outbox.

**Concorrência:** controle otimista em `wallet.version`. Conflito → o caso de uso recarrega e tenta de novo (até 3×, em processo). Persistindo, no HTTP vira `409`; no consumidor, é erro transitório → fila de retry.

**Conflito persistente** é o erro `ConcurrentWalletUpdateError`. O retry fica num helper da aplicação (`retryOnConflict`), usado pelos casos de uso de comando.

Contratos (interfaces em `application/contracts/`):

| Contrato | Para quê |
|---|---|
| `WalletRepository` | `findByAccount`, `save` (com `version` otimista; grava saldos, reservas e ledger) |
| `VoidedOrders` | Lápide da saga S2: `isVoided(orderId)`, `markVoided(orderId)` |
| `AccountGateway` | `exists(accountId)`, via gRPC (§7) |
| `MarketCatalog` | Precisão de cada ativo e os ativos base/quote de cada mercado, lidos do `markets.json` |
| `TransactionRunner`, `EventPublisher`, `Clock` | Como no `account` |

O health check (`/health`) não é caso de uso: fica em `infra/http/health.ts`.

Sagas em que este serviço participa: **S1**, **S2** (passo compensável e compensação), **S3** (liquidação), **S4** (liberação). Ver [06-sagas.md](../06-sagas.md).

## 5. API pública (REST)

| Método | Rota | Entrada | Saída | Erros |
|---|---|---|---|---|
| POST | `/deposit` | `accountId, assetId, quantity` | `204` | `404` conta · `422` ativo/quantidade · `409` conflito de concorrência persistente · `503` `account` fora do ar |
| POST | `/withdraw` | `accountId, assetId, quantity` | `204` | `404` · `422` (inclui saldo disponível insuficiente) · `409` · `503` |

`quantity` trafega como **string decimal** (`"0.5"`), como nos eventos: nunca `number`.

Ambos aceitam `Idempotency-Key`, com o comportamento da Stripe: a mesma chave devolve a mesma resposta ([Q13](../99-decisoes.md#q13)). Quantidade fora da precisão do ativo → `422`.

## 6. gRPC interno

O `wallet` não expõe gRPC. Ele só **chama** o `account` (`AccountService.Exists`, §7), mandando o token compartilhado no metadata `x-service-token` ([autenticação §2](../08-autenticacao-entre-servicos.md#2-grpc-interno-token-compartilhado)).

## 7. Integração síncrona e resiliência

"A conta existe?", usado por `Deposit`, `Withdraw` e `ReserveFunds`:

1. A carteira existe localmente (`WalletRepository`)? Pronto.
2. Senão, `GrpcAccountGateway` + `accountAcl` — `AccountService.Exists`, deadline 500 ms, retry 3× com backoff + jitter. Se existir, o caso de uso abre a carteira na hora com `Wallet.open` (cobre a janela antes de `account.created` chegar). O adapter só responde se a conta existe; quem abre é o domínio.
3. Conta inexistente → `WalletNotFoundError` (`404` no HTTP; evento `WALLET_NOT_FOUND` no `ReserveFunds`).

Os passos 1 e 3 ficam no `WalletStore.loadOrOpen` (aplicação); o passo 2 é o adapter. Se o gRPC estiver fora depois das tentativas, o adapter lança `AccountServiceUnavailableError`: no HTTP, `503`; no consumidor, erro transitório → fila de retry (a ordem fica em `pending` até resolver).

## 8. Mensageria

| Direção | Evento | Fila / Exchange |
|---|---|---|
| Consome | `account.created` | `wallet.accountCreated` |
| Consome | `order.placed` | `wallet.orderPlaced` |
| Consome | `matching.tradeExecuted` | `wallet.tradeExecuted` |
| Consome | `matching.orderRemoved` | `wallet.orderRemoved` |
| Consome | `order.voided` | `wallet.orderVoided` |
| Publica | `wallet.fundsReserved`, `wallet.fundsReservationRejected`, `wallet.balanceChanged` | `wallet.events` |

## 9. Dados (`wallet-db`)

```sql
create table wallet (
  account_id  uuid primary key,
  version     bigint not null default 0,   -- optimistic lock + balanceChanged version
  created_at  timestamptz not null default now()
);

create table balance (
  account_id  uuid not null references wallet,
  asset_id    text not null,
  available   numeric(36,8) not null check (available >= 0),
  reserved    numeric(36,8) not null check (reserved >= 0),
  primary key (account_id, asset_id)
);

create table reservation (
  order_id     uuid primary key,
  account_id   uuid not null references wallet,
  asset_id     text not null,
  side         text not null,
  limit_price  numeric(36,8) not null,
  remaining    numeric(36,8) not null check (remaining >= 0),
  status       text not null,             -- open | closed | void
  created_at   timestamptz not null
);
create index reservation_open on reservation (account_id) where status = 'open';

-- S2 compensation tombstone: a voided order never gets a reservation
create table voided_order (
  order_id   uuid primary key,
  voided_at  timestamptz not null default now()
);

-- append-only audit trail
create table ledger_entry (
  id               bigserial primary key,
  account_id       uuid not null,
  asset_id         text not null,
  available_delta  numeric(36,8) not null,
  reserved_delta   numeric(36,8) not null,
  reason           text not null,         -- DEPOSIT | WITHDRAW | RESERVE | SETTLE | RELEASE | VOID
  reference_id     text,                  -- orderId / tradeId / idempotency key
  created_at       timestamptz not null default now()
);

-- outbox, inbox: see 03-mensageria.md §5
```

Não há `balance_view` nem DAO: o `wallet` não tem leitura pública, e os saldos chegam ao `account` por `wallet.balanceChanged`. Se surgir relatório de carteira (extrato, por exemplo), ele lê `ledger_entry` ou ganha uma `*_view` própria.

O `check` no banco é a última defesa da invariante 1. A regra de verdade está no agregado.

## 10. Estrutura

```
backend/wallet/
  .env.example  .env.test.example  Makefile (migrações e testes, como no account)
  docker/                           Dockerfile  Dockerfile.dockerignore  docker-compose.yml  docker-compose.platform.yml  docker-compose.test.yml
  package.json  package-lock.json  tsconfig.json  eslint.config.mjs  .dependency-cruiser.cjs  vitest.config.ts
  src/
    domain/
      entities/                     wallet.ts  reservation.ts  ledgerEntry.ts  aggregateRoot.ts
      valueObjects/                 accountId.ts  orderId.ts  assetId.ts  quantity.ts  price.ts  side.ts  marketId.ts  balance.ts
      events/                       domainEvent.ts  fundsReserved.ts  fundsReservationRejected.ts  balanceChanged.ts
      errors.ts
    application/
      usecases/                     openWallet.ts  deposit.ts  withdraw.ts  reserveFunds.ts  settleTradeSide.ts
                                    releaseReservation.ts  compensateReservation.ts
                                    retryOnConflict.ts  walletStore.ts (carregar/abrir e salvar+publicar, comum aos comandos)
      contracts/                    walletRepository.ts  voidedOrders.ts  accountGateway.ts  marketCatalog.ts
                                    transactionRunner.ts  eventPublisher.ts  clock.ts
    infra/
      http/                         walletRoutes.ts (deposit, withdraw, rate limit)  health.ts
      grpc/account/                 grpcAccountGateway.ts (manda o token)  accountAcl.ts
      messaging/
        consumers/                  accountCreatedConsumer.ts  orderPlacedConsumer.ts  tradeExecutedConsumer.ts
                                    orderRemovedConsumer.ts  orderVoidedConsumer.ts
                                    consumedEvent.ts (ACL de entrada: tipo, versão e schema; classificação de erro)
        outboxEventPublisher.ts     domain event → outbox
      database/                     kyselyWalletRepository.ts  kyselyVoidedOrders.ts
                                    kyselyTransactionRunner.ts  postgres.ts  database.ts  migrator.ts  migrationFiles.ts
        migrations/                 <timestamp>_create_<tabela>_table.ts, uma por tabela de §9 + outbox, inbox, idempotency_key
      catalog/jsonMarketCatalog.ts  lê e valida o markets.json na subida
      platform/                     config/  http/  messaging/  observability/  resilience/   (copiados do account)
      schemas/
        published/events/           wallet.fundsReserved.v1  wallet.fundsReservationRejected.v1  wallet.balanceChanged.v1
        consumed/events/            account.created.v1  order.placed.v1  order.voided.v1
                                    matching.tradeExecuted.v1  matching.orderRemoved.v1
        consumed/proto/account.proto
        envelope.schema.json  markets.json  markets.schema.json
      generated/                    código do .proto (não versionado)
      composition.ts  settings.ts  system.ts
      api.ts  worker.ts  migrate.ts
  test/
    unit/  integration/             espelham src/
    fakes/  support/
```

Os schemas de `order.*` e `matching.*` são escritos agora pelo `wallet` a partir do catálogo da [mensageria §3](../03-mensageria.md#3-cat%C3%A1logo-de-eventos-v1). Até `order` e `matching` existirem, o `make check` os lista como pendentes; quando os donos forem construídos, publicam os originais e as cópias têm de bater.

**Um evento, várias transações.** O `Consumer` da plataforma aceita uma função `units(envelope)` que divide a mensagem em partes, cada uma com sua chave de inbox. O `tradeExecuted` vira duas partes (`eventId:buyAccountId:buyer` e `eventId:sellAccountId:seller`), cada uma numa transação. Se a segunda falhar e a mensagem voltar, a primeira não é aplicada de novo ([mensageria §5](../03-mensageria.md#inbox-consumidor)).

### `.env.example`

```bash
API_PORT=3000
HEALTH_PORT=3001
DATABASE_HOST=wallet-db
DATABASE_PORT=5432
DATABASE_NAME=wallet
DATABASE_USER=wallet
DATABASE_PASSWORD=wallet-db-dev
RABBITMQ_HOST=rabbitmq
RABBITMQ_USER=wallet
RABBITMQ_PASSWORD=wallet-rabbitmq-dev
REDIS_HOST=redis
REDIS_USER=wallet
REDIS_PASSWORD=wallet-redis-dev
ACCOUNT_GRPC_ADDR=account-api:50051
ACCOUNT_GRPC_TOKEN=internal-grpc-dev
RATE_LIMITS_MOVEMENT_PER_IP=30/1m
RATE_LIMITS_MOVEMENT_PER_ACCOUNT=10/1m
LOG_LEVEL=debug
```

## 11. Testes principais

| Nível | Casos |
|---|---|
| Unidade | Depósito e saque (limites, ativo inválido) · reserva de compra (`qty × price` em USD) e de venda (`qty` em BTC) · reserva repetida é ignorada · saldo insuficiente considerando reservas abertas · liquidação do comprador devolve a diferença de preço · liquidação do vendedor · **`settle` e `release` em qualquer ordem dão o mesmo saldo final** · liberação por remoção STP (`orderRemoved` com motivo `SELF_TRADE_PREVENTION`) · `ReserveFunds` publica rejeição em vez de lançar erro · fallback "conta existe?" · compensação: `order.voided` antes e depois de `order.placed` termina com saldo intacto · depósito com mais casas que a precisão do ativo é rejeitado |
| Integração | Conflito de `version` com duas transações simultâneas · `check` do banco barra saldo negativo · inbox ignora `tradeExecuted` duplicado e não reaplica o lado já liquidado quando o outro falha · ledger registra cada mudança · fallback "conta existe?" contra o fake gRPC do `account` (`Exists` com retry só em `UNAVAILABLE`, token em toda chamada) · migrações sobem e descem |
| Contrato | Eventos publicados validam nos schemas · o cliente gRPC usa a cópia de `account.proto` |
