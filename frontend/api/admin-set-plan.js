import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://loqmxllfjvdwamwicoow.supabase.co';

const anonSb  = createClient(SUPABASE_URL, process.env.SUPABASE_ANON_KEY || 'sb_publishable_wL5qlj7xHeE6-y2cXaRKfw_39-iEoUt');
const adminSb = createClient(SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const VALID_PLANS = new Set(['visitor', 'pro', 'elite', 'admin']);

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Missing auth token' });

  const { data: { user }, error: authErr } = await anonSb.auth.getUser(token);
  if (authErr || !user) return res.status(401).json({ error: 'Invalid token' });

  const { data: profile } = await adminSb
    .from('user_profiles')
    .select('plan')
    .eq('id', user.id)
    .maybeSingle();

  if (profile?.plan !== 'admin') return res.status(403).json({ error: 'Forbidden' });

  const { targetUserId, newPlan } = req.body || {};
  if (!targetUserId || !VALID_PLANS.has(newPlan)) {
    return res.status(400).json({ error: 'Invalid targetUserId or newPlan' });
  }

  const { error } = await adminSb
    .from('user_profiles')
    .update({ plan: newPlan, updated_at: new Date().toISOString() })
    .eq('id', targetUserId);

  if (error) return res.status(500).json({ error: error.message });

  res.status(200).json({ ok: true });
}
