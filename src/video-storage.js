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
