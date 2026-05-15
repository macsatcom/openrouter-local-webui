import express from 'express';
import { requireAuth } from '../auth.js';
import { queries } from '../db.js';

const router = express.Router();

router.get('/', requireAuth, (req, res) => {
  const conversations = queries.getConversations.all(req.user.id);
  res.json({ conversations });
});

router.post('/', requireAuth, (req, res) => {
  const { title } = req.body;
  const conversationTitle = title || 'New conversation';
  const result = queries.createConversation.run(req.user.id, conversationTitle);
  res.json({
    conversation: {
      id: result.lastInsertRowid,
      user_id: req.user.id,
      title: conversationTitle,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    }
  });
});

router.get('/:id', requireAuth, (req, res) => {
  const conversationId = parseInt(req.params.id);
  const conversation = queries.getConversationById.get(conversationId, req.user.id);
  if (!conversation) {
    return res.status(404).json({ error: 'Conversation not found' });
  }
  const messages = queries.getConversationMessages.all(conversationId);
  res.json({ conversation, messages });
});

router.put('/:id', requireAuth, (req, res) => {
  const conversationId = parseInt(req.params.id);
  const { title } = req.body;
  if (!title) {
    return res.status(400).json({ error: 'Title required' });
  }
  const result = queries.updateConversationTitle.run(title, conversationId, req.user.id);
  if (result.changes === 0) {
    return res.status(404).json({ error: 'Conversation not found' });
  }
  const conversation = queries.getConversationById.get(conversationId, req.user.id);
  res.json({ conversation });
});

router.delete('/:id', requireAuth, (req, res) => {
  const conversationId = parseInt(req.params.id);
  const result = queries.deleteConversation.run(conversationId, req.user.id);
  if (result.changes === 0) {
    return res.status(404).json({ error: 'Conversation not found' });
  }
  res.json({ success: true });
});

export default router;