// Provider verification emails (approve / reject), sent via Resend.
// Mirrors the from-address, env vars and HTML style of the auth emails
// in routes/auth.js (sendVerificationEmail).
const { Resend } = require('resend');

const resend = new Resend(process.env.RESEND_API_KEY);
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';

// Shared chrome around the message body
const shell = (heading, bodyHtml) => `
  <!DOCTYPE html>
  <html>
    <body style="margin:0;padding:0;background:#f8f6f0;font-family:sans-serif;">
      <div style="max-width:520px;margin:40px auto;background:#ffffff;border-radius:16px;overflow:hidden;border:1px solid rgba(15,26,14,0.08);">
        <div style="background:#0f1a0e;padding:28px 36px;">
          <span style="font-size:22px;font-weight:900;color:#ffffff;letter-spacing:-0.02em;">
            Tendr<span style="color:#7db885;">It</span>
          </span>
        </div>
        <div style="padding:36px;">
          <h1 style="margin:0 0 12px;font-size:22px;font-weight:800;color:#0f1a0e;">${heading}</h1>
          ${bodyHtml}
        </div>
      </div>
    </body>
  </html>
`;

const ctaButton = (href, label) => `
  <a href="${href}"
    style="display:inline-block;background:#3d6b45;color:#ffffff;text-decoration:none;font-size:15px;font-weight:700;padding:14px 32px;border-radius:100px;">
    ${label}
  </a>
`;

const escapeHtml = (str = '') =>
  String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

/**
 * Provider approved — Verified badge is now live.
 */
const sendProviderApprovedEmail = async (email, firstName, note) => {
  const dashboardUrl = `${FRONTEND_URL}/provider-browse`;
  const noteBlock = note
    ? `<div style="margin:0 0 24px;padding:16px;background:#f1f6f1;border-radius:12px;font-size:14px;color:rgba(15,26,14,0.7);line-height:1.6;">
         ${escapeHtml(note)}
       </div>`
    : '';

  await resend.emails.send({
    from: `TendrIt <${process.env.RESEND_FROM_EMAIL}>`,
    to: email,
    subject: "You're verified on TendrIt ✓",
    html: shell(
      `Hi ${escapeHtml(firstName)}, you're verified! ✓`,
      `
        <p style="margin:0 0 24px;font-size:15px;color:rgba(15,26,14,0.55);line-height:1.7;">
          Great news — our team has reviewed your documents and approved your provider account.
          The <strong>Verified ✓</strong> badge now appears on your public profile, helping homeowners
          choose you with confidence.
        </p>
        ${noteBlock}
        ${ctaButton(dashboardUrl, 'Go to My Dashboard')}
        <p style="margin:24px 0 0;font-size:13px;color:rgba(15,26,14,0.35);line-height:1.6;">
          You can start quoting on jobs right away. Welcome to TendrIt!
        </p>
      `
    ),
  });
};

/**
 * Provider rejected — show the reason + optional detail.
 */
const sendProviderRejectedEmail = async (email, firstName, reason, notes) => {
  const supportEmail = process.env.RESEND_FROM_EMAIL || 'support@tendrit.com';
  const notesBlock = notes
    ? `<p style="margin:0 0 24px;font-size:14px;color:rgba(15,26,14,0.6);line-height:1.7;">
         ${escapeHtml(notes)}
       </p>`
    : '';

  const onboardingUrl = `${FRONTEND_URL}/provider-onboarding`;

  await resend.emails.send({
    from: `TendrIt <${process.env.RESEND_FROM_EMAIL}>`,
    to: email,
    subject: 'Action needed: update your TendrIt application',
    html: shell(
      `Hi ${escapeHtml(firstName)}, your application needs an update`,
      `
        <p style="margin:0 0 20px;font-size:15px;color:rgba(15,26,14,0.55);line-height:1.7;">
          Thanks for submitting your details. We weren't able to verify your provider account
          this time for the following reason:
        </p>
        <div style="margin:0 0 20px;padding:16px;background:#fdecea;border-left:4px solid #d9534f;border-radius:8px;font-size:14px;font-weight:600;color:#a8312b;line-height:1.6;">
          ${escapeHtml(reason)}
        </div>
        ${notesBlock}
        <p style="margin:0 0 24px;font-size:15px;color:rgba(15,26,14,0.55);line-height:1.7;">
          Good news — you can fix this yourself. Open your onboarding dashboard, update the
          details above, and resubmit. Our team will review your application again.
        </p>
        ${ctaButton(onboardingUrl, 'Fix & Resubmit My Application')}
        <p style="margin:24px 0 0;font-size:13px;color:rgba(15,26,14,0.4);line-height:1.6;">
          Need help? Reply to this email or contact us at
          <a href="mailto:${supportEmail}" style="color:#3d6b45;">${supportEmail}</a>.
        </p>
      `
    ),
  });
};

module.exports = { sendProviderApprovedEmail, sendProviderRejectedEmail };
