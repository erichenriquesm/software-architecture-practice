# 99 — Decisões sobre as lacunas do objetivo

> Status: **resolvido** · As 17 questões que o [objective.md](objective.md) deixava em aberto, decididas com base em como exchanges e APIs reais resolvem cada uma. Por ser um projeto de conceito, a regra foi: **seguir o padrão de mercado sempre que ele for consistente com o resto da spec**; quando não for, ficar com a solução mais simples que preserve as invariantes.

## Princípio que amarra as decisões

**Não arredondar, validar.** Exchanges reais não arredondam preço nem quantidade: rejeitam o que não respeita os filtros do mercado. Com isso, toda conta (`qty × price`, reserva, liquidação) é **exata** na escala interna, e várias questões (Q6, Q11, Q12) se resolvem juntas.

---

## Decisões

| # | Lacuna | Decisão | Referência real |
|---|---|---|---|
| <a id="q1"></a>**Q1** | Withdraw dizia "quantidade **≥** saldo" (invertido). | `quantity ≤ available`. O saldo reservado em ordens abertas **não** pode ser sacado. | Binance separa `free` de `locked`, e só o `free` é sacável. |
| <a id="q2"></a>**Q2** | Schema `ccca` × `app`, banco único. | Um Postgres por serviço; schema com o nome do serviço. | Database per service. |
| <a id="q3"></a>**Q3** | `cancel_order` sem caso de uso. | Cancela **só a parte não executada**; o que já executou continua executado. A ordem termina `cancelled` com `fillQuantity` preservado. | Binance: ordem `CANCELED` mantém o `executedQty`. |
| <a id="q4"></a>**Q4** | Sem autenticação; `accountId` no corpo. | **Fora do escopo do conceito.** Os serviços recebem `accountId` como diz o objetivo. Ponto de extensão definido: o **edge proxy** autentica (API key + assinatura HMAC com timestamp) e injeta `X-Account-Id`; a partir daí, os serviços passam a ignorar o `accountId` do corpo. Nenhum serviço implementa autenticação de usuário própria. Quando o login existir, a identidade do usuário viaja do edge para os serviços num **JWT interno** de vida curta, assinado só pelo edge ([autenticação entre serviços §6](08-autenticacao-entre-servicos.md#6-identidade-do-usu%C3%A1rio-jwt-interno-quando-o-login-existir)). A autenticação **entre serviços** (mTLS e credenciais por canal) já faz parte do conceito. As regras contra brute force do login futuro (bloqueio por conta e por IP, escalonado e temporário) já estão em [rate limiting §4](07-rate-limiting.md#4-brute-force-em-autentica%C3%A7%C3%A3o). | Binance: endpoints `SIGNED` com `X-MBX-APIKEY` + HMAC-SHA256 + `timestamp`/`recvWindow`. |
| <a id="q5"></a>**Q5** | Quais mercados existem? | **Catálogo estático** em `backend/contracts/markets.json` (dado de referência da Published Language, não código de domínio), com os **filtros** de cada mercado. Hoje só `BTC-USD`. Cada serviço lê o catálogo na inicialização. | Binance `exchangeInfo`: lista de símbolos com filtros. |
| <a id="q6"></a>**Q6** | "Precisão" do GetDepth agrupa casas inteiras. | `bucket = floor(price / 10^p) × 10^p`. Vai de `p = −2` (o próprio tick de `0.01`, **sem agregação**) até `p = 5`. **Padrão: sem agregação.** O exemplo do objetivo (`p = 3` → 84.000) continua valendo. | Bitfinex: book com níveis de agregação (`P0`…) e book "raw". |
| <a id="q7"></a>**Q7** | Cancelar ordem em `pending`? | **Pode.** Exchanges deixam cancelar a qualquer momento antes do fim. Em `pending`, o cancelamento usa a **mesma compensação do timeout**: a ordem vira `cancelled` e publica `order.voided`, e o `wallet` libera ou anula a reserva. O pivot da saga continua sendo um só (a ordem sai de `pending` uma única vez). | Binance permite cancelar ordem `NEW`. |
| <a id="q8"></a>**Q8** | Ordem a mercado. | **Fora do escopo**, como diz o objetivo: só ordem limitada. | — |
| <a id="q9"></a>**Q9** | Self-trade (a conta casa com a própria ordem). | **Prevenção de self-trade (STP) no `matching`, modo "cancelar o maker":** se o melhor maker é da mesma conta do taker, o maker é **removido do livro** (`orderRemoved`, motivo `SELF_TRADE_PREVENTION`) e o taker continua casando com o próximo. Não existe trade de uma conta com ela mesma, o que protege volume e preço do `market-data`. | Binance `EXPIRE_MAKER` (padrão na Binance.US) · Coinbase "cancel oldest" (`co`). |
| <a id="q10"></a>**Q10** | Taxas. | **Sem taxa.** Taxa maker/taker entra depois como campo novo no `tradeExecuted` (mudança compatível). | Exchanges reais cobram maker/taker; fica como evolução. |
| <a id="q11"></a>**Q11** | Casas decimais e arredondamento. | Filtros do mercado `BTC-USD`: **tick** (preço) `0.01`, **step** (quantidade) `0.00001`, **valor mínimo** (`qty × price`) `5 USD`. Preço fora do tick ou quantidade fora do step é **rejeitado** (`422`), não arredondado. Escala interna **8** para todos os ativos (`numeric(36,8)`). Como `step × tick = 10⁻⁷`, todo `qty × price` cabe em 8 casas: **nenhum arredondamento acontece** em reserva ou liquidação. Depósito e saque respeitam a precisão do ativo: `BTC` 8 casas, `USD` 2. Liquidações podem deixar no saldo de `USD` um resíduo abaixo do centavo (até 7 casas): ele continua no saldo, entra em novas ordens, mas não é sacável. É a mesma "poeira" que as exchanges reais acumulam. | Binance `PRICE_FILTER` (`price % tickSize == 0`), `LOT_SIZE` (`stepSize`), `NOTIONAL` (`minNotional`). |
| <a id="q12"></a>**Q12** | `quantity` no GetAccount: total ou disponível? | `quantity = available + reserved` (total), e também `available` e `reserved`. | Binance: `free` + `locked` por ativo. Coinbase: `holds`. |
| <a id="q13"></a>**Q13** | Idempotência dos POSTs públicos. | Header **`Idempotency-Key`** em **todos** os POSTs públicos (`/signup`, `/deposit`, `/withdraw`, `/place_order`, `/cancel_order`), com o comportamento da Stripe: a primeira resposta (status + corpo) é guardada e **devolvida igual** nas repetições; a mesma chave com outro corpo → `422`; as chaves ficam guardadas por **pelo menos 24 h**. Implementado em `libs/http`, com tabela `idempotency_key` no banco de cada serviço. | Stripe Idempotent Requests. |
| <a id="q14"></a>**Q14** | Origem de depósito e saque. | **Simulados** (confirmado): só mexem no saldo. Sem gateway de pagamento, banco ou blockchain. | — |
| <a id="q15"></a>**Q15** | Código atual na raiz (`src/`, `Dockerfile`, `package.json`…). | **Era só experimento: nada é migrado.** Tudo o que está hoje na raiz (`src/`, `dist/`, `node_modules/`, `Dockerfile`, `.dockerignore`, `.npmrc`, `package.json`, `package-lock.json`, `tsconfig.json`, `vitest.config.ts`) é **apagado no início da fase 0**. A raiz passa a ter só `backend/` e `frontend/`, além de `sdd/` e dos arquivos do git ([ambiente §0](04-ambiente-docker.md#0-layout-da-raiz-do-reposit%C3%B3rio)). As ideias que valem (VOs de nome e e-mail, corrente de fallback) são reescritas do zero nos lugares certos. | — |
| <a id="q16"></a>**Q16** | GetMarket sem período. | **Janela móvel das últimas 24 h** (não o dia do calendário). | Binance `ticker/24hr`: "rolling window", não o dia UTC. |
| <a id="q17"></a>**Q17** | Reconstruir projeções sem histórico no broker. | **RabbitMQ Stream** (log só de inclusão, relido por offset) no mesmo broker. O `market-data` declara o stream `marketData.matchingLog` com binding em `matching.events` (`matching.#`). No rebuild, apaga as `*_view` e relê o stream do início; as projeções são idempotentes e *last-write-wins*, então reler é seguro. Retenção: `x-max-age` de 30 dias no conceito. | RabbitMQ Streams (desde a 3.9): leitura não destrutiva com offset, própria para replay. |

---

## Anexo: formato do `markets.json`

Catálogo de referência da [Q5](#q5), em `backend/contracts/markets.json`. Valores decimais em **string**, como nos eventos.

```json
{
  "version": 1,
  "assets": [
    { "assetId": "BTC", "precision": 8 },
    { "assetId": "USD", "precision": 2 }
  ],
  "markets": [
    {
      "marketId": "BTC-USD",
      "baseAsset": "BTC",
      "quoteAsset": "USD",
      "tickSize": "0.01",
      "stepSize": "0.00001",
      "minQuantity": "0.00001",
      "minNotional": "5",
      "depthPrecision": { "min": -2, "max": 5 },
      "status": "active"
    }
  ]
}
```

| Campo | Uso |
|---|---|
| `assets[].precision` | Casas aceitas em depósito e saque (`wallet`) |
| `tickSize`, `stepSize`, `minQuantity`, `minNotional` | Filtros da `PlaceOrder` (`order`), [Q11](#q11) |
| `depthPrecision` | Faixa de `precision` aceita no `GetDepth` e níveis pré-agregados (`market-data`), [Q6](#q6) |
| `status` | `active` aceita ordens; outro valor recusa novas ordens. Hoje só existe `active`. |

O arquivo tem um JSON Schema próprio em `contracts/` e é validado na inicialização de cada serviço: catálogo inválido impede o serviço de subir.

## O que mudou nas specs por causa destas decisões

| Decisão | Documentos ajustados |
|---|---|
| Q5, Q11 (catálogo + filtros) | [princípios](01-principios.md), [design estratégico](02-design-estrategico.md), [order](services/order.md), [wallet](services/wallet.md) |
| Q6 (precisão a partir do tick) | [market-data](services/market-data.md) |
| Q7 (cancelar em `pending`) | [order](services/order.md), [wallet](services/wallet.md), [mensageria](03-mensageria.md), [sagas](06-sagas.md) |
| Q9 (STP) | [matching](services/matching.md), [wallet](services/wallet.md), [order](services/order.md), [mensageria](03-mensageria.md), [sagas](06-sagas.md) |
| Q13 (`Idempotency-Key` em todos os POSTs) | [princípios](01-principios.md), todos os serviços com REST |
| Q16, Q17 (24 h e stream) | [market-data](services/market-data.md), [mensageria](03-mensageria.md) |

## Fontes

- Binance — filtros de mercado (`PRICE_FILTER`, `LOT_SIZE`, `NOTIONAL`): https://developers.binance.com/docs/binance-spot-api-docs/filters
- Binance — prevenção de self-trade (STP): https://developers.binance.com/docs/binance-spot-api-docs/faqs/stp_faq · https://support.binance.us/en/articles/9842907-self-trade-prevention
- Binance — segurança de requisição (API key + HMAC): https://developers.binance.com/legacy-docs/binance-spot-api-docs/rest-api/request-security
- Binance — estatísticas de 24 h em janela móvel: https://developers.binance.com/docs/derivatives/usds-margined-futures/market-data/rest-api/24hr-Ticker-Price-Change-Statistics
- Binance — status de ordem (`NEW`, `CANCELED`, `EXPIRED`…): https://github.com/KenRoytman/binance-official-api-docs/blob/master/rest-api.md
- Coinbase Exchange — matching engine e STP: https://docs.cdp.coinbase.com/exchange/concepts/matching-engine
- Coinbase Exchange — ordens, `holds` e liquidação: https://docs.cdp.coinbase.com/api-reference/exchange-api/rest-api/orders/get-single-order.md
- Bitfinex — níveis de agregação do book: https://docs.bitfinex.com/reference/ws-public-books
- Stripe — requisições idempotentes: https://docs.stripe.com/api/idempotent_requests
- RabbitMQ — Streams e replay: https://www.cloudamqp.com/blog/rabbitmq-streams-and-replay-features-part-1-when-to-use-rabbitmq-streams.html · https://www.rabbitmq.com/docs/stream-effectively-once-processing
