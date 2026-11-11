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

  // User requirement: In the overschedule column, ignore the negative numbers. They imply no delay.
  // Delay days: positive numbers indicate delay, while negative numbers imply no delay (0).
  const positiveOverSchedule = task.rawOverSchedule > 0 ? task.rawOverSchedule : 0;
  const positiveDelayDays = task.rawDelayDays > 0 ? task.rawDelayDays : 0;

  let delay = positiveDelayDays || positiveOverSchedule;
  let calculatedUrgency = task.rawUrgency;

  if (!calculatedUrgency) {
    if (delay > 0) {
      calculatedUrgency = Math.min(100, Math.round((delay / task.everyXDays) * 100));
    } else {
      calculatedUrgency = 0;
    }
  }

  let statusLabel = 'On Schedule';
  let statusClass = 'status-ok';
  let urgencyClass = 'urgency-low';

  if (delay >= 2 || calculatedUrgency >= 80) {
    statusLabel = 'Urgent / Overdue';
    statusClass = 'status-urgent';
    urgencyClass = 'urgency-high';
  } else if (delay > 0 || calculatedUrgency >= 40) {
    statusLabel = 'Due Soon';
    statusClass = 'status-due';
    urgencyClass = 'urgency-medium';
  }

  return {
    isDone: false,
    doneDate: null,
    daysOverdue: delay,
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
function openDrawer() {
  const drawer = document.getElementById('sideDrawer');
  const backdrop = document.getElementById('drawerBackdrop');
  if (drawer && backdrop) {
    drawer.classList.add('open');
    backdrop.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
  }
}

function closeDrawer() {
  const drawer = document.getElementById('sideDrawer');
  const backdrop = document.getElementById('drawerBackdrop');
  if (drawer && backdrop) {
    drawer.classList.remove('open');
    backdrop.classList.add('hidden');
    document.body.style.overflow = '';
  }
}

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
  const quickContainer = document.getElementById('quickFilterItems');
  const roomContainer = document.getElementById('roomFilterItems');
  const currentLabel = document.getElementById('currentFilterLabel');
  const activeHeading = document.getElementById('activeFilterHeading');

  if (quickContainer) quickContainer.innerHTML = '';
  if (roomContainer) roomContainer.innerHTML = '';

  // Calculate unique rooms and counts
  const roomCounts = {};
  let totalOverdue = 0;
  let totalDue = 0;
  let totalDone = 0;

  AppState.tasks.forEach(t => {
    roomCounts[t.room] = (roomCounts[t.room] || 0) + 1;
    const st = calculateLiveTaskStatus(t);
    if (st.isDone) totalDone++;
    else if (st.daysOverdue >= 2 || st.urgencyScore >= 80) totalOverdue++;
    else if (st.daysOverdue > 0 || st.urgencyScore >= 40) totalDue++;
  });

  const baseTabs = [
    { id: 'all', icon: '📋', label: 'All Tasks', count: AppState.tasks.length },
    { id: 'overdue', icon: '⚠️', label: 'Overdue Delay', count: totalOverdue },
    { id: 'due', icon: '⏰', label: 'Due Soon', count: totalDue },
    { id: 'completed', icon: '✓', label: 'Completed', count: totalDone }
  ];

  const roomTabs = Object.keys(roomCounts).map(room => ({
    id: 'room_' + room,
    icon: '🚪',
    roomName: room,
    label: room,
    count: roomCounts[room]
  }));

  let currentTitle = 'All Tasks';

  const createDrawerItem = (tab) => {
    const btn = document.createElement('button');
    const isActive = AppState.activeTab === tab.id;
    if (isActive) currentTitle = tab.label;

    btn.className = `drawer-item ${isActive ? 'active' : ''}`;
    btn.innerHTML = `
      <span class="drawer-item-title">${tab.icon || ''} ${escapeHtml(tab.label)}</span>
      <span class="drawer-item-count">${tab.count}</span>
    `;
    btn.addEventListener('click', () => {
      AppState.activeTab = tab.id;
      closeDrawer();
      renderTabs();
      renderTasks();
    });
    return btn;
  };

  if (quickContainer) {
    baseTabs.forEach(tab => quickContainer.appendChild(createDrawerItem(tab)));
  }

  if (roomContainer) {
    roomTabs.forEach(tab => roomContainer.appendChild(createDrawerItem(tab)));
  }

  if (currentLabel) currentLabel.textContent = currentTitle;
  if (activeHeading) activeHeading.textContent = currentTitle;
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

// Track expanded task IDs for the collapsible single-line list items
AppState.expandedTaskIds = AppState.expandedTaskIds || new Set();

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
    const isExpanded = AppState.expandedTaskIds.has(task.id);

    const row = document.createElement('div');
    let stateClass = '';
    if (status.isDone) stateClass = 'is-completed';
    else if (status.urgencyClass === 'urgency-high') stateClass = 'is-urgent';
    else if (status.urgencyClass === 'urgency-medium') stateClass = 'is-warning';

    row.className = `task-row ${stateClass} ${isExpanded ? 'expanded' : ''}`;
    row.id = `row_${task.id}`;

    // Single-line compact row header + details panel
    row.innerHTML = `
      <div class="row-main" data-task-id="${task.id}">
        <button class="btn-row-done ${status.isDone ? 'completed' : ''}" data-task-id="${task.id}" aria-label="Mark task done" title="${status.isDone ? 'Marked complete (click to undo)' : 'Mark task complete'}">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3">
            <polyline points="20 6 9 17 4 12"></polyline>
          </svg>
        </button>

        <div class="row-info" title="Click to view details">
          <div class="row-title-line">
            <span class="row-title ${status.isDone ? 'title-done' : ''}">${escapeHtml(task.name)}</span>
            <span class="row-room-badge">${escapeHtml(task.room)}</span>
            ${comments.length > 0 ? `<span class="row-comment-indicator" title="${comments.length} notes">💬 ${comments.length}</span>` : ''}
          </div>
          <div class="row-sub-line">
            <span class="row-sub-text">Every ${task.everyXDays}d &bull; Last: ${escapeHtml(status.effectiveLastCleaning)}</span>
            ${status.isDone
              ? '<span class="status-pill status-pill-done">Done</span>'
              : (status.daysOverdue > 0
                  ? `<span class="status-pill status-pill-urgent">+${status.daysOverdue}d delay</span>`
                  : '<span class="status-pill status-pill-ok">On Track</span>'
                )
            }
          </div>
        </div>

        <div class="row-expand-arrow" title="Toggle full details">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
            <polyline points="6 9 12 15 18 9"></polyline>
          </svg>
        </div>
      </div>

      <div class="row-details ${isExpanded ? 'open' : ''}">
        <div class="details-grid">
          <div class="detail-box">
            <span class="d-label">Room / Location</span>
            <span class="d-val">${escapeHtml(task.room)}</span>
          </div>
          <div class="detail-box">
            <span class="d-label">Frequency Cycle</span>
            <span class="d-val">Every ${task.everyXDays} day${task.everyXDays > 1 ? 's' : ''}</span>
          </div>
          <div class="detail-box">
            <span class="d-label">Last Cleaned</span>
            <span class="d-val">${escapeHtml(status.effectiveLastCleaning)}</span>
          </div>
          <div class="detail-box">
            <span class="d-label">Delay Status</span>
            <span class="d-val" style="color: ${status.isDone ? 'var(--success)' : (status.daysOverdue > 0 ? 'var(--danger)' : 'var(--text-secondary)')}">
              ${status.isDone ? 'Cleaned Today' : (status.daysOverdue > 0 ? `${status.daysOverdue} days overdue` : 'No delay (On schedule)')}
            </span>
          </div>
          <div class="detail-box">
            <span class="d-label">Urgency Score</span>
            <span class="d-val">${status.isDone ? '0' : status.urgencyScore + '/100'}</span>
          </div>
        </div>

        ${comments.length > 0 ? `
          <div class="details-notes-preview">
            <strong>Notes (${comments.length}):</strong>
            <ul class="compact-notes-list">
              ${comments.slice(-2).map(c => `<li>"${escapeHtml(c.text)}" <small>(${c.dateStr || ''})</small></li>`).join('')}
            </ul>
          </div>
        ` : ''}

        <div class="row-actions-bar">
          <button class="btn btn-sm btn-outline-primary btn-action-comment" data-task-id="${task.id}">
            💬 Notes &amp; Comments (${comments.length})
          </button>
          ${status.isDone ? `
            <button class="btn btn-sm btn-outline-danger btn-action-reset" data-task-id="${task.id}">
              ↺ Reset to CSV Default
            </button>
          ` : `
            <button class="btn btn-sm btn-success btn-action-done" data-task-id="${task.id}">
              ✓ Mark Complete
            </button>
          `}
        </div>
      </div>
    `;

    // Click handler for toggle mark done directly from the list item icon
    const doneBtn = row.querySelector('.btn-row-done');
    doneBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleTaskDone(task);
    });

    // Click on row main expands/collapses detailed view
    const rowMain = row.querySelector('.row-main');
    rowMain.addEventListener('click', (e) => {
      if (e.target.closest('.btn-row-done')) return;
      if (AppState.expandedTaskIds.has(task.id)) {
        AppState.expandedTaskIds.delete(task.id);
      } else {
        AppState.expandedTaskIds.add(task.id);
      }
      renderTasks();
    });

    // Detailed actions
    const commentBtn = row.querySelector('.btn-action-comment');
    if (commentBtn) {
      commentBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        openCommentModal(task);
      });
    }

    const resetBtn = row.querySelector('.btn-action-reset');
    if (resetBtn) {
      resetBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        resetTaskStatus(task);
      });
    }

    const actionDoneBtn = row.querySelector('.btn-action-done');
    if (actionDoneBtn) {
      actionDoneBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleTaskDone(task);
      });
    }

    tasksList.appendChild(row);
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

  // Hamburger drawer navigation
  const hamburgerBtn = document.getElementById('hamburgerBtn');
  const closeDrawerBtn = document.getElementById('closeDrawerBtn');
  const drawerBackdrop = document.getElementById('drawerBackdrop');
  const openMenuPillBtn = document.getElementById('openMenuPillBtn');

  if (hamburgerBtn) hamburgerBtn.addEventListener('click', openDrawer);
  if (closeDrawerBtn) closeDrawerBtn.addEventListener('click', closeDrawer);
  if (drawerBackdrop) drawerBackdrop.addEventListener('click', closeDrawer);
  if (openMenuPillBtn) openMenuPillBtn.addEventListener('click', openDrawer);

  const drawerOpenLogsBtn = document.getElementById('drawerOpenLogsBtn');
  if (drawerOpenLogsBtn) {
    drawerOpenLogsBtn.addEventListener('click', () => {
      closeDrawer();
      openLogModal();
    });
  }

  const drawerOpenSourceBtn = document.getElementById('drawerOpenSourceBtn');
  if (drawerOpenSourceBtn) {
    drawerOpenSourceBtn.addEventListener('click', () => {
      closeDrawer();
      customCsvUrlInput.value = AppState.csvSourceUrl;
      sourceModal.classList.remove('hidden');
    });
  }

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
