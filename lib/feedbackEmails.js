const { Resend } = require('resend');

const resend = new Resend(process.env.RESEND_API_KEY);

const escapeHtml = (str = '') =>
  String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const CAT_LABEL = { feedback: 'Feedback', bug: 'Bug Report', idea: 'Idea / Feature', other: 'Other' };
const ROLE_LABEL = { client: 'Client', provider: 'Service Provider', visitor: 'Visitor', other: 'Other' };

const shell = (heading, bodyHtml) => `
  <!DOCTYPE html>
  <html>
    <body style="margin:0;padding:0;background:#f8f6f0;font-family:sans-serif;">
      <div style="max-width:560px;margin:40px auto;background:#ffffff;border-radius:16px;overflow:hidden;border:1px solid rgba(15,26,14,0.08);">
        <div style="background:#0f1a0e;padding:24px 32px;">
          <span style="font-size:20px;font-weight:900;color:#ffffff;letter-spacing:-0.02em;">
            Tendr<span style="color:#7db885;">It</span>
          </span>
          <span style="font-size:11px;color:rgba(255,255,255,0.45);text-transform:uppercase;letter-spacing:0.08em;margin-left:8px;">Admin</span>
        </div>
        <div style="padding:30px 32px;">
          <h1 style="margin:0 0 16px;font-size:19px;font-weight:800;color:#0f1a0e;">${heading}</h1>
          ${bodyHtml}
        </div>
      </div>
    </body>
  </html>
`;

const row = (label, value) => `
  <tr>
    <td style="padding:6px 0;font-size:12px;color:rgba(15,26,14,0.45);width:120px;vertical-align:top;">${escapeHtml(label)}</td>
    <td style="padding:6px 0;font-size:13.5px;color:#0f1a0e;font-weight:600;">${escapeHtml(value)}</td>
  </tr>
`;

/**
 * Notify all admins of a new feedback submission. Reply-To is the submitter,
 * so admins can reply directly from their mail client.
 *
 * @param {string[]} adminEmails
 * @param {{ id, cat, name, email, role, rating, follow_up, message }} sub
 */
const sendFeedbackNotification = async (adminEmails, sub) => {
  if (!adminEmails || adminEmails.length === 0) return;

  const catLabel = CAT_LABEL[sub.cat] || sub.cat;
  const roleLabel = ROLE_LABEL[sub.role] || (sub.role || '—');
  const ratingTxt = sub.rating ? `${sub.rating} / 5 ★` : '—';

  const { error } = await resend.emails.send({
    from: `TendrIt Feedback <${process.env.RESEND_FROM_EMAIL}>`,
    to: adminEmails,
    replyTo: sub.email,
    subject: `New ${catLabel}: ${sub.name || sub.email}`,
    html: shell(
      `New ${catLabel.toLowerCase()} submission`,
      `
        <p style="margin:0 0 18px;font-size:14px;color:rgba(15,26,14,0.55);line-height:1.6;">
          A new ${escapeHtml(catLabel)} submission came in through the TendrIt feedback form. <strong style="color:#0f1a0e;">Reply to this email</strong> to respond directly to the sender.
        </p>
        <table style="width:100%;border-collapse:collapse;margin-bottom:20px;">
          ${row('Type', catLabel)}
          ${row('From', sub.name || '—')}
          ${row('Email', sub.email)}
          ${row('Role', roleLabel)}
          ${sub.cat === 'feedback' ? row('Rating', ratingTxt) : ''}
          ${row('Follow-up OK', sub.follow_up ? 'Yes' : 'No')}
        </table>
        <div style="font-size:12px;color:rgba(15,26,14,0.45);text-transform:uppercase;letter-spacing:0.06em;margin-bottom:8px;">Message</div>
        <div style="background:#f1f6f1;border-radius:12px;padding:16px 18px;font-size:14px;color:#0f1a0e;line-height:1.7;white-space:pre-wrap;">${escapeHtml(sub.message)}</div>
        <p style="margin:20px 0 0;font-size:11.5px;color:rgba(15,26,14,0.35);line-height:1.6;">
          Reference: ${escapeHtml(sub.id || '—')} · You're receiving this because you are a TendrIt administrator.
        </p>
      `
    ),
  });

  if (error) throw new Error(`Resend feedback notification failed: ${error.message || JSON.stringify(error)}`);
};

module.exports = { sendFeedbackNotification };
