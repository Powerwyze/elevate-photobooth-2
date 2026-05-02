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
  try {
    if (stream) {
      stream.getTracks().forEach(t => t.stop());
      stream = null;
    }
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode, width: { ideal: 1280 }, height: { ideal: 1707 } },
      audio: false,
    });
    cam.srcObject = stream;
    cam.hidden = false;
    snap.hidden = true;
    await cam.play();
  } catch (e) {
    showError(`Camera unavailable. Tap Switch then Start Camera. (${e.message || e})`);
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

// Auto-start camera
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
