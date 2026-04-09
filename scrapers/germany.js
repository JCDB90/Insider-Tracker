const fetch = require('node-fetch');

async function scrapeDE() {
  console.log('🇩🇪 Scraping BaFin Germany...');
  
  try {
    const url = 'https://www.bafin.de/EN/PublikationenDaten/Datenbanken/Insiderverzeichnis/insiderverzeichnis_node_en.html';
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
      }
    });
    
    const html = await response.text();
    
    console.log('✅ Successfully fetched BaFin page');
    console.log('Page length:', html.length, 'characters');
    
    if (html.includes('BaFin') || html.includes('Insider')) {
      console.log('✅ Confirmed: This is the official BaFin portal');
      console.log('\nNote: BaFin data available - needs HTML parsing');
    }
    
  } catch (error) {
    console.error('❌ Error:', error.message);
  }
}

scrapeDE();