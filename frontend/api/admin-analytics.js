import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://loqmxllfjvdwamwicoow.supabase.co';
const ANON_KEY     = process.env.SUPABASE_ANON_KEY || 'sb_publishable_wL5qlj7xHeE6-y2cXaRKfw_39-iEoUt';

const anonSb  = createClient(SUPABASE_URL, ANON_KEY);

async function verifyAdmin(token) {
  const { data: { user }, error } = await anonSb.auth.getUser(token);
  if (error || !user) return null;
  const userSb = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
  const { data: profile } = await userSb.from('user_profiles').select('plan').eq('id', user.id).maybeSingle();
  return profile?.plan === 'admin' ? user : null;
}

function groupBy(rows, key) {
  const map = {};
  for (const row of rows) {
    const k = row[key] || null;
    if (!map[k]) map[k] = [];
    map[k].push(row);
  }
  return map;
}

function weekKey(dateStr) {
  const d = new Date(dateStr);
  // Monday of the week
  const day = d.getDay();
  const diff = (day === 0 ? -6 : 1 - day);
  d.setDate(d.getDate() + diff);
  return d.toISOString().slice(0, 10);
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).end();

  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Missing auth token' });

  const admin = await verifyAdmin(token);
  if (!admin) return res.status(403).json({ error: 'Forbidden' });

  const svcKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!svcKey) return res.status(500).json({ error: 'SUPABASE_SERVICE_ROLE_KEY not configured' });

  const adminSb = createClient(SUPABASE_URL, svcKey);
  const { data: rows, error } = await adminSb
    .from('user_profiles')
    .select('id, plan, utm_source, utm_medium, utm_campaign, utm_content, utm_term, landing_page, created_at')
    .order('created_at', { ascending: true });

  if (error) return res.status(500).json({ error: error.message });

  // ── Traffic sources ──────────────────────────────────────────────────────────
  const bySource = groupBy(rows, 'utm_source');
  const trafficSources = Object.entries(bySource)
    .map(([source, users]) => {
      const conversions = users.filter(u => u.plan !== 'visitor').length;
      return {
        utm_source: source,
        signups: users.length,
        conversions,
        conversion_rate: users.length > 0 ? +(conversions / users.length * 100).toFixed(1) : 0,
      };
    })
    .sort((a, b) => b.signups - a.signups);

  // ── Top campaigns ────────────────────────────────────────────────────────────
  const campaignMap = {};
  for (const u of rows) {
    if (!u.utm_campaign) continue;
    const k = `${u.utm_campaign}||${u.utm_source || ''}`;
    if (!campaignMap[k]) campaignMap[k] = { utm_campaign: u.utm_campaign, utm_source: u.utm_source, signups: 0 };
    campaignMap[k].signups++;
  }
  const topCampaigns = Object.values(campaignMap).sort((a, b) => b.signups - a.signups).slice(0, 20);

  // ── Revenue by source ────────────────────────────────────────────────────────
  const revenueBySource = Object.entries(bySource)
    .map(([source, users]) => {
      const pro   = users.filter(u => u.plan === 'pro').length;
      const elite = users.filter(u => u.plan === 'elite').length;
      return {
        utm_source: source,
        pro_users: pro,
        elite_users: elite,
        est_mrr: +(pro * 9.99 + elite * 14.99).toFixed(2),
      };
    })
    .sort((a, b) => b.est_mrr - a.est_mrr);

  // ── Landing pages ────────────────────────────────────────────────────────────
  const pageMap = {};
  for (const u of rows) {
    if (!u.landing_page) continue;
    if (!pageMap[u.landing_page]) pageMap[u.landing_page] = { landing_page: u.landing_page, visits: 0, conversions: 0 };
    pageMap[u.landing_page].visits++;
    if (u.plan !== 'visitor') pageMap[u.landing_page].conversions++;
  }
  const landingPages = Object.values(pageMap).sort((a, b) => b.visits - a.visits);

  // ── Weekly signups (last 12 weeks) ───────────────────────────────────────────
  const weekMap = {};
  for (const u of rows) {
    if (!u.created_at) continue;
    const wk = weekKey(u.created_at);
    if (!weekMap[wk]) weekMap[wk] = { week: wk, new_signups: 0, paid: 0 };
    weekMap[wk].new_signups++;
    if (u.plan !== 'visitor') weekMap[wk].paid++;
  }
  const weeklySignups = Object.values(weekMap)
    .sort((a, b) => b.week.localeCompare(a.week))
    .slice(0, 12)
    .reverse();

  // ── Summary stats ────────────────────────────────────────────────────────────
  const paid   = rows.filter(u => ['pro', 'elite'].includes(u.plan));
  const pros   = rows.filter(u => u.plan === 'pro').length;
  const elites = rows.filter(u => u.plan === 'elite').length;
  const withSource = rows.filter(u => u.utm_source);
  const withSourceConverted = withSource.filter(u => u.plan !== 'visitor');
  const summary = {
    total_signups: rows.length,
    paid_users: paid.length,
    est_mrr: +(pros * 9.99 + elites * 14.99).toFixed(2),
    avg_conversion_rate: withSource.length > 0
      ? +(withSourceConverted.length / withSource.length * 100).toFixed(1)
      : 0,
  };

  res.status(200).json({ summary, trafficSources, topCampaigns, revenueBySource, landingPages, weeklySignups });
}
