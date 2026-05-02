// Elevate — On-site Photo Booth Kiosk
// Single-screen experience: countdown → capture → AI render → QR for guest's phone.
// AI generation runs on Vercel serverless functions at same-origin /api/photo.

// ---------- Photo Booth ----------
const cam = document.getElementById('cam');
const snap = document.getElementById('snap');
const cap = document.getElementById('cap');
const camWrap = document.getElementById('camWrap');
const flash = document.getElementById('flash');
const countdownEl = document.getElementById('countdown');
const errEl = document.getElementById('err');
const afterCaptureRow = document.getElementById('afterCaptureRow');
const btnTake = document.getElementById('btnTake');
const btnRetake = document.getElementById('btnRetake');
const btnGenerate = document.getElementById('btnGenerate');
const btnStart = document.getElementById('btnStart');
const btnSwitch = document.getElementById('btnSwitch');
const btnNewGuest = document.getElementById('btnNewGuest');
const loading = document.getElementById('loading');
const loadingTitle = document.getElementById('loadingTitle');
const result = document.getElementById('result');
const resultImg = document.getElementById('resultImg');
const qrCodeEl = document.getElementById('qrCode');
const status = document.getElementById('status');

let stream = null;
let facingMode = 'user';
let capturedBlob = null;
let currentPhotoId = null;

function showError(msg) {
  errEl.textContent = msg;
  errEl.hidden = !msg;
}
function clearError() { showError(''); }

async function startCamera() {
  clearError();

  // Pre-flight checks — surface the real reason instead of a silent black screen.
  if (!window.isSecureContext) {
    showError('Camera requires HTTPS. Open this page over https:// (or localhost).');
    return;
  }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    showError('This browser does not expose camera APIs. Try Chrome, Safari, or Edge.');
    return;
  }

  try {
    if (stream) {
      stream.getTracks().forEach(t => t.stop());
      stream = null;
    }

    // Try the requested facing mode first; fall back to ANY camera if that fails.
    // Some kiosks / desktops only expose a single device with no facingMode label,
    // and a strict facingMode constraint will reject with OverconstrainedError.
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: facingMode }, width: { ideal: 1280 }, height: { ideal: 1707 } },
        audio: false,
      });
    } catch (innerErr) {
      console.warn('[camera] facingMode failed, retrying without constraint:', innerErr);
      stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    }

    cam.srcObject = stream;
    cam.hidden = false;
    snap.hidden = true;

    // play() can reject on strict autoplay policies even though the element
    // has muted+playsinline. Treat reject as soft: log + show error, but keep stream.
    try {
      await cam.play();
    } catch (playErr) {
      console.warn('[camera] play() rejected:', playErr);
      showError('Tap the camera area to start the preview.');
      // Tap-to-play fallback for stricter mobile browsers
      cam.addEventListener('click', () => cam.play().catch(() => {}), { once: true });
      camWrap.addEventListener('click', () => cam.play().catch(() => {}), { once: true });
    }
  } catch (e) {
    const name = e && e.name;
    let msg;
    if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
      msg = 'Camera permission was blocked. Open browser settings, allow camera for this site, then reload.';
    } else if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
      msg = 'No camera detected on this device.';
    } else if (name === 'NotReadableError' || name === 'TrackStartError') {
      msg = 'Camera is in use by another app. Close other apps using the camera and tap Start Camera.';
    } else if (name === 'OverconstrainedError') {
      msg = 'Camera could not match requested settings. Tap Switch, then Start Camera.';
    } else {
      msg = `Camera unavailable: ${e.message || e}. Tap Start Camera to retry.`;
    }
    showError(msg);
  }
}

function stopCamera() {
  if (stream) {
    stream.getTracks().forEach(t => t.stop());
    stream = null;
  }
}

btnStart.addEventListener('click', startCamera);
btnSwitch.addEventListener('click', () => {
  facingMode = facingMode === 'user' ? 'environment' : 'user';
  startCamera();
});

// Take photo button → immediately start countdown (QR-first flow, no upfront form)
btnTake.addEventListener('click', () => {
  if (!stream || !cam.videoWidth) {
    showError('Camera is not ready yet. Wait a moment and try again.');
    return;
  }
  clearError();
  startCountdown();
});

// 5-second countdown then capture
function startCountdown() {
  let n = 5;
  countdownEl.hidden = false;
  countdownEl.textContent = n;
  const tick = setInterval(() => {
    n -= 1;
    if (n <= 0) {
      clearInterval(tick);
      countdownEl.textContent = '📸';
      setTimeout(() => {
        countdownEl.hidden = true;
        captureFrame();
      }, 350);
    } else {
      countdownEl.textContent = n;
    }
  }, 1000);
}

function captureFrame() {
  // Flash
  flash.classList.add('is-firing');
  setTimeout(() => flash.classList.remove('is-firing'), 170);

  // Capture
  const w = cam.videoWidth || 720;
  const h = cam.videoHeight || 960;
  cap.width = w; cap.height = h;
  const ctx = cap.getContext('2d');
  // Mirror to match the live preview
  ctx.translate(w, 0);
  ctx.scale(-1, 1);
  ctx.drawImage(cam, 0, 0, w, h);

  cap.toBlob((blob) => {
    capturedBlob = blob;
    snap.src = URL.createObjectURL(blob);
    snap.hidden = false;
    cam.hidden = true;
    btnTake.hidden = true;
    afterCaptureRow.hidden = false;
    stopCamera();
  }, 'image/jpeg', 0.92);
}

btnRetake.addEventListener('click', () => {
  capturedBlob = null;
  snap.hidden = true;
  cam.hidden = false;
  btnTake.hidden = false;
  afterCaptureRow.hidden = true;
  startCamera();
});

// Themed loading messages cycle
const LOADING_MESSAGES = [
  'Painting your Capri scene…',
  'Squeezing a few extra lemons…',
  'Polishing the chrome…',
  'Adjusting the cliffside light…',
  'Tying the silk scarf…',
];

let loadingTimer = null;
function startLoadingMessages() {
  let i = 0;
  loadingTitle.textContent = LOADING_MESSAGES[0];
  loadingTimer = setInterval(() => {
    i = (i + 1) % LOADING_MESSAGES.length;
    loadingTitle.textContent = LOADING_MESSAGES[i];
  }, 4500);
}
function stopLoadingMessages() {
  if (loadingTimer) { clearInterval(loadingTimer); loadingTimer = null; }
}

// QR-first flow: POST /api/photo → receive {photo_id, public_url} → render QR
btnGenerate.addEventListener('click', async () => {
  if (!capturedBlob) {
    showError('Take a picture first.');
    return;
  }
  clearError();
  camWrap.hidden = true;
  afterCaptureRow.hidden = true;
  loading.hidden = false;
  startLoadingMessages();

  try {
    // Compress to ~1024px JPEG, then base64 it for JSON upload to Vercel function.
    const imageBase64 = await blobToBase64Compressed(capturedBlob, 1024, 0.88);

    const res = await fetch('/api/photo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ imageBase64 }),
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(`Generation failed (${res.status}). ${txt}`);
    }
    const data = await res.json();
    currentPhotoId = data.photo_id;

    resultImg.src = data.public_url;
    renderQrCode(currentPhotoId);

    loading.hidden = true;
    stopLoadingMessages();
    result.hidden = false;
    status.textContent = '';
    status.className = 'booth__status';
  } catch (e) {
    loading.hidden = true;
    stopLoadingMessages();
    camWrap.hidden = false;
    afterCaptureRow.hidden = false;
    showError(`Failed: ${e.message || e}`);
  }
});

// Resize a JPEG/PNG blob to fit within `maxDim` on the longest edge,
// then return the base64 (no data: prefix) at the given JPEG quality.
async function blobToBase64Compressed(blob, maxDim = 1024, quality = 0.88) {
  const bitmap = await createImageBitmap(blob);
  const { width: srcW, height: srcH } = bitmap;
  const scale = Math.min(1, maxDim / Math.max(srcW, srcH));
  const w = Math.round(srcW * scale);
  const h = Math.round(srcH * scale);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, 0, 0, w, h);
  const dataUrl = canvas.toDataURL('image/jpeg', quality);
  return dataUrl.split(',')[1];
}

function renderQrCode(photoId) {
  if (!qrCodeEl) return;
  qrCodeEl.innerHTML = '';
  const claimUrl = `${window.location.origin}/claim?id=${encodeURIComponent(photoId)}`;
  try {
    if (typeof window.qrcode !== 'function') throw new Error('qrcode library not loaded');
    // Type 0 = auto-pick smallest type that fits the data; error level M
    const qr = window.qrcode(0, 'M');
    qr.addData(claimUrl);
    qr.make();
    // 8px module, 2-module quiet zone
    const svg = qr.createSvgTag({ cellSize: 8, margin: 16, scalable: true });
    qrCodeEl.innerHTML = svg;
    const svgEl = qrCodeEl.querySelector('svg');
    if (svgEl) {
      svgEl.setAttribute('width', '100%');
      svgEl.setAttribute('height', '100%');
      svgEl.setAttribute('aria-label', 'QR code — scan to download your photo');
      svgEl.setAttribute('role', 'img');
      // Recolor: white squares = bg, black squares = ink
      svgEl.querySelectorAll('rect').forEach((r, i) => {
        if (i === 0) r.setAttribute('fill', '#fdf6ec');
        else r.setAttribute('fill', '#1f2d33');
      });
    }
  } catch (e) {
    console.error('qr render failed', e);
    const fallback = document.createElement('a');
    fallback.href = claimUrl;
    fallback.textContent = claimUrl;
    fallback.style.fontSize = '0.7rem';
    fallback.style.wordBreak = 'break-all';
    qrCodeEl.appendChild(fallback);
  }
}

// New guest — reset
btnNewGuest.addEventListener('click', () => {
  capturedBlob = null;
  currentPhotoId = null;
  resultImg.src = '';
  if (qrCodeEl) qrCodeEl.innerHTML = '';
  result.hidden = true;
  loading.hidden = true;
  camWrap.hidden = false;
  snap.hidden = true;
  cam.hidden = false;
  btnTake.hidden = false;
  afterCaptureRow.hidden = true;
  status.textContent = '';
  status.className = 'booth__status';
  clearError();
  startCamera();
});

// ---------- Kiosk lockdown ----------
window.addEventListener('contextmenu', e => e.preventDefault());
window.addEventListener('keydown', e => {
  if (e.ctrlKey || e.metaKey) {
    if (['t','n','w','r','f','p'].includes(e.key.toLowerCase())) e.preventDefault();
  }
  if (e.key === 'F5' || e.key === 'F11') e.preventDefault();
});

// Auto-start camera. On strict autoplay-gated browsers this may fail silently;
// the error handler in startCamera() surfaces guidance, and tapping Start Camera
// (which is a user gesture) will succeed.
startCamera();

// ---------- Legal overlay (Terms & Privacy) ----------
(function setupLegalOverlay() {
  const overlay = document.getElementById('legalOverlay');
  const closeBtn = document.getElementById('legalClose');
  const titleEl = document.getElementById('legalTitle');
  if (!overlay || !closeBtn || !titleEl) return;
  const bodies = overlay.querySelectorAll('.legal-body');
  const scroll = overlay.querySelector('.legal-overlay__scroll');

  const TITLES = {
    terms: 'Terms & Conditions',
    privacy: 'Privacy Policy',
  };

  function show(which) {
    if (!TITLES[which]) which = 'terms';
    titleEl.textContent = TITLES[which];
    bodies.forEach(b => {
      b.hidden = (b.dataset.body !== which);
    });
    overlay.hidden = false;
    if (scroll) scroll.scrollTop = 0;
  }
  function hide() { overlay.hidden = true; }

  document.addEventListener('click', (e) => {
    const trigger = e.target.closest('[data-legal]');
    if (trigger) {
      e.preventDefault();
      show(trigger.dataset.legal);
      return;
    }
    if (e.target === overlay) hide();
  });
  closeBtn.addEventListener('click', hide);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !overlay.hidden) hide();
  });
})();
