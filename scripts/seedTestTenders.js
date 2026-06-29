/**
 * Seed script — bulk OPEN tenders for testing the public Explore page.
 *
 * Usage:  node scripts/seedTestTenders.js
 *
 * Creates a spread of open tenders (varied category / parish / urgency / budget /
 * quotes_count / created_at) owned by the account below, so the Explore page
 * filters, sorts and counts can be exercised against real data.
 *
 * Idempotent: every seeded row's description is tagged with [SEEDTEST]; the
 * script deletes prior seeds for this user before inserting a fresh batch.
 */

require('dotenv').config();
const db = require('../db');

const OWNER_EMAIL = 'nooramin@strugbitsglobal.com';
const TAG = '[SEEDTEST]';

const PARISHES = [
  'Kingston', 'St. Andrew', 'St. Thomas', 'Portland', 'St. Mary', 'St. Ann',
  'Trelawny', 'St. James', 'Hanover', 'Westmoreland', 'St. Elizabeth', 'Manchester',
  'Clarendon', 'St. Catherine',
];

const URGENCIES = ['emergency', 'urgent', 'soon', 'flexible', 'planning'];

// Budget buckets in whole dollars → matches the Explore budget filter ranges.
const BUDGETS = [
  { min: 2000,  max: 4500  }, // under $5k
  { min: 5000,  max: 12000 }, // $5k–$15k
  { min: 18000, max: 28000 }, // $15k–$50k
  { min: 55000, max: 70000 }, // $50k+
];

const DESCRIPTIONS = [
  'Looking for a reliable professional to handle this job promptly. Please include your rate and availability.',
  'Mid-sized job at a residential property. Materials can be discussed. References appreciated.',
  'Urgent attention needed. Site is ready and accessible. Quote should cover labour and cleanup.',
  'Recurring/ongoing arrangement preferred for the right provider. Quality and punctuality matter most.',
  'Standard scope of work for a 3-bedroom home. Photos available on request after quoting.',
];

(async () => {
  try {
    const u = await db.query(
      'SELECT id, email, role FROM public.users WHERE email = $1',
      [OWNER_EMAIL],
    );
    if (u.rows.length === 0) {
      console.error(`✗ No user found with email ${OWNER_EMAIL}. Aborting.`);
      process.exit(1);
    }
    const owner = u.rows[0];
    console.log(`Owner: ${owner.email} (${owner.id}) — role=${owner.role}`);

    const svc = await db.query(
      'SELECT slug, display_name FROM public.service_types WHERE is_active = true ORDER BY sort_order',
    );
    const slugs = svc.rows.map(r => r.slug);
    if (slugs.length === 0) {
      console.error('✗ No active service_types found. Aborting.');
      process.exit(1);
    }
    console.log(`Service categories (${slugs.length}): ${slugs.join(', ')}`);

    // Clean any previous seed batch for this owner.
    const del = await db.query(
      `DELETE FROM public.tenders WHERE client_id = $1 AND description LIKE $2`,
      [owner.id, `%${TAG}%`],
    );
    console.log(`Removed ${del.rowCount} previous seeded tender(s).`);

    // Build the batch: one tender per (category × first few parishes), cycling
    // urgency / budget / quotes / age for good filter coverage.
    const rows = [];
    let i = 0;
    for (const slug of slugs) {
      // 2 tenders per category, across rotating parishes.
      for (let k = 0; k < 2; k++) {
        const parish    = PARISHES[i % PARISHES.length];
        const urgency   = URGENCIES[i % URGENCIES.length];
        const budget    = BUDGETS[i % BUDGETS.length];
        const quotes    = i % 7;                 // 0..6 → exercises "fewest quotes"
        const ageDays   = i % 5 === 0 ? 0 : (i % 9); // some posted today → "new today"
        const display   = svc.rows.find(s => s.slug === slug)?.display_name ?? slug;
        const desc      = `${DESCRIPTIONS[i % DESCRIPTIONS.length]} ${TAG} ${display} in ${parish}.`;
        rows.push({ slug, parish, urgency, budget, quotes, ageDays, desc });
        i++;
      }
    }

    let inserted = 0;
    for (const r of rows) {
      const res = await db.query(
        `INSERT INTO public.tenders (
            client_id, category, service_type_id, parish,
            description, urgency, urgency_note,
            preferred_start_date, budget_min, budget_max,
            contact_name, contact_phone, contact_email,
            location_lat, location_lng, status,
            terms_accepted_at, quotes_count, created_at
         )
         SELECT
            $1, $2::service_category, st.id, $3,
            $4, $5::tender_urgency, NULL,
            (now() + interval '5 days')::date, $6, $7,
            $8, $9, $10,
            NULL, NULL, 'open'::tender_status,
            now(), $11, now() - ($12 || ' days')::interval
         FROM public.service_types st
         WHERE st.slug = $2::text
         RETURNING id`,
        [
          owner.id,
          r.slug,
          r.parish,
          r.desc,
          r.urgency,
          r.budget.min * 100,
          r.budget.max * 100,
          'Test Homeowner',
          '8765551234',
          OWNER_EMAIL,
          r.quotes,
          String(r.ageDays),
        ],
      );
      if (res.rows.length) inserted++;
    }

    console.log(`✓ Inserted ${inserted} open tender(s) for ${OWNER_EMAIL}.`);
    process.exit(0);
  } catch (err) {
    console.error('✗ Seed failed:', err.message);
    process.exit(1);
  }
})();
