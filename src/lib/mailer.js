const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const nodemailer = require('nodemailer');

function toBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }

  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function cleanEnvString(value) {
  return String(value || '')
    .trim()
    .replace(/^['"]+/, '')
    .replace(/['"]+$/, '')
    .trim();
}

function reloadEnvFile() {
  dotenv.config({
    path: path.join(process.cwd(), '.env'),
    override: true,
    quiet: true,
  });
}

function getMailConfig() {
  reloadEnvFile();

  return {
    host: cleanEnvString(process.env.SMTP_HOST || ''),
    port: Number.parseInt(cleanEnvString(process.env.SMTP_PORT || '587'), 10) || 587,
    secure: toBoolean(cleanEnvString(process.env.SMTP_SECURE), false),
    user: cleanEnvString(process.env.SMTP_USER || ''),
    pass: cleanEnvString(process.env.SMTP_PASS || ''),
    from: cleanEnvString(process.env.SMTP_FROM || ''),
    allowInvalidCerts: toBoolean(cleanEnvString(process.env.SMTP_ALLOW_INVALID_CERTS), false),
    previewDir: path.join(process.cwd(), 'tmp', 'mail-previews'),
  };
}

function isMailConfigured(config = getMailConfig()) {
  return Boolean(config.host && config.from);
}

function createTransporter(config = getMailConfig()) {
  if (!isMailConfigured(config)) {
    return null;
  }

  return nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: config.user ? {
      user: config.user,
      pass: config.pass,
    } : undefined,
    tls: {
      rejectUnauthorized: !config.allowInvalidCerts,
    },
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 20000,
  });
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function savePreviewMail(message, config = getMailConfig()) {
  fs.mkdirSync(config.previewDir, { recursive: true });

  const previewPath = path.join(
    config.previewDir,
    `${new Date().toISOString().replace(/[:.]/g, '-')}-${Math.random().toString(36).slice(2, 8)}.eml`
  );

  fs.writeFileSync(previewPath, Buffer.isBuffer(message) ? message : Buffer.from(String(message || ''), 'utf8'));
  return previewPath;
}

async function sendParticipantAccessEmail({ event, participant, galleryUrl, qrImageBuffer }) {
  if (!participant || !String(participant.email || '').trim()) {
    return { sent: false, skipped: true, reason: 'missing-recipient' };
  }

  const config = getMailConfig();
  const recipient = String(participant.email || '').trim().toLowerCase();
  const participantName = `${participant.firstname || ''} ${participant.lastname || ''}`.trim();
  const safeEventName = escapeHtml(event?.name || 'Dein Event');
  const safeParticipantName = escapeHtml(participantName || 'Teilnehmer');
  const safeGalleryUrl = escapeHtml(galleryUrl);
  const subject = `${event?.name || 'Event'}: dein QR-Code und Bilder-Link`;
  const qrCid = `qr-${participant.id || Date.now()}@eventphotos`;

  const attachments = [];
  if (Buffer.isBuffer(qrImageBuffer) && qrImageBuffer.length) {
    attachments.push({
      filename: `${participantName || 'teilnehmer'}-qr.png`.replace(/\s+/g, '-'),
      content: qrImageBuffer,
      contentType: 'image/png',
      cid: qrCid,
    });
  }

  const message = {
    from: config.from || event?.contactEmail || 'noreply@example.com',
    to: recipient,
    subject,
    text: [
      `Hallo ${participantName || 'Teilnehmer'},`,
      '',
      `danke für deine Anmeldung zu ${event?.name || 'unserem Event'}.`,
      'Im Anhang findest du deinen persönlichen QR-Code.',
      '',
      'Dein persönlicher Bilder-Link:',
      galleryUrl,
      '',
      'Wenn du den QR-Code später mit der Handykamera scannst, öffnet sich deine Galerie direkt.',
      '',
      `Rückfragen: ${event?.contactEmail || ''}`,
    ].join('\n'),
    html: `
      <div style="margin:0;padding:24px;background:#f7f7f7;font-family:Arial,sans-serif;color:#363636;line-height:1.6;">
        <div style="max-width:680px;margin:0 auto;background:#ffffff;border:1px solid rgba(1,49,84,0.1);border-radius:18px;overflow:hidden;box-shadow:0 12px 28px rgba(1,49,84,0.08);">
          <div style="height:10px;background:linear-gradient(90deg,#ffde00 0 34%,#d7005f 34% 66%,#013154 66% 100%);"></div>
          <div style="padding:20px 24px;background:#ffffff;border-bottom:1px solid rgba(1,49,84,0.08);">
            <div style="font-size:12px;font-weight:800;letter-spacing:1.3px;text-transform:uppercase;color:#d7005f;">DLRG Jugend</div>
            <div style="font-size:28px;font-weight:700;color:#013154;line-height:1.15;">Dein Zugang zu den Event-Fotos</div>
          </div>
          <div style="padding:24px;">
            <p style="margin-top:0;">Hallo <strong>${safeParticipantName}</strong>,</p>
            <p>danke für deine Anmeldung zu <strong>${safeEventName}</strong>. Im Anhang findest du deinen persönlichen QR-Code. Über den Link unten gelangst du direkt zu deiner Galerie.</p>

            <div style="margin:18px 0;padding:16px 18px;background:#f7f7f7;border-left:4px solid #d7005f;border-radius:12px;">
              <div style="font-size:12px;font-weight:800;text-transform:uppercase;letter-spacing:1.2px;color:#013154;margin-bottom:8px;">Persönlicher Abruflink</div>
              <a href="${safeGalleryUrl}" style="color:#d7005f;text-decoration:none;font-weight:700;word-break:break-word;">${safeGalleryUrl}</a>
            </div>

            <p>Wenn du den QR-Code mit der Handykamera scannst, öffnet sich deine Galerie automatisch.</p>
            ${attachments.length ? `<div style="margin:18px 0 22px;"><img src="cid:${qrCid}" alt="QR-Code" style="max-width:220px;border:1px solid rgba(1,49,84,0.12);border-radius:12px;padding:8px;background:#ffffff;" /></div>` : ''}

            <div style="margin-top:20px;">
              <a href="${safeGalleryUrl}" style="display:inline-block;background:#013154;color:#ffffff;text-decoration:none;font-weight:800;padding:12px 18px;border-radius:999px;">Galerie öffnen</a>
            </div>

            <p style="margin-top:20px;margin-bottom:0;">Rückfragen: <a href="mailto:${escapeHtml(event?.contactEmail || '')}" style="color:#d7005f;font-weight:700;text-decoration:none;">${escapeHtml(event?.contactEmail || '')}</a></p>
          </div>
        </div>
      </div>
    `,
    attachments,
  };

  if (!isMailConfigured(config)) {
    const previewTransport = nodemailer.createTransport({
      streamTransport: true,
      buffer: true,
      newline: 'unix',
    });
    const preview = await previewTransport.sendMail(message);
    const previewPath = await savePreviewMail(preview.message, config);

    return {
      sent: false,
      skipped: true,
      reason: 'smtp-not-configured',
      previewPath,
    };
  }

  const transporter = createTransporter(config);
  const info = await transporter.sendMail(message);

  return {
    sent: true,
    messageId: info.messageId,
    accepted: info.accepted || [],
    rejected: info.rejected || [],
  };
}

module.exports = {
  getMailConfig,
  isMailConfigured,
  sendParticipantAccessEmail,
};
