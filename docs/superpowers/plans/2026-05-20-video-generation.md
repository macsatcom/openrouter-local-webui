# Video Generation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a dedicated video generation page with async job submission, background polling, admin cost controls, and notifications.

**Architecture:** Fresh `src/routes/video.js` route + `src/video-worker.js` background poller + `static/video.html` + `static/js/video.js`. Video model discovery via `GET /api/v1/videos/models`. Jobs submitted to `POST /api/v1/videos`, worker polls every 15s, downloads MP4s on completion, tracks via `video_logs` + `video_notifications` tables.

**Tech Stack:** Express 4, better-sqlite3, vanilla JS frontend, no new npm deps.

---

### Task 1: Database -- video_logs + video_notifications tables + queries

**Files:**
- Modify: `src/db.js`

- [ ] **Step 1: Add table creation in `db.exec()` block**

Insert before the migration `ALTER TABLE` lines:

```js
CREATE TABLE IF NOT EXISTS video_logs (
  id           TEXT PRIMARY KEY,
  user_id      INTEGER NOT NULL,
  model        TEXT NOT NULL,
  prompt       TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending',
  job_id       TEXT,
  video_path   TEXT,
  duration     INTEGER,
  resolution   TEXT,
  aspect_ratio TEXT,
  has_audio    INTEGER DEFAULT 0,
  cost         REAL DEFAULT 0,
  error        TEXT,
  created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
  completed_at DATETIME,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS video_notifications (
  user_id    INTEGER NOT NULL,
  video_id   TEXT NOT NULL,
  seen       INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, video_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (video_id) REFERENCES video_logs(id) ON DELETE CASCADE
);
```

- [ ] **Step 2: Add prepared queries in the `queries` object**

Add these after the `deleteUserMemory` line:

```js
logVideo: db.prepare('INSERT INTO video_logs (id, user_id, model, prompt, status, job_id, duration, resolution, aspect_ratio, has_audio, cost, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'),
updateVideoJobResult: db.prepare('UPDATE video_logs SET status = ?, video_path = ?, cost = ?, completed_at = ?, error = ? WHERE id = ?'),
getVideoLogsByUser: db.prepare('SELECT vl.*, u.username FROM video_logs vl JOIN users u ON vl.user_id = u.id WHERE vl.user_id = ? ORDER BY vl.created_at DESC LIMIT ? OFFSET ?'),
getVideoLogs: db.prepare('SELECT vl.*, u.username FROM video_logs vl JOIN users u ON vl.user_id = u.id ORDER BY vl.created_at DESC LIMIT ? OFFSET ?'),
countVideoLogsByUser: db.prepare('SELECT COUNT(*) as count FROM video_logs WHERE user_id = ?'),
countVideoLogs: db.prepare('SELECT COUNT(*) as count FROM video_logs'),
getActiveVideoJobs: db.prepare("SELECT * FROM video_logs WHERE status IN ('pending', 'in_progress')"),
getVideoById: db.prepare('SELECT * FROM video_logs WHERE id = ?'),
insertVideoNotification: db.prepare('INSERT OR IGNORE INTO video_notifications (user_id, video_id) VALUES (?, ?)'),
getUnseenNotifications: db.prepare('SELECT vn.*, vl.prompt, vl.status FROM video_notifications vn JOIN video_logs vl ON vn.video_id = vl.id WHERE vn.user_id = ? AND vn.seen = 0 ORDER BY vn.created_at DESC'),
markNotificationsSeen: db.prepare('UPDATE video_notifications SET seen = 1 WHERE user_id = ?'),
markVideoNotificationSeen: db.prepare('UPDATE video_notifications SET seen = 1 WHERE user_id = ? AND video_id = ?'),
```

- [ ] **Step 3: Add helper functions after `recordSpending`**

```js
export function getMaxVideoResolution() {
  return getSetting('max_video_resolution', '');
}

export function getMaxVideoDuration() {
  return parseInt(getSetting('max_video_duration', '0')) || 0;
}
```

- [ ] **Step 4: Run to verify DB boot**

```bash
npm start
# Server should boot without DB errors
# Check for "Error: table video_logs already exists" is fine on re-runs due to IF NOT EXISTS
^C
```

### Task 2: Video storage helper

**Files:**
- Create: `src/video-storage.js`

- [ ] **Step 1: Create file**

```js
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { v4 as uuidv4 } from 'uuid';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VIDEOS_DIR = process.env.VIDEOS_DIR || path.join(__dirname, '..', 'generated-videos');

if (!fs.existsSync(VIDEOS_DIR)) {
  fs.mkdirSync(VIDEOS_DIR, { recursive: true });
}

export function generateVideoFilename(ext = 'mp4') {
  return `${uuidv4()}.${ext}`;
}

export function saveVideoFromBuffer(buffer, filename) {
  const filepath = path.join(VIDEOS_DIR, filename);
  fs.writeFileSync(filepath, buffer);
  return filepath;
}

export function getVideoPath(filename) {
  return path.join(VIDEOS_DIR, filename);
}

export function deleteVideoFile(filename) {
  const filepath = path.join(VIDEOS_DIR, filename);
  if (fs.existsSync(filepath)) {
    fs.unlinkSync(filepath);
  }
}

export function videoFileExists(filename) {
  return fs.existsSync(path.join(VIDEOS_DIR, filename));
}

export default VIDEOS_DIR;
```

### Task 3: Video route -- models endpoint

**Files:**
- Create: `src/routes/video.js` (first batch: models endpoint)

- [ ] **Step 1: Create `src/routes/video.js` with models endpoint**

```js
import express from 'express';
import { requireAuth } from '../auth.js';
import { queries, getSetting, checkUserSpendingLimit, recordSpending, getUserExposedModels, getMaxVideoResolution, getMaxVideoDuration } from '../db.js';
import db from '../db.js';
import { v4 as uuidv4 } from 'uuid';
import { generateVideoFilename, saveVideoFromBuffer, deleteVideoFile } from '../video-storage.js';
import path from 'path';
import fs from 'fs';
import VIDEOS_DIR from '../video-storage.js';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const router = express.Router();

async function fetchVideoModels(apiKey) {
  try {
    const response = await fetch('https://openrouter.ai/api/v1/videos/models', {
      headers: { 'Authorization': `Bearer ${apiKey}` }
    });
    if (!response.ok) return [];
    const data = await response.json();
    return data.data || [];
  } catch {
    return [];
  }
}

function formatVideoPrice(model) {
  const skus = model.pricing_skus || {};
  const prices = Object.values(skus).map(p => parseFloat(p)).filter(p => !isNaN(p));
  if (prices.length === 0) return '?';
  const minPrice = Math.min(...prices);
  if (minPrice === 0) return 'Free';
  if (minPrice < 0.001) return '$' + (minPrice * 1000).toFixed(3) + '/K per sec';
  return '$' + minPrice.toFixed(3) + '/s';
}

function compareResolutions(a, b) {
  const rank = { '480p': 1, '720p': 2, '1080p': 3, '1K': 3, '2K': 4, '4K': 5 };
  return (rank[a] || 0) - (rank[b] || 0);
}

router.get('/models', requireAuth, async (req, res) => {
  const apiKey = getSetting('openrouter_api_key');
  if (!apiKey) return res.json({ models: [], error: 'API key not configured' });

  const allModels = await fetchVideoModels(apiKey);
  let filtered = allModels;
  const userExposed = getUserExposedModels(req.user.id);
  if (userExposed.length > 0) {
    filtered = allModels.filter(m => userExposed.includes(m.id));
  }

  const maxRes = getMaxVideoResolution();
  if (maxRes) {
    filtered = filtered.filter(m => {
      const supported = m.supported_resolutions || [];
      return supported.some(r => compareResolutions(r, maxRes) <= 0);
    });
  }

  return res.json({
    models: filtered.map(m => ({
      id: m.id,
      name: `${m.name || m.id} (${formatVideoPrice(m)})`,
      supported_durations: m.supported_durations || [],
      supported_resolutions: m.supported_resolutions || [],
      supported_aspect_ratios: m.supported_aspect_ratios || [],
      supported_frame_images: m.supported_frame_images || []
    }))
  });
});
```

- [ ] **Step 2: Add generate, list, download, delete, jobs, notifications endpoints to `src/routes/video.js`**

Append to the file before `export default router;`:

```js
router.post('/generate', requireAuth, async (req, res) => {
  const apiKey = getSetting('openrouter_api_key');
  if (!apiKey) return res.status(500).json({ error: 'API key not configured' });

  const { model, prompt, duration, resolution, aspect_ratio, frame_images, input_references, generate_audio } = req.body;
  if (!model || !prompt) return res.status(400).json({ error: 'model and prompt required' });

  const limitCheck = checkUserSpendingLimit(req.user.id);
  if (!limitCheck.allowed) {
    return res.status(429).json({ error: `Limit exceeded: ${limitCheck.reason}` });
  }

  const maxRes = getMaxVideoResolution();
  const maxDur = getMaxVideoDuration();
  const effectiveRes = resolution || '720p';
  const effectiveDur = duration || 5;

  if (maxRes && compareResolutions(effectiveRes, maxRes) > 0) {
    return res.status(400).json({ error: `Resolution ${effectiveRes} exceeds admin max of ${maxRes}` });
  }
  if (maxDur > 0 && effectiveDur > maxDur) {
    return res.status(400).json({ error: `Duration ${effectiveDur}s exceeds admin max of ${maxDur}s` });
  }

  try {
    const body = { model, prompt, duration: effectiveDur, resolution: effectiveRes };
    if (aspect_ratio) body.aspect_ratio = aspect_ratio;
    if (generate_audio !== undefined) body.generate_audio = generate_audio;
    if (frame_images) body.frame_images = frame_images;
    if (input_references) body.input_references = input_references;

    const response = await fetch('https://openrouter.ai/api/v1/videos', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      const errorText = await response.text();
      let errorMsg = `OpenRouter error: ${errorText}`;
      try {
        const errorJson = JSON.parse(errorText);
        if (errorJson.error?.message) errorMsg = errorJson.error.message;
      } catch {}
      return res.status(400).json({ error: errorMsg });
    }

    const data = await response.json();
    const videoId = uuidv4();

    queries.logVideo.run(
      videoId, req.user.id, model, prompt,
      data.status || 'pending', data.id,
      effectiveDur, effectiveRes, aspect_ratio || null,
      generate_audio ? 1 : 0, 0, null
    );

    res.json({ id: videoId, job_id: data.id, status: data.status, polling_url: data.polling_url });
  } catch (error) {
    console.error('Video generation error:', error);
    res.status(500).json({ error: error.message });
  }
});

router.get('/list', requireAuth, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 100);
  const offset = parseInt(req.query.offset) || 0;
  const status = req.query.status;

  let logs;
  if (status) {
    logs = db.prepare('SELECT * FROM video_logs WHERE user_id = ? AND status = ? ORDER BY created_at DESC LIMIT ? OFFSET ?')
      .all(req.user.id, status, limit, offset);
  } else {
    logs = queries.getVideoLogsByUser.all(req.user.id, limit, offset);
  }

  res.json({
    logs: logs.map(l => ({
      ...l,
      video_url: l.video_path ? `/api/video/download/${l.id}` : null,
      prompt_short: (l.prompt || '').slice(0, 80)
    }))
  });
});

router.get('/download/:id', (req, res) => {
  const video = queries.getVideoById.get(req.params.id);
  if (!video || !video.video_path) return res.status(404).json({ error: 'Not found' });
  const filepath = path.join(VIDEOS_DIR, video.video_path);
  if (!fs.existsSync(filepath)) return res.status(404).json({ error: 'File not found' });
  res.sendFile(filepath);
});

router.delete('/delete/:id', requireAuth, (req, res) => {
  const video = queries.getVideoById.get(req.params.id);
  if (!video) return res.status(404).json({ error: 'Not found' });
  if (video.user_id !== req.user.id && !req.user.is_admin) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  if (video.video_path) deleteVideoFile(video.video_path);
  db.prepare('DELETE FROM video_logs WHERE id = ?').run(req.params.id);
  db.prepare('DELETE FROM video_notifications WHERE video_id = ?').run(req.params.id);
  res.json({ success: true });
});

router.get('/jobs', requireAuth, (req, res) => {
  const ids = req.query.ids ? req.query.ids.split(',') : [];
  if (ids.length === 0) return res.json({ jobs: [] });
  const placeholders = ids.map(() => '?').join(',');
  const jobs = db.prepare(`SELECT id, status FROM video_logs WHERE id IN (${placeholders})`).all(...ids);
  res.json({ jobs });
});

router.get('/notifications', requireAuth, (req, res) => {
  const notifications = queries.getUnseenNotifications.all(req.user.id);
  res.json({
    count: notifications.length,
    videos: notifications.map(n => ({
      id: n.video_id,
      prompt_snippet: (n.prompt || '').slice(0, 60)
    }))
  });
});

router.post('/notifications/mark-seen', requireAuth, (req, res) => {
  const { video_id } = req.body;
  if (video_id) {
    queries.markVideoNotificationSeen.run(req.user.id, video_id);
  } else {
    queries.markNotificationsSeen.run(req.user.id);
  }
  res.json({ success: true });
});

export default router;
```

### Task 4: Video worker -- background polling

**Files:**
- Create: `src/video-worker.js`

- [ ] **Step 1: Create `src/video-worker.js`**

```js
import db from './db.js';
import { getSetting } from './db.js';
import { saveVideoFromBuffer } from './video-storage.js';
import { v4 as uuidv4 } from 'uuid';

const POLL_INTERVAL = 15_000;
let intervalHandle = null;

export function startVideoWorker() {
  console.log('Video worker started (polling every 15s)');
  intervalHandle = setInterval(pollActiveJobs, POLL_INTERVAL);
}

export function stopVideoWorker() {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}

async function pollActiveJobs() {
  const apiKey = getSetting('openrouter_api_key');
  if (!apiKey) return;

  try {
    const jobs = db.prepare("SELECT * FROM video_logs WHERE status IN ('pending', 'in_progress')").all();

    for (const job of jobs) {
      try {
        const response = await fetch(`https://openrouter.ai/api/v1/videos/${job.job_id}`, {
          headers: { 'Authorization': `Bearer ${apiKey}` }
        });
        if (!response.ok) continue;

        const status = await response.json();
        const newStatus = status.status;

        if (newStatus === 'completed') {
          const videoUrl = status.unsigned_urls?.[0] ||
            `https://openrouter.ai/api/v1/videos/${job.job_id}/content?index=0`;

          const headers = videoUrl.includes('openrouter.ai')
            ? { 'Authorization': `Bearer ${apiKey}` }
            : {};

          const videoResponse = await fetch(videoUrl, { headers });

          if (videoResponse.ok) {
            const buffer = Buffer.from(await videoResponse.arrayBuffer());
            const filename = `${uuidv4()}.mp4`;
            saveVideoFromBuffer(buffer, filename);

            const cost = status.usage?.cost || 0;
            db.prepare('UPDATE video_logs SET status = ?, video_path = ?, cost = ?, completed_at = datetime("now"), error = ? WHERE id = ?')
              .run('completed', filename, cost, null, job.id);

            db.prepare('INSERT OR IGNORE INTO video_notifications (user_id, video_id) VALUES (?, ?)')
              .run(job.user_id, job.id);
          } else {
            db.prepare('UPDATE video_logs SET status = ?, error = ? WHERE id = ?')
              .run('failed', 'Failed to download video', job.id);
          }
        } else if (['failed', 'cancelled', 'expired'].includes(newStatus)) {
          db.prepare('UPDATE video_logs SET status = ?, error = ?, completed_at = datetime("now") WHERE id = ?')
            .run(newStatus, status.error || `Job ${newStatus}`, job.id);
        } else if (newStatus !== job.status) {
          db.prepare('UPDATE video_logs SET status = ? WHERE id = ?')
            .run(newStatus, job.id);
        }
      } catch (e) {
        console.error(`Video worker error for job ${job.id}:`, e.message);
      }
    }
  } catch (e) {
    console.error('Video worker poll error:', e.message);
  }
}
```

### Task 5: Server.js -- mount routes, start worker, add /video route

**Files:**
- Modify: `src/server.js`

- [ ] **Step 1: Add imports after line 8**

```js
import videoRoutes from './routes/video.js';
import { startVideoWorker } from './video-worker.js';
```

- [ ] **Step 2: Add route mount after line 49**

```js
app.use('/api/video', videoRoutes);
```

- [ ] **Step 3: Add page route after line 73 (after the /image route block)**

```js
app.get('/video', (req, res) => {
  if (!req.user) return res.redirect('/login.html');
  res.sendFile(path.join(__dirname, '..', 'static', 'video.html'));
});
```

- [ ] **Step 4: Add worker start inside `app.listen` callback**

```js
startVideoWorker();
```

### Task 6: Frontend -- video.html page

**Files:**
- Create: `static/video.html`

- [ ] **Step 1: Create `static/video.html`**

```html
<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
  <meta name="theme-color" content="#141414">
  <link rel="manifest" href="/manifest.json">
  <script>(function(){var t=localStorage.getItem('theme');if(t){document.documentElement.dataset.theme=t;var m=document.querySelector('meta[name=\"theme-color\"]');if(m)m.content=t==='light'?'#f5f3f0':'#141414';}})();</script>
  <title>OpenRouter Local WebUI - Video Generation</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Instrument+Sans:wght@400;500;600&family=JetBrains+Mono:wght@400&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="/css/style.css">
</head>
<body class="scrollable">
  <header class="header">
    <h1>OpenRouter Local WebUI</h1>
    <nav>
      <a href="/chat">Chat</a>
      <a href="/image">Image Gen</a>
      <a href="/video" class="active">Video Gen<span class="nav-badge hidden" id="videoBadge"></span></a>
      <a href="/api/auth/logout" onclick="logout(event)">Logout</a>
    </nav>
    <div class="user-info">
      <span id="username"></span>
      <select id="themeSelect" class="theme-select">
        <option value="dark">Dark</option>
        <option value="light">Light</option>
      </select>
    </div>
  </header>

  <div class="container">
    <div class="card">
      <h2>Generate Video</h2>

      <div class="model-select">
        <div class="model-picker">
          <input type="text" id="modelFilter" class="model-search" placeholder="Search models..." autocomplete="off">
          <div class="model-dropdown" id="modelDropdown"></div>
          <input type="hidden" id="modelSelect" value="">
        </div>
      </div>

      <div class="form-group">
        <label for="prompt">Prompt</label>
        <textarea id="prompt" rows="3" placeholder="Describe the video you want to generate..."></textarea>
      </div>

      <div class="form-group" id="refImageGroup">
        <label>Reference Images</label>
        <div class="ref-image-area" id="refFirstFrameArea">
          <input type="file" id="refFirstFrameInput" accept="image/png,image/jpeg,image/webp" hidden>
          <button class="btn btn-ghost" id="refFirstFrameBtn" type="button">First frame</button>
          <div class="ref-image-preview hidden" id="refFirstFramePreview">
            <img id="refFirstFramePreviewImg" src="">
            <button class="ref-image-remove" id="refFirstFrameRemove" type="button">&times;</button>
          </div>
        </div>
        <div class="ref-image-area" id="refLastFrameArea">
          <input type="file" id="refLastFrameInput" accept="image/png,image/jpeg,image/webp" hidden>
          <button class="btn btn-ghost" id="refLastFrameBtn" type="button">Last frame</button>
          <div class="ref-image-preview hidden" id="refLastFramePreview">
            <img id="refLastFramePreviewImg" src="">
            <button class="ref-image-remove" id="refLastFrameRemove" type="button">&times;</button>
          </div>
        </div>
        <div class="ref-image-area" id="refStyleArea">
          <input type="file" id="refStyleInput" accept="image/png,image/jpeg,image/webp" hidden>
          <button class="btn btn-ghost" id="refStyleBtn" type="button">Style reference</button>
          <div class="ref-image-preview hidden" id="refStylePreview">
            <img id="refStylePreviewImg" src="">
            <button class="ref-image-remove" id="refStyleRemove" type="button">&times;</button>
          </div>
        </div>
      </div>

      <div class="options-group">
        <button class="options-toggle" id="optionsToggle" type="button">Options</button>
        <div class="options-panel hidden" id="optionsPanel">
          <div class="options-grid">
            <div class="form-group">
              <label for="duration">Duration (s)</label>
              <select id="duration">
                <option value="5">5</option>
                <option value="8">8</option>
                <option value="10">10</option>
                <option value="15">15</option>
              </select>
            </div>
            <div class="form-group">
              <label for="resolution">Resolution</label>
              <select id="resolution">
                <option value="720p">720p</option>
                <option value="1080p">1080p</option>
                <option value="480p">480p</option>
              </select>
            </div>
            <div class="form-group">
              <label for="aspectRatio">Aspect Ratio</label>
              <select id="aspectRatio">
                <option value="16:9">16:9 (Landscape)</option>
                <option value="9:16">9:16 (Portrait)</option>
                <option value="1:1">1:1 (Square)</option>
                <option value="4:3">4:3 (Standard)</option>
                <option value="3:4">3:4 (Portrait)</option>
                <option value="21:9">21:9 (Ultrawide)</option>
              </select>
            </div>
            <div class="form-group">
              <label for="audioToggle">Generate Audio</label>
              <label class="toggle-row">
                <input type="checkbox" id="audioToggle" checked>
                <span>Audio</span>
              </label>
            </div>
          </div>
        </div>
      </div>

      <button class="btn btn-primary" id="generateBtn" style="width:100%">Generate Video</button>
      <div id="status" style="margin-top: 10px;"></div>
    </div>

    <div class="card">
      <h2>Your Videos</h2>
      <div class="tab-bar" id="videoTabs">
        <button class="tab-btn active" data-status="">All</button>
        <button class="tab-btn" data-status="pending">Pending</button>
        <button class="tab-btn" data-status="completed">Completed</button>
        <button class="tab-btn" data-status="failed">Failed</button>
      </div>
      <div class="video-grid" id="videoGrid"></div>
      <div id="loadMore" style="text-align: center; margin-top: 20px;">
        <button class="btn" id="loadMoreBtn">Load More</button>
      </div>
    </div>
  </div>

  <div id="toastContainer" class="toast-container hidden"></div>

  <div class="lightbox" id="videoLightbox" onclick="closeVideoPlayer()">
    <span class="lightbox-close">&times;</span>
    <video id="lightboxVideo" controls autoplay style="max-width: 90%; max-height: 90%;"></video>
  </div>

  <script src="/js/video.js"></script>
  <script>if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js');</script>
  <script>
    async function logout(e) {
      e.preventDefault();
      await fetch('/api/auth/logout', { method: 'POST' });
      window.location.href = '/login';
    }
    document.getElementById('username').textContent = localStorage.getItem('username') || '';
    (function(){
      var sel = document.getElementById('themeSelect');
      var meta = document.querySelector('meta[name="theme-color"]');
      if (sel) {
        sel.value = localStorage.getItem('theme') || 'dark';
        sel.addEventListener('change', function(){
          document.documentElement.dataset.theme = sel.value;
          localStorage.setItem('theme', sel.value);
          if (meta) meta.content = sel.value === 'light' ? '#f5f3f0' : '#141414';
        });
      }
    })();
  </script>
</body>
</html>
```

### Task 7: Frontend -- video.js logic

**Files:**
- Create: `static/js/video.js`

- [ ] **Step 1: Create `static/js/video.js`**

```js
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
      const al = document.querySelector('.admin-link');
      if (al) al.classList.remove('hidden');
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
    if (!res.ok) { statusEl.innerHTML = `<div class="error">Error: ${data.error}</div>`; return; }

    statusEl.innerHTML = '<div class="success">Video job submitted! Check back soon.</div>';
    loadVideos(true);
  } catch (e) {
    statusEl.innerHTML = `<div class="error">Request failed: ${e.message}</div>`;
  } finally {
    generateBtn.disabled = false;
    generateBtn.textContent = 'Generate Video';
  }
}

async function loadVideos(reset = false) {
  if (loading) return;
  if (reset) { offset = 0; videoGridEl.innerHTML = ''; activeJobIds.clear(); }

  loading = true;
  try {
    const url = `/api/video/list?limit=20&offset=${offset}${currentStatus ? '&status=' + currentStatus : ''}`;
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
    card.innerHTML = `
      <video src="${log.video_url}" preload="metadata" muted onclick="openVideoPlayer('${log.video_url}')"></video>
      <div class="play-overlay" onclick="openVideoPlayer('${log.video_url}')">&#9654;</div>
      <div class="info">${escapeHtml(log.prompt_short)}${log.prompt.length > 80 ? '...' : ''}</div>
      <div class="info">${new Date(log.created_at).toLocaleString()} | ${log.resolution || ''} | ${log.duration || ''}s</div>
      <div class="info">Cost: $${(log.cost || 0).toFixed(4)}</div>
      <div class="actions">
        <a href="${log.video_url}" download class="btn">Download</a>
        <button class="btn btn-danger" onclick="deleteVideo('${log.id}', this)">Delete</button>
      </div>
    `;
  } else if (log.status === 'pending' || log.status === 'in_progress') {
    card.innerHTML = `
      <div class="video-card-pending"><span class="loading"></span><br>${log.status === 'in_progress' ? 'Generating...' : 'Queued...'}</div>
      <div class="info">${escapeHtml(log.prompt_short)}${log.prompt.length > 80 ? '...' : ''}</div>
      <div class="info">${new Date(log.created_at).toLocaleString()}</div>
      <div class="actions">
        <button class="btn btn-danger" onclick="deleteVideo('${log.id}', this)">Cancel</button>
      </div>
    `;
  } else if (log.status === 'failed') {
    card.innerHTML = `
      <div class="video-card-failed">&#10060; Failed</div>
      <div class="info">${escapeHtml(log.prompt_short)}${log.prompt.length > 80 ? '...' : ''}</div>
      <div class="info">${new Date(log.created_at).toLocaleString()}</div>
      <div class="info">${escapeHtml(log.error || 'Unknown error')}</div>
      <div class="actions">
        <button class="btn btn-danger" onclick="deleteVideo('${log.id}', this)">Delete</button>
      </div>
    `;
  }

  return card;
}

async function pollActiveJobs() {
  if (activeJobIds.size === 0) return;
  const ids = Array.from(activeJobIds).join(',');
  try {
    const res = await fetch(`/api/video/jobs?ids=${ids}`);
    const data = await res.json();
    for (const job of data.jobs) {
      if (job.status === 'completed' || job.status === 'failed') {
        activeJobIds.delete(job.id);
      }
    }
    if (data.jobs.some(j => j.status !== 'pending' && j.status !== 'in_progress')) {
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
        showToast('Video ready: "' + escapeHtml(v.prompt_snippet) + (v.prompt_snippet.length >= 60 ? '...' : '') + '"');
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
  toast.onclick = () => { window.location.href = '/video'; };
  toastContainer.appendChild(toast);
  setTimeout(() => { toast.remove(); if (toastContainer.children.length === 0) toastContainer.classList.add('hidden'); }, 5000);
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function renderDropdown(models) {
  modelDropdown.innerHTML = models.map(m =>
    '<div class="model-dropdown-item" data-value="' + m.id + '">' + (m.name || m.id) + '</div>'
  ).join('');
}

function filterDropdown(term) {
  const filtered = videoModels.filter(m =>
    (m.name || m.id).toLowerCase().includes(term.toLowerCase())
  );
  if (filtered.length === 0) {
    modelDropdown.innerHTML = '<div class="model-dropdown-empty">No models found</div>';
  } else {
    modelDropdown.innerHTML = filtered.map(m =>
      '<div class="model-dropdown-item" data-value="' + m.id + '">' + (m.name || m.id) + '</div>'
    ).join('');
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
  btnEl.textContent = btnEl === refFirstFrameBtn ? 'First frame' : btnEl === refLastFrameBtn ? 'Last frame' : 'Style reference';
}

// Event listeners
refFirstFrameBtn.addEventListener('click', () => refFirstFrameInput.click());
refFirstFrameInput.addEventListener('change', () => handleRefImage(refFirstFrameInput.files[0], refFirstFramePreview, refFirstFramePreviewImg, refFirstFrameBtn, v => refFirstFrameBase64 = v));
refFirstFrameRemove.addEventListener('click', () => removeRefImage(refFirstFramePreview, refFirstFrameInput, refFirstFrameBtn, v => refFirstFrameBase64 = v));

refLastFrameBtn.addEventListener('click', () => refLastFrameInput.click());
refLastFrameInput.addEventListener('change', () => handleRefImage(refLastFrameInput.files[0], refLastFramePreview, refLastFramePreviewImg, refLastFrameBtn, v => refLastFrameBase64 = v));
refLastFrameRemove.addEventListener('click', () => removeRefImage(refLastFramePreview, refLastFrameInput, refLastFrameBtn, v => refLastFrameBase64 = v));

refStyleBtn.addEventListener('click', () => refStyleInput.click());
refStyleInput.addEventListener('change', () => handleRefImage(refStyleInput.files[0], refStylePreview, refStylePreviewImg, refStyleBtn, v => refStyleBase64 = v));
refStyleRemove.addEventListener('click', () => removeRefImage(refStylePreview, refStyleInput, refStyleBtn, v => refStyleBase64 = v));

optionsToggle.addEventListener('click', () => {
  optionsPanel.classList.toggle('hidden');
  optionsToggle.classList.toggle('open');
});

modelFilterInput.addEventListener('input', () => {
  const term = modelFilterInput.value.trim();
  modelDropdown.classList.add('open');
  if (term) filterDropdown(term); else renderDropdown(videoModels);
});

modelFilterInput.addEventListener('focus', () => {
  if (videoModels.length > 0) {
    modelDropdown.classList.add('open');
    const term = modelFilterInput.value.trim();
    if (term) filterDropdown(term); else renderDropdown(videoModels);
  }
});

modelDropdown.addEventListener('click', (e) => {
  const item = e.target.closest('.model-dropdown-item');
  if (item) {
    modelSelect.value = item.dataset.value;
    modelFilterInput.value = item.textContent;
    localStorage.setItem('lastVideoModelId', item.dataset.value);
    modelDropdown.classList.remove('open');
  }
});

document.addEventListener('click', (e) => {
  if (!modelFilterInput.parentElement.contains(e.target)) {
    modelDropdown.classList.remove('open');
  }
});

generateBtn.addEventListener('click', generate);
loadMoreBtn.addEventListener('click', () => loadVideos());

// Tabs
document.querySelectorAll('#videoTabs .tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#videoTabs .tab-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentStatus = btn.dataset.status;
    loadVideos(true);
  });
});

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') closeVideoPlayer();
});

checkAuth().then(() => {
  loadModels();
  loadVideos();
  setInterval(pollActiveJobs, 5000);
  setInterval(pollNotifications, 10000);
});
```

### Task 8: CSS -- video styles, toast, badge

**Files:**
- Modify: `static/css/style.css`

- [ ] **Step 1: Add video grid styles**

```css
.video-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 16px;
  margin-top: 16px;
}

.video-card {
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: 8px;
  overflow: hidden;
  position: relative;
}

.video-card video {
  width: 100%;
  height: 180px;
  object-fit: cover;
  background: #000;
  cursor: pointer;
  display: block;
}

.video-card .play-overlay {
  position: absolute;
  top: 70px;
  left: 50%;
  transform: translateX(-50%);
  width: 48px;
  height: 48px;
  background: rgba(0,0,0,0.6);
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #fff;
  font-size: 20px;
  cursor: pointer;
  pointer-events: none;
}

.video-card .info {
  padding: 8px 12px;
  font-size: 12px;
  color: var(--text-2);
}

.video-card .actions {
  padding: 8px 12px;
  display: flex;
  gap: 8px;
}

.video-card-pending {
  height: 180px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  background: var(--surface-2);
  color: var(--text-2);
  font-size: 14px;
}

.video-card-failed {
  height: 180px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--surface-2);
  color: var(--danger);
  font-size: 24px;
}
```

- [ ] **Step 2: Add toast styles**

```css
.toast-container {
  position: fixed;
  bottom: 20px;
  right: 20px;
  z-index: 10000;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.toast {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 12px 16px;
  color: var(--text);
  font-size: 13px;
  cursor: pointer;
  box-shadow: 0 4px 12px rgba(0,0,0,0.3);
  animation: slideIn 0.3s ease;
  max-width: 320px;
}

@keyframes slideIn {
  from { transform: translateX(100%); opacity: 0; }
  to { transform: translateX(0); opacity: 1; }
}
```

- [ ] **Step 3: Add nav badge styles**

```css
.nav-badge {
  background: var(--danger);
  color: #fff;
  font-size: 10px;
  padding: 1px 5px;
  border-radius: 10px;
  margin-left: 4px;
  vertical-align: top;
}

.hidden {
  display: none !important;
}
```

- [ ] **Step 4: Add tab bar styles (if not already present)**

```css
.tab-bar {
  display: flex;
  gap: 4px;
  margin-bottom: 12px;
  border-bottom: 1px solid var(--border);
  padding-bottom: 8px;
}

.tab-btn {
  background: none;
  border: none;
  color: var(--text-2);
  padding: 6px 14px;
  cursor: pointer;
  font-size: 13px;
  border-radius: 6px;
}

.tab-btn.active {
  background: var(--accent-dim);
  color: var(--accent);
}

.tab-btn:hover {
  color: var(--text);
}
```

### Task 9: Navigation -- add Video Gen link to all pages

**Files:**
- Modify: `static/index.html`
- Modify: `static/image.html`
- Modify: `static/admin.html`

- [ ] **Step 1: Add Video Gen nav link after Image Gen**

In each file, find the `<nav>` section and add after the Image Gen link:
```html
<a href="/video">Video Gen<span class="nav-badge hidden" id="videoBadge"></span></a>
```

- [ ] **Step 2: Add badge polling script to each page**

Add before the closing `</body>` tag:
```html
<script>
(async function pollVideoBadge() {
  try {
    const res = await fetch('/api/video/notifications');
    const data = await res.json();
    const badge = document.getElementById('videoBadge');
    if (badge) {
      if (data.count > 0) { badge.textContent = data.count; badge.classList.remove('hidden'); }
      else { badge.classList.add('hidden'); }
    }
  } catch(e) {}
  setTimeout(pollVideoBadge, 10000);
})();
</script>
```

### Task 10: Admin -- Video Logs tab

**Files:**
- Modify: `src/routes/admin.js`
- Modify: `static/admin.html`
- Modify: `static/js/admin.js`

- [ ] **Step 1: Add admin video-logs endpoint to `src/routes/admin.js`**

```js
router.get('/video-logs', requireAdmin, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 20, 100);
  const offset = parseInt(req.query.offset) || 0;
  const userId = req.query.user_id || null;
  const logs = userId ? queries.getVideoLogsByUser.all(userId, limit, offset) : queries.getVideoLogs.all(limit, offset);
  const count = userId ? queries.countVideoLogsByUser.get(userId).count : queries.countVideoLogs.get().count;
  res.json({ logs, total: count });
});
```

- [ ] **Step 2: Add video models endpoint to admin route**

```js
router.get('/video-models', requireAdmin, async (req, res) => {
  const apiKey = getSetting('openrouter_api_key');
  if (!apiKey) return res.json({ models: [] });
  try {
    const response = await fetch('https://openrouter.ai/api/v1/videos/models', {
      headers: { 'Authorization': `Bearer ${apiKey}` }
    });
    if (!response.ok) return res.json({ models: [] });
    const data = await response.json();
    res.json({ models: data.data || [] });
  } catch {
    res.json({ models: [] });
  }
});
```

- [ ] **Step 3: Add settings save for video limits in admin route settings endpoint**

Add these to the save/load settings logic:
```js
// In load settings:
'max_video_resolution': getSetting('max_video_resolution', ''),
'max_video_duration': getSetting('max_video_duration', '0'),

// In save settings (if using a generic save endpoint):
if (key.startsWith('max_video_')) setSetting(key, value);
```

If the admin settings endpoint uses a single POST to save all, add the video limit fields to the update handler.

- [ ] **Step 4: Add Video Logs tab button and section to `static/admin.html`**

After the Image Logs tab button:
```html
<button data-tab="video-logs">Video Logs</button>
```

Add the section after the image-logs section:
```html
<div id="video-logs" class="admin-section">
  <h2>Video Logs</h2>
  <div style="margin-bottom: 10px;">
    <select id="videoLogUser" style="width: auto; margin-right: 10px;">
      <option value="">All Users</option>
    </select>
    <button class="btn" onclick="loadVideoLogs()">Filter</button>
  </div>
  <table>
    <thead><tr>
      <th>User</th><th>Prompt</th><th>Status</th><th>Duration</th><th>Res</th><th>Preview</th><th>Cost</th><th>Created</th>
    </tr></thead>
    <tbody id="videoLogsTable"></tbody>
  </table>
  <div id="videoLogsPagination" style="margin-top: 15px; text-align: center;"></div>
</div>
```

Add Video Limits fields in the Settings section:
```html
<h3>Video Generation Limits</h3>
<div class="form-group">
  <label>Max Video Resolution</label>
  <select id="maxVideoResolution">
    <option value="">No limit</option>
    <option value="480p">480p</option>
    <option value="720p">720p</option>
    <option value="1080p">1080p</option>
  </select>
</div>
<div class="form-group">
  <label>Max Video Duration (seconds, 0 = no limit)</label>
  <input type="number" id="maxVideoDuration" min="0" max="300" value="0">
</div>
```

- [ ] **Step 5: Add admin video JS logic to `static/js/admin.js`**

Add alongside the existing `imageLogsOffset`:
```js
let videoLogsOffset = 0;
```

Add tab activation handler:
```js
if (btn.dataset.tab === 'video-logs') loadVideoLogs();
```

Add `loadVideoLogs()` function (mirrors `loadImageLogs()`):
```js
async function loadVideoLogs(offset = 0) {
  videoLogsOffset = offset;
  const userId = document.getElementById('videoLogUser').value;
  const url = `/api/admin/video-logs?limit=20&offset=${offset}${userId ? `&user_id=${userId}` : ''}`;
  const res = await fetch(url);
  const data = await res.json();
  const table = document.getElementById('videoLogsTable');
  table.innerHTML = data.logs.map(l => `
    <tr>
      <td>${escapeHtml(l.username)}</td>
      <td>${escapeHtml((l.prompt || '').slice(0, 50))}</td>
      <td>${l.status}</td>
      <td>${l.duration || '-'}s</td>
      <td>${l.resolution || '-'}</td>
      <td>${l.video_path ? `<video src="/api/video/download/${l.id}" width="80" controls preload="metadata"></video>` : '-'}</td>
      <td>$${(l.cost || 0).toFixed(4)}</td>
      <td>${new Date(l.created_at).toLocaleString()}</td>
    </tr>
  `).join('') || '<tr><td colspan="8">No videos found</td></tr>';
  const total = data.total || 0;
  const pagination = document.getElementById('videoLogsPagination');
  pagination.innerHTML = '';
  if (offset > 0) pagination.innerHTML += `<button class="btn" onclick="loadVideoLogs(${offset - 20})">Previous</button> `;
  if (offset + 20 < total) pagination.innerHTML += `<button class="btn" onclick="loadVideoLogs(${offset + 20})">Next</button>`;
}
```

Add video limits load/save in the settings functions:
```js
// In loadSettings, after loading other settings:
document.getElementById('maxVideoResolution').value = data.max_video_resolution || '';
document.getElementById('maxVideoDuration').value = data.max_video_duration || '0';

// In saveSettings, add video limit saves:
await fetch('/api/admin/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
  key: 'max_video_resolution', value: document.getElementById('maxVideoResolution').value
})});
await fetch('/api/admin/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
  key: 'max_video_duration', value: document.getElementById('maxVideoDuration').value
})});
```

Add user dropdown population for video logs (mirrors image logs):
```js
const videoUserSelect = document.getElementById('videoLogUser');
if (videoUserSelect) {
  videoUserSelect.innerHTML = '<option value="">All Users</option>' + options;
}
```

### Task 11: Docker -- video volume

**Files:**
- Modify: `docker-compose.yml`

- [ ] **Step 1: Add volume and mount**

Add to `volumes:` section:
```yaml
  openrouter-videos:
```

Add to `services.app.volumes:`:
```yaml
      - openrouter-videos:/app/generated-videos
```

### Task 12: Verify the full stack

- [ ] **Step 1: Start the server**

```bash
npm start
```

- [ ] **Step 2: Verify routes are registered**

Server should start without errors. Check console logs for "Video worker started (polling every 15s)".

- [ ] **Step 3: Verify the video page loads**

Open `http://localhost:3000/video` -- should see the video generation page with model dropdown, prompt, etc.

- [ ] **Step 4: Verify notification polling works**

Open any page (chat, image, admin) -- the badge polling script should run every 10s without errors.

- [ ] **Step 5: Verify video models API**

```bash
curl http://localhost:3000/api/video/models -H "Cookie: <session_cookie>"
```

Should return a list of video models.
