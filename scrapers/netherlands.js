const fetch = require('node-fetch');
const cheerio = require('cheerio');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  'https://loqmxllfjvdwamwicoow.supabase.co',
  'sb_publishable_wL5qlj7xHeE6-y2cXaRKfw_39-iEoUt'
);

async function scrapeNL() {
  console.log('🇳🇱 Scraping AFM Netherlands...');
  
  try {
    const url = 'https://www.afm.nl/en/sector/registers/meldingenregisters/openbaarmaking-voorwetenschap';
    const response = await fetch(url);
    const html = await response.text();
    const $ = cheerio.load(html);
    
    console.log('✅ Fetched AFM page, parsing...');
    
    const buybacks = [];
    
    // Look for buyback keywords in the page
    const text = $('body').text().toLowerCase();
    
    // For now, let's create a test entry to verify the flow works
    const testBuyback = {
      filing_id: 'NL-TEST-001',
      country_code: 'NL',
      ticker: 'TEST',
      company: 'Test Company BV',
      announced_date: '2025-01-15',
      total_value: 1000000,
      currency: 'EUR',
      status: 'active',
      filing_url: url,
      source: 'AFM Netherlands'
    };
    
    buybacks.push(testBuyback);
    
    // Save to Supabase
    if (buybacks.length > 0) {
      const { data, error } = await supabase
        .from('buyback_programs')
        .upsert(buybacks, { onConflict: 'filing_id' });
      
      if (error) {
        console.error('❌ Database error:', error.message);
      } else {
        console.log(`✅ Saved ${buybacks.length} buyback(s) to database`);
      }
    }
    
    return buybacks;
    
  } catch (error) {
    console.error('❌ Error:', error.message);
  }
}

scrapeNL();