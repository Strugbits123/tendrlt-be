/**
 * Seed script — providers + clients + quotes + accepted jobs + reviews.
 *
 * Usage:  node scripts/seed-providers.js
 *
 * Populates the admin "Providers" screen with real data:
 *  - ~12 providers (mixed verification), each with a service + parishes.
 *  - a few extra homeowners (so Top Clients has variety), each with tenders.
 *  - quotes on open tenders; ~2/3 accepted → transactions (fees snapshotted);
 *    ~half of those completed → a review (1–5 star) powering rating stats.
 *
 * Direct DB writes (bypasses Turnstile/email-verification the same way
 * scripts/create-admin.js + seed-tenders.js do). Idempotent by email.
 * All money is JMD cents.
 */
const path = require('path');
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const PASSWORD = 'Password123!';

const PROVIDERS = [
  { first: 'Asha',     last: 'Campbell', parish: 'St. Ann',       slug: 'cleaning',     verified: true },
  { first: 'Marcus',   last: 'Johnson',  parish: 'St. Andrew',    slug: 'plumbing',     verified: true },
  { first: 'Patricia', last: 'Morgan',   parish: 'Kingston',      slug: 'cleaning',     verified: true },
  { first: 'Miguel',   last: 'Torres',   parish: 'Clarendon',     slug: 'electrical',   verified: true },
  { first: 'Carl',     last: 'Thompson', parish: 'St. Mary',      slug: 'roofing',      verified: true },
  { first: 'Andre',    last: 'Williams', parish: 'Kingston',      slug: 'lawn_garden',  verified: true },
  { first: 'Donovan',  last: 'Reid',     parish: 'St. Catherine', slug: 'electrical',   verified: true },
  { first: 'Kesha',    last: 'Brown',    parish: 'Kingston',      slug: 'lawn_garden',  verified: true },
  { first: 'Peter',    last: 'Clarke',   parish: 'Portland',      slug: 'roofing',      verified: true },
  { first: 'Devon',    last: 'Smith',    parish: 'Kingston',      slug: 'plumbing',     verified: false },
  { first: 'Simone',   last: 'Grant',    parish: 'St. James',     slug: 'painting',     verified: false },
  { first: 'Rohan',    last: 'Bailey',   parish: 'Manchester',    slug: 'hvac',         verified: false },
];

const CLIENTS = [
  { first: 'Devon',   last: 'Hughes',   parish: 'Kingston' },
  { first: 'Marcia',  last: 'Thompson', parish: 'St. Andrew' },
  { first: 'Sandra',  last: 'Brown',    parish: 'St. Catherine' },
  { first: 'Keith',   last: 'Morrison', parish: 'Manchester' },
];

const TIMELINES = ['same_day', 'next_day', '2_3_days', 'within_1_week', '1_2_weeks', '2_4_weeks'];
const REVIEWS = [
  'Excellent work, very professional and on time.', 'Great job, would hire again.',
  'Good service overall, a few small delays.', 'Did the work as agreed, happy with the result.',
  'Solid work and fair pricing.', 'Communication could be better but the job got done.',
  'Outstanding — exceeded expectations.', 'Decent work, cleaned up after.',
];
// Weighted toward high ratings, with a couple of low ones so flags/distribution look real.
const RATING_POOL = [5, 5, 5, 5, 4, 4, 4, 3, 5, 4, 2, 1];

const rand = (n) => Math.floor(Math.random() * n);
const randItem = (a) => a[rand(a.length)];
const emailFor = (f, l) => `${f}.${l}`.toLowerCase().replace(/[^a-z.]/g, '') + '@seed.tendrit.test';

async function upsertUser(pool, { first, last, parish, role, providerService }, hash) {
  const email = emailFor(first, last);
  await pool.query(
    `INSERT INTO public.users (email, password_hash, first_name, last_name, phone_number, parish, role, provider_service, is_email_verified)
     VALUES ($1,$2,$3,$4,$5,$6,$7::user_role,$8,true)
     ON CONFLICT (email) DO NOTHING`,
    [email, hash, first, last, '876-555-0' + (100 + rand(899)), parish, role, providerService || null]
  );
  const r = await pool.query('SELECT id FROM public.users WHERE email = $1', [email]);
  return r.rows[0].id;
}

async function main() {
  const cs = process.env.DATABASE_URL;
  if (!cs) { console.error('ERROR: DATABASE_URL missing in .env'); process.exit(1); }
  const pool = new Pool({ connectionString: cs, ssl: cs.includes('supabase.co') ? { rejectUnauthorized: false } : false });
  const hash = await bcrypt.hash(PASSWORD, 10);

  try {
    // Active fee rates → snapshot onto tenders/quotes/transactions.
    const cfg = (await pool.query('SELECT client_rate, provider_rate FROM public.platform_fee_config WHERE id = 1')).rows[0] || {};
    const clientRate = parseFloat(cfg.client_rate) || 9.5;
    const providerRate = parseFloat(cfg.provider_rate) || 12;

    // Service catalog by slug.
    const svc = (await pool.query('SELECT id, slug, display_name FROM public.service_types')).rows;
    const svcBySlug = Object.fromEntries(svc.map((s) => [s.slug, s]));

    // 1) Providers.
    const providers = [];
    for (const p of PROVIDERS) {
      const service = svcBySlug[p.slug] || randItem(svc);
      const id = await upsertUser(pool, { ...p, role: 'provider', providerService: service.display_name }, hash);
      await pool.query(
        `INSERT INTO public.provider_profiles
           (provider_id, bio, business_name, is_verified, is_onboarding_complete, verification_status, submitted_at)
         VALUES ($1,$2,$3,$4,true,$5::verification_status, NOW() - INTERVAL '20 days')
         ON CONFLICT (provider_id) DO UPDATE
           SET is_verified = EXCLUDED.is_verified, verification_status = EXCLUDED.verification_status,
               is_onboarding_complete = true`,
        [id, `Experienced ${service.display_name} professional serving ${p.parish}.`, `${p.last} ${service.display_name} Co.`,
         p.verified, p.verified ? 'approved' : 'pending']
      );
      if (p.verified) {
        await pool.query(`UPDATE public.provider_profiles SET reviewed_at = NOW() - INTERVAL '18 days' WHERE provider_id = $1 AND reviewed_at IS NULL`, [id]);
      }
      await pool.query(
        `INSERT INTO public.provider_services (provider_id, category, service_type_id)
         VALUES ($1,$2::service_category,$3) ON CONFLICT (provider_id, category) DO NOTHING`,
        [id, service.slug, service.id]
      );
      await pool.query(
        `INSERT INTO public.provider_parishes (provider_id, parish) VALUES ($1,$2)
         ON CONFLICT (provider_id, parish) DO NOTHING`,
        [id, p.parish]
      );
      providers.push({ id, name: `${p.first} ${p.last}` });
    }
    console.log(`Providers ready: ${providers.length}`);

    // 2) Extra homeowners (clients) + a couple of tenders each.
    const clientIds = [];
    for (const c of CLIENTS) {
      const id = await upsertUser(pool, { ...c, role: 'homeowner' }, hash);
      clientIds.push(id);
      for (let k = 0; k < 2; k++) {
        const service = randItem(svc);
        const bmin = 300000 + rand(20) * 100000;
        await pool.query(
          `INSERT INTO public.tenders
             (client_id, category, service_type_id, parish, description, urgency, status,
              budget_min, budget_max, contact_name, contact_phone, contact_email,
              client_fee_rate, terms_accepted_at, created_at, updated_at)
           VALUES ($1,$2::service_category,$3,$4,$5,'soon','open',$6,$7,$8,$9,$10,$11,NOW(),
                   NOW() - (($12)||' days')::interval, NOW())`,
          [id, service.slug, service.id, c.parish,
           `${service.display_name} work needed in ${c.parish}.`, bmin, bmin + 500000,
           `${c.first} ${c.last}`, '876-555-0100', emailFor(c.first, c.last),
           clientRate, 3 + rand(10)]
        );
      }
    }
    console.log(`Extra clients ready: ${clientIds.length}`);

    // 3) Candidate open tenders (all homeowners incl. existing nooramin).
    const tenders = (await pool.query(
      `SELECT id, client_id, budget_min, budget_max, created_at, client_fee_rate
       FROM public.tenders WHERE status = 'open' ORDER BY created_at ASC`
    )).rows;
    console.log(`Open tenders available: ${tenders.length}`);

    let quotesN = 0, acceptedN = 0, completedN = 0, reviewsN = 0;
    // Award ~70% of tenders; complete ~half of those.
    for (let i = 0; i < tenders.length; i++) {
      const t = tenders[i];
      const bmin = t.budget_min || 400000;
      const bmax = t.budget_max || 1500000;
      const cRate = parseFloat(t.client_fee_rate) || clientRate;

      // 2–3 distinct providers quote this tender.
      const shuffled = [...providers].sort(() => Math.random() - 0.5);
      const bidders = shuffled.slice(0, 2 + rand(2));
      const quoteRows = [];
      for (const b of bidders) {
        const amount = bmin + rand(Math.max(1, bmax - bmin));
        const hrs = 1 + rand(36);
        const created = new Date(Math.min(Date.now(), new Date(t.created_at).getTime() + hrs * 3600e3));
        const q = await pool.query(
          `INSERT INTO public.quotes (tender_id, provider_id, amount, timeline, message, provider_fee_rate, status, created_at, updated_at)
           VALUES ($1,$2,$3,$4::quote_timeline,$5,$6,'pending',$7,$7)
           ON CONFLICT (tender_id, provider_id) DO NOTHING
           RETURNING id`,
          [t.id, b.id, amount, randItem(TIMELINES), 'Happy to help — full service included.', providerRate, created.toISOString()]
        );
        if (q.rows[0]) { quotesN++; quoteRows.push({ id: q.rows[0].id, providerId: b.id, amount }); }
      }
      if (quoteRows.length === 0) continue;

      // Award ~70% of tenders.
      if (Math.random() > 0.7) continue;
      const win = quoteRows[0];
      await pool.query(`UPDATE public.quotes SET status='rejected', updated_at=NOW() WHERE tender_id=$1 AND id<>$2`, [t.id, win.id]);
      await pool.query(`UPDATE public.quotes SET status='accepted', updated_at=NOW() WHERE id=$1`, [win.id]);
      acceptedN++;

      const clientFee = Math.round((win.amount * cRate) / 100);
      const providerFee = Math.round((win.amount * providerRate) / 100);
      const payout = win.amount - providerFee;
      const platformFee = clientFee + providerFee;
      const complete = Math.random() < 0.55;

      await pool.query(
        `INSERT INTO public.transactions
           (quote_id, tender_id, client_id, provider_id, amount, client_fee, provider_fee,
            client_fee_rate, provider_fee_rate, platform_fee, provider_payout, status,
            collected_at, provider_completed_at, completed_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NOW(),$13,$14)
         ON CONFLICT (quote_id) DO NOTHING`,
        [win.id, t.id, t.client_id, win.providerId, win.amount, clientFee, providerFee,
         cRate, providerRate, platformFee, payout, complete ? 'completed' : 'held',
         complete ? new Date().toISOString() : null, complete ? new Date().toISOString() : null]
      );
      await pool.query(`UPDATE public.tenders SET status=$2, updated_at=NOW() WHERE id=$1`,
        [t.id, complete ? 'completed' : 'in_progress']);

      if (complete) {
        completedN++;
        const rating = randItem(RATING_POOL);
        const r = await pool.query(
          `INSERT INTO public.reviews (tender_id, quote_id, client_id, provider_id, rating, comment)
           VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (tender_id, client_id) DO NOTHING RETURNING id`,
          [t.id, win.id, t.client_id, win.providerId, rating, randItem(REVIEWS)]
        );
        if (r.rows[0]) reviewsN++;
      }
    }

    console.log(`\nDone.`);
    console.log(`  quotes:       ${quotesN}`);
    console.log(`  accepted:     ${acceptedN}`);
    console.log(`  completed:    ${completedN}`);
    console.log(`  reviews:      ${reviewsN}`);
    console.log(`\nSeed provider/client login password: ${PASSWORD}`);
  } catch (err) {
    console.error('Seed error:', err);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
