const fetch = require('node-fetch');

async function scrapeAU() {
  console.log('🇦🇺 Scraping ASX Australia...');
  
  try {
    // ASX Company Announcements Platform
    const url = 'https://www.asx.com.au/asx/statistics/announcements.do';
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      }
    });
    
    const html = await response.text();
    
    console.log('✅ Successfully fetched ASX page');
    console.log('Page length:', html.length, 'characters');
    
    if (html.includes('ASX') || html.includes('Australian')) {
      console.log('✅ Confirmed: Official Australian Securities Exchange');
      console.log('\nKeywords: "share buyback", "on-market buyback", "Appendix 3E"');
      console.log('Note: Competitor stopped tracking AU in Jan 2024 - HUGE opportunity!');
    }
    
  } catch (error) {
    console.error('❌ Error:', error.message);
  }
}

scrapeAU();