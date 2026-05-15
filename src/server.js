import express from 'express';
import session from 'express-session';
import path from 'path';
import { fileURLToPath } from 'url';
import authRoutes from './routes/auth.js';
import chatRoutes from './routes/chat.js';
import conversationsRoutes from './routes/conversations.js';
import imageRoutes from './routes/image.js';
import adminRoutes from './routes/admin.js';
import { optionalAuth } from './auth.js';
import db from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

app.use(session({
  secret: process.env.SESSION_SECRET || 'openrouter-local-webui-secret-change-in-production',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    maxAge: 7 * 24 * 60 * 60 * 1000
  }
}));

app.use((req, res, next) => {
  if (req.session && req.session.userId) {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
    if (user) {
      req.user = user;
    }
  }
  next();
});

app.use('/api/auth', authRoutes);
app.use('/api/chat', chatRoutes);
app.use('/api/conversations', conversationsRoutes);
app.use('/api/image', imageRoutes);
app.use('/api/admin', adminRoutes);

app.use(express.static(path.join(__dirname, '..', 'static')));

app.get('/', (req, res) => {
  if (!req.user) {
    return res.redirect('/login.html');
  }
  res.sendFile(path.join(__dirname, '..', 'static', 'index.html'));
});

app.get('/chat', (req, res) => {
  if (!req.user) {
    return res.redirect('/login.html');
  }
  res.sendFile(path.join(__dirname, '..', 'static', 'index.html'));
});

app.get('/image', (req, res) => {
  if (!req.user) {
    return res.redirect('/login.html');
  }
  res.sendFile(path.join(__dirname, '..', 'static', 'image.html'));
});

app.get('/admin', (req, res) => {
  if (!req.user || !req.user.is_admin) {
    return res.redirect('/chat');
  }
  res.sendFile(path.join(__dirname, '..', 'static', 'admin.html'));
});

app.get('/login', (req, res) => {
  if (req.user) {
    return res.redirect('/chat');
  }
  res.sendFile(path.join(__dirname, '..', 'static', 'login.html'));
});

app.use((req, res) => {
  res.status(404).send('Not found');
});

app.listen(PORT, () => {
  console.log(`OpenRouter Local WebUI running on http://localhost:${PORT}`);
});