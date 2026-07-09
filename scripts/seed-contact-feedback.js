/**
 * Seed script — creates demo Contact Inbox + Feedback Inbox submissions for
 * local/testing so the admin panel tables have data to render.
 *
 * Usage:  node scripts/seed-contact-feedback.js [count]   (default 35, per table)
 */

const path = require('path');
const { Pool } = require('pg');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const COUNT = Math.max(1, parseInt(process.argv[2], 10) || 35);

const NAME_POOL = [
  { fn: 'Sandra', ln: 'Brown' }, { fn: 'Devon', ln: 'Hughes' }, { fn: 'Marcus', ln: 'Thompson' },
  { fn: 'Kezia', ln: 'Brown' }, { fn: 'Patricia', ln: 'Clarke' }, { fn: 'Omar', ln: 'Blake' },
  { fn: 'Winston', ln: 'Bailey' }, { fn: 'Simone', ln: 'Reid' }, { fn: 'Clinton', ln: 'James' },
  { fn: 'Yvette', ln: 'Hamilton' }, { fn: 'Beverley', ln: 'Edwards' }, { fn: 'Donna', ln: 'Richards' },
  { fn: 'Andre', ln: 'Williams' }, { fn: 'Kirk', ln: 'Anderson' }, { fn: 'Horace', ln: 'Patterson' },
  { fn: 'Sharon', ln: 'Murray' }, { fn: 'Devon', ln: 'Clarke' }, { fn: 'Ricky', ln: 'Dawkins' },
  { fn: 'Marcia', ln: 'Thomas' }, { fn: 'Natasha', ln: 'Green' }, { fn: 'Paulette', ln: 'Morrison' },
  { fn: 'Tanya', ln: 'Francis' }, { fn: 'Victor', ln: 'Reid' }, { fn: 'Delroy', ln: 'Reid' },
  { fn: 'Grace', ln: 'Campbell' }, { fn: 'Errol', ln: 'Hamilton' }, { fn: 'Michael', ln: 'Brown' },
  { fn: 'Judith', ln: 'Powell' }, { fn: 'Owen', ln: 'Grant' }, { fn: 'Cherry', ln: 'Douglas' },
  { fn: 'Franklyn', ln: 'Reid' }, { fn: 'Leroy', ln: 'Campbell' },
];
const DOMAINS = ['gmail.com', 'outlook.com', 'yahoo.com', 'hotmail.com'];
const PARISHES = [
  'Kingston', 'St. Andrew', 'St. Thomas', 'Portland', 'St. Mary', 'St. Ann',
  'Trelawny', 'St. James', 'Hanover', 'Westmoreland', 'St. Elizabeth', 'Manchester', 'Clarendon', 'St. Catherine',
];
const STATUS_POOL = ['new', 'new', 'read', 'read', 'read', 'resolved', 'archived'];

function pick(arr, i) { return arr[i % arr.length]; }
function randItem(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function randInt(min, max) { return min + Math.floor(Math.random() * (max - min + 1)); }
function emailFor(p) { return `${p.fn.toLowerCase()}.${p.ln.charAt(0).toLowerCase()}@${randItem(DOMAINS)}`; }
function tenderCode() { return `TND-${randInt(1000, 9999)}`; }

/* ── Contact messages ── */
const CONTACT_ROLES = ['homeowner', 'homeowner', 'provider', 'provider', 'other'];
const CONTACT_TEMPLATES = {
  'Problem with a quote': [
    () => `I accepted a quote for ${tenderCode()} but the total shown at payment does not match what the provider quoted. Can someone explain the breakdown?`,
    () => `A provider submitted a quote for my job in ${randItem(PARISHES)} three days ago and it still shows as pending. Is there a way to follow up?`,
  ],
  'Payment or escrow issue': [
    () => `I released payment for job ${tenderCode()} four days ago but the provider says the funds have not arrived yet. Please investigate.`,
    () => `My payout for job ${tenderCode()} shows as Paid in my dashboard but I have not received it in my bank account.`,
  ],
  'Provider verification': [
    () => `I submitted my documents for verification over two weeks ago and my status is still Pending. Can you check what's holding it up?`,
    () => `My verification was approved but my public profile still shows an unverified badge. Please fix this.`,
  ],
  'Account access': [
    () => `I can't log in to my account. I've tried resetting my password twice but the reset email never arrives.`,
    () => `I need to update the email address on my account and can't find the option in settings.`,
  ],
  'Report a user': [
    () => `I'd like to report a provider who took a deposit outside the platform for job ${tenderCode()} and never completed the work.`,
    () => `A client posted a tender in ${randItem(PARISHES)}, received several quotes, then cancelled it with no explanation. This wastes providers' time.`,
  ],
  'Feature request': [
    () => `It would be great to have a side-by-side quote comparison view instead of clicking into each quote individually.`,
    () => `Could you add calendar integration so confirmed jobs automatically show up in Google Calendar?`,
  ],
  'General question': [
    () => `Is TendrIt available in ${randItem(PARISHES)} yet? I'd like to post a job but wasn't sure about coverage.`,
    () => `How long does it usually take to start receiving quotes after posting a tender?`,
  ],
  'Other': [
    () => `I'm writing on behalf of a local community group interested in a partnership with TendrIt. Who should we reach out to?`,
    () => `Just wanted to say the platform has been a great experience so far — quick question about your fee structure though.`,
  ],
};
const CONTACT_SUBJECTS = Object.keys(CONTACT_TEMPLATES);

/* ── Feedback submissions ── */
const FEEDBACK_ROLES = ['client', 'client', 'provider', 'provider', 'visitor', 'other'];
const FEEDBACK_TEMPLATES = {
  feedback: [
    () => `Really happy with TendrIt — got several competitive quotes within hours and the secure payment gave me peace of mind.`,
    () => `Great platform overall. Would love the ability to message a provider before accepting their quote.`,
    () => `My booking rate has gone up noticeably since joining. Clients here take the process seriously because payment is held securely.`,
  ],
  bug: [
    () => `The quote form resets and loses everything I typed after I attach a photo. Happens consistently on Chrome/Android.`,
    () => `I got the same confirmation email four times for a single event — looks like a notification bug.`,
    () => `My "Available Now" toggle doesn't persist between sessions, so I keep missing new tender alerts.`,
  ],
  idea: [
    () => `A "Saved Providers" feature would be great — once I find someone reliable I'd like to invite them directly next time.`,
    () => `Please consider adding a portfolio/gallery feature so providers can show before-and-after photos.`,
    () => `An automated repeat-booking option for recurring jobs like lawn care would save a lot of time.`,
  ],
  other: [
    () => `Is TendrIt planning to expand into ${randItem(PARISHES)} any time soon? Following the platform with interest.`,
    () => `I'd like to explore a partnership opportunity — who's the right person to contact about that?`,
  ],
};
const FEEDBACK_CATS = ['feedback', 'feedback', 'feedback', 'bug', 'bug', 'idea', 'other'];

async function seedContactMessages(pool, count) {
  let created = 0;
  for (let i = 0; i < count; i++) {
    const person = pick(NAME_POOL, i + 3);
    const role = randItem(CONTACT_ROLES);
    const subject = pick(CONTACT_SUBJECTS, i);
    const message = randItem(CONTACT_TEMPLATES[subject])();
    const status = randItem(STATUS_POOL);
    const trashed = i > 0 && i % 9 === 0;
    const ageMinutes = randInt(0, 43200); // spread across the last ~30 days

    await pool.query(
      `INSERT INTO public.contact_messages (first_name, last_name, email, role, subject, message, status, trashed, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW() - ($9 || ' minutes')::interval)`,
      [person.fn, person.ln, emailFor(person), role, subject, message, status, trashed, ageMinutes]
    );
    created++;
  }
  return created;
}

async function seedFeedbackSubmissions(pool, count) {
  let created = 0;
  for (let i = 0; i < count; i++) {
    const person = pick(NAME_POOL, i + 11);
    const cat = pick(FEEDBACK_CATS, i);
    const role = randItem(FEEDBACK_ROLES);
    const message = randItem(FEEDBACK_TEMPLATES[cat])();
    const rating = cat === 'feedback' ? randInt(3, 5) : null;
    const followUp = Math.random() < 0.7;
    const status = randItem(STATUS_POOL);
    const ageMinutes = randInt(0, 43200);

    await pool.query(
      `INSERT INTO public.feedback_submissions (cat, name, email, role, rating, follow_up, message, status, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW() - ($9 || ' minutes')::interval)`,
      [cat, `${person.fn} ${person.ln}`, emailFor(person), role, rating, followUp, message, status, ageMinutes]
    );
    created++;
  }
  return created;
}

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('ERROR: DATABASE_URL missing in .env');
    process.exit(1);
  }

  const pool = new Pool({
    connectionString,
    ssl: connectionString.includes('supabase.co') ? { rejectUnauthorized: false } : false,
  });

  try {
    console.log(`Seeding ${COUNT} contact messages…`);
    const contactCount = await seedContactMessages(pool, COUNT);
    console.log(`  ✓ Created ${contactCount} contact message(s).`);

    console.log(`Seeding ${COUNT} feedback submissions…`);
    const feedbackCount = await seedFeedbackSubmissions(pool, COUNT);
    console.log(`  ✓ Created ${feedbackCount} feedback submission(s).`);

    console.log('\nDone.');
  } catch (err) {
    console.error('Seed error:', err);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
