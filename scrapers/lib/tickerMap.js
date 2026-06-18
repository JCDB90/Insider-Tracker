'use strict';

/**
 * Maps country codes to Yahoo Finance exchange suffixes.
 * Also provides specific overrides for tickers that need special handling.
 */

const COUNTRY_SUFFIX = {
  AT: '.VI',  BE: '.BR',  CA: '.TO',  CH: '.SW',  CZ: '.PR',
  DE: '.DE',  DK: '.CO',  ES: '.MC',  FI: '.HE',  FR: '.PA',
  GB: '.L',   HK: '.HK',  IE: '.IR',  IT: '.MI',  JP: '.T',
  KR: '.KS',  LU: '.LU',  NL: '.AS',  NO: '.OL',  PL: '.WA',
  PT: '.LS',  SE: '.ST',  SG: '.SI',  ZA: '.JO',
};

// ticker overrides keyed as "TICKER|COUNTRY" → Yahoo symbol
// Used for companies registered in one country but listed on another exchange.
const SPECIFIC_OVERRIDES = {
  'BARC|GB':   'BARC.L',
  'BP|GB':     'BP.L',
  'SHEL|GB':   'SHEL.L',
  'HSBA|GB':   'HSBA.L',
  'AZN|GB':    'AZN.L',
  'GSK|GB':    'GSK.L',
  'LSEG|GB':   'LSEG.L',
  'FLOW|NL':   'FLOW.AS',
  'PRX|NL':    'PRX.AS',
  'ASML|NL':   'ASML.AS',
  'INGA|NL':   'INGA.AS',
  'RDSA|NL':   'SHELL.AS',
  // NL-registered companies listed on non-Amsterdam exchanges
  'CPR|NL':    'CPR.MI',     // Davide Campari (Milan)
  'CEM|NL':    'CEM.MI',     // Cementir Holding (Milan)
  'RACE|NL':   'RACE.MI',    // Ferrari (Milan)
  'ADP|NL':    'ADP.DE',     // Ad Pepper Media (Frankfurt)
  'ARGX|NL':   'ARGX.BR',   // argenx SE (Brussels)
  'ONWD|NL':   'ONWD.BR',   // Onward Medical (Brussels)
  'PEN|NL':    'PEN.PR',     // Photon Energy (Prague)
  'QGEN|NL':   'QGEN',       // Qiagen (NYSE)
  'VID|ES':    'VID.MC',
  'REP|ES':    'REP.MC',
  'IBE|ES':    'IBE.MC',
  'THEP|FR':   'THEP.PA',
  'MC|FR':     'MC.PA',
  'OR|FR':     'OR.PA',
  'JEN|BE':    'JEN.BR',
  // LU-registered but traded on Euronext Amsterdam or Brussels
  'APAM|LU':   'APAM.AS',   // Aperam S.A. (Amsterdam)
  'BREB|LU':   'BREB.BR',   // Brederode S.A. (Brussels)
  // GB-filed companies primarily listed on other exchanges
  'FLUT|GB':   'FLUT',      // Flutter Entertainment (NYSE, migrated from LSE)
  // PL tickers where GPW symbol differs from Yahoo Finance symbol
  'BNPPPL|PL':    'BNP.WA',
  'HANDLOWY|PL':  'BHW.WA',
  'MILLENNIUM|PL':'MIL.WA',
  'AGORA|PL':     'AGO.WA',
  'HUUUGE|PL':    'HUG.WA',
};

/**
 * Convert a local ticker to Yahoo Finance format.
 * Returns the Yahoo-format symbol, or null if country unknown.
 */
function toYahooTicker(ticker, countryCode) {
  if (!ticker || !countryCode) return ticker || null;
  const override = SPECIFIC_OVERRIDES[`${ticker}|${countryCode}`];
  if (override) return override;
  const suffix = COUNTRY_SUFFIX[countryCode];
  if (!suffix) return ticker; // US or unknown — use bare ticker
  return `${ticker}${suffix}`;
}

/**
 * Return the list of Yahoo suffixes to try for a country (in priority order).
 * Used by getClosePrice when trying multiple suffixes.
 */
function getSuffixesForCountry(countryCode) {
  const primary = COUNTRY_SUFFIX[countryCode];
  if (!primary) return [''];
  // Some markets have secondary venues worth trying
  const extras = {
    NL: ['.AS', '.PA'],
    BE: ['.BR', '.PA'],
    DE: ['.DE', '.F'],
    FR: ['.PA', '.AS'],
    GB: ['.L'],
    CH: ['.SW'],
  };
  return extras[countryCode] || [primary];
}

/**
 * GPW (Warsaw Stock Exchange) ticker → full company name.
 * Bankier API returns only symbol; these names are looked up from Bankier company pages.
 * Used by poland.js scraper and backfill scripts.
 */
const PL_COMPANY_NAMES = {
  'ADATEX':    'Adatex SA',
  'AGORA':     'Agora SA',
  'AMICA':     'Amica SA',
  'ANSWEAR':   'Answear.com SA',
  'APATOR':    'Apator SA',
  'ASSECOSEE': 'Asseco SEE SA',
  'ASTARTA':   'Astarta Holding PLC',
  'ATCCARGO':  'ATC-Cargo SA',
  'BNPPPL':    'BNP Paribas Bank Polska SA',
  'BUDIMEX':   'Budimex SA',
  'CAVATINA':  'Cavatina Holding SA',
  'CIGAMES':   'CI Games SE',
  'CORMAY':    'PZ Cormay SA',
  'DADELO':    'Dadelo SA',
  'DATAWALK':  'DataWalk SA',
  'DEVELIA':   'Develia SA',
  'DIGITREE':  'Digitree Group SA',
  'EKOPOL':    'Ekopol SA',
  'ELEKTROTI': 'Elektrotim SA',
  'ENAP':      'Energoaparatura SA',
  'ENERGY':    'Energy SA',
  'EQUNICO':   'Equnico SE',
  'EUROHOLD':  'Eurohold Bulgaria AD',
  'EXCELLENC': 'Excellence SA',
  'FARM51':    'The Farm 51 Group SA',
  'GAMIVO':    'Gamivo SA',
  'GDEVS':     'G-Devs SA',
  'GPW':       'GPW SA',
  'GRUPRACUJ': 'Grupa Pracuj SA',
  'HANDLOWY':  'Bank Handlowy w Warszawie SA',
  'HUUUGE':    'Huuuge, Inc.',
  'IMMGAMES':  'TrustBTC SA',
  'KBJ':       'KBJ SA',
  'KOMPAP':    'Kompap SA',
  'KRUK':      'Kruk SA',
  'LOKUM':     'Lokum Deweloper SA',
  'LPP':       'LPP SA',
  'MBANK':     'mBank SA',
  'MEDICALG':  'Medicalgorithmics SA',
  'MILLENNIUM':'Bank Millennium SA',
  'MILTON':    'Milton Essex SA',
  'MOLIERA2':  'Moliera2 SA',
  'MOONLIT':   'Moonlit SA',
  'MOSTALZAB': 'Mostostal Zabrze SA',
  'MURAPOL':   'Murapol SA',
  'NANOGROUP': 'NanoGroup SA',
  'NEUCA':     'Neuca SA',
  'ONEMORE':   'One More Level SA',
  'OPONEO.PL': 'Oponeo.pl SA',
  'ORZLOPONY': 'Orzeł SA',
  'PCCEXOL':   'PCC Exol SA',
  'PEKABEX':   'Pekabex SA',
  'PGE':       'PGE SA',
  'PGNIG':     'Polskie Górnictwo Naftowe i Gazownictwo SA',
  'PKN':       'Orlen SA',
  'PKO':       'PKO BP SA',
  'PKPCARGO':  'PKP Cargo SA',
  'PLAY':      'Play Communications SA',
  'PTWP':      'PTWP SA',
  'PZU':       'PZU SA',
  'QUART':     'Quart Development SA',
  'QUERCUS':   'Quercus TFI SA',
  'RAFAKO':    'Rafako SA',
  'SANTANDER': 'Santander Bank Polska SA',
  'SCANWAY':   'Scanway SA',
  'SDSOPTIC':  'SDS Optic SA',
  'SECOGROUP': 'Seco/Warwick SA',
  'SNTVERSE':  'Synthaverse SA',
  'SOPHARMA':  'Sopharma AD',
  'SWMANSION': 'Software Mansion SA',
  'SYNEKTIK':  'Synektik SA',
  'TAURONPE':  'Tauron PE SA',
  'TELEMEDPL': 'Telemedycyna Polska SA',
  'TELESTR':   'Telestrada SA',
  'TRANSPOL':  'Trans Polonia SA',
  'VARSAV':    'Varsav Game Studios SA',
  'VERCOM':    'Vercom SA',
  'VOTUM':     'Votum SA',
  'VRFABRIC':  'VRFabric SA',
  'XTPL':      'XTPL SA',
};

/**
 * Return full company name for a GPW ticker, or null if unknown.
 */
function getPlCompanyName(ticker) {
  return PL_COMPANY_NAMES[ticker] || null;
}

module.exports = { toYahooTicker, getSuffixesForCountry, COUNTRY_SUFFIX, SPECIFIC_OVERRIDES, PL_COMPANY_NAMES, getPlCompanyName };
