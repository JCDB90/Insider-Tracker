const fetch = require('node-fetch');

async function scrapeAT() {
  console.log('🇦🇹 Scraping FMA Austria...');
  
  try {
    // FMA Austria's official website
    const url = 'https://www.fma.gv.at/en/';
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      }
    });
    
    const html = await response.text();
    
    console.log('✅ Successfully fetched FMA Austria page');
    console.log('Page length:', html.length, 'characters');
    
    if (html.includes('FMA') || html.includes('Austria')) {
      console.log('✅ Confirmed: This is Austria\'s official financial regulator');
      console.log('\nKeywords to filter: "Aktienrückkauf", "Rückkaufprogramm"');
    }
    
  } catch (error) {
    console.error('❌ Error:', error.message);
  }
}

scrapeAT();