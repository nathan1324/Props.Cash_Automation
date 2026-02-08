// DOM references
const authBadge       = document.getElementById('auth-badge');
const btnInit         = document.getElementById('btn-init');
const btnRun          = document.getElementById('btn-run');
const btnScrape       = document.getElementById('btn-scrape');
const actionStatus    = document.getElementById('action-status');
const scheduleToggle  = document.getElementById('schedule-toggle');
const scheduleTime    = document.getElementById('schedule-time');
const btnSaveSchedule = document.getElementById('btn-save-schedule');
const nextRunEl       = document.getElementById('next-run');
const lastRunEl       = document.getElementById('last-run');
const lastScrapeEl    = document.getElementById('last-scrape');
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

    // Last scrape
    var ls = data.lastScrape;
    if (ls) {
      var lsHtml = '<strong>' + (ls.success ? 'SUCCESS' : 'FAILED') + '</strong>';
      lsHtml += ' &mdash; ' + (ls.timestamp || '');
      if (ls.session) {
        var s = ls.session;
        if (s.summary) {
          lsHtml += '<br>Props: ' + (s.summary.propsSucceeded || 0) + '/' + (s.summary.propsAttempted || 0);
          lsHtml += '<br>Rows: ' + (s.summary.rowsTotal || 0);
        }
        if (s.errors && s.errors.length > 0) {
          lsHtml += '<br>Errors: ' + s.errors.length;
        }
        if (s.artifactDir) {
          lsHtml += '<br>Artifacts: ' + s.artifactDir;
        }
      }
      if (ls.db) {
        var dbLabel = ls.db.status === 'success' ? 'DB: persisted'
          : ls.db.status === 'skipped' ? 'DB: skipped'
          : 'DB: error';
        lsHtml += '<br>' + dbLabel;
        if (ls.db.rowsPersisted) {
          lsHtml += ' (' + ls.db.rowsInserted + ' new, ' + ls.db.rowsUpdated + ' updated)';
        }
        if (ls.db.error) lsHtml += ' — ' + ls.db.error;
      }
      if (ls.durationMs) lsHtml += '<br>Duration: ' + ls.durationMs + 'ms';
      if (ls.error) lsHtml += '<br>Error: ' + ls.error;
      lastScrapeEl.innerHTML = lsHtml;
    } else {
      lastScrapeEl.textContent = 'No scrapes yet';
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
  btnScrape.disabled = isRunning;
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

btnScrape.addEventListener('click', async function () {
  consoleBox.textContent = 'Starting props scrape...\n';
  actionStatus.textContent = 'Starting scrape...';
  var result = await window.api.runScrape();
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

// ── Data Browser ────────────────────────────────────────────────────

var dbStatusMsg   = document.getElementById('db-status-msg');
var dataBrowser   = document.getElementById('data-browser');
var dbDateSelect  = document.getElementById('db-date');
var dbPropSelect  = document.getElementById('db-prop');
var dbPlayerInput = document.getElementById('db-player-search');
var dbSortSelect  = document.getElementById('db-sort');
var btnDbLoad     = document.getElementById('btn-db-load');
var dbSummary     = document.getElementById('db-summary');
var dbTableBody   = document.getElementById('db-table-body');

async function initDataBrowser() {
  var status = await window.api.dbStatus();
  if (!status.configured) {
    dbStatusMsg.textContent = 'Database not configured (set DATABASE_URL in .env)';
    return;
  }
  if (!status.connected) {
    dbStatusMsg.textContent = 'Database configured but connection failed';
    return;
  }

  dbStatusMsg.style.display = 'none';
  dataBrowser.style.display = 'block';

  // Load available dates
  var datesResult = await window.api.queryDates();
  if (datesResult.success && datesResult.dates.length > 0) {
    dbDateSelect.innerHTML = '';
    datesResult.dates.forEach(function (d) {
      var opt = document.createElement('option');
      opt.value = d.dateIso;
      opt.textContent = d.dateIso + ' (' + d.rowsCount + ' rows, ' + d.propsCount + ' props)';
      dbDateSelect.appendChild(opt);
    });
    // Auto-load the most recent date
    loadPropsForDate(datesResult.dates[0].dateIso);
    loadData();
  } else {
    dbSummary.textContent = 'No data yet. Run a scrape first.';
  }
}

async function loadPropsForDate(dateIso) {
  var result = await window.api.queryPropsForDate(dateIso);
  dbPropSelect.innerHTML = '<option value="">All props</option>';
  if (result.success) {
    result.props.forEach(function (p) {
      var opt = document.createElement('option');
      opt.value = p.key;
      opt.textContent = p.label + ' (' + p.count + ')';
      dbPropSelect.appendChild(opt);
    });
  }
}

async function loadData() {
  var dateIso = dbDateSelect.value;
  if (!dateIso) return;

  dbSummary.textContent = 'Loading...';
  dbTableBody.innerHTML = '';

  var opts = { dateIso: dateIso };
  var propKey = dbPropSelect.value;
  if (propKey) opts.propKey = propKey;
  var search = dbPlayerInput.value.trim();
  if (search) opts.playerSearch = search;
  opts.orderBy = dbSortSelect.value;
  opts.limit = 500;

  var result = await window.api.queryPropRows(opts);

  if (!result.success) {
    dbSummary.textContent = 'Error: ' + result.error;
    return;
  }

  dbSummary.textContent = result.count + ' rows' + (result.count >= 500 ? ' (limited to 500)' : '');

  result.rows.forEach(function (row) {
    var tr = document.createElement('tr');

    var diffClass = '';
    if (row.diff != null) {
      diffClass = row.diff > 0 ? 'cell-positive' : row.diff < 0 ? 'cell-negative' : '';
    }

    tr.innerHTML =
      '<td>' + esc(row.playerName) + '</td>' +
      '<td>' + esc(row.team || '') + '</td>' +
      '<td>' + esc(row.propLabel || row.propKey) + '</td>' +
      '<td>' + (row.line != null ? row.line : '') + '</td>' +
      '<td>' + (row.oddsOver != null ? row.oddsOver : '') + '</td>' +
      '<td>' + (row.oddsUnder != null ? row.oddsUnder : '') + '</td>' +
      '<td>' + (row.projection != null ? row.projection : '') + '</td>' +
      '<td class="' + diffClass + '">' + (row.diff != null ? row.diff : '') + '</td>' +
      '<td>' + esc(row.dvp || '') + '</td>' +
      '<td class="cell-status">' + esc(row.status || '') + '</td>';

    dbTableBody.appendChild(tr);
  });
}

function esc(str) {
  var div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// Date change → reload props list + data
dbDateSelect.addEventListener('change', function () {
  loadPropsForDate(dbDateSelect.value);
  loadData();
});

// Prop / sort change → reload data
dbPropSelect.addEventListener('change', loadData);
dbSortSelect.addEventListener('change', loadData);

// Load button
btnDbLoad.addEventListener('click', loadData);

// Player search on Enter
dbPlayerInput.addEventListener('keydown', function (e) {
  if (e.key === 'Enter') loadData();
});

// ── Initialize ──────────────────────────────────────────────────────

refreshStatus();
setInterval(refreshStatus, 5000);
initDataBrowser();
