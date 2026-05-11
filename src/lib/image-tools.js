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
      let resolved = false;
      const timeoutId = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          resolve(null);
        }
      }, 3000);
      
      const qr = new QrCode();
      
      qr.callback = (error, value) => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timeoutId);
        
        if (error || !value || !value.result) {
          resolve(null);
          return;
        }

        resolve(value.result);
      };

      try {
        qr.decode(image.bitmap);
      } catch (decodeError) {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeoutId);
          resolve(null);
        }
      }
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
    // Try multiple rotation angles to handle perspective distortion
    const rotationAngles = [0, 5, -5, 10, -10, 15, -15];
    
    for (const angle of rotationAngles) {
      const { data: rotatedBuffer, info } = await sharp(imagePath)
        .rotate(angle, { background: { r: 255, g: 255, b: 255 } })
        .toBuffer({ resolveWithObject: true });

      const directResult = await decodeQrFromBuffer(rotatedBuffer);
      if (directResult) {
        return directResult;
      }

      const width = info.width || 1200;
      const height = info.height || 1200;

      // Fokussierte Liste von Kandidaten mit Emphasis auf Contrast
      const candidateGenerators = [
        // Aggressive threshold variations for tilted/perspective QR codes
        () => sharp(rotatedBuffer)
          .grayscale()
          .normalise()
          .threshold(150)
          .resize({ width: 1500, height: 1500, fit: 'inside' })
          .png()
          .toBuffer(),

        () => sharp(rotatedBuffer)
          .grayscale()
          .normalise()
          .threshold(170)
          .resize({ width: 1500, height: 1500, fit: 'inside' })
          .png()
          .toBuffer(),

        () => sharp(rotatedBuffer)
          .grayscale()
          .normalise()
          .threshold(190)
          .resize({ width: 1500, height: 1500, fit: 'inside' })
          .png()
          .toBuffer(),

        // Grayscale with strong sharpening
        () => sharp(rotatedBuffer)
          .grayscale()
          .normalise()
          .sharpen({ sigma: 2 })
          .resize({ width: 1500, height: 1500, fit: 'inside' })
          .png()
          .toBuffer(),

        // Centered crop with threshold
        () => {
          const cropArea = createCenteredCropArea(width, height, 0.7);
          return sharp(rotatedBuffer)
            .extract(cropArea)
            .grayscale()
            .normalise()
            .threshold(170)
            .resize({ width: 1500, height: 1500, fit: 'inside' })
            .png()
            .toBuffer();
        },

        // High contrast + invert for light QR codes
        () => sharp(rotatedBuffer)
          .grayscale()
          .normalise()
          .negate()
          .threshold(80)
          .resize({ width: 1500, height: 1500, fit: 'inside' })
          .png()
          .toBuffer(),
      ];

      for (const generator of candidateGenerators) {
        try {
          const buffer = await generator();
          const result = await decodeQrFromBuffer(buffer);
          if (result) {
            return result;
          }
        } catch (err) {
          continue;
        }
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
