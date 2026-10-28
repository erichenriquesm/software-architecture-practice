# Serviço `account` — Identidade e Conta

> Status: **spec** · Subdomínio: **Generic** · Modelagem: **leve**

## 1. Responsabilidade

- Cadastrar contas (nome, e-mail, CPF, senha) e garantir as regras de cadastro.
- Responder `GetAccount`: dados cadastrais + saldos (via **projeção local** dos saldos da carteira).
- Responder ao `wallet`, via gRPC, se uma conta existe (fallback dele).

**Fora do escopo:** login/autenticação, alteração de cadastro, exclusão de conta ([Q4](../99-decisoes.md#q4)).

## 2. Workload

Baixo volume de escrita (cadastro), leitura simples por id. Nada de contenção. Escala horizontal trivial.

## 3. Modelo de domínio

**Entidade `Account`** (raiz do agregado): `accountId`, `name: FullName`, `email: Email`, `document: Cpf`, `password: PasswordHash`.

| Value Object | Regra |
|---|---|
| `FullName` | Nome e sobrenome (≥ 2 partes não vazias). |
| `Email` | Formato válido; normalizado em minúsculas. |
| `Cpf` | Algoritmo dos dígitos verificadores; rejeita sequências repetidas (`111.111.111-11`); armazenado só com dígitos. |
| `Password` | Senha em texto: ≥ 8 caracteres, com minúscula, maiúscula e número. **Só existe durante o signup**; nunca é persistida. |
| `PasswordHash` | Resultado do hash (argon2id). É o que a entidade guarda. |

Unicidade de e-mail **não** é invariante do agregado (envolve todas as contas): é regra do caso de uso + `unique` no banco.

## 4. Casos de uso

| Caso de uso | Tipo | Regras / passos |
|---|---|---|
| `Signup` | Comando | Cria VOs (valida) → `AccountRepository.existsByEmail` → hash via `PasswordHasher` → salva → outbox `account.created`. Corrida de e-mail duplicado é pega pela `unique` e traduzida para o mesmo erro. |
| `GetAccount` | Consulta | `AccountDao.findById` + `BalanceDao` (lê só a `account_balance_view`, §7). 404 se não existir. |
| `ProjectWalletBalance` | Handler de evento | `wallet.balanceChanged` → *upsert* em `account_balance_view` se `version` for maior que a gravada. |
| `AccountExists` | Consulta (gRPC) | `AccountDao.exists(accountId)`. |

Contratos (interfaces em `application/contracts/`): `AccountRepository`, `AccountDao` (com `AccountView`), `BalanceDao` (com `BalanceView`), `BalanceProjection` (grava a `account_balance_view`), `PasswordHasher` (o hash é lento de propósito; o fake deixa o teste de unidade rápido), `TransactionRunner`, `EventPublisher`, `IdGenerator`, `Clock`.

O health check (`/health`) não é caso de uso: fica em `infra/http/health.ts`, com uma sonda por dependência.

## 5. API pública (REST)

| Método | Rota | Entrada | Saída | Erros |
|---|---|---|---|---|
| POST | `/signup` | `name, email, document, password` | `201 { accountId }` | `422` validação · `409` e-mail já cadastrado |
| GET | `/accounts/:accountId` | — | `200 { accountId, name, email, document, assets[{ assetId, quantity, available, reserved }] }` | `404` |

- `quantity = available + reserved` (saldo total, como pede o objetivo). `available`/`reserved` são extras úteis ([Q12](../99-decisoes.md#q12)).
- Conta sem linha na projeção (recém-criada) responde `assets: []`: a carteira dela ainda está vazia.
- `password` nunca sai em nenhuma resposta.
- `POST /signup` não usa `Idempotency-Key` ([Q13](../99-decisoes.md#q13)): a repetição cai no `409` de e-mail duplicado.

## 6. gRPC interno

```proto
service AccountService {
  rpc Exists (ExistsRequest) returns (ExistsResponse);   // { account_id } → { exists }
}
```

Toda chamada leva o token compartilhado no metadata `x-service-token`; sem ele ou errado → `UNAUTHENTICATED` ([autenticação §2](../08-autenticacao-entre-servicos.md#2-grpc-interno-token-compartilhado)). O `account` não chama nenhum serviço por gRPC.

## 7. Integração síncrona e resiliência

Nenhuma. Os saldos do `GetAccount` vêm só da `account_balance_view`, alimentada por `wallet.balanceChanged`. Conta recém-criada que ainda não recebeu nenhum evento responde `assets: []`, o que é verdade: a carteira dela está vazia. Não há chamada ao `wallet`.

## 8. Mensageria

| Direção | Evento | Fila / Exchange |
|---|---|---|
| Publica | `account.created` | `account.events` |
| Consome | `wallet.balanceChanged` | `account.walletBalances` |

## 9. Dados (`account-db`)

```sql
-- write model
create table account (
  account_id     uuid primary key,
  name           text not null,
  email          text not null,
  document       text not null,
  password_hash  text not null,
  created_at     timestamptz not null default now()
);
create unique index account_email_uq on account (lower(email));

-- async projection fed by wallet.balanceChanged
create table account_balance_view (
  account_id  uuid not null,
  asset_id    text not null,
  available   numeric(36,8) not null,
  reserved    numeric(36,8) not null,
  version     bigint not null,          -- wallet version; last-write-wins
  updated_at  timestamptz not null,
  primary key (account_id, asset_id)
);

-- outbox, inbox: see 03-mensageria.md §5
```

A tabela `idempotency_key` das primeiras migrações sai na `000006_drop_idempotency_key_table` (o `down` a recria): o `account` não usa mais `Idempotency-Key` ([Q13](../99-decisoes.md#q13)).

`GetAccount` não precisa de projeção síncrona: a tabela `account` já está no formato da resposta e a consulta é por chave. Criar `account_view` seria duplicação sem ganho.

## 10. Estrutura

```
backend/account/
  .env.example  .env.test.example  Makefile (comandos de migração)
  docker/                           Dockerfile  Dockerfile.dockerignore  docker-compose.yml  docker-compose.platform.yml  docker-compose.test.yml
  package.json  package-lock.json  tsconfig.json  eslint.config.mjs  .dependency-cruiser.cjs  vitest.config.ts
  src/
    domain/
      entities/                     account.ts  aggregateRoot.ts
      valueObjects/                 accountId.ts  fullName.ts  email.ts  cpf.ts  password.ts  passwordHash.ts
      events/                       domainEvent.ts  accountCreated.ts
      errors.ts
    application/
      usecases/                     signup.ts (+ SignupInput)  getAccount.ts (+ GetAccountOutput)  projectWalletBalance.ts  accountExists.ts
      contracts/                    accountRepository.ts  accountDao.ts (+ AccountView)  balanceDao.ts (+ BalanceView)  balanceProjection.ts
                                    passwordHasher.ts  transactionRunner.ts  eventPublisher.ts  idGenerator.ts  clock.ts
    infra/
      http/                         accountRoutes.ts (signup, getAccount, rate limit)  health.ts
      grpc/accountGrpcServer.ts     servidor do Exists, com o interceptor do token
      messaging/                    walletBalancesConsumer.ts  outboxEventPublisher.ts
      database/                     kyselyAccountRepository.ts  kyselyAccountDao.ts  kyselyBalanceDao.ts
                                    kyselyBalanceProjection.ts  kyselyTransactionRunner.ts  postgres.ts  database.ts
                                    migrator.ts  migrationFiles.ts
        migrations/                 2026_10_28_000001_create_outbox_table.ts … 000006_drop_idempotency_key_table.ts
      crypto/argon2PasswordHasher.ts
      platform/                     config/  http/  messaging/  observability/  resilience/  security/
      schemas/
        published/events/account.created.v1.schema.json
        published/proto/account.proto
        consumed/events/wallet.balanceChanged.v1.schema.json
        envelope.schema.json
      generated/                    código do .proto (não versionado)
      composition.ts  settings.ts  system.ts
      api.ts  worker.ts  migrate.ts
  test/
    unit/  integration/             espelham src/
    fakes/                          um fake por contrato de application/contracts/
    support/                        Postgres/RabbitMQ/Redis efêmeros, fixtures
```

Nada é migrado do código experimental da raiz: o serviço é escrito do zero ([Q15](../99-decisoes.md#q15)). Como é o primeiro serviço, o `src/infra/platform/` e o `test/support/` também nascem aqui, só com o que o `account` usa.

### `.env.example`

```bash
API_PORT=3000
GRPC_PORT=50051
HEALTH_PORT=3001
DATABASE_HOST=account-db
DATABASE_PORT=5432
DATABASE_NAME=account
DATABASE_USER=account
DATABASE_PASSWORD=account-db-dev
RABBITMQ_HOST=rabbitmq
RABBITMQ_USER=account
RABBITMQ_PASSWORD=account-rabbitmq-dev
REDIS_HOST=redis
REDIS_USER=account
REDIS_PASSWORD=account-redis-dev
GRPC_TOKEN=internal-grpc-dev
RATE_LIMITS_AUTH_PER_IP=5/1h
RATE_LIMITS_AUTH_PER_EMAIL=3/1h
RATE_LIMITS_PRIVATE_READ_PER_IP=600/1m
RATE_LIMITS_PRIVATE_READ_PER_ACCOUNT=300/1m
LOG_LEVEL=debug
```

## 11. Testes principais

| Nível | Casos |
|---|---|
| Unidade | `Cpf` válido/inválido/repetido · `Password` cada regra · `FullName` sem sobrenome · `Signup` com e-mail duplicado (fake) · `Signup` publica `account.created` · `GetAccount` sem linhas na projeção → `assets: []` |
| Integração | `unique` de e-mail sob corrida (dois signups simultâneos → um 409) · projeção ignora `version` antiga · servidor `Exists`: sem token ou token errado → `UNAUTHENTICATED` |
| Contrato | `account.created` valida no schema · servidor implementa `AccountService` |
