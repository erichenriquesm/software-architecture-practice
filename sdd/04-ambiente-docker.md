# 04 — Ambiente com Docker

> Status: **spec** · Regra: **tudo roda em container**. Nada de Postgres, RabbitMQ ou Node "da máquina" para rodar ou testar.

---

## 0. Layout da raiz do repositório

```
/
  backend/     ← todos os microserviços, contratos, libs e infra local (este documento)
  frontend/    ← cliente web (fora do escopo desta spec por enquanto)
  sdd/         ← specs
  .gitignore
```

Nada de código, `package.json` ou `Dockerfile` na raiz. O que existe hoje na raiz é experimento e é apagado no início da fase 0 ([Q15](99-decisoes.md#q15)). Cada pasta de topo é independente: `backend/` tem seu próprio `package.json` (raiz dos npm workspaces), e `frontend/` terá o dele.

## 1. Estrutura do `backend/`

```
backend/
  package.json                ← raiz dos npm workspaces (libs, contracts e serviços)
  tsconfig.base.json
  docker-compose.yml          ← sobe a plataforma inteira (include de todos os composes)
  infra/
    docker-compose.yml        ← security-init + RabbitMQ único + Redis + edge proxy + rede trading-net
    security/                 ← imagem do security-init (CA, certificados, senhas, definitions.json, users.acl)
    edge/nginx.conf           ← roteamento REST público → serviços
  contracts/                  ← events/*.schema.json, proto/*.proto, markets.json
  libs/                       ← messaging, resilience, http, security, testing
  service-template/           ← serviço mínimo funcional e testado; base de todo serviço novo
  scripts/scaffold.ts         ← npm run scaffold -- <svc>: copia o template e troca os nomes
  account/
    docker-compose.yml        ← account-api, account-worker, account-migrate, account-db
    Dockerfile
    src/ (domain, application, infra)
    migrations/
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
| `security-init` | imagem própria de `backend/infra/security/` | — | Roda uma vez antes de tudo: gera CA local, certificados por serviço, senhas e as configurações de usuário do RabbitMQ e do Redis no volume `trading-secrets` ([autenticação §1](08-autenticacao-entre-servicos.md#1-segredos-e-certificados-no-ambiente-local)). |
| `rabbitmq` | `rabbitmq:4-management-alpine` | 5672, 15672 (painel) | **Único broker** da plataforma. Carrega o `definitions.json` (vhost, usuários, permissões e exchanges) gerado pelo `security-init`. Healthcheck `rabbitmq-diagnostics -q check_running` (o `ping` responde antes de o nó terminar de subir). |
| `edge` | `nginx:alpine` | 8080 | Reverse proxy da API pública REST. Sem regra de negócio; aplica rate limit por IP, limites de conexão e microcache ([rate limiting §2](07-rate-limiting.md#2-camada-1--edge-nginx)). |
| `redis` | `redis:7-alpine` | 6379 | Carrega o `users.acl` do `security-init` (um usuário por serviço). Contadores de rate limit e lista de bloqueio, compartilhados entre réplicas. Técnico, como o broker; não guarda dado de domínio ([rate limiting §8](07-rate-limiting.md#8-infraestrutura)). |

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
# backend/<svc>/docker-compose.yml (identical declaration)
networks:
  trading-net:
    name: trading-net
    driver: bridge
```

A rede é declarada **igual** em todos os composes, e não como `external`. Com o `include` do compose da plataforma, a declaração `external` repetida conflita com a rede importada e falha de forma intermitente na primeira subida (verificado em container). Com a mesma declaração, o compose reconhece que é a mesma rede, e cada compose também sobe sozinho.

- **Todos os containers** (serviços, bancos, RabbitMQ, Redis, edge) entram na `trading-net`.
- Numa rede `bridge` definida pelo usuário, o Docker tem **DNS interno**: cada container é encontrado pelo **nome do serviço no compose**. Ninguém usa IP.
- Por isso os nomes de serviço são **fixos e únicos na plataforma**: `rabbitmq`, `edge`, `<svc>-db`, `<svc>-api`, `<svc>-worker`. Dois composes não podem usar o mesmo nome.
- **Endereços ficam no próprio `docker-compose.yml`**, em `environment`, já com o nome DNS:
  ```yaml
  environment:
    DATABASE_HOST: wallet-db
    DATABASE_NAME: wallet
    DATABASE_USER: wallet_app
    DATABASE_PASSWORD_FILE: /run/secrets/wallet-db-app-password
    RABBITMQ_HOST: rabbitmq
    RABBITMQ_USER: wallet
    RABBITMQ_PASSWORD_FILE: /run/secrets/wallet-rabbitmq-password
    REDIS_HOST: redis
    REDIS_USER: wallet
    REDIS_PASSWORD_FILE: /run/secrets/wallet-redis-password
    ACCOUNT_GRPC_ADDR: account-api:50051
    TLS_CA_FILE: /run/secrets/ca.crt
    TLS_CERT_FILE: /run/secrets/wallet.crt
    TLS_KEY_FILE: /run/secrets/wallet.key
  ```
  Endereços vêm do compose com nome DNS; **senhas, chaves e certificados nunca**: o código lê o conteúdo dos arquivos `*_FILE`, montados pelo volume `trading-secrets` ([autenticação §1](08-autenticacao-entre-servicos.md#1-segredos-e-certificados-no-ambiente-local)). **Não é preciso `.env` para comunicação.** `.env` só existe, opcionalmente, para sobrescrever algo localmente (ex.: nível de log).
- Dentro da rede, as **portas são as internas e iguais em todos os serviços** (REST `3000`, gRPC `50051`, Postgres `5432`). As portas do host (§3) existem só para acessar de fora do Docker durante a depuração.
- Isolamento não depende da rede: cada serviço tem credenciais próprias em cada canal (mTLS no gRPC, usuário no RabbitMQ, Postgres e Redis), com o mínimo de permissão ([autenticação entre serviços](08-autenticacao-entre-servicos.md)).

---

## 3. Compose de cada backend

Todo serviço segue o mesmo molde. Exemplo `backend/wallet/docker-compose.yml`:

| Container | Comando (dev) | Depende de |
|---|---|---|
| `wallet-db` | `postgres:17-alpine`, volume `wallet-db-data` | — |
| `wallet-migrate` | `tsx src/infra/main/migrate.ts` (roda e sai) | `wallet-db` saudável |
| `wallet-api` | `tsx watch src/infra/main/api.ts` (REST + gRPC) | `wallet-migrate` concluído |
| `wallet-worker` | `tsx watch src/infra/main/worker.ts` (consumidores + outbox relay) | `wallet-migrate` concluído, `rabbitmq` |

O `docker-compose.yml` de cada serviço é o de **desenvolvimento** (§3.1). A imagem de execução (sem watch, com `dist/`) vem do override `docker-compose.runtime.yml` (§3.2).

- **Mesma imagem, processos diferentes.** `api` e `worker` escalam de forma independente, porque o workload é diferente: `api` responde request; `worker` consome fila.
- **Um Postgres por serviço**, no compose do próprio serviço. Banco `wallet`, schema `wallet`. Ninguém mais conecta nele.
- Configuração por variável de ambiente declarada no próprio compose, usando nomes DNS da `trading-net` (§2.1). Sem IP, sem `.env` obrigatório.
- Healthcheck em todo container de longa duração (`/health` no `api`; o `worker` também expõe `/health` numa porta interna).
- `<svc>-migrate` usa o usuário `<svc>_migrator`; `api` e `worker` usam `<svc>_app`, que não altera estrutura ([autenticação §4](08-autenticacao-entre-servicos.md#4-postgres-dois-usu%C3%A1rios-por-servi%C3%A7o)).

### 3.1 Desenvolvimento sem rebuild (Compose Watch)

**Regra: no dia a dia, nenhuma alteração de código exige rebuildar o container.** Só mudança de dependência ou do próprio `Dockerfile` exige.

Mecanismo: **Compose Watch** (`develop.watch`, Docker Compose ≥ 2.22) sincroniza os arquivos alterados para dentro do container em execução, e o `tsx watch` reinicia o processo Node sozinho. Escolhido em vez de bind mount porque não sobrescreve o `node_modules` do container e funciona bem no macOS.

```yaml
# backend/wallet/docker-compose.yml (development)
services:
  wallet-api:
    container_name: wallet-api
    build:
      context: ..                       # backend/ (workspace root)
      dockerfile: wallet/Dockerfile
      target: dev
    working_dir: /app/wallet
    command: sh -c "npm run proto:gen -w contracts && npx tsx watch src/infra/main/api.ts"
    environment:
      DATABASE_HOST: wallet-db
      DATABASE_NAME: wallet
      DATABASE_USER: wallet_app
      DATABASE_PASSWORD_FILE: /run/secrets/wallet-db-app-password
      RABBITMQ_HOST: rabbitmq
      RABBITMQ_USER: wallet
      RABBITMQ_PASSWORD_FILE: /run/secrets/wallet-rabbitmq-password
      REDIS_HOST: redis
      REDIS_USER: wallet
      REDIS_PASSWORD_FILE: /run/secrets/wallet-redis-password
      ACCOUNT_GRPC_ADDR: account-api:50051
      TLS_CA_FILE: /run/secrets/ca.crt
      TLS_CERT_FILE: /run/secrets/wallet.crt
      TLS_KEY_FILE: /run/secrets/wallet.key
    networks: [trading-net]
    depends_on:
      wallet-migrate:
        condition: service_completed_successfully
    develop:
      watch:
        - action: sync                  # own code: hot reload via tsx watch
          path: ./src
          target: /app/wallet/src
        - action: sync                  # shared technical libs
          path: ../libs
          target: /app/libs
          ignore: [node_modules/]
        - action: sync                  # event JSON Schemas and markets.json
          path: ../contracts
          target: /app/contracts
        - action: sync+restart          # .proto: restart regenerates contracts/generated
          path: ../contracts/proto
          target: /app/contracts/proto
        - action: sync                  # new migrations, applied by re-running wallet-migrate
          path: ./migrations
          target: /app/wallet/migrations
        - action: rebuild               # dependencies changed
          path: ./package.json
        - action: rebuild
          path: ../package-lock.json
        - action: rebuild
          path: ./Dockerfile
```

O `wallet-worker` tem o mesmo bloco `develop.watch`, com `command` apontando para `worker.ts`.

**O que exige o quê**

| Alteração | Precisa rebuild? | O que acontece |
|---|---|---|
| Código do serviço (`src/`) | **Não** | `sync` → `tsx watch` reinicia em ~1 s |
| `libs/` | **Não** | `sync` → reinício de todos os serviços que usam a lib |
| JSON Schema de evento, `markets.json` | **Não** | `sync` → reinício |
| `.proto` | **Não** | `sync+restart` → o comando regenera `contracts/generated/` e sobe |
| Nova migração | **Não** | `sync` + `docker compose run --rm wallet-migrate` |
| Variável de ambiente no compose | **Não** | `docker compose up -d` recria só o container, com a mesma imagem |
| Teste | **Não** | `docker compose exec wallet-api npx vitest` (modo watch) |
| `package.json` / `package-lock.json` | Sim | `rebuild` automático pelo watch |
| `Dockerfile` | Sim | `rebuild` automático pelo watch |

Subir em modo desenvolvimento:
```bash
docker compose -f backend/docker-compose.yml up --watch
```

### 3.2 Modo de execução (imagem final)

`docker-compose.runtime.yml`, ao lado de cada `docker-compose.yml`, sobrescreve só o necessário: `target: runtime`, `command: node dist/infra/main/api.js` e **sem** `develop`. É o modo usado pelos testes E2E e para validar a imagem que seria implantada.
```bash
docker compose -f backend/docker-compose.yml -f backend/docker-compose.runtime.yml up -d --build
```

### Processos por serviço

| Serviço | `api` (REST) | gRPC interno | `worker` |
|---|---|---|---|
| `account` | sim | sim (`AccountService.Exists`) | sim (outbox + projeção de saldos) |
| `wallet` | sim | sim (`WalletService.GetBalances`) | sim (consumidores + outbox) |
| `order` | sim | não | sim |
| `matching` | **não** (só `/health`) | não | sim (um consumidor ativo por mercado) |
| `market-data` | sim | não | sim (projeções) |

### Portas no host (só para depuração local)

Dentro da `trading-net` os containers se acham pelo nome e usam as portas internas (`wallet-api:50051`, `wallet-db:5432`). As portas abaixo são só o mapeamento para o host, para depurar.

| Serviço | REST | gRPC | Postgres |
|---|---|---|---|
| `account` | 3001 | 50051 | 5433 |
| `wallet` | 3002 | 50052 | 5434 |
| `order` | 3003 | — | 5435 |
| `matching` | 3004 (`/health`) | — | 5436 |
| `market-data` | 3005 | — | 5437 |

---

## 4. Como subir

Plataforma inteira, em desenvolvimento (sem rebuild a cada alteração, §3.1):
```bash
docker compose -f backend/docker-compose.yml up --watch
```

Um serviço isolado (a infraestrutura compartilhada precisa estar de pé, por causa da rede e do broker):
```bash
docker compose -f backend/infra/docker-compose.yml up -d
```
```bash
docker compose -f backend/wallet/docker-compose.yml up --watch
```

---

## 5. Dockerfile de cada serviço

Multi-stage, com testes de unidade dentro do build:

1. **deps** — `npm ci` com devDependencies (workspace: `libs/` e `contracts/` entram aqui).
2. **dev** — `deps` + código-fonte + `tsx`. É o alvo do `docker-compose.yml`: o código é atualizado pelo Compose Watch, sem rebuild (§3.1). Roda como **root**, porque gera arquivos (código do protobuf, arquivos temporários do Vitest) em diretórios criados pela camada `deps`. Só a imagem final é não-root.
3. **build** — gera `contracts/generated/` a partir dos `.proto`, compila e **roda os testes de unidade**. Teste vermelho = imagem não é gerada.
4. **runtime** — `node:26-alpine`, só dependências de produção e `dist/`. Usuário não-root (`node`, uid 1000), coberto pelo E2E. Alvo do `docker-compose.runtime.yml` (§3.2).

Testes de integração **não** rodam no build, porque precisam de Postgres/RabbitMQ. Eles rodam no perfil `test` do compose (ver [testes](05-estrategia-de-testes.md#5-como-rodar)).

---

## 6. Referência de implantação na AWS (fora do escopo)

> **Não faz parte do conceito**, que roda inteiro em Docker local. Esta seção é um passo a passo neutro: diz **o que** cada peça local vira na AWS e **em que ordem** montar. Onde há mais de uma opção, cada passo traz o critério para escolher, sem preferência. Nenhum serviço muda: eles só conhecem variáveis de ambiente e nomes de host.

### 6.1 Equivalências

| Peça local | Função | Equivalente na AWS |
|---|---|---|
| `*-api`, `*-worker` | Processos dos serviços | Amazon ECS (Fargate ou EC2) ou Amazon EKS |
| `*-migrate` | Migração antes de subir | Tarefa avulsa do ECS ou Job do EKS |
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
2. Gere a imagem no alvo `runtime` do Dockerfile (§5), que é a mesma usada no E2E.
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
2. **Broker**: o projeto exige do RabbitMQ: exchanges `topic`, quorum queues, `x-single-active-consumer`, filas com TTL e dead-letter, e **streams** (replay do `market-data`, [mensageria §8](03-mensageria.md#8-stream-para-replay-de-proje%C3%A7%C3%B5es)).
   - Escolha **Amazon MQ for RabbitMQ** se a versão disponível suportar todos esses recursos.
   - Escolha **RabbitMQ autogerenciado em container** se algum deles não for suportado.
3. **Redis**: um cluster no **ElastiCache**. Cada serviço usa o próprio prefixo de chave, como no local.

**Passo 4 — Segredos e configuração**
1. Guarde as strings de conexão e as senhas no **Secrets Manager** ou no **SSM Parameter Store**.
2. As demais variáveis do compose (§2.1) viram variáveis da task definition ou do manifesto, com os mesmos nomes.

**Passo 5 — Processos**
1. Para cada serviço, crie:
   - uma definição para o `api` e outra para o `worker`, com a mesma imagem e comandos diferentes (§3.2);
   - uma tarefa avulsa para o `migrate`.
2. Ordem de cada implantação: rode o `migrate` → espere terminar com sucesso → atualize `api` e `worker`.
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

O rate limit **por conta** e o bloqueio escalonado **não** vão para a borda: continuam no plugin de `libs/http`, porque a borda enxerga IP e API key, não o `accountId` que vem no corpo.

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
