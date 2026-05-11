require('dotenv').config();

const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const session = require('express-session');
const multer = require('multer');
const rateLimit = require('express-rate-limit');
const archiver = require('archiver');
const QRCode = require('qrcode');

const {
  ensureStore,
  getPrimaryEvent,
  getEventByIdOrSlug,
  updateEventById,
  listParticipantsForEvent,
  getParticipantById,
  getParticipantByToken,
  createOrFindParticipant,
  updateParticipantById,
  listBatchesForEvent,
  getBatchById,
  createBatch,
  updateBatch,
  addPhotoRecord,
  updatePhotoRecord,
  deletePhotoById,
  listPhotosForEvent,
  getPhotoById,
  getPhotosForBatch,
  getVisiblePhotosForParticipant,
  clearEventPhotos,
  getDashboardStats,
} = require('./lib/store');
const {
  ensureDirectories,
  persistUpload,
  createThumbnail,
  decodeQrValue,
  publicAssetPath,
} = require('./lib/image-tools');
const {
  sendParticipantAccessEmail,
} = require('./lib/mailer');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'eventphotos123';

function readPositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value || ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const MAX_UPLOAD_FILE_SIZE_MB = readPositiveInt(process.env.MAX_UPLOAD_FILE_SIZE_MB, 100);
const MAX_LOOKUP_FILE_SIZE_MB = readPositiveInt(process.env.MAX_LOOKUP_FILE_SIZE_MB, 25);
const MAX_UPLOAD_FILES = readPositiveInt(process.env.MAX_UPLOAD_FILES, 2000);

ensureStore();
ensureDirectories();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.json({ limit: '10mb' }));
app.use(
  session({
    secret: process.env.SESSION_SECRET || 'event-photos-dev-secret',
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: false,
    },
  })
);
app.use('/assets', express.static(path.join(process.cwd(), 'storage')));
app.use(express.static(path.join(process.cwd(), 'public')));

function isSupportedImageFile(file) {
  const extension = path.extname(file.originalname || '').toLowerCase();
  const allowedExtensions = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.tif', '.tiff', '.heic', '.heif']);
  return String(file.mimetype || '').startsWith('image/') || allowedExtensions.has(extension);
}

function imageFileFilter(req, file, callback) {
  if (!isSupportedImageFile(file)) {
    req.skippedFiles = [...(req.skippedFiles || []), file.originalname || 'unbekannt'];
    callback(null, false);
    return;
  }

  callback(null, true);
}

const upload = multer({
  dest: path.join(process.cwd(), 'tmp'),
  fileFilter: imageFileFilter,
  limits: {
    fileSize: MAX_UPLOAD_FILE_SIZE_MB * 1024 * 1024,
    files: MAX_UPLOAD_FILES,
  },
});

const lookupUpload = multer({
  dest: path.join(process.cwd(), 'tmp'),
  fileFilter: imageFileFilter,
  limits: {
    fileSize: MAX_LOOKUP_FILE_SIZE_MB * 1024 * 1024,
    files: 1,
  },
});

const lookupLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 50,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: 'Zu viele Anfragen. Bitte später erneut versuchen.',
});

function wantsJson(req) {
  const accept = req.get('accept') || '';
  return accept.includes('application/json') || req.is('application/json');
}

function redirectWithNotice(res, targetUrl, params = {}) {
  const query = new URLSearchParams(params);
  const separator = targetUrl.includes('?') ? '&' : '?';
  res.redirect(query.toString() ? `${targetUrl}${separator}${query.toString()}` : targetUrl);
}

function requireAdmin(req, res, next) {
  if (req.session.isAdmin) {
    next();
    return;
  }

  redirectWithNotice(res, '/admin', { error: 'Bitte zuerst anmelden.' });
}

function attachEvent(paramName) {
  return (req, res, next) => {
    const event = getEventByIdOrSlug(req.params[paramName]);

    if (!event) {
      res.status(404).send('Event nicht gefunden.');
      return;
    }

    req.event = event;
    next();
  };
}

function parseQrPayload(value) {
  const raw = String(value || '').trim();

  if (!raw) {
    return null;
  }

  try {
    const maybeUrl = raw.startsWith('http://') || raw.startsWith('https://')
      ? new URL(raw)
      : (raw.startsWith('/') ? new URL(raw, 'http://local-placeholder') : null);

    if (maybeUrl) {
      const tokenFromUrl = maybeUrl.searchParams.get('token');
      const participantIdFromUrl = maybeUrl.searchParams.get('participantId');

      if (tokenFromUrl || participantIdFromUrl) {
        return {
          token: tokenFromUrl || null,
          participantId: participantIdFromUrl || null,
          url: raw,
        };
      }
    }
  } catch (error) {
    // ignore URL parse issues and continue with JSON/plain token parsing
  }

  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null) {
      return parsed;
    }
  } catch (error) {
    return { token: raw };
  }

  return { token: raw };
}

function isLocalHostname(hostname) {
  const normalized = String(hostname || '').toLowerCase();
  return ['localhost', '127.0.0.1', '::1', '0.0.0.0'].includes(normalized);
}

function getLocalNetworkIp() {
  const interfaces = os.networkInterfaces();

  for (const preferredName of ['en0', 'en1', 'eth0', 'wlan0']) {
    const entries = interfaces[preferredName] || [];
    const match = entries.find((entry) => entry && entry.family === 'IPv4' && !entry.internal);
    if (match) {
      return match.address;
    }
  }

  for (const entries of Object.values(interfaces)) {
    const match = (entries || []).find((entry) => entry && entry.family === 'IPv4' && !entry.internal);
    if (match) {
      return match.address;
    }
  }

  return null;
}

function getBaseUrl(req) {
  const configuredBaseUrl = String(process.env.BASE_URL || '').trim().replace(/\/$/, '');

  if (configuredBaseUrl) {
    try {
      const parsed = new URL(configuredBaseUrl);
      if (!isLocalHostname(parsed.hostname)) {
        return configuredBaseUrl;
      }
    } catch (error) {
      return configuredBaseUrl;
    }
  }

  const forwardedProto = String(req.get('x-forwarded-proto') || '').split(',')[0].trim();
  const protocol = forwardedProto || req.protocol || 'http';
  const forwardedHost = String(req.get('x-forwarded-host') || '').split(',')[0].trim();
  const requestHost = forwardedHost || req.get('host') || `localhost:${PORT}`;

  try {
    const requestUrl = new URL(`${protocol}://${requestHost}`);
    if (!isLocalHostname(requestUrl.hostname)) {
      return `${protocol}://${requestHost}`.replace(/\/$/, '');
    }
  } catch (error) {
    // fall through to LAN IP detection
  }

  const localNetworkIp = getLocalNetworkIp();
  if (localNetworkIp) {
    return `${protocol}://${localNetworkIp}:${PORT}`;
  }

  if (configuredBaseUrl) {
    return configuredBaseUrl;
  }

  return `${protocol}://${requestHost}`.replace(/\/$/, '');
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || '').trim());
}

function buildParticipantGalleryUrl(event, participant, baseUrl) {
  const galleryUrl = new URL(`/event/${event.slug}/gallery`, baseUrl || `http://localhost:${PORT}`);
  galleryUrl.searchParams.set('token', participant.token);
  return galleryUrl;
}

async function generateParticipantQrBuffer(event, participant, baseUrl) {
  const galleryUrl = buildParticipantGalleryUrl(event, participant, baseUrl);

  return QRCode.toBuffer(galleryUrl.toString(), {
    type: 'png',
    width: 420,
    margin: 2,
  });
}

async function generateParticipantQrDataUrl(event, participant, baseUrl) {
  const buffer = await generateParticipantQrBuffer(event, participant, baseUrl);
  return `data:image/png;base64,${buffer.toString('base64')}`;
}

function resolveParticipantFromPayload(eventId, value) {
  const payload = parseQrPayload(value);

  if (!payload) {
    return { payload: null, participant: null };
  }

  let participant = null;

  if (payload.participantId) {
    const candidate = getParticipantById(payload.participantId);
    if (candidate && candidate.eventId === eventId) {
      participant = candidate;
    }
  }

  if (!participant && payload.token) {
    participant = getParticipantByToken(eventId, payload.token);
  }

  return { payload, participant };
}


function photoToViewModel(photo) {
  return {
    ...photo,
    thumbnailUrl: publicAssetPath(photo.thumbnailPath || photo.filePath),
    fileUrl: publicAssetPath(photo.filePath),
  };
}

function buildReviewGroups(eventId, batchId) {
  const participants = listParticipantsForEvent(eventId);
  const photos = getPhotosForBatch(batchId).map(photoToViewModel);
  const groups = [];

  const unassigned = photos.filter((photo) => !photo.participantId);
  groups.push({
    key: 'unassigned',
    title: 'Nicht zugeordnet',
    participant: null,
    photos: unassigned,
  });

  for (const participant of participants) {
    const belonging = photos.filter((photo) => photo.participantId === participant.id);
    if (belonging.length > 0) {
      groups.push({
        key: participant.id,
        title: `${participant.firstname} ${participant.lastname}`,
        participant,
        photos: belonging,
      });
    }
  }

  return groups.filter((group) => group.photos.length > 0 || group.key === 'unassigned');
}

async function extractLookupToken(req) {
  const typedToken = String(req.body.token || '').trim();

  if (typedToken) {
    return typedToken;
  }

  if (!req.file) {
    return '';
  }

  const lookupPath = await persistUpload(req.file.path, req.file.originalname, 'lookups');
  return (await decodeQrValue(lookupPath)) || '';
}

async function removeFiles(filePaths) {
  const uniquePaths = [...new Set(filePaths.filter(Boolean))];

  await Promise.all(
    uniquePaths.map((filePath) => fs.promises.unlink(filePath).catch(() => {}))
  );
}

function safeAdminReturnTo(value, fallbackUrl) {
  const normalized = String(value || '').trim();
  return normalized.startsWith('/admin/') ? normalized : fallbackUrl;
}

function buildParticipantManagementRows(eventId) {
  const photos = listPhotosForEvent(eventId);
  const releasedBatchIds = new Set(
    listBatchesForEvent(eventId)
      .filter((batch) => batch.status === 'done')
      .map((batch) => batch.id)
  );

  return listParticipantsForEvent(eventId).map((participant) => ({
    ...participant,
    assignedPhotos: photos.filter((photo) => photo.participantId === participant.id && !photo.isBadge).length,
    releasedPhotos: photos.filter(
      (photo) => photo.participantId === participant.id
        && !photo.isBadge
        && releasedBatchIds.has(photo.batchId)
    ).length,
  }));
}

function buildPhotoAdminEntries(eventId) {
  const participants = listParticipantsForEvent(eventId);
  const batches = listBatchesForEvent(eventId);
  const participantById = new Map(participants.map((participant) => [participant.id, participant]));
  const batchById = new Map(batches.map((batch) => [batch.id, batch]));

  const photos = listPhotosForEvent(eventId)
    .map(photoToViewModel)
    .map((photo) => ({
      ...photo,
      participant: participantById.get(photo.participantId) || null,
      batch: batchById.get(photo.batchId) || null,
    }))
    .sort((left, right) => new Date(right.createdAt) - new Date(left.createdAt));

  return { photos, participants, batches };
}

function buildRecentPhotos(eventId, limit = 8) {
  return listPhotosForEvent(eventId)
    .filter((photo) => !photo.isBadge)
    .sort((left, right) => new Date(right.createdAt) - new Date(left.createdAt))
    .slice(0, limit)
    .map(photoToViewModel);
}

function renderAdminPage(res, view, options) {
  res.render(view, {
    adminSection: 'dashboard',
    message: '',
    error: '',
    ...options,
  });
}

app.get('/health', (req, res) => {
  res.json({ ok: true, timestamp: new Date().toISOString() });
});

app.get(['/', '/event/:slug'], (req, res, next) => {
  if (req.params.slug) {
    attachEvent('slug')(req, res, next);
    return;
  }

  req.event = getPrimaryEvent();
  next();
}, (req, res) => {
  res.render('public-home', {
    pageTitle: `${req.event.name} – Teilnehmer`,
    event: req.event,
    message: req.query.message || '',
    error: req.query.error || '',
  });
});

app.post('/event/:slug/register', attachEvent('slug'), async (req, res) => {
  const firstname = String(req.body.firstname || '').trim();
  const lastname = String(req.body.lastname || '').trim();
  const email = String(req.body.email || '').trim().toLowerCase();
  const consent = req.body.consent === 'yes';

  if (!firstname || !lastname || !email || !consent) {
    redirectWithNotice(res, `/event/${req.event.slug}`, {
      error: 'Bitte Vorname, Nachname, E-Mail-Adresse und Einwilligung angeben.',
    });
    return;
  }

  if (!isValidEmail(email)) {
    redirectWithNotice(res, `/event/${req.event.slug}`, {
      error: 'Bitte eine gültige E-Mail-Adresse angeben.',
    });
    return;
  }

  const { participant } = createOrFindParticipant({
    eventId: req.event.id,
    firstname,
    lastname,
    email,
  });

  const baseUrl = getBaseUrl(req);
  const qrImageBuffer = await generateParticipantQrBuffer(req.event, participant, baseUrl);
  const galleryUrl = buildParticipantGalleryUrl(req.event, participant, baseUrl).toString();
  const noticeParams = {};

  try {
    const mailResult = await sendParticipantAccessEmail({
      event: req.event,
      participant,
      galleryUrl,
      qrImageBuffer,
    });

    if (mailResult.sent) {
      noticeParams.message = `QR-Code und Galerie-Link wurden an ${participant.email} gesendet.`;
    } else if (mailResult.reason === 'smtp-not-configured') {
      noticeParams.error = 'Registrierung erfolgreich, aber der Mailversand ist noch nicht eingerichtet. Bitte SMTP in der .env konfigurieren.';
    } else {
      noticeParams.error = 'Registrierung erfolgreich, aber die E-Mail konnte nicht versendet werden.';
    }
  } catch (error) {
    console.error('Zugangsmail konnte nicht versendet werden:', error);
    noticeParams.error = 'Registrierung erfolgreich, aber die E-Mail konnte gerade nicht versendet werden.';
  }

  redirectWithNotice(res, `/event/${req.event.slug}/register/${participant.id}`, noticeParams);
});

app.get('/event/:slug/register/:participantId', attachEvent('slug'), async (req, res) => {
  const participant = getParticipantById(req.params.participantId);

  if (!participant || participant.eventId !== req.event.id) {
    res.status(404).send('Teilnehmer nicht gefunden.');
    return;
  }

  const baseUrl = getBaseUrl(req);
  const qrImagePath = await generateParticipantQrDataUrl(req.event, participant, baseUrl);

  res.render('register-result', {
    pageTitle: `${participant.firstname} ${participant.lastname} – QR-Code`,
    event: req.event,
    participant,
    qrImagePath,
    galleryUrl: buildParticipantGalleryUrl(req.event, participant, baseUrl).toString(),
    message: req.query.message || '',
    error: req.query.error || '',
  });
});

app.get('/event/:slug/gallery', attachEvent('slug'), (req, res) => {
  const token = String(req.query.token || '').trim();

  if (!token) {
    redirectWithNotice(res, `/event/${req.event.slug}`, {
      error: 'Bitte zuerst einen QR-Code scannen oder einen Token eingeben.',
    });
    return;
  }

  const { participant } = resolveParticipantFromPayload(req.event.id, token);

  if (!participant) {
    redirectWithNotice(res, `/event/${req.event.slug}`, {
      error: 'Für diesen QR-Code wurde kein Teilnehmer gefunden.',
    });
    return;
  }

  const photos = getVisiblePhotosForParticipant(req.event.id, participant.id).map(photoToViewModel);

  res.render('public-gallery', {
    pageTitle: `${participant.firstname} ${participant.lastname} – Galerie`,
    event: req.event,
    participant,
    photos,
  });
});

app.post('/api/events/:id/register', attachEvent('id'), async (req, res) => {
  const firstname = String(req.body.firstname || '').trim();
  const lastname = String(req.body.lastname || '').trim();
  const email = String(req.body.email || '').trim().toLowerCase();

  if (!firstname || !lastname || !email) {
    res.status(400).json({ error: 'Vorname, Nachname und E-Mail sind erforderlich.' });
    return;
  }

  if (!isValidEmail(email)) {
    res.status(400).json({ error: 'Bitte eine gültige E-Mail-Adresse angeben.' });
    return;
  }

  const { participant } = createOrFindParticipant({
    eventId: req.event.id,
    firstname,
    lastname,
    email,
  });

  const baseUrl = getBaseUrl(req);
  const qrImageBuffer = await generateParticipantQrBuffer(req.event, participant, baseUrl);
  const qrImagePath = `data:image/png;base64,${qrImageBuffer.toString('base64')}`;
  const galleryUrl = buildParticipantGalleryUrl(req.event, participant, baseUrl).toString();

  let mailStatus;
  try {
    mailStatus = await sendParticipantAccessEmail({
      event: req.event,
      participant,
      galleryUrl,
      qrImageBuffer,
    });
  } catch (error) {
    console.error('Zugangsmail konnte nicht versendet werden:', error);
    mailStatus = { sent: false, error: 'mail-send-failed' };
  }

  res.json({ participant, qrImagePath, galleryUrl, mailStatus });
});

app.get('/admin/participants/:id/qr', requireAdmin, async (req, res) => {
  const participant = getParticipantById(req.params.id);

  if (!participant) {
    res.status(404).send('Teilnehmer nicht gefunden.');
    return;
  }

  const event = getEventByIdOrSlug(participant.eventId);
  if (!event) {
    res.status(404).send('Event nicht gefunden.');
    return;
  }

  const qrImageBuffer = await generateParticipantQrBuffer(event, participant, getBaseUrl(req));
  const fileName = `${participant.firstname}-${participant.lastname}-qr.png`;

  res.setHeader('Content-Type', 'image/png');
  res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
  res.send(qrImageBuffer);
});

app.post('/admin/participants/:id/send-access-email', requireAdmin, async (req, res) => {
  const participant = getParticipantById(req.params.id);

  if (!participant) {
    res.status(404).send('Teilnehmer nicht gefunden.');
    return;
  }

  const event = getEventByIdOrSlug(participant.eventId);
  if (!event) {
    res.status(404).send('Event nicht gefunden.');
    return;
  }

  const fallbackUrl = `/admin/events/${event.slug}/participants`;
  const returnTo = safeAdminReturnTo(req.body.returnTo, fallbackUrl);

  if (!participant.email || !isValidEmail(participant.email)) {
    redirectWithNotice(res, returnTo, {
      error: 'Für diesen Teilnehmer ist keine gültige E-Mail-Adresse hinterlegt.',
    });
    return;
  }

  const baseUrl = getBaseUrl(req);
  const qrImageBuffer = await generateParticipantQrBuffer(event, participant, baseUrl);

  try {
    const mailResult = await sendParticipantAccessEmail({
      event,
      participant,
      galleryUrl: buildParticipantGalleryUrl(event, participant, baseUrl).toString(),
      qrImageBuffer,
    });

    if (mailResult.sent) {
      redirectWithNotice(res, returnTo, {
        message: `Zugangsmail wurde an ${participant.email} gesendet.`,
      });
      return;
    }

    redirectWithNotice(res, returnTo, {
      error: 'Mailversand ist noch nicht eingerichtet. Bitte SMTP in der .env konfigurieren.',
    });
  } catch (error) {
    console.error('Zugangsmail konnte nicht versendet werden:', error);
    redirectWithNotice(res, returnTo, {
      error: 'Die Zugangsmail konnte nicht versendet werden.',
    });
  }
});

app.post('/api/events/:id/lookup', lookupLimiter, attachEvent('id'), lookupUpload.single('badgeImage'), async (req, res) => {
  const token = await extractLookupToken(req);

  if (!token) {
    if (wantsJson(req)) {
      res.status(400).json({ error: 'Es konnte kein QR-Code erkannt werden.' });
      return;
    }

    redirectWithNotice(res, `/event/${req.event.slug}`, {
      error: 'Es konnte kein QR-Code erkannt werden.',
    });
    return;
  }

  const { participant } = resolveParticipantFromPayload(req.event.id, token);

  if (!participant) {
    if (wantsJson(req)) {
      res.status(404).json({ error: 'Kein Teilnehmer zu diesem QR-Code gefunden.' });
      return;
    }

    redirectWithNotice(res, `/event/${req.event.slug}`, {
      error: 'Kein Teilnehmer zu diesem QR-Code gefunden.',
    });
    return;
  }

  const photos = getVisiblePhotosForParticipant(req.event.id, participant.id).map(photoToViewModel);

  if (wantsJson(req)) {
    res.json({ participant, photos });
    return;
  }

  res.redirect(`/event/${req.event.slug}/gallery?token=${encodeURIComponent(participant.token)}`);
});

app.get('/admin', (req, res) => {
  if (req.session.isAdmin) {
    res.redirect(`/admin/events/${getPrimaryEvent().slug}`);
    return;
  }

  res.render('admin-login', {
    pageTitle: 'Admin-Login',
    error: req.query.error || '',
  });
});

app.post('/admin/login', (req, res) => {
  if (String(req.body.password || '') === ADMIN_PASSWORD) {
    req.session.isAdmin = true;
    res.redirect(`/admin/events/${getPrimaryEvent().slug}`);
    return;
  }

  redirectWithNotice(res, '/admin', { error: 'Passwort ist ungültig.' });
});

app.post('/admin/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/admin');
  });
});

app.get('/admin/events/:slug', requireAdmin, attachEvent('slug'), (req, res) => {
  renderAdminPage(res, 'admin-dashboard', {
    pageTitle: `${req.event.name} – Dashboard`,
    event: req.event,
    adminSection: 'dashboard',
    stats: getDashboardStats(req.event.id),
    recentParticipants: buildParticipantManagementRows(req.event.id).slice(0, 6),
    recentBatches: listBatchesForEvent(req.event.id).slice(0, 6),
    recentPhotos: buildRecentPhotos(req.event.id, 8),
    message: req.query.message || '',
    error: req.query.error || '',
  });
});

app.get('/admin/events/:slug/participants', requireAdmin, attachEvent('slug'), (req, res) => {
  renderAdminPage(res, 'admin-participants', {
    pageTitle: `${req.event.name} – Teilnehmerverwaltung`,
    event: req.event,
    adminSection: 'participants',
    participants: buildParticipantManagementRows(req.event.id),
    message: req.query.message || '',
    error: req.query.error || '',
  });
});

app.post('/admin/events/:slug/participants', requireAdmin, attachEvent('slug'), async (req, res) => {
  const firstname = String(req.body.firstname || '').trim();
  const lastname = String(req.body.lastname || '').trim();
  const email = String(req.body.email || '').trim().toLowerCase();

  if (!firstname || !lastname || !email) {
    redirectWithNotice(res, `/admin/events/${req.event.slug}/participants`, {
      error: 'Vorname, Nachname und E-Mail-Adresse sind erforderlich.',
    });
    return;
  }

  if (!isValidEmail(email)) {
    redirectWithNotice(res, `/admin/events/${req.event.slug}/participants`, {
      error: 'Bitte eine gültige E-Mail-Adresse angeben.',
    });
    return;
  }

  const { participant, created } = createOrFindParticipant({
    eventId: req.event.id,
    firstname,
    lastname,
    email,
  });

  const baseUrl = getBaseUrl(req);
  const qrImageBuffer = await generateParticipantQrBuffer(req.event, participant, baseUrl);
  const galleryUrl = buildParticipantGalleryUrl(req.event, participant, baseUrl).toString();
  const noticeParams = {
    message: created ? 'Teilnehmer wurde angelegt.' : 'Teilnehmer war bereits vorhanden.',
  };

  try {
    const mailResult = await sendParticipantAccessEmail({
      event: req.event,
      participant,
      galleryUrl,
      qrImageBuffer,
    });

    if (mailResult.sent) {
      noticeParams.message = `${noticeParams.message} Zugangsmail wurde an ${participant.email} gesendet.`;
    } else if (mailResult.reason === 'smtp-not-configured') {
      noticeParams.error = 'Teilnehmer gespeichert, aber der Mailversand ist noch nicht eingerichtet. Bitte SMTP in der .env konfigurieren.';
    } else {
      noticeParams.error = 'Teilnehmer gespeichert, aber die Zugangsmail konnte nicht versendet werden.';
    }
  } catch (error) {
    console.error('Zugangsmail konnte nicht versendet werden:', error);
    noticeParams.error = 'Teilnehmer gespeichert, aber die Zugangsmail konnte nicht versendet werden.';
  }

  redirectWithNotice(res, `/admin/events/${req.event.slug}/participants`, noticeParams);
});

app.get('/admin/events/:slug/batches', requireAdmin, attachEvent('slug'), (req, res) => {
  renderAdminPage(res, 'admin-batches', {
    pageTitle: `${req.event.name} – Batches`,
    event: req.event,
    adminSection: 'batches',
    stats: getDashboardStats(req.event.id),
    batches: listBatchesForEvent(req.event.id),
    message: req.query.message || '',
    error: req.query.error || '',
  });
});

app.get('/admin/events/:slug/photos', requireAdmin, attachEvent('slug'), (req, res) => {
  const { photos, participants, batches } = buildPhotoAdminEntries(req.event.id);
  const filters = {
    participantId: String(req.query.participantId || '').trim(),
    batchId: String(req.query.batchId || '').trim(),
    type: String(req.query.type || 'all').trim(),
    search: String(req.query.search || '').trim(),
  };

  let filteredPhotos = [...photos];

  if (filters.participantId) {
    filteredPhotos = filteredPhotos.filter((photo) => photo.participantId === filters.participantId);
  }

  if (filters.batchId) {
    filteredPhotos = filteredPhotos.filter((photo) => photo.batchId === filters.batchId);
  }

  if (filters.type === 'photos') {
    filteredPhotos = filteredPhotos.filter((photo) => !photo.isBadge);
  } else if (filters.type === 'badges') {
    filteredPhotos = filteredPhotos.filter((photo) => photo.isBadge);
  }

  if (filters.search) {
    const searchNeedle = filters.search.toLowerCase();
    filteredPhotos = filteredPhotos.filter((photo) => {
      const participantName = photo.participant ? `${photo.participant.firstname} ${photo.participant.lastname}`.toLowerCase() : '';
      return String(photo.originalName || '').toLowerCase().includes(searchNeedle) || participantName.includes(searchNeedle);
    });
  }

  renderAdminPage(res, 'admin-photos', {
    pageTitle: `${req.event.name} – Bildübersicht`,
    event: req.event,
    adminSection: 'photos',
    photos: filteredPhotos,
    participants,
    batches,
    filters,
    totalPhotos: photos.length,
    returnTo: req.originalUrl,
    message: req.query.message || '',
    error: req.query.error || '',
  });
});

app.get('/admin/events/:slug/settings', requireAdmin, attachEvent('slug'), (req, res) => {
  renderAdminPage(res, 'admin-settings', {
    pageTitle: `${req.event.name} – Einstellungen`,
    event: req.event,
    adminSection: 'settings',
    message: req.query.message || '',
    error: req.query.error || '',
  });
});

app.post('/admin/events/:slug/settings', requireAdmin, attachEvent('slug'), (req, res) => {
  const updatedEvent = updateEventById(req.event.id, {
    name: String(req.body.name || '').trim(),
    slug: String(req.body.slug || '').trim(),
    date: String(req.body.date || '').trim(),
    contactEmail: String(req.body.contactEmail || '').trim(),
    download: {
      allowZip: req.body.allowZip === 'yes',
      maxResolution: String(req.body.maxResolution || 'original').trim(),
      watermark: req.body.watermark === 'yes',
    },
  });

  if (!updatedEvent) {
    res.status(404).send('Event nicht gefunden.');
    return;
  }

  redirectWithNotice(res, `/admin/events/${updatedEvent.slug}/settings`, {
    message: 'Einstellungen gespeichert.',
  });
});

app.get('/admin/events/:slug/danger', requireAdmin, attachEvent('slug'), (req, res) => {
  renderAdminPage(res, 'admin-danger', {
    pageTitle: `${req.event.name} – Gefahrenbereich`,
    event: req.event,
    adminSection: 'danger',
    stats: getDashboardStats(req.event.id),
    batches: listBatchesForEvent(req.event.id),
    photoCount: listPhotosForEvent(req.event.id).length,
    message: req.query.message || '',
    error: req.query.error || '',
  });
});

app.get(['/admin/events/:slug/review', '/admin/events/:slug/batches/review'], requireAdmin, attachEvent('slug'), (req, res) => {
  const batchId = String(req.query.batch || '').trim();
  const batch = getBatchById(batchId);

  if (!batch || batch.eventId !== req.event.id) {
    redirectWithNotice(res, `/admin/events/${req.event.slug}/batches`, {
      error: 'Batch wurde nicht gefunden.',
    });
    return;
  }

  renderAdminPage(res, 'admin-review', {
    pageTitle: `${req.event.name} – Review`,
    event: req.event,
    adminSection: 'batches',
    batch,
    groups: buildReviewGroups(req.event.id, batch.id),
    participants: listParticipantsForEvent(req.event.id),
    message: req.query.message || '',
    error: req.query.error || '',
  });
});

app.get('/api/events/:id/batches', requireAdmin, attachEvent('id'), (req, res) => {
  res.json({ batches: listBatchesForEvent(req.event.id) });
});

app.post('/api/events/:id/upload', requireAdmin, attachEvent('id'), upload.array('images', MAX_UPLOAD_FILES), async (req, res) => {
  const skippedFiles = Array.isArray(req.skippedFiles) ? req.skippedFiles : [];

  if (!req.files || req.files.length === 0) {
    redirectWithNotice(res, `/admin/events/${req.event.slug}/batches`, {
      error: skippedFiles.length
        ? 'Es wurden nur Nicht-Bilddateien erkannt. Bitte einen Ordner mit Bilddateien hochladen.'
        : 'Bitte mindestens ein Bild auswählen.',
    });
    return;
  }

  const orderedFiles = [...req.files]
    .filter((file) => isSupportedImageFile(file))
    .sort((left, right) => left.originalname.localeCompare(right.originalname, 'de', {
      numeric: true,
      sensitivity: 'base',
    }));

  console.log(`[UPLOAD] ${orderedFiles.length} Bilder zum Verarbeiten`);

  const batch = createBatch({
    eventId: req.event.id,
    totalImages: orderedFiles.length,
  });

  updateBatch(batch.id, { status: 'processing' });
  let currentParticipant = null;

  for (const [index, file] of orderedFiles.entries()) {
    console.log(`[UPLOAD] Verarbeite Bild ${index + 1}/${orderedFiles.length}: ${file.originalname}`);
    
    const filePath = await persistUpload(file.path, file.originalname, 'originals');
    const thumbnailPath = await createThumbnail(filePath).catch(() => filePath);
    const qrPayload = await decodeQrValue(filePath);
    
    console.log(`[UPLOAD] QR erkannt in ${file.originalname}: ${qrPayload || 'NEIN'}`);
    
    const { participant } = resolveParticipantFromPayload(req.event.id, qrPayload);

    let participantId = currentParticipant ? currentParticipant.id : null;
    let isBadge = false;
    let detectionConfidence = 0;

    if (participant) {
      currentParticipant = participant;
      participantId = participant.id;
      isBadge = true;
      detectionConfidence = 1;
    } else if (qrPayload) {
      currentParticipant = null;
      participantId = null;
      isBadge = true;
      detectionConfidence = 0.5;
    }

    addPhotoRecord({
      eventId: req.event.id,
      batchId: batch.id,
      participantId,
      filePath,
      thumbnailPath,
      sortOrder: index + 1,
      isBadge,
      uploadedAt: new Date().toISOString(),
      fileSize: file.size,
      originalName: file.originalname,
      qrPayload,
      detectionConfidence,
    });

    updateBatch(batch.id, {
      processedImages: index + 1,
    });
  }

  updateBatch(batch.id, {
    status: 'review',
    processedImages: orderedFiles.length,
  });

  const skippedInfo = skippedFiles.length
    ? ` ${skippedFiles.length} Nicht-Bilddatei(en) wurden automatisch ignoriert.`
    : '';

  console.log(`[UPLOAD] Batch ${batch.id} fertig. ${orderedFiles.length} Bilder verarbeitet.`);

  redirectWithNotice(res, `/admin/events/${req.event.slug}/batches/review`, {
    batch: batch.id,
    message: `Batch erfolgreich verarbeitet.${skippedInfo}`,
  });
});

app.get('/api/batches/:id/review', requireAdmin, (req, res) => {
  const batch = getBatchById(req.params.id);

  if (!batch) {
    res.status(404).json({ error: 'Batch nicht gefunden.' });
    return;
  }

  res.json({
    batch,
    groups: buildReviewGroups(batch.eventId, batch.id),
  });
});

function handlePhotoUpdate(req, res) {
  const existing = getPhotoById(req.params.id);

  if (!existing) {
    res.status(404).send('Foto nicht gefunden.');
    return;
  }

  const participantId = String(req.body.participantId || '').trim() || null;
  const isBadge = req.body.isBadge === 'yes' || req.body.isBadge === true || req.body.isBadge === 'true';
  const photo = updatePhotoRecord(existing.id, {
    participantId,
    isBadge,
  });

  if (wantsJson(req)) {
    res.json({ photo });
    return;
  }

  const event = getEventByIdOrSlug(photo.eventId);
  const fallbackUrl = req.body.batchId || photo.batchId
    ? `/admin/events/${event.slug}/batches/review?batch=${encodeURIComponent(req.body.batchId || photo.batchId)}`
    : `/admin/events/${event.slug}/photos`;

  redirectWithNotice(res, safeAdminReturnTo(req.body.returnTo, fallbackUrl), {
    message: 'Foto aktualisiert.',
  });
}

app.patch('/api/photos/:id', requireAdmin, handlePhotoUpdate);
app.post('/admin/photos/:id', requireAdmin, handlePhotoUpdate);

app.post('/admin/photos/:id/delete', requireAdmin, async (req, res) => {
  const photo = deletePhotoById(req.params.id);

  if (!photo) {
    res.status(404).send('Foto nicht gefunden.');
    return;
  }

  await removeFiles([photo.filePath, photo.thumbnailPath]);

  const remainingPhotos = getPhotosForBatch(photo.batchId);
  updateBatch(photo.batchId, {
    totalImages: remainingPhotos.length,
    processedImages: remainingPhotos.length,
  });

  const event = getEventByIdOrSlug(photo.eventId);
  const fallbackUrl = photo.batchId
    ? `/admin/events/${event.slug}/batches/review?batch=${encodeURIComponent(photo.batchId)}`
    : `/admin/events/${event.slug}/photos`;

  redirectWithNotice(res, safeAdminReturnTo(req.body.returnTo, fallbackUrl), {
    message: 'Foto wurde gelöscht.',
  });
});

function handleParticipantUpdate(req, res) {
  const existingParticipant = getParticipantById(req.params.id);

  if (!existingParticipant) {
    res.status(404).send('Teilnehmer nicht gefunden.');
    return;
  }

  const emailWasProvided = Object.prototype.hasOwnProperty.call(req.body, 'email');
  const nextEmail = emailWasProvided ? String(req.body.email || '').trim().toLowerCase() : undefined;

  if (emailWasProvided && nextEmail && !isValidEmail(nextEmail)) {
    if (wantsJson(req)) {
      res.status(400).json({ error: 'Bitte eine gültige E-Mail-Adresse angeben.' });
      return;
    }

    const event = getEventByIdOrSlug(existingParticipant.eventId);
    const fallbackUrl = req.body.batchId
      ? `/admin/events/${event.slug}/batches/review?batch=${encodeURIComponent(req.body.batchId)}`
      : `/admin/events/${event.slug}/participants`;

    redirectWithNotice(res, safeAdminReturnTo(req.body.returnTo, fallbackUrl), {
      error: 'Bitte eine gültige E-Mail-Adresse angeben.',
    });
    return;
  }

  const changes = {
    firstname: String(req.body.firstname || '').trim(),
    lastname: String(req.body.lastname || '').trim(),
  };

  if (emailWasProvided) {
    changes.email = nextEmail;
  }

  const participant = updateParticipantById(req.params.id, changes);

  if (wantsJson(req)) {
    res.json({ participant });
    return;
  }

  const event = getEventByIdOrSlug(participant.eventId);
  const fallbackUrl = req.body.batchId
    ? `/admin/events/${event.slug}/batches/review?batch=${encodeURIComponent(req.body.batchId)}`
    : `/admin/events/${event.slug}/participants`;

  redirectWithNotice(res, safeAdminReturnTo(req.body.returnTo, fallbackUrl), {
    message: emailWasProvided ? 'Teilnehmerdaten gespeichert.' : 'Teilnehmername gespeichert.',
  });
}

app.patch('/api/participants/:id', requireAdmin, handleParticipantUpdate);
app.post('/admin/participants/:id', requireAdmin, handleParticipantUpdate);

app.post('/api/batches/:id/confirm', requireAdmin, (req, res) => {
  const batch = updateBatch(req.params.id, {
    status: 'done',
    releasedAt: new Date().toISOString(),
  });

  if (!batch) {
    res.status(404).send('Batch nicht gefunden.');
    return;
  }

  const event = getEventByIdOrSlug(batch.eventId);

  if (wantsJson(req)) {
    res.json({ batch });
    return;
  }

  redirectWithNotice(res, `/admin/events/${event.slug}/batches`, {
    message: 'Batch freigegeben. Fotos sind jetzt sichtbar.',
  });
});

app.post('/admin/events/:slug/delete-photos', requireAdmin, attachEvent('slug'), async (req, res) => {
  const { removedPhotos, removedBatches } = clearEventPhotos(req.event.id);
  const lookupDirectory = path.join(process.cwd(), 'storage', 'lookups');
  const lookupFiles = await fs.promises.readdir(lookupDirectory).catch(() => []);

  const photoFiles = removedPhotos.flatMap((photo) => [photo.filePath, photo.thumbnailPath]);

  await removeFiles([
    ...photoFiles,
    ...lookupFiles.map((fileName) => path.join(lookupDirectory, fileName)),
  ]);

  const successMessage = `${removedPhotos.length} Bilddateien und ${removedBatches.length} Batches wurden gelöscht.`;

  if (wantsJson(req)) {
    res.json({
      ok: true,
      deletedImages: removedPhotos.length,
      deletedBatches: removedBatches.length,
    });
    return;
  }

  redirectWithNotice(res, `/admin/events/${req.event.slug}/danger`, {
    message: successMessage,
  });
});

app.get('/api/photos/:id/download', (req, res) => {
  const photo = getPhotoById(req.params.id);

  if (!photo) {
    res.status(404).send('Foto nicht gefunden.');
    return;
  }

  const batch = getBatchById(photo.batchId);
  if (!req.session.isAdmin && (!batch || batch.status !== 'done')) {
    res.status(403).send('Foto ist noch nicht freigegeben.');
    return;
  }

  if (!req.session.isAdmin) {
    const participant = getParticipantById(photo.participantId);
    const token = String(req.query.token || '').trim();

    if (!participant || participant.token !== token) {
      res.status(403).send('Ungültiger Download-Zugriff.');
      return;
    }
  }

  res.download(photo.filePath, photo.originalName);
});

app.get('/api/events/:id/download/:pid', attachEvent('id'), (req, res) => {
  const participant = getParticipantById(req.params.pid);

  if (!participant || participant.eventId !== req.event.id) {
    res.status(404).send('Teilnehmer nicht gefunden.');
    return;
  }

  if (!req.session.isAdmin && req.event.download && req.event.download.allowZip === false) {
    res.status(403).send('ZIP-Download ist für dieses Event deaktiviert.');
    return;
  }

  if (!req.session.isAdmin) {
    const token = String(req.query.token || '').trim();
    if (participant.token !== token) {
      res.status(403).send('Ungültiger ZIP-Zugriff.');
      return;
    }
  }

  const photos = getVisiblePhotosForParticipant(req.event.id, participant.id);
  if (!photos.length) {
    res.status(404).send('Keine freigegebenen Fotos vorhanden.');
    return;
  }

  res.attachment(`${participant.firstname}-${participant.lastname}.zip`);

  const archive = archiver('zip', { zlib: { level: 9 } });
  archive.on('error', (error) => {
    res.status(500).end(error.message);
  });
  archive.pipe(res);

  for (const photo of photos) {
    archive.file(photo.filePath, { name: photo.originalName });
  }

  archive.finalize();
});

app.use((error, req, res, next) => {
  if (!error) {
    next();
    return;
  }

  if (error instanceof multer.MulterError) {
    let message = 'Der Upload konnte nicht verarbeitet werden.';

    if (error.code === 'LIMIT_FILE_SIZE') {
      const maxSize = req.path.includes('/lookup') ? MAX_LOOKUP_FILE_SIZE_MB : MAX_UPLOAD_FILE_SIZE_MB;
      message = `Datei zu groß. Erlaubt sind maximal ${maxSize} MB pro Bild.`;
    } else if (error.code === 'LIMIT_FILE_COUNT') {
      message = `Zu viele Dateien. Pro Upload sind maximal ${MAX_UPLOAD_FILES} Bilder erlaubt.`;
    } else if (error.code === 'LIMIT_UNEXPECTED_FILE') {
      message = 'Unerwartete Datei im Upload. Bitte nur Bilddateien hochladen.';
    }

    if (wantsJson(req)) {
      res.status(400).json({ error: message });
      return;
    }

    const fallbackEvent = req.event || getPrimaryEvent();
    const targetUrl = req.path.includes('/admin') || req.path.includes('/upload')
      ? (req.path.includes('/settings')
        ? `/admin/events/${fallbackEvent.slug}/settings`
        : req.path.includes('/photos')
          ? `/admin/events/${fallbackEvent.slug}/photos`
          : req.path.includes('/participants')
            ? `/admin/events/${fallbackEvent.slug}/participants`
            : req.path.includes('/danger') || req.path.includes('/delete-photos')
              ? `/admin/events/${fallbackEvent.slug}/danger`
              : req.path.includes('/upload') || req.path.includes('/batches') || req.path.includes('/review')
                ? `/admin/events/${fallbackEvent.slug}/batches`
                : `/admin/events/${fallbackEvent.slug}`)
      : `/event/${fallbackEvent.slug}`;

    redirectWithNotice(res, targetUrl, { error: message });
    return;
  }

  if (error.statusCode) {
    if (wantsJson(req)) {
      res.status(error.statusCode).json({ error: error.message });
      return;
    }

    const fallbackEvent = req.event || getPrimaryEvent();
    const targetUrl = req.path.includes('/admin') || req.path.includes('/upload')
      ? (req.path.includes('/settings')
        ? `/admin/events/${fallbackEvent.slug}/settings`
        : req.path.includes('/photos')
          ? `/admin/events/${fallbackEvent.slug}/photos`
          : req.path.includes('/participants')
            ? `/admin/events/${fallbackEvent.slug}/participants`
            : req.path.includes('/danger') || req.path.includes('/delete-photos')
              ? `/admin/events/${fallbackEvent.slug}/danger`
              : req.path.includes('/upload') || req.path.includes('/batches') || req.path.includes('/review')
                ? `/admin/events/${fallbackEvent.slug}/batches`
                : `/admin/events/${fallbackEvent.slug}`)
      : `/event/${fallbackEvent.slug}`;

    redirectWithNotice(res, targetUrl, { error: error.message });
    return;
  }

  console.error(error);

  if (wantsJson(req)) {
    res.status(500).json({ error: 'Interner Serverfehler.' });
    return;
  }

  const fallbackEvent = req.event || getPrimaryEvent();
  const targetUrl = req.path.includes('/admin') || req.path.includes('/upload')
    ? (req.path.includes('/settings')
      ? `/admin/events/${fallbackEvent.slug}/settings`
      : req.path.includes('/photos')
        ? `/admin/events/${fallbackEvent.slug}/photos`
        : req.path.includes('/participants')
          ? `/admin/events/${fallbackEvent.slug}/participants`
          : req.path.includes('/danger') || req.path.includes('/delete-photos')
            ? `/admin/events/${fallbackEvent.slug}/danger`
            : req.path.includes('/upload') || req.path.includes('/batches') || req.path.includes('/review')
              ? `/admin/events/${fallbackEvent.slug}/batches`
              : `/admin/events/${fallbackEvent.slug}`)
    : `/event/${fallbackEvent.slug}`;

  redirectWithNotice(res, targetUrl, { error: 'Interner Serverfehler beim Upload.' });
});

app.use((req, res) => {
  const event = getPrimaryEvent();
  res.status(404).render('public-home', {
    pageTitle: `${event.name} – Teilnehmer`,
    event,
    message: '',
    error: 'Die angeforderte Seite wurde nicht gefunden.',
  });
});

app.listen(PORT, HOST, () => {
  console.log(`Event-Fotosystem läuft auf http://${HOST}:${PORT}`);
});
