# Funil de Tráfego — Imersão-SET26 (Meta Ads)

Dashboard estático (GitHub Pages) que cruza **duas planilhas Google** e se reconstrói
sozinho **100% na nuvem** a cada 2 h. Nada roda no seu PC.

- **URL pública:** https://adryonv.github.io/Funil-Imersao-SET26/
- **Somente leitura** nas planilhas (export CSV/gviz) — nunca escreve nelas.

## Como funciona

1. `build.mjs` (Node, sem dependências) roda no GitHub Actions:
   - lê a planilha de **anúncios** (aba *Meta Ads*) e a de **compradores** (aba
     *Imersão 0 ao Lucro 3*);
   - considera **apenas vendas de 01/09/2026 em diante** (lançamento Imersão-SET26);
     o lançamento anterior, que vive na mesma planilha, é descartado;
   - atribui cada venda ao anúncio pelas UTMs
     (`utm_campaign`→campanha · `utm_medium`→conjunto · `utm_content`→anúncio),
     com a coluna *Origem de Checkout* (SCK) como fallback;
   - grava `public/data.json` **agregado, sem PII** (nomes/e-mails/telefones ficam fora).
2. A conta é em **Real (BRL)**. O gasto vai **bruto** no `data.json`; o dashboard
   aplica o **imposto obrigatório ×1,1385 (13,85%)** antes de todas as métricas
   (CPM, CPC, CAC, ROAS, etc.). A receita usa a coluna **Valor da Compra** (R$).
3. `index.html` é publicado na branch `gh-pages` (sem OIDC/deploy-pages).
4. `index.html` busca `data.json?v=<BUILD_ID>&t=<timestamp>` com `cache:no-store`
   (**cache-bust** duplo) — o navegador sempre pega a versão nova.

## Saúde do funil

Teto de **CAC = R$ 49** (definido pelo cliente). Bandas, piso de ROAS e tetos de
CPC/CPM são derivados dele. Editável no topo do `<script>` de `public/index.html`
(`const CAC_GOAL`).

## Gatilhos do build

- `schedule` a cada 2 h (backup) · `workflow_dispatch` (botão manual) ·
  `repository_dispatch type=rebuild` (cron-job.org) · `push` na `main`.

### cron-job.org (a cada 2 h)

- **Method:** `POST`
- **URL:** `https://api.github.com/repos/adryonV/Funil-Imersao-SET26/dispatches`
- **Headers:**
  - `Accept: application/vnd.github+json`
  - `Authorization: Bearer <SEU_TOKEN>`
  - `X-GitHub-Api-Version: 2022-11-28`
  - `User-Agent: cron-job`
- **Body:** `{"event_type":"rebuild"}`

O token vive **só** no cron-job.org, nunca neste repositório.
