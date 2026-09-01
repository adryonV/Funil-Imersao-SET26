// build.mjs — runs on the GitHub Actions runner (Node 20+, no dependencies).
//
// Cross-references two shared Google Sheets and writes ./public/data.json for the
// static dashboard. READ-ONLY: it only fetches the sheets via CSV/gviz export
// endpoints; it never writes to them.
//
// DATA MODEL (Imersão-SET26) -------------------------------------------------
//   1) Métricas dos Anúncios — aba "Meta Ads": Day / Campaign Name / Ad Set Name /
//      Ad Name / Amount Spent / Impressions / Link Clicks / Landing Page Views /
//      Checkouts Initiated. One row per day×campaign×conjunto×anúncio.
//   2) Lista de Compradores — aba "Imersão 0 ao Lucro 3":
//      Data / Nome / Email / Valor da Compra / Forma de Pagto / Utm_source /
//      utm_campaign / utm_medium / utm_content / Utm_term / Origem de Checkout / DATA (UTC-3).
//      One row per sale. ATRIBUIÇÃO DO CRIATIVO vem das UTMs (nesta conta o
//      utm_content JÁ traz o nome do anúncio): utm_campaign→campanha,
//      utm_medium→conjunto, utm_content→anúncio. A coluna "Origem de Checkout"
//      (SCK do Meta) é usada só como fallback quando a UTM não resolve o anúncio.
//      VALUE: coluna "Valor da Compra" em REAL (BRL), usada direto.
//
// FILTRO DE DATA: só entram vendas de SALES_FROM (2026-09-01) em diante — o
//   lançamento anterior (Imersão-JUN26) vive na mesma planilha e é descartado.
//
// MOEDA: a conta é em REAL (BRL). Imposto obrigatório ×1,1385 aplicado NO
//   DASHBOARD (o data.json guarda o gasto BRUTO; meta.tax carrega o fator).

import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';

// --- Sources ----------------------------------------------------------------
const ADS_ID    = '1mXaJWC2Eecu7eSwQ8UkamO_sLCIuZCtI5u7tA0YRYFU';
const BUYERS_ID  = '1Qe1_LFcrd98hhOTa5rJAL78ZRUoHCZ-Pj4kIRgdiljI';
const SALES_GID  = '2093645749';                 // aba "Imersão 0 ao Lucro 3"
const SALES_TAB  = 'Imersão 0 ao Lucro 3';       // só rótulo p/ exibição

// Lemos a aba pelo GID (determinístico): esta planilha tem várias abas com nomes
// parecidos ("Imersão 0 ao Lucro" 1/2/3) e o gviz por NOME resolve a errada.
const SHEET_ADS   = `https://docs.google.com/spreadsheets/d/${ADS_ID}/export?format=csv&gid=0`;
const SHEET_SALES = `https://docs.google.com/spreadsheets/d/${BUYERS_ID}/export?format=csv&gid=${SALES_GID}`;

const ADS_URL    = `https://docs.google.com/spreadsheets/d/${ADS_ID}/edit`;
const BUYERS_URL = `https://docs.google.com/spreadsheets/d/${BUYERS_ID}/edit`;

// --- Só vendas deste lançamento (01/09/2026 em diante) ----------------------
const SALES_FROM = '2026-09-01';                 // YYYY-MM-DD, inclusivo

// --- Tax on ad spend --------------------------------------------------------
// Conta em REAL: imposto obrigatório de 13,85% sobre o gasto.
const TAX_RATE = 1.1385;

// --- Ticket de fallback (só se uma venda vier sem "Valor da Compra") --------
const FALLBACK_TICKET = 49;

// --- utm_source values that mean "paid Meta traffic" ------------------------
const isPaidSource = (s) => /^(fb|facebook|facebook[-\s]?ads|meta|meta[-\s]?ads|ig|instagram)$/i.test(String(s || '').trim());

// ---------------------------------------------------------------------------
// CSV parser (quoted fields, escaped quotes, embedded newlines)
function parseCSV(text) {
  const rows = [];
  let row = [], field = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += c;
    } else {
      if (c === '"') inQ = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else if (c === '\r') { /* ignore */ }
      else field += c;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// Number in Brazilian or plain format: "1.234,56" / "46,9" / "197"
function num(s) {
  if (s == null) return 0;
  s = String(s).trim().replace(/^R\$\s*/i, '');
  if (!s) return 0;
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : 0;
}

// Collapse whitespace + trim (join keys sometimes differ only by double spaces).
const normKey = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
// Lowercase + strip accents (for matching).
const fold = (s) => normKey(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

// Decode a URL-encoded UTM then normalize.
function decodeUtm(s) {
  let v = String(s == null ? '' : s);
  if (v.includes('%')) { try { v = decodeURIComponent(v.replace(/\+/g, ' ')); } catch { /* keep */ } }
  return normKey(v);
}
const isUtm = (s) => {
  const v = String(s == null ? '' : s).trim().toLowerCase();
  return v !== '' && v !== 'undefined' && !v.includes('{{');
};
// Meta sometimes appends "|<numeric id>" to UTM values. Strip a trailing "|<6+ digits>".
const stripId = (s) => decodeUtm(s).replace(/\s*\|\s*\d{6,}\s*$/, '').trim();
// utm_content occasionally = "<AdName>|<id>::<fbclid junk>::" → take the ad name.
const cleanContent = (s) => {
  let v = decodeUtm(s).split('::')[0].split('|')[0];
  return normKey(v);
};

const pad = (n) => String(n).padStart(2, '0');

// Extract YYYY-MM-DD from "01/09/2026 12:12", "1/9/2026", ISO…
function isoDate(s) {
  const t = String(s || '').trim();
  let m = t.match(/^(\d{4})-(\d{2})-(\d{2})/);            // ISO
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = t.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);           // D/M/YYYY (Brazil)
  if (m) return `${m[3]}-${pad(+m[2])}-${pad(+m[1])}`;
  return null;
}

async function fetchText(url, label) {
  const r = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': 'funnel-dashboard-build' } });
  if (!r.ok) throw new Error(`Fetch failed ${r.status} for ${label}`);
  const body = await r.text();
  if (/^\s*<!DOCTYPE html/i.test(body)) {
    throw new Error(`Got an HTML page instead of CSV for ${label} — the sheet is probably NOT shared publicly (set "Anyone with the link → Viewer").`);
  }
  return body;
}
// Case/space-insensitive header lookup; accepts several aliases.
function headerIndex(h, ...names) {
  const want = names.map((n) => fold(n));
  return h.findIndex((x) => want.includes(fold(x)));
}

(async () => {
  const [csvAds, csvSales] = await Promise.all([
    fetchText(SHEET_ADS, 'ads sheet'),
    fetchText(SHEET_SALES, `buyers tab "${SALES_TAB}"`),
  ]);

  // ---------------- Sheet 1: Meta Ads metrics ----------------
  const a = parseCSV(csvAds);
  const h1 = a[0] || [];
  const I = {
    day:   headerIndex(h1, 'Day'),
    camp:  headerIndex(h1, 'Campaign Name'),
    set:   headerIndex(h1, 'Ad Set Name'),
    ad:    headerIndex(h1, 'Ad Name'),
    spend: headerIndex(h1, 'Amount Spent'),
    imp:   headerIndex(h1, 'Impressions'),
    clk:   headerIndex(h1, 'Link Clicks'),
    lpv:   headerIndex(h1, 'Landing Page Views'),
    chk:   headerIndex(h1, 'Checkouts Initiated'),
  };
  const ads = [];
  for (let i = 1; i < a.length; i++) {
    const r = a[i];
    if (!r || r.length < 2) continue;
    const day = String(r[I.day] || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
    ads.push({
      d: day,
      c: normKey(r[I.camp]),
      s: normKey(r[I.set]),
      a: normKey(r[I.ad]),
      spend: num(r[I.spend]),                       // GROSS — tax applied in dashboard
      imp: Math.round(num(r[I.imp])),
      clk: Math.round(num(r[I.clk])),
      lpv: I.lpv >= 0 ? Math.round(num(r[I.lpv])) : 0,
      ic:  I.chk >= 0 ? Math.round(num(r[I.chk])) : 0,
    });
  }

  // Canonical name lookups (folded → original ads-sheet spelling) so a sale's
  // campaign/conjunto/anúncio join EXACTLY to the ad rows in the grouping tables.
  const canonCamp = new Map(), canonSet = new Map(), canonAd = new Map();
  // Ad-name → {campaign, adset} it spent most under (fallback attribution).
  const spendByCombo = new Map();
  for (const r of ads) {
    if (r.c) canonCamp.set(fold(r.c), r.c);
    if (r.s) canonSet.set(fold(r.s), r.s);
    if (r.a) canonAd.set(fold(r.a), r.a);
    if (r.a) {
      const ak = fold(r.a);
      const m = spendByCombo.get(ak) || new Map();
      const k = r.c + '||' + r.s;
      m.set(k, (m.get(k) || 0) + r.spend);
      spendByCombo.set(ak, m);
    }
  }
  const adToCombo = new Map();
  for (const [ak, m] of spendByCombo) {
    let best = '||', bestSpend = -Infinity;
    for (const [k, sp] of m) if (sp > bestSpend) { bestSpend = sp; best = k; }
    const [c, s] = best.split('||');
    adToCombo.set(ak, { c, s });
  }

  // (anúncio + conjunto) → campanha de maior gasto — resolve a campanha exata quando
  // temos o par anúncio/conjunto mas não a campanha (um mesmo anúncio roda em 2 campanhas).
  const campByAdSet = new Map(); // "fold(ad)|fold(set)" -> Map(campanha -> gasto)
  for (const r of ads) {
    if (!r.a) continue;
    const k = fold(r.a) + '|' + fold(r.s);
    const mm = campByAdSet.get(k) || new Map();
    mm.set(r.c, (mm.get(r.c) || 0) + r.spend);
    campByAdSet.set(k, mm);
  }
  const campForAdSet = (adFold, setFold) => {
    const mm = campByAdSet.get(adFold + '|' + setFold);
    if (!mm) return '';
    let best = '', bs = -Infinity;
    for (const [c, sp] of mm) if (sp > bs) { bs = sp; best = c; }
    return best;
  };

  // SCK / "Origem de Checkout" (Site Custom Key do Meta), formato desta conta:
  // "<source>|<conjunto>|<campanha>|<ANÚNCIO>|<placement>". Usado só como fallback
  // (as UTMs desta conta já vêm corretas). Conjunto e campanha têm " | " interno,
  // então casamos pelo MAIOR nome conhecido presente como substring na SCK.
  const longestInSck = (rawSck, canonMap) => {
    const hay = fold(rawSck);
    let best = '', bestLen = 0;
    for (const [cf, orig] of canonMap) if (cf && cf.length > bestLen && hay.includes(cf)) { bestLen = cf.length; best = orig; }
    return best;
  };

  // ---------------- Sheet 2: buyers (aba "Imersão 0 ao Lucro 3") ----------------
  const b = parseCSV(csvSales);
  const h2 = b[0] || [];
  const B = {
    date: headerIndex(h2, 'Data', 'DATA', 'Data | Hora', 'Data da Compra'),
    name: headerIndex(h2, 'Nome', 'NOME', 'Nome Completo'),
    mail: headerIndex(h2, 'Email', 'E-mail'),
    src:  headerIndex(h2, 'Utm_source', 'UTM Source', 'utm_source'),
    med:  headerIndex(h2, 'utm_medium', 'UTM Medium'),
    camp: headerIndex(h2, 'utm_campaign', 'UTM Campaign'),
    cont: headerIndex(h2, 'utm_content', 'UTM Content'),
    sck:  headerIndex(h2, 'Origem de Checkout', 'SCK', 'Site Custom Key'),
  };
  // Coluna de valor da compra (em BRL).
  const valIdx = headerIndex(h2, 'Valor da Compra', 'Valor', 'Bruto', 'Valor Bruto',
                             'Faturamento', 'Preço', 'Preco', 'Amount', 'Value', 'Revenue');
  const hasValueCol = valIdx >= 0;

  const sales = [];
  const attribution = { ad: 0, adset: 0, campaign: 0, unmatched: 0, none: 0 };
  let trafficSales = 0, valuedFromCol = 0, sckAttributed = 0, droppedByDate = 0;

  for (let i = 1; i < b.length; i++) {
    const r = b[i];
    if (!r || r.length < 1) continue;
    const d = isoDate(r[B.date]);
    if (!d) continue;
    if (d < SALES_FROM) { droppedByDate++; continue; }   // só o lançamento atual
    const name = normKey(r[B.name]);
    const mail = normKey(B.mail >= 0 ? r[B.mail] : '');
    const rawSrc  = String(r[B.src]  || '');
    const rawMed  = String(r[B.med]  || '');
    const rawCamp = String(r[B.camp] || '');
    const rawCont = String(r[B.cont] || '');
    const rawSck  = String(B.sck >= 0 ? r[B.sck] : '');
    const hasUtm = [rawSrc, rawMed, rawCamp, rawCont].some(isUtm);
    // Skip placeholder/empty rows (only a date, no identity, no UTM).
    if (!name && !mail && !hasUtm) continue;

    // Valor: coluna "Valor da Compra" (BRL), senão o ticket de fallback.
    let value = FALLBACK_TICKET;
    if (hasValueCol) {
      const vv = num(r[valIdx]);
      if (vv > 0) { value = Math.round(vv * 100) / 100; valuedFromCol++; }
    }

    const paid = isPaidSource(rawSrc);
    let src = 'organico', m = 'none', c = '', s = '', ad = '';
    if (paid) {
      src = 'meta-ads';
      // 1) UTMs primeiro (nesta conta o utm_content já traz o anúncio correto).
      const uCamp = stripId(rawCamp), uSet = stripId(rawMed), uAd = cleanContent(rawCont);
      c  = canonCamp.get(fold(uCamp)) || (isUtm(uCamp) ? uCamp : '');
      s  = canonSet.get(fold(uSet))  || (isUtm(uSet)  ? uSet  : '');
      ad = canonAd.get(fold(uAd))    || '';
      // 2) Fallback SCK ("Origem de Checkout") se a UTM não resolveu o anúncio.
      if (!ad && rawSck) {
        ad = longestInSck(rawSck, canonAd);
        if (!s) s = longestInSck(rawSck, canonSet);
        if (!c) c = longestInSck(rawSck, canonCamp);
        if (ad) sckAttributed++;
      }
      // 3) Completa campanha/conjunto pelo anúncio quando faltarem.
      if (ad && (!c || !s)) {
        const byPair = campForAdSet(fold(ad), fold(s));
        if (!c && byPair) c = canonCamp.get(fold(byPair)) || byPair;
        const combo = adToCombo.get(fold(ad));
        if (combo) { if (!c) c = canonCamp.get(fold(combo.c)) || combo.c; if (!s) s = canonSet.get(fold(combo.s)) || combo.s; }
      }
      m = ad ? 'ad' : s ? 'adset' : c ? 'campaign' : (hasUtm ? 'unmatched' : 'none');
      trafficSales++;
      attribution[m]++;
    } else if (isUtm(rawSrc)) {
      src = fold(rawSrc);   // keep a real non-Meta source label (organico/direto/…)
    }
    sales.push({ d, v: Math.round(value * 100) / 100, src, m, c, s, a: ad });
  }
  const salesRows = sales.length;

  // ---------------- Output (reference data.json contract) ----------------
  const allDates = [...ads.map((x) => x.d), ...sales.map((x) => x.d)].sort();
  const now = new Date();
  const nowBR = now.toLocaleString('pt-BR', {
    timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  }).replace(',', '');

  const warnings = [];
  warnings.push(`Gasto acrescido do imposto obrigatório ×${TAX_RATE} (13,85%), aplicado antes de todas as métricas.`);
  warnings.push(`Somente vendas de ${SALES_FROM.split('-').reverse().join('/')} em diante (lançamento Imersão-SET26); ${droppedByDate} venda(s) anteriores descartadas.`);
  if (hasValueCol) {
    warnings.push(`Receita = coluna "${normKey(h2[valIdx])}" (em R$).`);
    const noVal = salesRows - valuedFromCol;
    if (noVal > 0) warnings.push(`${noVal} venda(s) sem valor na coluna — receita estimada em R$ ${FALLBACK_TICKET.toFixed(2)} cada (fallback).`);
  } else {
    warnings.push(`A aba "${SALES_TAB}" não tem coluna de valor — cada venda vale R$ ${FALLBACK_TICKET.toFixed(2)} (fallback).`);
  }
  if (sckAttributed > 0) warnings.push(`${sckAttributed} venda(s) atribuídas ao criativo pela coluna "Origem de Checkout" (SCK), quando a UTM não bastou.`);
  if (attribution.none > 0)      warnings.push(`${attribution.none} venda(s) de tráfego sem UTM — contam na receita, mas ficam em "Não atribuído".`);
  if (attribution.unmatched > 0) warnings.push(`${attribution.unmatched} venda(s) com UTM que não existe na planilha de anúncios (período fora da janela, outra conta ou UTM digitada errada).`);
  if (attribution.adset + attribution.campaign > 0) warnings.push(`${attribution.adset + attribution.campaign} venda(s) casaram só até conjunto/campanha, não até o anúncio.`);
  const nonTraffic = salesRows - trafficSales;
  if (nonTraffic > 0) warnings.push(`${nonTraffic} venda(s) fora do tráfego (utm_source ≠ Meta) — orgânico/direto; entram só como referência, não no funil/CAC/ROAS.`);

  const out = {
    meta: {
      title: 'Imersão-SET26 — Meta Ads',
      platform: 'Meta Ads',
      traffic_source: 'meta-ads',
      tax: TAX_RATE,
      currency: 'BRL',
      generated_at: now.toISOString(),
      generated_at_br: nowBR,
      date_min: allDates[0] || null,
      date_max: allDates[allDates.length - 1] || null,
      ads_url: ADS_URL,
      sales_url: BUYERS_URL,
      sales_tab: SALES_TAB,
      counts: {
        ads_rows: ads.length,
        sales_rows: salesRows,
        traffic_sales: trafficSales,
        attribution,
      },
      warnings,
    },
    ads,
    sales,
  };

  mkdirSync('public', { recursive: true });
  writeFileSync('public/data.json', JSON.stringify(out));

  // Cache-bust: stamp the current build id into index.html.
  try {
    const buildId = now.toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
    let html = readFileSync('public/index.html', 'utf8');
    html = html.replace(/const BUILD_ID = "[^"]*";/, `const BUILD_ID = "${buildId}";`);
    writeFileSync('public/index.html', html);
  } catch (e) { console.warn('BUILD_ID stamp skipped:', e.message); }

  console.log('Wrote public/data.json', out.meta.counts, out.meta.date_min, '→', out.meta.date_max);
  if (ads.length === 0) throw new Error('No ad rows parsed — aborting so the previous deploy is kept.');
})().catch((err) => { console.error(err); process.exit(1); });
