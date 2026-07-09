const { Resend } = require('resend');

const resend = new Resend(process.env.RESEND_API_KEY);
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';

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

// SLA copy reused in both emails.
const SLA_HOURS = 72;

/**
 * Notify an admin that a homeowner raised a dispute (they review + resolve).
 */
const sendDisputeAdminEmail = async (adminEmail, { tenderTitle, tenderCode, homeownerName, providerName, description, imageUrl }) => {
  if (!adminEmail) return;
  const { error } = await resend.emails.send({
    from: `TendrIt Disputes <${process.env.RESEND_FROM_EMAIL}>`,
    to: adminEmail,
    subject: `⚠️ New dispute — ${escapeHtml(tenderTitle)}${tenderCode ? ` (${escapeHtml(tenderCode)})` : ''}`,
    html: shell(
      `A dispute needs review`,
      `
        <p style="margin:0 0 16px;font-size:15px;color:rgba(15,26,14,0.6);line-height:1.7;">
          <strong>${escapeHtml(homeownerName)}</strong> raised a dispute on the
          <strong>${escapeHtml(tenderTitle)}</strong> job awarded to
          <strong>${escapeHtml(providerName)}</strong>.
        </p>
        <div style="margin:0 0 20px;padding:16px;background:#fdf2f2;border-radius:12px;border:1px solid rgba(220,38,38,0.15);">
          <div style="font-size:12px;font-weight:700;color:#dc2626;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:6px;">What went wrong</div>
          <div style="font-size:14px;color:rgba(15,26,14,0.75);line-height:1.6;white-space:pre-wrap;">${escapeHtml(description)}</div>
        </div>
        ${imageUrl ? `<p style="margin:0 0 20px;font-size:14px;">📎 <a href="${imageUrl}" style="color:#3d6b45;font-weight:600;">View submitted photo</a></p>` : ''}
        <p style="margin:0 0 20px;font-size:14px;color:rgba(15,26,14,0.6);line-height:1.6;">
          SLA: resolve within <strong>${SLA_HOURS} hours</strong>. Contact the parties by phone/email as needed.
        </p>
        ${ctaButton(`${FRONTEND_URL}/admin`, 'Open Admin Console')}
      `
    ),
  });
  if (error) throw new Error(error.message || 'Resend send failed (dispute admin)');
};

/**
 * Tell the provider (from the TendrIt/admin side) that a dispute was raised on
 * their job — reassure, set the 72h SLA expectation, ask them to stay reachable.
 */
const sendDisputeProviderEmail = async (providerEmail, { providerName, tenderTitle }) => {
  if (!providerEmail) return;
  const { error } = await resend.emails.send({
    from: `TendrIt Support <${process.env.RESEND_FROM_EMAIL}>`,
    to: providerEmail,
    subject: `A dispute was raised on your job — ${escapeHtml(tenderTitle)}`,
    html: shell(
      `We're reviewing a dispute on your job`,
      `
        <p style="margin:0 0 16px;font-size:15px;color:rgba(15,26,14,0.6);line-height:1.7;">
          Hi ${escapeHtml(providerName)}, the homeowner on your
          <strong>${escapeHtml(tenderTitle)}</strong> job has raised a dispute and submitted it to us.
        </p>
        <div style="margin:0 0 20px;padding:16px;background:#f1f6f1;border-radius:12px;font-size:14px;color:rgba(15,26,14,0.7);line-height:1.65;">
          Our team is reviewing the dispute and will work to resolve it within a
          <strong>${SLA_HOURS}-hour (3-day)</strong> window. During this time a member of our
          team may reach out to you by <strong>phone call</strong> or <strong>email</strong> for more details —
          please stay reachable so we can resolve this quickly and fairly.
        </div>
        <p style="margin:0 0 20px;font-size:14px;color:rgba(15,26,14,0.6);line-height:1.6;">
          There's nothing you need to do right now. We'll be in touch if we need anything from you.
        </p>
        ${ctaButton(`${FRONTEND_URL}/my-quotes`, 'View Your Jobs')}
        <p style="margin:24px 0 0;font-size:13px;color:rgba(15,26,14,0.35);line-height:1.6;">
          — The TendrIt Team
        </p>
      `
    ),
  });
  if (error) throw new Error(error.message || 'Resend send failed (dispute provider)');
};

module.exports = { sendDisputeAdminEmail, sendDisputeProviderEmail };
