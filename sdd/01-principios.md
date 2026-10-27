# 01 — Princípios de Arquitetura

> Status: **spec** · Vale para todos os serviços em `backend/`.

Princípios são **regras com motivo**. Quando uma regra atrapalhar mais do que ajuda num caso concreto, quebre-a **registrando o porquê** na spec do serviço.

---

## 1. Clean Architecture pragmática

Cada serviço tem três camadas:

```
<servico>/src/
  domain/        ← regras de negócio. Zero dependência de framework, banco ou broker.
  application/   ← casos de uso: orquestram domínio + portas. Definem Input/Output e portas.
  infra/         ← HTTP, Postgres, RabbitMQ, gateways. Implementa as portas. Composition root.
```

**Regra de dependência:** `infra → application → domain`. Nunca o contrário.
Verificação automática: teste de arquitetura (ex.: `dependency-cruiser`) roda no pipeline e falha se `domain` importar `application`/`infra`, ou `application` importar `infra`.

### Ports & Adapters dentro da `infra`

Toda conversa com o mundo externo passa por um **adapter**. O caso de uso só conhece **portas** (interfaces em `application/`) e nunca sabe se do outro lado há RabbitMQ, gRPC, HTTP ou Postgres.

```
<servico>/src/infra/
  adapters/
    inbound/                    ← adapters de entrada (driving): mundo externo → caso de uso
      http/                     controllers REST (Fastify)
      grpc/                     handlers gRPC
      messaging/                um consumer por fila: envelope → ACL de entrada → Input → caso de uso
      scheduler/                jobs agendados (ex.: expirePendingOrdersJob)
    outbound/                   ← adapters de saída (driven): implementam as portas de application/
      persistence/              repositories, DAOs e projection writers (Postgres)
      messaging/                OutboxEventPublisher (implementa EventPublisher) + relay para o RabbitMQ
      gateways/<servico>/       adapter gRPC + ACL + corrente de fallback
  main/                         composition root: api.ts, worker.ts, migrate.ts
```

**Adapters de saída (outbound)**

| Porta (em `application/`) | Adapter (em `infra/adapters/outbound/`) | O que esconde |
|---|---|---|
| `EventPublisher` | `messaging/OutboxEventPublisher` | Grava o evento na tabela `outbox`, na transação do caso de uso. Quem fala com o RabbitMQ é o **relay**, que é infraestrutura interna do adapter. |
| `TransactionRunner` | `persistence/KyselyTransactionRunner` | Abre a transação (`db.transaction()`) e a guarda num `AsyncLocalStorage`, de onde o Repository e o `EventPublisher` a pegam. Sem isso, estado e evento não seriam atômicos. |
| `<X>Repository`, `<X>Dao` | `persistence/Kysely<X>Repository`, `persistence/Kysely<X>Dao` | Consulta tipada com Kysely e mapeamento linha ↔ agregado / `<X>View`. |
| `<X>Gateway` | `gateways/<x>/Grpc<X>Gateway` + `<X>Acl` | Transporte, deadline, retry e tradução do modelo externo. |
| `Clock`, `IdGenerator` | `SystemClock`, `UuidV7Generator` | Relógio e geração de id. |

**Adapters de entrada (inbound)**

| Adapter | Responsabilidade | O que **não** faz |
|---|---|---|
| Controller REST / handler gRPC | Valida o schema de entrada, monta o `<UseCase>Input`, chama o caso de uso, traduz erro de domínio em status | Regra de negócio |
| Consumer de mensageria | Valida o envelope no schema do contrato, checa a inbox, traduz o payload (ACL de entrada) para o `<UseCase>Input`, classifica o erro (rejeição × transitório × permanente) para ack / retry / DLQ | Conhecer o agregado; decidir regra |
| Job agendado | Dispara o caso de uso no intervalo configurado | — |

Regras:
1. **Um caso de uso não sabe por qual adapter foi chamado.** O mesmo `ReserveFunds` poderia ser chamado por HTTP ou por fila sem mudar uma linha.
2. **A ACL também existe na entrada:** o evento de outro contexto é traduzido pelo consumer antes de chegar ao caso de uso. Payload externo nunca entra em `application/`.
3. **A corrente de fallback é um adapter composto** que implementa a mesma porta do gateway. O caso de uso vê uma porta só (`WalletGateway`), não a corrente.
4. **`libs/` fornece a base técnica dos adapters** (consumer com retry/DLQ, relay do outbox, cliente gRPC com deadline e retry, `FallbackHandler`). Cada serviço escreve só a parte específica: o mapeamento e a ACL.
5. **Teste:** caso de uso com fakes das portas (unidade); adapter contra a tecnologia real (integração).

### Quando criar uma porta (interface)

Porta tem custo. Crie **só** quando houver pelo menos um destes motivos:

| Motivo | Exemplo |
|---|---|
| Fronteira com outro sistema | `EventPublisher`, `WalletGateway`, `AccountGateway` |
| Atomicidade entre adapters de saída | `TransactionRunner` (Repository + outbox na mesma transação) |
| Persistência de **agregado** (Repository) ou **leitura/relatório** (DAO) | `WalletRepository`, `OrderRepository` · `OrderDao`, `DepthDao` |
| Tempo / id / aleatoriedade que o teste precisa controlar | `Clock`, `IdGenerator` |

### Repository × DAO

Escrita e leitura usam objetos de acesso a dados **diferentes**, de propósito (CQRS-lite):

| | **Repository** | **DAO** |
|---|---|---|
| Para quê | Mutar e recuperar **estado de domínio** | **Relatórios** e consultas de leitura |
| Devolve | **Agregado** (`Wallet`, `Order`, `OrderBook`) | **Modelo de leitura `<X>View`** (plano, pronto para a resposta) |
| Recebe | Agregado para salvar | Filtros (`accountId`, `status`, `marketId`, período…) |
| Quem usa | Casos de uso de **comando** (`Deposit`, `PlaceOrder`…) e handlers de evento | Casos de uso de **consulta** (`GetOrders`, `GetDepth`, `GetTrades`, `GetMarket`…) |
| Métodos típicos | `findById`, `save` — só o que o agregado precisa | Quantos forem úteis: `listByAccount`, `aggregateByPrice`, `statsBetween`… |
| SQL | Simples, por chave; respeita a fronteira do agregado | Livre: `JOIN`, `GROUP BY`, agregações, paginação |
| Concorrência | Controle otimista (`version`) ou lock | Sem lock, só leitura |

Regras:
1. **Repository nunca devolve `<X>View`; DAO nunca devolve entidade.** Se a tela precisa de um formato, é DAO.
2. **Caso de uso de comando não usa DAO** para decidir regra. Decisão de negócio parte do agregado carregado pelo Repository.
3. **DAO não escreve.** Projeções (como em `market-data`) são gravadas pelo handler do evento através de um **projection writer** na `infra`, não pelo DAO.
4. Ambos têm **interface em `application/`** (`application/repositories/`, `application/daos/`) e implementação em `infra/adapters/outbound/persistence/`. Assim o caso de uso é testável com fake, e a implementação real é coberta por teste de integração com Postgres.
5. **Repositório genérico (`BaseRepository<T>`) é proibido.** Cada repositório expõe só o que o agregado precisa.

### CQRS e tabelas de projeção

Objetivo: **toda leitura pública responde com uma consulta local, indexada, sem `JOIN` pesado e sem chamada a outro serviço.** O lado de escrita fica normalizado e protegido pelo agregado; o lado de leitura fica desnormalizado, no formato da resposta.

| | Tabelas de escrita | Tabelas de projeção (`*_view`) |
|---|---|---|
| Quem escreve | Repository (via agregado) | **Projection writer** |
| Quem lê | Repository | **DAO** |
| Forma | Normalizada, fronteira do agregado | Desnormalizada, uma linha ≈ um item da resposta, índices pela consulta |
| Consistência | Forte | Ver tipos abaixo |

Dois tipos de projeção:

| Tipo | Quando | Como | Consistência |
|---|---|---|---|
| **Síncrona (mesma transação)** | O dado é do **próprio** serviço | O caso de uso salva o agregado e atualiza a `*_view` na mesma transação | Forte, sem atraso |
| **Assíncrona (por evento)** | O dado vem de **outro** serviço | Consumidor do evento atualiza a `*_view` local | Eventual (normalmente milissegundos) |

Regras:
1. **Projeção é descartável.** Tem de ser possível recriá-la do zero (replay do write model ou dos eventos). Nunca é fonte da verdade.
2. **Projeção assíncrona é idempotente e tolerante a desordem:** guarda a `version`/`sequence` do evento de origem e ignora atualização mais antiga (*last-write-wins* por versão).
3. **Projeção assíncrona substitui HTTP síncrono** sempre que um pouco de atraso for aceitável. O Gateway + ACL fica como **fallback** para quando a projeção ainda não existe (ex.: conta recém-criada).
4. **Pré-calcule o que é caro.** Agregação feita a cada request (depth por precisão, estatística por período) vira tabela pré-agregada atualizada na escrita.
5. A resposta que vem de projeção assíncrona pode informar `asOf` (momento da última atualização) quando isso importar para o cliente.

---

## 2. DDD tático — a balança entre comportamento e estrutura

O modelo é **rico onde há invariante** e **simples onde não há**. Rico demais em CRUD vira cerimônia; anêmico demais onde há regra vira bug espalhado.

| Serviço | Estilo | Onde mora a regra |
|---|---|---|
| `matching` | Modelo rico | `OrderBook.place(entry)` devolve trades. Toda a regra de preço-tempo é pura e testável. |
| `wallet` | Modelo rico | `Wallet.reserve/settle/release/withdraw` protegem `available ≥ 0` e `reserved = Σ reservas`. |
| `order` | Modelo rico | `Order` é uma máquina de estados; transição inválida lança erro de domínio. |
| `account` | Modelo leve | Entidade `Account` + VOs (`FullName`, `Email`, `Cpf`, `Password`). Unicidade de e-mail é regra de aplicação + constraint no banco. |
| `market-data` | Sem domínio | Projeções (projection writers) + DAOs + funções puras (agregação por precisão). |

Regras:
1. **Agregado é fronteira de consistência:** uma transação altera **um** agregado. Mais de um → evento.
2. **Value Objects para tudo que tem regra ou unidade:** `Quantity`, `Price`, `Money`, `AssetId`, `MarketId`, `Side`. Nada de `number` solto no domínio.
3. **Dinheiro e quantidade nunca em `float`.** Usar biblioteca decimal (ex.: `decimal.js`) no domínio e `numeric(36,8)` no Postgres, escala interna 8 para todos os ativos. **Não arredondar, validar:** preço e quantidade fora dos filtros do mercado (tick, step, valor mínimo, em `contracts/markets.json`) são rejeitados. Assim toda conta é exata (ver [Q11](99-decisoes.md#q11)).
4. **Erros de domínio são classes** (`InsufficientFundsError`, `InvalidOrderTransitionError`), não `new Error('string')`. A `infra` traduz para HTTP status / evento de rejeição.
5. **Rejeição de negócio não é exceção de infraestrutura.** "Saldo insuficiente" num consumidor vira evento (`wallet.fundsReservationRejected`), não retry.
6. **Domain events** são emitidos pelo agregado e gravados no **outbox** na mesma transação ([mensageria](03-mensageria.md#5-outbox-e-inbox)).
7. **Um caso de uso nunca chama outro.** A comunicação entre casos de uso é por evento (§2.1).

### 2.1 Eventos entre casos de uso (event-driven interno)

Event-driven não vale só entre serviços: vale **dentro** do serviço. Se o caso de uso A importasse o caso de uso B, mudar B quebraria A, e os dois teriam de rodar sempre juntos. Com evento, A só anuncia o fato; quem reage é registrado no composition root, e A não sabe quem é.

**Dois tipos de evento**

| | Evento de domínio | Evento de integração |
|---|---|---|
| Nome | Classe no passado: `OrderAccepted`, `FundsReserved` | Tipo do contrato: `order.accepted`, `wallet.fundsReserved` |
| Onde vive | `domain/events.ts` do serviço | `backend/contracts/events/` (Published Language) |
| Conteúdo | Pode carregar VOs e detalhes internos | Só primitivos e strings decimais, versionado |
| Alcance | **Só dentro do serviço** | Outros serviços (e o próprio serviço, quando a reação é em outra transação) |
| Quem converte | — | `IntegrationEventMapper`, adapter de saída da mensageria |

Evento de domínio **nunca sai cru** do serviço.

**Como a reação acontece**

```
caso de uso ── agregado.pullEvents() ──► DomainEventDispatcher (porta, em processo)
                                              │
              ┌───────────────────────────────┴───────────────────────────────┐
     reação na MESMA transação                                     reação em OUTRA transação
     (handler transacional)                                        (outro agregado / outro caso de uso)
              │                                                               │
   • projection writer síncrono (ex.: OrderViewProjector)          IntegrationEventMapper → outbox
   • IntegrationEventMapper → outbox                                 → RabbitMQ → consumer (adapter de entrada)
   falhou = rollback de tudo                                         → caso de uso B, com inbox, retry e DLQ
```

| Situação | Mecanismo | Por quê |
|---|---|---|
| A reação precisa ser **atômica** com o caso de uso (projeção síncrona, gravar no outbox) | **Handler transacional**, chamado pelo `DomainEventDispatcher` dentro do `TransactionRunner`, antes do `commit` | Ou tudo acontece, ou nada |
| A reação **altera outro agregado** ou **dispara outro caso de uso** | **Outbox → RabbitMQ → consumer**, mesmo que o consumidor seja o próprio serviço | Uma transação = um agregado (§2, regra 1). Ganha durabilidade, idempotência (inbox) e retry/DLQ de graça |

Regras:
1. **Handler transacional não chama caso de uso.** Ele é um adapter (projeção, mapeamento para o outbox), não orquestra regra.
2. **Não existe evento em memória depois do `commit`.** Se o processo cair entre o `commit` e o handler, a reação se perderia. Toda reação fora da transação passa pelo outbox.
3. **Um adapter de entrada pode chamar o mesmo caso de uso mais de uma vez** (ex.: um trade gera um `ApplyFill` para a ordem de compra e outro para a de venda). Isso é o adapter traduzindo uma mensagem em vários comandos, não um caso de uso chamando outro.
4. **Agregado acumula eventos** (`recordEvent`) e o caso de uso os entrega com `pullEvents()` ao dispatcher. Nenhum agregado conhece o dispatcher.
5. **Portas:** `DomainEventDispatcher` (em `application/`); implementação `InProcessDomainEventDispatcher` (na `infra`), com os handlers registrados no composition root.

---

## 3. Clean Code

- **Nomes na linguagem ubíqua** do contexto ([design estratégico §3](02-design-estrategico.md#3-linguagem-ub%C3%ADqua-por-contexto)). **Código e comentários em inglês**, docs em português.
- **Funções pequenas, um nível de abstração.** Caso de uso lê como o enunciado: valida → carrega → executa regra → persiste → publica.
- **Sem `any`.** `strict: true` no TypeScript. Entrada externa é `unknown` até ser validada (schema na borda).
- **Comentário só em último caso, e em inglês.** Antes de comentar, tente renomear, extrair uma função ou criar um VO até o código se explicar. Comentário só sobrevive para explicar um **porquê** que o código não consegue expressar (uma regra externa, um trade-off, uma limitação de biblioteca). Nunca para dizer **o quê** o código faz, e nunca código comentado.
- **Sem abstração especulativa.** Duas ocorrências: tolerável. Três: extraia.
- **Imutabilidade por padrão** em VOs, `Input`, `Output` e `View` (`readonly`).
- **Injeção de dependência pelo construtor**, montada no composition root (`infra/main/`). Sem container de DI mágico.

### 3.1 Object Calisthenics (pragmático)

As 9 regras do Object Calisthenics, com o rigor ajustado por camada. **No `domain/` são obrigatórias**; em `application/` também, salvo as marcadas; na `infra/` valem como orientação, porque adapter lida com formatos externos.

| # | Regra | Como aplicamos | Rigor |
|---|---|---|---|
| 1 | **Um nível de indentação por método** | Laço com `if` dentro vira método extraído (ex.: `OrderBook.place` chama `matchAgainst(maker)`) | Obrigatória |
| 2 | **Não usar `else`** | **Early return** e guard clauses. Variação de comportamento por tipo vira polimorfismo ou mapa, não cadeia de `if/else` | Obrigatória |
| 3 | **Encapsular primitivos** | VOs: `Quantity`, `Price`, `MarketId`, `AssetId`, `Email`, `Cpf`… Nenhum `string`/`number` solto no domínio | Obrigatória no domínio |
| 4 | **Coleções de primeira classe** | Coleção com regra vira classe: `Bids`/`Asks` (ordenação preço-tempo), `Balances`, `Reservations` | Obrigatória no domínio |
| 5 | **Um ponto por linha** (Lei de Demeter) | Peça ao objeto, não navegue nele: `wallet.reserve(...)`, nunca `wallet.balances.get(asset).available.minus(...)`. Encadeamento de *builders* e de `decimal.js` é exceção | Obrigatória |
| 6 | **Não abreviar** | `quantity`, não `qty`; `accountId`, não `accId`. (As specs usam `qty` em pseudocódigo; o código não.) | Obrigatória |
| 7 | **Entidades pequenas** | Referência: método ≤ 15 linhas, classe ≤ 150 linhas, arquivo com uma responsabilidade. Passou disso, extraia | Orientação |
| 8 | **Poucas variáveis de instância** | Agrupe estado relacionado em VOs (`Fill` com `quantity` + `value`, em vez de dois campos soltos). Não há limite rígido de 2: agregados precisam de mais | Orientação |
| 9 | **Sem getters/setters** | *Tell, don't ask*: o domínio expõe comportamentos (`order.applyFill`), não setters. Leitura só por acessores `readonly` usados pelo mapeamento (Repository, Output), e **nunca** para decidir regra fora do agregado | Obrigatória no domínio |

```ts
// ✗ else + nested indentation
applyFill(fill: Fill) {
  if (this.isReserved()) {
    if (this.fill.plus(fill).exceeds(this.quantity)) throw new FillExceedsQuantityError();
    else this.fill = this.fill.plus(fill);
  } else throw new InvalidOrderTransitionError();
}

// ✓ guard clauses, one level, no else
applyFill(fill: Fill): void {
  if (!this.isReserved()) throw new InvalidOrderTransitionError();
  const nextFill = this.fill.plus(fill);
  if (nextFill.exceeds(this.quantity)) throw new FillExceedsQuantityError();
  this.fill = nextFill;
  this.recordEvent(new OrderFilled(this.id, fill));
}
```

Verificação automática no lint: `max-depth: 1` e `no-else-return` no `domain/` e em `application/`; `id-length` com lista de exceções; `max-lines-per-function` como aviso.

### 3.2 Convenções de nomes

**camelCase é a regra.** As exceções existem só onde a tecnologia exige outra coisa.

| Item | Convenção | Exemplo |
|---|---|---|
| Variáveis, funções, métodos, campos, propriedades | camelCase | `fillQuantity`, `remainingQuantity`, `pullEvents()` |
| Arquivos | camelCase | `placeOrder.ts`, `placeOrderInput.ts` |
| Tipos, classes, interfaces | PascalCase (convenção do TypeScript para tipos) | `PlaceOrder`, `OrderRepository` |
| **Entrada de caso de uso** | `<CasoDeUso>Input` | `PlaceOrderInput` |
| **Saída de caso de uso** | `<CasoDeUso>Output` (sem retorno: `type DepositOutput = void`) | `PlaceOrderOutput` |
| **Variáveis com entrada e saída** | terminam em `Input` / `Output` | fora do caso de uso: `placeOrderInput`, `placeOrderOutput` · dentro: `input`, `output` |
| Modelo de leitura do DAO | `<X>View` | `OrderView`, `DepthLevelView` |
| Campos JSON (REST, eventos, gRPC via ts-proto) | camelCase | `{ "orderId": …, "fillPrice": … }` |
| Tipo de evento de integração | `<contexto>.<fatoEmCamelCase>` | `matching.tradeExecuted`, `wallet.fundsReserved` |
| Fila | `<consumidor>.<assuntoEmCamelCase>` | `wallet.orderPlaced`, `marketData.trades` |
| Valores de status | camelCase | `partiallyFilled`, `cancelling` |

| Exceção | Convenção | Motivo |
|---|---|---|
| Tabelas e colunas do Postgres | snake_case | O Postgres converte identificador sem aspas para minúsculo; camelCase exigiria aspas em todo SQL. O adapter de persistência faz o mapeamento. |
| Códigos de motivo e constantes | UPPER_SNAKE | `INSUFFICIENT_FUNDS`, `SELF_TRADE_PREVENTION`: são constantes, não identificadores |
| Rotas REST do objetivo | como no objetivo | `/place_order`, `/cancel_order` já estão definidas |
| Diretórios de serviço, containers, nomes DNS | kebab-case | `market-data`, `wallet-db`: nomes de host |
| Variáveis de ambiente | UPPER_SNAKE | Convenção de shell |
| Campos no `.proto` | snake_case | Guia de estilo do protobuf; o `ts-proto` gera camelCase no código |

### 3.3 Anatomia de um caso de uso

Um caso de uso é **um caso específico**: tem exatamente uma entrada e uma saída.

```
application/usecases/placeOrder/
  placeOrder.ts         ← classe PlaceOrder implements UseCase<PlaceOrderInput, PlaceOrderOutput>
  placeOrderInput.ts
  placeOrderOutput.ts
```

```ts
export interface UseCase<TInput, TOutput> {
  execute(input: TInput): Promise<TOutput>;
}

export class PlaceOrder implements UseCase<PlaceOrderInput, PlaceOrderOutput> {
  constructor(
    private readonly orderRepository: OrderRepository,
    private readonly marketCatalog: MarketCatalog,
    private readonly transactionRunner: TransactionRunner,
    private readonly domainEventDispatcher: DomainEventDispatcher,
    private readonly idGenerator: IdGenerator,
    private readonly clock: Clock,
  ) {}

  async execute(input: PlaceOrderInput): Promise<PlaceOrderOutput> {
    const market = this.marketCatalog.get(MarketId.from(input.marketId));
    const order = Order.place({ id: this.idGenerator.next(), market, ...input, now: this.clock.now() });

    await this.transactionRunner.run(async () => {
      await this.orderRepository.save(order);
      await this.domainEventDispatcher.dispatch(order.pullEvents());
    });

    const output: PlaceOrderOutput = { orderId: order.id.value, status: order.status };
    return output;
  }
}

// inbound adapter (REST controller)
const placeOrderInput: PlaceOrderInput = parsePlaceOrderBody(request.body);
const placeOrderOutput = await placeOrder.execute(placeOrderInput);
reply.status(202).send(placeOrderOutput);
```

- O caso de uso **não conhece** o RabbitMQ, a `order_view` nem quem vai reagir ao `OrderPlaced`. Ele só despacha os eventos de domínio (§2.1).
- Caso de uso de consulta segue o mesmo formato: `GetOrdersInput` → DAO → `GetOrdersOutput` (montado a partir de `OrderView[]`).

---

## 4. Integração síncrona (Gateway + ACL)

HTTP entre serviços é **exceção**. A primeira opção para ler dado de outro contexto é sempre uma **projeção local** (ver [CQRS e tabelas de projeção](#cqrs-e-tabelas-de-proje%C3%A7%C3%A3o)). HTTP entra só como **fallback**, quando a projeção ainda não tem o dado. Hoje existem dois casos, ambos de fallback: `account → wallet` (saldos de conta recém-criada no `GetAccount`) e `wallet → account` ("a conta existe?" antes de o evento `account.created` chegar).

Estrutura obrigatória:

```
application/ports/walletGateway.ts                            ← porta: fala a língua do MEU contexto
infra/adapters/outbound/gateways/wallet/grpcWalletGateway.ts  ← adapter: gRPC, deadline, retry
infra/adapters/outbound/gateways/wallet/walletAcl.ts          ← ACL: traduz o modelo DELES → o MEU
```

- **Gateway** é o **adapter de saída** que implementa a porta: encapsula o transporte (endereço, metadata, deadline, retry, circuit).
- **ACL (Anti-Corruption Layer)** traduz o payload externo para tipos do meu contexto e **rejeita** resposta fora do contrato. Nada do modelo externo atravessa a porta.
- A porta devolve tipos do meu domínio/aplicação, nunca o JSON nem a mensagem protobuf externa.

### 4.1 REST ou gRPC

| Use **REST (HTTP/JSON)** quando… | Use **gRPC (HTTP/2 + protobuf)** quando… |
|---|---|
| O cliente é **externo** à plataforma (front, parceiro, `curl`) | A chamada é **interna**, de serviço para serviço |
| Passa pelo **edge proxy** | Não sai da rede Docker interna |
| Legibilidade e facilidade de depurar importam mais que performance | **Latência** e tamanho de payload importam |
| Pode haver cache HTTP / CDN | O contrato precisa ser **estritamente tipado** e gerado (sem drift) |
| Endpoints do [objective.md](objective.md) | Fallbacks do Gateway + ACL (`AccountExists`, `GetBalances`) |

Decisão para esta plataforma:
- **API pública: REST.** Exatamente os endpoints do objetivo, roteados pelo edge proxy.
- **Síncrono interno: gRPC.** Os `.proto` ficam em `backend/contracts/proto/` (Published Language, como os eventos). O código é gerado (`ts-proto`) **uma vez**, no pacote `backend/contracts/generated/`, e cliente e servidor importam o mesmo código: os dois lados nunca divergem. Só os adapters da `infra` importam esse pacote; a ACL traduz a mensagem gerada para os tipos do meu contexto.
- **Assíncrono: RabbitMQ** (ver [mensageria](03-mensageria.md)). gRPC não substitui evento: se o chamador não precisa da resposta na hora, é evento.
- **Health check e métricas: HTTP simples** (`/health`, `/metrics`), porque é o que o Docker e as ferramentas de observabilidade esperam.
- **Fora do escopo:** gRPC no browser (gRPC-Web) e streaming. Se surgir depth em tempo real para o front, o caminho é WebSocket/SSE no `market-data`, não gRPC.

Regras de gRPC:
- **mTLS sempre**, com allowlist de métodos por serviço chamador. Chamador fora da lista → `PERMISSION_DENIED` (erro permanente, sem retry). Ver [autenticação entre serviços §2](08-autenticacao-entre-servicos.md#2-grpc-interno-mtls--allowlist).
- **Deadline sempre** (padrão 500 ms), propagado na chamada.
- Retry só para `UNAVAILABLE`, `DEADLINE_EXCEEDED` e `RESOURCE_EXHAUSTED`, com o mesmo backoff + jitter do §5.2. Nunca para `INVALID_ARGUMENT`, `NOT_FOUND`, `FAILED_PRECONDITION`, `PERMISSION_DENIED`, `UNAUTHENTICATED`.
- `NOT_FOUND` é resposta válida (ex.: conta não existe), não falha: a ACL traduz para o tipo do meu contexto.
- Cada serviço que expõe gRPC escuta numa porta própria, separada do REST.

---

## 5. Resiliência

### 5.1 Timeouts
Toda chamada de rede tem timeout explícito. Padrão para chamada interna (deadline gRPC): **500 ms**. Sem timeout = sem merge.

### 5.2 Retry com backoff exponencial + jitter
- **Só para falha transitória**: timeout, conexão recusada, HTTP 502/503/504, gRPC `UNAVAILABLE`/`DEADLINE_EXCEEDED`, erro de conexão com Postgres/RabbitMQ.
- **Nunca** para 4xx, erro de validação ou rejeição de negócio.
- Fórmula (full jitter): `delay = random(0, min(cap, base × 2^attempt))`. Padrão gRPC interno: `base=100ms`, `cap=2s`, `maxAttempts=3`.
- Mensageria usa retry por filas com atraso; ver [mensageria §4](03-mensageria.md#4-retry-backoff-e-dlq).
- **Só é seguro repetir operação idempotente.** Toda escrita disparada por mensagem é idempotente via inbox.

### 5.3 Fallback com Chain of Responsibility
Quando há mais de uma forma de obter um resultado, os elos formam uma corrente: cada elo tenta, e se falhar repassa ao próximo. A base fica em `libs/resilience`.

```ts
abstract class FallbackHandler<I, O> {
  constructor(private readonly next?: FallbackHandler<I, O>) {}
  protected abstract tryHandle(input: I): Promise<O>;
  async handle(input: I): Promise<O> {
    try { return await this.tryHandle(input); }
    catch (e) { if (!this.next) throw e; return this.next.handle(input); }
  }
}
```

Uso previsto:

| Onde | Corrente |
|---|---|
| `wallet`: "a conta existe?" | `LocalWalletLookup` → `AccountGrpcGateway` → rejeita (se existir, o caso de uso abre a carteira com `Wallet.open`) |
| `account`: saldos do `GetAccount` | `BalanceProjectionLookup` (local) → `WalletGrpcGateway` (com retry) → `DegradedBalances` (sem saldos + aviso) |

O último elo é sempre **explícito**: ou degrada com aviso, ou falha com erro claro. Nunca engolir erro silenciosamente.

### 5.4 Idempotência
- Consumidores: tabela **inbox** (`consumer` + `message_key`, ver [mensageria §5](03-mensageria.md#inbox-consumidor)) na mesma transação do efeito.
- **Todo POST público** aceita o header `Idempotency-Key`, com o comportamento da Stripe: a primeira resposta (status + corpo) é guardada por pelo menos 24 h e devolvida igual nas repetições; a mesma chave com outro corpo → `422`. Implementado uma vez em `libs/http` (ver [Q13](99-decisoes.md#q13)).

### 5.5 Circuit breaker
Fora do MVP. Os gateways nascem com uma interface que permite adicionar depois sem mexer nos casos de uso.

### 5.6 Rate limiting
Toda a API pública tem limite **por tipo de uso**, em duas camadas: no edge (por IP) e no serviço (por conta e por IP, com Redis). Autenticação tem os limites mais apertados, contra brute force. O limitador é a porta `RateLimiter`, com a corrente de fallback Redis → memória. Detalhes em [07-rate-limiting.md](07-rate-limiting.md).

### 5.7 Graceful shutdown
Ao receber `SIGTERM`: parar de consumir, terminar a mensagem em andamento, dar `ack`, fechar conexões. Mensagem sem `ack` volta para a fila.

---

## 6. Código compartilhado

Monorepo com **npm workspaces**, com raiz em `backend/package.json` (a raiz do repositório não tem código). Cada serviço continua sendo implantável sozinho.

```
backend/
  contracts/   ← Published Language, versionada: JSON Schemas dos eventos (events/) e .proto do gRPC interno (proto/), e markets.json (catálogo de mercados com filtros)
  libs/
    messaging/   ← envelope, publisher com confirms, consumer com retry/DLQ, outbox relay, inbox
    resilience/  ← retry com backoff+jitter, FallbackHandler, timeout
    http/        ← plugins de Idempotency-Key e rate limit, tradução de erro de domínio → status HTTP
    security/    ← credenciais mTLS do gRPC, interceptor de allowlist, leitura de segredos *_FILE, verificação do JWT interno (futuro)
    testing/     ← banco/broker/Redis efêmeros por worker, CA efêmera para mTLS, fakes de serviço (startFakeGrpcServer, startFakeHttpServer), fixtures dos contratos
```

- `libs/` é **só técnico**. Se aparecer regra de negócio, está no lugar errado.
- **Domínio nunca é compartilhado.** `Quantity` de `wallet` e `Quantity` de `matching` podem ser parecidos e mesmo assim são classes separadas: cada contexto evolui sozinho.

---

## 7. Docker sempre

- **Tudo roda em container**: serviços, testes, migrações, banco e RabbitMQ. Nada depende de Postgres/RabbitMQ instalado na máquina.
- **Cada backend tem seu `docker-compose.yml`** com o próprio Postgres e os próprios processos.
- **RabbitMQ é único**, num compose de infraestrutura compartilhada, ligado aos serviços por uma rede Docker externa.
- Detalhes em [04-ambiente-docker.md](04-ambiente-docker.md).

---

## 8. Testes

Pirâmide: regra específica é testada no nível mais baixo possível. Detalhes em [05-estrategia-de-testes.md](05-estrategia-de-testes.md).

---

## 9. Stack

| Item | Escolha | Motivo |
|---|---|---|
| Linguagem | TypeScript (strict) **fixado em `~6.0.3`**, Node 26 | Um ecossistema só para serviços, libs e testes. A versão é fixada porque `typescript-eslint`, `dependency-cruiser` e `kysely-codegen` ainda exigem TypeScript < 6.1 |
| HTTP (API pública) | Fastify | Leve, schema de validação nativo |
| RPC interno | `@grpc/grpc-js` + `ts-proto` | Contrato tipado gerado a partir de `contracts/proto` |
| Acesso ao Postgres | **Kysely** (query builder tipado) sobre o driver `pg` | Não é ORM: o domínio não ganha decorators nem classes de entidade, e o Repository mapeia linha ↔ agregado à mão. Cobre o que a spec exige: `FOR UPDATE SKIP LOCKED` (relay do outbox), `ON CONFLICT` (projeções), transação explícita, `GROUP BY` e agregações tipadas nos DAOs, e `sql` para o que faltar (ex.: `pg_advisory_lock`) |
| Tipos do banco | `kysely-codegen`, gerado do banco já migrado e versionado em `infra/adapters/outbound/persistence/database.ts` | O tipo vem do schema real, não de uma cópia escrita à mão |
| `numeric` | Lido como **string** e convertido para `decimal.js` no mapeamento | Nunca passa por `number`: não perde casas |
| Migrações | Arquivos **SQL** versionados (`migrations/0001_*.sql`), aplicados em ordem pelo container `migrate` com o `Migrator` do Kysely (`kysely/migration`). Todas as migrações pendentes rodam **numa única transação**: ou todas entram, ou nenhuma. Por isso não se usa `CREATE INDEX CONCURRENTLY` | SQL legível e auditável; o Kysely só controla o que já foi aplicado |
| RabbitMQ | `amqplib` encapsulado em `libs/messaging` | |
| Decimal | `decimal.js` | Dinheiro sem erro de ponto flutuante |
| Testes | Vitest | Já usado no projeto |
| Validação de borda | JSON Schema (o mesmo de `contracts/`) | Uma fonte da verdade para contrato |
