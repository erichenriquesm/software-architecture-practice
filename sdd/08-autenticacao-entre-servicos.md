# 08 — Autenticação entre serviços

> Status: **spec** · Trata de **serviço provando a outro serviço quem ele é**, e do que cada um pode fazer. A identidade do **usuário** é outro assunto: hoje fica fora do escopo ([Q4](99-decisoes.md#q4)), e o §6 só define como ela vai viajar quando o login existir.

Regra geral: **cada serviço tem credencial própria no RabbitMQ, no Postgres e no Redis, e cada credencial só pode o mínimo que o serviço precisa.** No gRPC, que hoje tem um método só, basta um token compartilhado (§2).

| Canal | Como o serviço se identifica | O que limita o acesso |
|---|---|---|
| gRPC interno | Token compartilhado no metadata (§2) | Só quem tem o token chama; hoje há um método só |
| RabbitMQ | Usuário e senha por serviço (§3) | Permissões de configure / write / read |
| Postgres | Um usuário por serviço, que migra e acessa os dados (§4) | O usuário só existe no banco do próprio serviço |
| Redis | Usuário e senha por serviço (§5) | Só chaves com o prefixo do serviço |
| REST do edge para os serviços | Nenhuma no conceito (rede interna) | §6 |

---

## 1. Onde ficam as credenciais

**No `.env` de cada compose**, copiado do `.env.example` versionado ([ambiente §2.2](04-ambiente-docker.md#22-envexample-por-compose)). Não existe container que gere senha nem certificado.

| Credencial | `.env` de quem cria | `.env` de quem usa |
|---|---|---|
| Usuário e senha do serviço no RabbitMQ | `backend/infra/` | `backend/<svc>/` |
| Usuário e senha do serviço no Redis | `backend/infra/` | `backend/<svc>/` |
| Usuários e senhas do Postgres | `backend/<svc>/` (o banco é do próprio serviço) | `backend/<svc>/` |
| Token gRPC compartilhado | `backend/account/` (servidor, `GRPC_TOKEN`) | `backend/wallet/` (cliente, `ACCOUNT_GRPC_TOKEN`) |

Quando a mesma credencial aparece em dois `.env.example`, os dois têm o mesmo valor. Os valores do `.env.example` são **só de desenvolvimento**; fora do ambiente local, as mesmas variáveis vêm do gerenciador de segredos ([ambiente §6](04-ambiente-docker.md#6-refer%C3%AAncia-de-implanta%C3%A7%C3%A3o-na-aws-fora-do-escopo)).

---

## 2. gRPC interno: token compartilhado

Hoje existe um método gRPC só, de fallback: `AccountService.Exists`, servido pelo `account` e chamado pelo `wallet`. Para um método e um chamador, nome de serviço e allowlist por método seriam cerimônia. Basta um token.

Quem chama manda o token no metadata de toda chamada:

```
x-service-token: internal-grpc-dev
```

```bash
# backend/account/.env.example (server)
GRPC_TOKEN=internal-grpc-dev
```
```bash
# backend/wallet/.env.example (client)
ACCOUNT_GRPC_TOKEN=internal-grpc-dev
```

Um **interceptor** em `src/infra/platform/security/` do `account` roda antes de qualquer handler e compara o token com `crypto.timingSafeEqual` (buffers do mesmo tamanho). Sem token ou token errado → **`UNAUTHENTICATED`**. É **erro permanente**: o gateway não faz retry ([princípios §4.1](01-principios.md#41-rest-ou-grpc)).

Se surgirem mais métodos ou chamadores, aí sim cada chamador ganha o próprio token e cada método a lista de quem pode chamá-lo.

O tráfego gRPC não é criptografado: fica dentro da `trading-net`. Fora do ambiente local, TLS pode ser ligado no canal sem mudar essa checagem.

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

Como ler: para ligar uma fila própria numa exchange de outro contexto, o RabbitMQ exige *write* na fila e *read* na exchange. Por isso a exchange do produtor aparece no *read* de quem consome dela. Ninguém tem *write* na exchange de outro contexto, então **nenhum serviço consegue publicar um evento em nome de outro**.

- **`retry` aparece no *write* e no *read* de todos.** *Write* para publicar na fila de atraso e na DLQ; *read* porque toda fila é ligada à exchange `retry`, e ligar fila a uma exchange exige *read* nela.
- Ninguém usa a exchange padrão (`""`) como dead-letter: isso exigiria *write* em `amq.default`.
- **Como os usuários são criados:** `backend/infra/rabbitmq/` tem um `definitions.template.json` (vhost, usuários, permissões e exchanges) com as senhas como variáveis (`${ACCOUNT_RABBITMQ_PASSWORD}`…). O script de entrada do container troca as variáveis pelos valores do `.env` da infra e sobe o broker com o arquivo pronto.
- **Cada usuário de serviço tem a tag `management`**: entra no painel de gestão (`http://127.0.0.1:15672`) com o próprio usuário e senha do `.env` e vê só o que as permissões da tabela acima já deixam (as filas e exchanges do vhost `trading`), sem poder administrar o broker.
- O usuário admin (do `.env` da infra) é o único com a tag `administrator`: gerencia usuários, permissões e o broker inteiro.
- Tentativa fora da permissão → `ACCESS_REFUSED` do broker: erro permanente, alarme.

---

## 4. Postgres: um usuário por serviço

Cada banco de serviço tem **um** usuário, `<svc>` (ex.: `account`), dono do banco: ele roda as migrações e lê/grava os dados.

- **Como é criado:** no primeiro boot do `<svc>-db`, pela própria imagem do Postgres, a partir de `DATABASE_NAME`, `DATABASE_USER` e `DATABASE_PASSWORD` do `.env` do serviço (o compose repassa como `POSTGRES_DB`, `POSTGRES_USER` e `POSTGRES_PASSWORD`). Não há script de init.
- O usuário só existe no banco do próprio serviço. Isso reforça, por credencial, a regra "nenhum serviço lê o banco de outro" ([design estratégico §4](02-design-estrategico.md#4-context-map)).
- **Trade-off aceito:** o processo que atende requisição também pode alterar a estrutura do banco. Separar migração e execução em dois usuários exigiria um script de init e duas senhas por serviço; o conceito prefere a simplicidade. Fora do ambiente local, a separação pode voltar sem mudar código: basta a migração rodar com outras credenciais.

---

## 5. Redis: usuário por serviço

Um usuário por serviço, restrito ao próprio prefixo de chave e aos comandos que o rate limit usa:

```
user default off
user wallet on >wallet-redis-dev ~wallet:* resetchannels -@all +eval +evalsha +hello +auth +client|setinfo +client|setname +info +get +set +del +incrby +expire +pexpire +ttl +pttl
```

- `user default off`: conexão sem usuário é recusada.
- `~wallet:*`: o `wallet` não enxerga contadores de outro serviço.
- **`-@all` e lista explícita**: só os comandos do limitador. Categorias como `+@read +@write` liberariam `KEYS` e `FLUSHALL`.
- Comandos chamados **dentro do Lua** também passam pela ACL; por isso o script só usa comandos da lista. `TIME` é negado, então o horário entra pelo `ARGV`.
- `+hello` e `+info` existem porque o cliente (ioredis) usa RESP3 e faz checagem de prontidão.
- **Como os usuários são criados:** o script de entrada do container gera o `users.acl` a partir do `.env` da infra (uma linha por serviço, como acima) e sobe o Redis com `--aclfile`.

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

O JWT **não** autentica serviço. Quem autentica serviço é o token gRPC (§2) e as credenciais por canal (§3–5).

### O que fica sem autenticação no conceito
A chamada REST do edge para os serviços trafega sem TLS dentro da `trading-net`. É uma escolha consciente do conceito, que roda numa rede Docker isolada. Quando o JWT interno existir, o serviço passa a recusar requisição sem token válido.

---

## 7. Testes

Seguem as regras de repetibilidade ([testes §3](05-estrategia-de-testes.md#3-repetibilidade)).

| Nível | Casos |
|---|---|
| Unidade | Interceptor: token certo passa · token errado → `UNAUTHENTICATED` · sem token → `UNAUTHENTICATED` |
| Integração | O fake gRPC (`startFakeGrpcServer`) confere o mesmo header. Casos: gateway manda o token em toda chamada · `UNAUTHENTICATED` não tem retry · no broker de teste, publicar na exchange de outro contexto dá `ACCESS_REFUSED` · usuário Redis não lê chave de outro prefixo |
| E2E | A plataforma sobe só com os `.env` copiados dos `.env.example`, e os caminhos críticos passam |
