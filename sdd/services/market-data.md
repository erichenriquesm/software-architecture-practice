# Serviço `market-data` — Dados de Mercado

> Status: **spec** · Subdomínio: **Supporting** · Modelagem: **sem domínio (CQRS: projeções + DAOs)**

## 1. Responsabilidade

Responder, com baixa latência, as consultas públicas de mercado:
- **Depth**: profundidade do livro agregada por faixa de preço, com precisão.
- **Trades**: histórico de negociações do mercado.
- **Market**: spread, mínimo, máximo e volume num período.

Tudo vem de **projeções** dos eventos do `matching`. Este serviço não decide nada e não publica eventos.

## 2. Workload

**Leitura intensa** e cliente sensível a latência. Escrita só pelos projetores (worker). `api` escala horizontalmente sem coordenação: só lê.

## 3. Por que não há camada de domínio

Não há invariante a proteger: os fatos já foram decididos pelo `matching`. Um agregado aqui seria cerimônia. O que existe:
- **Projection writers** (`infra/database/`), que transformam evento em linha de `*_view`. O consumer chama o projetor direto: gravar uma projeção não tem regra, então não há caso de uso de escrita.
- **Funções puras** (`application/calculations/`), com a matemática testável: faixa de preço, agregação por precisão, spread, período e combinação de estatísticas.
- **DAOs** (interface em `application/contracts/`, implementação em `infra/database/`), que leem as `*_view` e devolvem `<X>View`.
- **Casos de uso de consulta**, finos: validam a consulta, chamam o DAO e montam a resposta.
- **Erros de aplicação** em `application/errors.ts` (não há `domain/errors.ts`).

## 4. Projeções

| Projeção | Alimentada por | Como | Serve |
|---|---|---|---|
| `trade_view` | `matching.tradeExecuted` | `insert … on conflict (trade_id) do nothing` | `GetTrades`, bordas do `GetMarket` |
| `candle_1m_view` | `matching.tradeExecuted` | Só quando o trade entrou de fato em `trade_view`: *upsert* comutativo por (mercado, minuto) em SQL: `least`/`greatest` no `min`/`max`, `volume += quantity × price`, `trade_count += 1`, `open`/`close` pelo trade mais antigo/mais novo (desempate por `trade_id`) | `GetMarket` |
| `book_state_view` | `matching.bookSnapshot` | *Upsert* com `where sequence < excluded.sequence` (*last-write-wins*) | Spread, `sequence` e `asOf` do depth |
| `depth_view` | `matching.bookSnapshot` | Na mesma transação, e só se o `book_state_view` mudou: apaga e regrava os níveis **já agregados para cada precisão do mercado (−2 a 5)** | `GetDepth` |

**Idempotência dos trades:** o candle só soma o trade que acabou de entrar em `trade_view` (o `insert` devolve se inseriu). Assim o volume não conta duas vezes nem com a mesma mensagem entregue de novo (que a inbox já barra) nem no rebuild, que relê o republish do `matching` sem inbox (§8).

**Comutatividade do candle:** `min`, `max`, `volume` e `trade_count` são somas e extremos; `open`/`close` comparam `(executed_at, trade_id)`. Qualquer ordem de chegada dá o mesmo candle, o que importa porque o retry por fila de atraso não preserva a ordem ([mensageria §5](../03-mensageria.md#handlers-comutativos)).

**Snapshot concorrente:** o *upsert* trava a linha do mercado até o `commit`. Dois snapshots ao mesmo tempo se serializam ali; o segundo reavalia o `where` contra a linha já gravada e, se for mais antigo, não toca no `depth_view`.

**Pré-agregação do depth:** em vez de agrupar a cada request, o projetor calcula os níveis para todas as precisões suportadas quando o snapshot chega (`aggregateDepth`, função pura). O `GetDepth` vira **uma leitura por índice**. O custo é escrever ~8× os níveis por snapshot, que é pequeno.

**Candles de 1 minuto:** o `GetMarket` soma os candles dos minutos inteiros do período e lê em `trade_view` só as **bordas** (os minutos parciais do início e do fim). Assim, um período longo custa poucas linhas, e não todas as negociações.

## 5. Regras de cálculo

| Cálculo | Regra |
|---|---|
| Faixa de preço (`precision = p`) | `bucket = floor(price / 10^p) × 10^p`. Ex.: `p = 3` → 84.500, 84.600 e 84.700 caem em **84.000** ([Q6](../99-decisoes.md#q6)). `p = −2` é o próprio tick (`0.01`): nível de preço exato, sem agregação. Vale igual para os dois lados. |
| Quantidade da faixa | Soma das quantidades daquele lado na faixa. |
| Ordenação | `buys` em preço decrescente, `sells` em crescente. |
| Precisão suportada | `depthPrecision` do mercado no `markets.json` (`−2` a `5` em `BTC-USD`). **Sem `precision` → sem agregação** (o `min`). Fora da faixa → `422`. |
| Spread | `melhor ask − melhor bid` do livro atual. `null` se faltar um dos lados. Não depende do período. |
| Min / Max | Menor / maior **preço negociado** no período. `null` sem negociações. |
| Volume | `Σ quantity × price` das negociações do período (no ativo de cotação). `0` sem negociações. |
| Período | `startDate` inclusive, `endDate` exclusivo. Sem os dois → **janela móvel das últimas 24 h** até agora, não o dia do calendário, como o ticker de 24 h da Binance ([Q16](../99-decisoes.md#q16)). Só `startDate` → até agora. Só `endDate` → as 24 h antes dele. `startDate ≥ endDate` ou data inválida → `422`. |
| Divisão do período | Borda inicial `[start, próximo minuto)` e final `[minuto de end, end)` em `trade_view`; minutos inteiros entre elas em `candle_1m_view`. Período dentro de um único minuto → só `trade_view`. |
| `asOf` | Depth: momento (`occurredAt`) do snapshot aplicado. Market: o mais recente entre o snapshot aplicado e o último trade do mercado. `null` enquanto não houver nenhum. |

Decimais saem como string com 8 casas (`"84000.00000000"`), como no resto da plataforma.

## 6. Casos de uso

Regra de DTO ([princípios §3.2](../01-principios.md#32-conven%C3%A7%C3%B5es-de-nomes)): até 2 valores entram e saem direto; 3 ou mais viram DTO. Quando o caso de uso devolve exatamente o `<X>View` do DAO, ele usa esse tipo (sem alias).

| Caso de uso | Assinatura | Adapter de entrada | Passos |
|---|---|---|---|
| `GetDepth` | `execute(marketId, precision?): DepthView` | REST `GET /markets/:marketId/depth` | Mercado no catálogo (`404`) → precisão na faixa do mercado, padrão o `min` (`422`) → `DepthDao.findByPrecision`. Sem snapshot ainda: livro vazio, `sequence = 0`, `asOf = null`. |
| `GetTrades` | `execute(input: GetTradesInput): TradeView[]` | REST `GET /markets/:marketId/trades` | Mercado (`404`) → `limit` de 1 a 500, padrão 50 (`422`) → `before` é data válida (`422`) → `TradeDao.listRecent`, mais recentes primeiro. |
| `GetMarket` | `execute(input: GetMarketInput): GetMarketOutput` | REST `GET /markets/:marketId` | Mercado (`404`) → `marketPeriod` → `splitByMinute` → `MarketStatsDao.candleStats`/`tradeStats` por pedaço → `combineStats` → `topOfBook` → `spread` → `asOf`. |

DTOs (`application/dtos/`):

| DTO | Campos | Usado por |
|---|---|---|
| `GetTradesInput` | `marketId, limit?, before?` | `GetTrades` |
| `GetMarketInput` | `marketId, startDate?, endDate?` | `GetMarket` |
| `GetMarketOutput` | `spread, min, max, volume, asOf` | `GetMarket` |
| `DepthView` | `buys[{ quantity, price }], sells[{ quantity, price }], sequence, asOf` (níveis em `DepthLevelView`) | `DepthDao`, `GetDepth` |
| `TradeView` | `tradeId, buyOrderId, sellOrderId, side, quantity, price, timestamp` | `TradeDao`, `GetTrades` |
| `TradeStatsView` | `min, max, volume` | `MarketStatsDao`, `combineStats` |
| `TopOfBookView` | `bestBid, bestAsk, updatedAt` | `MarketStatsDao` |

Contratos (interfaces em `application/contracts/`): `DepthDao` (`findByPrecision`), `TradeDao` (`listRecent`), `MarketStatsDao` (`candleStats`, `tradeStats`, `topOfBook`, `lastTradeAt`), `MarketCatalog` (`depthPrecisionOf`: faixa de precisão do mercado, `undefined` se não existe ou não está ativo), `Clock`.

Funções puras (`application/calculations/`): `priceBucket`, `aggregateDepth`, `spread`, `marketPeriod` + `splitByMinute`, `combineStats`.

## 7. API pública (REST)

| Método | Rota | Entrada | Saída |
|---|---|---|---|
| GET | `/markets/:marketId/depth` | `?precision=` (inteiro, opcional) | `200 { buys: [{ quantity, price }], sells: [{ quantity, price }], sequence, asOf }` |
| GET | `/markets/:marketId/trades` | `?limit=50&before=<executedAt>` | `200 [{ tradeId, buyOrderId, sellOrderId, side, quantity, price, timestamp }]` — mais recentes primeiro; `before` é exclusivo |
| GET | `/markets/:marketId` | `?startDate&endDate` (ISO 8601) | `200 { spread, min, max, volume, asOf }` |

Erros: `404 marketNotFound` mercado desconhecido · `422 invalidQuery` parâmetro fora da regra (faixa de `precision` ou `limit`, data inválida, período invertido) · `422 invalidRequest` parâmetro do tipo errado, barrado pelo schema da rota (`precision=alta`). Parâmetro desconhecido na query é ignorado.
`asOf` informa até quando a projeção está atualizada (dado com consistência eventual).

**Rate limit** ([07 §3.1](../07-rate-limiting.md#31-grupos-e-limites)): grupo `publicRead`, por IP, `RATE_LIMITS_PUBLIC_READ_PER_IP=1200/1m` de peso. Peso: `GET /markets/:id` = 1 · `/trades` = 2 até 50 itens, 5 acima · `/depth` = 2. Chaves no Redis com o prefixo `marketData:` (o usuário `marketData` só enxerga essas chaves). Sem limite por conta: as rotas são públicas.

O `market-data` não tem `POST`, por isso não tem `Idempotency-Key` nem a tabela `idempotency_key`.

## 8. Mensageria

| Direção | Evento | Fila |
|---|---|---|
| Consome | `matching.tradeExecuted` (`matching.tradeExecuted.*`) | `marketData.trades` |
| Consome | `matching.bookSnapshot` (`matching.bookSnapshot.*`) | `marketData.book` |
| Consome (rebuild) | `matching.replay.#` | `marketData.replay` (vazia no dia a dia) |

As duas filas usam retry por filas de atraso (1s → 5s → 25s) e DLQ ([mensageria §4](../03-mensageria.md#4-retry-backoff-e-dlq)). Payload fora do contrato ou mercado fora do catálogo → DLQ direto; o resto (banco fora, deadlock) → retry.

`trade_view` e `candle_1m_view` são atualizadas **na mesma transação**, com inbox por `eventId`.
O snapshot **dispensa inbox**: o `sequence` já torna a aplicação idempotente, e uma linha de inbox por snapshot só faria a tabela crescer. O `Consumer` da plataforma tem a opção `inbox: false` para isso.

O worker declara, na subida, a fila `marketData.replay` (quorum, durável) ligada a `matching.events` com `matching.replay.#`, mas não a consome: ela só é lida pelo rebuild ([mensageria §8](../03-mensageria.md#8-rebuild-de-proje%C3%A7%C3%B5es-republish-a-partir-do-produtor)).

### Rebuild das projeções

`make projections-rebuild` no `Makefile` de `backend/` faz tudo; por baixo:
1. `market-data`: `npm run projections:rebuild-prepare` esvazia `marketData.replay`, para não sobrar nada de um rebuild interrompido;
2. `matching`: `npm run history:republish` publica todos os trades, o snapshot atual de cada livro e o marcador `matching.replayCompleted` (routing `matching.replay.*`);
3. `market-data`: `npm run projections:rebuild` faz o `truncate` de `trade_view`, `candle_1m_view`, `book_state_view` e `depth_view` numa transação, consome `marketData.replay` aplicando cada evento nos mesmos projetores, **sem inbox**, e termina ao receber o `replayCompleted`. Se nada chegar por `REBUILD_TIMEOUT` (padrão `60s`), falha com erro claro (o republish não rodou).

O schema do marcador fica em `src/infra/contracts/consumed/events/matching.replayCompleted.v1.schema.json`. O `Makefile` do serviço tem `projections-rebuild-prepare` e `projections-rebuild` para rodar os passos 1 e 3 sozinhos.

Os consumers normais podem continuar rodando durante o rebuild: o trade é gravado uma vez só (`trade_id`) e o snapshot é *last-write-wins*.

## 9. Dados (`market-data-db`)

```sql
create table trade_view (
  trade_id       uuid primary key,
  market_id      text not null,
  buy_order_id   uuid not null,
  sell_order_id  uuid not null,
  side           text not null,             -- taker side
  quantity       numeric(36,8) not null,
  price          numeric(36,8) not null,
  executed_at    timestamptz not null
);
create index trade_view_market_time on trade_view (market_id, executed_at desc, trade_id desc);

create table candle_1m_view (
  market_id       text not null,
  bucket_start    timestamptz not null,     -- truncated to the minute (UTC)
  open_price      numeric(36,8) not null,
  open_at         timestamptz not null,
  open_trade_id   uuid not null,
  close_price     numeric(36,8) not null,
  close_at        timestamptz not null,
  close_trade_id  uuid not null,
  min_price       numeric(36,8) not null,
  max_price       numeric(36,8) not null,
  volume          numeric(36,8) not null,
  trade_count     integer not null,
  primary key (market_id, bucket_start)
);

create table book_state_view (
  market_id   text primary key,
  sequence    bigint not null,
  best_bid    numeric(36,8),
  best_ask    numeric(36,8),
  updated_at  timestamptz not null          -- occurredAt of the applied snapshot
);

create table depth_view (
  market_id  text not null,
  precision  smallint not null,
  side       text not null,                 -- buy | sell
  price      numeric(36,8) not null,        -- bucket start
  quantity   numeric(36,8) not null,
  primary key (market_id, precision, side, price)
);

-- inbox: see 03-mensageria.md §5 (no outbox: publishes nothing; no idempotency_key: no POST)
```

Todas as tabelas `*_view` são **descartáveis** e recriadas pelo rebuild (§8, [Q17](../99-decisoes.md#q17)).

## 10. Estrutura

```
backend/market-data/
  .env.example  .env.test.example  Makefile (migrações, rebuild, testes, deps)
  docker/                           Dockerfile  Dockerfile.dockerignore  docker-compose.yml  docker-compose.platform.yml  docker-compose.test.yml
  package.json  package-lock.json  tsconfig.json  tsconfig.build.json  eslint.config.mjs  .dependency-cruiser.cjs  vitest.config.ts
  src/
    (sem domain/: não há invariante a proteger, §3)
    application/
      usecases/                     getDepth.ts  getTrades.ts  getMarket.ts  useCase.ts
      dtos/                         getTradesDto.ts  getMarketDto.ts  depthView.ts  tradeView.ts  marketStatsView.ts
      contracts/                    depthDao.ts  tradeDao.ts  marketStatsDao.ts  marketCatalog.ts  clock.ts
      calculations/                 priceBucket.ts  aggregateDepth.ts  spread.ts  marketPeriod.ts  combineStats.ts   ← funções puras
      errors.ts                     MarketNotFoundError  InvalidQueryError
    infra/
      http/                         marketRoutes.ts (depth, trades, market, rate limit)  health.ts
      messaging/
        consumers/                  tradesConsumer.ts  bookConsumer.ts  consumedEvent.ts
        replayQueue.ts              declaração e purge de marketData.replay
        projectionsRebuilder.ts     rebuild das projeções pelo republish do matching
      database/                     kyselyDepthDao.ts  kyselyTradeDao.ts  kyselyMarketStatsDao.ts
                                    tradeProjector.ts  bookProjector.ts  projections.ts (truncate do rebuild)
                                    kyselyTransactionRunner.ts  postgres.ts  database.ts  migrator.ts  migrationFiles.ts
        migrations/                 inbox, trade_view, candle_1m_view, book_state_view, depth_view
      catalog/jsonMarketCatalog.ts  lê e valida o markets.json na subida; faixa de precision por mercado
      platform/                     copiados do order (Consumer com units, opção inbox: false, reconexão ao RabbitMQ, rate limit); sem gRPC, sem outbox, sem idempotência
      contracts/
        consumed/events/            matching.tradeExecuted.v1  matching.bookSnapshot.v1
        envelope.schema.json  markets.json  markets.schema.json
      composition.ts  settings.ts  system.ts
      api.ts  worker.ts  migrate.ts  rebuild.ts
  test/
    unit/  integration/             espelham src/
    fakes/  support/
```

Sem `published/`: o `market-data` não publica eventos.

### `.env.example`

```bash
API_PORT=3000
HEALTH_PORT=3001
DATABASE_HOST=market-data-db
DATABASE_PORT=5432
DATABASE_NAME=market_data
DATABASE_USER=market_data
DATABASE_PASSWORD=market-data-db-dev
RABBITMQ_HOST=rabbitmq
RABBITMQ_USER=marketData
RABBITMQ_PASSWORD=market-data-rabbitmq-dev
REDIS_HOST=redis
REDIS_USER=marketData
REDIS_PASSWORD=market-data-redis-dev
RATE_LIMITS_PUBLIC_READ_PER_IP=1200/1m
REBUILD_TIMEOUT=60s
LOG_LEVEL=debug
```

## 11. Testes principais

| Nível | Casos |
|---|---|
| Unidade | `priceBucket` com o exemplo do objetivo (84.500/84.600/84.700, p=3 → 84.000) e p=−2 sem agregação · `aggregateDepth`: duas ordens de 10 @ 84.500 → 20 @ 84.500; três de 4 → 12 @ 84.000 · ordenação de `buys`/`sells` · `spread` com um lado vazio · `marketPeriod`: 24 h móveis, só início, só fim, início ≥ fim · `splitByMinute`: bordas + minutos inteiros, período dentro de um minuto · `combineStats` com pedaços vazios · casos de uso com fakes: mercado desconhecido (`404`), precisão fora da faixa e padrão sem agregação, `limit` e `before` inválidos, `asOf` mais recente · peso do rate limit por rota · catálogo e settings |
| Integração | Snapshot antigo depois do novo é ignorado · `depth_view` reescrita atomicamente por precisão · `tradeExecuted` duplicado (mesmo evento e mesmo `tradeId` com outro `eventId`) não soma volume duas vezes · candle igual em qualquer ordem de trades · `GetMarket` com período que corta minutos (bordas + candles) bate com o cálculo direto sobre `trade_view` · rotas HTTP com `404`/`422` e paginação por `before` · consumers × RabbitMQ (snapshot sem inbox, trade com inbox) · rebuild pelo republish recria as projeções e para no marcador · migrações sobem e descem |
| Contrato | Fixtures de `tradeExecuted` e `bookSnapshot` validadas nos schemas são aceitas pelos projetores; payload fora do schema vai para a DLQ |
