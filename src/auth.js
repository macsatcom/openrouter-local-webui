import bcrypt from 'bcrypt';
import { queries } from './db.js';

export async function hashPassword(password) {
  return bcrypt.hash(password, 10);
}

export async function verifyPassword(password, hash) {
  return bcrypt.compare(password, hash);
}

export function requireAuth(req, res, next) {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const user = queries.getUserById.get(req.session.userId);
  if (!user) {
    req.session.destroy();
    return res.status(401).json({ error: 'Unauthorized' });
  }
  req.user = user;
  next();
}

export function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (!req.user.is_admin) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    next();
  });
}

export function optionalAuth(req, res, next) {
  if (req.session && req.session.userId) {
    const user = queries.getUserById.get(req.session.userId);
    if (user) {
      req.user = user;
    }
  }
  next();
}