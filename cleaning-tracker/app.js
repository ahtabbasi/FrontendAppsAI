/**
 * CleanTrack - Live CSV Cleaning Schedule PWA
 * Readonly CSV parser, cookie state management, live urgency calculation,
 * filtering, sorting, completion history & comments tracking, and export.
 */

// Default CSV published link from Google Sheets
const DEFAULT_CSV_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vQfpdQZD9w3kREdOGJ4OGvy7gK8DKBzniLpno6vf8O7uY6mfKkf9pQcQxLEQn39VPSLB7IUvFzUKHmH/pub?gid=1369551100&single=true&output=csv';
const COOKIE_STATE_PREFIX = 'ct_done_';
const COOKIE_COMMENTS_PREFIX = 'ct_com_';
const COOKIE_LOGS_PREFIX = 'ct_logs_';
const STORAGE_PREFIX = 'cleantrack_';

// ==========================================
// Robust Cookie Helpers (with LocalStorage fallback)
// ==========================================
const CookieStore = {
  get(key) {
    try {
      // Check cookies
      const name = encodeURIComponent(key) + "=";
      const ca = document.cookie.split(';');
      for (let i = 0; i < ca.length; i++) {
        let c = ca[i].trim();
        if (c.indexOf(name) === 0) {
          const val = decodeURIComponent(c.substring(name.length, c.length));
          return JSON.parse(val);
        }
      }
    } catch (e) {
      console.warn('Cookie read error:', e);
    }
    // Fallback to localStorage
    try {
      const lsVal = localStorage.getItem(STORAGE_PREFIX + key);
      if (lsVal) return JSON.parse(lsVal);
    } catch (e) {}
    return null;
  },

  set(key, value, days = 365) {
    const serialized = JSON.stringify(value);
    try {
      const d = new Date();
      d.setTime(d.getTime() + (days * 24 * 60 * 60 * 1000));
      const expires = "expires=" + d.toUTCString();
      // Only set cookie if length is reasonable (< 3800 bytes)
      if (encodeURIComponent(serialized).length < 3800) {
        document.cookie = `${encodeURIComponent(key)}=${encodeURIComponent(serialized)};${expires};path=/;SameSite=Lax`;
      }
    } catch (e) {
      console.warn('Cookie set error:', e);
    }
    // Always sync with localStorage as backup
    try {
      localStorage.setItem(STORAGE_PREFIX + key, serialized);
    } catch (e) {}
  },

  remove(key) {
    document.cookie = `${encodeURIComponent(key)}=;expires=Thu, 01 Jan 1970 00:00:00 UTC;path=/;SameSite=Lax`;
    try {
      localStorage.removeItem(STORAGE_PREFIX + key);
    } catch (e) {}
  }
};

// ==========================================
// Application State
// ==========================================
const AppState = {
  tasks: [],
  csvSourceUrl: CookieStore.get('custom_csv_url') || DEFAULT_CSV_URL,
  activeTab: 'all', // 'all', 'overdue', 'due', 'completed', or room name
  searchQuery: '',
  statusFilter: 'all',
  sortBy: 'urgency-desc',
  // Cookie backed states:
  doneState: CookieStore.get('done_map') || {}, // { [taskId]: { done: true, doneDate: '2023-11-12' } }
  commentsState: CookieStore.get('comments_map') || {}, // { [taskId]: [ { text, timestamp } ] }
  activityLogs: CookieStore.get('activity_logs') || [], // [ { id, action, taskId, taskName, room, timestamp, details } ]
  lastSyncTime: null,
  activeCommentTaskId: null
};

// ==========================================
// CSV Parsing Utility
// ==========================================
function parseCSV(text) {
  const lines = [];
  let row = [];
  let inQuotes = false;
  let currentToken = '';

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const nextChar = text[i + 1];

    if (char === '"') {
      if (inQuotes && nextChar === '"') {
        currentToken += '"';
        i++; // skip escaped quote
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      row.push(currentToken.trim());
      currentToken = '';
    } else if ((char === '\r' || char === '\n') && !inQuotes) {
      if (char === '\r' && nextChar === '\n') {
        i++;
      }
      row.push(currentToken.trim());
      currentToken = '';
      if (row.length > 0 && row.some(col => col !== '')) {
        lines.push(row);
      }
      row = [];
    } else {
      currentToken += char;
    }
  }

  if (currentToken.length > 0 || row.length > 0) {
    row.push(currentToken.trim());
    if (row.some(col => col !== '')) {
      lines.push(row);
    }
  }

  return lines;
}

// Convert parsed CSV lines into clean task objects
function processCSVRows(rows) {
  // Locate the header row
  let headerIndex = -1;
  for (let i = 0; i < rows.length; i++) {
    const rowStr = rows[i].join(' ').toLowerCase();
    if (rowStr.includes('every x days') || rowStr.includes('last cleaning') || rowStr.includes('urgency score')) {
      headerIndex = i;
      break;
    }
  }

  if (headerIndex === -1) {
    // If no header found, assume row index 2 or 0
    headerIndex = rows.length > 2 ? 2 : 0;
  }

  const dataRows = rows.slice(headerIndex + 1);
  let currentRoom = 'General';
  const tasks = [];

  dataRows.forEach((row, idx) => {
    // Row schema typically:
    // col 0: Room group (e.g. Kitchen)
    // col 1: Room column (Kitchen)
    // col 2: Default Done (FALSE)
    // col 3: Task Name (Vaccum)
    // col 4: Every X days (2)
    // col 5: Last cleaning date (10-Nov or empty)
    // col 6: Over schedule / Schedule status (-1, 3)
    // col 7: Delay days (3 or empty)
    // col 8: Urgency score (100 or empty)

    const roomCol0 = (row[0] || '').trim();
    const roomCol1 = (row[1] || '').trim();
    if (roomCol0) {
      currentRoom = roomCol0;
    } else if (roomCol1) {
      currentRoom = roomCol1;
    }

    const taskName = (row[3] || '').trim();
    if (!taskName) return; // Skip empty rows

    const everyXDays = parseFloat(row[4]) || 1;
    const lastCleaningDateStr = (row[5] || '').trim();
    const rawOverSchedule = parseFloat(row[6]) || 0;
    const rawDelayDays = parseFloat(row[7]) || 0;
    const rawUrgency = parseFloat(row[8]) || 0;

    const taskId = `${currentRoom.toLowerCase().replace(/[^a-z0-9]/g, '_')}_${taskName.toLowerCase().replace(/[^a-z0-9]/g, '_')}`;

    tasks.push({
      id: taskId,
      room: currentRoom,
      name: taskName,
      everyXDays: everyXDays,
      lastCleaningDateStr: lastCleaningDateStr,
      rawOverSchedule: rawOverSchedule,
      rawDelayDays: rawDelayDays,
      rawUrgency: rawUrgency,
      csvIndex: idx
    });
  });

  return tasks;
}

// Calculate live schedule status for a task
function calculateLiveTaskStatus(task) {
  const isDoneToday = Boolean(AppState.doneState[task.id] && AppState.doneState[task.id].done);
  const doneDate = AppState.doneState[task.id]?.doneDate;

  // If marked done in the app today, schedule is fresh:
  if (isDoneToday) {
    return {
      isDone: true,
      doneDate: doneDate,
      daysOverdue: 0,
      urgencyScore: 0,
      statusLabel: 'Completed',
      statusClass: 'status-done',
      urgencyClass: 'urgency-low',
      effectiveLastCleaning: doneDate || 'Today'
    };
  }

  // Use raw values or calculate based on date
  // Over schedule convention in sheet: negative means overdue (e.g. -1 is 1 day overdue), positive or zero means days remaining or due.
  // Delay days: positive means overdue delay.
  // Urgency score: 0 to 100+
  let calculatedUrgency = task.rawUrgency;
  let delay = task.rawDelayDays;

  // If raw urgency is 0 or empty, infer from over schedule
  if (!calculatedUrgency) {
    if (task.rawOverSchedule < 0) {
      // Overdue! (e.g. -3 on a 3 day cycle is 100% overdue)
      const daysLate = Math.abs(task.rawOverSchedule);
      calculatedUrgency = Math.min(100, Math.round((daysLate / task.everyXDays) * 100));
      delay = daysLate;
    } else if (task.rawOverSchedule === 0) {
      calculatedUrgency = 50; // Due today
      delay = 0;
    } else {
      calculatedUrgency = 10;
      delay = 0;
    }
  }

  let statusLabel = 'On Schedule';
  let statusClass = 'status-ok';
  let urgencyClass = 'urgency-low';

  if (calculatedUrgency >= 80 || delay >= 2 || task.rawOverSchedule <= -2) {
    statusLabel = 'Urgent / Overdue';
    statusClass = 'status-urgent';
    urgencyClass = 'urgency-high';
  } else if (calculatedUrgency >= 40 || task.rawOverSchedule <= 0) {
    statusLabel = 'Due Soon';
    statusClass = 'status-due';
    urgencyClass = 'urgency-medium';
  }

  return {
    isDone: false,
    doneDate: null,
    daysOverdue: delay || (task.rawOverSchedule < 0 ? Math.abs(task.rawOverSchedule) : 0),
    urgencyScore: calculatedUrgency,
    statusLabel: statusLabel,
    statusClass: statusClass,
    urgencyClass: urgencyClass,
    effectiveLastCleaning: task.lastCleaningDateStr || 'Never'
  };
}

// ==========================================
// Log & Activity Recording
// ==========================================
function recordActivity(action, task, details = '') {
  const timestamp = new Date().toISOString();
  const dateStr = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  const timeStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  const logEntry = {
    id: 'log_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5),
    action: action, // 'MARK_DONE', 'RESET_DONE', 'ADD_COMMENT', 'CLEAR_COMMENTS'
    taskId: task.id,
    taskName: task.name,
    room: task.room,
    timestamp: timestamp,
    dateStr: dateStr,
    timeStr: timeStr,
    details: details
  };

  AppState.activityLogs.unshift(logEntry);
  // Keep up to 200 activity logs
  if (AppState.activityLogs.length > 200) {
    AppState.activityLogs = AppState.activityLogs.slice(0, 200);
  }

  // Persist in Cookies & LocalStorage
  CookieStore.set('activity_logs', AppState.activityLogs);
  updateLogBadge();
}

// ==========================================
// Data Fetching & Sync
// ==========================================
async function fetchScheduleData() {
  const loadingEl = document.getElementById('loadingIndicator');
  const errorEl = document.getElementById('errorState');
  const tasksListEl = document.getElementById('tasksList');
  const syncIndicator = document.getElementById('syncIndicator');

  loadingEl.classList.remove('hidden');
  errorEl.classList.add('hidden');

  try {
    let csvText = '';
    let isLive = true;

    try {
      const response = await fetch(AppState.csvSourceUrl, { cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      csvText = await response.text();
    } catch (fetchErr) {
      console.warn('Live fetch failed, falling back to local fallback-data.csv:', fetchErr);
      isLive = false;
      const fallbackResp = await fetch('./fallback-data.csv');
      if (!fallbackResp.ok) throw new Error('Could not load fallback CSV data');
      csvText = await fallbackResp.text();
    }

    const rows = parseCSV(csvText);
    AppState.tasks = processCSVRows(rows);
    AppState.lastSyncTime = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    syncIndicator.className = isLive ? 'source-indicator live' : 'source-indicator error';
    document.getElementById('syncSourceText').textContent = isLive
      ? 'Reading from live Google Sheet CSV'
      : 'Using cached offline CSV data';

    renderApp();
  } catch (err) {
    console.error('Fatal fetch error:', err);
    loadingEl.classList.add('hidden');
    errorEl.classList.remove('hidden');
    document.getElementById('errorMessage').textContent = `Error loading data: ${err.message}`;
  } finally {
    loadingEl.classList.add('hidden');
  }
}

// ==========================================
// UI Rendering
// ==========================================
function renderApp() {
  renderStats();
  renderTabs();
  renderTasks();
  updateLogBadge();
}

function renderStats() {
  const total = AppState.tasks.length;
  let urgent = 0;
  let done = 0;

  AppState.tasks.forEach(task => {
    const status = calculateLiveTaskStatus(task);
    if (status.isDone) {
      done++;
    } else if (status.urgencyScore >= 50 || status.daysOverdue > 0) {
      urgent++;
    }
  });

  document.getElementById('totalTasksCount').textContent = total;
  document.getElementById('urgentTasksCount').textContent = urgent;
  document.getElementById('completedTasksCount').textContent = done;
  document.getElementById('lastSyncTime').textContent = AppState.lastSyncTime || 'Just now';
}

function renderTabs() {
  const tabsContainer = document.getElementById('tabsContainer');
  tabsContainer.innerHTML = '';

  // Calculate unique rooms and counts
  const roomCounts = {};
  let totalOverdue = 0;
  let totalDue = 0;
  let totalDone = 0;

  AppState.tasks.forEach(t => {
    roomCounts[t.room] = (roomCounts[t.room] || 0) + 1;
    const st = calculateLiveTaskStatus(t);
    if (st.isDone) totalDone++;
    else if (st.urgencyScore >= 80 || st.daysOverdue >= 2) totalOverdue++;
    else if (st.urgencyScore >= 40) totalDue++;
  });

  const baseTabs = [
    { id: 'all', label: 'All Tasks', count: AppState.tasks.length },
    { id: 'overdue', label: '⚠️ Overdue', count: totalOverdue },
    { id: 'due', label: '⏰ Due Soon', count: totalDue },
    { id: 'completed', label: '✓ Completed', count: totalDone }
  ];

  // Room tabs
  const roomTabs = Object.keys(roomCounts).map(room => ({
    id: 'room_' + room,
    roomName: room,
    label: room,
    count: roomCounts[room]
  }));

  const allTabs = [...baseTabs, ...roomTabs];

  allTabs.forEach(tab => {
    const btn = document.createElement('button');
    btn.className = `tab-btn ${AppState.activeTab === tab.id ? 'active' : ''}`;
    btn.innerHTML = `${tab.label} <span class="tab-count">${tab.count}</span>`;
    btn.addEventListener('click', () => {
      AppState.activeTab = tab.id;
      renderTabs();
      renderTasks();
    });
    tabsContainer.appendChild(btn);
  });
}

function getFilteredAndSortedTasks() {
  return AppState.tasks
    .filter(task => {
      const status = calculateLiveTaskStatus(task);

      // Tab filter
      if (AppState.activeTab === 'overdue') {
        if (status.isDone || (status.urgencyScore < 80 && status.daysOverdue < 2)) return false;
      } else if (AppState.activeTab === 'due') {
        if (status.isDone || status.urgencyScore < 40) return false;
      } else if (AppState.activeTab === 'completed') {
        if (!status.isDone) return false;
      } else if (AppState.activeTab.startsWith('room_')) {
        const roomName = AppState.activeTab.replace('room_', '');
        if (task.room !== roomName) return false;
      }

      // Status dropdown filter
      if (AppState.statusFilter === 'pending' && status.isDone) return false;
      if (AppState.statusFilter === 'done' && !status.isDone) return false;
      if (AppState.statusFilter === 'urgent' && (status.isDone || status.urgencyScore < 50)) return false;
      if (AppState.statusFilter === 'overdue' && (status.isDone || status.daysOverdue <= 0)) return false;

      // Search Query filter
      if (AppState.searchQuery.trim()) {
        const q = AppState.searchQuery.toLowerCase();
        const taskComments = (AppState.commentsState[task.id] || []).map(c => c.text).join(' ').toLowerCase();
        const matchesName = task.name.toLowerCase().includes(q);
        const matchesRoom = task.room.toLowerCase().includes(q);
        const matchesComment = taskComments.includes(q);
        if (!matchesName && !matchesRoom && !matchesComment) return false;
      }

      return true;
    })
    .sort((a, b) => {
      const statusA = calculateLiveTaskStatus(a);
      const statusB = calculateLiveTaskStatus(b);

      switch (AppState.sortBy) {
        case 'urgency-desc':
          return statusB.urgencyScore - statusA.urgencyScore;
        case 'overdue-asc':
          return statusB.daysOverdue - statusA.daysOverdue;
        case 'name-asc':
          return a.name.localeCompare(b.name);
        case 'room-asc':
          return a.room.localeCompare(b.room) || a.name.localeCompare(b.name);
        case 'interval-asc':
          return a.everyXDays - b.everyXDays;
        default:
          return 0;
      }
    });
}

function renderTasks() {
  const tasksList = document.getElementById('tasksList');
  const emptyState = document.getElementById('emptyState');
  const filteredTasks = getFilteredAndSortedTasks();

  tasksList.innerHTML = '';

  if (filteredTasks.length === 0) {
    emptyState.classList.remove('hidden');
    return;
  }
  emptyState.classList.add('hidden');

  filteredTasks.forEach(task => {
    const status = calculateLiveTaskStatus(task);
    const comments = AppState.commentsState[task.id] || [];
    const latestComment = comments.length > 0 ? comments[comments.length - 1] : null;

    const card = document.createElement('div');
    let borderClass = '';
    if (status.isDone) borderClass = 'is-completed';
    else if (status.urgencyClass === 'urgency-high') borderClass = 'is-urgent';
    else if (status.urgencyClass === 'urgency-medium') borderClass = 'is-warning';

    card.className = `task-card ${borderClass}`;
    card.id = `card_${task.id}`;

    card.innerHTML = `
      <div>
        <div class="task-card-header">
          <div class="task-meta-top">
            <span class="room-badge">${escapeHtml(task.room)}</span>
            <span class="urgency-badge ${status.urgencyClass}">
              ${status.isDone ? 'DONE' : `Urgency: ${status.urgencyScore}`}
            </span>
          </div>
        </div>

        <h3 class="task-title">
          <span>${escapeHtml(task.name)}</span>
        </h3>

        <div class="task-details">
          <div class="detail-item">
            <span class="detail-label">Frequency</span>
            <span class="detail-value">Every ${task.everyXDays} day${task.everyXDays > 1 ? 's' : ''}</span>
          </div>
          <div class="detail-item">
            <span class="detail-label">Last Cleaned</span>
            <span class="detail-value">${escapeHtml(status.effectiveLastCleaning)}</span>
          </div>
          <div class="detail-item">
            <span class="detail-label">Schedule Status</span>
            <span class="detail-value" style="color: ${status.isDone ? 'var(--success)' : (status.daysOverdue > 0 ? 'var(--danger)' : 'inherit')}">
              ${status.isDone ? 'Completed Today' : (status.daysOverdue > 0 ? `${status.daysOverdue} days overdue` : 'On track')}
            </span>
          </div>
          <div class="detail-item">
            <span class="detail-label">Urgency Score</span>
            <span class="detail-value">${status.isDone ? '0 (Clean)' : status.urgencyScore + '/100'}</span>
          </div>
        </div>

        ${latestComment ? `
          <div class="task-comment-preview" title="Latest note">
            <span>"${escapeHtml(latestComment.text)}"</span>
            <small style="margin-left: 0.5rem; opacity: 0.7;">${latestComment.dateStr || ''}</small>
          </div>
        ` : ''}
      </div>

      <div class="task-actions">
        <button class="btn-done ${status.isDone ? 'completed' : ''}" data-task-id="${task.id}" aria-label="Toggle completed">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3">
            <polyline points="20 6 9 17 4 12"></polyline>
          </svg>
          <span>${status.isDone ? 'Marked Done' : 'Mark Done'}</span>
        </button>

        <button class="btn-comment ${comments.length > 0 ? 'has-notes' : ''}" data-task-id="${task.id}" title="Task notes & comments">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
          </svg>
          <span>${comments.length > 0 ? comments.length : 'Note'}</span>
        </button>

        ${status.isDone ? `
          <button class="btn-reset-single" data-task-id="${task.id}" title="Reset status to CSV original">
            ↺
          </button>
        ` : ''}
      </div>
    `;

    // Event listeners for card buttons
    const doneBtn = card.querySelector('.btn-done');
    doneBtn.addEventListener('click', () => toggleTaskDone(task));

    const commentBtn = card.querySelector('.btn-comment');
    commentBtn.addEventListener('click', () => openCommentModal(task));

    const resetSingleBtn = card.querySelector('.btn-reset-single');
    if (resetSingleBtn) {
      resetSingleBtn.addEventListener('click', () => resetTaskStatus(task));
    }

    tasksList.appendChild(card);
  });
}

// ==========================================
// Task State Mutations (Cookies & LocalStorage)
// ==========================================
function toggleTaskDone(task) {
  const isCurrentlyDone = Boolean(AppState.doneState[task.id]?.done);
  const todayStr = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

  if (isCurrentlyDone) {
    delete AppState.doneState[task.id];
    recordActivity('RESET_DONE', task, 'Reverted completion status');
  } else {
    AppState.doneState[task.id] = {
      done: true,
      doneDate: todayStr,
      timestamp: Date.now()
    };
    recordActivity('MARK_DONE', task, `Marked complete on ${todayStr}`);
  }

  CookieStore.set('done_map', AppState.doneState);
  renderApp();
}

function resetTaskStatus(task) {
  if (AppState.doneState[task.id]) {
    delete AppState.doneState[task.id];
    CookieStore.set('done_map', AppState.doneState);
    recordActivity('RESET_DONE', task, 'Manually reset to initial CSV state');
    renderApp();
  }
}

function resetAllTasks() {
  if (!confirm('Are you sure you want to reset all tasks back to their original CSV status? This will clear all done marks.')) {
    return;
  }
  AppState.doneState = {};
  CookieStore.set('done_map', AppState.doneState);
  recordActivity('RESET_ALL', { id: 'all', name: 'All Tasks', room: 'System' }, 'Reset all tasks to CSV defaults');
  renderApp();
}

function markFilteredDone() {
  const filtered = getFilteredAndSortedTasks().filter(t => !AppState.doneState[t.id]?.done);
  if (filtered.length === 0) {
    alert('No pending tasks in current view to mark done.');
    return;
  }

  const todayStr = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  filtered.forEach(task => {
    AppState.doneState[task.id] = {
      done: true,
      doneDate: todayStr,
      timestamp: Date.now()
    };
    recordActivity('MARK_DONE', task, `Batch marked complete on ${todayStr}`);
  });

  CookieStore.set('done_map', AppState.doneState);
  renderApp();
}

// ==========================================
// Comment / Notes System
// ==========================================
function openCommentModal(task) {
  AppState.activeCommentTaskId = task.id;
  const modal = document.getElementById('commentModal');
  const taskInfo = document.getElementById('modalTaskInfo');
  const commentsList = document.getElementById('commentsHistoryList');
  const commentInput = document.getElementById('newCommentInput');

  taskInfo.textContent = `${task.room} • ${task.name} (Frequency: Every ${task.everyXDays} days)`;
  commentInput.value = '';

  renderCommentsList(task.id);
  modal.classList.remove('hidden');
}

function renderCommentsList(taskId) {
  const commentsList = document.getElementById('commentsHistoryList');
  const comments = AppState.commentsState[taskId] || [];

  commentsList.innerHTML = '';
  if (comments.length === 0) {
    commentsList.innerHTML = '<p style="color: var(--text-muted); font-size: 0.85rem; font-style: italic;">No comments or notes recorded yet.</p>';
    return;
  }

  comments.forEach((c, idx) => {
    const entry = document.createElement('div');
    entry.className = 'comment-entry';
    entry.innerHTML = `
      <div class="comment-meta">${escapeHtml(c.dateStr || '')} at ${escapeHtml(c.timeStr || '')}</div>
      <div class="comment-text">${escapeHtml(c.text)}</div>
    `;
    commentsList.appendChild(entry);
  });
}

function saveComment(e) {
  e.preventDefault();
  const taskId = AppState.activeCommentTaskId;
  if (!taskId) return;

  const commentInput = document.getElementById('newCommentInput');
  const text = commentInput.value.trim();
  if (!text) return;

  const task = AppState.tasks.find(t => t.id === taskId);
  const now = new Date();
  const commentObj = {
    id: Date.now().toString(),
    text: text,
    timestamp: now.toISOString(),
    dateStr: now.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
    timeStr: now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  };

  if (!AppState.commentsState[taskId]) {
    AppState.commentsState[taskId] = [];
  }
  AppState.commentsState[taskId].push(commentObj);
  CookieStore.set('comments_map', AppState.commentsState);

  if (task) {
    recordActivity('ADD_COMMENT', task, text);
  }

  commentInput.value = '';
  renderCommentsList(taskId);
  renderTasks();
}

function clearTaskComments() {
  const taskId = AppState.activeCommentTaskId;
  if (!taskId) return;

  const task = AppState.tasks.find(t => t.id === taskId);
  if (confirm('Clear all notes for this task?')) {
    delete AppState.commentsState[taskId];
    CookieStore.set('comments_map', AppState.commentsState);
    if (task) {
      recordActivity('CLEAR_COMMENTS', task, 'Cleared all task notes');
    }
    renderCommentsList(taskId);
    renderTasks();
  }
}

// ==========================================
// Activity Log & Export System
// ==========================================
function updateLogBadge() {
  const badge = document.getElementById('logBadge');
  const count = AppState.activityLogs.length;
  if (count > 0) {
    badge.textContent = count > 99 ? '99+' : count;
    badge.classList.remove('hidden');
  } else {
    badge.classList.add('hidden');
  }
}

function openLogModal() {
  const modal = document.getElementById('logModal');
  const listContainer = document.getElementById('logListContainer');
  document.getElementById('logCountDisplay').textContent = AppState.activityLogs.length;

  listContainer.innerHTML = '';
  if (AppState.activityLogs.length === 0) {
    listContainer.innerHTML = '<p style="text-align: center; color: var(--text-muted); padding: 2rem;">No activity logged yet. Marks, resets, and comments will be logged here daily.</p>';
  } else {
    // Group logs by date
    let lastDate = '';
    AppState.activityLogs.forEach(log => {
      if (log.dateStr !== lastDate) {
        lastDate = log.dateStr;
        const groupDate = document.createElement('div');
        groupDate.className = 'log-group-date';
        groupDate.textContent = `📅 ${lastDate}`;
        listContainer.appendChild(groupDate);
      }

      const item = document.createElement('div');
      item.className = 'log-item';

      let icon = '📝';
      let title = 'Action';
      if (log.action === 'MARK_DONE') {
        icon = '✅';
        title = `Marked Complete: ${log.taskName}`;
      } else if (log.action === 'RESET_DONE') {
        icon = '↺';
        title = `Reset Status: ${log.taskName}`;
      } else if (log.action === 'ADD_COMMENT') {
        icon = '💬';
        title = `Added Note: ${log.taskName}`;
      } else if (log.action === 'RESET_ALL') {
        icon = '⚠️';
        title = 'Reset All Tasks';
      }

      item.innerHTML = `
        <div class="log-item-icon">${icon}</div>
        <div class="log-item-content">
          <div class="log-item-title">${escapeHtml(title)}</div>
          <div class="log-item-meta">${escapeHtml(log.room)} • ${log.timeStr} (${log.dateStr})</div>
          ${log.details ? `<div class="log-item-details">"${escapeHtml(log.details)}"</div>` : ''}
        </div>
      `;
      listContainer.appendChild(item);
    });
  }

  modal.classList.remove('hidden');
}

function clearAllLogs() {
  if (AppState.activityLogs.length === 0) return;
  if (confirm('Clear all activity history logs? This cannot be undone.')) {
    AppState.activityLogs = [];
    CookieStore.remove('activity_logs');
    updateLogBadge();
    openLogModal();
  }
}

function exportLogsToCSV() {
  if (AppState.activityLogs.length === 0) {
    alert('No logs available to export.');
    return;
  }

  const headers = ['Timestamp', 'Date', 'Time', 'Action', 'Room', 'Task Name', 'Details'];
  const rows = AppState.activityLogs.map(log => [
    `"${log.timestamp}"`,
    `"${log.dateStr}"`,
    `"${log.timeStr}"`,
    `"${log.action}"`,
    `"${log.room.replace(/"/g, '""')}"`,
    `"${log.taskName.replace(/"/g, '""')}"`,
    `"${(log.details || '').replace(/"/g, '""')}"`
  ]);

  const csvContent = [headers.join(','), ...rows.map(r => r.join(','))].join('\r\n');
  downloadFile(csvContent, `cleaning-logs-${new Date().toISOString().slice(0, 10)}.csv`, 'text/csv;charset=utf-8;');
}

function exportLogsToTXT() {
  if (AppState.activityLogs.length === 0) {
    alert('No logs available to export.');
    return;
  }

  let txtContent = `=======================================================\n`;
  txtContent += `       CLEANTRACK ACTIVITY HISTORY & LOG REPORT        \n`;
  txtContent += `=======================================================\n`;
  txtContent += `Generated: ${new Date().toLocaleString()}\n`;
  txtContent += `Total Log Entries: ${AppState.activityLogs.length}\n\n`;

  let lastDate = '';
  AppState.activityLogs.forEach((log, idx) => {
    if (log.dateStr !== lastDate) {
      lastDate = log.dateStr;
      txtContent += `\n--- [ ${lastDate} ] ------------------------------------\n`;
    }
    txtContent += `[${log.timeStr}] [${log.action}] ${log.room} - ${log.taskName}\n`;
    if (log.details) {
      txtContent += `  Details: ${log.details}\n`;
    }
  });

  downloadFile(txtContent, `cleaning-logs-${new Date().toISOString().slice(0, 10)}.txt`, 'text/plain;charset=utf-8;');
}

function downloadFile(content, fileName, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    document.body.removeChild(a);
    window.URL.revokeObjectURL(url);
  }, 100);
}

// ==========================================
// Theme Management
// ==========================================
function initTheme() {
  const savedTheme = CookieStore.get('theme') || 'dark';
  document.documentElement.setAttribute('data-theme', savedTheme);
  updateThemeIcon(savedTheme);
}

function toggleTheme() {
  const current = document.documentElement.getAttribute('data-theme') || 'dark';
  const newTheme = current === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', newTheme);
  CookieStore.set('theme', newTheme);
  updateThemeIcon(newTheme);
}

function updateThemeIcon(theme) {
  const icon = document.getElementById('themeIcon');
  if (icon) {
    icon.textContent = theme === 'dark' ? '☀️' : '🌙';
  }
}

// ==========================================
// Utility Helpers
// ==========================================
function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// ==========================================
// Event Listeners & Initialization
// ==========================================
function setupEventListeners() {
  // Sync button
  document.getElementById('refreshBtn').addEventListener('click', () => {
    fetchScheduleData();
  });

  // Theme toggle
  document.getElementById('themeToggleBtn').addEventListener('click', toggleTheme);

  // Search input
  const searchInput = document.getElementById('searchInput');
  const clearSearchBtn = document.getElementById('clearSearchBtn');
  searchInput.addEventListener('input', (e) => {
    AppState.searchQuery = e.target.value;
    clearSearchBtn.classList.toggle('hidden', !AppState.searchQuery);
    renderTasks();
  });
  clearSearchBtn.addEventListener('click', () => {
    searchInput.value = '';
    AppState.searchQuery = '';
    clearSearchBtn.classList.add('hidden');
    renderTasks();
  });

  // Status Filter Select
  document.getElementById('statusFilterSelect').addEventListener('change', (e) => {
    AppState.statusFilter = e.target.value;
    renderTasks();
  });

  // Sort Select
  document.getElementById('sortSelect').addEventListener('change', (e) => {
    AppState.sortBy = e.target.value;
    renderTasks();
  });

  // Bulk actions
  document.getElementById('markFilteredDoneBtn').addEventListener('click', markFilteredDone);
  document.getElementById('resetAllBtn').addEventListener('click', resetAllTasks);

  // Reset filters button from empty state
  document.getElementById('resetFiltersBtn').addEventListener('click', () => {
    AppState.activeTab = 'all';
    AppState.searchQuery = '';
    AppState.statusFilter = 'all';
    searchInput.value = '';
    clearSearchBtn.classList.add('hidden');
    document.getElementById('statusFilterSelect').value = 'all';
    renderApp();
  });

  // Comments modal
  document.getElementById('closeCommentModalBtn').addEventListener('click', () => {
    document.getElementById('commentModal').classList.add('hidden');
  });
  document.getElementById('commentForm').addEventListener('submit', saveComment);
  document.getElementById('deleteCommentsBtn').addEventListener('click', clearTaskComments);

  // Activity Log modal
  document.getElementById('viewLogsBtn').addEventListener('click', openLogModal);
  document.getElementById('closeLogModalBtn').addEventListener('click', () => {
    document.getElementById('logModal').classList.add('hidden');
  });
  document.getElementById('exportCsvBtn').addEventListener('click', exportLogsToCSV);
  document.getElementById('exportTxtBtn').addEventListener('click', exportLogsToTXT);
  document.getElementById('clearLogsBtn').addEventListener('click', clearAllLogs);

  // Custom Source Modal
  const sourceModal = document.getElementById('sourceModal');
  const customCsvUrlInput = document.getElementById('customCsvUrlInput');
  document.getElementById('changeSourceBtn').addEventListener('click', () => {
    customCsvUrlInput.value = AppState.csvSourceUrl;
    sourceModal.classList.remove('hidden');
  });
  document.getElementById('closeSourceModalBtn').addEventListener('click', () => {
    sourceModal.classList.add('hidden');
  });
  document.getElementById('saveCustomUrlBtn').addEventListener('click', () => {
    const val = customCsvUrlInput.value.trim();
    if (val) {
      AppState.csvSourceUrl = val;
      CookieStore.set('custom_csv_url', val);
      sourceModal.classList.add('hidden');
      fetchScheduleData();
    }
  });
  document.getElementById('restoreDefaultUrlBtn').addEventListener('click', () => {
    customCsvUrlInput.value = DEFAULT_CSV_URL;
    AppState.csvSourceUrl = DEFAULT_CSV_URL;
    CookieStore.remove('custom_csv_url');
    sourceModal.classList.add('hidden');
    fetchScheduleData();
  });

  // Retry button
  document.getElementById('retryBtn').addEventListener('click', () => {
    fetchScheduleData();
  });

  // Close modals on clicking backdrop
  document.querySelectorAll('.modal-backdrop').forEach(modal => {
    modal.addEventListener('click', (e) => {
      if (e.target === modal) {
        modal.classList.add('hidden');
      }
    });
  });

  // Online / offline banner
  const offlineBanner = document.getElementById('offlineBanner');
  window.addEventListener('online', () => offlineBanner.classList.add('hidden'));
  window.addEventListener('offline', () => offlineBanner.classList.remove('hidden'));
  if (!navigator.onLine) offlineBanner.classList.remove('hidden');
}

// Service worker registration
function registerServiceWorker() {
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js')
        .then((reg) => {
          console.log('CleanTrack ServiceWorker registered:', reg.scope);
        })
        .catch((err) => {
          console.warn('ServiceWorker registration failed:', err);
        });
    });
  }
}

// Initialize application
document.addEventListener('DOMContentLoaded', () => {
  initTheme();
  setupEventListeners();
  fetchScheduleData();
  registerServiceWorker();
});
