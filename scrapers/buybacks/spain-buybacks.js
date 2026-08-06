'use strict';
/**
 * ES — Share Buyback Scraper
 *
 * Source: CNMV "Participaciones Significativas y Autocartera en Sociedades
 * cotizadas" (Significant Shareholdings and Treasury Shares in Listed
 * Companies) — https://www.cnmv.es/Portal/consultas/busqueda?id=7
 *
 * ── Why Puppeteer, not plain HTTP ──────────────────────────────────────────
 * The search form is classic ASP.NET WebForms (__VIEWSTATE/__EVENTVALIDATION
 * postback). A raw HTTP replay of the postback chain (GET form → POST search
 * → POST company-select) DOES reach the company-selection step correctly,
 * but the final per-company detail page (`.../DerechosVoto/Autocartera?
 * qS={GUID}`) consistently returned CNMV's CVFE error page — confirmed this
 * is NOT the documented geo-block (a real insider-transaction PDF fetched
 * fine from the same IP in the same investigation), so it's something about
 * this specific page's session/state handling that a scripted HTTP replay
 * doesn't reproduce correctly. A real Puppeteer browser session reaches it
 * with zero issues — verified live, same as portugal.js's CMVM portal.
 *
 * ── What this data source actually contains (read before "fixing" gaps) ────
 * Unlike Nordic/UK press releases ("running between X and Y", "up to £300m"),
 * every filing here is the SAME structured government form (Formulario
 * Modelo 2 — "Notificación de Operaciones Realizadas con Acciones Propias"),
 * triggered whenever a company's treasury-share % crosses a threshold or is
 * otherwise updated. It reports a TABLE of individual daily transactions
 * (date, Adquisición/Transmisión, shares, price) for the period leading up
 * to the trigger, not a clean "program announcement with start/end date and
 * authorised maximum" the way other markets' scrapers extract. There is no
 * separate "here is a brand-new buyback program" document type to filter
 * for — confirmed by reading multiple real filings, not assumed. So:
 *   - announced_date = this notification's own date (real, always present)
 *   - program_end / total_value = best-effort only, extracted from the
 *     free-text "INFORMACIÓN ADICIONAL" section when a filing happens to
 *     mention an explicit end date or authorised amount — usually null.
 *     This mirrors belgium-buybacks.js's "metadata only, by design" stance
 *     rather than fabricating structure the source doesn't have.
 *   - shares_bought / avg_price ARE reliably extractable — summed/weighted
 *     from the real per-day "Adquisición" (A) rows in each filing's table.
 *
 * A filing is only saved if it contains at least one real Adquisición (A)
 * row with a nonzero price — i.e. genuine open-market purchases, not a
 * notification driven purely by a Transmisión (sale/cancellation, e.g. an
 * amortización reducing share count) with no buying activity at all.
 *
 * ── Company discovery ───────────────────────────────────────────────────────
 * The company dropdown on the search page is populated dynamically from
 * whichever companies had ANY notification in the searched date range — it's
 * not a fixed master list. Search a wide window (LOOKBACK_DAYS default 365)
 * so infrequent filers still surface, then match dropdown entries against
 * TARGET_COMPANIES (a curated IBEX-35-ish list) rather than trying to crawl
 * all ~270 CNMV-registered issuers every run.
 */

const https                        = require('https');
const fs                           = require('fs');
const os                           = require('os');
const path                         = require('path');
const { execSync }                 = require('child_process');
const puppeteer                    = require('puppeteer');
const { saveBuybackPrograms, logScraperRun } = require('../lib/db');
const { extractDateRange } = require('../lib/buybackDates');
const { findChromium } = require('../lib/findChromium');

const COUNTRY_CODE   = 'ES';
const SOURCE         = 'CNMV Spain';
const CURRENCY       = 'EUR';
// Default 90 days (overridable via LOOKBACK_DAYS, e.g. for a one-off wider
// backfill) — matches belgium-buybacks.js's own default for the same
// trade-off: wide enough that dropdown-based company discovery still finds
// companies filing every 1-3 months, without re-fetching/re-parsing a full
// year of history on every weekly CI run. A 365-day run (used for this
// scraper's initial build/testing) took ~8 minutes for ~90 filings across
// 25 companies; running that every week in the shared buybacks-weekly.yml
// job (6 other scrapers before this one, 30-minute job timeout) would be
// both wasteful and a real timeout risk for no benefit, since the upsert
// already dedups on filing_id regardless of window size.
const RETENTION_DAYS = parseInt(process.env.LOOKBACK_DAYS || '90');
const BASE_URL       = 'https://www.cnmv.es/Portal/consultas/busqueda?id=7';
const NAV_TIMEOUT    = 60000;
const PDF_DELAY_MS   = 300;

// Target companies — name fragments (matched case/accent-insensitively
// against the CNMV dropdown's official "Denominación Social" text) → ticker.
// Tickers copied from spain.js's own TICKER_MAP for consistency with the
// insider-transactions scraper rather than re-guessed here.
const TARGET_COMPANIES = [
  ['banco bilbao vizcaya', 'BBVA'],
  ['banco santander',      'SAN'],
  ['iberdrola',            'IBE'],
  ['inditex',              'ITX'],
  ['telefonica',           'TEF'],
  ['repsol',               'REP'],
  ['caixabank',            'CABK'],
  ['cellnex',              'CLNX'],
  ['ferrovial',            'FER'],
  ['acs, actividades',     'ACS'],
  ['acciona, s.a.',        'ANA'],
  ['amadeus it group',     'AMS'],
  ['aena',                 'AENA'],
  ['colonial',             'COL'],
  ['endesa',               'ELE'],
  ['grifols',              'GRF'],
  ['international consolidated airlines', 'IAG'],
  ['mapfre',               'MAP'],
  ['melia',                'MEL'],
  ['naturgy',              'NTGY'],
  ['pharma mar',           'PHM'],
  ['redeia',               'RED'],
  ['banco de sabadell',    'SAB'],
  ['solaria',              'SLR'],
  ['viscofan',             'VIS'],
  ['fluidra',              'FDR'],
  ['vidrala',              'VID'],
];

function normalize(s) {
  return (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
}

function matchTarget(companyName) {
  const norm = normalize(companyName);
  for (const [frag, ticker] of TARGET_COMPANIES) {
    if (norm.includes(normalize(frag))) return ticker;
  }
  return null;
}

function isoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function cutoff() { const d = new Date(); d.setDate(d.getDate() - RETENTION_DAYS); return d; }
// "01/07/2026" → "2026-07-01"
function esDateToIso(s) {
  const m = (s || '').trim().match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}
// Spanish number format: "1.337.892" (thousands=.) or "19,36" (decimal=,)
function parseEsNum(s) {
  if (!s) return null;
  const str = s.toString().trim();
  if (!str || str === '...') return null;
  const cleaned = str.replace(/\./g, '').replace(',', '.');
  const n = parseFloat(cleaned);
  return isNaN(n) ? null : n;
}

// ─── Chromium resolution ────────────────────────────────────────────────────
// Delegated to lib/findChromium.js (shared with portugal.js and
// singapore.js) — see that file's header for why: it now also scans the
// real puppeteer download cache directly by filesystem, since
// puppeteer.executablePath() alone was confirmed to resolve incorrectly
// under run-daily.sh's cron+.env-sourced context (portugal.js and
// singapore.js were both silently saving 0 rows for weeks because of it).

function launchBrowser(chromiumPath) {
  return puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--disable-software-rasterizer'],
    ...(chromiumPath ? { executablePath: chromiumPath } : {}),
  });
}

// ─── Step 1: search + company discovery ───────────────────────────────────────

async function searchAndListCompanies(page, fromIso, toIso) {
  await page.goto(BASE_URL, { waitUntil: 'networkidle2', timeout: NAV_TIMEOUT });
  await page.waitForSelector('#ctl00_ContentPrincipal_wFechas_fecha_desde', { timeout: NAV_TIMEOUT });
  await page.evaluate((from, to) => {
    document.querySelector('#ctl00_ContentPrincipal_wFechas_fecha_desde').value = from;
    document.querySelector('#ctl00_ContentPrincipal_wFechas_fecha_hasta').value = to;
  }, fromIso, toIso);
  await Promise.all([
    page.click('#ctl00_ContentPrincipal_btnOk'),
    page.waitForNavigation({ waitUntil: 'networkidle2', timeout: NAV_TIMEOUT }).catch(() => null),
  ]);
  await new Promise(r => setTimeout(r, 800));

  return page.evaluate(() => {
    const sel = document.querySelector('#ctl00_ContentPrincipal_wbusqueda_lstSeleccion');
    if (!sel) return [];
    return Array.from(sel.options).map(o => ({ value: o.value, text: o.textContent.trim() }));
  });
}

// ─── Step 2: select one company, follow through to its notification history ──

async function fetchCompanyNotifications(page, fromIso, toIso, nif) {
  // Re-run the search fresh for each company — ASP.NET WebForms postback
  // state is page-specific; re-navigating from BASE_URL each time is slower
  // than trying to reuse in-page state but far more robust.
  await page.goto(BASE_URL, { waitUntil: 'networkidle2', timeout: NAV_TIMEOUT });
  await page.waitForSelector('#ctl00_ContentPrincipal_wFechas_fecha_desde', { timeout: NAV_TIMEOUT });
  await page.evaluate((from, to) => {
    document.querySelector('#ctl00_ContentPrincipal_wFechas_fecha_desde').value = from;
    document.querySelector('#ctl00_ContentPrincipal_wFechas_fecha_hasta').value = to;
  }, fromIso, toIso);
  await Promise.all([
    page.click('#ctl00_ContentPrincipal_btnOk'),
    page.waitForNavigation({ waitUntil: 'networkidle2', timeout: NAV_TIMEOUT }).catch(() => null),
  ]);
  await new Promise(r => setTimeout(r, 500));

  const hasCompany = await page.evaluate((nifVal) => {
    const sel = document.querySelector('#ctl00_ContentPrincipal_wbusqueda_lstSeleccion');
    return !!(sel && Array.from(sel.options).some(o => o.value === nifVal));
  }, nif);
  if (!hasCompany) return null;

  await page.select('#ctl00_ContentPrincipal_wbusqueda_lstSeleccion', nif);
  await Promise.all([
    page.click('#ctl00_ContentPrincipal_wbusqueda_btnSeleccionar'),
    page.waitForNavigation({ waitUntil: 'networkidle2', timeout: NAV_TIMEOUT }).catch(() => null),
  ]);
  await new Promise(r => setTimeout(r, 500));

  const autocarteraHref = await page.evaluate(() => {
    const a = Array.from(document.querySelectorAll('a')).find(a => (a.getAttribute('href') || '').toLowerCase().includes('autocartera.aspx'));
    return a ? a.getAttribute('href') : null;
  });
  if (!autocarteraHref) return [];

  await Promise.all([
    page.evaluate((href) => {
      const a = Array.from(document.querySelectorAll('a')).find(a => a.getAttribute('href') === href);
      if (a) a.click();
    }, autocarteraHref),
    page.waitForNavigation({ waitUntil: 'networkidle2', timeout: NAV_TIMEOUT }).catch(() => null),
  ]);
  await new Promise(r => setTimeout(r, 500));

  // The detail page always shows just the LATEST notification. Follow
  // "previous notifications" (if present) to get the full dated history —
  // each row there also carries its own document link.
  const prevHref = await page.evaluate(() => {
    const a = document.querySelector('a[href*="NotificacionesAnterioresAC"]');
    return a ? a.getAttribute('href') : null;
  });

  let rows = await page.evaluate(() => {
    const a = document.querySelector('a[id*="LinkFRegistro"]');
    const dateCell = a ? a.textContent.trim() : null;
    return a ? [{ date: dateCell, href: a.getAttribute('href') }] : [];
  });

  if (prevHref) {
    await Promise.all([
      page.evaluate(() => { document.querySelector('a[href*="NotificacionesAnterioresAC"]').click(); }),
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: NAV_TIMEOUT }).catch(() => null),
    ]);
    await new Promise(r => setTimeout(r, 500));
    rows = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('a[id*="LinkFRegistro"]')).map(a => ({
        date: a.textContent.trim(),
        href: a.getAttribute('href'),
      }));
    });
  }

  return rows;
}

// ─── PDF fetch + parse ─────────────────────────────────────────────────────────

function downloadPdf(url) {
  return new Promise((resolve) => {
    const req = https.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
    }, res => {
      if (res.statusCode !== 200) { res.resume(); return resolve(null); }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        if (buf.length < 8 || buf.slice(0, 4).toString() !== '%PDF') return resolve(null);
        resolve(buf);
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(30000, () => { req.destroy(); resolve(null); });
  });
}

function pdfToText(buffer) {
  const tmp = path.join(os.tmpdir(), `cnmv-${Date.now()}-${Math.random().toString(36).slice(2)}.pdf`);
  try {
    fs.writeFileSync(tmp, buffer);
    return execSync(`pdftotext -layout "${tmp}" -`, { encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'ignore'] }) || null;
  } catch { return null; }
  finally { try { fs.unlinkSync(tmp); } catch {} }
}

/**
 * Parse a Formulario Modelo 2 (Notificación de Operaciones Realizadas con
 * Acciones Propias). Returns null if this isn't a genuine buyback-relevant
 * filing (no real Adquisición transactions with a nonzero price).
 */
function parseAutocarteraPdf(text) {
  if (!text) return null;

  const nifM = text.match(/NIF\s*\|\s*TAX ID NO:?\s*([A-Z0-9-]+)/i);
  const companyM = text.match(/Denominaci[oó]n Social[^\n]*\n\s*([A-ZÀ-Ü][^\n]+)/i);
  const dateM = text.match(/FECHA QUE MOTIVA[^\n]*\n[^\n]*\n\s*(\d{2}\/\d{2}\/\d{4})/i);
  const isinM = text.match(/\b(ES\d{10})\b/);
  // CNMV's own registration number — e.g. "Registro de entrada Nº: 2026045262
  // 30/03/2026 16:32". This is the correct natural key for filing_id, NOT a
  // composite of company+date+shares: confirmed live that two GENUINELY
  // DIFFERENT filings for the same company can report identical shares-bought
  // figures with different (one apparently mistyped) trigger dates — IAG had
  // one filing correctly stating "20/10/2025" and another, registered 10 days
  // earlier, stating "20/10/2026" for what looks like the same underlying
  // transaction batch (same share count, near-identical avg price) — a
  // same-company-date-shares composite key collided on these two rows and
  // failed the whole upsert batch (Postgres: "ON CONFLICT DO UPDATE command
  // cannot affect row a second time"). The registration number doesn't have
  // this problem since CNMV assigns it uniquely per document regardless of
  // what the filer typed into the form.
  const regNumM = text.match(/Registro de entrada N[ºo]:?\s*(\d+)/i);

  // Per-day transaction rows: "21/05/2026   A   ES0113211835   1.337.892   19,36 ..."
  const txRe = /(\d{2}\/\d{2}\/\d{4})\s+([AT])\s+(ES\w{10})\s+([\d.,]+)\s+([\d.,]+|\.\.\.)/g;
  let m;
  const acquisitions = [];
  while ((m = txRe.exec(text)) !== null) {
    const [, dateStr, type, , sharesStr, priceStr] = m;
    if (type !== 'A') continue;
    const shares = parseEsNum(sharesStr);
    const price = priceStr === '...' ? null : parseEsNum(priceStr);
    if (shares && price != null && price > 0) acquisitions.push({ date: dateStr, shares, price });
  }
  if (!acquisitions.length) return null; // no genuine open-market purchases — skip

  const totalShares = acquisitions.reduce((s, a) => s + a.shares, 0);
  const totalValue   = acquisitions.reduce((s, a) => s + a.shares * a.price, 0);
  const avgPrice      = totalShares > 0 ? totalValue / totalShares : null;
  const lastTxDate     = acquisitions.map(a => a.date).sort((a, b) => esDateToIso(a).localeCompare(esDateToIso(b))).slice(-1)[0];

  // Best-effort: an explicit program end date or authorised max value is
  // occasionally (not usually) stated in the free-text "INFORMACIÓN
  // ADICIONAL" section — extract only when clearly present, leave null
  // otherwise rather than guessing.
  const addInfoM = text.match(/INFORMACI[OÓ]N ADICIONAL[^\n]*\n([\s\S]{0,800}?)(?:Lugar y fecha|$)/i);
  const addInfo = addInfoM ? addInfoM[1] : '';
  const hasProgramMention = /programa\s+de\s+recompra/i.test(addInfo) || /recompra\s+de\s+acciones/i.test(addInfo);
  const maxValueM = addInfo.match(/(?:hasta|m[aá]ximo)\s+(?:un\s+)?(?:importe\s+)?(?:de\s+)?(?:€|EUR)?\s*([\d.,]+)\s*(millones?|mill[oó]n)?\s*(?:€|euros|EUR)?/i);
  let maxValue = null;
  if (maxValueM) {
    const v = parseEsNum(maxValueM[1]);
    if (v) maxValue = maxValueM[2] ? Math.round(v * 1e6) : Math.round(v);
  }
  // Same best-effort spirit for an explicit program end date — covers the
  // Spanish "desde X hasta Y" / "del X al Y" phrasing when a filing happens
  // to state it (rare — see the file header on why this is usually null).
  const { start: programStart, end: programEndDate } = extractDateRange(addInfo);

  return {
    nif: nifM ? nifM[1] : null,
    company: companyM ? companyM[1].trim() : null,
    isin: isinM ? isinM[1] : null,
    registrationNumber: regNumM ? regNumM[1] : null,
    notificationDate: dateM ? esDateToIso(dateM[1]) : null,
    lastTxDateIso: lastTxDate ? esDateToIso(lastTxDate) : null,
    sharesBought: Math.round(totalShares),
    avgPrice: avgPrice ? Math.round(avgPrice * 10000) / 10000 : null,
    hasProgramMention,
    maxValue,
    programStart,
    programEnd: programEndDate,
  };
}

// ─── Main ──────────────────────────────────────────────────────────────────────

async function scrapeESBuybacks() {
  console.log('🇪🇸  CNMV Spain — Share Buyback Notifications (Puppeteer)');
  const t0 = Date.now();
  const co = cutoff();
  const fromIso = isoDate(co);
  const toIso   = isoDate(new Date());
  console.log(`  Lookback: ${RETENTION_DAYS} days (${fromIso} → ${toIso})`);

  let chromiumPath = findChromium();
  if (!chromiumPath) {
    console.log('  Attempting to install Chrome via puppeteer…');
    try {
      execSync('npx --yes puppeteer browsers install chrome', { stdio: 'inherit', timeout: 5 * 60 * 1000 });
      chromiumPath = findChromium();
    } catch (e) { console.log(`  ⚠  Install attempt failed: ${e.message}`); }
  }
  if (!chromiumPath) {
    console.error('  ❌ Could not find or install a working Chromium.');
    await logScraperRun(COUNTRY_CODE, 0, (Date.now() - t0) / 1000, 'failed');
    return { saved: 0 };
  }
  console.log(`  Using Chromium: ${chromiumPath}`);

  let browser;
  try {
    browser = await launchBrowser(chromiumPath);
  } catch (e) {
    console.error(`  ❌ Failed to launch browser: ${e.message}`);
    await logScraperRun(COUNTRY_CODE, 0, (Date.now() - t0) / 1000, 'failed');
    return { saved: 0 };
  }

  const dbRows = [];
  let companiesMatched = 0, companiesWithData = 0, pdfsParsed = 0, pdfsSkipped = 0;

  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(NAV_TIMEOUT);

    console.log('  Searching CNMV for companies with recent activity…');
    const options = await searchAndListCompanies(page, fromIso, toIso);
    console.log(`  ${options.length} companies found in date window`);

    const matched = [];
    for (const opt of options) {
      const ticker = matchTarget(opt.text);
      if (ticker) matched.push({ nif: opt.value, name: opt.text, ticker });
    }
    companiesMatched = matched.length;
    console.log(`  ${matched.length}/${TARGET_COMPANIES.length} target companies matched: ${matched.map(m => m.ticker).join(', ')}`);

    const missing = TARGET_COMPANIES.filter(([, tk]) => !matched.some(m => m.ticker === tk));
    if (missing.length) console.log(`  (no recent activity for: ${missing.map(([, tk]) => tk).join(', ')})`);

    for (const { nif, name, ticker } of matched) {
      let rows;
      try {
        rows = await fetchCompanyNotifications(page, fromIso, toIso, nif);
      } catch (e) {
        console.log(`  ⚠  ${ticker}: navigation failed (${e.message})`);
        continue;
      }
      if (!rows || !rows.length) continue;

      // Only fetch PDFs for notifications within the lookback window.
      const inWindow = rows.filter(r => {
        const iso = esDateToIso(r.date);
        return iso && iso >= fromIso;
      });
      if (!inWindow.length) continue;
      companiesWithData++;

      for (const row of inWindow) {
        await new Promise(r => setTimeout(r, PDF_DELAY_MS));
        const pdfBuf = await downloadPdf(row.href);
        if (!pdfBuf) { pdfsSkipped++; continue; }
        const text = pdfToText(pdfBuf);
        if (!text) { pdfsSkipped++; continue; }
        const parsed = parseAutocarteraPdf(text);
        if (!parsed) { pdfsSkipped++; continue; }
        pdfsParsed++;

        const notifDate = parsed.notificationDate || esDateToIso(row.date);
        // CNMV's own registration number is the correct unique key — see the
        // parseAutocarteraPdf comment on why a composite of company+date+
        // shares can collide (two distinct real filings, one with an
        // apparently mistyped date, reporting identical share counts).
        const fid = parsed.registrationNumber
          ? `ES-${parsed.registrationNumber}`
          : `ES-${parsed.nif || nif}-${notifDate}-${parsed.sharesBought}`;

        dbRows.push({
          filing_id:      fid,
          country_code:   COUNTRY_CODE,
          ticker,
          company:        parsed.company || name,
          announced_date: notifDate,
          execution_date: parsed.lastTxDateIso || notifDate,
          program_end:    parsed.programEnd, // best-effort only — see file header, usually null
          total_value:    parsed.maxValue, // best-effort only, usually null
          shares_bought:  parsed.sharesBought,
          avg_price:      parsed.avgPrice,
          currency:       CURRENCY,
          status:         'Active',
          filing_url:     row.href,
          source_url:     row.href,
          source:         SOURCE,
        });
      }
    }
  } finally {
    await browser.close().catch(() => {});
  }

  console.log(`  Companies matched: ${companiesMatched} | with in-window notifications: ${companiesWithData}`);
  console.log(`  PDFs parsed as genuine buybacks: ${pdfsParsed} | skipped (no real purchases / fetch failed): ${pdfsSkipped}`);

  if (!dbRows.length) {
    console.log('  0 rows to save.');
    await logScraperRun(COUNTRY_CODE, 0, (Date.now() - t0) / 1000, 'success');
    return { saved: 0 };
  }

  const { inserted, error } = await saveBuybackPrograms(dbRows);
  if (error) {
    await logScraperRun(COUNTRY_CODE, 0, (Date.now() - t0) / 1000, 'failed');
    console.error('  ❌ Supabase:', error.message);
    return { saved: 0 };
  }
  await logScraperRun(COUNTRY_CODE, inserted, (Date.now() - t0) / 1000, 'success');
  console.log(`  ✅ ${((Date.now() - t0) / 1000).toFixed(1)}s — ${inserted} saved`);
  return { saved: inserted };
}

scrapeESBuybacks().catch(err => {
  console.error('❌ Fatal:', err.message);
  process.exit(1);
});
