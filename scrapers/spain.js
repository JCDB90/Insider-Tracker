const fetch = require('node-fetch');

async function scrapeES() {
  console.log('🇪🇸 Scraping CNMV Spain...');
  
  try {
    const url = 'https://www.cnmv.es/portal/home.aspx?lang=en';
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      }
    });
    
    const html = await response.text();
    
    console.log('✅ Successfully fetched CNMV page');
    console.log('Page length:', html.length, 'characters');
    
    if (html.includes('CNMV') || html.includes('Spain')) {
      console.log('✅ Confirmed: Spanish securities regulator');
      console.log('\nKeywords: "programa de recompra", "recompra de acciones"');
    }
    
  } catch (error) {
    console.error('❌ Error:', error.message);
  }
}

scrapeES();