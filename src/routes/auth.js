import express from 'express';
import { queries } from '../db.js';
import { hashPassword, verifyPassword } from '../auth.js';
import { requireAuth } from '../auth.js';

const router = express.Router();

router.post('/register', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required' });
    }
    if (username.length < 3 || username.length > 32) {
      return res.status(400).json({ error: 'Username must be 3-32 characters' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }
    const existing = queries.getUserByUsername.get(username);
    if (existing) {
      return res.status(400).json({ error: 'Username already taken' });
    }
    const userCount = queries.getAllUsers.all();
    const isAdmin = userCount.length === 0 ? 1 : 0;
    const passwordHash = await hashPassword(password);
    const result = queries.createUser.run(username, passwordHash, isAdmin);
    req.session.userId = result.lastInsertRowid;
    res.json({
      user: {
        id: result.lastInsertRowid,
        username,
        is_admin: isAdmin
      }
    });
  } catch (error) {
    console.error('Register error:', error);
    res.status(500).json({ error: 'Registration failed' });
  }
});

router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required' });
    }
    const user = queries.getUserByUsername.get(username);
    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    const valid = await verifyPassword(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    req.session.userId = user.id;
    res.json({
      user: {
        id: user.id,
        username: user.username,
        is_admin: user.is_admin
      }
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Login failed' });
  }
});

router.post('/logout', (req, res) => {
  if (req.session) {
    req.session.destroy();
  }
  res.json({ success: true });
});

router.get('/me', requireAuth, (req, res) => {
  res.json({
    user: {
      id: req.user.id,
      username: req.user.username,
      is_admin: req.user.is_admin
    }
  });
});

export default router;