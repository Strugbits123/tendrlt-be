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

/**
 * Notify a provider that a new tender matching their parish & service was posted.
 *
 * @param {string} providerEmail
 * @param {{ providerName: string, serviceType: string, parish: string, tenderId: string }} opts
 */
const sendNewTenderEmail = async (providerEmail, { providerName, serviceType, parish, tenderId }) => {
  const tenderUrl = `${FRONTEND_URL}/tender/${tenderId}`;

  await resend.emails.send({
    from: `TendrIt <${process.env.RESEND_FROM_EMAIL}>`,
    to: providerEmail,
    subject: `New ${escapeHtml(serviceType)} job in ${escapeHtml(parish)} — TendrIt`,
    html: shell(
      `New job in your area! 🏡`,
      `
        <p style="margin:0 0 16px;font-size:15px;color:rgba(15,26,14,0.55);line-height:1.7;">
          Hi ${escapeHtml(providerName)}, a homeowner just posted a new
          <strong style="color:#0f1a0e;">${escapeHtml(serviceType)}</strong> tender
          in <strong style="color:#0f1a0e;">${escapeHtml(parish)}</strong>.
        </p>
        <div style="margin:0 0 24px;padding:16px;background:#f1f6f1;border-radius:12px;font-size:14px;color:rgba(15,26,14,0.7);line-height:1.6;">
          Be one of the first providers to submit a quote and win the job!
        </div>
        ${ctaButton(tenderUrl, 'View Tender & Quote')}
        <p style="margin:24px 0 0;font-size:13px;color:rgba(15,26,14,0.35);line-height:1.6;">
          You're receiving this because you serve the <strong>${escapeHtml(parish)}</strong> area
          and offer <strong>${escapeHtml(serviceType)}</strong> services on TendrIt.
        </p>
      `
    ),
  });
};

/**
 * Notify a homeowner that an administrator removed their tender.
 *
 * @param {string} clientEmail
 * @param {{ clientName: string, tenderTitle: string, tenderCode: string, reason?: string|null }} opts
 */
const sendTenderRemovedEmail = async (clientEmail, { clientName, tenderTitle, tenderCode, reason }) => {
  const url = `${FRONTEND_URL}/my-tenders`;

  const { error } = await resend.emails.send({
    from: `TendrIt <${process.env.RESEND_FROM_EMAIL}>`,
    to: clientEmail,
    subject: `Your tender ${escapeHtml(tenderCode)} was removed — TendrIt`,
    html: shell(
      `Your tender was removed`,
      `
        <p style="margin:0 0 16px;font-size:15px;color:rgba(15,26,14,0.55);line-height:1.7;">
          Hi ${escapeHtml(clientName || 'there')}, an administrator has removed your
          <strong style="color:#0f1a0e;">${escapeHtml(tenderTitle)}</strong> tender
          (<strong style="color:#0f1a0e;">${escapeHtml(tenderCode)}</strong>) from TendrIt.
          It is no longer visible to providers.
        </p>
        ${reason ? `
        <div style="margin:0 0 24px;padding:16px;background:#fdecec;border:1px solid #f5c2c2;border-radius:12px;font-size:14px;color:#9b2c2c;line-height:1.6;">
          <strong>Reason:</strong> ${escapeHtml(reason)}
        </div>` : `
        <div style="margin:0 0 24px;padding:16px;background:#f1f6f1;border-radius:12px;font-size:14px;color:rgba(15,26,14,0.7);line-height:1.6;">
          If you believe this was a mistake, please contact support.
        </div>`}
        ${ctaButton(url, 'View My Tenders')}
        <p style="margin:24px 0 0;font-size:13px;color:rgba(15,26,14,0.35);line-height:1.6;">
          You're receiving this because you posted this tender on TendrIt.
        </p>
      `
    ),
  });

  // Resend returns { data, error } and does NOT throw — surface failures.
  if (error) throw new Error(error.message || 'Resend send failed');
};

module.exports = { sendNewTenderEmail, sendTenderRemovedEmail };
