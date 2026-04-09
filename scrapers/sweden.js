const fetch = require('node-fetch');

async function scrapeSE() {
  console.log('🇸🇪 Scraping Finansinspektionen Sweden...');
  
  try {
    // Swedish Financial Supervisory Authority
    const url = 'https://www.fi.se/en/';
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      }
    });
    
    const html = await response.text();
    
    console.log('✅ Successfully fetched Finansinspektionen page');
    console.log('Page length:', html.length, 'characters');
    
    if (html.includes('Finansinspektionen') || html.includes('Sweden')) {
      console.log('✅ Confirmed: This is Sweden\'s official financial regulator');
      console.log('\nKeywords to filter: "återköpsprogram", "återköp av egna aktier", "share buyback"');
    }
    
  } catch (error) {
    console.error('❌ Error:', error.message);
  }
}

scrapeSE();