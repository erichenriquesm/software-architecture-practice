# 04 — Ambiente com Docker

> Status: **spec** · Regra: **tudo roda em container**. Nada de Postgres, RabbitMQ ou Node "da máquina" para rodar ou testar.

---

## 0. Repositórios e layout da raiz

**Um repositório por microserviço**, mais este, que é o **guarda-chuva**: guarda a `sdd/`, a infra compartilhada, os scripts e os `Makefile` da plataforma, e só **aponta** para os serviços. Cada serviço tem descrição e README próprios no repositório dele.

| Serviço | Repositório |
|---|---|
| `account` | [software-architecture-practice-account](https://github.com/erichenriquesm/software-architecture-practice-account) |
| `wallet` | [software-architecture-practice-wallet](https://github.com/erichenriquesm/software-architecture-practice-wallet) |
| `order` | [software-architecture-practice-order](https://github.com/erichenriquesm/software-architecture-practice-order) |
| `matching` | [software-architecture-practice-matching](https://github.com/erichenriquesm/software-architecture-practice-matching) |
| `market-data` | [software-architecture-practice-market-data](https://github.com/erichenriquesm/software-architecture-practice-market-data) |

A lista fica em `backend/repos.txt` (`<pasta> <url>` por linha). `make clone` (em `backend/`) clona em `backend/<serviço>/` os que ainda não estão lá; `make pull` atualiza todos. Essas pastas estão no `.gitignore` do guarda-chuva: cada uma é o clone do repositório do serviço, com o próprio `git`. Não se usa git submodule (versão presa, `submodule update` esquecido e "detached HEAD" no dia a dia); o `make clone` dá o mesmo resultado sem esse custo.

Clonar tudo do zero:
```bash
git clone https://github.com/erichenriquesm/software-architecture-practice.git
```
```bash
cd software-architecture-practice/backend && make clone && make up
```

```
/
  backend/     ← infra local, scripts, Makefile da plataforma e os clones dos serviços (este documento)
  frontend/    ← cliente web, repositório próprio clonado aqui ([frontend](09-frontend.md))
  sdd/         ← specs
  README.md    ← o que é a plataforma, os repositórios e como subir
  .gitignore
```

Nada de código, `package.json` ou `Dockerfile` na raiz. O que existe hoje na raiz é experimento e é apagado no início da fase 0 ([Q15](99-decisoes.md#q15)). Cada pasta de topo é independente. Dentro de `backend/`, cada serviço tem o próprio `package.json`; não há workspace nem `package.json` na raiz do `backend/`.

## 1. Estrutura do `backend/`

```
backend/
  Makefile                    ← make clone / pull / up / watch / migrate / ps / logs / down / test / check / projections-rebuild (§4)
  repos.txt                   ← os repositórios dos serviços (§0)
  docker-compose.yml          ← sobe a plataforma inteira em ambiente local (include de todos os composes)
  infra/                      ← infraestrutura compartilhada; nenhum código de serviço
    docker-compose.yml        ← RabbitMQ único + Redis + edge proxy + rede trading-net
    .env.example              ← credenciais de dev do RabbitMQ e do Redis (§2.2)
    rabbitmq/                 ← definitions.template.json + entrypoint.sh (gera o definitions.json com as senhas do .env)
    redis/entrypoint.sh       ← gera o users.acl com as senhas do .env
    edge/nginx.conf           ← roteamento REST público → serviços
    schemas/                  ← originais sem dono: envelope.schema.json, markets.json (+ schema)
  scripts/                    ← só biblioteca padrão do Node, rodados em container
    check-schemas.ts        ← compara cada cópia de contrato com o original do dono
  account/                    ← clone do repositório do serviço (make clone); projeto STANDALONE
    package.json  package-lock.json
    tsconfig.json  eslint.config.mjs  .dependency-cruiser.cjs  vitest.config.ts
    Makefile                  ← migrações estilo Laravel (§3.3), testes, deps
    .env.example              ← configuração e credenciais de dev do serviço (§2.2)
    .env.test.example         ← hosts e credenciais dos containers efêmeros de teste
    docker/                   ← tudo que é Docker do serviço
      Dockerfile              ← imagem multi-stage; contexto de build = a pasta do serviço (..)
      Dockerfile.dockerignore ← o que não entra no contexto de build
      docker-compose.yml      ← ambiente local: account-api, account-worker, account-db (sobe sozinho)
      docker-compose.platform.yml ← só a ligação com a plataforma (ex.: o worker espera o rabbitmq)
      docker-compose.test.yml ← testes de integração com infra efêmera e rede isolada
    src/
      domain/                 ← entities/, valueObjects/, events/ (e services/ quando houver)
      application/            ← usecases/, contracts/
      infra/
        http/ grpc/ messaging/ database/
        platform/             ← RNF escritos no serviço: resilience/, messaging/, http/, security/
        schemas/              ← published/ (dono) e consumed/ (cópias), envelope, markets.json
        database/migrations/  ← migrações estilo Laravel (up/down)
        api.ts  worker.ts  migrate.ts
    test/                     ← unit/ e integration/ (espelham src/), fakes/, support/
  wallet/       (mesma estrutura)
  order/        (mesma estrutura)
  matching/     (mesma estrutura, sem api pública)
  market-data/  (mesma estrutura)
  e2e/
    docker-compose.yml        ← roda os testes ponta a ponta contra a plataforma inteira
```

---

## 2. Infraestrutura compartilhada (`backend/infra/docker-compose.yml`)

| Serviço | Imagem | Porta host | Observação |
|---|---|---|---|
| `rabbitmq` | `rabbitmq:4-management-alpine` | 5672, 15672 (painel) | **Único broker** da plataforma. Sobe com o vhost, os usuários por serviço, as permissões e as exchanges, com as senhas do `.env` da infra. Healthcheck `rabbitmq-diagnostics -q check_running` (o `ping` responde antes de o nó terminar de subir). |
| `edge` | `nginx:alpine` | 8080 | Reverse proxy da API pública REST. Sem regra de negócio; aplica rate limit por IP, limites de conexão e microcache ([rate limiting §2](07-rate-limiting.md#2-camada-1--edge-nginx)). |
| `redis` | `redis:7-alpine` | 6379 | Sobe com um usuário por serviço, com as senhas do `.env` da infra. Contadores de rate limit, compartilhados entre réplicas. Técnico, como o broker; não guarda dado de domínio ([rate limiting §8](07-rate-limiting.md#8-infraestrutura)). |

Cria a rede **`trading-net`**, que os composes dos serviços declaram de forma idêntica (§2.1).

O `edge` precisa subir mesmo quando algum serviço ainda não existe (por exemplo, na fase 0 ou com um serviço parado). Por isso o nginx resolve os nomes **na hora da requisição**, e não no boot: `resolver 127.0.0.11 valid=10s` (o DNS interno do Docker) e o destino em variável (`set $account http://account-api:3000; proxy_pass $account;`). Serviço ausente responde `502` só naquela rota.

## 2.1 Rede: uma `bridge` para todos

```yaml
# backend/infra/docker-compose.yml
networks:
  trading-net:
    name: trading-net
    driver: bridge
```

```yaml
# backend/<svc>/docker/docker-compose.yml (identical declaration)
networks:
  trading-net:
    name: trading-net
    driver: bridge
```

A rede é declarada **igual** em todos os composes, e não como `external`. Com o `include` do compose da plataforma, a declaração `external` repetida conflita com a rede importada e falha de forma intermitente na primeira subida (verificado em container). Com a mesma declaração, o compose reconhece que é a mesma rede, e cada compose também sobe sozinho.

- **Todos os containers** (serviços, bancos, RabbitMQ, Redis, edge) entram na `trading-net`.
- Numa rede `bridge` definida pelo usuário, o Docker tem **DNS interno**: cada container é encontrado pelo **nome do serviço no compose**. Ninguém usa IP.
- Por isso os nomes de serviço são **fixos e únicos na plataforma**: `rabbitmq`, `edge`, `<svc>-db`, `<svc>-api`, `<svc>-worker`. Dois composes não podem usar o mesmo nome.
- **Endereços e credenciais vêm do `.env` de cada compose** (§2.2), sempre com o nome DNS, nunca IP.
- Dentro da rede, as **portas são as internas e iguais em todos os serviços** (REST `3000`, gRPC `50051`, Postgres `5432`). As portas do host (§3) existem só para acessar de fora do Docker durante a depuração.
- Isolamento não depende da rede: cada serviço tem credenciais próprias em cada canal (token no gRPC, usuário no RabbitMQ, Postgres e Redis), com o mínimo de permissão ([autenticação entre serviços](08-autenticacao-entre-servicos.md)).

## 2.2 `.env.example` por compose

Cada compose tem, ao lado dele, um **`.env.example` versionado**, com os valores de desenvolvimento já prontos para rodar em container:

| Onde | O que tem |
|---|---|
| `backend/infra/.env.example` | Usuário e senha de admin do RabbitMQ; usuário e senha de cada serviço no RabbitMQ e no Redis |
| `backend/<svc>/.env.example` | Hosts (nomes DNS), portas, nome do banco, usuário e senha do Postgres (um só por serviço), usuário e senha do serviço no RabbitMQ e no Redis, endereço gRPC de quem ele chama e o token gRPC compartilhado (§2.3), nível de log, limites de rate limit |

Para subir: `cp .env.example .env` em cada pasta. O `.env` está no `.gitignore`; o `.env.example` é a referência e sempre tem todas as variáveis. O compose lê o `.env` com `env_file: .env`.

Exemplo `backend/wallet/.env.example`:

```bash
DATABASE_HOST=wallet-db
DATABASE_PORT=5432
DATABASE_NAME=wallet
DATABASE_USER=wallet
DATABASE_PASSWORD=wallet-db-dev
RABBITMQ_HOST=rabbitmq
RABBITMQ_USER=wallet
RABBITMQ_PASSWORD=wallet-rabbitmq-dev
REDIS_HOST=redis
REDIS_USER=wallet
REDIS_PASSWORD=wallet-redis-dev
ACCOUNT_GRPC_ADDR=account-api:50051
ACCOUNT_GRPC_TOKEN=internal-grpc-dev
LOG_LEVEL=debug
```

- As senhas são **só de desenvolvimento**, e é por isso que podem estar no git. Em qualquer outro ambiente, as variáveis vêm do gerenciador de segredos (§6).
- A senha do serviço no RabbitMQ e no Redis aparece em dois lugares: no `.env` da infra (que cria o usuário) e no `.env` do serviço (que conecta). Os dois `.env.example` usam o mesmo valor.
- Variável nova no código = variável nova no `.env.example` no mesmo commit.

## 2.3 Token do gRPC interno

O gRPC interno confere um **token compartilhado** antes de executar o método. Hoje só o `account` expõe gRPC, e só o `wallet` chama.

**Quem chama** manda o token no metadata de toda chamada:

```
x-service-token: internal-grpc-dev
```

```bash
# backend/account/.env.example (server)
GRPC_TOKEN=internal-grpc-dev
```
```bash
# backend/wallet/.env.example (client)
ACCOUNT_GRPC_ADDR=account-api:50051
ACCOUNT_GRPC_TOKEN=internal-grpc-dev
```

| Situação | Resposta |
|---|---|
| Token bate | Executa o método |
| Sem token ou token errado | `UNAUTHENTICATED`, sem retry ([autenticação §2](08-autenticacao-entre-servicos.md#2-grpc-interno-token-compartilhado)) |

A checagem é um interceptor em `src/infra/platform/security/` do `account`, que roda antes de qualquer handler. O token aparece nos dois `.env.example`, com o mesmo valor.

O tráfego gRPC não é criptografado: fica dentro da `trading-net`. Fora do ambiente local, o token vem do gerenciador de segredos (§6), e TLS pode ser ligado no canal sem mudar essa checagem.

---

## 3. Compose de cada backend

Todo serviço segue o mesmo molde. Exemplo `backend/wallet/docker/docker-compose.yml`:

| Container | Comando (dev) | Depende de |
|---|---|---|
| `wallet-db` | `postgres:17-alpine`, volume `wallet-db-data` | — |
| `wallet-api` | `tsx src/infra/api.ts` (REST) | `wallet-db` saudável |
| `wallet-worker` | `tsx src/infra/worker.ts` (consumidores + outbox relay) | `wallet-db` saudável, `rabbitmq` |

Não existe container de migração: as migrações rodam por comando (`make migrate`, §3.3), dentro do container do serviço que já está de pé.

O `docker-compose.yml` de cada serviço é o de **desenvolvimento** (§3.1) e sobe sozinho, desde que a infraestrutura compartilhada já esteja de pé. O que só faz sentido dentro da plataforma (por exemplo, o worker esperar o `rabbitmq` ficar saudável) fica em `docker/docker-compose.platform.yml`, que o `backend/docker-compose.yml` inclui junto: `include: [{ path: [<svc>/docker/docker-compose.yml, <svc>/docker/docker-compose.platform.yml], env_file: <svc>/.env }]`. O `env_file` do `include` é o que permite ao compose ler as variáveis do `.env` do serviço (por exemplo, `${DATABASE_USER}` no Postgres), já que o compose fica em `docker/` e o `.env` na raiz do serviço.

**Compose é só para o ambiente local.** Produção não usa compose: usa a imagem do estágio `runtime` do `Dockerfile` (§5) num orquestrador (§6).

- **Mesma imagem, processos diferentes.** `api` e `worker` escalam de forma independente, porque o workload é diferente: `api` responde request; `worker` consome fila.
- **Um Postgres por serviço**, no compose do próprio serviço. Banco `wallet`, schema padrão (`public`). Ninguém mais conecta nele. O próprio Postgres cria banco e usuário no primeiro boot, a partir de `DATABASE_NAME`, `DATABASE_USER` e `DATABASE_PASSWORD` do `.env` (sem script de init).
- Configuração por variável de ambiente, vinda do `.env` do serviço (§2.2), usando nomes DNS da `trading-net`. Sem IP.
- Healthcheck em todo container de longa duração (`/health` no `api`; o `worker` também expõe `/health` numa porta interna e responde `503` enquanto está sem conexão com o RabbitMQ). Se a conexão com o broker cair, o worker sai com código 1 e o Docker o reinicia: `api` e `worker` têm `restart: unless-stopped` ([mensageria §4](03-mensageria.md#4-retry-backoff-e-dlq)).
- Um único usuário por serviço no Postgres: o mesmo migra e acessa os dados ([autenticação §4](08-autenticacao-entre-servicos.md#4-postgres-um-usu%C3%A1rio-por-servi%C3%A7o)).

### 3.1 Desenvolvimento sem rebuild (Compose Watch)

**Regra: no dia a dia, nenhuma alteração de código exige rebuildar o container.** Só mudança de dependência ou do próprio `Dockerfile` exige.

Mecanismo: **Compose Watch** (`develop.watch`, Docker Compose ≥ 2.22) sincroniza os arquivos alterados para dentro do container em execução e reinicia o container (`sync+restart`). Não usamos `tsx watch`: ele mantém o container vivo quando o processo cai, e aí o `restart: unless-stopped` nunca age. Escolhido em vez de bind mount porque não sobrescreve o `node_modules` do container e funciona bem no macOS.

```yaml
# backend/wallet/docker/docker-compose.yml (local development)
services:
  wallet-api:
    container_name: wallet-api
    build:
      context: ..                       # the service folder only
      dockerfile: docker/Dockerfile
      target: dev
    working_dir: /app
    command: sh -c "npm run proto:gen && exec npx tsx src/infra/api.ts"
    env_file: ../.env                   # copied from .env.example (§2.2)
    restart: unless-stopped             # the worker exits when the broker drops; Docker brings it back
    networks: [trading-net]
    depends_on:
      wallet-db:
        condition: service_healthy
    develop:
      watch:
        - action: sync+restart          # own code: sync, then restart the container
          path: ../src
          target: /app/src
          ignore:
            - infra/schemas/
        - action: sync+restart          # schemas: restart regenerates the gRPC code
          path: ../src/infra/schemas
          target: /app/src/infra/schemas
        - action: rebuild               # dependencies changed
          path: ../package.json
        - action: rebuild
          path: ../package-lock.json
        - action: rebuild
          path: ./Dockerfile
```

O `wallet-worker` tem o mesmo bloco `develop.watch` e o mesmo `restart`, com `command` apontando para `worker.ts`.

**O que exige o quê**

| Alteração | Precisa rebuild? | O que acontece |
|---|---|---|
| Código do serviço (`src/`) | **Não** | `sync+restart` → o container reinicia em ~2 s |
| `src/infra/schemas/` do serviço (inclusive `.proto`) | **Não** | `sync+restart` → o comando regenera o código do gRPC e sobe |
| Nova migração | **Não** | `make migration name=...` cria o arquivo e `make migrate` aplica (§3.3) |
| Variável de ambiente no compose | **Não** | `docker compose up -d` recria só o container, com a mesma imagem |
| Teste | **Não** | `docker compose exec wallet-api npx vitest` (modo watch) |
| `package.json` / `package-lock.json` do serviço | Sim | `rebuild` automático pelo watch |
| `Dockerfile` | Sim | `rebuild` automático pelo watch |

Subir em modo desenvolvimento:
```bash
docker compose -f backend/docker-compose.yml up --watch
```

### 3.3 Migrações (estilo Laravel)

As migrações ficam em `src/infra/database/migrations/` e **não têm container próprio**: rodam por comando, dentro do container `<svc>-api` que já está de pé (no `matching`, que não tem `api`, dentro do `<svc>-worker`). É o mesmo fluxo do `php artisan` dentro do container da aplicação. Cada serviço tem um `Makefile` com os comandos; rode dentro de `backend/<svc>/`, com a plataforma de pé:

| Laravel | Aqui |
|---|---|
| `php artisan migrate` | `make migrate` |
| `php artisan migrate:rollback` | `make migrate-rollback` |
| `php artisan migrate:status` | `make migrate-status` |
| `php artisan migrate:fresh` | `make migrate-fresh` |
| `php artisan make:migration create_x_table` | `make migration name=create_x_table` |

- Primeira subida (ou banco novo): `docker compose -f backend/docker-compose.yml up -d` e depois `make migrate`. Até migrar, o `api` responde, mas qualquer rota que toque o banco falha.
- `make migration` sobe um container avulso com a pasta de migrações do host montada (`-v`), para o arquivo novo aparecer no seu código.
- Por baixo, cada alvo do `Makefile` é um `docker compose exec <svc>-api npm run migrate…`.

### 3.2 Imagem final

A imagem de produção é o estágio `runtime` do `Dockerfile` (§5): `node dist/infra/api.js`, `worker.js` ou `migrate.js`, conforme o processo. Ela não tem compose próprio. Para conferir localmente que ela builda:
```bash
docker build -f backend/<svc>/docker/Dockerfile --target runtime backend/<svc>
```

### Processos por serviço

| Serviço | `api` (REST) | gRPC interno | `worker` |
|---|---|---|---|
| `account` | sim | sim (`AccountService.Exists`) | sim (outbox + projeção de saldos) |
| `wallet` | sim | não (só cliente do `account`) | sim (consumidores + outbox) |
| `order` | sim | não | sim |
| `matching` | **não** (só `/health`) | não | sim (um consumidor ativo por mercado) |
| `market-data` | sim | não | sim (projeções) |

### Portas no host (só para depuração local)

Dentro da `trading-net` os containers se acham pelo nome e usam as portas internas (`account-api:50051`, `wallet-db:5432`). As portas abaixo são só o mapeamento para o host, para depurar.

| Serviço | REST | gRPC | Postgres |
|---|---|---|---|
| `account` | 3001 | 50051 | 5433 |
| `wallet` | 3002 | — | 5434 |
| `order` | 3003 | — | 5435 |
| `matching` | 3004 (`/health`) | — | 5436 |
| `market-data` | 3005 | — | 5437 |

---

## 4. Como subir

Tudo pelo `Makefile` de `backend/` (a plataforma inteira) e pelo `Makefile` de cada serviço (as migrações dele, §3.3). Rode dentro de `backend/`:

| Comando | O que faz |
|---|---|
| `make clone` · `make pull` | Clona os repositórios dos serviços que faltam em `backend/<serviço>/` · atualiza todos (`git pull --ff-only`) (§0) |
| `make up` | Cria os `.env` que faltam a partir dos `.env.example`, instala as dependências do editor dos serviços que ainda não têm `node_modules` (como `make deps`), builda, sobe infra + serviços, espera ficarem saudáveis e roda `make migrate` em cada serviço |
| `make watch` | O mesmo, em primeiro plano com Compose Watch (§3.1): alterar código não exige rebuild |
| `make infra` | Sobe só a infra compartilhada (RabbitMQ, Redis, edge) |
| `make migrate` | Roda as migrações pendentes de todos os serviços |
| `make ps` | Lista os containers e a saúde de cada um |
| `make logs` · `make logs s=account-api` | Segue os logs de tudo ou de um container |
| `make down` | Para tudo (os volumes ficam) |
| `make test` | Todos os tipos de teste de todos os serviços (checagens estáticas, unidade, integração e contrato) e depois `make check`. Não precisa da plataforma de pé |
| `make check` | Confere as cópias de contrato e o layout da raiz |
| `make env` | Só cria os `.env` que ainda não existem (nunca sobrescreve) |
| `make deps` | Instala o `node_modules` e gera o código gRPC de cada serviço **na sua máquina**, via container, só para o editor enxergar tipos e imports. Rode de novo quando mudar `package.json` ou um `.proto` |

Um serviço sozinho continua possível, com a infra de pé: `docker compose -f backend/<svc>/docker/docker-compose.yml --env-file backend/<svc>/.env up --watch`.

## 5. Dockerfile de cada serviço

Multi-stage, com testes de unidade dentro do build:

1. **deps** — `npm ci` com devDependencies, a partir do `package.json` e do `package-lock.json` **do serviço**. O contexto de build é só a pasta do serviço: nada de fora dela entra na imagem.
2. **dev** — `deps` + código-fonte + `tsx`. É o alvo do `docker/docker-compose.yml` (só local): o código é atualizado pelo Compose Watch, sem rebuild (§3.1). Roda como **root**, porque gera arquivos (código do protobuf, arquivos temporários do Vitest) em diretórios criados pela camada `deps`. Só a imagem final é não-root.
3. **build** — gera o código do gRPC (`src/infra/generated/`) a partir dos `.proto` de `src/infra/schemas/`, compila e **roda os testes de unidade**. Teste vermelho = imagem não é gerada.
4. **runtime** — `node:26-alpine`, só dependências de produção e `dist/`. Usuário não-root (`node`, uid 1000). É a imagem de produção (§3.2, §6).

Testes de integração **não** rodam no build, porque precisam de Postgres/RabbitMQ. Eles rodam no `docker/docker-compose.test.yml` (ver [testes](05-estrategia-de-testes.md#5-como-rodar)).

---

## 6. Referência de implantação na AWS (fora do escopo)

> **Não faz parte do conceito**, que roda inteiro em Docker local. Esta seção é um passo a passo neutro: diz **o que** cada peça local vira na AWS e **em que ordem** montar. Onde há mais de uma opção, cada passo traz o critério para escolher, sem preferência. Nenhum serviço muda: eles só conhecem variáveis de ambiente e nomes de host.

### 6.1 Equivalências

| Peça local | Função | Equivalente na AWS |
|---|---|---|
| `*-api`, `*-worker` | Processos dos serviços | Amazon ECS (Fargate ou EC2) ou Amazon EKS |
| `make migrate` | Migração antes de subir | Tarefa avulsa do ECS ou Job do EKS, com a imagem do serviço rodando `node dist/infra/migrate.js` |
| `<svc>-db` | Um Postgres por serviço | Amazon RDS for PostgreSQL ou Amazon Aurora PostgreSQL |
| `rabbitmq` | Broker único | Amazon MQ for RabbitMQ ou RabbitMQ autogerenciado em container |
| `redis` | Contadores de rate limit | Amazon ElastiCache (Redis OSS ou Valkey) |
| DNS da `trading-net` | Serviço acha serviço pelo nome | ECS Service Connect, AWS Cloud Map ou DNS de Service do Kubernetes |
| `environment` do compose | Configuração | Task definition / manifesto, com segredos no AWS Secrets Manager ou no SSM Parameter Store |
| `edge`: roteamento | Rota → serviço | Application Load Balancer ou Amazon API Gateway |
| `edge`: rate limit por IP | Proteção por IP | AWS WAF (regras por taxa) |
| `edge`: microcache de 1 s | Cache de leitura pública | Amazon CloudFront |
| (fora do conceito) ataque volumétrico | Proteção de rede | AWS Shield |
| Logs no console | Observabilidade | Amazon CloudWatch |

### 6.2 Passo a passo

**Passo 1 — Imagens**
1. Crie um repositório no **Amazon ECR** por serviço.
2. Gere a imagem no alvo `runtime` do `docker/Dockerfile` (§5).
3. Envie cada imagem para o ECR com uma tag imutável (ex.: o hash do commit).

**Passo 2 — Rede**
1. Crie uma **VPC** com subnets públicas (só para a borda) e privadas (serviços, bancos, broker, Redis).
2. Crie um **security group** por peça. Regras de entrada:
   - banco de cada serviço: só a partir dos processos daquele serviço;
   - broker e Redis: só a partir dos processos dos serviços;
   - processos `api`: só a partir da borda e, na porta gRPC, dos serviços que os chamam;
   - processos `worker`: nenhuma entrada.

**Passo 3 — Dados e mensageria**
1. **Postgres**: um banco por serviço, cada um com usuário e senha próprios.
   - Escolha **RDS for PostgreSQL** se basta uma instância com réplica de failover.
   - Escolha **Aurora PostgreSQL** se precisar de réplicas de leitura com pouco atraso ou armazenamento que cresce sozinho.
2. **Broker**: o projeto exige do RabbitMQ: exchanges `topic`, quorum queues, `x-single-active-consumer`, filas com TTL e dead-letter. Não usa streams: o rebuild de projeção é republicado pelo produtor ([mensageria §8](03-mensageria.md#8-rebuild-de-proje%C3%A7%C3%B5es-republish-a-partir-do-produtor)).
   - Escolha **Amazon MQ for RabbitMQ** se a versão disponível suportar todos esses recursos.
   - Escolha **RabbitMQ autogerenciado em container** se algum deles não for suportado.
3. **Redis**: um cluster no **ElastiCache**. Cada serviço usa o próprio prefixo de chave, como no local.

**Passo 4 — Segredos e configuração**
1. Guarde as strings de conexão e as senhas no **Secrets Manager** ou no **SSM Parameter Store**.
2. As demais variáveis do compose (§2.1) viram variáveis da task definition ou do manifesto, com os mesmos nomes.

**Passo 5 — Processos**
1. Para cada serviço, crie:
   - uma definição para o `api` e outra para o `worker`, com a mesma imagem e comandos diferentes (§3.2);
   - uma tarefa avulsa de migração: a mesma imagem, com o comando `node dist/infra/migrate.js`.
2. Ordem de cada implantação: rode a migração → espere terminar com sucesso → atualize `api` e `worker`.
3. Escalonamento:
   - `api` e `worker` escalam separadamente;
   - o `worker` do `matching` pode ter várias réplicas, mas só uma consome cada mercado (`single-active-consumer`, [mensageria §6](03-mensageria.md#6-ordem-garantida-a-fila-do-matching)).
4. Health check: use o `/health` que todo processo já expõe (§3).
5. Orquestrador:
   - Escolha **ECS** se quiser menos peças para operar.
   - Escolha **EKS** se já houver operação de Kubernetes ou se precisar de portabilidade entre nuvens.

**Passo 6 — Descoberta de serviço (gRPC interno)**
1. Registre cada `api` com o mesmo nome usado no compose (`account-api`, `wallet-api`), para que `ACCOUNT_GRPC_ADDR` e afins não mudem.
2. Use o mecanismo do orquestrador escolhido no passo 5: **Service Connect** / **Cloud Map** no ECS, ou **Service** no EKS.

**Passo 7 — Borda (o papel do `edge`)**
1. **Roteamento**: crie as rotas da API pública ([design estratégico §6](02-design-estrategico.md#6-mapa-de-endpoints-p%C3%BAblicos-rest--contexto)) apontando para o `api` de cada serviço.
   - Escolha **Application Load Balancer** se a borda só precisa rotear.
   - Escolha **API Gateway** se a borda também for autenticar por API key + HMAC ([Q4](99-decisoes.md#q4)), com um autorizador.
2. **Rate limit por IP**: no **WAF**, crie uma regra por taxa para cada zona do edge, com os mesmos números ([rate limiting §2](07-rate-limiting.md#2-camada-1--edge-nginx)), e associe ao ALB, ao API Gateway ou ao CloudFront.
3. **Microcache**: no **CloudFront**, crie um comportamento para `/markets/*` com TTL de 1 s. As demais rotas passam sem cache.
4. **Ataque volumétrico**: o **Shield Standard** vem com o CloudFront. Avalie o **Shield Advanced** se houver exigência de proteção contratada.

O rate limit **por conta** **não** vai para a borda: continuam no plugin de rate limit de cada serviço (`src/infra/platform/http/`), porque a borda enxerga IP e API key, não o `accountId` que vem no corpo.

**Passo 8 — Observabilidade**
1. Envie os logs de todos os processos para o **CloudWatch Logs**. O `correlationId` continua em toda linha.
2. Crie alarmes para os mesmos sinais do local:
   - mensagens em qualquer DLQ;
   - ordens em `pending` ou `cancelling` além do limite ([sagas §6](06-sagas.md#6-observabilidade));
   - taxa de `429`.

**Passo 9 — Verificação**
1. Rode a suíte **E2E** ([testes §2](05-estrategia-de-testes.md#2-o-que-vai-em-cada-n%C3%ADvel)) contra o endereço público da borda.
2. A implantação só está pronta com os 4 caminhos críticos verdes.

### 6.3 Termo que não deve ser confundido

O *Gateway + ACL* desta spec ([princípios §4](01-principios.md#4-integra%C3%A7%C3%A3o-s%C3%ADncrona-gateway--acl)) é um padrão de código: o adapter que chama outro serviço por gRPC e traduz o modelo dele. Não tem relação com o Amazon API Gateway do passo 7.
