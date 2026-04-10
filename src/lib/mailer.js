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
      <div style="font-family:Arial,sans-serif;line-height:1.6;color:#1f2937;max-width:640px">
        <h2 style="margin-bottom:8px;">Hallo ${safeParticipantName},</h2>
        <p>danke für deine Anmeldung zu <strong>${safeEventName}</strong>.</p>
        <p>Im Anhang findest du deinen persönlichen QR-Code. Zusätzlich kannst du deine Bilder später direkt über diesen Link abrufen:</p>
        <p><a href="${safeGalleryUrl}">${safeGalleryUrl}</a></p>
        <p>Wenn du den QR-Code mit der Handykamera scannst, öffnet sich deine Galerie automatisch.</p>
        ${attachments.length ? `<p><img src="cid:${qrCid}" alt="QR-Code" style="max-width:220px;border:1px solid #e5e7eb;border-radius:12px;padding:8px;background:#fff;" /></p>` : ''}
        <p>Rückfragen: <a href="mailto:${escapeHtml(event?.contactEmail || '')}">${escapeHtml(event?.contactEmail || '')}</a></p>
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
