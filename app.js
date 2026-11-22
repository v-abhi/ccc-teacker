const STORAGE_KEY = 'ccc_tracker_v3';
const THEME_KEY = 'ccc_tracker_theme';
const REMINDER_KEY = 'ccc_tracker_reminder';
const APP_PUBLIC_URL = 'https://v-abhi.github.io/ccc-teacker/';
const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

let expandedAccordions = new Set();
let calendarViewMonth = new Map();
let lastRenderedDate = '';
let editingCommitmentId = null;

/* Theme Management (Daylight / Nightlight) */
function applyTheme(theme) {
  const mode = theme === 'light' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', mode);
  localStorage.setItem(THEME_KEY, mode);

  const toggleBtn = document.getElementById('btn-theme-toggle');
  if (toggleBtn) toggleBtn.innerHTML = mode === 'dark' ? '&#9728;&#65039;' : '&#127769;';

  const metaTheme = document.getElementById('meta-theme-color');
  if (metaTheme) metaTheme.setAttribute('content', mode === 'dark' ? '#0d1015' : '#ffffff');
}

function getLocalDateStr(dateObj = new Date()) {
  const y = dateObj.getFullYear();
  const m = String(dateObj.getMonth() + 1).padStart(2, '0');
  const d = String(dateObj.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function parseLocalDate(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function formatShortDate(dateStr) {
  const d = parseLocalDate(dateStr);
  return `${d.getDate()} ${MONTHS_SHORT[d.getMonth()]}`;
}

function shiftMonthStr(ymStr, delta) {
  const [y, m] = ymStr.split('-').map(Number);
  const dt = new Date(y, m - 1 + delta, 1);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}`;
}

/* Point 6: Normalize commitments into versioned forward-only rules so past dates stay immutable */
function normalizeCommitment(c) {
  if (!Array.isArray(c.rules) || c.rules.length === 0) {
    c.rules = [{
      effectiveFrom: c.startDate,
      freq: c.freq || 'daily',
      specificDays: Array.isArray(c.specificDays) ? c.specificDays : [1, 2, 3, 4, 5],
      rollingTarget: c.rollingTarget || 3,
      target: c.target || 20,
      threshold: c.threshold || 80
    }];
  }
  if (!c.logs) c.logs = {};
  if (c.reminderTime === undefined) c.reminderTime = '';
  return c;
}

function getRuleForDate(c, dateStr) {
  normalizeCommitment(c);
  let active = c.rules[0];
  for (const r of c.rules) {
    if (r.effectiveFrom <= dateStr) {
      active = r;
    } else {
      break;
    }
  }
  return active;
}

let state = loadState();

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY) || localStorage.getItem('ccc_tracker_v2') || localStorage.getItem('ccc_tracker_v1');
    const parsed = raw ? JSON.parse(raw) : { commitments: [] };
    parsed.commitments = (parsed.commitments || []).map(normalizeCommitment);
    return parsed;
  } catch {
    return { commitments: [] };
  }
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  mirrorBackupToAndroidDocuments();
}

async function mirrorBackupToAndroidDocuments() {
  try {
    const cap = window.Capacitor;
    if (!cap || !cap.isNativePlatform || !cap.isNativePlatform()) return;
    const { Filesystem } = cap.Plugins;
    if (!Filesystem) return;

    await Filesystem.writeFile({
      path: 'CCCTracker/ccc-auto-backup.json',
      data: JSON.stringify(state, null, 2),
      directory: 'DOCUMENTS',
      encoding: 'utf8',
      recursive: true
    });
  } catch {}
}

/* Automatically restores saved data from Documents/CCCTracker if local storage is empty after reinstall */
async function restoreMirrorBackupFromAndroidDocuments() {
  try {
    const cap = window.Capacitor;
    if (!cap || !cap.isNativePlatform || !cap.isNativePlatform()) return false;
    const { Filesystem } = cap.Plugins;
    if (!Filesystem) return false;

    const res = await Filesystem.readFile({
      path: 'CCCTracker/ccc-auto-backup.json',
      directory: 'DOCUMENTS',
      encoding: 'utf8'
    });

    const parsed = JSON.parse(typeof res.data === 'string' ? res.data : '');
    if (!Array.isArray(parsed.commitments)) return false;

    parsed.commitments = parsed.commitments.map(normalizeCommitment);
    state = parsed;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    renderAll();
    return true;
  } catch {
    return false;
  }
}

/* Point 6: Generate scheduled slots using whichever rule applies on each cursor date */
function generateSlots(c) {
  normalizeCommitment(c);
  const slots = [];
  let cursor = parseLocalDate(c.startDate);
  let safety = 0;

  while (slots.length < c.totalDays && safety < 2500) {
    const dateStr = getLocalDateStr(cursor);
    const rule = getRuleForDate(c, dateStr);
    const dayOfWeek = cursor.getDay();

    let isScheduledDay = false;
    if (rule.freq === 'daily' || rule.freq === 'rolling') {
      isScheduledDay = true;
    } else if (rule.freq === 'specific') {
      isScheduledDay = rule.specificDays.map(Number).includes(dayOfWeek);
    }

    if (isScheduledDay) {
      slots.push({
        index: slots.length + 1,
        date: dateStr,
        rule
      });
    }

    cursor.setDate(cursor.getDate() + 1);
    safety++;
  }

  return slots;
}

function evaluateCommitment(c, todayStr) {
  const slots = generateSlots(c);
  let elapsedCount = 0;
  let completedCount = 0;
  let partialCount = 0;
  let missedCount = 0;
  let remainingCount = 0;
  let totalScoreSum = 0;
  let currentStreak = 0;
  let longestStreak = 0;

  const enrichedSlots = slots.map(slot => {
    const rawVal = c.logs[slot.date];
    const isPast = slot.date < todayStr;
    const isToday = slot.date === todayStr;
    const isFuture = slot.date > todayStr;
    const rule = slot.rule;

    let status = 'future';
    let score = 0;
    let pct = 0;
    let isCompliant = false;

    if (isFuture) {
      remainingCount++;
    } else {
      if (rawVal !== undefined && rawVal !== null) {
        if (c.mode === 'binary') {
          score = rawVal === 1 ? 1 : 0;
          pct = score * 100;
          isCompliant = score === 1;
        } else {
          pct = Math.min(100, Math.round((rawVal / rule.target) * 100));
          score = pct / 100;
          isCompliant = pct >= rule.threshold;
        }
      }

      if (isPast) {
        elapsedCount++;
        totalScoreSum += score;
        if (isCompliant) {
          completedCount++;
          currentStreak++;
          longestStreak = Math.max(longestStreak, currentStreak);
          status = 'done';
        } else {
          currentStreak = 0;
          if (rawVal > 0) {
            partialCount++;
            status = 'partial';
          } else {
            missedCount++;
            status = 'missed';
          }
        }
      } else if (isToday) {
        if (rawVal !== undefined && rawVal !== null) {
          elapsedCount++;
          totalScoreSum += score;
          if (isCompliant) {
            completedCount++;
            currentStreak++;
            longestStreak = Math.max(longestStreak, currentStreak);
            status = 'done';
          } else if (rawVal > 0) {
            partialCount++;
            status = 'partial';
          } else {
            missedCount++;
            status = 'missed';
          }
        } else {
          remainingCount++;
          status = 'today';
        }
      }
    }

    return { ...slot, rawVal, pct, status, isToday, isPast, isFuture };
  });

  const latestRule = getRuleForDate(c, todayStr);
  let compliancePct = elapsedCount > 0 ? Math.round((completedCount / elapsedCount) * 100) : 100;
  if (latestRule.freq === 'rolling' && elapsedCount > 0) {
    const weeksElapsed = Math.ceil(elapsedCount / 7);
    const expectedToDate = Math.min(elapsedCount, weeksElapsed * latestRule.rollingTarget);
    compliancePct = expectedToDate > 0 ? Math.min(100, Math.round((completedCount / expectedToDate) * 100)) : 100;
  }

  const completionPct = Math.round((totalScoreSum / c.totalDays) * 100);
  const lastSlotDate = slots.length ? slots[slots.length - 1].date : c.startDate;
  const isCompleted = lastSlotDate < todayStr;

  return {
    slots: enrichedSlots,
    totalScheduled: c.totalDays,
    elapsedCount,
    completedCount,
    partialCount,
    missedCount,
    remainingCount,
    compliancePct,
    completionPct,
    currentStreak,
    longestStreak,
    isCompleted,
    latestRule
  };
}

function updateTodayLabel() {
  const el = document.getElementById('today-label');
  if (!el) return;

  el.textContent = new Date().toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZoneName: 'short'
  });
}

function renderAll() {
  const todayStr = getLocalDateStr();
  lastRenderedDate = todayStr;
  updateTodayLabel();

  renderDashboard(todayStr);
  renderTimeline(todayStr);
  renderAnalytics(todayStr);
}

function syncDateIfRolledOver() {
  const currentToday = getLocalDateStr();
  if (lastRenderedDate && currentToday !== lastRenderedDate) {
    renderAll();
  }
}

/* TAB 1: DASHBOARD (Point 4: Automatically hides finished commitments) */
function renderDashboard(todayStr) {
  const container = document.getElementById('dashboard-list');
  container.innerHTML = '';

  const ongoingCommitments = state.commitments
    .map(c => ({ c, stats: evaluateCommitment(c, todayStr) }))
    .filter(({ stats }) => !stats.isCompleted);

  if (ongoingCommitments.length === 0) {
    container.innerHTML = `<div class="card"><p class="muted">No active commitments. Tap "+ New" to start a new commitment.</p></div>`;
    return;
  }

  const items = ongoingCommitments.map(({ c, stats }) => {
    const todaySlot = stats.slots.find(s => s.isToday);
    return { c, stats, todaySlot, isActiveToday: Boolean(todaySlot) };
  }).sort((a, b) => Number(b.isActiveToday) - Number(a.isActiveToday));

  items.forEach(({ c, todaySlot, isActiveToday }) => {
    const row = document.createElement('div');
    row.className = `dash-item ${isActiveToday ? '' : 'inactive-today'}`;

    if (!isActiveToday) {
      row.innerHTML = `
        <div class="binary-row">
          <div>
            <div class="dash-title">${escapeHtml(c.title)}</div>
            <div class="dash-sub">Off-day &bull; Not scheduled today</div>
          </div>
        </div>`;
      container.appendChild(row);
      return;
    }

    const loggedVal = c.logs[todayStr];
    const activeRule = todaySlot.rule;

    if (c.mode === 'binary') {
      const isChecked = loggedVal === 1;
      row.innerHTML = `
        <div class="binary-row">
          <div>
            <div class="dash-title">${escapeHtml(c.title)}</div>
            <div class="dash-sub">D${todaySlot.index} of ${c.totalDays} &bull; Binary</div>
          </div>
          <label class="chk-box-label" aria-label="Mark ${escapeHtml(c.title)} completed">
            <input type="checkbox" ${isChecked ? 'checked' : ''}
              onchange="toggleBinaryCheckbox('${c.id}', '${todayStr}', this.checked)" />
          </label>
        </div>`;
    } else {
      const currentUnits = (loggedVal !== undefined && loggedVal !== null) ? loggedVal : 0;
      const currentPct = Math.min(100, Math.round((currentUnits / activeRule.target) * 100));

      row.innerHTML = `
        <div class="spec-top">
          <div>
            <div class="dash-title">${escapeHtml(c.title)}</div>
            <div class="dash-sub">D${todaySlot.index} of ${c.totalDays} &bull; Spectrum</div>
          </div>
          <span class="spec-min">Min: ${activeRule.threshold}%</span>
        </div>
        <div class="spec-progress-line">
          Progress: <strong id="lbl-pct-${c.id}">${currentPct}%</strong> &bull; <span id="lbl-unit-${c.id}">${currentUnits}</span>/${activeRule.target} ${escapeHtml(c.unit)}
        </div>
        <input type="range" class="spec-slider" id="rng-${c.id}" min="0" max="100" step="5" value="${currentPct}"
          oninput="previewSlider('${c.id}', ${activeRule.target}, this.value)"
          onchange="autoSaveSlider('${c.id}', '${todayStr}', ${activeRule.target}, this.value)" />
      `;
    }

    container.appendChild(row);
  });
}

/* TAB 2: SINGLE-MONTH BOUNDED CALENDAR (Point 3: Today underlined even on off-days) */
function buildSingleMonthCalendarHtml(c, stats, todayStr) {
  if (!stats.slots.length) return '';

  const slotMap = new Map();
  stats.slots.forEach(s => slotMap.set(s.date, s));

  const minYm = stats.slots[0].date.slice(0, 7);
  const maxYm = stats.slots[stats.slots.length - 1].date.slice(0, 7);

  if (!calendarViewMonth.has(c.id)) {
    const todayYm = todayStr.slice(0, 7);
    if (todayYm >= minYm && todayYm <= maxYm) calendarViewMonth.set(c.id, todayYm);
    else calendarViewMonth.set(c.id, minYm);
  }

  let activeYm = calendarViewMonth.get(c.id);
  if (activeYm < minYm) activeYm = minYm;
  if (activeYm > maxYm) activeYm = maxYm;
  calendarViewMonth.set(c.id, activeYm);

  const canPrev = activeYm > minYm;
  const canNext = activeYm < maxYm;

  const [year, month] = activeYm.split('-').map(Number);

  const activeCols = new Set();
  const sampleDateInMonth = `${activeYm}-15`;
  const viewRule = getRuleForDate(c, sampleDateInMonth);
  if (viewRule.freq === 'specific') {
    viewRule.specificDays.forEach(jsDay => activeCols.add((Number(jsDay) + 6) % 7));
  } else {
    [0, 1, 2, 3, 4, 5, 6].forEach(col => activeCols.add(col));
  }

  const weekdayLabels = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const weekdayHeaderHtml = `<div class="cal-weekdays">${
    weekdayLabels.map((lbl, idx) => `<span class="${activeCols.has(idx) ? 'wk-active' : ''}">${lbl}</span>`).join('')
  }</div>`;

  const firstOfMonth = new Date(year, month - 1, 1);
  const daysInMonth = new Date(year, month, 0).getDate();
  const startOffset = (firstOfMonth.getDay() + 6) % 7;

  const cells = [];
  for (let i = 0; i < startOffset; i++) {
    cells.push(`<div class="cal-cell blank"></div>`);
  }

  for (let day = 1; day <= daysInMonth; day++) {
    const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const slot = slotMap.get(dateStr);
    const isTodayDate = dateStr === todayStr;
    const todayUnderlineClass = isTodayDate ? ' is-today-marker' : '';
    const dd = String(day).padStart(2, '0');
    const mmm = MONTHS_SHORT[month - 1];

    if (!slot) {
      if (isTodayDate) {
        cells.push(`
          <div class="cal-cell blank${todayUnderlineClass}" title="${dateStr} (Today - Off-day)">
            <span class="cal-dd">${dd}</span>
            <span class="cal-mmm">${mmm}</span>
          </div>`);
      } else {
        cells.push(`<div class="cal-cell blank"></div>`);
      }
    } else {
      cells.push(`
        <div class="cal-cell ${slot.status}${todayUnderlineClass}" title="${dateStr} (${slot.status})">
          <span class="cal-dd">${dd}</span>
          <span class="cal-mmm">${mmm}</span>
        </div>`);
    }
  }

  while (cells.length % 7 !== 0) {
    cells.push(`<div class="cal-cell blank"></div>`);
  }

  const monthTitle = `${MONTHS_SHORT[month - 1]} ${year}`;
  return `
    <div class="cal-nav-bar">
      <button type="button" class="cal-nav-btn" ${canPrev ? '' : 'disabled'} onclick="changeCalMonth('${c.id}', -1)">&larr; Prev</button>
      <span class="month-title">${monthTitle}</span>
      <button type="button" class="cal-nav-btn" ${canNext ? '' : 'disabled'} onclick="changeCalMonth('${c.id}', 1)">Next &rarr;</button>
    </div>
    ${weekdayHeaderHtml}
    <div class="cal-grid">${cells.join('')}</div>
  `;
}

function renderTimeline(todayStr) {
  const container = document.getElementById('timeline-accordion');
  container.innerHTML = '';

  if (state.commitments.length === 0) {
    container.innerHTML = `<div class="card"><p class="muted">No commitments to inspect.</p></div>`;
    return;
  }

  state.commitments.forEach(c => {
    const stats = evaluateCommitment(c, todayStr);
    const isOpen = expandedAccordions.has(c.id);

    const item = document.createElement('div');
    item.className = `acc-item ${isOpen ? 'open' : ''}`;

    const calendarHtml = buildSingleMonthCalendarHtml(c, stats, todayStr);

    item.innerHTML = `
      <button class="acc-header" onclick="toggleAccordion('${c.id}')">
        <div>
          <div class="dash-title">${escapeHtml(c.title)}</div>
          <div class="dash-sub">${stats.completedCount}/${stats.totalScheduled} Completed &bull; Starts ${formatShortDate(c.startDate)}</div>
        </div>
        <span class="chevron">&#9660;</span>
      </button>
      <div class="acc-body">
        <div class="cal-legend">
          <span><i class="leg-dot" style="background:var(--green);"></i>Done</span>
          <span><i class="leg-dot" style="background:var(--yellow);"></i>Partial</span>
          <span><i class="leg-dot" style="background:var(--missed-gray);"></i>Missed</span>
          <span><i class="leg-dot" style="background:var(--future-bg);border:1px solid var(--future-border);"></i>Scheduled</span>
          <span><i class="leg-dot" style="background:var(--blank-cell);border:1px solid var(--border);"></i>Off</span>
        </div>
        ${calendarHtml}
      </div>
    `;
    container.appendChild(item);
  });
}

/* TAB 3: COMPACT 2-LINE ANALYTICS CARD WITH STATUS ICONS */
function renderAnalyticsCardHtml(c, s, isCompletedView) {
  const editBtnHtml = isCompletedView
    ? `<span class="finished-tag">Completed</span>`
    : `<button class="btn-icon-action edit" title="Edit commitment" onclick="openEditCommitment('${c.id}')">&#9998;</button>`;

  let compTierClass = 'tier-low';
  if (s.compliancePct >= 70) compTierClass = 'tier-high';
  else if (s.compliancePct >= 50) compTierClass = 'tier-mid';

  const streakHtml = s.currentStreak > 0
    ? `<span class="ana-streak" title="Current streak">&#128293; ${s.currentStreak}d</span>`
    : '';

  return `
    <div class="ana-card ${isCompletedView ? 'completed-card' : ''}">
      <div class="ana-row-1">
        <div class="ana-title-wrap">
          <span class="ana-title">${escapeHtml(c.title)}</span>
          ${streakHtml}
        </div>
        <div class="ana-right-top">
          ${editBtnHtml}
          <button class="btn-icon-action del" title="Delete commitment" onclick="deleteCommitment('${c.id}')">&#128465;</button>
        </div>
      </div>

      <div class="ana-metrics-row">
        <span class="ana-count">${s.completedCount}/${s.totalScheduled}</span>
        <span class="ana-compliance ${compTierClass}">${s.completedCount}/${s.elapsedCount} (${s.compliancePct}%)</span>
        <span class="ana-icon-stat stat-part" title="Partial">&#9680; ${s.partialCount}</span>
        <span class="ana-icon-stat stat-miss" title="Missed">&#10005; ${s.missedCount}</span>
        <span class="ana-overall">${s.completionPct}%</span>
      </div>

      <div class="ana-bar">
        <div class="ana-bar-fill" style="width:${s.completionPct}%"></div>
      </div>
    </div>
  `;
}

function renderAnalytics(todayStr) {
  const container = document.getElementById('analytics-list');
  container.innerHTML = '';

  if (state.commitments.length === 0) {
    container.innerHTML = `<div class="card"><p class="muted">No analytics available yet.</p></div>`;
    return;
  }

  const activeItems = [];
  const completedItems = [];

  state.commitments.forEach(c => {
    const s = evaluateCommitment(c, todayStr);
    if (s.isCompleted) completedItems.push({ c, s });
    else activeItems.push({ c, s });
  });

  if (activeItems.length > 0) {
    container.innerHTML += `<div class="section-subhead">Active Commitments (${activeItems.length})</div>`;
    const activeStack = document.createElement('div');
    activeStack.className = 'list-stack';
    activeItems.forEach(({ c, s }) => {
      activeStack.innerHTML += renderAnalyticsCardHtml(c, s, false);
    });
    container.appendChild(activeStack);
  }

  if (completedItems.length > 0) {
    container.innerHTML += `<div class="section-subhead">Completed Commitments (${completedItems.length})</div>`;
    const doneStack = document.createElement('div');
    doneStack.className = 'list-stack';
    completedItems.forEach(({ c, s }) => {
      doneStack.innerHTML += renderAnalyticsCardHtml(c, s, true);
    });
    container.appendChild(doneStack);
  }
}

/* INTERACTIONS & 24H LOCK GUARD */
window.toggleBinaryCheckbox = function(id, dateStr, isChecked) {
  if (dateStr !== getLocalDateStr()) {
    renderAll();
    return alert('Day rolled over at midnight. View refreshed to today.');
  }
  const c = state.commitments.find(x => x.id === id);
  if (!c) return;
  if (isChecked) {
    c.logs[dateStr] = 1;
  } else {
    delete c.logs[dateStr];
  }
  saveState();
  renderTimeline(dateStr);
  renderAnalytics(dateStr);
};

window.previewSlider = function(id, target, pctVal) {
  const pct = Number(pctVal);
  const units = Number(((pct / 100) * target).toFixed(2));
  document.getElementById(`lbl-pct-${id}`).textContent = `${pct}%`;
  document.getElementById(`lbl-unit-${id}`).textContent = units;
};

window.autoSaveSlider = function(id, dateStr, target, pctVal) {
  if (dateStr !== getLocalDateStr()) {
    renderAll();
    return alert('Day rolled over at midnight. View refreshed to today.');
  }
  const pct = Number(pctVal);
  const c = state.commitments.find(x => x.id === id);
  if (!c) return;
  if (pct === 0) {
    delete c.logs[dateStr];
  } else {
    c.logs[dateStr] = Number(((pct / 100) * target).toFixed(2));
  }
  saveState();
  renderTimeline(dateStr);
  renderAnalytics(dateStr);
};

window.changeCalMonth = function(id, delta) {
  const c = state.commitments.find(x => x.id === id);
  if (!c) return;
  const slots = generateSlots(c);
  if (!slots.length) return;
  const minYm = slots[0].date.slice(0, 7);
  const maxYm = slots[slots.length - 1].date.slice(0, 7);

  const currentYm = calendarViewMonth.get(id) || minYm;
  const targetYm = shiftMonthStr(currentYm, delta);
  if (targetYm < minYm || targetYm > maxYm) return;

  calendarViewMonth.set(id, targetYm);
  renderTimeline(getLocalDateStr());
};

window.toggleAccordion = function(id) {
  if (expandedAccordions.has(id)) expandedAccordions.delete(id);
  else expandedAccordions.add(id);
  renderTimeline(getLocalDateStr());
};

/* Point 6: Open modal in Edit mode locking Title, Mode, and Unit */
window.openEditCommitment = function(id) {
  const c = state.commitments.find(x => x.id === id);
  if (!c) return;
  normalizeCommitment(c);

  const todayStr = getLocalDateStr();
  const activeRule = getRuleForDate(c, todayStr);

  editingCommitmentId = id;
  document.getElementById('modal-heading').textContent = 'Edit Commitment (From Today)';
  document.getElementById('btn-submit-commitment').textContent = 'Save Changes';
  document.getElementById('cfg-start-label').textContent = `Started ${formatShortDate(c.startDate)}`;

  const titleEl = document.getElementById('cfg-title');
  titleEl.value = c.title;
  titleEl.disabled = true;

  document.getElementById('cfg-days').value = c.totalDays;
  document.getElementById('cfg-item-reminder').value = c.reminderTime || '';

  const freqEl = document.getElementById('cfg-freq');
  freqEl.value = activeRule.freq;
  document.getElementById('box-specific-days').classList.toggle('hidden', activeRule.freq !== 'specific');
  document.getElementById('box-rolling-days').classList.toggle('hidden', activeRule.freq !== 'rolling');

  const allowedSet = new Set((activeRule.specificDays || []).map(Number));
  document.querySelectorAll('#box-specific-days input').forEach(cb => {
    cb.checked = allowedSet.has(Number(cb.value));
  });
  document.getElementById('cfg-rolling-target').value = activeRule.rollingTarget || 3;

  const modeEl = document.getElementById('cfg-mode');
  modeEl.value = c.mode;
  modeEl.disabled = true;

  const targetEl = document.getElementById('cfg-target');
  const unitEl = document.getElementById('cfg-unit');
  const threshEl = document.getElementById('cfg-threshold');

  document.getElementById('box-spectrum').classList.toggle('hidden', c.mode !== 'spectrum');
  targetEl.value = activeRule.target;
  unitEl.value = c.unit || 'units';
  unitEl.disabled = true;
  threshEl.value = activeRule.threshold;
  document.getElementById('thresh-val').textContent = activeRule.threshold;

  document.getElementById('modal-new').classList.remove('hidden');
};

function resetModalToCreateMode() {
  editingCommitmentId = null;
  const todayStr = getLocalDateStr();
  document.getElementById('modal-heading').textContent = 'New Commitment';
  document.getElementById('btn-submit-commitment').textContent = 'Create';
  document.getElementById('cfg-start-label').textContent = `Today (${formatShortDate(todayStr)})`;

  document.getElementById('form-commitment').reset();
  document.getElementById('cfg-title').disabled = false;
  document.getElementById('cfg-mode').disabled = false;
  document.getElementById('cfg-unit').disabled = false;
  document.getElementById('thresh-val').textContent = '80';
  document.getElementById('box-specific-days').classList.add('hidden');
  document.getElementById('box-rolling-days').classList.add('hidden');
  document.getElementById('box-spectrum').classList.add('hidden');
}

window.deleteCommitment = async function(id) {
  if (!confirm('Delete this commitment and all its logged history?')) return;
  state.commitments = state.commitments.filter(x => x.id !== id);
  expandedAccordions.delete(id);
  calendarViewMonth.delete(id);
  await cancelItemReminder(id);
  saveState();
  renderAll();
};

function escapeHtml(str) {
  return str.replace(/[&<>"']/g, m => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[m]));
}

function updateCountdown() {
  syncDateIfRolledOver();
  const now = new Date();
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0);
  const diffMs = midnight - now;
  const hrs = String(Math.floor(diffMs / 3600000)).padStart(2, '0');
  const mins = String(Math.floor((diffMs % 3600000) / 60000)).padStart(2, '0');
  document.getElementById('countdown-badge').textContent = `Lock in ${hrs}h ${mins}m`;
}

/* Point 2: Safe positive integer ID + explicit error feedback for per-commitment reminders */
function getItemNotificationId(commitmentId) {
  let sum = 0;
  for (let i = 0; i < commitmentId.length; i++) {
    sum = (sum * 31 + commitmentId.charCodeAt(i)) % 89999;
  }
  return 10000 + Math.abs(sum);
}

async function cancelItemReminder(commitmentId) {
  const cap = window.Capacitor;
  if (!cap || !cap.isNativePlatform || !cap.isNativePlatform() || !cap.Plugins?.LocalNotifications) return;
  await cap.Plugins.LocalNotifications.cancel({
    notifications: [{ id: getItemNotificationId(commitmentId) }]
  }).catch(() => {});
}

async function syncItemReminder(commitment) {
  const cap = window.Capacitor;
  if (!cap || !cap.isNativePlatform || !cap.isNativePlatform() || !cap.Plugins?.LocalNotifications) return;
  const { LocalNotifications } = cap.Plugins;
  const notifId = getItemNotificationId(commitment.id);

  await LocalNotifications.cancel({ notifications: [{ id: notifId }] }).catch(() => {});
  if (!commitment.reminderTime) return;

  const perm = await LocalNotifications.requestPermissions();
  if (perm.display !== 'granted') {
    alert('Notification permission is required for reminders.');
    return;
  }

  const [hour, minute] = commitment.reminderTime.split(':').map(Number);
  try {
    await LocalNotifications.schedule({
      notifications: [{
        id: notifId,
        title: `CCC Tracker: ${commitment.title}`,
        body: 'Daily reminder to log this commitment.',
        schedule: { on: { hour, minute }, repeats: true }
      }]
    });
  } catch (err) {
    alert('Reminder schedule failed: ' + (err?.message || err));
  }
}

/* Global Daily Check-In Reminder in Tab 4 */
async function configureDailyReminder(timeStr, enable) {
  const statusEl = document.getElementById('reminder-status');
  const disableBtn = document.getElementById('btn-disable-reminder');
  const cap = window.Capacitor;

  if (!cap || !cap.isNativePlatform || !cap.isNativePlatform() || !cap.Plugins?.LocalNotifications) {
    statusEl.textContent = 'Native reminders work inside the installed Android APK.';
    return;
  }

  const { LocalNotifications } = cap.Plugins;

  if (!enable) {
    await LocalNotifications.cancel({ notifications: [{ id: 1001 }] });
    localStorage.removeItem(REMINDER_KEY);
    statusEl.textContent = 'Reminder is currently off.';
    disableBtn.classList.add('hidden');
    return;
  }

  const perm = await LocalNotifications.requestPermissions();
  if (perm.display !== 'granted') {
    statusEl.textContent = 'Notification permission denied in Android settings.';
    return;
  }

  const [hour, minute] = timeStr.split(':').map(Number);
  await LocalNotifications.cancel({ notifications: [{ id: 1001 }] });
  await LocalNotifications.schedule({
    notifications: [{
      id: 1001,
      title: 'CCC Tracker: Daily Check-In',
      body: 'Log today’s open commitments before the midnight lock.',
      schedule: { on: { hour, minute }, repeats: true }
    }]
  });

  localStorage.setItem(REMINDER_KEY, timeStr);
  statusEl.textContent = `Active: Daily check-in reminder set for ${timeStr}.`;
  disableBtn.classList.remove('hidden');
}

function initReminderUI() {
  const savedTime = localStorage.getItem(REMINDER_KEY);
  const timeInp = document.getElementById('cfg-reminder-time');
  const statusEl = document.getElementById('reminder-status');
  const disableBtn = document.getElementById('btn-disable-reminder');

  if (savedTime && timeInp) {
    timeInp.value = savedTime;
    statusEl.textContent = `Active: Daily check-in reminder set for ${savedTime}.`;
    disableBtn.classList.remove('hidden');
  }

  document.getElementById('btn-save-reminder')?.addEventListener('click', () => {
    configureDailyReminder(timeInp.value || '21:30', true);
  });

  disableBtn?.addEventListener('click', () => {
    configureDailyReminder(timeInp.value || '21:30', false);
  });
}

function initNativeLifecycle() {
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) syncDateIfRolledOver();
  });

  const cap = window.Capacitor;
  if (cap && cap.isNativePlatform && cap.isNativePlatform() && cap.Plugins?.App) {
    const { App } = cap.Plugins;

    App.addListener('appStateChange', ({ isActive }) => {
      if (isActive) syncDateIfRolledOver();
    });

    App.addListener('backButton', () => {
      const modal = document.getElementById('modal-new');
      if (modal && !modal.classList.contains('hidden')) {
        modal.classList.add('hidden');
        resetModalToCreateMode();
        return;
      }
      const activeNav = document.querySelector('.nav-btn.active');
      if (activeNav && activeNav.dataset.target !== 'view-dashboard') {
        document.querySelector('.nav-btn[data-target="view-dashboard"]').click();
        return;
      }
      App.exitApp();
    });
  }
}

document.addEventListener('DOMContentLoaded', () => {
  applyTheme(localStorage.getItem(THEME_KEY) || 'dark');

  document.getElementById('btn-theme-toggle').onclick = () => {
    const current = document.documentElement.getAttribute('data-theme');
    applyTheme(current === 'dark' ? 'light' : 'dark');
  };

  const todayStr = getLocalDateStr();
  document.getElementById('cfg-start-label').textContent = `Today (${formatShortDate(todayStr)})`;

  const shareUrl = window.location.protocol.startsWith('http') ? window.location.href.split('#')[0] : APP_PUBLIC_URL;
  document.getElementById('app-url-display').textContent = shareUrl;

  document.getElementById('btn-share-app').onclick = async () => {
    if (navigator.share) {
      try {
        await navigator.share({
          title: 'CCC Tracker',
          text: 'Offline-first commitment, compliance, and consistency tracker:',
          url: shareUrl
        });
      } catch {}
    } else {
      navigator.clipboard?.writeText(shareUrl);
      alert('App link copied to clipboard: ' + shareUrl);
    }
  };

  document.getElementById('btn-copy-link').onclick = () => {
    navigator.clipboard?.writeText(shareUrl);
    alert('App link copied to clipboard!');
  };

  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById(btn.dataset.target).classList.add('active');
    });
  });

  const modal = document.getElementById('modal-new');
  document.getElementById('btn-open-modal').onclick = () => {
    resetModalToCreateMode();
    modal.classList.remove('hidden');
  };
  document.getElementById('btn-close-modal').onclick = () => {
    modal.classList.add('hidden');
    resetModalToCreateMode();
  };
  document.getElementById('btn-cancel-modal').onclick = () => {
    modal.classList.add('hidden');
    resetModalToCreateMode();
  };

  document.getElementById('cfg-freq').addEventListener('change', e => {
    document.getElementById('box-specific-days').classList.toggle('hidden', e.target.value !== 'specific');
    document.getElementById('box-rolling-days').classList.toggle('hidden', e.target.value !== 'rolling');
  });

  document.getElementById('cfg-mode').addEventListener('change', e => {
    document.getElementById('box-spectrum').classList.toggle('hidden', e.target.value !== 'spectrum');
  });

  document.getElementById('cfg-threshold').addEventListener('input', e => {
    document.getElementById('thresh-val').textContent = e.target.value;
  });

  document.getElementById('form-commitment').addEventListener('submit', async e => {
    e.preventDefault();
    const nowDateStr = getLocalDateStr();
    const freq = document.getElementById('cfg-freq').value;
    const specificDays = Array.from(document.querySelectorAll('#box-specific-days input:checked')).map(cb => Number(cb.value));
    const rollingTarget = parseInt(document.getElementById('cfg-rolling-target').value, 10) || 3;
    const target = parseFloat(document.getElementById('cfg-target').value) || 20;
    const threshold = parseInt(document.getElementById('cfg-threshold').value, 10) || 80;
    const reminderTime = document.getElementById('cfg-item-reminder').value || '';
    const requestedDays = parseInt(document.getElementById('cfg-days').value, 10);

    if (freq === 'specific' && specificDays.length === 0) {
      return alert('Select at least one day of the week.');
    }

    if (editingCommitmentId) {
      const existing = state.commitments.find(x => x.id === editingCommitmentId);
      if (existing) {
        normalizeCommitment(existing);
        const currentStats = evaluateCommitment(existing, nowDateStr);
        const minAllowedDays = Math.max(1, currentStats.completedCount + currentStats.partialCount + currentStats.missedCount);
        if (requestedDays < minAllowedDays) {
          return alert(`Total days cannot be less than ${minAllowedDays} already-elapsed days.`);
        }

        existing.totalDays = requestedDays;
        existing.reminderTime = reminderTime;

        const newRule = {
          effectiveFrom: nowDateStr,
          freq,
          specificDays,
          rollingTarget,
          target,
          threshold
        };
        existing.rules = existing.rules.filter(r => r.effectiveFrom < nowDateStr);
        existing.rules.push(newRule);

        await syncItemReminder(existing);
      }
    } else {
      const newCommitment = normalizeCommitment({
        id: 'c_' + Date.now(),
        title: document.getElementById('cfg-title').value.trim(),
        startDate: nowDateStr,
        totalDays: requestedDays,
        freq,
        specificDays,
        rollingTarget,
        mode: document.getElementById('cfg-mode').value,
        target,
        unit: document.getElementById('cfg-unit').value.trim() || 'units',
        threshold,
        reminderTime,
        logs: {},
        rules: [{
          effectiveFrom: nowDateStr,
          freq,
          specificDays,
          rollingTarget,
          target,
          threshold
        }]
      });

      state.commitments.push(newCommitment);
      await syncItemReminder(newCommitment);
    }

    saveState();
    modal.classList.add('hidden');
    resetModalToCreateMode();
    renderAll();
  });

  document.getElementById('btn-export-csv').onclick = () => {
    const rows = [['commitment_id', 'title', 'mode', 'date', 'logged_value', 'target_on_date', 'threshold_pct_on_date']];
    state.commitments.forEach(c => {
      generateSlots(c).forEach(s => {
        const val = c.logs[s.date] !== undefined ? c.logs[s.date] : '';
        rows.push([c.id, `"${c.title.replace(/"/g, '""')}"`, c.mode, s.date, val, s.rule.target, s.rule.threshold]);
      });
    });
    downloadFile(rows.map(r => r.join(',')).join('\n'), `ccc-tracker-${getLocalDateStr()}.csv`, 'text/csv');
  };
