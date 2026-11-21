const STORAGE_KEY = 'ccc_tracker_v2';
const THEME_KEY = 'ccc_tracker_theme';
const APP_PUBLIC_URL = 'https://v-abhi.github.io/ccc-tracker/';
let expandedAccordions = new Set();

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
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

let state = loadState();

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY) || localStorage.getItem('ccc_tracker_v1');
    return raw ? JSON.parse(raw) : { commitments: [] };
  } catch {
    return { commitments: [] };
  }
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function generateSlots(c) {
  const slots = [];
  let cursor = parseLocalDate(c.startDate);

  if (c.freq === 'daily' || c.freq === 'rolling') {
    for (let i = 0; i < c.totalDays; i++) {
      slots.push({ index: i + 1, date: getLocalDateStr(cursor) });
      cursor.setDate(cursor.getDate() + 1);
    }
  } else if (c.freq === 'specific') {
    const allowed = new Set(c.specificDays.map(Number));
    let safety = 0;
    while (slots.length < c.totalDays && safety < 2000) {
      if (allowed.has(cursor.getDay())) {
        slots.push({ index: slots.length + 1, date: getLocalDateStr(cursor) });
      }
      cursor.setDate(cursor.getDate() + 1);
      safety++;
    }
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
          pct = Math.min(100, Math.round((rawVal / c.target) * 100));
          score = pct / 100;
          isCompliant = pct >= c.threshold;
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

  let compliancePct = elapsedCount > 0 ? Math.round((completedCount / elapsedCount) * 100) : 100;
  if (c.freq === 'rolling' && elapsedCount > 0) {
    const weeksElapsed = Math.ceil(elapsedCount / 7);
    const expectedToDate = Math.min(elapsedCount, weeksElapsed * c.rollingTarget);
    compliancePct = expectedToDate > 0 ? Math.min(100, Math.round((completedCount / expectedToDate) * 100)) : 100;
  }

  const completionPct = Math.round((totalScoreSum / c.totalDays) * 100);

  return {
    slots: enrichedSlots,
    totalScheduled: c.totalDays,
    completedCount,
    partialCount,
    missedCount,
    remainingCount,
    compliancePct,
    completionPct,
    currentStreak,
    longestStreak
  };
}

function renderAll() {
  const todayStr = getLocalDateStr();
  document.getElementById('today-label').textContent = formatShortDate(todayStr);

  renderDashboard(todayStr);
  renderTimeline(todayStr);
  renderAnalytics(todayStr);
}

/* TAB 1: DASHBOARD */
function renderDashboard(todayStr) {
  const container = document.getElementById('dashboard-list');
  container.innerHTML = '';

  if (state.commitments.length === 0) {
    container.innerHTML = `<div class="card"><p class="muted">No commitments configured yet. Tap "+ New" above to create your first tracked block.</p></div>`;
    return;
  }

  const items = state.commitments.map(c => {
    const stats = evaluateCommitment(c, todayStr);
    const todaySlot = stats.slots.find(s => s.isToday);
    return { c, stats, todaySlot, isActiveToday: Boolean(todaySlot) };
  }).sort((a, b) => Number(b.isActiveToday) - Number(a.isActiveToday));

  items.forEach(({ c, todaySlot, isActiveToday }) => {
    const row = document.createElement('div');
    row.className = `dash-item ${isActiveToday ? '' : 'inactive-today'}`;

    if (!isActiveToday) {
      row.innerHTML = `
        <div class="dash-top">
          <div>
            <div class="dash-title">${escapeHtml(c.title)}</div>
            <div class="dash-sub">Not scheduled for today (Off-day / Outside window)</div>
          </div>
          <span class="status-pill">Inactive Today</span>
        </div>`;
      container.appendChild(row);
      return;
    }

    const loggedVal = c.logs[todayStr];
    let pillHtml = `<span class="status-pill active">Day ${todaySlot.index}/${c.totalDays} &bull; Pending</span>`;
    if (loggedVal !== undefined && loggedVal !== null) {
      if (todaySlot.status === 'done') pillHtml = `<span class="status-pill done">Completed</span>`;
      else if (todaySlot.status === 'partial') pillHtml = `<span class="status-pill partial">${todaySlot.pct}% Logged</span>`;
      else pillHtml = `<span class="status-pill">Missed (0%)</span>`;
    }

    let actionHtml = '';
    if (c.mode === 'binary') {
      actionHtml = `
        <div class="dash-action binary-group">
          <button class="${loggedVal === 1 ? 'btn-primary' : 'btn-secondary'}" onclick="logBinary('${c.id}', '${todayStr}', 1)">Done</button>
          <button class="${loggedVal === 0 ? 'btn-primary' : 'btn-secondary'}" onclick="logBinary('${c.id}', '${todayStr}', 0)">Missed</button>
        </div>`;
    } else {
      const currentPct = (loggedVal !== undefined && loggedVal !== null)
        ? Math.min(100, Math.round((loggedVal / c.target) * 100))
        : 0;
      const currentUnits = (loggedVal !== undefined && loggedVal !== null) ? loggedVal : 0;

      actionHtml = `
        <div class="dash-action slider-wrap">
          <div class="slider-header">
            <span>Progress: <strong id="lbl-pct-${c.id}">${currentPct}%</strong> (<span id="lbl-unit-${c.id}">${currentUnits}</span> / ${c.target} ${escapeHtml(c.unit)})</span>
            <span>Min: ${c.threshold}%</span>
          </div>
          <div class="slider-row">
            <input type="range" id="rng-${c.id}" min="0" max="100" step="5" value="${currentPct}"
              oninput="previewSlider('${c.id}', ${c.target}, this.value)" />
            <button class="btn-primary btn-sm" onclick="commitSlider('${c.id}', '${todayStr}', ${c.target})">Save</button>
          </div>
        </div>`;
    }

    row.innerHTML = `
      <div class="dash-top">
        <div>
          <div class="dash-title">${escapeHtml(c.title)}</div>
          <div class="dash-sub">Day ${todaySlot.index} of ${c.totalDays} &bull; ${c.mode === 'binary' ? 'Binary' : `Target: ${c.target} ${escapeHtml(c.unit)}`}</div>
        </div>
        ${pillHtml}
      </div>
      ${actionHtml}
    `;
    container.appendChild(row);
  });
}

/* TAB 2: EXPANDABLE TIMELINE */
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

    const cellsHtml = stats.slots.map(s => {
      let valLabel = 'Upcoming';
      if (s.isPast || (s.isToday && s.rawVal !== undefined)) {
        if (c.mode === 'binary') {
          valLabel = s.rawVal === 1 ? 'Done' : 'Missed';
        } else {
          valLabel = s.rawVal !== undefined ? `${s.rawVal} ${c.unit} (${s.pct}%)` : '0 (Missed)';
        }
      } else if (s.isToday) {
        valLabel = 'Open Today';
      }

      const lockIcon = s.isPast ? ' &#128274;' : '';
      return `
        <div class="date-cell ${s.status}">
          <span class="dc-top">D${s.index} &bull; ${formatShortDate(s.date)}${lockIcon}</span>
          <span class="dc-val">${valLabel}</span>
        </div>`;
    }).join('');

    item.innerHTML = `
      <button class="acc-header" onclick="toggleAccordion('${c.id}')">
        <div>
          <div class="dash-title">${escapeHtml(c.title)}</div>
          <div class="dash-sub">${stats.completedCount}/${stats.totalScheduled} Completed &bull; Starts ${formatShortDate(c.startDate)}</div>
        </div>
        <span class="chevron">&#9660;</span>
      </button>
      <div class="acc-body">
        <div class="date-log-list">${cellsHtml}</div>
      </div>
    `;
    container.appendChild(item);
  });
}

/* TAB 3: ANALYTICS BREAKDOWN */
function renderAnalytics(todayStr) {
  const container = document.getElementById('analytics-list');
  container.innerHTML = '';

  if (state.commitments.length === 0) {
    container.innerHTML = `<div class="card"><p class="muted">No analytics available yet.</p></div>`;
    return;
  }

  state.commitments.forEach(c => {
    const s = evaluateCommitment(c, todayStr);
    const card = document.createElement('div');
    card.className = 'card';

    card.innerHTML = `
      <div class="dash-top">
        <div>
          <div class="dash-title">${escapeHtml(c.title)}</div>
          <div class="dash-sub">Compliance: ${s.compliancePct}% &bull; Overall Completion: ${s.completionPct}%</div>
        </div>
        <button class="btn-delete" onclick="deleteCommitment('${c.id}')">Delete</button>
      </div>

      <div class="progress-bar">
        <div class="progress-fill" style="width:${s.completionPct}%"></div>
      </div>

      <div class="stat-grid">
        <div class="stat-box"><div class="stat-num">${s.totalScheduled}</div><div class="stat-lbl">Scheduled</div></div>
        <div class="stat-box"><div class="stat-num" style="color:var(--green);">${s.completedCount}</div><div class="stat-lbl">Completed</div></div>
        <div class="stat-box"><div class="stat-num">${s.remainingCount}</div><div class="stat-lbl">Yet to Complete</div></div>
        <div class="stat-box"><div class="stat-num" style="color:var(--red);">${s.missedCount}</div><div class="stat-lbl">Missed</div></div>
        <div class="stat-box"><div class="stat-num" style="color:var(--amber);">${s.partialCount}</div><div class="stat-lbl">Partial</div></div>
        <div class="stat-box"><div class="stat-num">${s.currentStreak}d / ${s.longestStreak}d</div><div class="stat-lbl">Streak / Best</div></div>
      </div>
    `;
    container.appendChild(card);
  });
}

/* INTERACTIONS & 24H LOCK GUARD */
window.logBinary = function(id, dateStr, value) {
  if (dateStr !== getLocalDateStr()) return alert('24h Lock: Past or future days cannot be edited.');
  const c = state.commitments.find(x => x.id === id);
  if (!c) return;
  c.logs[dateStr] = value;
  saveState();
  renderAll();
};

window.previewSlider = function(id, target, pctVal) {
  const pct = Number(pctVal);
  const units = Number(((pct / 100) * target).toFixed(2));
  document.getElementById(`lbl-pct-${id}`).textContent = `${pct}%`;
  document.getElementById(`lbl-unit-${id}`).textContent = units;
};

window.commitSlider = function(id, dateStr, target) {
  if (dateStr !== getLocalDateStr()) return alert('24h Lock: Past or future days cannot be edited.');
  const pct = Number(document.getElementById(`rng-${id}`).value);
  const units = Number(((pct / 100) * target).toFixed(2));
  const c = state.commitments.find(x => x.id === id);
  if (!c) return;
  c.logs[dateStr] = units;
  saveState();
  renderAll();
};

window.toggleAccordion = function(id) {
  if (expandedAccordions.has(id)) expandedAccordions.delete(id);
  else expandedAccordions.add(id);
  renderTimeline(getLocalDateStr());
};

window.deleteCommitment = function(id) {
  if (!confirm('Delete this commitment and all its logged history?')) return;
  state.commitments = state.commitments.filter(x => x.id !== id);
  expandedAccordions.delete(id);
  saveState();
  renderAll();
};

function escapeHtml(str) {
  return str.replace(/[&<>"']/g, m => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[m]));
}

function updateCountdown() {
  const now = new Date();
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0);
  const diffMs = midnight - now;
  const hrs = String(Math.floor(diffMs / 3600000)).padStart(2, '0');
  const mins = String(Math.floor((diffMs % 3600000) / 60000)).padStart(2, '0');
  document.getElementById('countdown-badge').textContent = `Lock in ${hrs}h ${mins}m`;
}

document.addEventListener('DOMContentLoaded', () => {
  // Initialize saved theme (defaults to dark / nightlight)
  applyTheme(localStorage.getItem(THEME_KEY) || 'dark');

  document.getElementById('btn-theme-toggle').onclick = () => {
    const current = document.documentElement.getAttribute('data-theme');
    applyTheme(current === 'dark' ? 'light' : 'dark');
  };

  document.getElementById('cfg-start').value = getLocalDateStr();

  // Share & Copy App URL
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

  // Bottom Navigation
  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById(btn.dataset.target).classList.add('active');
    });
  });

  // Modal Wiring
  const modal = document.getElementById('modal-new');
  document.getElementById('btn-open-modal').onclick = () => modal.classList.remove('hidden');
  document.getElementById('btn-close-modal').onclick = () => modal.classList.add('hidden');
  document.getElementById('btn-cancel-modal').onclick = () => modal.classList.add('hidden');

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

  document.getElementById('form-commitment').addEventListener('submit', e => {
    e.preventDefault();
    const freq = document.getElementById('cfg-freq').value;
    const specificDays = Array.from(document.querySelectorAll('#box-specific-days input:checked')).map(cb => Number(cb.value));

    if (freq === 'specific' && specificDays.length === 0) {
      return alert('Select at least one day of the week.');
    }

    const newCommitment = {
      id: 'c_' + Date.now(),
      title: document.getElementById('cfg-title').value.trim(),
      startDate: document.getElementById('cfg-start').value,
      totalDays: parseInt(document.getElementById('cfg-days').value, 10),
      freq,
      specificDays,
      rollingTarget: parseInt(document.getElementById('cfg-rolling-target').value, 10),
      mode: document.getElementById('cfg-mode').value,
      target: parseFloat(document.getElementById('cfg-target').value),
      unit: document.getElementById('cfg-unit').value.trim() || 'units',
      threshold: parseInt(document.getElementById('cfg-threshold').value, 10),
      logs: {}
    };

    state.commitments.push(newCommitment);
    saveState();
    e.target.reset();
    document.getElementById('cfg-start').value = getLocalDateStr();
    document.getElementById('box-
