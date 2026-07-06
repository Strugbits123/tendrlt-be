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

/**
 * @param {string} text
 * @returns {{ blocked: boolean, label: string|null }}
 */
function detectPII(text) {
  if (!text || typeof text !== 'string') return { blocked: false, label: null };
  for (const p of PII_PATTERNS) {
    if (p.re.test(text)) return { blocked: true, label: p.label };
  }
  return { blocked: false, label: null };
}

module.exports = { detectPII, PII_PATTERNS };
