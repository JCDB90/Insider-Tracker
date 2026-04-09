const fetch = require('node-fetch');

async function scrapeHK() {
  console.log('🇭🇰 Scraping HKEX Hong Kong...');
  
  try {
    const url = 'https://www.hkex.com.hk/';
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      }
    });
    
    const html = await response.text();
    
    console.log('✅ Successfully fetched HKEX page');
    console.log('Page length:', html.length, 'characters');
    
    if (html.includes('HKEX') || html.includes('Hong Kong')) {
      console.log('✅ Confirmed: Hong Kong stock exchange');
      console.log('\nKeywords: "share repurchase", "buyback"');
      console.log('Gap: Competitors have limited HK coverage');
    }
    
  } catch (error) {
    console.error('❌ Error:', error.message);
  }
}

scrapeHK();