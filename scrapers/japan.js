const fetch = require('node-fetch');

async function scrapeJP() {
  console.log('🇯🇵 Scraping TSE Japan...');
  
  try {
    // Tokyo Stock Exchange
    const url = 'https://www.jpx.co.jp/english/';
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      }
    });
    
    const html = await response.text();
    
    console.log('✅ Successfully fetched JPX page');
    console.log('Page length:', html.length, 'characters');
    
    if (html.includes('JPX') || html.includes('Tokyo') || html.includes('Japan')) {
      console.log('✅ Confirmed: Japan Exchange Group (Tokyo Stock Exchange)');
      console.log('\nKeywords: "自社株買い" (jisha kabakai - share buyback), "buyback"');
      console.log('Note: 3rd largest stock market globally - massive opportunity!');
    }
    
  } catch (error) {
    console.error('❌ Error:', error.message);
  }
}

scrapeJP();