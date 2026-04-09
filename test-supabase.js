const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = 'https://loqmxllfjvdwamwicoow.supabase.co';
const supabaseKey = 'sb_publishable_wL5qlj7xHeE6-y2cXaRKfw_39-iEoUt';

const supabase = createClient(supabaseUrl, supabaseKey);

async function testConnection() {
  console.log('Testing Supabase connection...');
  
  // Try to query the buyback_programs table (should be empty)
  const { data, error } = await supabase
    .from('buyback_programs')
    .select('*')
    .limit(5);
  
  if (error) {
    console.error('❌ Error:', error.message);
  } else {
    console.log('✅ Connected to Supabase!');
    console.log('Rows in buyback_programs table:', data.length);
  }
}

testConnection();