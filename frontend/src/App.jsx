import { useState, useEffect } from 'react';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  'https://loqmxllfjvdwamwicoow.supabase.co',
  'sb_publishable_wL5qlj7xHeE6-y2cXaRKfw_39-iEoUt'
);

function App() {
  const [buybacks, setBuybacks] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchBuybacks() {
      const { data, error } = await supabase
        .from('buyback_programs')
        .select('*')
        .order('announced_date', { ascending: false });
      
      if (error) {
        console.error('Error:', error);
      } else {
        setBuybacks(data);
      }
      setLoading(false);
    }
    
    fetchBuybacks();
  }, []);

  if (loading) return <div style={{padding: 40}}>Loading...</div>;

  return (
    <div style={{padding: 40, fontFamily: 'system-ui'}}>
      <h1>Insider Tracker - Buyback Programs</h1>
      <p>Total programs: {buybacks.length}</p>
      
      {buybacks.length === 0 ? (
        <p>No data yet. Run the scrapers to populate!</p>
      ) : (
        <table style={{width: '100%', borderCollapse: 'collapse'}}>
          <thead>
            <tr style={{borderBottom: '2px solid #ccc'}}>
              <th style={{padding: 10, textAlign: 'left'}}>Country</th>
              <th style={{padding: 10, textAlign: 'left'}}>Company</th>
              <th style={{padding: 10, textAlign: 'left'}}>Ticker</th>
              <th style={{padding: 10, textAlign: 'left'}}>Announced</th>
              <th style={{padding: 10, textAlign: 'left'}}>Source</th>
            </tr>
          </thead>
          <tbody>
            {buybacks.map(bb => (
              <tr key={bb.id} style={{borderBottom: '1px solid #eee'}}>
                <td style={{padding: 10}}>{bb.country_code}</td>
                <td style={{padding: 10}}>{bb.company}</td>
                <td style={{padding: 10}}>{bb.ticker}</td>
                <td style={{padding: 10}}>{bb.announced_date}</td>
                <td style={{padding: 10, fontSize: 12, color: '#666'}}>{bb.source}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

export default App;
