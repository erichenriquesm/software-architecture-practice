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

Regra de DTO ([princípios §3.2](../01-principios.md#32-conven%C3%A7%C3%B5es-de-nomes)): até 2 valores entram e saem direto; 3 ou mais viram DTO.

| Caso de uso | Assinatura | Gatilho | Passos |
|---|---|---|---|
| `ExecuteOrder` | `execute(input: ExecuteOrderInput): void` | `order.accepted.<marketId>` | Carrega o livro do mercado. Se o `orderId` já está no livro → ignora (idempotência de domínio, além da inbox). `book.place(entry)` → numa transação: grava entradas alteradas e removidas, trades, `sequence`, outbox (`tradeExecuted` × N + `orderRemoved` por STP + `bookSnapshot`). |
| `RemoveOrder` | `execute(orderId, marketId): void` | `order.cancelRequested.<marketId>` | `book.cancel` → `matching.orderRemoved(CANCELLED)` + `bookSnapshot`, ou `matching.orderCancelRejected(NOT_IN_BOOK)`. |

`ExecuteOrderInput`: `orderId, accountId, marketId, side, quantity, price, acceptedAt` (o payload do `order.accepted`).

Contratos (interfaces em `application/contracts/`): `OrderBookRepository` (`load(marketId)` devolve o livro, vazio se ainda não existe; `save` com checagem de `sequence`), `TransactionRunner`, `DomainEventDispatcher`, `IdGenerator` (id dos trades), `Clock`. Não há DAO: este serviço não atende consultas.

Sagas em que este serviço participa: **S2** (passo repetível, depois do pivot), **S3** (dono: o trade é o pivot) e **S4** (pivot: remover do livro). Ver [06-sagas.md](../06-sagas.md).

### Banco como verdade, livro carregado a cada mensagem
- Cada mensagem carrega o livro do mercado do banco, aplica a ordem ou o cancelamento e grava tudo **na mesma transação** com o outbox. Só depois do `commit` vem o `ack`.
- Se a transação falhar, nada fica pela metade: a próxima tentativa carrega de novo o que está no banco.
- Como só existe um consumidor ativo por mercado (`single-active-consumer`), não há outro processo escrevendo no mesmo livro. O `save` ainda confere a `sequence` (`ConcurrentBookUpdateError`), como defesa.
- **Simplificação consciente:** manter o livro em memória entre mensagens e só recarregar em caso de falha evitaria a leitura a cada ordem. No conceito, com livros pequenos, a leitura por mensagem é mais simples e sempre consistente; o cache em memória fica como otimização futura, sem mudar domínio nem contratos.

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

Os mercados vêm do `markets.json` (os de `status: active`): o worker abre uma fila `matching.orders.<marketId>` e um consumidor por mercado. Mercado novo = nova entrada no catálogo (e nas cópias dele), sem variável de ambiente.

### Republish do histórico

`make history-republish` (`npm run history:republish` no `matching-worker`) existe só para o rebuild das projeções do `market-data` ([mensageria §8](../03-mensageria.md#8-rebuild-de-proje%C3%A7%C3%B5es-republish-a-partir-do-produtor)). Lê o banco e publica direto em `matching.events`, num canal com *publisher confirms* (sem outbox: não muda estado, e se cair basta rodar de novo):
1. cada linha de `trade`, por mercado e `book_sequence`, como `matching.tradeExecuted` com routing `matching.replay.tradeExecuted.<marketId>`;
2. o snapshot atual de cada livro (`OrderBook.levels()`) como `matching.bookSnapshot` com routing `matching.replay.bookSnapshot.<marketId>`;
3. `matching.replayCompleted` (`trades`, `snapshots`) com routing `matching.replay.completed`.

Os bindings de `wallet` e `order` (`matching.tradeExecuted.*`) não pegam o prefixo `matching.replay.`, então ninguém liquida nem preenche de novo.

## 8. Estrutura

```
backend/matching/
  .env.example  .env.test.example  Makefile (migrações e testes; roda no matching-worker, que é o único processo)
  docker/                           Dockerfile  Dockerfile.dockerignore  docker-compose.yml  docker-compose.platform.yml  docker-compose.test.yml
  package.json  package-lock.json  tsconfig.json  eslint.config.mjs  .dependency-cruiser.cjs  vitest.config.ts
  src/
    domain/
      entities/                     orderBook.ts  bookEntry.ts  bookSide.ts (bids e asks: a ordenação preço-tempo)  aggregateRoot.ts
      valueObjects/                 trade.ts  orderId.ts  accountId.ts  marketId.ts  side.ts  quantity.ts  price.ts
      domainEvents/                 domainEvent.ts  tradeExecuted.ts  orderRemoved.ts  orderCancelRejected.ts  bookChanged.ts
      domainServices/               (vazio por enquanto: toda regra cabe no agregado OrderBook)
      errors.ts
    application/
      usecases/                     executeOrder.ts  removeOrder.ts  useCase.ts  bookStore.ts (carregar e salvar+despachar)
      dtos/                         executeOrderDto.ts
      contracts/                    orderBookRepository.ts  transactionRunner.ts  domainEventDispatcher.ts  idGenerator.ts  clock.ts
    infra/
      http/health.ts                só /health (não há API pública)
      messaging/
        consumers/marketOrdersConsumer.ts   um por mercado; retry em processo; consumedEvent.ts
        matchingIntegrationEvents.ts        domain event → outbox
        historyRepublisher.ts               republish do histórico para rebuild de projeção
      database/                     kyselyOrderBookRepository.ts  kyselyTransactionRunner.ts  postgres.ts  database.ts
                                    migrator.ts  migrationFiles.ts
        migrations/                 outbox, inbox, book, book_entry, trade
      catalog/jsonMarketCatalog.ts  mercados ativos do markets.json
      platform/                     copiados do order, sem http/ (não há rotas públicas) e sem security/ (não há gRPC)
      contracts/
        published/events/           matching.tradeExecuted.v1  matching.orderRemoved.v1  matching.orderCancelRejected.v1  matching.bookSnapshot.v1
                                    matching.replayCompleted.v1
        consumed/events/            order.accepted.v1  order.cancelRequested.v1
        envelope.schema.json  markets.json  markets.schema.json
      composition.ts  settings.ts  system.ts
      worker.ts  migrate.ts  republish.ts
  test/
    unit/  integration/             espelham src/
    fakes/  support/
```

Os originais de `matching.tradeExecuted`, `matching.orderRemoved` e `matching.orderCancelRejected` são **os mesmos bytes** das cópias que `order` e `wallet` já guardam (escritas por eles a partir da [mensageria §3](../03-mensageria.md#3-cat%C3%A1logo-de-eventos-v1)); o `matching` passa a ser o dono.

O evento de domínio `BookChanged` vira o evento de integração `matching.bookSnapshot` no `matchingIntegrationEvents`. O `matching` não tem `api.ts`: o `/health` sobe junto com o `worker`.

### `.env.example`

```bash
HEALTH_PORT=3001
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
| Integração | Livro recarregado do banco é igual ao que estava em memória · falha no meio da transação não deixa trade sem entrada atualizada · consumer de mercado: ordens processadas na ordem de chegada, trade e snapshot publicados no outbox, `order.accepted` repetido não duplica · migrações sobem e descem |
| Contrato | `tradeExecuted`, `orderRemoved`, `orderCancelRejected`, `bookSnapshot` validam nos schemas |
