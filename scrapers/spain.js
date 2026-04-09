/**
 * ES — Insider Transactions Scraper
 *
 * Source: CNMV Spain
 * URL: https://www.cnmv.es/portal/Consultas/MAR/ListaOperaciones.aspx
 *
 * CNMV portal — ASP.NET SPA, JS-rendered. Needs Puppeteer or reverse-engineered API.
 */
'use strict';

const fetch   = require('node-fetch');
const cheerio = require('cheerio');
const { saveInsiderTransactions } = require('./lib/db');

const COUNTRY_CODE   = 'ES';
const SOURCE         = 'CNMV Spain';
const RETENTION_DAYS = 14;
const CURRENCY       = 'EUR';

function isoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function cutoff() { const d = new Date(); d.setDate(d.getDate() - RETENTION_DAYS); return d; }

async function scrapeES() {
  console.log('🇪🇸  CNMV Spain');
  const t0 = Date.now();
  const co = cutoff();

  // TODO: CNMV portal — ASP.NET SPA, JS-rendered. Needs Puppeteer or reverse-engineered API.
  // Implement HTTP scraping or Puppeteer for this market.
  // Regulatory portal: https://www.cnmv.es/portal/Consultas/MAR/ListaOperaciones.aspx
  // Try POST to: /ServiciosPublicacion/ServicioGratuito/GetNotificacionesInsidersMAR

  console.log('  ⚠  Scraper not yet implemented for ES.');
  console.log('  ℹ  0 rows saved.');
  return { saved: 0 };
}

scrapeES().catch(err => { console.error('❌ Fatal:', err.message); process.exit(1); });
