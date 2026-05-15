const modelSelect = document.getElementById('modelSelect');
const modelFilterInput = document.getElementById('modelFilter');
const modelDropdown = document.getElementById('modelDropdown');
const promptEl = document.getElementById('prompt');
const aspectRatioEl = document.getElementById('aspectRatio');
const generateBtn = document.getElementById('generateBtn');
const statusEl = document.getElementById('status');
const imageGridEl = document.getElementById('imageGrid');
const loadMoreBtn = document.getElementById('loadMoreBtn');

let offset = 0;
let loading = false;
let imageModels = [];

async function checkAuth() {
  try {
    const res = await fetch('/api/auth/me');
    if (!res.ok) throw new Error();
    const data = await res.json();
    localStorage.setItem('username', data.user.username);
  } catch {
    window.location.href = '/login';
  }
}

async function loadModels() {
  try {
    const res = await fetch('/api/image/models');
    const data = await res.json();
    imageModels = data.models;
    renderDropdown(imageModels);
  } catch (e) {
    statusEl.innerHTML = '<div class="error">Failed to load models</div>';
  }
}

async function generate() {
  const model = modelSelect.value;
  const prompt = promptEl.value.trim();
  if (!prompt) {
    statusEl.innerHTML = '<div class="error">Please enter a prompt</div>';
    return;
  }

  generateBtn.disabled = true;
  generateBtn.innerHTML = '<span class="loading"></span> Generating...';
  statusEl.innerHTML = '';

  try {
    const res = await fetch('/api/image/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        prompt,
        aspect_ratio: aspectRatioEl.value
      })
    });

    const data = await res.json();

    if (!res.ok) {
      statusEl.innerHTML = `<div class="error">Error: ${data.error}</div>`;
      return;
    }

    if (data.image_url) {
      statusEl.innerHTML = '<div class="success">Image generated successfully!</div>';
      loadImages(true);
    } else {
      statusEl.innerHTML = `<div class="error">No image returned: ${data.text || 'Unknown error'}</div>`;
    }
  } catch (e) {
    statusEl.innerHTML = `<div class="error">Request failed: ${e.message}</div>`;
  } finally {
    generateBtn.disabled = false;
    generateBtn.textContent = 'Generate';
  }
}

async function loadImages(reset = false) {
  if (loading) return;
  if (reset) {
    offset = 0;
    imageGridEl.innerHTML = '';
  }

  loading = true;
  try {
    const res = await fetch(`/api/image/list?limit=20&offset=${offset}`);
    const data = await res.json();

    if (data.logs.length === 0 && offset === 0) {
      imageGridEl.innerHTML = '<p style="color:#888">No images generated yet</p>';
      document.getElementById('loadMore').style.display = 'none';
      return;
    }

    for (const log of data.logs) {
      const card = document.createElement('div');
      card.className = 'image-card';
      if (log.image_url) {
        card.innerHTML = `
          <img src="${log.image_url}" alt="${escapeHtml(log.prompt)}" onclick="openLightbox('${log.image_url}')">
          <div class="info">${escapeHtml(log.prompt.slice(0, 50))}...</div>
          <div class="info">${new Date(log.created_at).toLocaleString()}</div>
          <div class="actions">
            <a href="${log.image_url}" download class="btn">Download</a>
            <button class="btn btn-danger" onclick="deleteImage('${log.image_path}', this)">Delete</button>
          </div>
        `;
      } else {
        card.innerHTML = `
          <div class="info">${escapeHtml(log.prompt)}</div>
          <div class="info">${new Date(log.created_at).toLocaleString()}</div>
          <div class="info">Image unavailable</div>
        `;
      }
      imageGridEl.appendChild(card);
    }

    offset += data.logs.length;
    document.getElementById('loadMore').style.display = data.logs.length < 20 ? 'none' : 'block';
  } catch (e) {
    console.error('Failed to load images:', e);
  } finally {
    loading = false;
  }
}

async function deleteImage(filename, btn) {
  if (!confirm('Delete this image?')) return;
  try {
    await fetch(`/api/image/delete/${filename}`, { method: 'DELETE' });
    btn.closest('.image-card').remove();
  } catch (e) {
    alert('Failed to delete image');
  }
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function renderDropdown(models) {
  modelDropdown.innerHTML = models.map(m =>
    `<div class="model-dropdown-item" data-value="${m.id}">${m.name || m.id}</div>`
  ).join('');
}

function filterDropdown(term) {
  const filtered = imageModels.filter(m =>
    (m.name || m.id).toLowerCase().includes(term.toLowerCase())
  );
  if (filtered.length === 0) {
    modelDropdown.innerHTML = '<div class="model-dropdown-empty">No models found</div>';
  } else {
    modelDropdown.innerHTML = filtered.map(m =>
      `<div class="model-dropdown-item" data-value="${m.id}">${m.name || m.id}</div>`
    ).join('');
  }
}

modelFilterInput.addEventListener('input', () => {
  const term = modelFilterInput.value.trim();
  modelDropdown.classList.add('open');
  if (term) {
    filterDropdown(term);
  } else {
    renderDropdown(imageModels);
  }
});

modelFilterInput.addEventListener('focus', () => {
  if (imageModels.length > 0) {
    const term = modelFilterInput.value.trim();
    modelDropdown.classList.add('open');
    if (term) filterDropdown(term);
    else renderDropdown(imageModels);
  }
});

modelDropdown.addEventListener('click', (e) => {
  const item = e.target.closest('.model-dropdown-item');
  if (item) {
    modelSelect.value = item.dataset.value;
    modelFilterInput.value = item.textContent;
    modelDropdown.classList.remove('open');
  }
});

document.addEventListener('click', (e) => {
  if (!modelFilterInput.parentElement.contains(e.target)) {
    modelDropdown.classList.remove('open');
  }
});

generateBtn.addEventListener('click', generate);
loadMoreBtn.addEventListener('click', () => loadImages());

function openLightbox(src) {
  const lb = document.getElementById('lightbox');
  document.getElementById('lightboxImg').src = src;
  lb.classList.add('active');
  document.body.style.overflow = 'hidden';
}

function closeLightbox() {
  const lb = document.getElementById('lightbox');
  lb.classList.remove('active');
  document.body.style.overflow = '';
}

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') closeLightbox();
});

checkAuth().then(() => {
  loadModels();
  loadImages();
});