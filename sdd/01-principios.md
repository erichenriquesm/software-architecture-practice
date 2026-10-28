# 01 — Princípios de Arquitetura

> Status: **spec** · Vale para todos os serviços em `backend/`.

Princípios são **regras com motivo**. Quando uma regra atrapalhar mais do que ajuda num caso concreto, quebre-a **registrando o porquê** na spec do serviço.

---

## 1. Clean Architecture pragmática

Cada serviço tem três camadas:

```
<servico>/
  src/
    domain/                ← regras de negócio. Zero dependência de framework, banco ou broker.
      entities/            agregados e entidades (Account, Wallet, Order, OrderBook)
      valueObjects/        Email, Cpf, Quantity, Price…
      events/              domain events: fatos no passado (AccountCreated, OrderAccepted…)
      services/            domain services: regra que envolve mais de uma entidade (só quando existir uma)
      errors.ts            erros de domínio
    application/           ← casos de uso: orquestram domínio + contratos.
      usecases/            um arquivo por caso de uso, com o Input/Output dele (signup.ts, getAccount.ts)
      contracts/           interfaces que a infra implementa (repositories, DAOs e suas Views, gateways, clock…)
      …                    o que mais for de aplicação (ex.: calculations/ no market-data)
    infra/                 ← tudo que fala com o mundo de fora. Implementa os contratos.
      http/                rotas REST (Fastify)
      grpc/                servidor gRPC + clientes de outros serviços (gateway, ACL, fallback)
      messaging/           consumers (um por fila), OutboxEventPublisher, relay do outbox
      database/            repositories, DAOs, projection writers, transaction runner, tipos do banco
      scheduler/           jobs agendados (só onde existir)
      platform/            base técnica: retry, inbox, rate limit, idempotência, token gRPC
      schemas/             JSON Schema dos eventos e .proto (published/ e consumed/), envelope, markets.json
      generated/           código gerado do .proto (não versionado)
      database/migrations/ migrações estilo Laravel: classes com up() e down() (§9)
      api.ts  worker.ts  migrate.ts   ← composition root
  test/
    unit/                  testes de unidade, espelhando src/
    integration/           testes de integração, espelhando src/
    fakes/                 um fake por contrato de application/contracts/
    support/               banco e broker efêmeros, fakes de rede, fixtures
```

Dentro de `domain/` as pastas não repetem o prefixo: o caminho já diz que são do domínio. O nome do tipo continua completo (`DomainEvent`), porque fora da pasta ele precisa se distinguir do evento de integração (`Envelope`).

**Pasta nasce com o primeiro arquivo.** Não existe pasta vazia "para quando precisar" (nem `.gitkeep`): quem abre o serviço só vê o que existe.

**README de cada serviço abre com "Comece por aqui":** o caminho de uma requisição (ou de um evento) de ponta a ponta, arquivo por arquivo, para quem chega ter o mapa antes de abrir as pastas.

`application/contracts/` são **interfaces TypeScript** (o que o caso de uso precisa); `infra/schemas/` são **formatos de transporte** (JSON Schema e `.proto`), que só a `infra` lê.

**Regra de dependência:** `infra → application → domain`. Nunca o contrário.
Verificação automática: teste de arquitetura (ex.: `dependency-cruiser`) roda no pipeline e falha se `domain` importar `application`/`infra`, ou `application` importar `infra`.

### Ports & Adapters dentro da `infra`

Toda conversa com o mundo externo passa por um **adapter**. O caso de uso só conhece **portas** (interfaces em `application/contracts/`) e nunca sabe se do outro lado há RabbitMQ, gRPC, HTTP ou Postgres.

Os adapters ficam em `infra/`, **agrupados por tecnologia** (`http/`, `grpc/`, `messaging/`, `database/`). A diferença entre adapter de entrada (mundo externo → caso de uso) e de saída (caso de uso → mundo externo) é conceitual e está nas tabelas abaixo; ela não vira pasta.

**Adapters de saída (outbound)**

| Porta (em `application/contracts/`) | Adapter (em `infra/`) | O que esconde |
|---|---|---|
| `EventPublisher` | `messaging/OutboxEventPublisher` | Converte cada evento de domínio no evento de integração (um `switch` pelo tipo) e grava na tabela `outbox`, na transação do caso de uso. Quem fala com o RabbitMQ é o **relay**, que é infraestrutura interna do adapter. |
| `TransactionRunner` | `database/KyselyTransactionRunner` | Abre a transação (`db.transaction()`) e a guarda num `AsyncLocalStorage`, de onde o Repository e o `EventPublisher` a pegam. Sem isso, estado e evento não seriam atômicos. |
| `<X>Repository`, `<X>Dao` | `database/Kysely<X>Repository`, `database/Kysely<X>Dao` | Consulta tipada com Kysely e mapeamento linha ↔ agregado / `<X>View`. |
| `<X>Gateway` | `grpc/<x>/Grpc<X>Gateway` + `<X>Acl` | Transporte, deadline, retry e tradução do modelo externo. |
| `Clock`, `IdGenerator` | `SystemClock`, `UuidV7Generator` | Relógio e geração de id. |

**Adapters de entrada (inbound)**

| Adapter | Responsabilidade | O que **não** faz |
|---|---|---|
| Controller REST / handler gRPC | Valida o schema de entrada, monta os parâmetros do caso de uso, chama o caso de uso, traduz erro de domínio em status | Regra de negócio |
| Consumer de mensageria | Valida o envelope no schema do contrato, checa a inbox, traduz o payload (ACL de entrada) para os parâmetros do caso de uso, classifica o erro (rejeição × transitório × permanente) para ack / retry / DLQ | Conhecer o agregado; decidir regra |
| Job agendado | Dispara o caso de uso no intervalo configurado | — |

Regras:
1. **Um caso de uso não sabe por qual adapter foi chamado.** O mesmo `ReserveFunds` poderia ser chamado por HTTP ou por fila sem mudar uma linha.
2. **A ACL também existe na entrada:** o evento de outro contexto é traduzido pelo consumer antes de chegar ao caso de uso. Payload externo nunca entra em `application/`.
3. **Fallback é código simples numa função só** (§5.3), sem classe de corrente. O caso de uso vê portas comuns (`WalletRepository`, `AccountGateway`).
4. **`src/infra/platform/` tem a base técnica dos adapters** (consumer com retry/DLQ, relay do outbox, cliente gRPC com deadline e retry), escrita à mão em cada serviço, só com o que aquele serviço usa (§6). Os adapters específicos (mapeamento e ACL) ficam nas pastas de cada tecnologia.
5. **Teste:** caso de uso com fakes das portas (unidade); adapter contra a tecnologia real (integração).

### Quando criar uma porta (interface)

Porta tem custo. Crie **só** quando houver pelo menos um destes motivos:

| Motivo | Exemplo |
|---|---|
| Fronteira com outro sistema | `EventPublisher`, `AccountGateway` |
| Atomicidade entre adapters de saída | `TransactionRunner` (Repository + outbox na mesma transação) |
| Persistência de **agregado** (Repository) ou **leitura/relatório** (DAO) | `WalletRepository`, `OrderRepository` · `OrderDao`, `DepthDao` |
| Tempo / id / aleatoriedade que o teste precisa controlar | `Clock`, `IdGenerator` |

Se **todo** quem usa a classe está na `infra/` (ex.: o store de idempotência, usado só pelo plugin HTTP), não há porta: a `infra` depende da classe concreta. Interface com uma implementação só e sem fake é cerimônia.

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
4. Ambos têm **interface em `application/contracts/`** e implementação em `infra/database/`. O `<X>View` que o DAO devolve fica no mesmo arquivo da porta do DAO (`orderDao.ts` exporta `OrderView`). Assim o caso de uso é testável com fake, e a implementação real é coberta por teste de integração com Postgres.
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
| **Síncrona (mesma transação)** | O dado é do **próprio** serviço e a tabela de escrita não serve à leitura | O caso de uso salva o agregado e atualiza a `*_view` na mesma transação. Se a tabela de escrita já serve (como a `order`), o DAO lê dela e não há `*_view` | Forte, sem atraso |
| **Assíncrona (por evento)** | O dado vem de **outro** serviço | Consumidor do evento atualiza a `*_view` local | Eventual (normalmente milissegundos) |

Regras:
1. **Projeção é descartável.** Tem de ser possível recriá-la do zero (replay do write model ou dos eventos). Nunca é fonte da verdade.
2. **Projeção assíncrona é idempotente e tolerante a desordem:** guarda a `version`/`sequence` do evento de origem e ignora atualização mais antiga (*last-write-wins* por versão).
3. **Projeção assíncrona substitui HTTP síncrono** sempre que um pouco de atraso for aceitável. O Gateway + ACL só entra como **fallback** quando a falta do dado bloqueia um comando (hoje, só o `wallet` perguntando ao `account` se a conta existe). Leitura sem dado na projeção responde vazio.
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
3. **Dinheiro e quantidade nunca em `float`.** Usar biblioteca decimal (ex.: `decimal.js`) no domínio e `numeric(36,8)` no Postgres, escala interna 8 para todos os ativos. **Não arredondar, validar:** preço e quantidade fora dos filtros do mercado (tick, step, valor mínimo, em `infra/schemas/markets.json`, lidos pela porta `MarketCatalog`) são rejeitados. Assim toda conta é exata (ver [Q11](99-decisoes.md#q11)).
4. **Erros de domínio são classes** (`InsufficientFundsError`, `InvalidOrderTransitionError`), não `new Error('string')`. A `infra` traduz para HTTP status / evento de rejeição.
5. **Rejeição de negócio não é exceção de infraestrutura.** "Saldo insuficiente" num consumidor vira evento (`wallet.fundsReservationRejected`), não retry.
6. **Domain events** são emitidos pelo agregado e gravados no **outbox** pelo `EventPublisher`, na mesma transação ([mensageria](03-mensageria.md#5-outbox-e-inbox)).
7. **Um caso de uso nunca chama outro.** A comunicação entre casos de uso é por evento (§2.1).

### 2.1 Eventos entre casos de uso (event-driven interno)

Event-driven não vale só entre serviços: vale **dentro** do serviço. Se o caso de uso A importasse o caso de uso B, mudar B quebraria A, e os dois teriam de rodar sempre juntos. Com evento, A só anuncia o fato e não sabe quem reage.

**Dois tipos de evento**

| | Evento de domínio | Evento de integração |
|---|---|---|
| Nome | Classe no passado: `OrderAccepted`, `FundsReserved` | Tipo do contrato: `order.accepted`, `wallet.fundsReserved` |
| Onde vive | `domain/events/` do serviço | `infra/schemas/published/events/` do serviço produtor; cópias em `infra/schemas/consumed/` dos consumidores (Published Language, §6) |
| Conteúdo | Pode carregar VOs e detalhes internos | Só primitivos e strings decimais, versionado |
| Alcance | **Só dentro do serviço** | Outros serviços (e o próprio serviço, quando a reação é em outra transação) |
| Quem converte | — | `OutboxEventPublisher`, adapter de saída da mensageria |

Evento de domínio **nunca sai cru** do serviço.

Regras:
1. **O agregado acumula eventos** (`recordEvent`) e não conhece quem publica.
2. **O caso de uso entrega os eventos ao `EventPublisher` dentro da transação:** `await this.eventPublisher.publish(order.pullEvents())`. O `OutboxEventPublisher` converte cada um no evento de integração e grava no outbox. Falhou = rollback de tudo.
3. **Reação em outro agregado (ou outro caso de uso) passa pelo outbox:** outbox → RabbitMQ → consumer → caso de uso B, com inbox, retry e DLQ, mesmo que o consumidor seja o próprio serviço. Uma transação = um agregado (§2, regra 1).
4. **Não existe evento em memória depois do `commit`.** Se o processo cair entre o `commit` e a reação, ela se perderia.
5. **Um adapter de entrada pode chamar o mesmo caso de uso mais de uma vez** (ex.: um trade gera um `ApplyFill` para a ordem de compra e outro para a de venda). Isso é o adapter traduzindo uma mensagem em vários comandos, não um caso de uso chamando outro.

---

## 3. Clean Code

- **Nomes na linguagem ubíqua** do contexto ([design estratégico §3](02-design-estrategico.md#3-linguagem-ub%C3%ADqua-por-contexto)). **Código e comentários em inglês**, docs em português.
- **Funções pequenas, um nível de abstração.** Caso de uso lê como o enunciado: valida → carrega → executa regra → persiste → publica.
- **Sem `any`.** `strict: true` no TypeScript. Entrada externa é `unknown` até ser validada (schema na borda).
- **Comentário só em último caso, e em inglês.** Antes de comentar, tente renomear, extrair uma função ou criar um VO até o código se explicar. Comentário só sobrevive para explicar um **porquê** que o código não consegue expressar (uma regra externa, um trade-off, uma limitação de biblioteca). Nunca para dizer **o quê** o código faz, e nunca código comentado.
- **Sem abstração especulativa.** Duas ocorrências: tolerável. Três: extraia.
- **Imutabilidade por padrão** em VOs, `Input`, `Output` e `View` (`readonly`).
- **Injeção de dependência pelo construtor**, montada no composition root (`infra/api.ts`, `infra/worker.ts`). Sem container de DI mágico.

### 3.1 Estilo de código

- **Guard clauses, sem `else`.** Retorne cedo; variação por tipo vira mapa ou polimorfismo, não cadeia de `if/else`.
- **VO para primitivo de domínio com regra:** `Quantity`, `Price`, `MarketId`, `AssetId`, `Email`, `Cpf`…
- **Não abreviar:** `quantity`, não `qty`; `accountId`, não `accId`. (As specs usam `qty` em pseudocódigo; o código não.)
- **Tell, don't ask no domínio:** o agregado expõe comportamento (`order.applyFill`, `wallet.reserve`), não setters. Ninguém decide regra lendo o estado de fora.

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

Verificação automática no lint: `max-depth: 3`, `no-else-return` e `id-length` com lista de exceções.

### 3.2 Convenções de nomes

**camelCase é a regra.** As exceções existem só onde a tecnologia exige outra coisa.

| Item | Convenção | Exemplo |
|---|---|---|
| Variáveis, funções, métodos, campos, propriedades | camelCase | `fillQuantity`, `remainingQuantity`, `pullEvents()` |
| Arquivos | camelCase | `placeOrder.ts`, `orderDao.ts` |
| Tipos, classes, interfaces | PascalCase (convenção do TypeScript para tipos) | `PlaceOrder`, `OrderRepository` |
| **Entrada de caso de uso** | Até 2 valores: parâmetros diretos (`execute(accountId)`). **3 ou mais: objeto** `<CasoDeUso>Input`, no arquivo do caso de uso | `PlaceOrderInput` |
| **Saída de caso de uso** | Até 2 valores: retorno direto (`Promise<string>`, `Promise<boolean>`, `Promise<void>`). **3 ou mais: objeto** `<CasoDeUso>Output`, no arquivo do caso de uso | `GetAccountOutput` |
| **Alias de Input/Output** | Proibido (`type XInput = Y`). Se o caso de uso recebe um tipo que já existe, usa esse tipo | `execute(change: BalanceChange)` |
| **Variáveis com entrada e saída** | terminam em `Input` / `Output` | fora do caso de uso: `placeOrderInput`, `placeOrderOutput` · dentro: `input`, `output` |
| Modelo de leitura do DAO | `<X>View`, no arquivo da porta do DAO | `OrderView`, `DepthLevelView` |
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
application/
  usecases/placeOrder.ts    ← classe PlaceOrder + PlaceOrderInput e PlaceOrderOutput
```

Caso de uso é uma classe simples com `execute`, sem interface base. **Input/Output só com 3 campos ou mais.** Abaixo disso o caso de uso recebe e devolve os valores direto: `GetAccount.execute(accountId: string)`, `AccountExists.execute(accountId: string): Promise<boolean>`, `Signup.execute(input: SignupInput): Promise<string>`. Alias de tipo (`type XInput = Y`) não existe.

```ts
export interface PlaceOrderInput {
  readonly accountId: string;
  readonly marketId: string;
  readonly side: string;
  readonly price: string;
  readonly quantity: string;
}

export interface PlaceOrderOutput {
  readonly orderId: string;
  readonly status: string;
}

export class PlaceOrder {
  constructor(
    private readonly orderRepository: OrderRepository,
    private readonly marketCatalog: MarketCatalog,
    private readonly transactionRunner: TransactionRunner,
    private readonly eventPublisher: EventPublisher,
    private readonly idGenerator: IdGenerator,
    private readonly clock: Clock,
  ) {}

  async execute(input: PlaceOrderInput): Promise<PlaceOrderOutput> {
    const market = this.marketCatalog.get(MarketId.from(input.marketId));
    const order = Order.place({ id: this.idGenerator.next(), market, ...input, now: this.clock.now() });

    await this.transactionRunner.run(async () => {
      await this.orderRepository.save(order);
      await this.eventPublisher.publish(order.pullEvents());
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

- O caso de uso **não conhece** o RabbitMQ, o outbox nem quem vai reagir ao `OrderPlaced`. Ele só entrega os eventos de domínio ao `EventPublisher` (§2.1).
- Caso de uso de consulta segue a mesma regra: `GetOrders.execute(accountId, status)` (2 valores, sem objeto de entrada) → DAO → `GetOrdersOutput` (montado a partir de `OrderView[]`).

---

## 4. Integração síncrona (Gateway + ACL)

HTTP entre serviços é **exceção**. A primeira opção para ler dado de outro contexto é sempre uma **projeção local** (ver [CQRS e tabelas de projeção](#cqrs-e-tabelas-de-proje%C3%A7%C3%A3o)). A chamada síncrona entra só como **fallback**, quando a projeção ainda não tem o dado e isso bloqueia um comando. Hoje existe um caso só: `wallet → account` ("a conta existe?" antes de o evento `account.created` chegar).

Estrutura obrigatória:

```
application/contracts/accountGateway.ts    ← porta: fala a língua do MEU contexto
infra/grpc/account/grpcAccountGateway.ts   ← adapter: gRPC, deadline, retry
infra/grpc/account/accountAcl.ts           ← ACL: traduz o modelo DELES → o MEU
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
| Endpoints do [objective.md](objective.md) | Fallback do Gateway + ACL (`AccountExists`) |

Decisão para esta plataforma:
- **API pública: REST.** Exatamente os endpoints do objetivo, roteados pelo edge proxy.
- **Síncrono interno: gRPC.** O `.proto` é do serviço que expõe o método (`infra/schemas/published/proto/`); quem chama guarda uma cópia (`infra/schemas/consumed/proto/`), verificada pelo `scripts/check-schemas` (§6). Cada serviço gera o próprio código TypeScript (`ts-proto`) a partir do `.proto` que tem. Só os adapters da `infra` importam o código gerado; a ACL traduz a mensagem gerada para os tipos do meu contexto.
- **Assíncrono: RabbitMQ** (ver [mensageria](03-mensageria.md)). gRPC não substitui evento: se o chamador não precisa da resposta na hora, é evento.
- **Health check e métricas: HTTP simples** (`/health`, `/metrics`), porque é o que o Docker e as ferramentas de observabilidade esperam.
- **Fora do escopo:** gRPC no browser (gRPC-Web) e streaming. Se surgir depth em tempo real para o front, o caminho é WebSocket/SSE no `market-data`, não gRPC.

Regras de gRPC:
- **Toda chamada leva o token compartilhado** no metadata `x-service-token`. Sem token ou token errado → `UNAUTHENTICATED` (erro permanente, sem retry). Ver [autenticação entre serviços §2](08-autenticacao-entre-servicos.md#2-grpc-interno-token-compartilhado).
- **Deadline sempre** (padrão 500 ms), propagado na chamada.
- Retry só para `UNAVAILABLE`, `DEADLINE_EXCEEDED` e `RESOURCE_EXHAUSTED`, com o mesmo backoff + jitter do §5.2. Nunca para `INVALID_ARGUMENT`, `NOT_FOUND`, `FAILED_PRECONDITION`, `UNAUTHENTICATED`.
- `NOT_FOUND` é resposta válida (ex.: conta não existe), não falha: a ACL traduz para o tipo do meu contexto.
- O serviço que expõe gRPC (hoje só o `account`) escuta numa porta própria, separada do REST.

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

### 5.3 Fallback: try/catch explícito
Quando há mais de uma forma de obter um resultado, os passos ficam em sequência numa função só, com `if` e `try/catch` comuns. Sem corrente de classes.

```ts
async loadOrOpen(accountId: AccountId): Promise<Wallet> {
  const stored = await this.walletRepository.findByAccount(accountId);
  if (stored) return stored;
  if (!(await this.accountGateway.exists(accountId.value))) throw new WalletNotFoundError(accountId.value);
  return Wallet.open(accountId);
}
```

Uso hoje:

| Onde | Passos |
|---|---|
| `wallet`: "a conta existe?" | Carteira local → `GrpcAccountGateway` (deadline + retry) → `WalletNotFoundError` (se existir, abre a carteira com `Wallet.open`) |

O último passo é sempre **explícito**: ou degrada com aviso, ou falha com erro claro. Nunca engolir erro silenciosamente.

### 5.4 Idempotência
- Consumidores: tabela **inbox** (`consumer` + `message_key`, ver [mensageria §5](03-mensageria.md#inbox-consumidor)) na mesma transação do efeito.
- **POST público que mexe com dinheiro ou ordem** (`/place_order`, `/cancel_order`, depósito e saque do `wallet`) aceita o header `Idempotency-Key`, com o comportamento da Stripe: a primeira resposta (status + corpo) é guardada por pelo menos 24 h e devolvida igual nas repetições; a mesma chave com outro corpo → `422`. Implementado em `src/infra/platform/http/` desses serviços. O `/signup` não precisa: o e-mail único já o torna idempotente ([Q13](99-decisoes.md#q13)).

### 5.5 Circuit breaker
Fora do MVP. Os gateways nascem com uma interface que permite adicionar depois sem mexer nos casos de uso.

### 5.6 Rate limiting
Toda a API pública tem limite **por tipo de uso**, em duas camadas: no edge (por IP) e no serviço (por conta e por IP, com Redis). Autenticação tem os limites mais apertados, contra brute force. O limitador usa o Redis. Se o Redis falhar, a requisição passa e o serviço registra um aviso (fail-open). Detalhes em [07-rate-limiting.md](07-rate-limiting.md).

### 5.7 Graceful shutdown
Ao receber `SIGTERM`: parar de consumir, terminar a mensagem em andamento, dar `ack`, fechar conexões. Mensagem sem `ack` volta para a fila.

Se a conexão com o broker cair, o worker não reconecta sozinho: registra o erro e sai com código 1. O Docker o reinicia (`restart: unless-stopped`), e outbox + inbox garantem que nada se perde.

---

## 6. Código compartilhado (não há)

**Nenhum código é compartilhado entre serviços.** Cada serviço é um **repositório próprio** ([ambiente §0](04-ambiente-docker.md#0-reposit%C3%B3rios-e-layout-da-raiz)), clonado em `backend/<svc>/` pelo `make clone` do repositório guarda-chuva.

| O quê | Onde fica | Como chega a um serviço novo |
|---|---|---|
| Domínio | `src/domain/` do serviço | Escrito pelo serviço. Nunca é compartilhado: `Quantity` de `wallet` e de `matching` são classes separadas |
| **Requisitos não funcionais** (retry, deadline, outbox, inbox, consumer com retry/DLQ, rate limit, `Idempotency-Key`, token gRPC) | **`src/infra/platform/`** do serviço: `resilience/`, `messaging/`, `http/`, `security/` | Escrito à mão quando o serviço é construído, só com o que ele usa. O primeiro serviço (`account`) escreve do zero; os seguintes podem copiar do anterior e adaptar |
| Helpers de teste (bancos e broker efêmeros, CA de teste, fakes gRPC/HTTP, fixtures) | **`test/`** do serviço | Do mesmo jeito: escritos no serviço, copiados e adaptados quando outro precisar |
| Contratos | `src/infra/schemas/` do serviço (ver abaixo) | O produtor é dono; o consumidor guarda cópia |
| Regras de lint e de arquitetura | `eslint.config.mjs` e `.dependency-cruiser.cjs` do serviço | Escritas no serviço |

**Regra de independência.** Um serviço:
- **nunca** importa nada fora da própria pasta (`../` é proibido e o teste de arquitetura quebra se acontecer);
- tem `package.json` e `package-lock.json` próprios, e um `docker/Dockerfile` cujo contexto de build é só a pasta dele;
- depende da infraestrutura compartilhada (RabbitMQ, Redis, edge) só pela rede `trading-net` e pelos nomes DNS, nunca por arquivo.

**Trade-off aceito.** Uma correção num RNF precisa ser replicada em cada serviço que tem aquele código. Em troca, não existe registro de pacotes, versão para publicar nem serviço arrastando outro numa atualização. **Não existe gerador nem template.** Os serviços são construídos um de cada vez, à mão. Quando um serviço precisa de algo que outro já tem, copia e adapta.

### Contratos: o produtor é dono, o consumidor guarda cópia

```
backend/account/src/infra/schemas/
  published/events/account.created.v1.schema.json      ← dono: account
  published/proto/account.proto                        ← dono: account (servidor gRPC)
  consumed/events/wallet.balanceChanged.v1.schema.json ← cópia do que account consome
  envelope.schema.json                                 ← cópia do envelope comum
  markets.json                                         ← cópia do catálogo, se o serviço usa
```

- **Quem publica um evento ou expõe um `.proto` é o dono** e guarda o original em `infra/schemas/published/`.
- **Quem consome guarda uma cópia** em `infra/schemas/consumed/`, e é contra ela que roda os testes de contrato.
- O código TypeScript do gRPC é gerado **dentro de cada serviço** (`ts-proto`), a partir do `.proto` que ele tem (o próprio, se for servidor; a cópia, se for cliente).
- **`scripts/check-schemas`** (container) compara cada cópia com o original do dono e falha se divergirem. Com os serviços em repositórios separados, ele roda no guarda-chuva sobre os clones (`make check`): mudar um contrato exige atualizar o original no dono e as cópias nos consumidores, cada um no seu repositório. Um registro de contratos (de onde cada consumidor puxaria a cópia) fica como evolução, e a regra continua a mesma.
- O envelope e o `markets.json` não têm um serviço dono: o original fica em `backend/infra/schemas/`, e cada serviço guarda uma cópia, verificada pelo mesmo script.
- A evolução segue a regra da [mensageria §2](03-mensageria.md#2-envelope): mudança compatível mantém a versão; incompatível cria `v2`, e o produtor publica as duas até os consumidores migrarem.

---

## 7. Docker sempre

- **Tudo roda em container**: serviços, testes, migrações, banco e RabbitMQ. Nada depende de Postgres/RabbitMQ instalado na máquina.
- **Cada backend tem seu `docker/docker-compose.yml`** com o próprio Postgres e os próprios processos. **Compose é só para o ambiente local**; produção usa a imagem `runtime`.
- **RabbitMQ é único**, num compose de infraestrutura compartilhada, ligado aos serviços por uma rede Docker externa.
- Detalhes em [04-ambiente-docker.md](04-ambiente-docker.md).

---

## 8. Testes

Pirâmide: regra específica é testada no nível mais baixo possível. Detalhes em [05-estrategia-de-testes.md](05-estrategia-de-testes.md).

---

## 9. Stack

| Item | Escolha | Motivo |
|---|---|---|
| Linguagem | TypeScript (strict) **fixado em `~6.0.3`**, Node 26 | Um ecossistema só para serviços, scripts e testes. A versão é fixada porque `typescript-eslint`, `dependency-cruiser` e `kysely-codegen` ainda exigem TypeScript < 6.1 |
| HTTP (API pública) | Fastify | Leve, schema de validação nativo |
| RPC interno | `@grpc/grpc-js` + `ts-proto` | Contrato tipado gerado, em cada serviço, a partir do `.proto` que ele tem em `infra/schemas/` |
| Acesso ao Postgres | **Kysely** (query builder tipado) sobre o driver `pg` | Não é ORM: o domínio não ganha decorators nem classes de entidade, e o Repository mapeia linha ↔ agregado à mão. Cobre o que a spec exige: `FOR UPDATE SKIP LOCKED` (relay do outbox), `ON CONFLICT` (projeções), transação explícita, `GROUP BY` e agregações tipadas nos DAOs, e `sql` para o que faltar (ex.: `pg_advisory_lock`) |
| Tipos do banco | `kysely-codegen`, gerado do banco já migrado e versionado em `infra/database/database.ts` | O tipo vem do schema real, não de uma cópia escrita à mão |
| `numeric` | Lido como **string** e convertido para `decimal.js` no mapeamento | Nunca passa por `number`: não perde casas |
| Migrações | **Estilo Laravel**: uma classe por arquivo em `src/infra/database/migrations/<AAAA_MM_DD_HHMMSS>_<nome>.ts`, com `up()` e `down()` escritos com o schema builder do Kysely (`db.schema.createTable(...)`; `sql` só onde o builder não cobre). Migrator próprio com **lotes (batches)** na tabela `migrations`: cada `migrate` roda os pendentes como um lote e `migrate:rollback` desfaz o último. Cada comando roda numa única transação, com advisory lock; por isso não se usa `CREATE INDEX CONCURRENTLY`. Comandos: `npm run migrate`, `migrate:rollback`, `migrate:status`, `migrate:fresh` (recusado com `NODE_ENV=production`) e `make:migration -- <nome>` | Mesmo fluxo do Laravel; o Migrator do Kysely não tem lote nem rollback por lote |
| RabbitMQ | `amqplib` encapsulado em `src/infra/platform/messaging/` | |
| Decimal | `decimal.js` | Dinheiro sem erro de ponto flutuante |
| Testes | Vitest | Já usado no projeto |
| Validação de borda | JSON Schema (o mesmo de `infra/schemas/`) | Uma fonte da verdade para contrato |
