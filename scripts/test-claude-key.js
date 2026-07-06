/**
 * test-claude-key.js — quick check that CLAUDE_API_KEY is valid.
 *
 * Sends a paragraph to Claude and prints back a short AI summary. If the key
 * works you get a summary; if it's invalid/expired you get a clear message.
 *
 * Usage (from the tendrlt-be folder so it picks up .env):
 *   node ../test-claude-key.js
 *   node ../test-claude-key.js "Your own paragraph of text here..."
 *
 * The key is read from tendrlt-be/.env (CLAUDE_API_KEY) and is never printed.
 */

// Read CLAUDE_API_KEY straight from tendrlt-be/.env (no dependencies needed).
const fs = require('fs');
const path = require('path');

function readEnvValue(key) {
  // Env var wins if already set; otherwise parse tendrlt-be/.env.
  if (process.env[key]) return process.env[key];
  const candidates = [
    path.join(__dirname, 'tendrlt-be', '.env'), // run from project root
    path.join(__dirname, '.env'), // script sitting next to .env
    path.join(process.cwd(), '.env'), // run from inside tendrlt-be
  ];
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && m[1] === key) {
        return m[2].replace(/^["']|["']$/g, ''); // strip optional quotes
      }
    }
  }
  return undefined;
}

const API_KEY = readEnvValue('CLAUDE_API_KEY');

// Cheapest + fastest model — ideal for a validity check.
const MODEL = 'claude-haiku-4-5';

// Sample paragraph used when none is passed on the command line.
const DEFAULT_PARAGRAPH =
  'TendrIt is a home-services tendering marketplace for Jamaica. Homeowners ' +
  'post jobs describing the work they need done, along with a budget and a ' +
  'deadline. Verified service providers browse the open tenders and submit ' +
  'competitive quotes. The homeowner then compares the quotes side by side, ' +
  'chats with providers, and awards the job to the best fit. The platform ' +
  'handles secure payments, applies a small service fee to each transaction, ' +
  'and keeps a full history of every job so both sides build a trusted track ' +
  'record over time.';

async function main() {
  if (!API_KEY) {
    console.error(
      '✗ CLAUDE_API_KEY not found. Add it to tendrlt-be/.env, e.g.:\n' +
        '  CLAUDE_API_KEY=sk-ant-...'
    );
    process.exit(1);
  }

  const paragraph = process.argv.slice(2).join(' ').trim() || DEFAULT_PARAGRAPH;

  console.log(`→ Model: ${MODEL}`);
  console.log(`→ Input (${paragraph.length} chars):\n${paragraph}\n`);
  console.log('→ Asking Claude for a short summary...\n');

  let res;
  try {
    res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 256,
        messages: [
          {
            role: 'user',
            content:
              'Summarize the following text in one or two short sentences.\n\n' +
              paragraph,
          },
        ],
      }),
    });
    console.log(res)
  } catch (err) {
    console.error('✗ Network error reaching the Claude API:', err.message);
    process.exitCode = 1;
    return;
  }

  const data = await res.json().catch(() => null);
  console.log('→ API response received.\n');
  console.log(data)

  if (!res.ok) {
    // Common cases: 401 invalid key, 403 no access, 429 rate limit, 400 billing.
    const type = data?.error?.type || 'unknown_error';
    const message = data?.error?.message || res.statusText;
    const isCredit = /credit balance/i.test(message);

    if (res.status === 401) {
      console.error(`✗ INVALID KEY (${res.status} ${type}): ${message}`);
      console.error('  → The CLAUDE_API_KEY is invalid or revoked.');
      return process.exitCode = 1;
    }
    if (isCredit) {
      // The request was authenticated, so the KEY itself is valid — the
      // account just has no usable credits.
      console.log(`✓ Key is VALID (authenticated OK), but the account is out of credits.`);
      console.log(`  → ${message}`);
      console.log('  → Add credits at console.anthropic.com → Plans & Billing, then re-run.');
      return;
    }
    console.error(`✗ API returned ${res.status} (${type}): ${message}`);
    console.error('  → The key was accepted, but the request failed for the reason above.');
    return process.exitCode = 1;
  }

  const summary = (data.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();

  console.log('✓ Key is valid. Summary from Claude:\n');
  console.log(summary);
  console.log(
    `\n(tokens — in: ${data.usage?.input_tokens}, out: ${data.usage?.output_tokens})`
  );
}

main();
