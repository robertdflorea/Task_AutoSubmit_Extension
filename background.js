// ── Button clicker (injected into the target page) ────────────────────────
// This function runs in the page context. It clicks the main button,
// then waits up to 4 seconds for a confirmation modal and clicks it too.
async function clickButtonOnPage(action) {
  const SELECTORS = [
    'button',
    '[role="button"]',
    'input[type="button"]',
    'input[type="submit"]'
  ];

  // Find a clickable element whose visible text matches one of the given terms
  function findButton(terms, root = document, exclude = null) {
    for (const selector of SELECTORS) {
      for (const el of root.querySelectorAll(selector)) {
        if (el === exclude) continue;
        const label = (
          el.textContent ||
          el.value ||
          el.getAttribute('aria-label') ||
          el.getAttribute('title') ||
          ''
        ).trim().toLowerCase();
        if (terms.some(t => label.includes(t.toLowerCase()))) return el;
      }
    }
    return null;
  }

  // ── Step 1: click the main button (Submit / Pause) ──────────────────────
  // Retry for up to 10 seconds — handles slow SPA rendering after tab reopen
  let mainBtn = null;
  const deadline = Date.now() + 10000;
  while (!mainBtn && Date.now() < deadline) {
    mainBtn = findButton([action]);
    if (!mainBtn) await new Promise(r => setTimeout(r, 500));
  }
  if (!mainBtn) return { success: false, step: 'main_not_found' };

  mainBtn.click();

  // ── Step 2: wait for a confirmation modal and click its confirm button ───
  // Polls every 200 ms for up to 4 seconds.
  // Looks inside standard modal/dialog containers first; if the action is
  // "Submit" the modal's own "Submit" button is also a valid confirm target.
  const CONFIRM_TERMS = ['submit', 'confirm', 'yes', 'ok', 'proceed', 'continue'];
  const MODAL_SELECTORS = [
    '[role="dialog"]',
    '[role="alertdialog"]',
    '.modal',
    '.dialog',
    '[class*="modal"]',
    '[class*="dialog"]',
    '[class*="popup"]',
    '[class*="overlay"]'
  ].join(', ');

  const modalBtn = await new Promise(resolve => {
    const deadline = Date.now() + 4000;
    const interval = setInterval(() => {
      // Search inside any visible modal/dialog container
      for (const container of document.querySelectorAll(MODAL_SELECTORS)) {
        const btn = findButton(CONFIRM_TERMS, container, mainBtn);
        if (btn) {
          clearInterval(interval);
          resolve(btn);
          return;
        }
      }
      if (Date.now() >= deadline) {
        clearInterval(interval);
        resolve(null);
      }
    }, 200);
  });

  if (modalBtn) {
    modalBtn.click();
    return { success: true, modalHandled: true,  text: mainBtn.textContent.trim() };
  }

  return { success: true, modalHandled: false, text: mainBtn.textContent.trim() };
}

// ── Generate a notification icon via OffscreenCanvas ──────────────────────
async function buildIconDataUrl() {
  const canvas = new OffscreenCanvas(64, 64);
  const ctx    = canvas.getContext('2d');

  ctx.fillStyle = '#6366f1';
  ctx.beginPath();
  ctx.arc(32, 32, 32, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle    = 'white';
  ctx.font         = 'bold 30px sans-serif';
  ctx.textAlign    = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('A', 32, 34);

  const blob   = await canvas.convertToBlob({ type: 'image/png' });
  const buffer = await blob.arrayBuffer();
  const bytes  = new Uint8Array(buffer);
  let binary   = '';
  bytes.forEach(b => (binary += String.fromCharCode(b)));
  return 'data:image/png;base64,' + btoa(binary);
}

// ── Show a Chrome notification ─────────────────────────────────────────────
async function showNotification(title, message) {
  let iconUrl;
  try {
    iconUrl = await buildIconDataUrl();
  } catch {
    iconUrl = ''; // Chrome 116+ allows omitting iconUrl
  }

  chrome.notifications.create('autosubmit-result', {
    type:    'basic',
    iconUrl,
    title,
    message,
    priority: 2
  });
}

// ── Wait for a tab to finish loading ──────────────────────────────────────
function waitForTabLoad(tabId) {
  return new Promise(resolve => {
    const listener = (id, changeInfo) => {
      if (id === tabId && changeInfo.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        setTimeout(resolve, 1500); // Extra wait for SPA rendering
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
}

// ── Main click routine ─────────────────────────────────────────────────────
async function performClick() {
  const { scheduledAction, targetUrl } = await chrome.storage.local.get([
    'scheduledAction',
    'targetUrl'
  ]);

  if (!scheduledAction || !targetUrl) return;

  // Try to find an already-open tab matching the stored URL
  let targetTab = null;
  try {
    const stored = new URL(targetUrl);
    const allTabs = await chrome.tabs.query({});
    targetTab = allTabs.find(t => {
      if (!t.url) return false;
      try {
        const u = new URL(t.url);
        return u.origin === stored.origin && u.pathname === stored.pathname;
      } catch { return false; }
    }) || null;
  } catch {
    // URL parsing failed — will open a new tab below
  }

  // If the tab is not open, the task session is gone — clicking is impossible
  if (!targetTab) {
    await chrome.storage.local.set({ status: 'tab_closed', statusTime: Date.now() });
    chrome.action.setBadgeText({ text: '✗' });
    chrome.action.setBadgeBackgroundColor({ color: '#ef4444' });
    setTimeout(() => chrome.action.setBadgeText({ text: '' }), 10000);
    await showNotification(
      'AutoSubmit — Tab Was Closed',
      `Could not click "${scheduledAction}": the task tab was closed before the timer fired. Please check your task manually.`
    );
    return;
  }

  // Inject and execute the click function
  let result;
  try {
    const [{ result: clickResult }] = await chrome.scripting.executeScript({
      target: { tabId: targetTab.id },
      func:   clickButtonOnPage,
      args:   [scheduledAction]
    });
    result = clickResult;
  } catch (err) {
    result = { success: false, error: err.message };
  }

  // Persist outcome for popup display
  const status = result?.success ? 'clicked' : 'failed';
  await chrome.storage.local.set({ status, statusTime: Date.now() });

  // Badge feedback on the extension icon
  chrome.action.setBadgeText({ text: result?.success ? '✓' : '✗' });
  chrome.action.setBadgeBackgroundColor({
    color: result?.success ? '#22c55e' : '#ef4444'
  });
  setTimeout(() => chrome.action.setBadgeText({ text: '' }), 10000);

  // ── Notification ──────────────────────────────────────────────────────────
  if (!result?.success) {
    await showNotification(
      'AutoSubmit — Action Failed',
      `Could not find the "${scheduledAction}" button on the page.`
    );
  } else if (result.modalHandled) {
    await showNotification(
      `AutoSubmit — ${scheduledAction} Confirmed`,
      `"${scheduledAction}" was clicked and the confirmation dialog was accepted automatically.`
    );
  } else {
    await showNotification(
      `AutoSubmit — ${scheduledAction} Clicked`,
      `The "${scheduledAction}" button was clicked successfully.`
    );
  }
}

// ── Notification click → focus the target tab ──────────────────────────────
chrome.notifications.onClicked.addListener(async (notificationId) => {
  if (notificationId !== 'autosubmit-result') return;

  chrome.notifications.clear(notificationId);

  const { targetUrl } = await chrome.storage.local.get('targetUrl');
  if (!targetUrl) return;

  // Find an open tab matching the stored URL
  const allTabs = await chrome.tabs.query({});
  let targetTab = null;
  try {
    const stored = new URL(targetUrl);
    targetTab = allTabs.find(t => {
      if (!t.url) return false;
      try {
        const u = new URL(t.url);
        return u.origin === stored.origin && u.pathname === stored.pathname;
      } catch { return false; }
    }) || null;
  } catch { /* ignore */ }

  if (targetTab) {
    // Tab is open — bring it into focus
    await chrome.tabs.update(targetTab.id, { active: true });
    await chrome.windows.update(targetTab.windowId, { focused: true });
  } else {
    // Tab was closed — reopen it
    await chrome.tabs.create({ url: targetUrl, active: true });
  }
});

// ── Warn immediately when the target tab is closed while a timer is active ──
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const { status, targetUrl } = await chrome.storage.local.get(['status', 'targetUrl']);
  if (status !== 'scheduled' || !targetUrl) return;

  // Check if the closed tab was the target tab
  // We can't read the URL of a removed tab, so we store the tabId at set-time
  const { targetTabId } = await chrome.storage.local.get('targetTabId');
  if (tabId !== targetTabId) return;

  await showNotification(
    'AutoSubmit — Warning: Task Tab Closed',
    'You closed the task tab while a timer is active. The scheduled action will not be able to click the button.'
  );
});

// ── Alarm listener ─────────────────────────────────────────────────────────
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'autosubmit') {
    performClick();
  }
});

// ── Message listener (from popup) ──────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'SET_ALARM') {
    // Store the tabId of the tab that set the alarm so we can detect if it's closed
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tabId = tabs[0]?.id ?? null;
      chrome.storage.local.set({ targetTabId: tabId });
    });
    chrome.alarms.clear('autosubmit', () => {
      chrome.alarms.create('autosubmit', {
        // NOTE: Chrome enforces a minimum alarm delay of ~1 minute for
        // unpacked extensions. This is fine for tasks that expire in hours.
        when: Date.now() + msg.delayMs
      });
      sendResponse({ ok: true });
    });
    return true;

  } else if (msg.type === 'CANCEL_ALARM') {
    chrome.alarms.clear('autosubmit', () => {
      sendResponse({ ok: true });
    });
    return true;
  }
});
