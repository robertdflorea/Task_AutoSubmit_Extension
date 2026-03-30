document.addEventListener('DOMContentLoaded', async () => {
  // Elements
  const btnActionSubmit = document.getElementById('btn-action-submit');
  const btnActionPause  = document.getElementById('btn-action-pause');
  const btnSet          = document.getElementById('btn-set');
  const btnCancel       = document.getElementById('btn-cancel');
  const tabUrlEl        = document.getElementById('tab-url');
  const statusSection   = document.getElementById('status-section');
  const statusText      = document.getElementById('status-text');
  const statusCountdown = document.getElementById('status-countdown');

  let selectedAction = 'Pause';
  let currentTabUrl  = '';
  let countdownTimer = null;

  // ── Load current tab URL ─────────────────────────────────────────────────
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.url) {
    currentTabUrl = tab.url;
    tabUrlEl.textContent = tab.url;
  } else {
    tabUrlEl.textContent = 'No active tab';
  }

  // ── Action selection ─────────────────────────────────────────────────────
  btnActionSubmit.addEventListener('click', () => setAction('Submit'));
  btnActionPause.addEventListener('click',  () => setAction('Pause'));

  function setAction(action) {
    selectedAction = action;
    btnActionSubmit.classList.toggle('active', action === 'Submit');
    btnActionPause.classList.toggle('active',  action === 'Pause');
  }

  // ── Set Timer ────────────────────────────────────────────────────────────
  btnSet.addEventListener('click', async () => {
    const delayMs = calculateDelayMs();
    if (delayMs === null) return;

    if (!currentTabUrl || currentTabUrl.startsWith('chrome://')) {
      showStatus('error', 'Error: Please open the task page first, then set the timer.');
      return;
    }

    const triggerAt = Date.now() + delayMs;

    await chrome.storage.local.set({
      scheduledAction: selectedAction,
      targetUrl:       currentTabUrl,
      triggerAt,
      status:          'scheduled'
    });

    chrome.runtime.sendMessage({
      type:     'SET_ALARM',
      delayMs,
      action:   selectedAction,
      url:      currentTabUrl,
      triggerAt
    });

    showStatus('success', `Scheduled: ${selectedAction}`, triggerAt);
  });

  // ── Cancel Timer ─────────────────────────────────────────────────────────
  btnCancel.addEventListener('click', async () => {
    chrome.runtime.sendMessage({ type: 'CANCEL_ALARM' });
    await chrome.storage.local.remove(['scheduledAction', 'targetUrl', 'triggerAt', 'status']);
    hideStatus();
  });

  // ── Restore state on popup open ──────────────────────────────────────────
  const stored = await chrome.storage.local.get([
    'scheduledAction', 'targetUrl', 'triggerAt', 'status'
  ]);

  if (stored.status === 'scheduled' && stored.triggerAt > Date.now()) {
    setAction(stored.scheduledAction || 'Pause');
    showStatus('success', `Scheduled: ${stored.scheduledAction}`, stored.triggerAt);
  } else if (stored.status === 'clicked') {
    showStatus('done', `Done: "${stored.scheduledAction}" was clicked successfully.`);
  } else if (stored.status === 'tab_closed') {
    showStatus('error', 'Task tab was closed before the timer fired. Please check your task manually.');
  } else if (stored.status === 'failed') {
    showStatus('error', `Failed: "${stored.scheduledAction}" button was not found on the page.`);
  }

  // ── Listen for background updates while popup is open ───────────────────
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    const newStatus = changes.status?.newValue;
    if (newStatus === 'clicked') {
      showStatus('done', `Done: "${stored.scheduledAction}" was clicked successfully.`);
    } else if (newStatus === 'tab_closed') {
      showStatus('error', 'Task tab was closed before the timer fired. Please check your task manually.');
    } else if (newStatus === 'failed') {
      showStatus('error', `Failed: "${stored.scheduledAction}" button was not found on the page.`);
    }
  });

  // ── Helpers ──────────────────────────────────────────────────────────────

  function calculateDelayMs() {
    const delaySec = getVal('count-h') * 3600 + getVal('count-m') * 60 + getVal('count-s');
    if (delaySec <= 0) {
      showStatus('error', 'Error: Please enter a valid countdown time.');
      return null;
    }
    return delaySec * 1000;
  }

  function getVal(id) {
    return parseInt(document.getElementById(id).value, 10) || 0;
  }

  function showStatus(type, message, triggerAt) {
    statusSection.style.display = 'block';
    statusSection.className     = `status-section ${type}`;
    statusText.textContent      = message;

    stopCountdown();
    if (triggerAt) {
      startCountdown(triggerAt);
    } else {
      statusCountdown.textContent = '';
    }
  }

  function hideStatus() {
    stopCountdown();
    statusSection.style.display = 'none';
  }

  function startCountdown(triggerAt) {
    updateCountdown(triggerAt);
    countdownTimer = setInterval(() => updateCountdown(triggerAt), 1000);
  }

  function updateCountdown(triggerAt) {
    const remaining = triggerAt - Date.now();
    if (remaining <= 0) {
      statusCountdown.textContent = 'Triggering...';
      stopCountdown();
      return;
    }
    statusCountdown.textContent = formatMs(remaining);
  }

  function stopCountdown() {
    if (countdownTimer) {
      clearInterval(countdownTimer);
      countdownTimer = null;
    }
  }

  function formatMs(ms) {
    const total = Math.floor(ms / 1000);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const pad = n => String(n).padStart(2, '0');
    return h > 0
      ? `${h}:${pad(m)}:${pad(s)}`
      : `${pad(m)}:${pad(s)}`;
  }
});
