# 07 — Rate limiting, brute force e DDoS

> Status: **spec** · Vale para toda a API pública REST. O tráfego interno (gRPC, RabbitMQ) tem outra proteção (§6).

Limites são definidos **por tipo de uso**, não um número único para tudo: leitura pública barata aguenta muito; criação de conta e (no futuro) login aguentam pouco, porque são alvo de brute force e de abuso.

---

## 1. Duas camadas

| Camada | Onde | Chave | Protege contra |
|---|---|---|---|
| **1. Edge** | `edge` (nginx), antes de qualquer serviço | **IP** | Inundação de requisições, conexões abertas demais, clientes lentos (slowloris), corpo gigante. Barra o grosso antes de gastar CPU dos serviços. |
| **2. Serviço** | Plugin de rate limit em `src/infra/platform/http/`, em todo `api` | **Conta** (`accountId`) e **IP**, por grupo de endpoint | Abuso de quem está dentro do limite de IP (várias contas no mesmo IP, uma conta em vários IPs), brute force, excesso de ordens |

As duas camadas são necessárias: o edge não vê o `accountId` (ele vem no corpo, [Q4](99-decisoes.md#q4)), e o serviço não deve receber o tráfego que o edge já sabe que é abusivo.

---

## 2. Camada 1 — edge (nginx)

| Proteção | Configuração |
|---|---|
| Zona `public` (`/markets/*`) | `limit_req` 20 r/s por IP, `burst=40 nodelay` |
| Zona `private` (`/accounts/*`, `/orders/*`, `/deposit`, `/withdraw`, `/place_order`, `/cancel_order`) | `limit_req` 10 r/s por IP, `burst=20 nodelay` |
| Zona `auth` (`/signup`; `/login` no futuro) | `limit_req` 5 r/min por IP, `burst=5 nodelay` (sem `nodelay`, o nginx enfileira e atrasa as requisições do burst em vez de responder na hora) |
| Conexões simultâneas | `limit_conn` 20 por IP |
| Tamanho do corpo | `client_max_body_size 16k` (nenhum payload legítimo passa disso) |
| Cliente lento | `client_header_timeout 5s`, `client_body_timeout 5s`, `send_timeout 10s` |
| Keep-alive | `keepalive_requests 100`, `keepalive_timeout 15s` |
| Microcache de leitura pública | `proxy_cache` de **1 s** em `/markets/*` (depth, trades, market). Mil requisições iguais no mesmo segundo viram uma só no `market-data`. |
| Resposta | `limit_req_status 429` |

O microcache de 1 s não altera a consistência na prática: as projeções já são eventualmente consistentes, e a resposta traz `asOf`.

---

## 3. Camada 2 — serviço (por uso)

Algoritmo: **contador de janela deslizante** com dois buckets ponderados (`anterior × (1 − tempoDecorrido/janela) + atual`), executado num script Lua no **Redis** (atômico) e compartilhado entre réplicas do mesmo serviço. É a mesma classe pura (`SlidingWindowCounter`) usada pelo limitador em memória, para os dois darem o mesmo resultado. Guardar cada requisição (lista ordenada) foi descartado: a cota de 100.000 ordens por 24 h viraria 100 mil itens por conta. Chave: `<service>:rl:<grupo>:<accountId|ip>:<inícioDoBucket>`, com expiração de duas janelas.

### 3.1 Grupos e limites

| Grupo | Endpoints | Limite por **IP** | Limite por **conta** | Por quê |
|---|---|---|---|---|
| **Auth** | `POST /signup` | 5 / hora | — (ainda não há conta) | Criação em massa de contas; enumeração de e-mail pelo `409` |
| **Auth por e-mail** | `POST /signup` | — | 3 tentativas / hora **por e-mail** | Mesmo e-mail testado a partir de vários IPs |
| **Ordens** | `POST /place_order`, `POST /cancel_order` | 100 / 10 s | **50 / 10 s** e **100.000 / 24 h** | Limite próprio de ordens, separado do peso, como a Binance faz |
| **Movimentação** | `POST /deposit`, `POST /withdraw` | 30 / min | **10 / min** | Dinheiro: pouco uso legítimo, alto impacto |
| **Leitura privada** | `GET /accounts/:id`, `/accounts/:id/orders`, `/orders/:id` | 600 de **peso** / min | 300 de peso / min | Leitura por conta |
| **Leitura pública** | `GET /markets/*` | 1.200 de **peso** / min | — | Barata (projeção + microcache), mas não infinita |

**Peso por endpoint** (só nos grupos de leitura): rota por id = 1 · lista de ordens = 5 · `GET /markets/:id` = 1 · `/trades` = 2 (até 50 itens; 5 acima disso) · `/depth` = 2. Assim, endpoints mais caros consomem mais da cota, no modelo do `REQUEST_WEIGHT` da Binance.

Os números são o ponto de partida do conceito e ficam em configuração (`RATE_LIMITS_*`), não no código.

### 3.2 Resposta ao exceder

- **`429 Too Many Requests`** com `Retry-After` (segundos).
- Toda resposta dos grupos limitados traz os headers do rascunho IETF: `RateLimit-Policy` (política fixa, ex.: `"orders";q=50;w=10`) e `RateLimit` (quanto resta, ex.: `"orders";r=12;t=4`).
- Requisição barrada **não executa nada**: o limite é checado antes do caso de uso, no adapter de entrada.
- A requisição repetida com a mesma `Idempotency-Key` também conta, porque retry agressivo é exatamente o que o limite deve conter.

### 3.3 Bloqueio escalonado para quem insiste

Quem continua batendo depois do `429` é bloqueado por tempo crescente, como a Binance faz:

| Gatilho | Bloqueio |
|---|---|
| 10 respostas `429` para o mesmo IP em 1 min | **2 min** |
| Novo gatilho durante 24 h | dobra (4 min, 8 min…) até o teto de **24 h** |

Durante o bloqueio, todas as rotas do serviço respondem `429` com o `Retry-After` do bloqueio. A lista de bloqueio fica no Redis (`<service>:rl:ban:<ip>`), com expiração automática.

---

## 4. Brute force em autenticação

Hoje o único endpoint de autenticação é o `POST /signup`, porque login está fora do escopo ([Q4](99-decisoes.md#q4)). Mesmo assim, ele já recebe as proteções acima, e o desenho do login fica definido para quando entrar.

### 4.1 Signup (agora)
- Limites do grupo **Auth** por IP e por e-mail (§3.1), mais a zona `auth` do edge.
- **Enumeração de e-mail:** o objetivo exige rejeitar e-mail duplicado (`409`), e isso revela que o e-mail existe. É um trade-off aceito. A mitigação é o limite apertado por IP e por e-mail, e um alarme quando um IP recebe muitos `409`.
- O hash da senha (argon2id) já é caro de propósito, o que também encarece ataque em massa.

### 4.2 Login (quando entrar, no edge)
Segue o OWASP:
- **Bloqueio por conta, não só por IP:** 5 falhas em 15 min bloqueiam aquela conta por 5 min, dobrando a cada reincidência até 24 h. Só IP não basta, porque o ataque se espalha por muitos IPs.
- **Bloqueio temporário, nunca permanente:** bloqueio permanente vira arma para derrubar a conta de outra pessoa (lockout DoS).
- **Limite por IP de falhas totais** (20 / hora, qualquer conta), contra *password spraying*, que testa uma senha em muitas contas para ficar abaixo do limite por conta.
- **Mensagem genérica** ("credenciais inválidas") e **tempo de resposta constante**, exista a conta ou não.
- Contadores no Redis, no mesmo plugin.

---

## 5. Resiliência do próprio limitador

O limitador não pode virar ponto único de falha. Usa a mesma **corrente de fallback** do resto da plataforma ([princípios §5.3](01-principios.md#53-fallback-com-chain-of-responsibility)):

1. `RedisRateLimiter` — contador compartilhado entre réplicas.
2. `InMemoryRateLimiter` — se o Redis estiver fora, cada réplica limita sozinha com os mesmos números. Fica mais permissivo (o limite vale por réplica), mas **nunca deixa passar sem limite**.

Os dois são **adapters** da porta `RateLimiter`, e a corrente é um adapter composto.

---

## 6. Tráfego interno

Não tem rate limit por cota, porque não vem de cliente externo. A proteção é outra:
- **gRPC:** deadline de 500 ms no cliente e **limite de requisições simultâneas** no servidor (100 por processo). Acima disso, responde `RESOURCE_EXHAUSTED`, que o cliente trata com retry e backoff ([princípios §4.1](01-principios.md#41-rest-ou-grpc)).
- **RabbitMQ:** o `prefetch` de cada consumidor já limita quanto entra ao mesmo tempo ([mensageria §1](03-mensageria.md#1-topologia-quem-declara-o-qu%C3%AA)).

---

## 7. O que fica fora (DDoS volumétrico)

O edge mitiga **ataque na camada de aplicação** (muitas requisições HTTP). **Ataque volumétrico** (inundação de rede) derruba a máquina antes de o nginx ver qualquer coisa, e só se resolve **antes** dela: CDN/WAF ou proteção do provedor de nuvem. Isso fica fora do conceito, que roda local. O ponto de encaixe é na frente do `edge`, sem mudar nenhum serviço. Na AWS, essa proteção fica com o AWS Shield, junto com CloudFront e WAF ([ambiente §6](04-ambiente-docker.md#6-refer%C3%AAncia-de-implanta%C3%A7%C3%A3o-na-aws-fora-do-escopo)).

---

## 8. Infraestrutura

- **Redis** (`redis:7-alpine`, container `redis`) entra no compose de infraestrutura compartilhada, ao lado do RabbitMQ, na `trading-net`. É técnico, como o broker: guarda só contadores e bloqueios, com expiração. Cada serviço usa o próprio prefixo de chave. Não é banco de domínio, então não viola o "um banco por serviço".
- Configuração do nginx em `backend/infra/edge/nginx.conf`.

## 9. Testes

| Nível | Casos |
|---|---|
| Unidade | Janela deslizante; cálculo de peso; escalonamento do bloqueio (2 → 4 → 8 min, teto 24 h); corrente Redis → memória |
| Integração | Limite compartilhado entre duas instâncias com o mesmo Redis; Redis parado → cai para memória sem deixar passar sem limite; headers `RateLimit`/`Retry-After` |
| E2E | 6º `POST /signup` do mesmo IP em 1 h → `429`; rajada de ordens acima de 50 / 10 s → `429` sem criar ordem |

## Fontes

- Binance — limites da API spot (peso por IP, limite de ordens, `429`/`418`, `Retry-After`, banimento crescente): https://developers.binance.com/docs/binance-spot-api-docs/rest-api/limits
- OWASP WSTG — mecanismo de bloqueio (3–5 falhas, 5–30 min, por conta e não só por IP): https://owasp.org/www-project-web-security-testing-guide/latest/4-Web_Application_Security_Testing/04-Authentication_Testing/03-Testing_for_Weak_Lock_Out_Mechanism
- OWASP — brute force em login (bloqueio temporário, escalonamento): https://wiki.owasp.org/index.php/OWASP_Periodic_Table_of_Vulnerabilities_-_Brute_Force_Login
- IETF — RateLimit header fields for HTTP (draft-11): https://datatracker.ietf.org/doc/html/draft-ietf-httpapi-ratelimit-headers-11
