const fetch = require('node-fetch');

async function scrapeIT() {
  console.log('🇮🇹 Scraping CONSOB Italy...');
  
  try {
    const url = 'https://www.consob.it/web/consob-and-its-activities/what-we-do';
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      }
    });
    
    const html = await response.text();
    
    console.log('✅ Successfully fetched CONSOB page');
    console.log('Page length:', html.length, 'characters');
    
    if (html.includes('CONSOB') || html.includes('Italy')) {
      console.log('✅ Confirmed: Italian securities regulator');
      console.log('\nKeywords: "riacquisto azioni proprie", "buy-back"');
    }
    
  } catch (error) {
    console.error('❌ Error:', error.message);
  }
}

scrapeIT();