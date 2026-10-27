# Serviço `wallet` — Carteira

> Status: **spec** · Subdomínio: **Supporting (crítico: dinheiro)** · Modelagem: **rica**

## 1. Responsabilidade

- Guardar o saldo de cada conta por ativo, separado em **disponível** e **reservado**.
- Depósito e saque.
- **Reservar** saldo quando uma ordem é criada (é isso que impede vender ou comprar duas vezes o mesmo saldo).
- **Liquidar** cada negociação nas carteiras do comprador e do vendedor.
- **Liberar** a reserva restante quando uma ordem sai do livro por cancelamento.
- Publicar o estado do saldo para projeções de outros contextos.

**Fora do escopo:** integração com banco/blockchain real para depósito e saque ([Q14](../99-decisoes.md#q14)), taxas ([Q10](../99-decisoes.md#q10)).

## 2. Workload

Escrita concorrente **na mesma conta** (depósito + reserva + liquidação podem chegar juntos). Precisa de **consistência forte por conta** e trilha de auditoria. Leitura é pequena (gRPC de saldos, fallback do `account`).

## 3. Modelo de domínio

**Agregado `Wallet`** (raiz), um por conta: `accountId`, `version`, `balances: Map<AssetId, Balance>`, `reservations: Map<OrderId, Reservation>` (só as abertas).

| Elemento | Conteúdo |
|---|---|
| `Balance` (VO) | `available`, `reserved` (`Quantity`) |
| `Reservation` (entidade interna) | `orderId`, `assetId`, `side`, `limitPrice`, `remaining` (no ativo reservado) |
| `AssetId` (VO) | `BTC` \| `USD` |
| `Quantity`, `Price` (VO) | Decimais não negativos, escala interna 8. Os filtros do mercado garantem que `qty × price` cabe em 8 casas: **não há arredondamento** em reserva nem liquidação ([Q11](../99-decisoes.md#q11)). |
| `AssetPrecision` | Do catálogo: `BTC` 8 casas, `USD` 2. Vale para depósito e saque. |
| `MarketId` (VO) | `BASE-QUOTE`, ex.: `BTC-USD` |

**Invariantes**
1. `available ≥ 0` e `reserved ≥ 0` para todo ativo.
2. `reserved(ativo) = Σ reservation.remaining` das reservas abertas daquele ativo.
3. Uma reserva por `orderId` (reserva repetida é ignorada: idempotência de domínio).
4. Ordem anulada (lápide) **nunca** ganha reserva, mesmo que o `order.placed` chegue depois.

**Comportamentos**

| Método | Regra |
|---|---|
| `deposit(asset, qty)` | `qty > 0`; `asset ∈ {BTC, USD}`; `qty` respeita a precisão do ativo → `available += qty` |
| `withdraw(asset, qty)` | `qty > 0`; precisão do ativo; `qty ≤ available` — o reservado não é sacável ([Q1](../99-decisoes.md#q1)) → `available -= qty` |
| `reserve(orderId, market, side, qty, price)` | Compra: reserva `qty × price` do **quote** (`USD`). Venda: reserva `qty` do **base** (`BTC`). Se `available < valor` → `InsufficientFundsError`. Move `available → reserved`. |
| `settleAsBuyer(trade)` | Consome da reserva `qty × limitPrice`; debita `qty × trade.price` do reservado; **devolve a diferença** `qty × (limitPrice − trade.price)` ao disponível; credita `qty` de `BTC` no disponível. |
| `settleAsSeller(trade)` | Consome `qty` de `BTC` da reserva e do reservado; credita `qty × trade.price` de `USD` no disponível. |
| `releaseRemaining(orderId, remainingQty)` | Compra: libera `remainingQty × limitPrice`. Venda: libera `remainingQty`. Fecha a reserva se `remaining = 0`. |
| `voidReservation(orderId)` | **Compensação da saga S2.** Reserva aberta → libera tudo o que resta e marca `void`. Reserva inexistente → nada a liberar; o caso de uso grava a lápide. |

Por que a diferença é devolvida: quem compra reserva pelo **seu** limite, mas a negociação sai pelo preço do **maker** (a ordem mais antiga), que pode ser menor.

`settle*` e `releaseRemaining` consomem **exatamente** a parte que lhes cabe, então o resultado é o mesmo em qualquer ordem de chegada ([mensageria §5](../03-mensageria.md#handlers-comutativos)).

Cada mudança de saldo emite `BalanceChanged(accountId, assetId, available, reserved, version)` e um lançamento no ledger.

## 4. Casos de uso

Nomes de intenção; o gatilho é do adapter de entrada. Todo caso de uso recebe `<CasoDeUso>Input` e devolve `<CasoDeUso>Output` (`void` nos comandos).

| Caso de uso | Adapter de entrada (gatilho) | Passos |
|---|---|---|
| `OpenWallet` | consumer `wallet.accountCreated` | Cria carteira vazia se não existir (`Wallet.open`). |
| `Deposit` | REST `POST /deposit` | Garante a carteira (§7) → `deposit` → salva → despacha `BalanceChanged`. |
| `Withdraw` | REST `POST /withdraw` | Garante a carteira → `withdraw` → salva → despacha `BalanceChanged`. |
| `ReserveFunds` | consumer `wallet.orderPlaced` | Garante a carteira. Sem conta → despacha `FundsReservationRejected(WALLET_NOT_FOUND)`. `reserve` → despacha `FundsReserved` + `BalanceChanged`. `InsufficientFundsError` → despacha `FundsReservationRejected(INSUFFICIENT_FUNDS)` (é evento, não retry). |
| `SettleTradeSide` | consumer `wallet.tradeExecuted` | O consumer chama **duas vezes** (lado comprador e lado vendedor), cada uma na sua transação, inbox `eventId:accountId:role`. Comprador e vendedor são sempre contas diferentes: o `matching` aplica prevenção de self-trade ([Q9](../99-decisoes.md#q9)). |
| `ReleaseReservation` | consumer `wallet.orderRemoved` | `releaseRemaining` → despacha `BalanceChanged`. |
| `CompensateReservation` | consumer `wallet.orderVoided` | Grava lápide em `voided_order` → se houver reserva aberta, `voidReservation` → despacha `BalanceChanged`. `ReserveFunds` consulta `voided_order` antes de reservar. |
| `GetBalances` | gRPC `WalletService.GetBalances` | `BalanceDao.listByAccount` → `GetBalancesOutput`. |

**"Garante a carteira"** não é chamar o `OpenWallet`: um caso de uso nunca chama outro. É o mesmo passo de domínio (`Wallet.open`) usado dentro da transação do caso de uso atual, depois que a porta `AccountGateway` confirma que a conta existe (§7).

Reações aos eventos de domínio: `IntegrationEventMapper` (handler transacional) grava `wallet.fundsReserved`, `wallet.fundsReservationRejected` e `wallet.balanceChanged` no outbox.

**Concorrência:** controle otimista em `wallet.version`. Conflito → o caso de uso recarrega e tenta de novo (até 3×, em processo). Persistindo, no HTTP vira `409`; no consumidor, é erro transitório → fila de retry.

Portas: `WalletRepository`, `BalanceDao`, `AccountGateway`, `TransactionRunner`, `DomainEventDispatcher`, `Clock`.

Sagas em que este serviço participa: **S1**, **S2** (passo compensável e compensação), **S3** (liquidação), **S4** (liberação). Ver [06-sagas.md](../06-sagas.md).

## 5. API pública (REST)

| Método | Rota | Entrada | Saída | Erros |
|---|---|---|---|---|
| POST | `/deposit` | `accountId, assetId, quantity` | `204` | `404` conta · `422` ativo/quantidade |
| POST | `/withdraw` | `accountId, assetId, quantity` | `204` | `404` · `422` (inclui saldo disponível insuficiente) |

Ambos aceitam `Idempotency-Key`, com o comportamento da Stripe: a mesma chave devolve a mesma resposta ([Q13](../99-decisoes.md#q13)). Quantidade fora da precisão do ativo → `422`.

## 6. gRPC interno

```proto
service WalletService {
  rpc GetBalances (GetBalancesRequest) returns (GetBalancesResponse);
  // { account_id } → { balances: [{ asset_id, available, reserved }], version }
  // NOT_FOUND when the wallet does not exist
}
```

mTLS obrigatório. Allowlist: `GetBalances` só pode ser chamado por `account` ([autenticação §2](../08-autenticacao-entre-servicos.md#2-grpc-interno-mtls--allowlist)). O `AccountGrpcGateway` deste serviço se apresenta com o certificado `wallet-api`.

## 7. Integração síncrona e resiliência

"A conta existe?", usado por `Deposit`, `Withdraw` e `ReserveFunds`:

1. `LocalWalletLookup` — a carteira existe localmente? Pronto.
2. `AccountGrpcGateway` + `AccountAcl` — `AccountService.Exists`, deadline 500 ms, retry 3× com backoff + jitter. Se existir, o caso de uso abre a carteira na hora com `Wallet.open` (cobre a janela antes de `account.created` chegar). O adapter só responde se a conta existe; quem abre é o domínio.
3. Fim da corrente → `AccountNotFoundError`.

Se o gRPC estiver fora depois das tentativas: no HTTP, `503`; no consumidor, erro transitório → fila de retry (a ordem fica em `pending` até resolver).

## 8. Mensageria

| Direção | Evento | Fila / Exchange |
|---|---|---|
| Consome | `account.created` | `wallet.accountCreated` |
| Consome | `order.placed` | `wallet.orderPlaced` |
| Consome | `matching.tradeExecuted` | `wallet.tradeExecuted` |
| Consome | `matching.orderRemoved` | `wallet.orderRemoved` |
| Consome | `order.voided` | `wallet.orderVoided` |
| Publica | `wallet.fundsReserved`, `wallet.fundsReservationRejected`, `wallet.balanceChanged` | `wallet.events` |

## 9. Dados (`wallet-db`, schema `wallet`)

```sql
create table wallet (
  account_id  uuid primary key,
  version     bigint not null default 0,   -- optimistic lock + balanceChanged version
  created_at  timestamptz not null default now()
);

create table balance (
  account_id  uuid not null references wallet,
  asset_id    text not null,
  available   numeric(36,8) not null check (available >= 0),
  reserved    numeric(36,8) not null check (reserved >= 0),
  primary key (account_id, asset_id)
);

create table reservation (
  order_id     uuid primary key,
  account_id   uuid not null references wallet,
  asset_id     text not null,
  side         text not null,
  limit_price  numeric(36,8) not null,
  remaining    numeric(36,8) not null check (remaining >= 0),
  status       text not null,             -- open | closed | void
  created_at   timestamptz not null
);
create index reservation_open on reservation (account_id) where status = 'open';

-- S2 compensation tombstone: a voided order never gets a reservation
create table voided_order (
  order_id   uuid primary key,
  voided_at  timestamptz not null default now()
);

-- append-only audit trail
create table ledger_entry (
  id               bigserial primary key,
  account_id       uuid not null,
  asset_id         text not null,
  available_delta  numeric(36,8) not null,
  reserved_delta   numeric(36,8) not null,
  reason           text not null,         -- DEPOSIT | WITHDRAW | RESERVE | SETTLE | RELEASE | VOID
  reference_id     text,                  -- orderId / tradeId / idempotency key
  created_at       timestamptz not null default now()
);

-- outbox, inbox: see 03-mensageria.md §5
```

**Exceção consciente ao CQRS:** não há `balance_view`. A tabela `balance` já é a resposta do `GetBalances` (consulta por chave primária), e esse endpoint é só fallback. O `BalanceDao` lê `balance` diretamente. Se surgir relatório de carteira (extrato, por exemplo), ele lê `ledger_entry` ou ganha uma `*_view` própria.

O `check` no banco é a última defesa da invariante 1. A regra de verdade está no agregado.

## 10. Estrutura

```
backend/wallet/src/
  domain/        wallet.ts, reservation.ts, valueObjects/{assetId, quantity, price, marketId, side}.ts, events.ts, errors.ts
  application/   usecases/{openWallet, deposit, withdraw, reserveFunds, settleTradeSide, releaseReservation, compensateReservation, getBalances}/
                   (cada pasta: <useCase>.ts, <useCase>Input.ts, <useCase>Output.ts)
                 repositories/walletRepository.ts · daos/balanceDao.ts · ports/{accountGateway, transactionRunner, domainEventDispatcher, clock}.ts
  infra/         adapters/inbound/{http, grpc, messaging/{accountCreated, orderPlaced, tradeExecuted, orderRemoved, orderVoided}Consumer}
                 adapters/outbound/{persistence/{repositories, daos}, messaging/outboxEventPublisher,
                                    gateways/account/{grpcAccountGateway, accountAcl, accountExistenceChain}}
                 main/{api, worker, migrate}.ts
```

## 11. Testes principais

| Nível | Casos |
|---|---|
| Unidade | Depósito e saque (limites, ativo inválido) · reserva de compra (`qty × price` em USD) e de venda (`qty` em BTC) · reserva repetida é ignorada · saldo insuficiente considerando reservas abertas · liquidação do comprador devolve a diferença de preço · liquidação do vendedor · **`settle` e `release` em qualquer ordem dão o mesmo saldo final** · liberação por remoção STP (`orderRemoved` com motivo `SELF_TRADE_PREVENTION`) · `ReserveFunds` publica rejeição em vez de lançar erro · corrente "conta existe?" · compensação: `order.voided` antes e depois de `order.placed` termina com saldo intacto · depósito com mais casas que a precisão do ativo é rejeitado |
| Integração | Conflito de `version` com duas transações simultâneas · `check` do banco barra saldo negativo · inbox ignora `tradeExecuted` duplicado · ledger registra cada mudança |
| Contrato | Eventos publicados validam nos schemas · `WalletService` implementa o `.proto` |
