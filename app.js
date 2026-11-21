const STORAGE_KEY = 'ccc_tracker_v2';
const THEME_KEY = 'ccc_tracker_theme';
const APP_PUBLIC_URL = 'https://v-abhi.github.io/ccc-tracker/';
const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

let expandedAccordions = new Set();
let calendarViewMonth = new Map();

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

/* TAB 1: DASHBOARD (SKETCH-ALIGNED MINIMALIST LAYOUT) */
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
      const currentPct = Math.min(100, Math.round((currentUnits / c.target) * 100));

      row.innerHTML = `
        <div class="spec-top">
          <div>
            <div class="dash-title">${escapeHtml(c.title)}</div>
            <div class="dash-sub">D${todaySlot.index} of ${c.totalDays} &bull; Spectrum</div>
          </div>
          <span class="spec-min">Min: ${c.threshold}%</span>
        </div>
        <div class="spec-progress-line">
          Progress: <strong id="lbl-pct-${c.id}">${currentPct}%</strong> &bull; <span id="lbl-unit-${c.id}">${currentUnits}</span>/${c.target} ${escapeHtml(c.unit)}
        </div>
        <input type="range" class="spec-slider" id="rng-${c.id}" min="0" max="100" step="5" value="${currentPct}"
          oninput="previewSlider('${c.id}', ${c.target}, this.value)"
          onchange="autoSaveSlider('${c.id}', '${todayStr}', ${c.target}, this.value)" />
      `;
    }

    container.appendChild(row);
  });
}

/* TAB 2: COMPACT SINGLE-MONTH BOUNDED CALENDAR */
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
  if (c.freq === 'specific') {
    c.specificDays.forEach(jsDay => activeCols.add((Number(jsDay) + 6) % 7));
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

    if (!slot) {
      cells.push(`<div class="cal-cell blank"></div>`);
    } else {
      const dd = String(day).padStart(2, '0');
      const mmm = MONTHS_SHORT[month - 1];
      cells.push(`
        <div class="cal-cell ${slot.status}" title="${dateStr} (${slot.status})">
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

/* TAB 3: COMPACT ANALYTICS BREAKDOWN */
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
    card.className = 'ana-card';

    card.innerHTML = `
      <div class="ana-row-1">
        <span class="ana-title">${escapeHtml(c.title)}</span>
        <div class="ana-right-top">
          <span class="ana-compliance">Compliance <strong>${s.compliancePct}%</strong></span>
          <button class="btn-del-icon" title="Delete commitment" onclick="deleteCommitment('${c.id}')">&#128465;</button>
        </div>
      </div>

      <div class="ana-row-2">
        <span class="ana-completed-txt">${s.completedCount}/${s.totalScheduled} completed</span>
        <span class="ana-overall-txt">${s.completionPct}% overall</span>
      </div>

      <div class="ana-bar">
        <div class="ana-bar-fill" style="width:${s.completionPct}%"></div>
      </div>

      <div class="ana-row-3">
        <span>${s.remainingCount} remaining &middot; ${s.missedCount} missed &middot; ${s.partialCount} partial</span>
        <span class="ana-streak">&#128293; ${s.currentStreak}d</span>
      </div>
    `;
    container.appendChild(card);
  });
}

/* INTERACTIONS & 24H LOCK GUARD */
window.toggleBinaryCheckbox = function(id, dateStr, isChecked) {
  if (dateStr !== getLocalDateStr()) return alert('24h Lock: Past or future days cannot be edited.');
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
  if (dateStr !== getLocalDateStr()) return alert('24h Lock: Past or future days cannot be edited.');
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

window.deleteCommitment = function(id) {
  if (!confirm('Delete this commitment and all its logged history?')) return;
  state.commitments = state.commitments.filter(x => x.id !== id);
  expandedAccordions.delete(id);
  calendarViewMonth.delete(id);
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
  applyTheme(localStorage.getItem(THEME_KEY) || 'dark');

  document.getElementById('btn-theme-toggle').onclick = () => {
    const current = document.documentElement.getAttribute('data-theme');
    applyTheme(current === 'dark' ? 'light' : 'dark');
  };

  document.getElementById('cfg-start').value = getLocalDateStr();

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
    document.getElementById('box-specific-days').classList.add('hidden');
    document.getElementById('box-rolling-days').classList.add('hidden');
    document.getElementById('box-spectrum').classList.add('hidden');
    modal.classList.add('hidden');
    renderAll();
  });

  document.getElementById('btn-export-csv').onclick = () => {
    const rows = [['commitment_id', 'title', 'mode', 'date', 'logged_value', 'target', 'threshold_pct']];
    state.commitments.forEach(c => {
      generateSlots(c).forEach(s => {
        const val = c.logs[s.date] !== undefined ? c.logs[s.date] : '';
        rows.push([c.id, `"${c.title.replace(/"/g, '""')}"`, c.mode, s.date, val, c.target || 1, c.threshold || 100]);
      });
    });
    downloadFile(rows.map(r => r.join(',')).join('\n'), `ccc-tracker-${getLocalDateStr()}.csv`, 'text/csv');
  };

  document.getElementById('btn-export-json').onclick = () => {
    downloadFile(JSON.stringify(state, null, 2), `ccc-backup-${getLocalDateStr()}.json`, 'application/json');
  };

  document.getElementById('input-import-json').onchange = e => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => {
      try {
        const parsed = JSON.parse(ev.target.result);
        if (!Array.isArray(parsed.commitments)) throw new Error('Invalid format');
        state = parsed;
        saveState();
        renderAll();
        alert('Backup restored.');
      } catch {
        alert('Invalid backup JSON file.');
      }
    };
    reader.readAsText(file);
  };

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }

  updateCountdown();
  setInterval(updateCountdown, 30000);
  renderAll();
});

function downloadFile(content, filename, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
