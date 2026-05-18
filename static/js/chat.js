if (typeof marked !== 'undefined') {
  marked.setOptions({ breaks: false });
  marked.use({
    renderer: {
      link({ href, title, text }) {
        const titleAttr = title ? ` title="${title}"` : '';
        return `<a href="${href}" target="_blank" rel="noopener noreferrer"${titleAttr}>${text}</a>`;
      }
    }
  });
}

const modelSelect = document.getElementById('modelSelect');
const modelFilterInput = document.getElementById('modelFilter');
const modelDropdown = document.getElementById('modelDropdown');
const skillSelectWrap = document.getElementById('skillSelectWrap');
const skillMultiSelect = document.getElementById('skillMultiSelect');
const skillTrigger = document.getElementById('skillTrigger');
const skillDropdown = document.getElementById('skillDropdown');
const mcpBar = document.getElementById('mcpBar');
const mcpMultiSelect = document.getElementById('mcpMultiSelect');
const mcpTrigger = document.getElementById('mcpTrigger');
const mcpDropdown = document.getElementById('mcpDropdown');
const messagesEl = document.getElementById('messages');
const inputEl = document.getElementById('input');
const sendBtn = document.getElementById('sendBtn');
const stopBtn = document.getElementById('stopBtn');
const clearBtn = document.getElementById('clearBtn');
const conversationsListEl = document.getElementById('conversationsList');
const chatAreaEl = document.getElementById('chatArea');
const emptyStateEl = document.getElementById('emptyState');
const attachImageBtn = document.getElementById('attachImageBtn');
const chatImageInput = document.getElementById('chatImageInput');
const chatAttachPreview = document.getElementById('chatAttachPreview');
const chatAttachPreviewImg = document.getElementById('chatAttachPreviewImg');
const chatAttachRemove = document.getElementById('chatAttachRemove');
const chatAttachPdfLabel = document.getElementById('chatAttachPdfLabel');

let currentUser = null;
let currentConversationId = null;
let conversations = [];
let chatModels = [];
let attachedImageBase64 = null;
let attachedFileName = null;
let skillOptions = [];
let mcpOptions = [];
let selectedSkills = new Set();
let selectedMcps = new Set();
let activeMultiSelect = null;
let abortController = null;

const PREFS_KEY = 'conversationPreferences';
const LAST_MODEL_KEY = 'lastModelId';

function getConversationPrefs() {
  try { return JSON.parse(localStorage.getItem(PREFS_KEY) || '{}'); }
  catch { return {}; }
}

function saveConversationPrefs(convId, model, mcpIds, skillIds) {
  const prefs = getConversationPrefs();
  prefs[convId] = { model, mcp: mcpIds, skills: skillIds };
  localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
}

function applyModelToUI(modelId) {
  const model = chatModels.find(m => m.id === modelId);
  if (model) {
    modelSelect.value = model.id;
    modelFilterInput.value = model.name || model.id;
    localStorage.setItem(LAST_MODEL_KEY, model.id);
  }
}

function loadAndApplyConvPrefs(convId) {
  const prefs = getConversationPrefs();
  const entry = prefs[convId];
  if (entry) {
    if (entry.model) applyModelToUI(entry.model);
    selectedSkills = new Set(entry.skills || []);
    selectedMcps = new Set(entry.mcp || []);
  } else {
    const lastModel = localStorage.getItem(LAST_MODEL_KEY);
    if (lastModel) applyModelToUI(lastModel);
    selectedSkills = new Set();
    selectedMcps = new Set();
  }
  if (skillOptions.length > 0) {
    renderMultiSelectOptions('skill');
    updateMultiSelectTrigger('skill');
  }
  if (mcpOptions.length > 0) {
    renderMultiSelectOptions('mcp');
    updateMultiSelectTrigger('mcp');
  }
}

function toggleMultiSelect(type) {
  const dropdown = type === 'skill' ? skillDropdown : mcpDropdown;
  const isOpen = !dropdown.classList.contains('open');
  closeAllMultiSelects();
  if (isOpen) {
    dropdown.classList.add('open');
    activeMultiSelect = type;
  }
}

function closeAllMultiSelects() {
  skillDropdown.classList.remove('open');
  mcpDropdown.classList.remove('open');
  activeMultiSelect = null;
}

function updateMultiSelectTrigger(type) {
  const trigger = type === 'skill' ? skillTrigger : mcpTrigger;
  const selected = type === 'skill' ? selectedSkills : selectedMcps;
  const options = type === 'skill' ? skillOptions : mcpOptions;
  if (selected.size === 0) {
    trigger.textContent = 'None';
  } else if (selected.size === options.length && options.length > 0) {
    trigger.textContent = `All (${selected.size})`;
  } else {
    const names = [...selected].map(id => {
      const opt = options.find(o => o.id === id);
      return opt ? opt.name : id;
    });
    trigger.textContent = names.join(', ') || 'None';
  }
}

function renderMultiSelectOptions(type) {
  const dropdown = type === 'skill' ? skillDropdown : mcpDropdown;
  const selected = type === 'skill' ? selectedSkills : selectedMcps;
  const options = type === 'skill' ? skillOptions : mcpOptions;
  if (options.length === 0) {
    dropdown.innerHTML = '<div class="model-dropdown-empty">No options</div>';
    return;
  }
  dropdown.innerHTML = options.map(o => `
    <div class="multi-select-item">
      <input type="checkbox" value="${o.id}" id="${type}-cb-${o.id}" ${selected.has(o.id) ? 'checked' : ''} onchange="toggleMultiOption('${type}', '${o.id}', this.checked)">
      <label for="${type}-cb-${o.id}" class="multi-select-label">${escapeHtml(o.name)}</label>
    </div>
  `).join('');
}

function toggleMultiOption(type, id, checked) {
  const selected = type === 'skill' ? selectedSkills : selectedMcps;
  if (checked) {
    selected.add(id);
  } else {
    selected.delete(id);
  }
  updateMultiSelectTrigger(type);
}

document.addEventListener('click', (e) => {
  const skillEl = skillMultiSelect;
  const mcpEl = mcpMultiSelect;
  if (activeMultiSelect === 'skill' && !skillEl.contains(e.target)) {
    closeAllMultiSelects();
  }
  if (activeMultiSelect === 'mcp' && !mcpEl.contains(e.target)) {
    closeAllMultiSelects();
  }
  if (!e.target.closest('.model-picker')) {
    modelDropdown.classList.remove('open');
  }
});

async function checkAuth() {
  if (localStorage.getItem('is_admin')) {
    document.getElementById('adminLink').classList.remove('hidden');
  }
  try {
    const res = await fetch('/api/auth/me');
    if (!res.ok) throw new Error();
    const data = await res.json();
    currentUser = data.user;
    localStorage.setItem('username', currentUser.username);
    localStorage.setItem('is_admin', currentUser.is_admin ? '1' : '');
    if (currentUser.is_admin) {
      document.getElementById('adminLink').classList.remove('hidden');
    }
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
    skillSelectWrap.style.display = 'none';
    return;
  }
  try {
    const res = await fetch('/api/admin/skills');
    const data = await res.json();
    skillOptions = data.skills.map(s => ({ id: s.id, name: s.name }));
    if (skillOptions.length === 0) {
      skillSelectWrap.style.display = 'none';
    } else {
      skillSelectWrap.style.display = '';
      renderMultiSelectOptions('skill');
      updateMultiSelectTrigger('skill');
    }
  } catch {}
}

async function loadMcpServers() {
  try {
    const res = await fetch('/api/admin/mcp/servers-enabled');
    const data = await res.json();
    if (!data.servers || data.servers.length === 0) {
      mcpBar.style.display = 'none';
    } else {
      mcpBar.style.display = '';
      mcpOptions = data.servers.map(s => ({ id: s.id, name: s.name }));
      renderMultiSelectOptions('mcp');
      updateMultiSelectTrigger('mcp');
    }
  } catch {
    mcpBar.style.display = 'none';
  }
}

async function loadConversations() {
  try {
    const res = await fetch('/api/conversations');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    conversations = data.conversations || [];
    renderConversations();
  } catch (e) {
    console.error('Failed to load conversations:', e);
  }
}

function renderConversations() {
  if (!conversationsListEl) return;
  if (conversations.length === 0) {
    conversationsListEl.innerHTML = '<div class="chat-empty" style="padding: 24px; height: auto;">No conversations yet</div>';
    return;
  }
  conversationsListEl.innerHTML = conversations.map(c => `
    <div class="conversation-item ${c.id === currentConversationId ? 'active' : ''}" data-id="${c.id}" onclick="selectConversation(${c.id})">
      <span class="conversation-title" id="title-${c.id}" onclick="event.stopPropagation()" ondblclick="editTitle(${c.id}, event)" title="Double-click to rename">${escapeHtml(c.title)}</span>
      <button class="conversation-delete" onclick="deleteConversation(${c.id}, event)">×</button>
    </div>
  `).join('');
}

async function newConversation() {
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
    const lastModel = localStorage.getItem(LAST_MODEL_KEY);
    if (lastModel) applyModelToUI(lastModel);
    selectedSkills = new Set();
    selectedMcps = new Set();
    if (skillOptions.length > 0) { renderMultiSelectOptions('skill'); updateMultiSelectTrigger('skill'); }
    if (mcpOptions.length > 0) { renderMultiSelectOptions('mcp'); updateMultiSelectTrigger('mcp'); }
    closeSidebar();
    loadConversations();
    inputEl.focus();
  } catch (e) {
    console.error('newConversation error:', e);
    alert('Error creating new chat: ' + e.message);
  }
}

async function selectConversation(id) {
  if (id === currentConversationId) return;
  currentConversationId = id;
  localStorage.setItem('lastConversationId', id);
  try {
    const res = await fetch(`/api/conversations/${id}`);
    const data = await res.json();
    renderMessages(data.messages);
    loadAndApplyConvPrefs(id);
    chatAreaEl.style.display = '';
    emptyStateEl.style.display = 'none';
    closeSidebar();
    renderConversations();
  } catch (e) {
    console.error('Failed to load conversation:', e);
  }
}

function renderMessages(msgs) {
  messagesEl.innerHTML = msgs.map(m => {
    const roleLabel = m.role === 'user' ? 'You' : 'Assistant';
    let contentHtml = '';
    if (m.role === 'user') {
      try {
        const parts = typeof m.content === 'string' ? JSON.parse(m.content) : m.content;
        if (Array.isArray(parts)) {
          contentHtml = parts.map(p => {
            if (p.type === 'text') return escapeHtml(p.text);
            if (p.type === 'image_url') return `<img src="${escapeHtml(p.image_url?.url || '')}" class="chat-inline-image" alt="Attached image">`;
            if (p.type === 'file') return `<div class="chat-file-attachment"><span class="chat-file-icon">PDF</span> ${escapeHtml(p.file?.filename || 'Attached file')}</div>`;
            return '';
          }).join(' ');
        } else {
          contentHtml = escapeHtml(m.content);
        }
      } catch {
        contentHtml = escapeHtml(m.content);
      }
    } else {
      contentHtml = marked.parse(escapeHtml(m.content));
    }
    return `
      <div class="message ${m.role}">
        <div class="role">${roleLabel}</div>
        <div class="content"><div class="body">${contentHtml}</div></div>
      </div>
    `;
  }).join('');
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function clearMessages() {
  messagesEl.innerHTML = '';
  inputEl.value = '';
  removeAttachedImage();
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

function buildUserContent(text) {
  if (!attachedImageBase64) return text;
  if (attachedImageBase64.startsWith('data:application/pdf')) {
    return [
      { type: 'text', text },
      { type: 'file', file: { filename: attachedFileName || 'document.pdf', file_data: attachedImageBase64 } }
    ];
  }
  return [
    { type: 'text', text },
    { type: 'image_url', image_url: { url: attachedImageBase64 } }
  ];
}

async function sendMessage() {
  const content = inputEl.value.trim();
  if (!content && !attachedImageBase64) return;

  const model = modelSelect.value;
  if (!model) {
    alert('Please select a model');
    return;
  }

  let conversationId = currentConversationId;

  if (!conversationId) {
    const titleText = content.slice(0, 50) + (content.length > 50 ? '...' : '');
    const result = await fetch('/api/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: titleText })
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

  const defaultPlaceholder = attachedImageBase64?.startsWith('data:application/pdf') ? '[File]' : '[Image]';
  const userContent = buildUserContent(content || defaultPlaceholder);

  if (!currentConversationId) {
    const userMsg = document.createElement('div');
    userMsg.className = 'message user';
    userMsg.innerHTML = `<div class="role">You</div><div class="content">${renderContentParts(userContent)}</div>`;
    messagesEl.appendChild(userMsg);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  if (currentConversationId) {
    const userMsg = document.createElement('div');
    userMsg.className = 'message user';
    userMsg.innerHTML = `<div class="role">You</div><div class="content">${renderContentParts(userContent)}</div>`;
    messagesEl.appendChild(userMsg);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  inputEl.value = '';
  removeAttachedImage();
  sendBtn.classList.add('hidden');
  stopBtn.classList.remove('hidden');

  const skillIds = [...selectedSkills];
  const mcpServerIds = [...selectedMcps];
  const previousMessages = [...messagesEl.querySelectorAll('.message')].map(m => {
    const contentEl = m.querySelector('.content');
    const imgEl = contentEl.querySelector('img');
    const fileEl = contentEl.querySelector('.chat-file-attachment');
    if (m.classList.contains('user') && (imgEl || fileEl)) {
      const textParts = contentEl.childNodes;
      let text = '';
      for (const node of textParts) {
        if (node.nodeType === Node.TEXT_NODE) text += node.textContent;
      }
      text = text.trim();
      const hasImg = !!imgEl;
      const parts = [{ type: 'text', text: text || (hasImg ? '[Image]' : '[File]') }];
      if (imgEl) {
        const src = imgEl.getAttribute('src');
        if (src) parts.push({ type: 'image_url', image_url: { url: src } });
      }
      if (fileEl) {
        const fileUrl = fileEl.getAttribute('data-file-url');
        const fileName = fileEl.textContent.replace('PDF', '').trim();
        if (fileUrl) parts.push({ type: 'file', file: { filename: fileName || 'document.pdf', file_data: fileUrl } });
      }
      return { role: 'user', content: parts };
    }
    return { role: m.classList.contains('user') ? 'user' : 'assistant', content: contentEl.textContent };
  });

  const assistantDiv = document.createElement('div');
  assistantDiv.className = 'message assistant';
  assistantDiv.innerHTML = '<div class="role">Assistant</div><div class="content"><div class="body"></div></div>';
  messagesEl.appendChild(assistantDiv);
  messagesEl.scrollTop = messagesEl.scrollHeight;

  const contentEl = assistantDiv.querySelector('.content');
  const bodyEl = contentEl.querySelector('.body');
  let streamedText = '';
  let stopped = false;

  abortController = new AbortController();

  try {
    const response = await fetch('/api/chat/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [...previousMessages, { role: 'user', content: userContent }],
        skill_ids: skillIds,
        conversation_id: conversationId,
        mcp_server_ids: mcpServerIds
      }),
      signal: abortController.signal
    });

    if (!response.ok) {
      const error = await response.json();
      contentEl.innerHTML = `<div class="error">Error: ${error.error}</div>`;
      stopBtn.classList.add('hidden');
      sendBtn.classList.remove('hidden');
      sendBtn.disabled = false;
      abortController = null;
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
                streamedText += data.content;
                bodyEl.innerHTML = typeof marked !== 'undefined' ? marked.parse(escapeHtml(streamedText)) : escapeHtml(streamedText);
                messagesEl.scrollTop = messagesEl.scrollHeight;
              }
              if (data.tool_call) {
                const statusDiv = document.createElement('div');
                statusDiv.className = 'tool-status running';
                statusDiv.setAttribute('data-tool', data.tool_call.name);
                statusDiv.textContent = '\uD83D\uDD27 ' + data.tool_call.name + '...';
                contentEl.appendChild(statusDiv);
                messagesEl.scrollTop = messagesEl.scrollHeight;
              }
              if (data.tool_result) {
                const existing = assistantDiv.querySelector(`.tool-status[data-tool="${data.tool_result.name}"]`);
                if (existing) {
                  if (data.tool_result.error) {
                    existing.className = 'tool-status error';
                    existing.textContent = '\u2717 ' + data.tool_result.name;
                  } else {
                    existing.className = 'tool-status done';
                    existing.textContent = '\u2713 ' + data.tool_result.name;
                  }
                }
              }
              if (data.done) {
                if (data.usage) {
                  bodyEl.innerHTML += `<div class="usage-info">Cost: $${data.usage.cost?.toFixed(4) || '?'} | Tokens: ${data.usage.tokens || '?'}</div>`;
                }
                if (data.conversation_id && data.conversation_id !== currentConversationId) {
                  currentConversationId = data.conversation_id;
                  localStorage.setItem('lastConversationId', currentConversationId);
                }
                saveConversationPrefs(currentConversationId, model, mcpServerIds, skillIds);
                localStorage.setItem(LAST_MODEL_KEY, model);
                loadConversations();
              }
              if (data.error) {
                contentEl.innerHTML = `<div class="error">Error: ${data.error}</div>`;
              }
            } catch {}
          }
        }
      }
    }
  } catch (e) {
    if (e.name === 'AbortError') {
      stopped = true;
    } else {
      contentEl.innerHTML = `<div class="error">Request failed: ${e.message}</div>`;
    }
  }

  if (stopped && streamedText) {
    bodyEl.innerHTML = (typeof marked !== 'undefined' ? marked.parse(escapeHtml(streamedText)) : escapeHtml(streamedText)) + '<div class="stopped-badge">Stopped</div>';
  }

  if (!contentEl.querySelector('.error') && !contentEl.querySelector('.usage-info')) {
    saveConversationPrefs(currentConversationId, model, mcpServerIds, skillIds);
    localStorage.setItem(LAST_MODEL_KEY, model);
    loadConversations();
  }

  stopBtn.classList.add('hidden');
  sendBtn.classList.remove('hidden');
  sendBtn.disabled = false;
  abortController = null;
}

function renderContentParts(userContent) {
  if (typeof userContent === 'string') return escapeHtml(userContent);
  return userContent.map(p => {
    if (p.type === 'text') return escapeHtml(p.text);
    if (p.type === 'image_url') return `<img src="${escapeHtml(p.image_url?.url || '')}" class="chat-inline-image" alt="Attached image">`;
    if (p.type === 'file') return `<div class="chat-file-attachment" data-file-url="${escapeHtml(p.file?.file_data || '')}"><span class="chat-file-icon">PDF</span> ${escapeHtml(p.file?.filename || 'Attached file')}</div>`;
    return '';
  }).join(' ');
}

function handleAttachImage(file) {
  if (!file) return;
  attachedFileName = file.name;
  const reader = new FileReader();
  reader.onload = function(e) {
    attachedImageBase64 = e.target.result;
    if (file.type === 'application/pdf') {
      chatAttachPreviewImg.classList.add('hidden');
      chatAttachPdfLabel.textContent = file.name;
      chatAttachPdfLabel.classList.remove('hidden');
    } else {
      chatAttachPreviewImg.src = attachedImageBase64;
      chatAttachPreviewImg.classList.remove('hidden');
      chatAttachPdfLabel.classList.add('hidden');
    }
    chatAttachPreview.classList.remove('hidden');
  };
  reader.readAsDataURL(file);
}

function removeAttachedImage() {
  attachedImageBase64 = null;
  attachedFileName = null;
  chatImageInput.value = '';
  chatAttachPreview.classList.add('hidden');
  chatAttachPreviewImg.classList.remove('hidden');
  chatAttachPdfLabel.classList.add('hidden');
}

function toggleSidebar() {
  document.getElementById('sidebar').classList.toggle('open');
}

function closeSidebar() {
  document.getElementById('sidebar').classList.remove('open');
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

attachImageBtn.addEventListener('click', () => chatImageInput.click());
chatImageInput.addEventListener('change', () => handleAttachImage(chatImageInput.files[0]));
chatAttachRemove.addEventListener('click', removeAttachedImage);

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

sendBtn.addEventListener('click', sendMessage);
stopBtn.addEventListener('click', () => {
  if (abortController) {
    abortController.abort();
  }
});
inputEl.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

clearBtn.addEventListener('click', () => {
  clearMessages();
    closeSidebar();
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
  await loadMcpServers();
  await loadConversations();

  const lastId = localStorage.getItem('lastConversationId');
  if (lastId) {
    const conv = conversations.find(c => c.id === parseInt(lastId));
    if (conv) {
      await selectConversation(parseInt(lastId));
    }
  }
  if (!currentConversationId) {
    const lastModel = localStorage.getItem(LAST_MODEL_KEY);
    if (lastModel) applyModelToUI(lastModel);
  }
});
