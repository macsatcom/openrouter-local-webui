# Video Generation Design

## Overview

Add a fully featured video generation page to OpenRouter Local WebUI, mirroring the existing image generation page but adapted for OpenRouter's async video API (`POST /api/v1/videos`). Supports text-to-video, image-to-video (first/last frame), reference-to-video (style guidance), and audio toggle.

## Architecture

### Video API Differences from Image Gen

| Aspect | Image Gen | Video Gen |
|---|---|---|
| Endpoint | `POST /api/v1/chat/completions` (sync) | `POST /api/v1/videos` (async) |
| Model discovery | `GET /api/v1/models?output_modalities=image` | `GET /api/v1/videos/models` |
| Response | Returns image inline | Returns job ID -> poll/download |
| Pricing | Per image | Per video second |
| Duration | N/A | Configurable (seconds, varies by model) |

### New Files

| File | Purpose |
|---|---|
| `src/routes/video.js` | Express router: models, generate, list, notifications, download, delete |
| `src/video-worker.js` | Background polling worker (setInterval, checks active jobs, downloads MP4s) |
| `src/video-storage.js` | File storage helpers for generated videos (mirrors image pattern) |
| `static/video.html` | Video generation page |
| `static/js/video.js` | Video page frontend logic |

### Modified Files

| File | Changes |
|---|---|
| `src/server.js` | Mount `/api/video` routes, start video worker on boot, add `/video` route |
| `src/db.js` | Add `video_logs` table + queries |
| `src/routes/admin.js` | Add `/api/admin/video-logs` endpoint + video model filtering for admin |
| `static/admin.html` | Add "Video Logs" tab + video limit settings |
| `static/js/admin.js` | Video logs tab logic + limit settings |
| `static/index.html` | Add "Video Gen" nav link with notification badge |
| `static/image.html` | Add "Video Gen" nav link |
| `static/admin.html` | Add "Video Gen" nav link |
| `static/css/style.css` | Video card, play overlay, toast, badge styles |
| `docker-compose.yml` | Mount `generated-videos` volume |

## Database

### New Table: `video_logs`

```sql
CREATE TABLE IF NOT EXISTS video_logs (
  id           TEXT PRIMARY KEY,
  user_id      INTEGER NOT NULL,
  model        TEXT NOT NULL,
  prompt       TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending',  -- pending | in_progress | completed | failed
  job_id       TEXT,                              -- OpenRouter job ID
  video_path   TEXT,                              -- path to saved MP4
  duration     INTEGER,                           -- requested seconds
  resolution   TEXT,                              -- e.g. "720p"
  aspect_ratio TEXT,                              -- e.g. "16:9"
  has_audio    INTEGER DEFAULT 0,
  cost         REAL DEFAULT 0,
  error        TEXT,
  created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
  completed_at DATETIME,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
```

### New Table: `video_notifications`

```sql
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

### New Prepared Queries

Mirroring the image_logs pattern:
- `getVideoLogsByUser` -- paginated by user
- `getVideoLogs` -- paginated all (admin)
- `countVideoLogsByUser`, `countVideoLogs`
- `getActiveVideoJobs` -- for worker polling
- `updateVideoJobStatus` -- worker updates
- `insertVideoNotification`, `getUnseenVideoNotifications`, `markVideoNotificationsSeen`

## Backend: Video Route (`src/routes/video.js`)

### Endpoints

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/api/video/models` | requireAuth | Fetch video models from OpenRouter, filter by user permissions |
| POST | `/api/video/generate` | requireAuth | Submit video job to OpenRouter, save to DB, return job info |
| GET | `/api/video/list` | requireAuth | Paginated list of user's videos, with optional `status` filter |
| GET | `/api/video/notifications` | requireAuth | Return count of unseen completed videos for badge/toast |
| POST | `/api/video/notifications/mark-seen` | requireAuth | Mark notifications as seen |
| GET | `/api/video/download/:id` | -- | Serve video file by DB id |
| DELETE | `/api/video/delete/:id` | requireAuth | Delete video file + DB record |
| GET | `/api/video/jobs` | requireAuth | Return status for specific video IDs (for frontend auto-refresh) |

### `POST /api/video/generate` Flow

1. Check spend limit
2. Validate model + prompt
3. Enforce admin caps (max resolution, max duration)
4. Call `POST https://openrouter.ai/api/v1/videos` with the payload
5. Save to `video_logs` with `status=pending` and the returned `job_id`
6. Return `{ id, status: 'pending' }` immediately

### Model Formatting

Video models have per-second pricing SKUs. Display as:
```
Google: Veo 3.1 Lite ($0.13/s)
ByteDance: Seedance 2.0 Fast ($0.000006/s)
```

## Backend: Video Worker (`src/video-worker.js`)

### Behavior

- Started once in `server.js` after app boots
- Runs `setInterval` every 15s
- Queries `video_logs` for `status IN ('pending', 'in_progress')`
- For each active job:
  1. Fetch `GET https://openrouter.ai/api/v1/videos/{job_id}`
  2. If `status === 'completed'`:
     - Download MP4 from `unsigned_urls[0]` or content endpoint
     - Save to `generated-videos/` with UUID filename
     - Update DB: `status='completed'`, `video_path`, `cost`, `completed_at`
     - Insert `video_notification` for the user
  3. If `status === 'failed'` | `'cancelled'` | `'expired'`:
     - Update DB: status, error field
  4. If still `pending` / `in_progress`: update DB status
- Cleans up old notification records periodically

## Frontend: Video Page (`static/video.html` + `static/js/video.js`)

### Page Layout

Modeled on `image.html` with these differences:

**Form section:**
- Searchable model dropdown (fetched from `/api/video/models`)
- Prompt textarea
- Reference images section with three modes:
  - First frame upload (image-to-video)
  - Last frame upload (image-to-video)
  - Style reference images (reference-to-video, can add multiple)
- Options panel:
  - Duration dropdown
  - Resolution dropdown (480p / 720p / 1080p)
  - Aspect ratio dropdown (16:9 / 9:16 / 1:1 / etc.)
  - Audio toggle checkbox
- Generate button

**Gallery section:**
- Tab bar: All | Pending | Completed | Failed
- Video cards in grid:
  - Pending: animated skeleton/spinner + "Generating..." + timestamp
  - Completed: `<video>` element with poster + play button overlay
  - Failed: error icon + error message
- Load more pagination
- Inline download + delete buttons on each card

**Lightbox:** Video player lightbox (click card to open video in overlay).

### Notification System

Frontend-side:
- `setInterval` every 10s calls `GET /api/video/notifications` -> returns `{ count, videos: [{id, prompt_snippet}] }`
- If `count > 0`: update badge on nav "Video Gen" link
- If count increased since last check: show toast notification
- Toast auto-dismisses after 5s
- Clicking toast navigates to video page
- Marking seen: poll `/api/video/notifications/mark-seen` when visiting video page or dismissing toast

### Auto-Status Refresh

When on the video page, frontend polls `GET /api/video/jobs?ids=id1,id2` every 5s for any jobs still in pending/in_progress state, and updates their cards in-place.

## Navigation Changes

### Nav Link Badge

All pages with nav links get a "Video Gen" link:
```html
<a href="/video">Video Gen<span class="nav-badge hidden" id="videoBadge"></span></a>
```

### Nav Link Order
Chat -> Image Gen -> **Video Gen** -> Admin (if admin) -> Logout

## Admin Panel

### New Tab: Video Logs
- Mirrors Image Logs tab
- User filter dropdown
- Table columns: ID, User, Model, Prompt, Status, Duration, Resolution, Preview (video thumbnail), Cost, Created At
- Pagination controls
- Preview opens video player

### New Settings: Video Generation Limits
- Max resolution dropdown (No limit / 480p / 720p / 1080p)
- Max duration number input (0 = no limit)
- Enforced server-side on generate: cap resolution and duration to admin limits
- Capped models filtered from dropdown

### Model Management
- Admin can set per-user video model restrictions
- Models fetched via `GET /api/v1/videos/models`
- Same UI pattern as image model selection

## Docker & Storage

### New Volume
```yaml
volumes:
  openrouter-videos:

services:
  app:
    volumes:
      - openrouter-videos:/app/generated-videos
```

### Server-Side Video Storage
- Videos saved to `generated-videos/` directory (configurable via `VIDEOS_DIR` env var)
- No extra system dependencies -- MP4 is standard browser-playable format

## Error Handling

### User-Facing Errors
- Spending limit exceeded -> same 429 as image gen, shows user-friendly message
- Model not available -> dropdown filter hides unavailable models
- Generation failed -> status shows error from OpenRouter in card
- Admin caps exceeded -> clear error message with the cap value

### Worker Errors
- OpenRouter API down -> retry on next poll cycle (15s), log to server console
- Download failure -> mark job as failed with error detail
- Recoverable: if worker crashes and restarts, it picks up all pending/in_progress jobs from DB
