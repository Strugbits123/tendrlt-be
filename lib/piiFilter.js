/**
 * PII / off-platform-contact filter for quote chat.
 *
 * AUTHORITATIVE copy — the server must never trust the client's check.
 * The frontend keeps a mirror (tendrlt-fe/lib/piiFilter.ts) only for instant UX.
 *
 * Goal: stop the two parties from taking the deal off-platform by sharing
 * phone numbers, emails, addresses, social handles, or asking to pay cash /
 * message on WhatsApp etc. Tuned to err toward blocking obvious attempts while
 * keeping normal job conversation usable.
 *
 * Two defence layers (regex alone loses to a motivated human):
 *   Layer 1 — NORMALIZE, then match. Every pattern runs against three views of
 *             the text: raw, normalized (NFKC + lowercase + homoglyphs + no
 *             zero-width chars), and "de-spaced" (single-char runs like
 *             "s t r e e t" rejoined to "street"). This defeats the
 *             spaced-out / rewritten-character bypass.
 *   Layer 2 — HEURISTICS, not enumeration. A joined-digit-run test (catches
 *             "8 7 6 - 5 5 5 ..." and spelled-out digits) and a dense
 *             street-address test — two rules that generalise better than
 *             piling on more literal patterns.
 *
 * (A future Layer 3 — a Claude classifier — can catch the truly obfuscated
 *  cases regex can never reach; see scripts/test-claude-key.js.)
 *
 * detectPII(text) -> { blocked: boolean, label: string | null }
 */

// Spelled-out digits → used to catch "eight seven six five five five ..."
const SPELLED = '(zero|one|two|three|four|five|six|seven|eight|nine|oh|o)';

const PII_PATTERNS = [
  // ── Phone numbers ────────────────────────────────────────────────
  // Jamaican prefixes with separators
  { re: /\b(?:1[-.\s]?)?(?:876|658)[-.\s]?\d{3}[-.\s]?\d{4}\b/, label: 'Jamaican phone number' },
  // Generic 7–15 digit run allowing spaces/dots/dashes/parens (e.g. (555) 123 4567, +44 7911 123456)
  { re: /(?:\+?\d[\s.\-()]?){7,15}/, label: 'phone number' },
  // 4-3-4 / 3-3-4 grouped numbers
  { re: /\b\d{3,4}[-.\s]\d{3}[-.\s]\d{4}\b/, label: 'phone number' },
  // Spelled-out digit sequences (5+ in a row)
  { re: new RegExp(`(?:\\b${SPELLED}\\b[\\s,.-]*){5,}`, 'i'), label: 'spelled-out phone number' },
  // "(my) number/digits is/are ...", "reach/call/text/whatsapp me on/at"
  { re: /\b(my\s+)?(number|digits|cell|mobile|phone)\s+(is|are|:)/i, label: 'phone number attempt' },
  { re: /\b(call|text|txt|ring|reach|whatsapp|message|msg|contact)\s+me\b/i, label: 'direct contact attempt' },

  // ── Email ────────────────────────────────────────────────────────
  { re: /\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b/, label: 'email address' },
  // Obfuscated: "name at gmail dot com"
  { re: /\b[A-Za-z0-9._%+\-]+\s*(?:@|\bat\b)\s*[A-Za-z0-9.\-]+\s*(?:\.|\bdot\b)\s*(com|net|org|io|co|edu|gov)\b/i, label: 'email address' },

  // ── URLs / social / messaging apps ──────────────────────────────
  { re: /\bhttps?:\/\/\S+/i, label: 'external link' },
  { re: /\b(wa\.me|t\.me|m\.me|bit\.ly|linktr\.ee)\b/i, label: 'external link' },
  { re: /\bwhats\s?app\b/i, label: 'WhatsApp contact' },
  { re: /\btelegram\b/i, label: 'Telegram contact' },
  { re: /\bsignal\s+(app|me|number)\b/i, label: 'Signal contact' },
  { re: /\b(instagram|insta|ig)\b/i, label: 'Instagram handle' },
  { re: /\b(facebook|fb|messenger)\b/i, label: 'Facebook contact' },
  { re: /\b(snapchat|snap)\b/i, label: 'Snapchat handle' },
  { re: /\btiktok\b/i, label: 'TikTok handle' },
  // @handle (not an email — no domain after)
  { re: /(^|\s)@[A-Za-z0-9._]{2,}\b/, label: 'social handle' },

  // ── Off-platform payment ─────────────────────────────────────────
  { re: /\bcash\s*(only|payment|in\s*hand)\b/i, label: 'off-platform payment request' },
  { re: /\bpay\s*(me\s*)?(cash|directly|outside|off[\s-]*platform|in\s*person)\b/i, label: 'off-platform payment request' },
  { re: /\b(bank|wire)\s*(transfer|details|account|acct|info)\b/i, label: 'bank details' },
  { re: /\b(venmo|cashapp|cash\s*app|zelle|paypal|revolut)\b/i, label: 'off-platform payment app' },
  { re: /\b(off|outside)\s*(the\s*)?(platform|app|tendrit)\b/i, label: 'off-platform request' },

  // ── Physical address ─────────────────────────────────────────────
  // number + street-type token (e.g. "12 King Street", "5 Hope Rd")
  { re: /\b\d{1,5}\s+([A-Za-z]+\s+){0,3}(street|st\.?|avenue|ave\.?|road|rd\.?|lane|ln\.?|drive|dr\.?|crescent|cres\.?|close|boulevard|blvd\.?|terrace|way|court|ct\.?)\b/i, label: 'street address' },
  { re: /\b(my|the)\s+address\s+(is|:)/i, label: 'address attempt' },
];

// ── Layer 1: normalization ─────────────────────────────────────────
// Zero-width / invisible joiners, word joiner, BOM, variation selector-16,
// and the combining keycap (so "1<keycap>" collapses to "1").
const INVISIBLE_RE = new RegExp('[' + [0x200b,0x200c,0x200d,0x2060,0xfeff,0xfe0f,0x20e3].map(function(c){return String.fromCharCode(c);}).join('') + ']', 'g');

// Common Cyrillic / Greek look-alikes → their Latin equivalent. Keys are
// lowercase (we lowercase before mapping).
const HOMOGLYPHS = {
  а: 'a', в: 'b', е: 'e', к: 'k', м: 'm', н: 'h', о: 'o', р: 'p', с: 'c',
  т: 't', у: 'y', х: 'x', і: 'i', ј: 'j', ѕ: 's', ԁ: 'd',
  α: 'a', β: 'b', ε: 'e', ι: 'i', κ: 'k', ν: 'v', ο: 'o', ρ: 'p', τ: 't',
  υ: 'y', χ: 'x', ϲ: 'c',
};
const HG_RE = new RegExp('[' + Object.keys(HOMOGLYPHS).join('') + ']', 'g');

function normalize(text) {
  return text
    .normalize('NFKC') // fold full-width / compatibility forms to ASCII
    .toLowerCase()
    .replace(INVISIBLE_RE, '')
    .replace(HG_RE, (c) => HOMOGLYPHS[c] || c);
}

// Rejoin runs of single characters separated by spaces/dots/dashes:
// "s t r e e t" -> "street", "8 7 6-5 5 5" -> "876555".
// Only collapses genuinely single-char tokens, so normal words are untouched.
function deSpace(s) {
  return s.replace(/\b[0-9a-z](?:[\s._\-]+[0-9a-z]\b)+/gi, (m) =>
    m.replace(/[\s._\-]+/g, '')
  );
}

// Remove all separators — used only by the dense-address heuristic.
function strip(s) {
  return s.replace(/[\s.,_\-()#]/g, '');
}

// ── Layer 2: heuristics ────────────────────────────────────────────
const WORD_TO_DIGIT = {
  zero: '0', one: '1', two: '2', three: '3', four: '4',
  five: '5', six: '6', seven: '7', eight: '8', nine: '9', oh: '0',
};

// Convert spelled-out numbers to digits, then join any digits separated only
// by spaces/dots/dashes/parens, and look for a run of 7+ — a likely phone number.
function hasLongDigitRun(norm) {
  const digitized = norm.replace(
    /\b(zero|one|two|three|four|five|six|seven|eight|nine|oh)\b/g,
    (w) => WORD_TO_DIGIT[w]
  );
  const joined = digitized.replace(/(\d)[\s.\-()]+(?=\d)/g, '$1');
  return /\d{7,}/.test(joined);
}

// Dense street address on the separator-stripped view: number + name + type,
// e.g. "12kingstreet". Requires ≥2 letters of street name between the number
// and the type token to keep false positives ("top10road") low. Bare "st"/"rd"
// are deliberately excluded here (too many normal words end in them) — the
// spaced form is still covered by the pattern list above. No trailing boundary,
// so "12kingstreetkingston" (separators stripped) still matches.
const STREET_DENSE_RE =
  /\d{1,5}[a-z]{2,}(street|avenue|road|lane|drive|crescent|close|boulevard|blvd|terrace|court|highway|parkway|gardens|heights)/;

function hasDenseAddress(stripped) {
  return STREET_DENSE_RE.test(stripped);
}

/**
 * @param {string} text
 * @returns {{ blocked: boolean, label: string|null }}
 */
function detectPII(text) {
  if (!text || typeof text !== 'string') return { blocked: false, label: null };

  const norm = normalize(text);
  const deSpaced = deSpace(norm);
  const stripped = strip(norm);
  const views = [text, norm, deSpaced];

  // Layer 1 — every pattern across raw + normalized + de-spaced views.
  for (const p of PII_PATTERNS) {
    for (const v of views) {
      if (p.re.test(v)) return { blocked: true, label: p.label };
    }
  }

  // Layer 2 — heuristics.
  if (hasLongDigitRun(norm)) return { blocked: true, label: 'phone number' };
  if (hasDenseAddress(stripped)) return { blocked: true, label: 'street address' };

  return { blocked: false, label: null };
}

module.exports = { detectPII, PII_PATTERNS };
