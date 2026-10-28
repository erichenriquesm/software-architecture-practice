# Serviço `matching` — Motor de Matching

> Status: **spec** · Subdomínio: **Core** · Modelagem: **a mais rica da plataforma**

## 1. Responsabilidade

- Manter o **livro de ofertas** de cada mercado.
- Ao receber uma ordem aceita, tentar casar com o lado oposto e gerar as **negociações (trades)**.
- Remover ordens do livro quando totalmente executadas ou canceladas.
- Ser a **fonte da verdade das negociações** e publicar o estado do livro.

**Fora do escopo:** saldo, status da ordem para o usuário, consultas públicas (é o `market-data`). Não tem API REST pública nem gRPC.

## 2. Workload

CPU e latência. **Escritor único e sequencial por mercado**: as ordens de um mercado são processadas uma por vez, na ordem em que foram aceitas, porque a prioridade preço-tempo depende disso. Escala **por mercado** (uma fila e um consumidor ativo por mercado), não por réplica dentro do mercado.

## 3. Modelo de domínio

**Agregado `OrderBook`** (raiz), um por mercado: `marketId`, `sequence` (incrementa a cada mudança), `bids`, `asks`.

**Entidade `BookEntry`**: `orderId`, `accountId`, `side`, `price`, `remaining`, `priority` (número de chegada; quanto menor, mais antiga).

| Lado | Ordenação |
|---|---|
| `bids` (compra) | preço **decrescente**, depois `priority` crescente |
| `asks` (venda) | preço **crescente**, depois `priority` crescente |

**`place(entry) → Trade[]`** — regra central, pura:

```
enquanto entry.remaining > 0 e existe melhor oferta do lado oposto (maker):
    se não cruza (compra: entry.price < maker.price · venda: entry.price > maker.price): pare
    se maker.accountId = entry.accountId:                       ← prevenção de self-trade (STP)
        remove o maker do livro → OrderRemoved(maker, remaining, SELF_TRADE_PREVENTION)
        continue                                                   (o taker segue para o próximo maker)
    qty   = min(entry.remaining, maker.remaining)
    trade = Trade(qty, price = maker.price, side = entry.side, buy/sell conforme os lados)
    reduz entry e maker em qty; maker zerado sai do livro
se entry.remaining > 0: entra no livro com a próxima priority
```

Isso implementa as regras do objetivo:
- compara a **maior compra** com a **menor venda**; executa se `compra ≥ venda`;
- quantidade = a **menor** entre as duas;
- preço = o da **ordem mais antiga** (o maker, que já estava no livro);
- `side` do trade = o lado da ordem **que acabou de entrar** (o taker);
- execução parcial e em cascata contra vários makers;
- ordem totalmente executada sai do livro; sem correspondência, fica esperando.

**Prevenção de self-trade (STP), modo "cancelar o maker"** ([Q9](../99-decisoes.md#q9)): uma conta nunca negocia com ela mesma. Quando o melhor maker é da mesma conta do taker, o maker sai do livro e o taker continua. É o comportamento do `EXPIRE_MAKER` da Binance e do *cancel oldest* da Coinbase. O `place` devolve, além dos trades, as remoções por STP.

**`place(entry) → { trades: Trade[], removed: OrderRemoved[] }`** · **`cancel(orderId) → OrderRemoved(CANCELLED) | NotInBook`**

**Exemplo do objetivo (vira teste):** livro com compra 10 BTC @ 83.000. Chega venda 5 BTC @ 82.400 → `Trade(5, 83.000, side=sell)`. A venda não entra no livro; a compra fica com 5.

**Invariantes:** `remaining > 0` para toda entrada do livro · nenhum `orderId` repetido · depois de cada `place`, o livro **não fica cruzado** (`melhor bid < melhor ask`) · nenhum trade tem `buyAccountId = sellAccountId`.

`Trade` (VO): `tradeId`, `marketId`, `buyOrderId`, `sellOrderId`, `buyAccountId`, `sellAccountId`, `side`, `quantity`, `price`, `executedAt`.

## 4. Casos de uso

| Caso de uso | Gatilho | Passos |
|---|---|---|
| `ExecuteOrder` | `order.accepted.<marketId>` | Se o `orderId` já está no livro → ignora (idempotência). `book.place(entry)` → numa transação: grava entradas alteradas, trades, `sequence`, outbox (`tradeExecuted` × N + `orderRemoved` por STP + `bookSnapshot`). |
| `RemoveOrder` | `order.cancelRequested.<marketId>` | `book.cancel` → `matching.orderRemoved` + `bookSnapshot`, ou `matching.orderCancelRejected(NOT_IN_BOOK)`. |

Contratos (interfaces em `application/contracts/`): `OrderBookRepository` (carregar/salvar o livro do mercado), `TransactionRunner`, `DomainEventDispatcher`, `IdGenerator`, `Clock`. Não há DAO: este serviço não atende consultas.

Sagas em que este serviço participa: **S2** (passo repetível, depois do pivot), **S3** (dono: o trade é o pivot) e **S4** (pivot: remover do livro). Ver [06-sagas.md](../06-sagas.md).

### Livro em memória + banco como verdade
- Ao iniciar o consumo de um mercado, o worker carrega o livro do banco.
- Cada mensagem é aplicada no livro em memória e persistida **na mesma transação** com o outbox. Só depois do `commit` vem o `ack`.
- Se a transação falhar, o livro em memória é **descartado e recarregado** do banco antes da próxima tentativa, para não divergir.
- Como só existe um consumidor ativo por mercado (`single-active-consumer`), não há outro processo escrevendo no mesmo livro.

## 5. Mensageria

| Direção | Evento | Fila / Exchange |
|---|---|---|
| Consome | `order.accepted.<m>`, `order.cancelRequested.<m>` | `matching.orders.<m>` (**uma fila por mercado**, ordenada, sem fila de retry — ver [mensageria §6](../03-mensageria.md#6-ordem-garantida-a-fila-do-matching)) |
| Publica | `matching.tradeExecuted.<m>`, `matching.orderRemoved.<m>`, `matching.orderCancelRejected.<m>`, `matching.bookSnapshot.<m>` | `matching.events` |

O `bookSnapshot` sai **uma vez por mensagem processada** que mudou o livro (não uma vez por trade), com os níveis agregados por preço exato.

## 6. Dados (`matching-db`)

```sql
create table book (
  market_id  text primary key,
  sequence   bigint not null default 0,
  next_priority bigint not null default 1
);

create table book_entry (
  order_id    uuid primary key,
  market_id   text not null references book,
  account_id  uuid not null,
  side        text not null,
  price       numeric(36,8) not null,
  remaining   numeric(36,8) not null check (remaining > 0),
  priority    bigint not null,
  accepted_at timestamptz not null
);
create index book_entry_load on book_entry (market_id, side, price, priority);

-- source of truth for trades
create table trade (
  trade_id         uuid primary key,
  market_id        text not null,
  buy_order_id     uuid not null,
  sell_order_id    uuid not null,
  buy_account_id   uuid not null,
  sell_account_id  uuid not null,
  side             text not null,
  quantity         numeric(36,8) not null,
  price            numeric(36,8) not null,
  executed_at      timestamptz not null,
  book_sequence    bigint not null
);

-- outbox, inbox: see 03-mensageria.md §5
```

Entrada totalmente executada é **apagada** de `book_entry`: o livro guarda só o que está aberto. O histórico fica em `trade` (aqui) e nas projeções do `order` e do `market-data`.

## 7. Configuração

`MARKETS=BTC-USD` (lista). O worker abre um consumidor por mercado configurado. Mercado novo = nova entrada na lista + fila nova.

## 8. Estrutura

```
backend/matching/
  .env.example  .env.test.example
  docker-compose.yml  docker-compose.platform.yml  docker-compose.runtime.yml  docker-compose.test.yml
  Dockerfile  package.json  package-lock.json  tsconfig.json  eslint.config.mjs  .dependency-cruiser.cjs  vitest.config.ts
  migrations/
  src/
    domain/
      entities/                     orderBook.ts  bookEntry.ts  bids.ts  asks.ts
      valueObjects/                 trade.ts  marketId.ts  side.ts  quantity.ts  price.ts
      domainEvents/                 tradeExecuted.ts  orderRemoved.ts  orderCancelRejected.ts  bookChanged.ts
      domainServices/               (vazio por enquanto: toda regra cabe no agregado OrderBook)
      errors.ts
    application/
      usecases/                     executeOrder.ts  removeOrder.ts
      dtos/                         executeOrderDto.ts  removeOrderDto.ts
      contracts/                    orderBookRepository.ts  transactionRunner.ts  domainEventDispatcher.ts
                                    idGenerator.ts  clock.ts
    infra/
      http/health.ts                só /health (não há API pública)
      messaging/
        consumers/marketConsumer.ts um por mercado, com retry em processo
        integrationEventMapper.ts  outboxEventPublisher.ts
      database/                     kyselyOrderBookRepository.ts  kyselyTransactionRunner.ts  database.ts
      platform/                     resilience/  messaging/   (copiados e adaptados; sem gRPC, sem rate limit)
      contracts/
        published/events/           matching.tradeExecuted.v1  matching.orderRemoved.v1
                                    matching.orderCancelRejected.v1  matching.bookSnapshot.v1
        consumed/events/            order.accepted.v1  order.cancelRequested.v1
        envelope.schema.json  markets.json   (lista de mercados: uma fila e um consumer por mercado)
      worker.ts  migrate.ts
  test/
    fakes/  support/
```

O evento de domínio `BookChanged` vira o evento de integração `matching.bookSnapshot` no `IntegrationEventMapper`. O `matching` não tem `api.ts`: o `/health` sobe junto com o `worker`.

### `.env.example`

```bash
HEALTH_PORT=3000
DATABASE_HOST=matching-db
DATABASE_PORT=5432
DATABASE_NAME=matching
DATABASE_USER=matching
DATABASE_PASSWORD=matching-db-dev
RABBITMQ_HOST=rabbitmq
RABBITMQ_USER=matching
RABBITMQ_PASSWORD=matching-rabbitmq-dev
LOG_LEVEL=debug
```

O `matching` não usa Redis (não tem API pública, então não tem rate limit) nem gRPC.

## 9. Testes principais

O `OrderBook` concentra os testes da plataforma. Todo cenário do objetivo vira teste de unidade.

| Nível | Casos |
|---|---|
| Unidade | Exemplo do objetivo (10 @ 83.000 × 5 @ 82.400) · STP: taker encontra maker da mesma conta → maker removido com motivo, taker segue casando com o próximo · STP com o taker parando no livro depois de remover o maker · sem match quando `bid < ask` · preço do maker quando o taker é compra e quando é venda · `side` = lado do taker · prioridade por tempo no mesmo preço · taker grande consome vários makers em cascata e o resto fica no livro · execução total remove o maker · livro nunca fica cruzado (teste por propriedade com ordens aleatórias) · `cancel` de ordem inexistente → `NotInBook` · `order.accepted` repetido não duplica a entrada |
| Integração | Livro recarregado do banco é igual ao que estava em memória · falha no meio da transação não deixa trade sem entrada atualizada · retry em processo bloqueia o mercado e retoma na ordem certa · `single-active-consumer`: segunda réplica só consome quando a primeira cai |
| Contrato | `tradeExecuted`, `orderRemoved`, `orderCancelRejected`, `bookSnapshot` validam nos schemas |
