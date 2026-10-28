# SDD — Plataforma de Trading

> Fase atual: **spec**. Define o quê e por quê. O como (tarefas, ordem de implementação detalhada) é a fase de **plano**.

## Como ler

| # | Documento | Responde |
|---|---|---|
| — | [objective.md](objective.md) | O problema: regras de negócio, casos de uso, API, glossário |
| 01 | [Princípios](01-principios.md) | Regras de arquitetura: Clean Arch pragmática, DDD tático, Repository × DAO, CQRS e projeções, REST × gRPC, resiliência, código compartilhado, Docker |
| 02 | [Design estratégico](02-design-estrategico.md) | Subdomínios, bounded contexts, por que cada fronteira, linguagem ubíqua, context map |
| 03 | [Mensageria](03-mensageria.md) | RabbitMQ: exchanges, filas, catálogo de eventos, retry/backoff/DLQ, outbox/inbox, ordenação |
| 04 | [Ambiente Docker](04-ambiente-docker.md) | Compose por backend, rede `bridge` única, portas, processos, Compose Watch, e referência de implantação na AWS (fora do escopo) |
| 05 | [Estratégia de testes](05-estrategia-de-testes.md) | Pirâmide: o que vai em cada nível e como rodar |
| 06 | [Sagas coreografadas](06-sagas.md) | Cada saga: transações locais, compensável × pivot × repetível, compensações, timeout, contramedidas de isolamento |
| 07 | [Rate limiting](07-rate-limiting.md) | Limites por tipo de uso (edge por IP + serviço por conta), brute force em autenticação, bloqueio escalonado, DDoS |
| 08 | [Autenticação entre serviços](08-autenticacao-entre-servicos.md) | Nome + token e allowlist no gRPC, usuários e permissões por serviço no RabbitMQ, Postgres e Redis, credenciais no `.env` de cada compose, JWT interno para o usuário (futuro) |
| 99 | [Decisões sobre as lacunas](99-decisoes.md) | As 17 lacunas do objetivo, decididas com base em exchanges e APIs reais, com fontes |

### Serviços

| Serviço | Contexto | Subdomínio | Modelagem | Workload |
|---|---|---|---|---|
| [account](services/account.md) | Identidade e Conta | Generic | Leve | Baixo volume, REST |
| [wallet](services/wallet.md) | Carteira | Supporting (crítico) | Rica | Escrita concorrente por conta |
| [order](services/order.md) | Gestão de Ordens | Core (suporte) | Rica (máquina de estados) | REST + eventos |
| [matching](services/matching.md) | Matching | **Core** | A mais rica | Escritor único por mercado |
| [market-data](services/market-data.md) | Dados de Mercado | Supporting | Sem domínio (CQRS) | Leitura intensa |

## Decisões principais

1. **Cinco bounded contexts, cinco serviços**, cada um com seu Postgres. Ordens e matching são separados porque têm workloads opostos (HTTP escalável × escritor único sequencial).
2. **"Considerar ordens em aberto" = reserva de saldo** no `wallet`. É ela que impede gastar o mesmo saldo duas vezes.
3. **Sagas coreografadas** (S1 abertura de carteira, S2 colocação de ordem, S3 liquidação, S4 cancelamento), sem orquestrador. Cada uma tem dono, pivot e compensações definidos; a S2 tem timeout que expira a ordem e libera a reserva.
4. **Um RabbitMQ.** O produtor declara só a exchange; o consumidor declara a fila e o binding.
5. **Outbox + inbox** em todo serviço: entrega pelo menos uma vez, efeito exatamente uma vez.
6. **Retry com backoff** por filas de atraso (1s → 5s → 25s) + DLQ. A fila do `matching` é a exceção: retry em processo para não quebrar a ordem.
7. **Handlers comutativos** onde a ordem dos eventos não é garantida (liquidação × liberação de reserva; fill × cancelamento).
8. **Repository** para estado de domínio, **DAO** para leitura, ambos com **Kysely** (query builder tipado, sem ORM) e migrações em SQL. **CQRS com tabelas de projeção**: nenhuma leitura pública espera outro serviço.
9. **REST** na API pública, **gRPC** no síncrono interno, sempre com **Gateway + ACL** e só como fallback de projeção.
10. **Ports & Adapters, com pastas simples:** `domain/` (`entities/`, `valueObjects/`, `events/`, `services/`), `application/` (`usecases/`, `dtos/`, `contracts/` com as interfaces) e `infra/` agrupada por tecnologia (`http/`, `grpc/`, `messaging/`, `database/`, `platform/`, `schemas/` com JSON Schema e `.proto`). Casos de uso só conhecem as interfaces.
11. **Fallback com Chain of Responsibility**, terminando sempre em degradação explícita ou erro claro.
12. **Lacunas do objetivo resolvidas com padrões de mercado** ([99](99-decisoes.md)): filtros de tick/step/valor mínimo em vez de arredondamento, prevenção de self-trade, `Idempotency-Key` estilo Stripe, janela móvel de 24 h, rebuild de projeção republicado a partir do banco do produtor (o broker só transporta).
13. **Rate limit por uso** em duas camadas (edge por IP, serviço por conta), com limites mais apertados em autenticação e bloqueio escalonado para quem insiste.
14. **Convenções:** casos de uso com `XxxInput`/`XxxOutput`, camelCase, Object Calisthenics no domínio, comentários em inglês e só em último caso, e um caso de uso nunca chama outro (comunicação por evento também dentro do serviço).
15. **Testes repetíveis:** tempo, id e aleatoriedade controlados, infraestrutura efêmera por worker, rede de teste isolada e **fake de rede** (gRPC/HTTP) para qualquer outro microserviço. Só o E2E sobe os serviços de verdade.
16. **Autenticação entre serviços:** nome + token no metadata do gRPC, com allowlist por método; usuário próprio, com o mínimo de permissão, no RabbitMQ, no Postgres (um usuário por serviço, que migra e acessa os dados) e no Redis. Todas as credenciais de dev ficam no `.env.example` de cada compose. JWT só para a identidade do usuário, quando o login existir.
17. **Serviços independentes, um repositório por serviço:** cada serviço vive no seu repositório (lockfile e Dockerfile próprios, nada de `../`); este repositório é o guarda-chuva e só aponta para eles (`make clone`, [ambiente §0](04-ambiente-docker.md#0-reposit%C3%B3rios-e-layout-da-raiz)). **Nenhum código é compartilhado**: os RNF (retry, outbox, rate limit, token gRPC…) ficam em `src/infra/platform/` de cada serviço, escritos à mão, sem gerador nem template (o próximo serviço copia do anterior e adapta), e os contratos têm dono (o produtor) e cópias nos consumidores, verificadas por `scripts/check-schemas`.
18. **Tudo em Docker**: compose por backend, rede `bridge` única (`trading-net`) com DNS por nome, um `.env.example` por compose com os dados de dev, e desenvolvimento com Compose Watch (alterar código não exige rebuild).

## Roteiro (esboço para a fase de plano)

| Fase | Entrega |
|---|---|
| 0 | Fundação: **apagar o experimento da raiz** ([Q15](99-decisoes.md#q15)), raiz só com `backend/`, `frontend/` e `sdd/`; `backend/infra/` (RabbitMQ, Redis, edge, `trading-net`, contratos sem dono, `.env.example`); `scripts/check-schemas.ts` e `Makefile` da plataforma (`make up`, `make check`…) |
| 1 | `account`, escrito do zero, inclusive `src/infra/platform/`, `test/support/` e o teste de arquitetura |
| 2 | `wallet` (copia do `account` o que precisar e adapta) |
| 3 | `order` |
| 4 | `matching` |
| 5 | `market-data` |
| 6 | E2E, DLQ replay, rebuild de projeções, observabilidade |

Cada fase fecha com a pirâmide de testes do serviço verde em container.
