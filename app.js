const STORAGE_KEY = 'ccc_tracker_v1';

// Helper: Local YYYY-MM-DD (avoids UTC offset bugs)
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

// State Management
let state = loadState();

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : { commitments: [] };
  } catch {
    return { commitments: [] };
  }
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

// Generate Active Slots based on Frequency Config
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

// Evaluate Metrics (Compliance, Consistency, Completion)
function evaluateCommitment(c, todayStr) {
  const slots = generateSlots(c);
  let elapsedCount = 0;
  let compliantCount = 0;
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
    let isCompliant = false;

    if (!isFuture) {
      if (rawVal !== undefined && rawVal !== null) {
        if (c.mode === 'binary') {
          score = rawVal === 1 ? 1 : 0;
          isCompliant = score === 1;
        } else {
          score = Math.min(1, rawVal / c.target);
          isCompliant = (rawVal / c.target) >= (c.threshold / 100);
        }
      }

      if (isPast) {
        elapsedCount++;
        totalScoreSum += score;
        if (isCompliant) {
          compliantCount++;
          currentStreak++;
          longestStreak = Math.max(longestStreak, currentStreak);
          status = 'done';
        } else {
          currentStreak = 0;
          status = (rawVal > 0) ? 'partial' : 'missed';
        }
      } else if (isToday) {
        if (rawVal !== undefined && rawVal !== null) {
          elapsedCount++;
          totalScoreSum += score;
          if (isCompliant) {
            compliantCount++;
            currentStreak++;
            longestStreak = Math.max(longestStreak, currentStreak);
            status = 'done';
          } else {
            status = rawVal > 0 ? 'partial' : 'today';
          }
        } else {
          status = 'today';
        }
      }
    }

    return { ...slot, rawVal, status, isToday, isPast, isFuture };
  });

  // Rolling weekly adjustment if freq === 'rolling'
  let compliancePct = elapsedCount > 0 ? Math.round((compliantCount / elapsedCount) * 100) : 100;
  if (c.freq === 'rolling' && elapsedCount > 0) {
    const weeksElapsed = Math.ceil(elapsedCount / 7);
    const expectedToDate = Math.min(elapsedCount, weeksElapsed * c.rollingTarget);
    compliancePct = expectedToDate > 0 ? Math.min(100, Math.round((compliantCount / expectedToDate) * 100)) : 100;
  }

  const completionPct = Math.round((totalScoreSum / c.totalDays) * 100);

  return {
    slots: enrichedSlots,
    compliancePct,
    completionPct,
    currentStreak,
    longestStreak,
    compliantCount
  };
}

// Render Dashboard
function render() {
  const todayStr = getLocalDateStr();
  document.getElementById('today-label').textContent = formatShortDate(todayStr);

  const container = document.getElementById('commitments-list');
  container.innerHTML = '';

  if (state.commitments.length === 0) {
    container.innerHTML = `<div class="card"><p class="muted">No active commitments yet. Tap "+ New Commitment" below to configure your first tracked block.</p></div>`;
    return;
  }

  state.commitments.forEach(c => {
    const stats = evaluateCommitment(c, todayStr);
    const todaySlot = stats.slots.find(s => s.isToday);

    const card = document.createElement('div');
    card.className = 'card';

    const freqDesc = c.freq === 'daily'
      ? `Daily &bull; ${c.totalDays} days`
      : c.freq === 'specific'
      ? `Custom Days &bull; ${c.totalDays} active days`
      : `Rolling ${c.rollingTarget}d/wk &bull; ${c.totalDays} days`;

    let todayHtml = '';
    if (!todaySlot) {
      todayHtml = `<div class="today-box off-day">Rest Day / Outside Active Window (No logging required)</div>`;
    } else if (c.mode === 'binary') {
      const val = c.logs[todayStr];
      todayHtml = `
        <div class="today-box">
          <div style="font-size:0.82rem;font-weight:600;">Day ${todaySlot.index} Check-In (Binary)</div>
          <div class="log-controls">
            <button class="${val === 1 ? 'btn-primary' : 'btn-secondary'}" onclick="logEntry('${c.id}', '${todayStr}', 1)">Done</button>
            <button class="${val === 0 ? 'btn-primary' : 'btn-secondary'}" onclick="logEntry('${c.id}', '${todayStr}', 0)">Missed</button>
          </div>
        </div>`;
    } else {
      const currentVal = c.logs[todayStr] ?? '';
      todayHtml = `
        <div class="today-box">
          <div style="font-size:0.82rem;font-weight:600;">Day ${todaySlot.index} Check-In (Target: ${c.target} ${c.unit}, Min ${c.threshold}%)</div>
          <div class="log-controls">
            <input type="number" id="inp-${c.id}" value="${currentVal}" min="0" step="any" placeholder="0" />
            <span style="font-size:0.82rem;color:var(--muted);">${c.unit}</span>
            <button class="btn-primary" onclick="logSpectrum('${c.id}', '${todayStr}')">Save</button>
          </div>
        </div>`;
    }

    const gridHtml = stats.slots.map(s => {
      const icon = s.isPast ? '&#128274;' : '';
      return `<div class="slot ${s.status}" title="${s.date}">
        <span class="s-day">D${s.index} ${icon}</span>
        <span class="s-date">${formatShortDate(s.date)}</span>
      </div>`;
    }).join('');

    card.innerHTML = `
      <div class="card-top">
        <div>
          <div class="card-title">${escapeHtml(c.title)}</div>
          <div class="card-meta">${freqDesc} &bull; Starts ${formatShortDate(c.startDate)}</div>
        </div>
        <button class="btn-delete" onclick="deleteCommitment('${c.id}')">Delete</button>
      </div>

      <div class="metrics-row">
        <div><div class="metric-val">${stats.compliancePct}%</div><div class="metric-lbl">Compliance</div></div>
        <div><div class="metric-val">${stats.completionPct}%</div><div class="metric-lbl">Completion</div></div>
        <div><div class="metric-val">${stats.currentStreak}d</div><div class="metric-lbl">Streak (Best ${stats.longestStreak}d)</div></div>
      </div>

      ${todayHtml}

      <div class="grid-header">
        <span>Timeline (Past days locked)</span>
        <span>${stats.compliantCount}/${c.totalDays} Compliant</span>
      </div>
      <div class="slot-grid">${gridHtml}</div>
    `;

    container.appendChild(card);
  });
}

// Actions (Enforcing strict Today-only writes)
window.logEntry = function(id, dateStr, value) {
  if (dateStr !== getLocalDateStr()) return alert('24h Lock: Past or future days cannot be modified.');
  const c = state.commitments.find(x => x.id === id);
  if (!c) return;
  c.logs[dateStr] = value;
  saveState();
  render();
};

window.logSpectrum = function(id, dateStr) {
  if (dateStr !== getLocalDateStr()) return alert('24h Lock: Past or future days cannot be modified.');
  const inp = document.getElementById(`inp-${id}`);
  const val = parseFloat(inp.value);
  if (isNaN(val) || val < 0) return alert('Enter a valid non-negative number.');
  window.logEntry(id, dateStr, val);
};

window.deleteCommitment = function(id) {
  if (!confirm('Delete this commitment and its local logs?')) return;
  state.commitments = state.commitments.filter(x => x.id !== id);
  saveState();
  render();
};

function escapeHtml(str) {
  return str.replace(/[&<>"']/g, m => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[m]));
}

// Countdown Timer to Midnight Lock
function updateCountdown() {
  const now = new Date();
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0);
  const diffMs = midnight - now;
  const hrs = String(Math.floor(diffMs / 3600000)).padStart(2, '0');
  const mins = String(Math.floor((diffMs % 3600000) / 60000)).padStart(2, '0');
  document.getElementById('countdown-badge').textContent = `Lock in ${hrs}h ${mins}m`;
}

// Modal & Navigation Wiring
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('cfg-start').value = getLocalDateStr();

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
    modal.classList.add('hidden');
    render();
  });

  // CSV Export
  document.getElementById('btn-export-csv').onclick = () => {
    const rows = [['commitment_id', 'title', 'mode', 'date', 'logged_value', 'target', 'threshold_pct']];
    state.commitments.forEach(c => {
      const slots = generateSlots(c);
      slots.forEach(s => {
        const val = c.logs[s.date] !== undefined ? c.logs[s.date] : '';
        rows.push([c.id, `"${c.title.replace(/"/g, '""')}"`, c.mode, s.date, val, c.target || 1, c.threshold || 100]);
      });
    });
    downloadFile(rows.map(r => r.join(',')).join('\n'), `ccc-tracker-${getLocalDateStr()}.csv`, 'text/csv');
  };

  // JSON Export
  document.getElementById('btn-export-json').onclick = () => {
    downloadFile(JSON.stringify(state, null, 2), `ccc-backup-${getLocalDateStr()}.json`, 'application/json');
  };

  // JSON Import
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
        render();
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
  render();
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

