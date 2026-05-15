let allUsers = [];
let allModels = [];
let adminModels = [];
let editingUserId = null;
let userSelectedModels = [];
let onlineSelectedModels = [];
let chatLogsOffset = 0;
let imageLogsOffset = 0;

async function checkAdmin() {
  try {
    const res = await fetch('/api/auth/me');
    if (!res.ok) throw new Error();
    const data = await res.json();
    if (!data.user.is_admin) throw new Error();
    localStorage.setItem('username', data.user.username);
  } catch {
    window.location.href = '/chat';
  }
}

document.querySelectorAll('.admin-tabs button').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.admin-tabs button').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.admin-section').forEach(s => s.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(btn.dataset.tab).classList.add('active');
    if (btn.dataset.tab === 'users') loadUsers();
    if (btn.dataset.tab === 'chat-logs') loadChatLogs();
    if (btn.dataset.tab === 'image-logs') loadImageLogs();
    if (btn.dataset.tab === 'skills') loadSkills();
    if (btn.dataset.tab === 'mcp') loadMcpServers();
  });
});

async function loadSettings() {
  const res = await fetch('/api/admin/settings');
  const data = await res.json();
  document.getElementById('apiKey').value = data.openrouter_api_key || '';
  document.getElementById('loggingEnabled').checked = data.logging_enabled;
  onlineSelectedModels = data.online_models || [];
  renderOnlineModelList(onlineSelectedModels);
}

async function loadAllModels() {
  const res = await fetch('/api/admin/models');
  const data = await res.json();
  allModels = data.models;
}

async function saveApiKey() {
  const key = document.getElementById('apiKey').value.trim();
  await fetch('/api/admin/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ openrouter_api_key: key })
  });
  alert('API key saved');
}

async function saveLogging() {
  const enabled = document.getElementById('loggingEnabled').checked;
  await fetch('/api/admin/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ logging_enabled: enabled })
  });
  alert('Logging setting saved');
}

function getOnlineModelPool() {
  if (adminModels.length > 0) {
    return allModels.filter(m => adminModels.includes(m.id));
  }
  return allModels;
}

function renderOnlineModelList(savedModels) {
  onlineSelectedModels = savedModels || onlineSelectedModels;
  const listEl = document.getElementById('onlineModelList');
  if (allModels.length === 0) {
    listEl.innerHTML = '<p style="color:#888; padding:10px;">No models available. Configure API key first.</p>';
    return;
  }
  const pool = getOnlineModelPool();
  if (pool.length === 0) {
    listEl.innerHTML = '<p style="color:#888; padding:10px;">No models available. Select models for the admin user first.</p>';
    return;
  }
  const filter = (document.getElementById('onlineModelFilter')?.value || '').toLowerCase();
  const filtered = filter ? pool.filter(m => (m.display_name || m.name || m.id).toLowerCase().includes(filter)) : pool;
  const header = `<div class="model-list-header"><span></span><span>Model (input/output)</span></div>`;
  const items = filtered.map(m => {
    const checked = onlineSelectedModels.includes(m.id) ? 'checked' : '';
    const displayName = escapeHtml(m.display_name || m.name || m.id);
    return `<div class="model-item"><input type="checkbox" value="${m.id}" ${checked}><span>${displayName}</span></div>`;
  }).join('');
  listEl.innerHTML = header + items;
}

async function saveOnlineModels() {
  await fetch('/api/admin/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ online_models: onlineSelectedModels })
  });
  alert('Online models saved');
}

async function loadUsers() {
  const res = await fetch('/api/admin/users');
  const data = await res.json();
  allUsers = data.users;
  adminModels = data.admin_models || [];
  const table = document.getElementById('usersTable');
  table.innerHTML = data.users.map(u => {
    const modelCount = u.exposed_models ? u.exposed_models.length : 0;
    const modelText = u.is_admin ? 'All' : (modelCount === 0 ? 'None' : modelCount + ' models');
    return `
    <tr>
      <td>${escapeHtml(u.username)}</td>
      <td>${u.is_admin ? 'Yes' : 'No'}</td>
      <td>${modelText}</td>
      <td>${u.daily_limit_cents < 0 ? 'No limit' : '$' + (u.daily_limit_cents / 100).toFixed(2)}</td>
      <td>${u.monthly_limit_cents < 0 ? 'No limit' : '$' + (u.monthly_limit_cents / 100).toFixed(2)}</td>
      <td>${new Date(u.created_at).toLocaleDateString()}</td>
      <td>
        <button class="btn" onclick="editUser(${u.id})">Edit</button>
        ${!u.is_admin ? `<button class="btn btn-danger" onclick="deleteUser(${u.id})">Delete</button>` : ''}
      </td>
    </tr>
  `;
  }).join('');

  const chatUserSelect = document.getElementById('chatLogUser');
  const imageUserSelect = document.getElementById('imageLogUser');
  const options = data.users.map(u => `<option value="${u.id}">${u.username}</option>`).join('');
  chatUserSelect.innerHTML = '<option value="">All Users</option>' + options;
  imageUserSelect.innerHTML = '<option value="">All Users</option>' + options;
}

function showCreateUser() {
  document.getElementById('userModalTitle').textContent = 'Create User';
  document.getElementById('editUserId').value = '';
  editingUserId = 'new';
  document.getElementById('newUsername').value = '';
  document.getElementById('newUsername').disabled = false;
  document.getElementById('newPassword').value = '';
  document.getElementById('newPassword').required = true;
  document.getElementById('passwordHint').style.display = 'none';
  document.getElementById('newDailyLimit').value = -1;
  document.getElementById('newMonthlyLimit').value = -1;
  const filterInput = document.getElementById('userModelFilter');
  if (filterInput) filterInput.value = '';
  userSelectedModels = [];
  renderModelList();
  document.getElementById('userModal').classList.add('active');
}

function getModelPool() {
  if (editingUserId === 'new' || typeof editingUserId === 'number') {
    return allModels.filter(m => adminModels.includes(m.id));
  }
  return allModels;
}

function renderModelList() {
  const listEl = document.getElementById('userModelList');
  if (allModels.length === 0) {
    listEl.innerHTML = '<p style="color:#888; padding:10px;">No models available. Configure API key first.</p>';
    return;
  }
  const pool = getModelPool();
  if (pool.length === 0) {
    listEl.innerHTML = '<p style="color:#888; padding:10px;">The admin has not selected any models yet. Configure the admin\'s model access first.</p>';
    return;
  }
  const filterInput = document.getElementById('userModelFilter');
  const filter = filterInput ? (filterInput.value || '').toLowerCase() : '';
  const filtered = filter ? pool.filter(m => (m.display_name || m.name || m.id).toLowerCase().includes(filter)) : pool;
  const header = `<div class="model-list-header"><span></span><span>Model (input/output)</span></div>`;
  const items = filtered.map(m => {
    const checked = userSelectedModels.includes(m.id) ? 'checked' : '';
    const displayName = escapeHtml(m.display_name || m.name || m.id);
    return `<div class="model-item"><input type="checkbox" value="${m.id}" ${checked}><span>${displayName}</span></div>`;
  }).join('');
  listEl.innerHTML = header + items;
}

// Event delegation: keep userSelectedModels in sync with checkbox state
document.getElementById('userModelList').addEventListener('change', (e) => {
  if (e.target.type === 'checkbox') {
    if (e.target.checked) {
      if (!userSelectedModels.includes(e.target.value)) {
        userSelectedModels.push(e.target.value);
      }
    } else {
      userSelectedModels = userSelectedModels.filter(id => id !== e.target.value);
    }
  }
});

// Event delegation: keep onlineSelectedModels in sync
document.getElementById('onlineModelList').addEventListener('change', (e) => {
  if (e.target.type === 'checkbox') {
    if (e.target.checked) {
      if (!onlineSelectedModels.includes(e.target.value)) {
        onlineSelectedModels.push(e.target.value);
      }
    } else {
      onlineSelectedModels = onlineSelectedModels.filter(id => id !== e.target.value);
    }
  }
});

async function editUser(id) {
  const user = allUsers.find(u => u.id === id);
  if (!user) return;
  editingUserId = user.is_admin ? null : id;
  const filterInput = document.getElementById('userModelFilter');
  if (filterInput) filterInput.value = '';
  document.getElementById('userModalTitle').textContent = 'Edit User: ' + user.username;
  document.getElementById('editUserId').value = id;
  document.getElementById('newUsername').value = user.username;
  document.getElementById('newUsername').disabled = true;
  document.getElementById('newPassword').value = '';
  document.getElementById('newPassword').required = false;
  document.getElementById('passwordHint').style.display = 'inline';
  document.getElementById('newDailyLimit').value = user.daily_limit_cents;
  document.getElementById('newMonthlyLimit').value = user.monthly_limit_cents;
  userSelectedModels = [...(user.exposed_models || [])];
  renderModelList();
  document.getElementById('userModal').classList.add('active');
}

function closeUserModal() {
  document.getElementById('userModal').classList.remove('active');
  document.getElementById('newUsername').disabled = false;
}

function selectAllModels() {
  document.querySelectorAll('#userModelList input[type="checkbox"]').forEach(cb => {
    cb.checked = true;
    if (!userSelectedModels.includes(cb.value)) {
      userSelectedModels.push(cb.value);
    }
  });
}

function clearAllModels() {
  document.querySelectorAll('#userModelList input[type="checkbox"]').forEach(cb => {
    cb.checked = false;
  });
  // Only clear models that are currently visible (filtered)
  const visibleIds = [...document.querySelectorAll('#userModelList input[type="checkbox"]')].map(cb => cb.value);
  userSelectedModels = userSelectedModels.filter(id => !visibleIds.includes(id));
}

function getSelectedModels() {
  return [...userSelectedModels];
}

async function saveUser() {
  const id = document.getElementById('editUserId').value;
  const username = document.getElementById('newUsername').value.trim();
  const password = document.getElementById('newPassword').value;
  const dailyLimit = parseInt(document.getElementById('newDailyLimit').value) || -1;
  const monthlyLimit = parseInt(document.getElementById('newMonthlyLimit').value) || -1;
  const exposedModels = getSelectedModels();

  if (!username) {
    alert('Username required');
    return;
  }

  const body = { daily_limit_cents: dailyLimit, monthly_limit_cents: monthlyLimit, exposed_models: exposedModels };
  if (!id) body.username = username;
  if (password) body.password = password;

  const url = id ? `/api/admin/users/${id}` : '/api/admin/users';
  const method = id ? 'PUT' : 'POST';

  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const data = await res.json();
    alert(data.error || 'Failed to save user');
    return;
  }

  closeUserModal();
  loadUsers();
}

async function deleteUser(id) {
  if (!confirm('Delete this user? This cannot be undone.')) return;
  const res = await fetch(`/api/admin/users/${id}`, { method: 'DELETE' });
  if (!res.ok) {
    const data = await res.json();
    alert(data.error || 'Failed to delete user');
    return;
  }
  loadUsers();
}

async function loadChatLogs(offset = 0) {
  chatLogsOffset = offset;
  const userId = document.getElementById('chatLogUser').value;
  const url = `/api/admin/logs?limit=20&offset=${offset}${userId ? `&user_id=${userId}` : ''}`;
  const res = await fetch(url);
  const data = await res.json();

  const table = document.getElementById('chatLogsTable');
  table.innerHTML = data.logs.map(l => `
    <tr>
      <td>${escapeHtml(l.username)}</td>
      <td>${escapeHtml(l.model)}</td>
      <td>${escapeHtml(l.prompt?.slice(0, 50))}...</td>
      <td>${escapeHtml(l.response?.slice(0, 50))}...</td>
      <td>$${l.cost?.toFixed(4) || '?'}</td>
      <td>${new Date(l.created_at).toLocaleString()}</td>
    </tr>
  `).join('');

  const pagination = document.getElementById('chatLogsPagination');
  if (data.total > 20) {
    pagination.innerHTML = `
      ${offset > 0 ? '<button class="btn" onclick="loadChatLogs(' + (offset - 20) + ')">Previous</button>' : ''}
      <span style="margin: 0 20px;">${offset + 1}-${Math.min(offset + 20, data.total)} of ${data.total}</span>
      ${offset + 20 < data.total ? '<button class="btn" onclick="loadChatLogs(' + (offset + 20) + ')">Next</button>' : ''}
    `;
  } else {
    pagination.innerHTML = '';
  }
}

async function loadImageLogs(offset = 0) {
  imageLogsOffset = offset;
  const userId = document.getElementById('imageLogUser').value;
  const url = `/api/admin/image-logs?limit=20&offset=${offset}${userId ? `&user_id=${userId}` : ''}`;
  const res = await fetch(url);
  const data = await res.json();

  const table = document.getElementById('imageLogsTable');
  table.innerHTML = data.logs.map(l => `
    <tr>
      <td>${escapeHtml(l.username)}</td>
      <td>${escapeHtml(l.model)}</td>
      <td>${escapeHtml(l.prompt?.slice(0, 50))}...</td>
      <td>$${l.cost?.toFixed(4) || '?'}</td>
      <td>${new Date(l.created_at).toLocaleString()}</td>
    </tr>
  `).join('');

  const pagination = document.getElementById('imageLogsPagination');
  if (data.total > 20) {
    pagination.innerHTML = `
      ${offset > 0 ? '<button class="btn" onclick="loadImageLogs(' + (offset - 20) + ')">Previous</button>' : ''}
      <span style="margin: 0 20px;">${offset + 1}-${Math.min(offset + 20, data.total)} of ${data.total}</span>
      ${offset + 20 < data.total ? '<button class="btn" onclick="loadImageLogs(' + (offset + 20) + ')">Next</button>' : ''}
    `;
  } else {
    pagination.innerHTML = '';
  }
}

async function loadSkills() {
  const res = await fetch('/api/admin/skills');
  const data = await res.json();
  const table = document.getElementById('skillsTable');
  table.innerHTML = data.skills.map(s => `
    <tr>
      <td>${escapeHtml(s.name)}</td>
      <td>${escapeHtml(s.description || '-')}</td>
      <td>
        <button class="btn" onclick="editSkill(${s.id})">Edit</button>
        <button class="btn btn-danger" onclick="deleteSkill(${s.id})">Delete</button>
      </td>
    </tr>
  `).join('');
}

function showCreateSkill() {
  document.getElementById('skillModalTitle').textContent = 'Create Skill';
  document.getElementById('editSkillId').value = '';
  document.getElementById('skillName').value = '';
  document.getElementById('skillDescription').value = '';
  document.getElementById('skillContent').value = '';
  document.getElementById('skillModal').classList.add('active');
}

async function editSkill(id) {
  const res = await fetch('/api/admin/skills');
  const data = await res.json();
  const skill = data.skills.find(s => s.id === id);
  if (!skill) return;
  document.getElementById('skillModalTitle').textContent = 'Edit Skill';
  document.getElementById('editSkillId').value = id;
  document.getElementById('skillName').value = skill.name;
  document.getElementById('skillDescription').value = skill.description || '';
  document.getElementById('skillContent').value = skill.content;
  document.getElementById('skillModal').classList.add('active');
}

function closeSkillModal() {
  document.getElementById('skillModal').classList.remove('active');
}

async function saveSkill() {
  const id = document.getElementById('editSkillId').value;
  const name = document.getElementById('skillName').value.trim();
  const description = document.getElementById('skillDescription').value.trim();
  const content = document.getElementById('skillContent').value.trim();

  if (!name || !content) {
    alert('Name and content are required');
    return;
  }

  const body = { name, description, content };
  const url = id ? `/api/admin/skills/${id}` : '/api/admin/skills';
  const method = id ? 'PUT' : 'POST';

  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const data = await res.json();
    alert(data.error || 'Failed to save skill');
    return;
  }

  closeSkillModal();
  loadSkills();
}

async function deleteSkill(id) {
  if (!confirm('Delete this skill?')) return;
  const res = await fetch(`/api/admin/skills/${id}`, { method: 'DELETE' });
  if (!res.ok) {
    alert('Failed to delete skill');
    return;
  }
  loadSkills();
}

async function loadMcpServers() {
  const res = await fetch('/api/admin/mcp/servers');
  const data = await res.json();
  const table = document.getElementById('mcpServersTable');
  table.innerHTML = data.servers.map(s => `
    <tr>
      <td>${escapeHtml(s.name)}</td>
      <td>${escapeHtml(s.transport_type)}</td>
      <td>${s.enabled ? 'Yes' : 'No'}</td>
      <td>
        <button class="btn" onclick="testMcpServer(${s.id})">Test</button>
        <button class="btn" onclick="editMcpServer(${s.id})">Edit</button>
        <button class="btn btn-danger" onclick="deleteMcpServer(${s.id})">Delete</button>
      </td>
    </tr>
  `).join('');
}

function showCreateMcpServer() {
  document.getElementById('mcpServerModalTitle').textContent = 'Add MCP Server';
  document.getElementById('editMcpServerId').value = '';
  document.getElementById('mcpServerName').value = '';
  document.getElementById('mcpServerDescription').value = '';
  document.getElementById('mcpServerTransport').value = 'stdio';
  document.getElementById('mcpServerCommand').value = '';
  document.getElementById('mcpServerArgs').value = '';
  document.getElementById('mcpServerUrl').value = '';
  document.getElementById('mcpServerAuthToken').value = '';
  toggleMcpTransportFields();
  document.getElementById('mcpServerModal').classList.add('active');
}

function editMcpServer(id) {
  fetch('/api/admin/mcp/servers')
    .then(r => r.json())
    .then(data => {
      const server = data.servers.find(s => s.id === id);
      if (!server) return;
      document.getElementById('mcpServerModalTitle').textContent = 'Edit MCP Server';
      document.getElementById('editMcpServerId').value = id;
      document.getElementById('mcpServerName').value = server.name;
      document.getElementById('mcpServerDescription').value = server.description || '';
      document.getElementById('mcpServerTransport').value = server.transport_type || 'stdio';
      document.getElementById('mcpServerCommand').value = server.command || '';
      document.getElementById('mcpServerArgs').value = server.args || '';
      document.getElementById('mcpServerUrl').value = server.url || '';
      document.getElementById('mcpServerAuthToken').value = server.auth_token || '';
      toggleMcpTransportFields();
      document.getElementById('mcpServerModal').classList.add('active');
    });
}

function closeMcpServerModal() {
  document.getElementById('mcpServerModal').classList.remove('active');
}

function toggleMcpTransportFields() {
  const transport = document.getElementById('mcpServerTransport').value;
  document.getElementById('mcpStdioFields').style.display = transport === 'stdio' ? '' : 'none';
  document.getElementById('mcpSseFields').style.display = transport === 'sse' ? '' : 'none';
}

async function saveMcpServer() {
  const id = document.getElementById('editMcpServerId').value;
  const name = document.getElementById('mcpServerName').value.trim();
  const description = document.getElementById('mcpServerDescription').value.trim();
  const transport_type = document.getElementById('mcpServerTransport').value;
  const command = document.getElementById('mcpServerCommand').value.trim();
  const args = document.getElementById('mcpServerArgs').value.trim();
  const url = document.getElementById('mcpServerUrl').value.trim();
  const auth_token = document.getElementById('mcpServerAuthToken').value.trim();

  if (!name) {
    alert('Name is required');
    return;
  }
  if (transport_type === 'stdio' && !command) {
    alert('Command is required for stdio transport');
    return;
  }
  if (transport_type === 'sse' && !url) {
    alert('URL is required for SSE transport');
    return;
  }

  const body = { name, description, transport_type };
  if (command) body.command = command;
  if (args) body.args = args;
  if (url) body.url = url;
  if (auth_token) body.auth_token = auth_token;

  const endpoint = id ? `/api/admin/mcp/servers/${id}` : '/api/admin/mcp/servers';
  const method = id ? 'PUT' : 'POST';

  const res = await fetch(endpoint, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const data = await res.json();
    alert(data.error || 'Failed to save MCP server');
    return;
  }

  closeMcpServerModal();
  loadMcpServers();
}

async function deleteMcpServer(id) {
  if (!confirm('Delete this MCP server?')) return;
  const res = await fetch(`/api/admin/mcp/servers/${id}`, { method: 'DELETE' });
  if (!res.ok) {
    alert('Failed to delete MCP server');
    return;
  }
  loadMcpServers();
}

async function testMcpServer(id) {
  const btn = event.target;
  btn.disabled = true;
  btn.textContent = 'Testing...';
  try {
    const res = await fetch(`/api/admin/mcp/servers/${id}/test`, { method: 'POST' });
    const data = await res.json();
    if (data.success) {
      alert(`Connection successful! Found ${data.toolCount} tools:\n${data.tools.map(t => '  - ' + t).join('\n')}`);
    } else {
      alert('Connection failed: ' + (data.error || 'Unknown error'));
    }
  } catch (e) {
    alert('Test failed: ' + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Test';
  }
}

function escapeHtml(text) {
  if (!text) return '';
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

checkAdmin().then(async () => {
  await loadAllModels();
  loadSettings();
  loadUsers();
});
