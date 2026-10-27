# 08 — Autenticação entre serviços

> Status: **spec** · Trata de **serviço provando a outro serviço quem ele é**, e do que cada um pode fazer. A identidade do **usuário** é outro assunto: hoje fica fora do escopo ([Q4](99-decisoes.md#q4)), e o §6 só define como ela vai viajar quando o login existir.

Regra geral: **cada serviço tem identidade própria em cada canal, e cada identidade só pode o mínimo que o serviço precisa.** Ninguém compartilha senha, certificado ou usuário com outro serviço.

| Canal | Como o serviço se autentica | O que limita o acesso |
|---|---|---|
| gRPC interno | **mTLS**, um certificado por serviço | Allowlist de métodos por serviço chamador (§2) |
| RabbitMQ | Usuário e senha por serviço | Permissões de configure / write / read por expressão (§3) |
| Postgres | Usuário por serviço, separado entre migração e execução (§4) | Cada usuário só existe no banco do próprio serviço |
| Redis | Usuário por serviço na ACL do Redis (§5) | Só chaves com o prefixo do serviço |
| REST do edge para os serviços | Nenhuma no conceito (rede interna) | §6 |

---

## 1. Segredos e certificados no ambiente local

Tudo é gerado **dentro de container**, como manda a regra de Docker ([princípios §7](01-principios.md#7-docker-sempre)), e nada disso vai para o git.

- **`security-init`**, container de execução única no compose de infraestrutura compartilhada (`backend/infra/`), roda antes de qualquer outro:
  1. cria uma **CA local** (chave privada + certificado raiz);
  2. emite um **certificado por serviço** com o nome DNS dele no SAN (`account-api`, `wallet-api`, …), validade de 30 dias;
  3. gera uma **senha aleatória** por serviço para RabbitMQ, Postgres (migração e execução) e Redis;
  4. grava tudo no volume nomeado **`trading-secrets`**.
- Se o volume já tiver os arquivos, o `security-init` não faz nada. Para rotacionar: `docker compose run --rm security-init --rotate`.
- O volume tem **um subdiretório por container** (`rabbitmq/`, `redis/`, `<svc>-db/`, `<svc>-migrate/`, `<svc>-api/`, `<svc>-worker/`), com dono igual ao usuário daquele container (rabbitmq 100, redis 999, postgres 70, node 1000) e modo `0600`. Cada container monta **só o próprio subdiretório** (`volume.subpath`), em `/run/secrets/` e somente leitura. O código lê o conteúdo de variáveis `*_FILE` (ex.: `DATABASE_PASSWORD_FILE=/run/secrets/wallet-db-app-password`). Nenhuma senha aparece no `docker-compose.yml` nem em `.env`.
- A chave privada da CA só é montada no `security-init`. Nenhum serviço consegue emitir certificado.

---

## 2. gRPC interno: mTLS + allowlist

### 2.1 mTLS
- Servidor e cliente apresentam certificado e verificam o do outro contra a CA local. Sem certificado válido, a conexão nem abre.
- O cliente confere se o certificado do servidor tem o nome que ele chamou (`account-api`). Isso impede que outro container se passe pelo serviço.
- O servidor extrai a **identidade do chamador** do certificado (o nome no SAN, ex.: `wallet-api` → serviço `wallet`).
- Implementado em `src/infra/platform/security/` de cada serviço (vem do template): credenciais do cliente e do servidor `@grpc/grpc-js` a partir dos arquivos de `/run/secrets/`.

### 2.2 Allowlist por serviço
Cada servidor gRPC declara **quem pode chamar cada método**. A checagem é um interceptor de `src/infra/platform/security/`, que roda **antes** do handler, no adapter de entrada.

| Servidor | Método | Quem pode chamar |
|---|---|---|
| `account` | `AccountService.Exists` | `wallet` |
| `wallet` | `WalletService.GetBalances` | `account` |

- Chamador fora da lista → **`PERMISSION_DENIED`**, com log de auditoria (`caller`, `method`, `correlationId`). A ACL do cliente trata esse código como erro permanente: **sem retry**.
- A allowlist fica em configuração do serviço (`grpcAllowlist`), versionada junto com o código, e é validada na inicialização. Método sem entrada na lista é **negado por padrão**.
- Adicionar um consumidor novo de um método é mudar a lista do servidor: a decisão fica com o dono do método.

---

## 3. RabbitMQ: usuário e permissões por serviço

Um usuário por serviço, no vhost `trading`. As permissões do RabbitMQ são três expressões regulares (configure, write, read) e seguem a regra de topologia da [mensageria §1](03-mensageria.md#1-topologia-quem-declara-o-qu%C3%AA): **o produtor só mexe na própria exchange; o consumidor só mexe nas próprias filas**.

| Usuário | configure (declarar) | write (publicar / bind) | read (consumir / bind) |
|---|---|---|---|
| `account` | `^(account\.events\|account\..*)$` | `^(account\.events\|account\..*\|retry)$` | `^(account\..*\|wallet\.events\|retry)$` |
| `wallet` | `^(wallet\.events\|wallet\..*)$` | `^(wallet\.events\|wallet\..*\|retry)$` | `^(wallet\..*\|account\.events\|order\.events\|matching\.events\|retry)$` |
| `order` | `^(order\.events\|order\..*)$` | `^(order\.events\|order\..*\|retry)$` | `^(order\..*\|wallet\.events\|matching\.events\|retry)$` |
| `matching` | `^(matching\.events\|matching\..*)$` | `^(matching\.events\|matching\..*\|retry)$` | `^(matching\..*\|order\.events\|retry)$` |
| `marketData` | `^marketData\..*$` | `^(marketData\..*\|retry)$` | `^(marketData\..*\|matching\.events\|retry)$` |

Como ler: para fazer o binding de uma fila própria numa exchange de outro contexto, o RabbitMQ exige *write* na fila e *read* na exchange. Por isso a exchange do produtor aparece no *read* de quem consome dela. Ninguém tem *write* na exchange de outro contexto, então **nenhum serviço consegue publicar um evento em nome de outro**.

- **`retry` aparece no *write* e no *read* de todos os consumidores.** *Write* para publicar a cópia na fila de atraso e na DLQ; *read* porque toda fila (principal, de atraso e DLQ) é ligada à exchange `retry`, e ligar fila a uma exchange exige *read* nela (verificado em container).
- O `matching` não tem filas de atraso ([mensageria §6](03-mensageria.md#6-ordem-garantida-a-fila-do-matching)), mas tem acesso a `retry` para mandar falha permanente para a DLQ dele.
- Ninguém usa a exchange padrão (`""`) como dead-letter: isso exigiria *write* em `amq.default`.
- As filas de atraso e a DLQ são declaradas pelo próprio serviço consumidor; a exchange `retry` vem do `definitions.json`, como as demais.
- Os usuários, o vhost e as permissões ficam num `definitions.json` gerado pelo `security-init` e carregado pelo RabbitMQ na subida. O usuário administrador só é usado por esse processo e pelo painel de gestão.
- Tentativa fora da permissão → `ACCESS_REFUSED` do broker: erro permanente, alarme.

---

## 4. Postgres: dois usuários por serviço

Cada banco de serviço tem **dois** usuários, para que o processo que atende requisição não possa alterar a estrutura do banco:

| Usuário | Usado por | Pode |
|---|---|---|
| `<svc>_migrator` | container `<svc>-migrate` | Dono do schema: `CREATE` / `ALTER` / `DROP` |
| `<svc>_app` | `<svc>-api` e `<svc>-worker` | Só `SELECT`, `INSERT`, `UPDATE`, `DELETE` nas tabelas do schema e uso das sequences (`GRANT` feito pela migração) |

- O superusuário do Postgres só é usado na criação do banco e dos dois usuários, no primeiro boot do container.
- Os usuários só existem no banco do próprio serviço. Isso reforça, por credencial, a regra "nenhum serviço lê o banco de outro" ([design estratégico §4](02-design-estrategico.md#4-context-map)).
- O `market-data` não precisa de `DELETE` fora da reconstrução de projeções; o comando de rebuild roda com o `<svc>_migrator`.

---

## 5. Redis: ACL por serviço

Um usuário por serviço na ACL do Redis, restrito ao próprio prefixo de chave e aos comandos que o rate limit usa:

```
user default off
user wallet on #{sha256 da senha} ~wallet:* resetchannels -@all +eval +evalsha +hello +auth +client|setinfo +client|setname +info +get +set +del +incrby +expire +pexpire +ttl +pttl
```

- `user default off`: conexão sem usuário é recusada.
- `~wallet:*`: o `wallet` não enxerga contadores de outro serviço.
- **`-@all` e lista explícita**: só os comandos do limitador. Categorias como `+@read +@write` liberariam `KEYS` e `FLUSHALL` (verificado em container).
- Comandos chamados **dentro do Lua** também passam pela ACL; por isso o script só usa comandos da lista. `TIME` é negado, então o horário entra pelo `ARGV`.
- `+hello` e `+info` existem porque o cliente (ioredis) usa RESP3 e faz checagem de prontidão.
- Senha guardada como hash SHA-256 (`#…`), nunca em claro.
- A ACL é gerada pelo `security-init` num arquivo `users.acl`, carregado pelo Redis na subida.

---

## 6. Identidade do usuário: JWT interno (quando o login existir)

**Fora do escopo do conceito.** Hoje os serviços recebem o `accountId` no corpo da requisição, como define o objetivo. Quando o login for implementado no edge ([Q4](99-decisoes.md#q4)), a identidade do usuário passa a viajar assim:

1. O edge autentica o usuário (API key + assinatura HMAC, como a Binance) e aplica o brute force do [rate limiting §4](07-rate-limiting.md#4-brute-force-em-autentica%C3%A7%C3%A3o).
2. O edge emite um **JWT interno**, de vida curta, e o envia ao serviço no header `Authorization: Bearer …`:

   | Claim | Valor |
   |---|---|
   | `iss` | `edge` |
   | `sub` | `accountId` do usuário |
   | `aud` | serviço de destino (`order`, `wallet`…) |
   | `exp` | **60 s** depois da emissão |
   | `jti` | id único, para log e auditoria |

3. Assinatura **assimétrica** (`EdDSA` ou `ES256`). Só o edge tem a chave privada; os serviços só têm a pública e só conseguem **verificar**, nunca emitir.
4. O adapter de entrada REST verifica assinatura, `iss`, `aud` e `exp`, e passa o `accountId` do token para o `Input` do caso de uso. A partir daí, o `accountId` do corpo é ignorado.
5. Em eventos e gRPC, o `accountId` continua indo no payload, como já está: o JWT é só a prova de quem fez a requisição na borda, e não atravessa a mensageria.

O JWT **não** autentica serviço. Quem autentica serviço é o mTLS (§2) e as credenciais por canal (§3–5).

### O que fica sem autenticação no conceito
A chamada REST do edge para os serviços trafega sem TLS dentro da `trading-net`. É uma escolha consciente do conceito, que roda numa rede Docker isolada. Quando o JWT interno existir, o serviço passa a recusar requisição sem token válido; TLS nesse trecho pode ser adicionado com os mesmos certificados da CA local.

---

## 7. Testes

Seguem as regras de repetibilidade ([testes §3](05-estrategia-de-testes.md#3-repetibilidade)).

| Nível | Casos |
|---|---|
| Unidade | Allowlist: chamador permitido, chamador negado, método sem entrada (negado por padrão) · extração da identidade a partir do SAN · validação da configuração na inicialização |
| Integração | O `test/support/` do serviço gera uma **CA efêmera por execução** e certificados de teste. O fake gRPC (`startFakeGrpcServer`) também exige mTLS. Casos: cliente sem certificado não conecta · certificado de outra CA é recusado · chamador fora da allowlist recebe `PERMISSION_DENIED` e o gateway não faz retry · no broker de teste, publicar na exchange de outro contexto dá `ACCESS_REFUSED` · usuário `<svc>_app` não consegue `ALTER TABLE` · usuário Redis não lê chave de outro prefixo |
| E2E | A plataforma sobe com o `security-init` e os caminhos críticos passam com mTLS ligado |
