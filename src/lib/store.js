const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const STORE_PATH = path.join(process.cwd(), 'data', 'store.json');

function slugify(value, fallback = 'event') {
  const normalized = String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .trim()
    .replace(/[\s_-]+/g, '-')
    .replace(/^-+|-+$/g, '');

  return normalized || fallback;
}

function defaultEvent() {
  return {
    id: 'evt_musterveranstaltung_2026',
    slug: slugify(process.env.EVENT_SLUG || 'musterveranstaltung-2026', 'musterveranstaltung-2026'),
    name: process.env.EVENT_NAME || 'Musterveranstaltung 2026',
    date: process.env.EVENT_DATE || '2026-05-15',
    contactEmail: process.env.CONTACT_EMAIL || 'orga@example.com',
    download: {
      allowZip: true,
      maxResolution: 'original',
      watermark: false,
    },
  };
}

function normalizeDownloadSettings(download = {}) {
  const allowZip = download.allowZip === undefined
    ? true
    : download.allowZip === true || download.allowZip === 'true' || download.allowZip === 'yes' || download.allowZip === 1;
  const watermark = download.watermark === true || download.watermark === 'true' || download.watermark === 'yes' || download.watermark === 1;
  const maxResolution = ['original', 'large', 'medium'].includes(String(download.maxResolution || 'original'))
    ? String(download.maxResolution || 'original')
    : 'original';

  return {
    allowZip,
    maxResolution,
    watermark,
  };
}

function normalizeEvent(event = {}) {
  const fallback = defaultEvent();

  return {
    ...fallback,
    ...event,
    id: String(event.id || fallback.id).trim() || fallback.id,
    slug: slugify(event.slug || fallback.slug, fallback.slug),
    name: String(event.name || fallback.name).trim() || fallback.name,
    date: String(event.date || fallback.date).trim() || fallback.date,
    contactEmail: String(event.contactEmail || fallback.contactEmail).trim() || fallback.contactEmail,
    download: normalizeDownloadSettings({
      ...fallback.download,
      ...(event.download || {}),
    }),
  };
}

function defaultStore() {
  return {
    events: [defaultEvent()],
    participants: [],
    photos: [],
    batches: [],
  };
}

function loadStore() {
  if (!fs.existsSync(STORE_PATH)) {
    return defaultStore();
  }

  const raw = fs.readFileSync(STORE_PATH, 'utf8');
  return JSON.parse(raw);
}

function saveStore(store) {
  const nextStore = {
    events: Array.isArray(store?.events) && store.events.length ? store.events.map(normalizeEvent) : [defaultEvent()],
    participants: Array.isArray(store?.participants) ? store.participants : [],
    photos: Array.isArray(store?.photos) ? store.photos : [],
    batches: Array.isArray(store?.batches) ? store.batches : [],
  };

  fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
  fs.writeFileSync(STORE_PATH, JSON.stringify(nextStore, null, 2));
  return nextStore;
}

function ensureStore() {
  fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });

  if (!fs.existsSync(STORE_PATH)) {
    saveStore(defaultStore());
    return;
  }

  saveStore(loadStore());
}

function listEvents() {
  return (loadStore().events || []).map(normalizeEvent);
}

function getPrimaryEvent() {
  return listEvents()[0] || defaultEvent();
}

function getEventByIdOrSlug(value) {
  return listEvents().find((event) => event.id === value || event.slug === value) || null;
}

function updateEventById(eventId, changes = {}) {
  const store = loadStore();
  const event = store.events.find((entry) => entry.id === eventId);

  if (!event) {
    return null;
  }

  const nextDownload = normalizeDownloadSettings({
    ...(event.download || {}),
    ...(changes.download || {}),
  });

  Object.assign(event, changes, {
    slug: slugify(changes.slug || event.slug, event.slug || getPrimaryEvent().slug),
    name: String(changes.name || event.name || '').trim() || getPrimaryEvent().name,
    date: String(changes.date || event.date || '').trim() || getPrimaryEvent().date,
    contactEmail: String(changes.contactEmail || event.contactEmail || '').trim() || getPrimaryEvent().contactEmail,
    download: nextDownload,
    updatedAt: new Date().toISOString(),
  });

  saveStore(store);
  return normalizeEvent(event);
}

function listParticipantsForEvent(eventId) {
  return loadStore()
    .participants
    .filter((participant) => participant.eventId === eventId)
    .sort((left, right) => `${left.lastname} ${left.firstname}`.localeCompare(`${right.lastname} ${right.firstname}`, 'de'));
}

function getParticipantById(participantId) {
  return loadStore().participants.find((participant) => participant.id === participantId) || null;
}

function getParticipantByToken(eventId, token) {
  const trimmed = String(token || '').trim();
  return loadStore().participants.find(
    (participant) => participant.eventId === eventId && (participant.token === trimmed || participant.id === trimmed)
  ) || null;
}

function createOrFindParticipant({ eventId, firstname, lastname, email = '' }) {
  const store = loadStore();
  const normalizedFirst = String(firstname || '').trim();
  const normalizedLast = String(lastname || '').trim();
  const normalizedEmail = String(email || '').trim().toLowerCase();

  const existing = store.participants.find(
    (participant) =>
      participant.eventId === eventId
      && participant.firstname.trim().toLowerCase() === normalizedFirst.toLowerCase()
      && participant.lastname.trim().toLowerCase() === normalizedLast.toLowerCase()
  );

  if (existing) {
    if (normalizedEmail && existing.email !== normalizedEmail) {
      existing.email = normalizedEmail;
      existing.updatedAt = new Date().toISOString();
      saveStore(store);
    }

    return { participant: existing, created: false };
  }

  const participant = {
    id: uuidv4(),
    eventId,
    firstname: normalizedFirst,
    lastname: normalizedLast,
    email: normalizedEmail,
    token: uuidv4(),
    createdAt: new Date().toISOString(),
  };

  store.participants.push(participant);
  saveStore(store);
  return { participant, created: true };
}

function updateParticipantById(participantId, changes) {
  const store = loadStore();
  const participant = store.participants.find((entry) => entry.id === participantId);

  if (!participant) {
    return null;
  }

  const nextChanges = { ...changes };

  if (Object.prototype.hasOwnProperty.call(nextChanges, 'firstname')) {
    nextChanges.firstname = String(nextChanges.firstname || '').trim();
  }

  if (Object.prototype.hasOwnProperty.call(nextChanges, 'lastname')) {
    nextChanges.lastname = String(nextChanges.lastname || '').trim();
  }

  if (Object.prototype.hasOwnProperty.call(nextChanges, 'email')) {
    nextChanges.email = String(nextChanges.email || '').trim().toLowerCase();
  }

  Object.assign(participant, nextChanges, { updatedAt: new Date().toISOString() });
  saveStore(store);
  return participant;
}

function listBatchesForEvent(eventId) {
  return loadStore()
    .batches
    .filter((batch) => batch.eventId === eventId)
    .sort((left, right) => new Date(right.createdAt) - new Date(left.createdAt));
}

function getBatchById(batchId) {
  return loadStore().batches.find((batch) => batch.id === batchId) || null;
}

function createBatch({ eventId, totalImages }) {
  const store = loadStore();
  const batch = {
    id: uuidv4(),
    eventId,
    status: 'pending',
    totalImages,
    processedImages: 0,
    createdAt: new Date().toISOString(),
  };

  store.batches.push(batch);
  saveStore(store);
  return batch;
}

function updateBatch(batchId, changes) {
  const store = loadStore();
  const batch = store.batches.find((entry) => entry.id === batchId);

  if (!batch) {
    return null;
  }

  Object.assign(batch, changes, { updatedAt: new Date().toISOString() });
  saveStore(store);
  return batch;
}

function addPhotoRecord(record) {
  const store = loadStore();
  const photo = {
    id: uuidv4(),
    createdAt: new Date().toISOString(),
    ...record,
  };

  store.photos.push(photo);
  saveStore(store);
  return photo;
}

function updatePhotoRecord(photoId, changes) {
  const store = loadStore();
  const photo = store.photos.find((entry) => entry.id === photoId);

  if (!photo) {
    return null;
  }

  Object.assign(photo, changes, { updatedAt: new Date().toISOString() });
  saveStore(store);
  return photo;
}

function deletePhotoById(photoId) {
  const store = loadStore();
  const index = store.photos.findIndex((photo) => photo.id === photoId);

  if (index === -1) {
    return null;
  }

  const [removedPhoto] = store.photos.splice(index, 1);
  saveStore(store);
  return removedPhoto;
}

function listPhotosForEvent(eventId) {
  return loadStore()
    .photos
    .filter((photo) => photo.eventId === eventId)
    .sort((left, right) => (left.sortOrder || 0) - (right.sortOrder || 0));
}

function getPhotoById(photoId) {
  return loadStore().photos.find((photo) => photo.id === photoId) || null;
}

function getPhotosForBatch(batchId) {
  return loadStore()
    .photos
    .filter((photo) => photo.batchId === batchId)
    .sort((left, right) => (left.sortOrder || 0) - (right.sortOrder || 0));
}

function getVisiblePhotosForParticipant(eventId, participantId) {
  const store = loadStore();
  const releasedBatchIds = new Set(
    store.batches
      .filter((batch) => batch.eventId === eventId && batch.status === 'done')
      .map((batch) => batch.id)
  );

  return store.photos
    .filter(
      (photo) => photo.eventId === eventId
        && photo.participantId === participantId
        && !photo.isBadge
        && releasedBatchIds.has(photo.batchId)
    )
    .sort((left, right) => (left.sortOrder || 0) - (right.sortOrder || 0));
}

function clearEventPhotos(eventId) {
  const store = loadStore();
  const removedPhotos = store.photos.filter((photo) => photo.eventId === eventId);
  const removedBatches = store.batches.filter((batch) => batch.eventId === eventId);

  store.photos = store.photos.filter((photo) => photo.eventId !== eventId);
  store.batches = store.batches.filter((batch) => batch.eventId !== eventId);
  saveStore(store);

  return {
    removedPhotos,
    removedBatches,
  };
}

function getDashboardStats(eventId) {
  const participants = listParticipantsForEvent(eventId);
  const batches = listBatchesForEvent(eventId);
  const photos = listPhotosForEvent(eventId);

  return {
    participants: participants.length,
    batches: batches.length,
    pendingBatches: batches.filter((batch) => batch.status !== 'done').length,
    photos: photos.filter((photo) => !photo.isBadge).length,
    unreleasedPhotos: photos.filter((photo) => !photo.isBadge && batches.some((batch) => batch.id === photo.batchId && batch.status !== 'done')).length,
  };
}

module.exports = {
  ensureStore,
  getPrimaryEvent,
  listEvents,
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
};
