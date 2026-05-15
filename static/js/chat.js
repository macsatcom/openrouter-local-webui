const modelSelect = document.getElementById('modelSelect');
const modelFilterInput = document.getElementById('modelFilter');
const modelDropdown = document.getElementById('modelDropdown');
const skillSelect = document.getElementById('skillSelect');
const messagesEl = document.getElementById('messages');
const inputEl = document.getElementById('input');
const sendBtn = document.getElementById('sendBtn');
const clearBtn = document.getElementById('clearBtn');
const conversationsListEl = document.getElementById('conversationsList');
const chatAreaEl = document.getElementById('chatArea');
const emptyStateEl = document.getElementById('emptyState');

let currentUser = null;
let currentConversationId = null;
let conversations = [];
let chatModels = [];

async function checkAuth() {
  try {
    const res = await fetch('/api/auth/me');
    if (!res.ok) throw new Error();
    const data = await res.json();
    currentUser = data.user;
    localStorage.setItem('username', currentUser.username);
  } catch {
    window.location.href = '/login';
  }
}

async function loadModels() {
  try {
    const res = await fetch('/api/chat/models');
    const data = await res.json();
    chatModels = data.models;
    renderDropdown(chatModels);
  } catch (e) {
    console.error('Failed to load models:', e);
  }
}

async function loadSkills() {
  if (!currentUser?.is_admin) {
    skillSelect.parentElement.style.display = 'none';
    return;
  }
  try {
    const res = await fetch('/api/admin/skills');
    const data = await res.json();
    skillSelect.innerHTML = '<option value="">None</option>' + data.skills.map(s => `<option value="${s.id}">${s.name}</option>`).join('');
  } catch {}
}

async function loadConversations() {
  try {
    const res = await fetch('/api/conversations');
    console.log('loadConversations status:', res.status);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    conversations = data.conversations || [];
    console.log('Loaded conversations:', conversations.length);
    renderConversations();
  } catch (e) {
    console.error('Failed to load conversations:', e);
  }
}

function renderConversations() {
  console.log('renderConversations called, count:', conversations.length);
  console.log('conversationsListEl:', conversationsListEl);
  if (!conversationsListEl) {
    console.error('conversationsListEl is null!');
    return;
  }
  if (conversations.length === 0) {
    conversationsListEl.innerHTML = '<div class="chat-empty" style="padding: 24px; height: auto;">No conversations yet</div>';
    return;
  }
  conversationsListEl.innerHTML = conversations.map(c => `
    <div class="conversation-item ${c.id === currentConversationId ? 'active' : ''}" data-id="${c.id}" onclick="selectConversation(${c.id})">
      <span class="conversation-title" id="title-${c.id}" ondblclick="editTitle(${c.id}, event)" title="Double-click to rename">${escapeHtml(c.title)}</span>
      <button class="conversation-delete" onclick="deleteConversation(${c.id}, event)">×</button>
    </div>
  `).join('');
}

async function newConversation() {
  console.log('newConversation called');
  try {
    const res = await fetch('/api/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'New conversation' })
    });
    if (!res.ok) throw new Error('Failed to create conversation');
    const data = await res.json();
    currentConversationId = data.conversation.id;
    localStorage.setItem('lastConversationId', currentConversationId);
    clearMessages();
    chatAreaEl.style.display = '';
    emptyStateEl.style.display = 'none';
    loadConversations();
    inputEl.focus();
  } catch (e) {
    console.error('newConversation error:', e);
    alert('Error creating new chat: ' + e.message);
  }
}

async function selectConversation(id) {
  currentConversationId = id;
  localStorage.setItem('lastConversationId', id);

  try {
    const res = await fetch(`/api/conversations/${id}`);
    const data = await res.json();
    renderMessages(data.messages);
    chatAreaEl.style.display = '';
    emptyStateEl.style.display = 'none';
    renderConversations();
  } catch (e) {
    console.error('Failed to load conversation:', e);
  }
}

function renderMessages(msgs) {
  messagesEl.innerHTML = msgs.map(m => `
    <div class="message ${m.role}">
      <div class="role">${m.role === 'user' ? 'You' : 'Assistant'}</div>
      <div class="content">${escapeHtml(m.content)}</div>
    </div>
  `).join('');
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function clearMessages() {
  messagesEl.innerHTML = '';
  inputEl.value = '';
}

function escapeHtml(text) {
  if (!text) return '';
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function editTitle(id, event) {
  event.stopPropagation();
  const titleSpan = document.getElementById(`title-${id}`);
  const currentTitle = titleSpan.textContent;
  titleSpan.outerHTML = `<input type="text" class="conversation-title-input" value="${escapeHtml(currentTitle)}" id="title-input-${id}" onblur="saveTitle(${id})" onkeydown="handleTitleKey(event, ${id})">`;
  document.getElementById(`title-input-${id}`).focus();
}

async function saveTitle(id) {
  const input = document.getElementById(`title-input-${id}`);
  const newTitle = input.value.trim() || 'Untitled';
  try {
    await fetch(`/api/conversations/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: newTitle })
    });
    const conv = conversations.find(c => c.id === id);
    if (conv) conv.title = newTitle;
    renderConversations();
  } catch (e) {
    console.error('Failed to update title:', e);
  }
}

function handleTitleKey(event, id) {
  if (event.key === 'Enter') {
    event.preventDefault();
    saveTitle(id);
  } else if (event.key === 'Escape') {
    const input = document.getElementById(`title-input-${id}`);
    input.blur();
  }
}

async function deleteConversation(id, event) {
  event.stopPropagation();
  if (!confirm('Delete this conversation?')) return;
  try {
    await fetch(`/api/conversations/${id}`, { method: 'DELETE' });
    conversations = conversations.filter(c => c.id !== id);
    if (currentConversationId === id) {
      currentConversationId = null;
      clearMessages();
      chatAreaEl.style.display = 'none';
      emptyStateEl.style.display = 'flex';
    }
    renderConversations();
  } catch (e) {
    console.error('Failed to delete conversation:', e);
  }
}

async function sendMessage() {
  const content = inputEl.value.trim();
  if (!content) return;

  const model = modelSelect.value;
  if (!model) {
    alert('Please select a model');
    return;
  }

  let conversationId = currentConversationId;

  if (!conversationId) {
    const result = await fetch('/api/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: content.slice(0, 50) + (content.length > 50 ? '...' : '') })
    });
    const data = await result.json();
    conversationId = data.conversation.id;
    currentConversationId = conversationId;
    localStorage.setItem('lastConversationId', conversationId);
    chatAreaEl.style.display = '';
    emptyStateEl.style.display = 'none';
  }

  const conv = conversations.find(c => c.id === conversationId);
  if (conv && conv.title === 'New conversation') {
    const newTitle = content.slice(0, 50) + (content.length > 50 ? '...' : '');
    await fetch(`/api/conversations/${conversationId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: newTitle })
    });
    conv.title = newTitle;
    loadConversations();
  }

  if (!currentConversationId) {
    const userMsg = document.createElement('div');
    userMsg.className = 'message user';
    userMsg.innerHTML = `<div class="role">You</div><div class="content">${escapeHtml(content)}</div>`;
    messagesEl.appendChild(userMsg);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  if (currentConversationId) {
    const userMsg = document.createElement('div');
    userMsg.className = 'message user';
    userMsg.innerHTML = `<div class="role">You</div><div class="content">${escapeHtml(content)}</div>`;
    messagesEl.appendChild(userMsg);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  inputEl.value = '';
  sendBtn.disabled = true;
  sendBtn.innerHTML = '<span class="loading"></span>';

  const skillId = skillSelect.value || null;
  const previousMessages = [...messagesEl.querySelectorAll('.message')].map(m => ({
    role: m.classList.contains('user') ? 'user' : 'assistant',
    content: m.querySelector('.content').textContent
  }));

  const assistantDiv = document.createElement('div');
  assistantDiv.className = 'message assistant';
  assistantDiv.innerHTML = '<div class="role">Assistant</div><div class="content"></div>';
  messagesEl.appendChild(assistantDiv);
  messagesEl.scrollTop = messagesEl.scrollHeight;

  try {
    const response = await fetch('/api/chat/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [...previousMessages, { role: 'user', content }],
        skill_id: skillId,
        conversation_id: conversationId
      })
    });

    if (!response.ok) {
      const error = await response.json();
      assistantDiv.querySelector('.content').innerHTML = `<div class="error">Error: ${error.error}</div>`;
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let done = false;

    while (!done) {
      const { value, done: d } = await reader.read();
      done = d;
      if (value) {
        const text = decoder.decode(value, { stream: true });
        const lines = text.split('\n');
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              const data = JSON.parse(line.slice(6));
              if (data.content) {
                assistantDiv.querySelector('.content').textContent += data.content;
                messagesEl.scrollTop = messagesEl.scrollHeight;
              }
              if (data.done) {
                if (data.usage) {
                  assistantDiv.querySelector('.content').innerHTML += `\n\n<small style="color:#888">Cost: $${data.usage.cost?.toFixed(4) || '?'} | Tokens: ${data.usage.tokens || '?'}</small>`;
                }
                if (data.conversation_id && data.conversation_id !== currentConversationId) {
                  currentConversationId = data.conversation_id;
                  localStorage.setItem('lastConversationId', currentConversationId);
                }
                loadConversations();
              }
              if (data.error) {
                assistantDiv.querySelector('.content').innerHTML = `<div class="error">Error: ${data.error}</div>`;
              }
            } catch {}
          }
        }
      }
    }
  } catch (e) {
    assistantDiv.querySelector('.content').innerHTML = `<div class="error">Request failed: ${e.message}</div>`;
  } finally {
    sendBtn.disabled = false;
    sendBtn.textContent = 'Send';
  }
}

function toggleSidebar() {
  document.getElementById('sidebar').classList.toggle('open');
}

function renderDropdown(models) {
  modelDropdown.innerHTML = models.map(m =>
    `<div class="model-dropdown-item" data-value="${m.id}">${m.name || m.id}</div>`
  ).join('');
}

function filterDropdown(term) {
  const filtered = chatModels.filter(m =>
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
    renderDropdown(chatModels);
  }
});

modelFilterInput.addEventListener('focus', () => {
  if (chatModels.length > 0) {
    const term = modelFilterInput.value.trim();
    modelDropdown.classList.add('open');
    if (term) filterDropdown(term);
    else renderDropdown(chatModels);
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

sendBtn.addEventListener('click', sendMessage);
inputEl.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

clearBtn.addEventListener('click', () => {
  clearMessages();
  if (currentConversationId) {
    localStorage.removeItem('lastConversationId');
    currentConversationId = null;
    chatAreaEl.style.display = 'none';
    emptyStateEl.style.display = 'flex';
    loadConversations();
  }
});

checkAuth().then(async () => {
  await loadModels();
  await loadSkills();
  await loadConversations();

  const lastId = localStorage.getItem('lastConversationId');
  if (lastId) {
    const conv = conversations.find(c => c.id === parseInt(lastId));
    if (conv) {
      await selectConversation(parseInt(lastId));
    }
  }
});