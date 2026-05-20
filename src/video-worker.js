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
            db.prepare(`UPDATE video_logs SET status = ?, video_path = ?, cost = ?, completed_at = datetime('now'), error = ? WHERE id = ?`)
              .run('completed', filename, cost, null, job.id);

            db.prepare('INSERT OR IGNORE INTO video_notifications (user_id, video_id) VALUES (?, ?)')
              .run(job.user_id, job.id);
          } else {
            db.prepare(`UPDATE video_logs SET status = ?, error = ?, completed_at = datetime('now') WHERE id = ?`)
              .run('failed', 'Failed to download video', job.id);
          }
        } else if (['failed', 'cancelled', 'expired'].includes(newStatus)) {
          db.prepare(`UPDATE video_logs SET status = ?, error = ?, completed_at = datetime('now') WHERE id = ?`)
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
