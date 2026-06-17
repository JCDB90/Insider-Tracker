import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://loqmxllfjvdwamwicoow.supabase.co';
const ANON_KEY = process.env.SUPABASE_ANON_KEY || 'sb_publishable_wL5qlj7xHeE6-y2cXaRKfw_39-iEoUt';

// Anon client — used only to verify the caller's JWT
const anonSb = createClient(SUPABASE_URL, ANON_KEY);

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).end();

  // Verify caller JWT
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) {
    console.error('[admin-users] no auth token');
    return res.status(401).json({ error: 'Missing auth token' });
  }

  const { data: { user }, error: authErr } = await anonSb.auth.getUser(token);
  if (authErr || !user) {
    console.error('[admin-users] invalid token:', authErr?.message);
    return res.status(401).json({ error: 'Invalid token' });
  }

  console.log('[admin-users] caller:', user.email, user.id);

  // Check admin plan using the caller's own JWT — works under RLS without service role key
  const userSb = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
  const { data: profile, error: profileErr } = await userSb
    .from('user_profiles')
    .select('plan')
    .eq('id', user.id)
    .maybeSingle();

  console.log('[admin-users] caller plan:', profile?.plan, 'err:', profileErr?.message);

  if (profile?.plan !== 'admin') {
    return res.status(403).json({ error: `Forbidden — plan is '${profile?.plan ?? 'unknown'}'` });
  }

  // Fetch all users — requires service role key to bypass RLS
  const svcKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!svcKey) {
    console.error('[admin-users] SUPABASE_SERVICE_ROLE_KEY not set in Vercel env vars');
    return res.status(500).json({ error: 'SUPABASE_SERVICE_ROLE_KEY not configured' });
  }

  const adminSb = createClient(SUPABASE_URL, svcKey);

  const [profilesRes, authRes] = await Promise.all([
    adminSb
      .from('user_profiles')
      .select('id, email, plan, created_at, last_notified_at, stripe_customer_id, subscription_status')
      .order('created_at', { ascending: false }),
    adminSb.auth.admin.listUsers({ perPage: 1000 }),
  ]);

  if (profilesRes.error) {
    console.error('[admin-users] query error:', profilesRes.error.message);
    return res.status(500).json({ error: profilesRes.error.message });
  }

  // Build email → last_sign_in_at lookup from Auth
  const loginMap = {};
  for (const u of authRes.data?.users ?? []) {
    if (u.email) loginMap[u.email.toLowerCase()] = u.last_sign_in_at ?? null;
  }

  const merged = (profilesRes.data ?? []).map(u => ({
    ...u,
    last_login: u.email ? (loginMap[u.email.toLowerCase()] ?? null) : null,
  }));

  console.log('[admin-users] returning', merged.length, 'rows');
  res.status(200).json(merged);
}
