const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const QrCode = require('qrcode-reader');
const { Jimp } = require('jimp');
const { v4: uuidv4 } = require('uuid');

const STORAGE_ROOT = path.join(process.cwd(), 'storage');

function ensureDirectories() {
  const directories = [
    STORAGE_ROOT,
    path.join(STORAGE_ROOT, 'originals'),
    path.join(STORAGE_ROOT, 'thumbs'),
    path.join(STORAGE_ROOT, 'lookups'),
    path.join(STORAGE_ROOT, 'qrcodes'),
    path.join(process.cwd(), 'tmp'),
  ];

  for (const directory of directories) {
    fs.mkdirSync(directory, { recursive: true });
  }
}

function safeName(input) {
  return String(input || 'upload')
    .replace(/\s+/g, '-')
    .replace(/[^a-zA-Z0-9._-]/g, '')
    .toLowerCase();
}

async function persistUpload(tempPath, originalName, folder = 'originals') {
  ensureDirectories();

  const extension = path.extname(originalName) || '.jpg';
  const basename = path.basename(originalName, extension);
  const targetPath = path.join(
    STORAGE_ROOT,
    folder,
    `${uuidv4()}-${safeName(basename)}${extension.toLowerCase()}`
  );

  try {
    await fs.promises.rename(tempPath, targetPath);
  } catch (error) {
    await fs.promises.copyFile(tempPath, targetPath);
    await fs.promises.unlink(tempPath).catch(() => {});
  }

  return targetPath;
}

async function createThumbnail(sourcePath) {
  ensureDirectories();

  const targetPath = path.join(STORAGE_ROOT, 'thumbs', `${path.basename(sourcePath, path.extname(sourcePath))}.jpg`);

  await sharp(sourcePath)
    .rotate()
    .resize({ width: 400, height: 400, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 82 })
    .toFile(targetPath);

  return targetPath;
}

async function decodeQrFromBuffer(buffer) {
  try {
    const image = await Jimp.read(buffer);

    return await new Promise((resolve) => {
      const qr = new QrCode();
      qr.callback = (error, value) => {
        if (error || !value || !value.result) {
          resolve(null);
          return;
        }

        resolve(value.result);
      };

      qr.decode(image.bitmap);
    });
  } catch (error) {
    return null;
  }
}

function createCenteredCropArea(width, height, ratio) {
  const cropWidth = Math.max(220, Math.min(width, Math.round(width * ratio)));
  const cropHeight = Math.max(220, Math.min(height, Math.round(height * ratio)));

  return {
    left: Math.max(0, Math.round((width - cropWidth) / 2)),
    top: Math.max(0, Math.round((height - cropHeight) / 2)),
    width: cropWidth,
    height: cropHeight,
  };
}

async function decodeQrValue(imagePath) {
  try {
    const { data: rotatedBuffer, info } = await sharp(imagePath)
      .rotate()
      .toBuffer({ resolveWithObject: true });

    const directResult = await decodeQrFromBuffer(rotatedBuffer);
    if (directResult) {
      return directResult;
    }

    const width = info.width || 1200;
    const height = info.height || 1200;
    const resizeOptions = {
      width: 1800,
      height: 1800,
      fit: 'inside',
      withoutEnlargement: false,
    };

    const candidateBuffers = [
      await sharp(rotatedBuffer)
        .resize(resizeOptions)
        .png()
        .toBuffer(),
      await sharp(rotatedBuffer)
        .grayscale()
        .normalise()
        .sharpen()
        .resize(resizeOptions)
        .png()
        .toBuffer(),
      await sharp(rotatedBuffer)
        .grayscale()
        .normalise()
        .threshold(170)
        .resize(resizeOptions)
        .png()
        .toBuffer(),
    ];

    for (const ratio of [0.85, 0.65, 0.5]) {
      const cropArea = createCenteredCropArea(width, height, ratio);

      candidateBuffers.push(
        await sharp(rotatedBuffer)
          .extract(cropArea)
          .resize(resizeOptions)
          .png()
          .toBuffer()
      );

      candidateBuffers.push(
        await sharp(rotatedBuffer)
          .extract(cropArea)
          .grayscale()
          .normalise()
          .sharpen()
          .resize(resizeOptions)
          .png()
          .toBuffer()
      );

      candidateBuffers.push(
        await sharp(rotatedBuffer)
          .extract(cropArea)
          .grayscale()
          .normalise()
          .threshold(170)
          .resize(resizeOptions)
          .png()
          .toBuffer()
      );
    }

    for (const buffer of candidateBuffers) {
      const result = await decodeQrFromBuffer(buffer);
      if (result) {
        return result;
      }
    }

    return null;
  } catch (error) {
    return null;
  }
}

function publicAssetPath(filePath) {
  if (!filePath) {
    return null;
  }

  return `/assets/${path.relative(STORAGE_ROOT, filePath).replace(/\\/g, '/')}`;
}

module.exports = {
  ensureDirectories,
  persistUpload,
  createThumbnail,
  decodeQrValue,
  publicAssetPath,
};
