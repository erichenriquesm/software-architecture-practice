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
- **Projection writers** (`infra`), que transformam evento em linha de `*_view`.
- **Funções puras** (`application/calculations/`), com a matemática testável: agregação por precisão, spread, combinação de candles.
- **DAOs** (`application/daos/` + `infra/adapters/outbound/persistence/daos/`), que leem as `*_view`.
- **Casos de uso de consulta**, finos: recebem `<Consulta>Input`, chamam o DAO (que devolve `<X>View`) e devolvem `<Consulta>Output`.

## 4. Projeções

| Projeção | Alimentada por | Como | Serve |
|---|---|---|---|
| `trade_view` | `matching.tradeExecuted` | `insert … on conflict do nothing` (idempotente por `trade_id`) | `GetTrades`, bordas do `GetMarket` |
| `candle_1m_view` | `matching.tradeExecuted` | *upsert* comutativo por (mercado, minuto): `min`, `max`, `volume += qty × price`, `open`/`close` pelo trade mais antigo/mais novo | `GetMarket` |
| `book_state_view` | `matching.bookSnapshot` | Substitui se `sequence` for maior (*last-write-wins*) | Spread |
| `depth_view` | `matching.bookSnapshot` | Na mesma transação do `book_state_view`: apaga e regrava os níveis **já agregados para cada precisão de −2 (sem agregação) a 5** | `GetDepth` |

**Pré-agregação do depth:** em vez de agrupar a cada request, o projetor calcula os níveis para todas as precisões suportadas quando o snapshot chega (`aggregateDepth`, função pura). O `GetDepth` vira **uma leitura por índice**. O custo é escrever ~8× os níveis por snapshot, que é pequeno.

**Candles de 1 minuto:** o `GetMarket` soma os candles dos minutos inteiros do período e lê em `trade_view` só as **bordas** (os minutos parciais do início e do fim). Assim, um período longo custa poucas linhas, e não todas as negociações.

## 5. Regras de cálculo

| Cálculo | Regra |
|---|---|
| Faixa de preço (`precision = p`) | `bucket = floor(price / 10^p) × 10^p`. Ex.: `p = 3` → 84.500, 84.600 e 84.700 caem em **84.000** ([Q6](../99-decisoes.md#q6)). `p = −2` é o próprio tick (`0.01`): nível de preço exato, sem agregação. |
| Quantidade da faixa | Soma das quantidades das ordens abertas daquele lado na faixa. |
| Precisão suportada | Do expoente do tick do mercado (`−2` em `BTC-USD`) até `5`. **Sem `precision` → sem agregação** (`−2`). Fora da faixa → `422`. |
| Spread | `melhor ask − melhor bid` do livro atual. `null` se faltar um dos lados. Não depende do período. |
| Min / Max | Menor / maior **preço negociado** no período. |
| Volume | `Σ quantity × price` das negociações do período (no ativo de cotação). |
| Período | `startDate` inclusive, `endDate` exclusivo. Sem período → **janela móvel das últimas 24 h**, não o dia do calendário, como o ticker de 24 h da Binance ([Q16](../99-decisoes.md#q16)). |

## 6. API pública (REST)

| Método | Rota | Entrada | Saída |
|---|---|---|---|
| GET | `/markets/:marketId/depth` | `?precision=` (opcional) | `200 { buys: [{ quantity, price }], sells: [{ quantity, price }], sequence, asOf }` — `buys` em preço decrescente, `sells` em crescente |
| GET | `/markets/:marketId/trades` | `?limit=50&before=<executedAt>` | `200 [{ tradeId, buyOrderId, sellOrderId, side, quantity, price, timestamp }]` — mais recentes primeiro |
| GET | `/markets/:marketId` | `?startDate&endDate` | `200 { spread, min, max, volume, asOf }` |

Erros: `404` mercado desconhecido · `422` parâmetro inválido.
`asOf` informa até quando a projeção está atualizada (dado com consistência eventual).

## 7. Mensageria

| Direção | Evento | Fila |
|---|---|---|
| Consome | `matching.tradeExecuted` | `marketData.trades` |
| Consome | `matching.bookSnapshot` | `marketData.book` |
| Declara (replay) | `matching.#` | `marketData.matchingLog` (stream, só lido no rebuild) |

`trade_view` e `candle_1m_view` são atualizadas **na mesma transação**, com inbox por `eventId`: o candle não é somado duas vezes.
O snapshot dispensa inbox: o `sequence` já torna a aplicação idempotente.

## 8. Dados (`market-data-db`, schema `market_data`)

```sql
create table trade_view (
  trade_id       uuid primary key,
  market_id      text not null,
  buy_order_id   uuid not null,
  sell_order_id  uuid not null,
  side           text not null,
  quantity       numeric(36,8) not null,
  price          numeric(36,8) not null,
  executed_at    timestamptz not null
);
create index trade_view_market_time on trade_view (market_id, executed_at desc);

create table candle_1m_view (
  market_id     text not null,
  bucket_start  timestamptz not null,      -- truncated to the minute
  open_price    numeric(36,8) not null,
  open_at       timestamptz not null,
  close_price   numeric(36,8) not null,
  close_at      timestamptz not null,
  min_price     numeric(36,8) not null,
  max_price     numeric(36,8) not null,
  volume        numeric(36,8) not null,
  trade_count   integer not null,
  primary key (market_id, bucket_start)
);

create table book_state_view (
  market_id   text primary key,
  sequence    bigint not null,
  best_bid    numeric(36,8),
  best_ask    numeric(36,8),
  updated_at  timestamptz not null
);

create table depth_view (
  market_id  text not null,
  precision  smallint not null,
  side       text not null,               -- buy | sell
  price      numeric(36,8) not null,      -- bucket start
  quantity   numeric(36,8) not null,
  primary key (market_id, precision, side, price)
);

-- inbox: see 03-mensageria.md §5 (no outbox: publishes nothing)
```

Todas as tabelas são **descartáveis**: `npm run projections:rebuild` (container) apaga as `*_view` e relê do início o stream `marketData.matchingLog`, um RabbitMQ Stream declarado por este serviço com retenção de 30 dias ([mensageria §8](../03-mensageria.md#8-stream-para-replay-de-proje%C3%A7%C3%B5es), [Q17](../99-decisoes.md#q17)).

## 9. Estrutura

```
backend/market-data/src/
  application/   queries/{getDepth, getTrades, getMarket}/   (cada pasta: <query>.ts, <query>Input.ts, <query>Output.ts)
                 daos/{depthDao, tradeDao, marketStatsDao}.ts
                 calculations/{aggregateDepth, priceBucket, spread, mergeCandle}.ts   ← funções puras
  infra/         adapters/inbound/{http, messaging/{trades, book}Consumer, messaging/matchingLogReplayer}
                 adapters/outbound/persistence/{daos, projections/{tradeProjector, bookProjector}}
                 main/{api, worker, migrate}.ts
```

## 10. Testes principais

| Nível | Casos |
|---|---|
| Unidade | `priceBucket` com o exemplo do objetivo (84.500/84.600/84.700, p=3 → 84.000) · `aggregateDepth`: duas ordens de 10 @ 84.500 → 20 @ 84.500 · ordenação de `buys`/`sells` · `spread` com um lado vazio · `mergeCandle` comutativo (mesmo resultado em qualquer ordem de trades) · validação de `precision` e período |
| Integração | Snapshot antigo depois do novo é ignorado · `tradeExecuted` duplicado não soma volume duas vezes · `GetMarket` com período que corta minutos (bordas + candles) bate com o cálculo direto sobre `trade_view` · `depth_view` reescrita atomicamente |
| Contrato | Fixtures de `tradeExecuted` e `bookSnapshot` geradas dos schemas são aceitas pelos projetores |
