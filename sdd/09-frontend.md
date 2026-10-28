# 09 — Frontend

> Status: **spec** · O cliente web da plataforma: o que ele mostra, como fala com o backend e as regras de código. As telas estão desenhadas no canvas [Lastro — telas](https://claude.ai/artifact/HQUEd6yYcP5mNrDwmegSkL) e os componentes no design system [Lastro](https://claude.ai/artifact/TxB2hTYzK7GWCJwqX84WzH).

---

## 1. Escopo e telas

| Tela | Rota | Dados (via edge) |
|---|---|---|
| Entrar | `/entrar` | `POST /login`, `GET /me` ([§5](#5-autenticação)) |
| Cadastro | `/cadastro` | `POST /signup` |
| Mercado | `/mercado/:marketId` | `GET /markets/:marketId` · `/depth` · `/trades`, `POST /place_order` |
| Carteira | `/carteira` | `GET /accounts/:accountId`, `POST /deposit` · `/withdraw` |
| Ordens | `/ordens` | `GET /accounts/:accountId/orders`, `POST /cancel_order` |
| Detalhe da ordem | `/ordens/:orderId` | `GET /orders/:orderId` |

Fora do escopo: ordem a mercado, gráfico de candles, tempo real por WebSocket/SSE ([princípios](01-principios.md): se surgir, o caminho é o `market-data`), app mobile nativo. A tela funciona em largura de celular, mas o alvo é desktop.

O front só conhece o **edge** ([design estratégico](02-design-estrategico.md)). Nenhuma URL de serviço aparece no código.

---

## 2. Stack

| Papel | Escolha | Por quê |
|---|---|---|
| UI | Vue 3 (`<script setup lang="ts">`) + TypeScript `strict`, checado por `vue-tsc` | SFC com Composition API: lógica em composables, template só apresenta |
| Build e dev | Vite + `@vitejs/plugin-vue` | Dev server com HMR, roda no container com Compose Watch |
| Rotas | Vue Router | Rotas lazy e guard central (`beforeEach`) |
| Estado de UI | Pinia (setup stores) | Só o que atravessa rotas: sessão do usuário e tema |
| Server state | TanStack Query (`@tanstack/vue-query`) | Cache, polling, dedupe e invalidação sem store global |
| Formulários | Zod + composable `useForm` próprio | Schema único para validação e tipo; o estado do formulário é um composable, sem biblioteca de form |
| Decimal | `decimal.js` | O mesmo do backend: preço, quantidade e saldo nunca viram `number` |
| Testes | Vitest + jsdom + Testing Library (Vue) + MSW; Playwright no E2E | Mesma pirâmide do [backend](05-estrategia-de-testes.md) |
| Catálogo | O design system [Lastro](https://claude.ai/artifact/TxB2hTYzK7GWCJwqX84WzH) | Tokens, regras e previews de cada componente; o código dos componentes vive em `src/lastro/` |

As dependências entram com a mesma regra do backend: versão exata, aprovada antes de entrar no `package.json`.

O front é um **repositório próprio** (`software-architecture-practice-frontend`), clonado em `frontend/` do guarda-chuva, como cada serviço em `backend/` ([README, decisão 17](README.md)). Roda em Docker, num compose dele na `trading-net`, e o edge serve `/` a partir dele, na mesma origem da API (o cookie de sessão é `SameSite=Strict`). Alterar código não exige rebuild (Compose Watch + HMR do Vite). As rotas do front são em português (`/mercado`, `/carteira`, `/ordens`) e não colidem com as da API.

---

## 3. Organização

Por **contexto de negócio**, nunca por tipo de arquivo. Os contextos espelham os bounded contexts do backend.

```
src/
  app/            ← main.ts, App.vue, router e guard, plugins (Pinia, Vue Query)
  pages/          ← uma por rota (`XxxPage.vue`); só compõe contextos
  lastro/         ← design system: tokens.css e componentes `Lt*` (LtButton, LtSideToggle, LtAmountField, LtOrderBook…)
  contexts/
    market/       ← último preço, livro, profundidade, negociações
    orderTicket/  ← boleta, confirmação, envio
    orders/       ← lista e detalhe de ordens
    wallet/       ← saldos, depósito, saque
    identity/     ← entrar, cadastro, sessão
  entities/       ← tipos e VOs usados por 2+ contextos (Decimal, Side, OrderStatus, MarketId)
  shared/         ← cliente HTTP, formatação, logger, sem domínio
```

Regras:

1. **Importa só para baixo:** `pages → contexts → entities → shared`. Um contexto nunca importa outro; quando dois precisam do mesmo dado, ele sobe para `entities/` ou a página orquestra os dois. O lint garante (`no-restricted-imports`) e um teste de arquitetura (dependency-cruiser, como no backend) também.
2. **Camadas dentro do contexto**, como no backend: `domain/` (VOs e regras puras, sem Vue), `application/` (composables de caso de uso `useXxx`, com `XxxInput`/`XxxOutput`, e o store Pinia quando o contexto tem um), `infra/` (`*.api.ts` e o mapper) e `ui/` (componentes `.vue`). Contexto simples pode ter arquivos soltos; não crie pasta antes de precisar.
3. **Quem faz o quê:**

   | Peça | Faz | Não faz |
   |---|---|---|
   | `*.api.ts` | Uma função por endpoint, tipada, pelo cliente HTTP | Lógica, estado, mensagem de erro |
   | Composable `useXxx` | Caso de uso: chama a API via Vue Query, gera a `Idempotency-Key`, mapeia status para tipo de erro, devolve refs | Tocar no DOM, importar componente |
   | Store Pinia | Estado de UI que atravessa rotas (sessão, tema) | Guardar resposta da API |
   | Componente `ui/` | Renderiza props, emite eventos, usa um composable | `fetch`, regra de negócio, conta com decimal |
   | Página | Compõe contextos de uma rota | Lógica própria |

4. **Alias `@/`** em vez de caminhos relativos longos; o mesmo alias no Vite e no `tsconfig`.
5. Componente de tela fica no contexto. Componente reutilizável entre contextos é do **Lastro** (`src/lastro/`), com o preview correspondente no design system, nunca como CSS local.

---

## 4. Dados e contratos

O fluxo é sempre **tipos → `*.api.ts` → composable → componente**. Componente não faz fetch; composable não chama `fetch` direto.

- **`*.api.ts`**: um arquivo por contexto, uma função por endpoint, retorno `Promise<T>` tipado, sem lógica e sem efeito colateral.
- **Mapper na borda:** converte o JSON da API para o modelo do front (`null → undefined`, strings decimais → `Decimal` só onde há conta). O resto do código nunca vê `null`.
- **Um cliente HTTP só** (`shared/api/client.ts`): base `/`, timeout, `credentials: 'include'`, `X-Request-Id` gerado por requisição, `Idempotency-Key` quando o composable passa uma. Nada de `fetch` cru fora dele.
- **Server state fica no TanStack Query**, nunca num store global. Store Pinia só para estado de UI que atravessa rotas: a sessão (quem está logado, vindo do `/me`) e o tema.
- **Derivado é calculado**, nunca sincronizado: total da boleta, profundidade a partir do livro, saldo disponível para o lado escolhido.
- **Tipos de transporte** levam o sufixo do contrato (`PlaceOrderRequest`, `OrderResponse`). Os composables de caso de uso usam `XxxInput`/`XxxOutput`. Um endpoint tem um tipo só; se dois contextos usam, ele vai para `entities/`.
- **Valores de enum** (`side`, `status`, `reason`) são unions de string com uma fonte única em `entities/`, iguais aos do backend, mudados no mesmo PR. Rótulos num `Record<OrderStatus, string>` ao lado. Nunca a palavra-chave `enum`.

### 4.1 Dinheiro e quantidade

Preço, quantidade e saldo trafegam como **string decimal** e assim ficam até a tela. Conta só com `Decimal`; nunca `parseFloat`, `Number()` ou aritmética nativa. Formatação centralizada em `shared/format` (`Intl.NumberFormat('pt-BR')` sobre a string, casas por ativo: BTC 8, USD 2). O schema Zod valida a string (regex decimal + escala do ativo + tick/step do mercado de [Q11](99-decisoes.md#q11)), e a máscara do campo é só visual.

### 4.2 Retry, idempotência e limite

| Situação | O que o cliente faz |
|---|---|
| `GET` com erro de rede, timeout, `503` | Repete com backoff exponencial e jitter, até 3 vezes |
| `429` | Espera o `Retry-After`, pausa o polling daquela consulta e mostra a contagem ([Estados](https://claude.ai/artifact/HQUEd6yYcP5mNrDwmegSkL)) |
| `POST` com `Idempotency-Key` (`/deposit`, `/withdraw`, `/place_order`, `/cancel_order`, [Q13](99-decisoes.md#q13)) | Repete **com a mesma chave** em rede, timeout, `503` e `429`. A chave nasce no clique do usuário (uma por intenção), no composable, não no `*.api.ts` |
| `POST` sem chave (`/signup`, `/login`) | Não repete sozinho |
| `4xx` de domínio | Nunca repete |

- Botão de envio fica desabilitado enquanto a requisição está pendente.
- Resposta repetida de uma chave já processada é sucesso, não erro.
- Polling do mercado (`refetchInterval`) fica dentro do orçamento de [rate limiting](07-rate-limiting.md) e para quando a aba está oculta. Depois de enviar ou cancelar ordem, invalide ordens, saldos e livro.

### 4.3 Erros

Cada tipo tem **um canal**, e o status vira mensagem **no composable**, por uma tabela `status → tipo` tipada, nunca num `switch` no componente:

| Erro | Canal |
|---|---|
| Validação do schema | Abaixo do campo, depois de tocado |
| `422` / `409` numa boleta ou formulário | Alerta no topo do formulário, com a mensagem do backend e como resolver |
| `404` | Estado "não encontrado" da tela |
| `503` | Faixa de indisponibilidade com nova tentativa |
| `429` | Aviso com contagem regressiva |
| `401` | Sessão encerrada: volta para `/entrar` com retorno à rota de origem |
| Exceção não tratada | Error boundary por página, com o logger |

Todo `catch` faz uma de três coisas: relança, avisa o usuário ou loga. `catch` vazio, `alert()` e `console.*` como feedback são proibidos.

---

## 5. Autenticação

Desenho completo em [autenticação §6](08-autenticacao-entre-servicos.md#6-identidade-do-usu%C3%A1rio-sess%C3%A3o-no-account-jwt-interno-at%C3%A9-o-servi%C3%A7o). O que importa para o front:

- `POST /login` devolve `204` e um cookie `session` `HttpOnly`. O front **não lê, não guarda e não manda token**: o browser envia o cookie sozinho (`credentials: 'include'`, mesma origem do edge).
- Depois do login, `GET /me` diz quem é o usuário (`accountId`, nome, e-mail). É a primeira chamada ao abrir o app; `401` ali significa "não logado".
- Os corpos de `/deposit`, `/withdraw`, `/place_order` e `/cancel_order` **não levam `accountId`**. Nas rotas com `:accountId`, use o do `/me`.
- `POST /logout` encerra a sessão; o front limpa o cache do Vue Query e o store de sessão e vai para `/entrar`.
- Erros: `401 invalidCredentials` no login (mensagem única "E-mail ou senha incorretos."), `429 tooManyLoginAttempts` com `Retry-After` (bloqueio progressivo), `401 unauthenticated` em qualquer rota privada (sessão acabou, §4.3).

No front, a proteção é **declarada em cada rota** (`requiresAuth`) e resolvida num guard central no router, a partir do `/me`. Componente nenhum decide acesso.

---

## 6. Formulários

- **Schema Zod fora do componente** é a fonte única: validação e tipo (`z.infer`).
- Estado do formulário separado da submissão (chamada, pendente, erro da API).
- Valida texto no blur, seleção no change. Campo condicional por `discriminatedUnion`, nunca `if` no submit.
- Senha do cadastro mostra as regras do objetivo como checklist ao vivo (8 caracteres, minúscula, maiúscula, número).
- CPF com máscara visual; o schema remove a máscara antes de validar.

---

## 7. Visual, tema e acessibilidade

- Só os componentes e tokens do **Lastro**. Nenhuma cor literal; nada de `!important` para sobrescrever tema.
- **Tema escuro por padrão:** um script inline no `<head>` aplica `data-theme` antes do primeiro paint; sem preferência salva, é `dark`. O claro só por escolha do usuário.
- **WCAG 2.1 AA:** HTML semântico, `<label>` em todo campo, foco visível, contraste conferido nos dois temas, `prefers-reduced-motion` respeitado. Compra e venda nunca só por cor (rótulo ou ▲/▼).
- **Textos:** pt-BR, caixa de sentença, botão com verbo, erro que diz como resolver. Sem i18n por enquanto, mas toda string de UI sai de um arquivo de mensagens por contexto, para a troca ser mecânica depois.

---

## 8. Desempenho

- Toda rota é lazy; o gráfico de profundidade carrega sob demanda.
- Metas: LCP < 2,5 s, CLS < 0,1, INP < 200 ms.
- Skeleton com a forma final; nunca spinner de página inteira.
- Intervalos, listeners e polling são limpos ao desmontar.
- Antes de adicionar uma dependência, olhe o peso no bundle.

---

## 9. Segurança

- Nunca renderizar HTML vindo da API ou do usuário (`dangerouslySetInnerHTML` proibido).
- Nenhum segredo em variável `VITE_*`; `.env.example` sem valores; variáveis tipadas.
- `rel="noopener noreferrer"` em todo `target="_blank"`.
- Sem `console.*` em produção (lint `error` no build).

---

## 10. Observabilidade

- Logger estruturado (`createLogger(context)`) com `timestamp`, `level`, `context`, `accountId` e o `X-Request-Id` da requisição, o mesmo id que o edge repassa aos serviços.
- Nunca logar senha, CPF ou cookie.
- Error boundary e handler global logam pelo logger; o APM (fora do escopo da PoC) entra atrás da mesma interface.

---

## 11. Testes

Mesma regra do [backend](05-estrategia-de-testes.md): cada regra no nível mais baixo onde existe, e testes repetíveis.

| Nível | O quê | Como |
|---|---|---|
| Unidade | VOs, formatação, schemas, tabela de erros, cálculo da boleta | Vitest puro, sem DOM |
| Composable de caso de uso | Fluxo de envio, retry com a mesma chave, `429` | Cliente de API injetado por interface, com fake em memória |
| Componente | O que o usuário vê e faz | Testing Library por papel e rótulo, MSW na rede com `onUnhandledRequest: 'error'` |
| E2E | Cadastro → depósito → ordem → aparece em Ordens | Playwright contra a plataforma em Docker |

Sem snapshot, sem seletor CSS ou test-id quando há papel acessível, sem rede real no CI. Os handlers do MSW simulam `422`, `409`, `429` com `Retry-After` e `503`.

---

## 12. Qualidade e entrega

- CI: `typecheck → lint (--max-warnings 0) → test → build`, com lockfile congelado; qualquer falha bloqueia o merge. Tudo dentro do container, como no backend.
- Todo componente novo do Lastro ganha o preview no design system no mesmo PR; antes de criar um componente, procure no catálogo.
- Exceção a qualquer regra deste documento exige registro em [decisões](99-decisoes.md).
