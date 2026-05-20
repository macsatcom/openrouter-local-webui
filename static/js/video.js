const modelSelect = document.getElementById('modelSelect');
const modelFilterInput = document.getElementById('modelFilter');
const modelDropdown = document.getElementById('modelDropdown');
const promptEl = document.getElementById('prompt');
const generateBtn = document.getElementById('generateBtn');
const statusEl = document.getElementById('status');
const videoGridEl = document.getElementById('videoGrid');
const loadMoreBtn = document.getElementById('loadMoreBtn');
const toastContainer = document.getElementById('toastContainer');

const durationEl = document.getElementById('duration');
const resolutionEl = document.getElementById('resolution');
const aspectRatioEl = document.getElementById('aspectRatio');
const audioToggle = document.getElementById('audioToggle');
const optionsToggle = document.getElementById('optionsToggle');
const optionsPanel = document.getElementById('optionsPanel');

const refFirstFrameInput = document.getElementById('refFirstFrameInput');
const refFirstFrameBtn = document.getElementById('refFirstFrameBtn');
const refFirstFramePreview = document.getElementById('refFirstFramePreview');
const refFirstFramePreviewImg = document.getElementById('refFirstFramePreviewImg');
const refFirstFrameRemove = document.getElementById('refFirstFrameRemove');

const refLastFrameInput = document.getElementById('refLastFrameInput');
const refLastFrameBtn = document.getElementById('refLastFrameBtn');
const refLastFramePreview = document.getElementById('refLastFramePreview');
const refLastFramePreviewImg = document.getElementById('refLastFramePreviewImg');
const refLastFrameRemove = document.getElementById('refLastFrameRemove');

const refStyleInput = document.getElementById('refStyleInput');
const refStyleBtn = document.getElementById('refStyleBtn');
const refStylePreview = document.getElementById('refStylePreview');
const refStylePreviewImg = document.getElementById('refStylePreviewImg');
const refStyleRemove = document.getElementById('refStyleRemove');

let offset = 0;
let loading = false;
let videoModels = [];
let currentStatus = '';
let activeJobIds = new Set();
let lastNotificationCount = 0;
let refFirstFrameBase64 = null;
let refLastFrameBase64 = null;
let refStyleBase64 = null;

async function checkAuth() {
  try {
    const res = await fetch('/api/auth/me');
    if (!res.ok) throw new Error();
    const data = await res.json();
    localStorage.setItem('username', data.user.username);
    if (data.user.is_admin) {
      document.getElementById('adminLink').classList.remove('hidden');
    }
  } catch {
    window.location.href = '/login';
  }
}

async function loadModels() {
  try {
    const res = await fetch('/api/video/models');
    const data = await res.json();
    videoModels = data.models;
    renderDropdown(videoModels);
    const lastModel = localStorage.getItem('lastVideoModelId');
    if (lastModel) {
      const model = videoModels.find(m => m.id === lastModel);
      if (model) { modelSelect.value = model.id; modelFilterInput.value = model.name || model.id; }
    } else if (videoModels.length > 0) {
      modelSelect.value = videoModels[0].id;
      modelFilterInput.value = videoModels[0].name || videoModels[0].id;
    }
  } catch (e) {
    statusEl.innerHTML = '<div class="error">Failed to load models</div>';
  }
}

async function generate() {
  const model = modelSelect.value;
  const prompt = promptEl.value.trim();
  if (!prompt) { statusEl.innerHTML = '<div class="error">Please enter a prompt</div>'; return; }

  localStorage.setItem('lastVideoModelId', model);
  generateBtn.disabled = true;
  generateBtn.innerHTML = '<span class="loading"></span> Generating...';
  statusEl.innerHTML = '';

  try {
    const body = {
      model, prompt,
      duration: parseInt(durationEl.value) || 5,
      resolution: resolutionEl.value,
      aspect_ratio: aspectRatioEl.value,
      generate_audio: audioToggle.checked
    };

    const frameImages = [];
    if (refFirstFrameBase64) {
      frameImages.push({ type: 'image_url', image_url: { url: refFirstFrameBase64 }, frame_type: 'first_frame' });
    }
    if (refLastFrameBase64) {
      frameImages.push({ type: 'image_url', image_url: { url: refLastFrameBase64 }, frame_type: 'last_frame' });
    }
    if (frameImages.length > 0) body.frame_images = frameImages;

    if (refStyleBase64) {
      body.input_references = [{ type: 'image_url', image_url: { url: refStyleBase64 } }];
    }

    const res = await fetch('/api/video/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    const data = await res.json();
    if (!res.ok) { statusEl.innerHTML = '<div class="error">Error: ' + data.error + '</div>'; return; }

    statusEl.innerHTML = '<div class="success">Video job submitted! Check back soon.</div>';
    loadVideos(true);
  } catch (e) {
    statusEl.innerHTML = '<div class="error">Request failed: ' + e.message + '</div>';
  } finally {
    generateBtn.disabled = false;
    generateBtn.textContent = 'Generate Video';
  }
}

async function loadVideos(reset) {
  if (loading) return;
  if (reset) { offset = 0; videoGridEl.innerHTML = ''; activeJobIds.clear(); }

  loading = true;
  try {
    const url = '/api/video/list?limit=20&offset=' + offset + (currentStatus ? '&status=' + currentStatus : '');
    const res = await fetch(url);
    const data = await res.json();

    if (data.logs.length === 0 && offset === 0) {
      videoGridEl.innerHTML = '<p class="empty-text">No videos generated yet</p>';
      document.getElementById('loadMore').style.display = 'none';
      return;
    }

    for (const log of data.logs) {
      if (log.status === 'pending' || log.status === 'in_progress') activeJobIds.add(log.id);
      const card = buildVideoCard(log);
      videoGridEl.appendChild(card);
    }

    offset += data.logs.length;
    document.getElementById('loadMore').style.display = data.logs.length < 20 ? 'none' : 'block';
  } catch (e) {
    console.error('Failed to load videos:', e);
  } finally {
    loading = false;
  }
}

function buildVideoCard(log) {
  const card = document.createElement('div');
  card.className = 'video-card';
  card.id = 'video-' + log.id;

  if (log.status === 'completed') {
    card.innerHTML =
      '<video src="' + log.video_url + '" preload="metadata" muted onclick="openVideoPlayer(\'' + log.video_url + '\')"></video>' +
      '<div class="play-overlay" onclick="openVideoPlayer(\'' + log.video_url + '\')">&#9654;</div>' +
      '<div class="info">' + escapeHtml(log.prompt_short) + '</div>' +
      '<div class="info">' + new Date(log.created_at).toLocaleString() + ' | ' + (log.resolution || '') + ' | ' + (log.duration || '') + 's</div>' +
      '<div class="info">Cost: $' + (log.cost || 0).toFixed(4) + '</div>' +
      '<div class="actions">' +
        '<a href="' + log.video_url + '" download class="btn">Download</a>' +
        '<button class="btn btn-danger" onclick="deleteVideo(\'' + log.id + '\', this)">Delete</button>' +
      '</div>';
  } else if (log.status === 'pending' || log.status === 'in_progress') {
    card.innerHTML =
      '<div class="video-card-pending"><span class="loading"></span><br>' + (log.status === 'in_progress' ? 'Generating...' : 'Queued...') + '</div>' +
      '<div class="info">' + escapeHtml(log.prompt_short) + '</div>' +
      '<div class="info">' + new Date(log.created_at).toLocaleString() + '</div>' +
      '<div class="actions">' +
        '<button class="btn btn-danger" onclick="deleteVideo(\'' + log.id + '\', this)">Cancel</button>' +
      '</div>';
  } else if (log.status === 'failed') {
    card.innerHTML =
      '<div class="video-card-failed">&#10060; Failed</div>' +
      '<div class="info">' + escapeHtml(log.prompt_short) + '</div>' +
      '<div class="info">' + new Date(log.created_at).toLocaleString() + '</div>' +
      '<div class="info">' + escapeHtml(log.error || 'Unknown error') + '</div>' +
      '<div class="actions">' +
        '<button class="btn btn-danger" onclick="deleteVideo(\'' + log.id + '\', this)">Delete</button>' +
      '</div>';
  }

  return card;
}

async function pollActiveJobs() {
  if (activeJobIds.size === 0) return;
  const ids = Array.from(activeJobIds).join(',');
  try {
    const res = await fetch('/api/video/jobs?ids=' + ids);
    const data = await res.json();
    for (const job of data.jobs) {
      if (job.status === 'completed' || job.status === 'failed') {
        activeJobIds.delete(job.id);
      }
    }
    if (data.jobs.some(function(j) { return j.status !== 'pending' && j.status !== 'in_progress'; })) {
      loadVideos(true);
    }
  } catch (e) {}
}

async function pollNotifications() {
  try {
    const res = await fetch('/api/video/notifications');
    const data = await res.json();
    const badge = document.getElementById('videoBadge');
    if (badge) {
      if (data.count > 0) { badge.textContent = data.count; badge.classList.remove('hidden'); }
      else { badge.classList.add('hidden'); }
    }
    if (data.count > lastNotificationCount && lastNotificationCount > 0) {
      for (const v of data.videos) {
        showToast('Video ready: "' + escapeHtml(v.prompt_snippet) + '"');
      }
    }
    lastNotificationCount = data.count;
  } catch (e) {}
}

async function deleteVideo(id, btn) {
  if (!confirm('Delete this video?')) return;
  try {
    await fetch('/api/video/delete/' + id, { method: 'DELETE' });
    const card = document.getElementById('video-' + id);
    if (card) card.remove();
    activeJobIds.delete(id);
  } catch (e) {
    alert('Failed to delete video');
  }
}

function openVideoPlayer(url) {
  const lb = document.getElementById('videoLightbox');
  document.getElementById('lightboxVideo').src = url;
  lb.classList.add('active');
  document.body.style.overflow = 'hidden';
}

function closeVideoPlayer() {
  const lb = document.getElementById('videoLightbox');
  const video = document.getElementById('lightboxVideo');
  video.pause();
  video.src = '';
  lb.classList.remove('active');
  document.body.style.overflow = '';
}

function showToast(message) {
  toastContainer.classList.remove('hidden');
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.innerHTML = '🎬 ' + message;
  toast.onclick = function() { window.location.href = '/video'; };
  toastContainer.appendChild(toast);
  setTimeout(function() { toast.remove(); if (toastContainer.children.length === 0) toastContainer.classList.add('hidden'); }, 5000);
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function renderDropdown(models) {
  modelDropdown.innerHTML = models.map(function(m) {
    return '<div class="model-dropdown-item" data-value="' + m.id + '">' + (m.name || m.id) + '</div>';
  }).join('');
}

function filterDropdown(term) {
  const filtered = videoModels.filter(function(m) {
    return (m.name || m.id).toLowerCase().includes(term.toLowerCase());
  });
  if (filtered.length === 0) {
    modelDropdown.innerHTML = '<div class="model-dropdown-empty">No models found</div>';
  } else {
    modelDropdown.innerHTML = filtered.map(function(m) {
      return '<div class="model-dropdown-item" data-value="' + m.id + '">' + (m.name || m.id) + '</div>';
    }).join('');
  }
}

function handleRefImage(file, previewEl, previewImgEl, btnEl, stateSetter) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = function(e) {
    stateSetter(e.target.result);
    previewImgEl.src = e.target.result;
    previewEl.classList.remove('hidden');
    btnEl.textContent = 'Change';
  };
  reader.readAsDataURL(file);
}

function removeRefImage(previewEl, inputEl, btnEl, stateSetter) {
  stateSetter(null);
  inputEl.value = '';
  previewEl.classList.add('hidden');
  var defaultText = btnEl === refFirstFrameBtn ? 'First frame' : (btnEl === refLastFrameBtn ? 'Last frame' : 'Style reference');
  btnEl.textContent = defaultText;
}

refFirstFrameBtn.addEventListener('click', function() { refFirstFrameInput.click(); });
refFirstFrameInput.addEventListener('change', function() { handleRefImage(refFirstFrameInput.files[0], refFirstFramePreview, refFirstFramePreviewImg, refFirstFrameBtn, function(v) { refFirstFrameBase64 = v; }); });
refFirstFrameRemove.addEventListener('click', function() { removeRefImage(refFirstFramePreview, refFirstFrameInput, refFirstFrameBtn, function(v) { refFirstFrameBase64 = v; }); });

refLastFrameBtn.addEventListener('click', function() { refLastFrameInput.click(); });
refLastFrameInput.addEventListener('change', function() { handleRefImage(refLastFrameInput.files[0], refLastFramePreview, refLastFramePreviewImg, refLastFrameBtn, function(v) { refLastFrameBase64 = v; }); });
refLastFrameRemove.addEventListener('click', function() { removeRefImage(refLastFramePreview, refLastFrameInput, refLastFrameBtn, function(v) { refLastFrameBase64 = v; }); });

refStyleBtn.addEventListener('click', function() { refStyleInput.click(); });
refStyleInput.addEventListener('change', function() { handleRefImage(refStyleInput.files[0], refStylePreview, refStylePreviewImg, refStyleBtn, function(v) { refStyleBase64 = v; }); });
refStyleRemove.addEventListener('click', function() { removeRefImage(refStylePreview, refStyleInput, refStyleBtn, function(v) { refStyleBase64 = v; }); });

optionsToggle.addEventListener('click', function() {
  optionsPanel.classList.toggle('hidden');
  optionsToggle.classList.toggle('open');
});

modelFilterInput.addEventListener('input', function() {
  var term = modelFilterInput.value.trim();
  modelDropdown.classList.add('open');
  if (term) filterDropdown(term); else renderDropdown(videoModels);
});

modelFilterInput.addEventListener('focus', function() {
  if (videoModels.length > 0) {
    modelDropdown.classList.add('open');
    var term = modelFilterInput.value.trim();
    if (term) filterDropdown(term); else renderDropdown(videoModels);
  }
});

modelDropdown.addEventListener('click', function(e) {
  var item = e.target.closest('.model-dropdown-item');
  if (item) {
    modelSelect.value = item.dataset.value;
    modelFilterInput.value = item.textContent;
    localStorage.setItem('lastVideoModelId', item.dataset.value);
    modelDropdown.classList.remove('open');
  }
});

document.addEventListener('click', function(e) {
  if (!modelFilterInput.parentElement.contains(e.target)) {
    modelDropdown.classList.remove('open');
  }
});

generateBtn.addEventListener('click', generate);
loadMoreBtn.addEventListener('click', function() { loadVideos(); });

document.querySelectorAll('#videoTabs .tab-btn').forEach(function(btn) {
  btn.addEventListener('click', function() {
    document.querySelectorAll('#videoTabs .tab-btn').forEach(function(b) { b.classList.remove('active'); });
    btn.classList.add('active');
    currentStatus = btn.dataset.status;
    loadVideos(true);
  });
});

document.addEventListener('keydown', function(e) {
  if (e.key === 'Escape') closeVideoPlayer();
});

checkAuth().then(function() {
  loadModels();
  loadVideos();
  setInterval(pollActiveJobs, 5000);
  setInterval(pollNotifications, 10000);
});
