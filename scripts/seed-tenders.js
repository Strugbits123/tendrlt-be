/**
 * Seed script — creates demo tenders for local/testing.
 *
 * Usage:  node scripts/seed-tenders.js [count]   (default 30)
 *
 * - Picks an existing homeowner as the tender owner (client_id).
 * - Spreads tenders across service categories, parishes, urgencies and budgets.
 * - All tenders are created with status='open' so they show in the provider feed.
 * - Attaches the TendrIt logo as each tender's photo (uploaded to the public
 *   `tender-media` Supabase Storage bucket, the same bucket real uploads use).
 */

const path = require('path');
const fs = require('fs');
const { Pool } = require('pg');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const COUNT = Math.max(1, parseInt(process.argv[2], 10) || 30);

const LOGO_PATH = path.join(__dirname, '../../tendrlt-fe/public/icon-512x512.png');

const PARISHES = [
  'Kingston', 'St. Andrew', 'St. Thomas', 'Portland', 'St. Mary', 'St. Ann',
  'Trelawny', 'St. James', 'Hanover', 'Westmoreland', 'St. Elizabeth',
  'Manchester', 'Clarendon', 'St. Catherine',
];

const URGENCIES = ['emergency', 'urgent', 'soon', 'flexible', 'planning'];

// Budget tiers in JMD cents [min, max]
const BUDGET_TIERS = [
  [300000, 700000],     // $3k – $7k
  [500000, 1200000],    // $5k – $12k
  [800000, 1800000],    // $8k – $18k
  [1500000, 3500000],   // $15k – $35k
  [400000, 999900],     // $4k – $9,999
];

// Category-specific job snippets; generic fallback keyed by display name.
const TASKS = {
  lawn_garden:        ['Full lawn mowing, edging and hedge trimming for a medium yard.', 'Garden cleanup, weeding and planting of new flower beds.'],
  plumbing:           ['Fix a leaking kitchen tap and replace the bathroom shower mixer.', 'Investigate low water pressure and repair a burst pipe under the sink.'],
  electrical:         ['Install three ceiling fans and replace a faulty breaker.', 'Rewire two bedrooms and add outdoor security lighting.'],
  pest_control:       ['Treat the house for termites and do a full roach extermination.', 'Quarterly pest control treatment for a 3-bedroom home.'],
  painting:           ['Repaint the living room, hallway and two bedrooms (paint supplied).', 'Exterior wall painting and minor crack filling for a single-storey house.'],
  roofing:            ['Repair leaking zinc roof and replace damaged fascia boards.', 'Inspect and reseal a flat concrete roof before the rainy season.'],
  cleaning:           ['Deep clean a 3-bedroom house including windows and tiles.', 'Post-construction cleanup for a newly renovated apartment.'],
  carpentry:          ['Build custom kitchen cabinets and a pantry shelf unit.', 'Repair wooden door frames and install new skirting.'],
  hvac:               ['Service two split AC units and fix one that is not cooling.', 'Supply and install a new 1.5-ton inverter AC in the master bedroom.'],
  pool_maintenance:   ['Weekly pool cleaning, chemical balancing and filter service.', 'Drain, acid-wash and refill a backyard pool.'],
  solar:              ['Install a 5kW rooftop solar system with battery backup.', 'Service an existing solar array and replace a faulty inverter.'],
  tiling:             ['Re-tile a bathroom floor and walls, approx 25 x 25 ft area.', 'Lay porcelain tiles in an open-plan living and dining room.'],
  moving:             ['Move a 2-bedroom apartment across town, including packing.', 'Relocate office furniture and equipment to a new building.'],
  security:           ['Install 6 CCTV cameras with a DVR and mobile access.', 'Supply and fit burglar bars and an alarm system.'],
  handyman:           ['General repairs: hang doors, patch walls and fix a leaking gutter.', 'Assemble flat-pack furniture and mount two TVs.'],
  general_contractor: ['Build a 12x14 ft concrete extension at the back of the house.', 'Full kitchen and bathroom renovation for a townhouse.'],
};

function pick(arr, i) { return arr[i % arr.length]; }
function randItem(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('ERROR: DATABASE_URL missing in .env');
    process.exit(1);
  }
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    console.error('ERROR: SUPABASE_URL / SUPABASE_SERVICE_KEY missing in .env');
    process.exit(1);
  }
  if (!fs.existsSync(LOGO_PATH)) {
    console.error(`ERROR: Logo not found at ${LOGO_PATH}`);
    process.exit(1);
  }

  const pool = new Pool({
    connectionString,
    ssl: connectionString.includes('supabase.co') ? { rejectUnauthorized: false } : false,
  });
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  const logoBuffer = fs.readFileSync(LOGO_PATH);

  try {
    // 1. Find a homeowner to own the tenders
    const owner = await pool.query(
      `SELECT id, first_name, last_name, email, phone_number
       FROM public.users WHERE role = 'homeowner' ORDER BY created_at ASC LIMIT 1`
    );
    if (owner.rows.length === 0) {
      console.error('ERROR: No homeowner user found. Create one first.');
      process.exit(1);
    }
    const client = owner.rows[0];
    const contactName = `${client.first_name} ${client.last_name}`.trim();
    console.log(`Owner: ${contactName} <${client.email}> (${client.id})`);

    // 2. Load active service types (category = slug, service_type_id = id)
    const svc = await pool.query(
      `SELECT id, slug, display_name FROM public.service_types WHERE is_active = true ORDER BY sort_order`
    );
    if (svc.rows.length === 0) {
      console.error('ERROR: No service_types found. Run migrations/seed first.');
      process.exit(1);
    }
    const services = svc.rows;
    console.log(`Loaded ${services.length} service types. Creating ${COUNT} tenders…\n`);

    let created = 0;
    for (let i = 0; i < COUNT; i++) {
      const service = pick(services, i);
      const parish  = pick(PARISHES, i + 1);
      const urgency = randItem(URGENCIES);
      const [bmin, bmax] = randItem(BUDGET_TIERS);
      const tasks = TASKS[service.slug] || [`Professional ${service.display_name.toLowerCase()} work needed for a residential property.`];
      const description = `${randItem(tasks)} Located in ${parish}. Please quote your best all-inclusive price.`;
      // Stagger created_at across the last ~3 days so the feed looks natural.
      const ageMinutes = Math.floor(Math.random() * 4320);
      const startInDays = Math.floor(Math.random() * 21); // 0–20 days out

      // 3. Insert the tender (status=open)
      const ins = await pool.query(
        `INSERT INTO public.tenders (
           client_id, category, description, parish,
           budget_min, budget_max, status, urgency,
           preferred_start_date, photos_count, service_type_id,
           contact_name, contact_phone, contact_email,
           terms_accepted_at, created_at, updated_at
         ) VALUES (
           $1, $2::service_category, $3, $4,
           $5, $6, 'open', $7::tender_urgency,
           (CURRENT_DATE + ($8 || ' days')::interval), 1, $9,
           $10, $11, $12,
           NOW(), NOW() - ($13 || ' minutes')::interval, NOW()
         ) RETURNING id`,
        [
          client.id, service.slug, description, parish,
          bmin, bmax, urgency,
          startInDays, service.id,
          contactName, client.phone_number || '876-555-0100', client.email,
          ageMinutes,
        ]
      );
      const tenderId = ins.rows[0].id;

      // 4. Upload the TendrIt logo to tender-media + record the photo row
      const storagePath = `${client.id}/${tenderId}/${Date.now()}_0_logo.png`;
      const { error: upErr } = await supabase.storage
        .from('tender-media')
        .upload(storagePath, logoBuffer, { contentType: 'image/png', upsert: true });
      if (upErr) {
        console.warn(`  ⚠ photo upload failed for ${tenderId}: ${upErr.message}`);
      } else {
        await pool.query(
          `INSERT INTO public.tender_photos (tender_id, storage_path, display_order)
           VALUES ($1, $2, 0)`,
          [tenderId, storagePath]
        );
      }

      created++;
      console.log(`  ✓ [${created}/${COUNT}] ${service.display_name} · ${parish} · ${urgency}`);
    }

    console.log(`\nDone. Created ${created} tender(s) for ${contactName}.`);
  } catch (err) {
    console.error('Seed error:', err);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
