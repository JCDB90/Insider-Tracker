const fetch = require('node-fetch');

async function scrapeZA() {
  console.log('🇿🇦 Scraping JSE South Africa...');
  
  try {
    // Johannesburg Stock Exchange
    const url = 'https://www.jse.co.za/';
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      }
    });
    
    const html = await response.text();
    
    console.log('✅ Successfully fetched JSE page');
    console.log('Page length:', html.length, 'characters');
    
    if (html.includes('JSE') || html.includes('Johannesburg') || html.includes('South Africa')) {
      console.log('✅ Confirmed: Johannesburg Stock Exchange');
      console.log('\nKeywords: "share buy-back", "share repurchase"');
      console.log('Official source: JSE SENS (Stock Exchange News Service)');
      console.log('Note: Naspers, Standard Bank, FirstRand - major African market!');
    }
    
  } catch (error) {
    console.error('❌ Error:', error.message);
  }
}

scrapeZA();