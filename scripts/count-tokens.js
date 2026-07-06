/**
 * count-tokens.js — count how many input tokens a paragraph uses for a Claude model.
 *
 * Calls Anthropic's /v1/messages/count_tokens endpoint (token counting is not
 * billed — but note it still requires a non-zero account credit balance, since
 * it lives under the /v1/messages family).
 *
 * Usage (from the tendrlt-be folder):
 *   npm run count:tokens
 *   npm run count:tokens -- "Your own paragraph of text here..."
 *   node scripts/count-tokens.js "Your paragraph..."
 *
 * The key is read from .env (CLAUDE_API_KEY) and is never printed.
 */

const fs = require('fs');
const path = require('path');

function readEnvValue(key) {
  if (process.env[key]) return process.env[key];
  const candidates = [
    path.join(process.cwd(), '.env'), // run via npm from tendrlt-be/
    path.join(__dirname, '..', '.env'), // .env one level up from scripts/
    path.join(__dirname, '.env'),
  ];
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && m[1] === key) return m[2].replace(/^["']|["']$/g, '');
    }
  }
  return undefined;
}

const API_KEY = readEnvValue('CLAUDE_API_KEY');
const MODEL = 'claude-haiku-4-5';

const DEFAULT_PARAGRAPH =
  'TendrIt is a home-services tendering marketplace for Jamaica. Homeowners ' +
  'post jobs describing the work they need done, along with a budget and a ' +
  'deadline. Verified service providers browse the open tenders and submit ' +
  'competitive quotes. The homeowner then compares the quotes side by side, ' +
  'chats with providers, and awards the job to the best fit.';

async function main() {
  if (!API_KEY) {
    console.error('✗ CLAUDE_API_KEY not found in .env');
    process.exitCode = 1;
    return;
  }

  const paragraph = process.argv.slice(2).join(' ').trim() || DEFAULT_PARAGRAPH;

  console.log(`→ Model: ${MODEL}`);
  console.log(`→ Text (${paragraph.length} chars):\n${paragraph}\n`);
  console.log('→ Counting tokens...\n');

  let res;
  try {
    res = await fetch('https://api.anthropic.com/v1/messages/count_tokens', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: 'user', content: paragraph }],
      }),
    });
  } catch (err) {
    console.error('✗ Network error reaching the Claude API:', err.message);
    process.exitCode = 1;
    return;
  }

  const data = await res.json().catch(() => null);

  if (!res.ok) {
    const type = data?.error?.type || 'unknown_error';
    const message = data?.error?.message || res.statusText;
    if (res.status === 401) {
      console.error(`✗ INVALID KEY (401 ${type}): ${message}`);
    } else if (/credit balance/i.test(message)) {
      console.error(`✗ Blocked by credit balance (${res.status}): ${message}`);
      console.error('  → Token counting is free, but needs a non-zero balance. Add credits, then re-run.');
    } else {
      console.error(`✗ API returned ${res.status} (${type}): ${message}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log(`✓ Input tokens: ${data.input_tokens}`);
}

main();
