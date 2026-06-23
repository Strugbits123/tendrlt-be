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
 * Notify a homeowner that a provider has submitted a new quote.
 */
const sendNewQuoteEmail = async (homeownerEmail, { homeownerName, providerName, tenderTitle, amount }) => {
  const formattedAmount = '$' + Math.round(amount / 100).toLocaleString();
  const dashboardUrl = `${FRONTEND_URL}/my-tenders`;

  await resend.emails.send({
    from: `TendrIt <${process.env.RESEND_FROM_EMAIL}>`,
    to: homeownerEmail,
    subject: `New quote from ${escapeHtml(providerName)} — ${escapeHtml(tenderTitle)}`,
    html: shell(
      `You have a new quote! 🎉`,
      `
        <p style="margin:0 0 20px;font-size:15px;color:rgba(15,26,14,0.55);line-height:1.7;">
          Hi ${escapeHtml(homeownerName)}, <strong>${escapeHtml(providerName)}</strong> has submitted a quote of
          <strong style="color:#0f1a0e;">${escapeHtml(formattedAmount)}</strong> for your
          <strong>${escapeHtml(tenderTitle)}</strong> tender.
        </p>
        <div style="margin:0 0 24px;padding:16px;background:#f1f6f1;border-radius:12px;font-size:14px;color:rgba(15,26,14,0.7);line-height:1.6;">
          Log in to review the full quote, compare it with others, and accept or decline.
        </div>
        ${ctaButton(dashboardUrl, 'View My Quotes')}
        <p style="margin:24px 0 0;font-size:13px;color:rgba(15,26,14,0.35);line-height:1.6;">
          You can view all your quotes in the My Tenders section of your dashboard.
        </p>
      `
    ),
  });
};

module.exports = { sendNewQuoteEmail };
