import { useState, useEffect } from 'react';
import { createClient } from '@supabase/supabase-js';
import './App.css';

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
      
      if (!error) setBuybacks(data);
      setLoading(false);
    }
    fetchBuybacks();
  }, []);

  if (loading) {
    return (
      <div className="loading">
        <div className="spinner"></div>
        <p>Loading...</p>
      </div>
    );
  }

  return (
    <div className="app">
      <header className="header">
        <div className="container">
          <div className="logo">
            <h1>Insider Tracker</h1>
            <span className="beta">BETA</span>
          </div>
        </div>
      </header>

      <main className="main">
        <div className="container">
          <div className="table-container">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Company</th>
                  <th>Ticker</th>
                  <th>Country</th>
                  <th>Date</th>
                  <th>Source</th>
                </tr>
              </thead>
              <tbody>
                {buybacks.map(bb => (
                  <tr key={bb.id}>
                    <td className="company-cell">{bb.company}</td>
                    <td className="ticker-cell">{bb.ticker}</td>
                    <td><span className="country-badge">{bb.country_code}</span></td>
                    <td>{new Date(bb.announced_date).toLocaleDateString()}</td>
                    <td className="source-cell">{bb.source}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </main>

      <footer className="footer">
        <div className="container">
          <p>Tracking {buybacks.length} programs across multiple markets</p>
        </div>
      </footer>
    </div>
  );
}

export default App;