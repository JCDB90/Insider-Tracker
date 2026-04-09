const fetch = require('node-fetch');

async function scrapePL() {
  console.log('🇵🇱 Scraping GPW Poland (Warsaw Stock Exchange)...');
  
  try {
    const url = 'https://www.gpw.pl/espi-en';
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      }
    });
    
    const html = await response.text();
    
    console.log('✅ Successfully fetched GPW ESPI page');
    console.log('Page length:', html.length, 'characters');
    
    if (html.includes('ESPI') || html.includes('GPW')) {
      console.log('✅ Confirmed: This is the official Warsaw Stock Exchange disclosure system');
      console.log('\nKeywords to filter: "program skupu akcji własnych", "buyback"');
    }
    
  } catch (error) {
    console.error('❌ Error:', error.message);
  }
}

scrapePL();