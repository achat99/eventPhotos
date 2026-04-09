require('dotenv').config();

const fs = require('fs');
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
    const parsed = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null) {
      return parsed;
    }
  } catch (error) {
    return { token: raw };
  }

  return { token: raw };
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

async function ensureParticipantQrImage(event, participant) {
  const qrDirectory = path.join(process.cwd(), 'storage', 'qrcodes');
  fs.mkdirSync(qrDirectory, { recursive: true });

  const targetPath = path.join(qrDirectory, `${participant.id}.png`);
  const payload = JSON.stringify({
    eventId: event.id,
    participantId: participant.id,
    token: participant.token,
    name: `${participant.firstname} ${participant.lastname}`,
  });

  await QRCode.toFile(targetPath, payload, {
    width: 420,
    margin: 2,
  });

  return publicAssetPath(targetPath);
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
  const consent = req.body.consent === 'yes';

  if (!firstname || !lastname || !consent) {
    redirectWithNotice(res, `/event/${req.event.slug}`, {
      error: 'Bitte Vorname, Nachname und Einwilligung angeben.',
    });
    return;
  }

  const { participant } = createOrFindParticipant({
    eventId: req.event.id,
    firstname,
    lastname,
  });

  await ensureParticipantQrImage(req.event, participant);
  res.redirect(`/event/${req.event.slug}/register/${participant.id}`);
});

app.get('/event/:slug/register/:participantId', attachEvent('slug'), async (req, res) => {
  const participant = getParticipantById(req.params.participantId);

  if (!participant || participant.eventId !== req.event.id) {
    res.status(404).send('Teilnehmer nicht gefunden.');
    return;
  }

  const qrImagePath = await ensureParticipantQrImage(req.event, participant);

  res.render('register-result', {
    pageTitle: `${participant.firstname} ${participant.lastname} – QR-Code`,
    event: req.event,
    participant,
    qrImagePath,
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

  if (!firstname || !lastname) {
    res.status(400).json({ error: 'Vorname und Nachname sind erforderlich.' });
    return;
  }

  const { participant } = createOrFindParticipant({
    eventId: req.event.id,
    firstname,
    lastname,
  });

  const qrImagePath = await ensureParticipantQrImage(req.event, participant);
  res.json({ participant, qrImagePath });
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
  res.render('admin-dashboard', {
    pageTitle: `${req.event.name} – Admin`,
    event: req.event,
    stats: getDashboardStats(req.event.id),
    participants: listParticipantsForEvent(req.event.id),
    batches: listBatchesForEvent(req.event.id),
    message: req.query.message || '',
    error: req.query.error || '',
  });
});

app.get('/admin/events/:slug/review', requireAdmin, attachEvent('slug'), (req, res) => {
  const batchId = String(req.query.batch || '').trim();
  const batch = getBatchById(batchId);

  if (!batch || batch.eventId !== req.event.id) {
    redirectWithNotice(res, `/admin/events/${req.event.slug}`, {
      error: 'Batch wurde nicht gefunden.',
    });
    return;
  }

  res.render('admin-review', {
    pageTitle: `${req.event.name} – Review`,
    event: req.event,
    batch,
    groups: buildReviewGroups(req.event.id, batch.id),
    participants: listParticipantsForEvent(req.event.id),
    message: req.query.message || '',
  });
});

app.get('/api/events/:id/batches', requireAdmin, attachEvent('id'), (req, res) => {
  res.json({ batches: listBatchesForEvent(req.event.id) });
});

app.post('/api/events/:id/upload', requireAdmin, attachEvent('id'), upload.array('images', MAX_UPLOAD_FILES), async (req, res) => {
  const skippedFiles = Array.isArray(req.skippedFiles) ? req.skippedFiles : [];

  if (!req.files || req.files.length === 0) {
    redirectWithNotice(res, `/admin/events/${req.event.slug}`, {
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

  const batch = createBatch({
    eventId: req.event.id,
    totalImages: orderedFiles.length,
  });

  updateBatch(batch.id, { status: 'processing' });
  let currentParticipant = null;

  for (const [index, file] of orderedFiles.entries()) {
    const filePath = await persistUpload(file.path, file.originalname, 'originals');
    const thumbnailPath = await createThumbnail(filePath).catch(() => filePath);
    const qrPayload = await decodeQrValue(filePath);
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

  redirectWithNotice(res, `/admin/events/${req.event.slug}/review`, {
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
  redirectWithNotice(res, `/admin/events/${event.slug}/review`, {
    batch: req.body.batchId || photo.batchId,
    message: 'Foto aktualisiert.',
  });
}

app.patch('/api/photos/:id', requireAdmin, handlePhotoUpdate);
app.post('/admin/photos/:id', requireAdmin, handlePhotoUpdate);

function handleParticipantUpdate(req, res) {
  const participant = updateParticipantById(req.params.id, {
    firstname: String(req.body.firstname || '').trim(),
    lastname: String(req.body.lastname || '').trim(),
  });

  if (!participant) {
    res.status(404).send('Teilnehmer nicht gefunden.');
    return;
  }

  if (wantsJson(req)) {
    res.json({ participant });
    return;
  }

  const event = getEventByIdOrSlug(participant.eventId);
  redirectWithNotice(res, `/admin/events/${event.slug}/review`, {
    batch: req.body.batchId || '',
    message: 'Teilnehmername gespeichert.',
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

  redirectWithNotice(res, `/admin/events/${event.slug}`, {
    message: 'Batch freigegeben. Fotos sind jetzt sichtbar.',
  });
});

app.post('/admin/events/:slug/delete-photos', requireAdmin, attachEvent('slug'), async (req, res) => {
  const participants = listParticipantsForEvent(req.event.id);
  const { removedPhotos, removedBatches } = clearEventPhotos(req.event.id);
  const lookupDirectory = path.join(process.cwd(), 'storage', 'lookups');
  const lookupFiles = await fs.promises.readdir(lookupDirectory).catch(() => []);

  const photoFiles = removedPhotos.flatMap((photo) => [photo.filePath, photo.thumbnailPath]);
  const qrCodeFiles = participants.map((participant) => path.join(process.cwd(), 'storage', 'qrcodes', `${participant.id}.png`));

  await removeFiles([
    ...photoFiles,
    ...qrCodeFiles,
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

  redirectWithNotice(res, `/admin/events/${req.event.slug}`, {
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
      ? `/admin/events/${fallbackEvent.slug}`
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
      ? `/admin/events/${fallbackEvent.slug}`
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
    ? `/admin/events/${fallbackEvent.slug}`
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
