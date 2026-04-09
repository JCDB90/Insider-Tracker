const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  'https://loqmxllfjvdwamwicoow.supabase.co',
  'sb_publishable_wL5qlj7xHeE6-y2cXaRKfw_39-iEoUt'
);

// Today: 2026-04-09  — dates span the last 30 days
const transactions = [
  // ── Netherlands ──────────────────────────────────────────────────
  {
    ticker: 'ASML',   company: 'ASML Holding N.V.',
    insider_name: 'Christophe Fouquet', insider_role: 'CEO',
    transaction_type: 'SELL', transaction_date: '2026-04-07',
    shares: 8500, price_per_share: 724.60, total_value: 6159100,
    currency: 'EUR', country_code: 'NL',
    filing_url: 'https://www.afm.nl', source: 'AFM Netherlands',
  },
  {
    ticker: 'ASML',   company: 'ASML Holding N.V.',
    insider_name: 'Roger Dassen', insider_role: 'CFO',
    transaction_type: 'SELL', transaction_date: '2026-03-28',
    shares: 3200, price_per_share: 718.20, total_value: 2298240,
    currency: 'EUR', country_code: 'NL',
    filing_url: 'https://www.afm.nl', source: 'AFM Netherlands',
  },
  {
    ticker: 'ADYEN',  company: 'Adyen N.V.',
    insider_name: 'Ingo Uytdehaage', insider_role: 'Co-CEO',
    transaction_type: 'BUY', transaction_date: '2026-04-02',
    shares: 420, price_per_share: 1462.00, total_value: 614040,
    currency: 'EUR', country_code: 'NL',
    filing_url: 'https://www.afm.nl', source: 'AFM Netherlands',
  },
  {
    ticker: 'IMCD',   company: 'IMCD N.V.',
    insider_name: 'Marco Veenstra', insider_role: 'CFO',
    transaction_type: 'BUY', transaction_date: '2026-03-18',
    shares: 2100, price_per_share: 122.40, total_value: 257040,
    currency: 'EUR', country_code: 'NL',
    filing_url: 'https://www.afm.nl', source: 'AFM Netherlands',
  },

  // ── Germany ───────────────────────────────────────────────────────
  {
    ticker: 'SAP',    company: 'SAP SE',
    insider_name: 'Christian Klein', insider_role: 'CEO',
    transaction_type: 'BUY', transaction_date: '2026-04-05',
    shares: 14000, price_per_share: 231.80, total_value: 3245200,
    currency: 'EUR', country_code: 'DE',
    filing_url: 'https://www.bafin.de', source: 'BaFin Germany',
  },
  {
    ticker: 'SIE',    company: 'Siemens AG',
    insider_name: 'Roland Busch', insider_role: 'CEO',
    transaction_type: 'SELL', transaction_date: '2026-04-01',
    shares: 22000, price_per_share: 174.50, total_value: 3839000,
    currency: 'EUR', country_code: 'DE',
    filing_url: 'https://www.bafin.de', source: 'BaFin Germany',
  },
  {
    ticker: 'BAYN',   company: 'Bayer AG',
    insider_name: 'Bill Anderson', insider_role: 'CEO',
    transaction_type: 'BUY', transaction_date: '2026-03-25',
    shares: 55000, price_per_share: 26.14, total_value: 1437700,
    currency: 'EUR', country_code: 'DE',
    filing_url: 'https://www.bafin.de', source: 'BaFin Germany',
  },
  {
    ticker: 'DTE',    company: 'Deutsche Telekom AG',
    insider_name: 'Timotheus Höttges', insider_role: 'CEO',
    transaction_type: 'BUY', transaction_date: '2026-03-14',
    shares: 38000, price_per_share: 32.76, total_value: 1244880,
    currency: 'EUR', country_code: 'DE',
    filing_url: 'https://www.bafin.de', source: 'BaFin Germany',
  },

  // ── France ────────────────────────────────────────────────────────
  {
    ticker: 'MC',     company: 'LVMH Moët Hennessy',
    insider_name: 'Bernard Arnault', insider_role: 'Chairman & CEO',
    transaction_type: 'BUY', transaction_date: '2026-04-08',
    shares: 6500, price_per_share: 548.30, total_value: 3563950,
    currency: 'EUR', country_code: 'FR',
    filing_url: 'https://www.amf-france.org', source: 'AMF France',
  },
  {
    ticker: 'TTE',    company: 'TotalEnergies SE',
    insider_name: 'Patrick Pouyanné', insider_role: 'CEO',
    transaction_type: 'BUY', transaction_date: '2026-03-31',
    shares: 18000, price_per_share: 58.92, total_value: 1060560,
    currency: 'EUR', country_code: 'FR',
    filing_url: 'https://www.amf-france.org', source: 'AMF France',
  },

  // ── Poland ────────────────────────────────────────────────────────
  {
    ticker: 'PKN',    company: 'PKN Orlen S.A.',
    insider_name: 'Ireneusz Fąfara', insider_role: 'CEO',
    transaction_type: 'BUY', transaction_date: '2026-04-03',
    shares: 42000, price_per_share: 57.20, total_value: 2402400,
    currency: 'EUR', country_code: 'PL',
    filing_url: 'https://www.knf.gov.pl', source: 'KNF Poland',
  },
  {
    ticker: 'ALE',    company: 'Allegro.eu S.A.',
    insider_name: 'Aleksei Vinogradov', insider_role: 'CFO',
    transaction_type: 'SELL', transaction_date: '2026-03-22',
    shares: 95000, price_per_share: 34.80, total_value: 3306000,
    currency: 'EUR', country_code: 'PL',
    filing_url: 'https://www.knf.gov.pl', source: 'KNF Poland',
  },

  // ── Ireland ───────────────────────────────────────────────────────
  {
    ticker: 'CRH',    company: 'CRH plc',
    insider_name: 'Albert Manifold', insider_role: 'CEO',
    transaction_type: 'BUY', transaction_date: '2026-04-04',
    shares: 11500, price_per_share: 71.44, total_value: 821560,
    currency: 'EUR', country_code: 'IE',
    filing_url: 'https://www.centralbank.ie', source: 'CBI Ireland',
  },

  // ── Austria ───────────────────────────────────────────────────────
  {
    ticker: 'OMV',    company: 'OMV AG',
    insider_name: 'Alfred Stern', insider_role: 'CEO',
    transaction_type: 'SELL', transaction_date: '2026-03-27',
    shares: 28000, price_per_share: 39.86, total_value: 1116080,
    currency: 'EUR', country_code: 'AT',
    filing_url: 'https://www.fma.gv.at', source: 'FMA Austria',
  },

  // ── Sweden ────────────────────────────────────────────────────────
  {
    ticker: 'ERIC-B', company: 'Telefonaktiebolaget LM Ericsson',
    insider_name: 'Börje Ekholm', insider_role: 'CEO',
    transaction_type: 'BUY', transaction_date: '2026-03-19',
    shares: 210000, price_per_share: 8.94, total_value: 1877400,
    currency: 'EUR', country_code: 'SE',
    filing_url: 'https://www.fi.se', source: 'FI Sweden',
  },
  {
    ticker: 'VOLV-B', company: 'Volvo AB',
    insider_name: 'Jim Rowan', insider_role: 'CEO',
    transaction_type: 'SELL', transaction_date: '2026-04-06',
    shares: 85000, price_per_share: 21.30, total_value: 1810500,
    currency: 'EUR', country_code: 'SE',
    filing_url: 'https://www.fi.se', source: 'FI Sweden',
  },

  // ── Denmark ───────────────────────────────────────────────────────
  {
    ticker: 'NOVO-B', company: 'Novo Nordisk A/S',
    insider_name: 'Lars Fruergaard Jørgensen', insider_role: 'CEO',
    transaction_type: 'SELL', transaction_date: '2026-04-01',
    shares: 32000, price_per_share: 62.44, total_value: 1998080,
    currency: 'EUR', country_code: 'DK',
    filing_url: 'https://www.finanstilsynet.dk', source: 'Finanstilsynet Denmark',
  },

  // ── Switzerland ───────────────────────────────────────────────────
  {
    ticker: 'NESN',   company: 'Nestlé S.A.',
    insider_name: 'Laurent Freixe', insider_role: 'CEO',
    transaction_type: 'BUY', transaction_date: '2026-03-24',
    shares: 29000, price_per_share: 78.66, total_value: 2281140,
    currency: 'EUR', country_code: 'CH',
    filing_url: 'https://www.finma.ch', source: 'FINMA Switzerland',
  },
  {
    ticker: 'ROG',    company: 'Roche Holding AG',
    insider_name: 'Thomas Schinecker', insider_role: 'CEO',
    transaction_type: 'SELL', transaction_date: '2026-03-16',
    shares: 8200, price_per_share: 252.10, total_value: 2067220,
    currency: 'EUR', country_code: 'CH',
    filing_url: 'https://www.finma.ch', source: 'FINMA Switzerland',
  },

  // ── Finland ───────────────────────────────────────────────────────
  {
    ticker: 'NOKIA',  company: 'Nokia Oyj',
    insider_name: 'Pekka Lundmark', insider_role: 'CEO',
    transaction_type: 'BUY', transaction_date: '2026-03-29',
    shares: 550000, price_per_share: 4.42, total_value: 2431000,
    currency: 'EUR', country_code: 'FI',
    filing_url: 'https://www.finanssivalvonta.fi', source: 'FIN-FSA Finland',
  },

  // ── Italy ─────────────────────────────────────────────────────────
  {
    ticker: 'ENEL',   company: 'Enel S.p.A.',
    insider_name: 'Flavio Cattaneo', insider_role: 'CEO',
    transaction_type: 'BUY', transaction_date: '2026-04-07',
    shares: 420000, price_per_share: 7.48, total_value: 3141600,
    currency: 'EUR', country_code: 'IT',
    filing_url: 'https://www.consob.it', source: 'CONSOB Italy',
  },

  // ── Hong Kong ─────────────────────────────────────────────────────
  {
    ticker: '1299.HK', company: 'AIA Group Limited',
    insider_name: 'Lee Yuan Siong', insider_role: 'CEO',
    transaction_type: 'BUY', transaction_date: '2026-03-21',
    shares: 380000, price_per_share: 6.84, total_value: 2599200,
    currency: 'EUR', country_code: 'HK',
    filing_url: 'https://www.sfc.hk', source: 'SFC Hong Kong',
  },

  // ── Japan ─────────────────────────────────────────────────────────
  {
    ticker: '6758.T', company: 'Sony Group Corporation',
    insider_name: 'Kenichiro Yoshida', insider_role: 'Chairman',
    transaction_type: 'SELL', transaction_date: '2026-03-26',
    shares: 45000, price_per_share: 14.20, total_value: 639000,
    currency: 'EUR', country_code: 'JP',
    filing_url: 'https://www.fsa.go.jp', source: 'FSA Japan',
  },

  // ── South Korea ───────────────────────────────────────────────────
  {
    ticker: '005930.KS', company: 'Samsung Electronics Co., Ltd.',
    insider_name: 'Han Jong-hee', insider_role: 'Co-CEO',
    transaction_type: 'BUY', transaction_date: '2026-04-03',
    shares: 180000, price_per_share: 0.47, total_value: 846000,
    currency: 'EUR', country_code: 'KR',
    filing_url: 'https://dart.fss.or.kr', source: 'FSS South Korea',
  },

  // ── Singapore ─────────────────────────────────────────────────────
  {
    ticker: 'D05.SI', company: 'DBS Group Holdings Ltd.',
    insider_name: 'Piyush Gupta', insider_role: 'CEO',
    transaction_type: 'BUY', transaction_date: '2026-03-12',
    shares: 62000, price_per_share: 28.90, total_value: 1791800,
    currency: 'EUR', country_code: 'SG',
    filing_url: 'https://www.mas.gov.sg', source: 'MAS Singapore',
  },

  // ── Portugal ──────────────────────────────────────────────────────
  {
    ticker: 'EDP',    company: 'EDP - Energias de Portugal',
    insider_name: 'Miguel Stilwell d\'Andrade', insider_role: 'CEO',
    transaction_type: 'BUY', transaction_date: '2026-03-20',
    shares: 320000, price_per_share: 3.76, total_value: 1203200,
    currency: 'EUR', country_code: 'PT',
    filing_url: 'https://www.cmvm.pt', source: 'CMVM Portugal',
  },

  // ── Czech Republic ────────────────────────────────────────────────
  {
    ticker: 'CEZ',    company: 'ČEZ, a. s.',
    insider_name: 'Daniel Beneš', insider_role: 'CEO',
    transaction_type: 'SELL', transaction_date: '2026-03-30',
    shares: 48000, price_per_share: 22.14, total_value: 1062720,
    currency: 'EUR', country_code: 'CZ',
    filing_url: 'https://www.cnb.cz', source: 'CNB Czech Republic',
  },

  // ── Luxembourg ────────────────────────────────────────────────────
  {
    ticker: 'ARCO',   company: 'ArcelorMittal S.A.',
    insider_name: 'Aditya Mittal', insider_role: 'CEO',
    transaction_type: 'BUY', transaction_date: '2026-04-02',
    shares: 75000, price_per_share: 18.64, total_value: 1398000,
    currency: 'EUR', country_code: 'LU',
    filing_url: 'https://www.cssf.lu', source: 'CSSF Luxembourg',
  },

  // ── Australia ─────────────────────────────────────────────────────
  {
    ticker: 'BHP.AX', company: 'BHP Group Limited',
    insider_name: 'Mike Henry', insider_role: 'CEO',
    transaction_type: 'SELL', transaction_date: '2026-03-17',
    shares: 95000, price_per_share: 26.42, total_value: 2509900,
    currency: 'EUR', country_code: 'AU',
    filing_url: 'https://www.asic.gov.au', source: 'ASIC Australia',
  },

  // ── Canada ────────────────────────────────────────────────────────
  {
    ticker: 'SU.TO',  company: 'Suncor Energy Inc.',
    insider_name: 'Rich Kruger', insider_role: 'CEO',
    transaction_type: 'BUY', transaction_date: '2026-03-23',
    shares: 68000, price_per_share: 36.18, total_value: 2460240,
    currency: 'EUR', country_code: 'CA',
    filing_url: 'https://www.sedarplus.ca', source: 'SEDAR Canada',
  },

  // ── Spain ─────────────────────────────────────────────────────────
  {
    ticker: 'ITX',    company: 'Industria de Diseño Textil (Inditex)',
    insider_name: 'Óscar García Maceiras', insider_role: 'CEO',
    transaction_type: 'SELL', transaction_date: '2026-04-08',
    shares: 120000, price_per_share: 43.72, total_value: 5246400,
    currency: 'EUR', country_code: 'ES',
    filing_url: 'https://www.cnmv.es', source: 'CNMV Spain',
  },

  // ── South Africa ──────────────────────────────────────────────────
  {
    ticker: 'NPN.JO', company: 'Naspers Limited',
    insider_name: 'Ervin Tu', insider_role: 'CEO',
    transaction_type: 'BUY', transaction_date: '2026-03-15',
    shares: 14000, price_per_share: 148.60, total_value: 2080400,
    currency: 'EUR', country_code: 'ZA',
    filing_url: 'https://www.fsca.co.za', source: 'FSCA South Africa',
  },
];

// Stamp every row with a unique filing_id
const stamped = transactions.map((t, i) =>
  ({ ...t, filing_id: `SEED-${t.country_code}-${t.ticker.replace(/[^A-Z0-9]/gi, '')}-${String(i + 1).padStart(3, '0')}` })
);

async function seed() {
  console.log(`Inserting ${stamped.length} insider transactions…`);

  // Clear existing test data first, then insert fresh
  await supabase.from('insider_transactions').delete().neq('id', 0);

  const { data, error } = await supabase
    .from('insider_transactions')
    .insert(stamped);

  if (error) {
    console.error('Error:', error.message);
    console.error('Details:', error.details);
    process.exit(1);
  }

  console.log(`✅ Successfully seeded ${stamped.length} transactions`);
  console.log('Countries covered:', [...new Set(stamped.map(t => t.country_code))].sort().join(', '));
  console.log('Buys:', stamped.filter(t => t.transaction_type === 'BUY').length);
  console.log('Sells:', stamped.filter(t => t.transaction_type === 'SELL').length);
}

seed();
