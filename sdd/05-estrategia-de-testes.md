# 05 — Estratégia de Testes

> Status: **spec** · Regra central: **cada regra é testada no nível mais baixo onde ela existe.** Níveis de cima testam a ligação entre as peças, não a regra de novo.

---

## 1. A pirâmide

```
            ▲  E2E (poucos)                     plataforma inteira em docker compose
           ▲▲▲ Contrato                         eventos (JSON Schema) e gRPC (.proto)
         ▲▲▲▲▲▲ Integração                      Repository/DAO × Postgres real, broker real, gRPC real
   ▲▲▲▲▲▲▲▲▲▲▲▲▲▲ Unidade (a maioria)            domínio puro + casos de uso com fakes
```

Proporção-alvo em número de testes: **~70% unidade · ~20% integração · ~7% contrato · ~3% E2E.**

---

## 2. O que vai em cada nível

### Unidade — sem I/O, milissegundos
- **Value Objects**: cada regra de validação (CPF, e-mail, senha, quantidade > 0, escala decimal).
- **Agregados**: invariantes e transições.
  - `OrderBook`: **todos os cenários do objetivo viram teste**. Exemplo obrigatório: compra 10 BTC @ 83.000 no livro + venda 5 BTC @ 82.400 → trade de 5 @ 83.000, `side = sell`, venda sai do livro, compra fica com 5. Mais: preço do maker, prioridade por tempo no mesmo preço, execução parcial em cascata, sem match quando `bid < ask`.
  - `Wallet`: reserva, liquidação com devolução da diferença de preço, saque acima do disponível, comutatividade de `settle` × `release`.
  - `Order`: transições válidas e inválidas, preço médio de fill, status derivado com eventos fora de ordem.
- **Casos de uso**: com **fakes em memória** dos Repositories, DAOs, gateways e do `EventPublisher` (`test/fakes/recordingEventPublisher.ts`, que guarda os eventos recebidos). Verificam orquestração: carregou, chamou o domínio, salvou, publicou o evento certo.
- **Funções puras**: agregação de depth por precisão, cálculo de spread, backoff com jitter.
- **ACLs**: tradução de mensagem externa → tipo do contexto, incluindo resposta fora do contrato.

### Integração — um componente real por vez
- **Repository** × Postgres: salvar/carregar agregado, controle otimista (`version`) sob concorrência.
- **DAO** × Postgres: consultas e filtros sobre as `*_view`, com dados semeados.
- **Projection writers**: idempotência e *last-write-wins* (aplicar o mesmo evento duas vezes; aplicar versão antiga depois da nova).
- **Outbox relay** × RabbitMQ: publicação em ordem e com confirms.
- **Consumidor** × RabbitMQ: inbox (duplicata ignorada), retry para a fila de atraso, DLQ para erro permanente.
- **Gateway gRPC** × **servidor gRPC fake** do outro serviço (§3.2): deadline, retry só em código transitório, token enviado.
- **Caso de uso que depende de outro serviço** (ex.: `Deposit` com o fallback "a conta existe?") × Postgres real + **fake** do outro serviço. Nunca o serviço de verdade.
- **Migrações**: rodam do zero num banco vazio.

**Não** retestar regra de negócio aqui.

### Contrato
- **Produtor**: todo evento que o serviço publica valida contra o schema dele em `src/infra/schemas/published/events/`.
- **Consumidor**: fixtures geradas a partir dos schemas são aceitas pelos handlers.
- **gRPC**: o servidor implementa o `.proto` de `src/infra/schemas/published/proto/` (garantido pela geração de código) e o cliente é testado contra a cópia em `src/infra/schemas/consumed/proto/`. O `scripts/check-schemas` garante que cópia e original são iguais.
- Mudança incompatível de contrato quebra esses testes antes de quebrar a produção.

### E2E — poucos, caminhos críticos
0. Autenticação: rota privada sem sessão ou com `Authorization` forjado → `401`; conta de outro usuário → `403`; logout encerra a sessão.
1. Signup → Login → Deposit → GetAccount mostra o saldo.
2. Duas contas: compra + venda que cruzam → trade → saldos liquidados nas duas contas → `GetOrders` com fills → depth e trades em `market-data`.
3. Ordem sem saldo → `rejected`.
4. Ordem aberta → cancel → saldo reservado volta.

E2E usa só a API pública REST pelo edge proxy, e espera a consistência eventual com *polling* com timeout (nunca `sleep` fixo). Fica em `backend/e2e/` (`node:test` + `fetch`, sem dependência) e roda contra a plataforma de desenvolvimento, sem apagá-la. Para repetir sem ambiente novo:

- **Duas contas fixas** (`e2e-buyer`, `e2e-seller`): o cadastro só acontece na primeira execução, porque o limite é 5 por IP por hora.
- **Saldos comparados por diferença**, a partir de um saldo já assentado (o depósito aparece na projeção antes da medida).
- **Preço dentro do spread atual**: acima da melhor compra e abaixo da melhor venda, para que as ordens do E2E só casem entre si, mesmo com ordens de outras contas no livro.

---

## 3. Repetibilidade

**Todo teste dá o mesmo resultado em qualquer execução, em qualquer ordem e em paralelo.** Teste que depende de horário, de ordem de execução ou de outro serviço estar de pé não é teste: é sorteio.

### 3.1 Regras de repetibilidade

| Fonte de variação | Como neutralizar |
|---|---|
| **Outro microserviço** | **Nunca chamado de verdade** fora do E2E. Vira um servidor fake (§3.2). |
| Eventos de outro serviço | Publicados no broker de teste como **fixtures geradas dos JSON Schemas** de `src/infra/schemas/`. O serviço produtor não sobe. |
| Tempo | `Clock` fake no domínio e na aplicação; `vi.useFakeTimers()` para timeout, backoff e job agendado. Nada de `Date.now()` direto. |
| Ids | `IdGenerator` fake com sequência determinística. |
| Aleatoriedade | Teste por propriedade (ex.: livro nunca cruzado) com **seed fixa**, e a seed é impressa quando falha. Jitter do backoff recebe o gerador aleatório por injeção. |
| Banco | Postgres efêmero (`tmpfs`), **um banco por worker do Vitest** (`<svc>_test_<workerId>`), migrado do zero; `truncate` das tabelas do serviço antes de cada teste. |
| Broker e Redis | RabbitMQ e Redis efêmeros do perfil `test`, com **vhost / prefixo de chave por worker**. |
| Espera assíncrona | Na integração, **sem `sleep`**: espera um sinal explícito (confirm do publisher, callback do consumer, promessa resolvida pelo fake). Polling com timeout só no E2E. |
| Rede | Os containers de teste ficam numa **rede isolada** (`<svc>-test-net`), fora da `trading-net`. Não há como um teste alcançar um serviço real nem a internet por acidente. |
| Ordem entre testes | Nenhum teste usa dado criado por outro. Cada um monta e limpa o próprio cenário. |

### 3.2 Fake de outro microserviço

Quando o código sob teste depende de outro serviço, o teste sobe um **fake de rede em processo**, e não um mock de biblioteca: a requisição passa pelo adapter real (cliente gRPC/HTTP, deadline, retry, ACL), e só o outro lado é falso.

| Dependência | Fake | Fornecido por |
|---|---|---|
| gRPC interno (`AccountService`) | `startFakeGrpcServer(proto, handlers)`: servidor `@grpc/grpc-js` na porta `0` (porta livre aleatória), gerado do mesmo `.proto` que o serviço tem em `src/infra/schemas/`, e que confere o token como o servidor real ([autenticação §7](08-autenticacao-entre-servicos.md#7-testes)) | `test/support/` do serviço |
| HTTP externo (se surgir: provedor de identidade, gateway de pagamento…) | `startFakeHttpServer(routes)`: instância Fastify na porta `0` | `test/support/` do serviço |

O fake é **programável por cenário**, e cada cenário é determinístico:

```ts
const accountService = await startFakeGrpcServer(accountProto, {
  exists: respondSequence([
    grpcError(Status.UNAVAILABLE),
    grpcError(Status.UNAVAILABLE),
    { exists: true },
  ]),
});
```

Cenários que todo gateway testa: resposta válida · `NOT_FOUND` · `UNAVAILABLE` N vezes e depois sucesso (retry) · demora acima do deadline (timeout) · resposta fora do contrato (a ACL rejeita) · fora do ar de vez (erro claro).

**O fake não pode mentir sobre o contrato:** as respostas dele são validadas contra o mesmo `.proto`/JSON Schema que o serviço real implementa, e os testes de contrato do serviço real (§2, Contrato) garantem que ele responde no mesmo formato. Se o contrato mudar, o fake e o real quebram juntos.

## 4. Regras

- **Teste descreve comportamento**, no formato Given / When / Then.
- **Sem mock de biblioteca de terceiros** em teste de unidade: o fake é da **porta** do meu contexto.
- **Onde fica cada coisa:**

  | O quê | Onde |
  |---|---|
  | Teste de unidade | `test/unit/`, espelhando `src/`: `src/application/usecases/signup.ts` → `test/unit/application/usecases/signup.spec.ts` |
  | Teste de integração e de contrato | `test/integration/`, espelhando `src/`: `src/infra/database/migrator.ts` → `test/integration/infra/database/migrator.spec.ts` |
  | Fakes das portas (um por porta, reaproveitados) | `test/fakes/` |
  | Helpers de teste (fake gRPC/HTTP, banco e broker efêmeros, fixtures) | `test/support/` |
- **Tempo e id controlados** por `Clock`/`IdGenerator` fakes. Nada de `Date.now()` no domínio.
- **Banco limpo por teste** de integração (`truncate` das tabelas do serviço ou transação com rollback).
- **Teste instável é bug.** Não se aumenta timeout para "passar".
- Cobertura: meta **≥ 90% em `domain/`**, sem meta global. Cobertura alta em `infra/` vem da integração, não de mock.

---

## 5. Como rodar

Tudo em container.

**Um comando para tudo:** `make test` dentro de `backend/<svc>/` (um serviço) ou de `backend/` (todos os serviços e a checagem de contratos). Em cada serviço:

| Alvo | O que roda |
|---|---|
| `make test` | `test-unit` e depois `test-integration` |
| `make test-unit` | typecheck, lint, regras de arquitetura e testes de unidade (`test/unit/`) |
| `make test-integration` | testes de integração e de contrato (`test/integration/`) com Postgres, RabbitMQ e Redis efêmeros; os containers são removidos ao final, mesmo se um teste falhar |

O E2E roda com `make e2e` em `backend/`: sobe e migra a plataforma e depois executa os cenários.


| O quê | Como |
|---|---|
| Unidade | Roda no **build da imagem** de cada serviço; ou `npm run docker:test` no serviço (mostra a saída). |
| Integração + contrato | `make test-integration` em `backend/<svc>/` (por baixo: `docker compose -f docker/docker-compose.test.yml --env-file .env.test run --rm --build tests` e depois `down -v`) — sobe `<svc>-db-test` (Postgres em `tmpfs`), `<svc>-rabbitmq-test` e `<svc>-redis-test` efêmeros numa rede isolada `<svc>-test-net` (§3.1), roda e descarta. Os fakes de outros serviços sobem dentro do processo de teste. |
| E2E | `make e2e` em `backend/` (por baixo: `make up` e depois `docker compose run --rm e2e` dentro de `backend/e2e/`) — usa os mesmos composes de desenvolvimento e roda os cenários pelo edge. |

RabbitMQ e Redis dos testes de integração são **efêmeros e isolados por serviço**, para que testes de serviços diferentes não interfiram entre si. A regra de "um único RabbitMQ" vale para a plataforma em execução, não para testes isolados. O E2E é o único nível que sobe os serviços de verdade.

Os testes de integração ficam num arquivo próprio (`docker/docker-compose.test.yml`), que declara só os containers efêmeros de teste. Assim um `down -v` dos testes nunca alcança o banco de desenvolvimento do serviço.

O compose de teste tem o próprio **`.env.test.example`** ao lado dele (copiado para `.env.test`), com os hosts e as credenciais dos containers efêmeros (`<svc>-db-test`, `<svc>-rabbitmq-test`, `<svc>-redis-test`), seguindo a mesma regra do [ambiente §2.2](04-ambiente-docker.md#22-envexample-por-compose).
