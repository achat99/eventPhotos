document.addEventListener('DOMContentLoaded', () => {
  const startButton = document.getElementById('start-scan-btn');
  const scannerWrap = document.getElementById('qr-scanner');
  const tokenInput = document.getElementById('lookupToken');
  const lookupForm = document.getElementById('lookupForm');
  const status = document.getElementById('scanner-status');

  if (startButton && scannerWrap && tokenInput && lookupForm && status) {
    let scanner;

    startButton.addEventListener('click', async () => {
      if (typeof Html5Qrcode === 'undefined') {
        status.textContent = 'Die Scanner-Bibliothek konnte nicht geladen werden.';
        return;
      }

      startButton.disabled = true;
      scannerWrap.classList.remove('d-none');
      status.textContent = 'Kamera wird gestartet...';

      scanner = new Html5Qrcode('qr-scanner');

      try {
        await scanner.start(
          { facingMode: 'environment' },
          { fps: 10, qrbox: { width: 240, height: 240 } },
          async (decodedText) => {
            tokenInput.value = decodedText;
            status.textContent = 'QR-Code erkannt. Galerie wird geöffnet...';

            try {
              await scanner.stop();
            } catch (error) {
              console.warn('Scanner stop failed', error);
            }

            lookupForm.submit();
          },
          () => {}
        );

        status.textContent = 'Kamera aktiv – QR-Code bitte in den Rahmen halten.';
      } catch (error) {
        console.error(error);
        status.textContent = 'Kamera konnte nicht gestartet werden. Bitte Berechtigung prüfen oder den Token manuell eingeben.';
        startButton.disabled = false;
      }
    });
  }

  const previewModal = document.getElementById('photoPreviewModal');
  const previewImage = document.getElementById('photoPreviewImage');
  const previewTitle = document.getElementById('photoPreviewTitle');
  const previewDownload = document.getElementById('photoPreviewDownload');

  if (previewModal && previewImage && previewTitle && previewDownload) {
    const previewTriggers = document.querySelectorAll('[data-photo-preview="true"]');

    previewTriggers.forEach((trigger) => {
      trigger.addEventListener('click', () => {
        previewImage.src = trigger.dataset.fullImage || '';
        previewImage.alt = trigger.dataset.fileName || 'Eventfoto';
        previewTitle.textContent = trigger.dataset.fileName || 'Vergrößerte Vorschau';
        previewDownload.href = trigger.dataset.downloadUrl || '#';
      });
    });

    previewModal.addEventListener('hidden.bs.modal', () => {
      previewImage.src = '';
      previewDownload.href = '#';
    });
  }
});
