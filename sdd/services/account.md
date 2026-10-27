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
| `GetAccount` | Consulta | `AccountDao.findById` + corrente de saldos (§7). 404 se não existir. |
| `ProjectWalletBalance` | Handler de evento | `wallet.balanceChanged` → *upsert* em `account_balance_view` se `version` for maior que a gravada. |
| `AccountExists` | Consulta (gRPC) | `AccountDao.exists(accountId)`. |

Portas: `AccountRepository`, `AccountDao`, `BalanceDao`, `PasswordHasher` (o hash é lento de propósito; o fake deixa o teste de unidade rápido), `WalletGateway`, `IdGenerator`.

## 5. API pública (REST)

| Método | Rota | Entrada | Saída | Erros |
|---|---|---|---|---|
| POST | `/signup` | `name, email, document, password` | `201 { accountId }` | `422` validação · `409` e-mail já cadastrado |
| GET | `/accounts/:accountId` | — | `200 { accountId, name, email, document, assets[{ assetId, quantity, available, reserved }], balancesStatus }` | `404` |

- `quantity = available + reserved` (saldo total, como pede o objetivo). `available`/`reserved` são extras úteis ([Q12](../99-decisoes.md#q12)).
- `balancesStatus`: `ok` (projeção) · `live` (veio do fallback gRPC) · `unavailable` (degradado, `assets: []`).
- `password` nunca sai em nenhuma resposta.
- `POST /signup` aceita `Idempotency-Key` ([Q13](../99-decisoes.md#q13)). Sem a chave, a repetição cai no `409` de e-mail duplicado.

## 6. gRPC interno

```proto
service AccountService {
  rpc Exists (ExistsRequest) returns (ExistsResponse);   // { account_id } → { exists }
}
```

mTLS obrigatório. Allowlist: `Exists` só pode ser chamado por `wallet` ([autenticação §2](../08-autenticacao-entre-servicos.md#2-grpc-interno-mtls--allowlist)). O `WalletGrpcGateway` deste serviço se apresenta com o certificado `account-api`.

## 7. Integração síncrona e resiliência

Corrente de fallback para os saldos do `GetAccount`:

1. `BalanceProjectionLookup` — lê `account_balance_view`. Se houver linhas: pronto (`ok`).
2. `WalletGrpcGateway` + `WalletAcl` — `WalletService.GetBalances`, deadline 500 ms, retry 3× com backoff + jitter. A ACL traduz para `AssetBalance[]` (`live`).
3. `DegradedBalances` — devolve `assets: []` e `unavailable`. **Não falha o request**: dado cadastral continua útil.

O passo 2 só acontece para conta recém-criada que ainda não recebeu nenhum `wallet.balanceChanged`, ou depois de perder a projeção.

## 8. Mensageria

| Direção | Evento | Fila / Exchange |
|---|---|---|
| Publica | `account.created` | `account.events` |
| Consome | `wallet.balanceChanged` | `account.walletBalances` |

## 9. Dados (`account-db`, schema `account`)

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

`GetAccount` não precisa de projeção síncrona: a tabela `account` já está no formato da resposta e a consulta é por chave. Criar `account_view` seria duplicação sem ganho.

## 10. Estrutura

```
backend/account/src/
  domain/        account.ts, valueObjects/{fullName, email, cpf, password, passwordHash}.ts, errors.ts
  application/   usecases/{signup, getAccount, projectWalletBalance, accountExists}/   (cada pasta: <useCase>.ts, <useCase>Input.ts, <useCase>Output.ts)
                 repositories/accountRepository.ts · daos/{accountDao, balanceDao}.ts
                 ports/{passwordHasher, walletGateway, transactionRunner, domainEventDispatcher, idGenerator}.ts
  infra/         adapters/inbound/{http, grpc, messaging/walletBalanceConsumer}
                 adapters/outbound/{persistence/{repositories, daos, projections}, messaging/outboxEventPublisher,
                                    gateways/wallet/{grpcWalletGateway, walletAcl, balancesFallbackChain}, crypto/argon2PasswordHasher}
                 main/{api, worker, migrate}.ts
```

Nada é migrado do código experimental da raiz: o serviço é escrito do zero ([Q15](../99-decisoes.md#q15)).

## 11. Testes principais

| Nível | Casos |
|---|---|
| Unidade | `Cpf` válido/inválido/repetido · `Password` cada regra · `FullName` sem sobrenome · `Signup` com e-mail duplicado (fake) · `Signup` publica `account.created` · corrente de saldos: projeção → gRPC → degradado · `WalletAcl` rejeita resposta malformada |
| Integração | `unique` de e-mail sob corrida (dois signups simultâneos → um 409) · projeção ignora `version` antiga · gateway gRPC: deadline e retry só em `UNAVAILABLE` |
| Contrato | `account.created` valida no schema · servidor implementa `AccountService` |
