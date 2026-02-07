// DOM references
const authBadge       = document.getElementById('auth-badge');
const btnInit         = document.getElementById('btn-init');
const btnRun          = document.getElementById('btn-run');
const actionStatus    = document.getElementById('action-status');
const scheduleToggle  = document.getElementById('schedule-toggle');
const scheduleTime    = document.getElementById('schedule-time');
const btnSaveSchedule = document.getElementById('btn-save-schedule');
const nextRunEl       = document.getElementById('next-run');
const lastRunEl       = document.getElementById('last-run');
const consoleBox      = document.getElementById('console-output');

let isRunning = false;

// ── Console output streaming ────────────────────────────────────────

window.api.onConsoleOutput(function (line) {
  if (consoleBox.textContent === 'Waiting for activity...') {
    consoleBox.textContent = '';
  }
  consoleBox.textContent += line;
  consoleBox.scrollTop = consoleBox.scrollHeight;
});

window.api.onProcessDone(function (type, code) {
  isRunning = false;
  updateButtons();
  refreshStatus();
  actionStatus.textContent = '"' + type + '" finished (exit code: ' + code + ')';
});

// ── Status polling ──────────────────────────────────────────────────

async function refreshStatus() {
  try {
    var data = await window.api.getStatus();

    // Auth badge
    authBadge.textContent = data.authStatus;
    authBadge.className = 'status-badge status-' + data.authStatus;

    // Running state
    isRunning = data.isRunning;
    updateButtons();

    // Last run
    var lr = data.lastRun;
    if (lr) {
      var html = '<strong>' + (lr.success ? 'SUCCESS' : 'FAILED') + '</strong>';
      html += ' &mdash; ' + (lr.timestamp || '');
      if (lr.pageTitle) html += '<br>Title: ' + lr.pageTitle;
      if (lr.currentUrl) html += '<br>URL: ' + lr.currentUrl;
      if (lr.durationMs) html += '<br>Duration: ' + lr.durationMs + 'ms';
      if (lr.error) html += '<br>Error: ' + lr.error;
      lastRunEl.innerHTML = html;
    } else {
      lastRunEl.textContent = 'No runs yet';
    }

    // Schedule
    var sched = data.schedule;
    scheduleToggle.checked = sched.enabled;
    if (sched.time) {
      scheduleTime.value = sched.time;
    }
    if (sched.nextRun) {
      var next = new Date(sched.nextRun);
      nextRunEl.textContent = 'Next run: ' + next.toLocaleString();
    } else if (sched.enabled) {
      nextRunEl.textContent = 'Next run: calculating...';
    } else {
      nextRunEl.textContent = 'Scheduling disabled';
    }
  } catch (err) {
    console.error('Failed to refresh status:', err);
  }
}

function updateButtons() {
  btnInit.disabled = isRunning;
  btnRun.disabled = isRunning;
  if (isRunning) {
    actionStatus.textContent = 'Process running...';
  }
}

// ── Action handlers ─────────────────────────────────────────────────

btnInit.addEventListener('click', async function () {
  consoleBox.textContent = 'Launching auth init — complete login in the browser window...\n';
  actionStatus.textContent = 'Starting auth init...';
  var result = await window.api.initAuth();
  if (!result.success) {
    actionStatus.textContent = 'Error: ' + result.error;
  }
});

btnRun.addEventListener('click', async function () {
  consoleBox.textContent = 'Starting automation run...\n';
  actionStatus.textContent = 'Starting automation...';
  var result = await window.api.runAutomation();
  if (!result.success) {
    actionStatus.textContent = 'Error: ' + result.error;
  }
});

// ── Scheduler handlers ──────────────────────────────────────────────

scheduleToggle.addEventListener('change', async function () {
  if (scheduleToggle.checked) {
    var time = scheduleTime.value || '08:00';
    actionStatus.textContent = 'Enabling schedule...';
    var result = await window.api.scheduleEnable(time);
    actionStatus.textContent = result.success
      ? 'Schedule enabled for ' + time
      : 'Error: ' + result.error;
  } else {
    actionStatus.textContent = 'Disabling schedule...';
    var result = await window.api.scheduleDisable();
    actionStatus.textContent = result.success
      ? 'Schedule disabled'
      : 'Error: ' + result.error;
  }
  refreshStatus();
});

btnSaveSchedule.addEventListener('click', async function () {
  var time = scheduleTime.value;
  if (!time) return;
  actionStatus.textContent = 'Updating schedule time...';
  var result = await window.api.scheduleUpdateTime(time);
  actionStatus.textContent = result.success
    ? 'Schedule updated to ' + time
    : 'Error: ' + result.error;
  refreshStatus();
});

// ── Initialize ──────────────────────────────────────────────────────

refreshStatus();
setInterval(refreshStatus, 5000);
