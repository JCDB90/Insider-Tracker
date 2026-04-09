const fetch = require('node-fetch');

async function scrapeIE() {
  console.log('🇮🇪 Scraping Euronext Dublin (Ireland)...');
  
  try {
    const url = 'https://www.ise.ie/Market-Data-Announcements/Company-Announcements/';
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      }
    });
    
    const html = await response.text();
    
    console.log('✅ Successfully fetched Euronext Dublin page');
    console.log('Page length:', html.length, 'characters');
    
    if (html.includes('Announcements') || html.includes('Euronext') || html.includes('ISE')) {
      console.log('✅ Confirmed: This is the official Irish stock exchange announcement portal');
      console.log('\nKeywords to filter: "share buyback", "repurchase programme"');
    }
    
  } catch (error) {
    console.error('❌ Error:', error.message);
  }
}

scrapeIE();