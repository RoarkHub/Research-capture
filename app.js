// Roark R&D Capture — talks directly to the GitHub Contents API.
// No backend, no framework. Settings and a retry queue live in localStorage.

const SETTINGS_KEY = 'capture.settings';
const QUEUE_KEY = 'capture.queue';

function loadSettings() {
  try {
    return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {};
  } catch {
    return {};
  }
}

function saveSettings(settings) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

function loadQueue() {
  try {
    return JSON.parse(localStorage.getItem(QUEUE_KEY)) || [];
  } catch {
    return [];
  }
}

function saveQueue(queue) {
  localStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
}

// btoa() alone mangles anything outside Latin-1 (emoji, accented characters).
// Encode to UTF-8 bytes first, then base64, so non-ASCII note content survives.
function utf8ToBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let binary = '';
  bytes.forEach((b) => { binary += String.fromCharCode(b); });
  return btoa(binary);
}

function slugify(text, maxLen = 40) {
  const slug = (text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLen);
  return slug || 'note';
}

function timestampUTC() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-${pad(now.getUTCDate())}` +
    `-${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`
  );
}

function buildMarkdown({ project, tags, summary, body, created }) {
  const tagList = (tags || '')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);

  const lines = ['---'];
  if (project) lines.push(`project: ${project}`);
  lines.push(`tags: [${tagList.join(', ')}]`);
  if (summary) lines.push(`summary: ${summary}`);
  lines.push(`created: ${created}`);
  lines.push('---', '', body || '');
  return lines.join('\n');
}

// Deliberately does NOT send X-GitHub-Api-Version — that header isn't in
// GitHub's CORS allow-list yet and triggers a preflight failure in browsers.
async function pushToGitHub({ owner, repo, token, path, content, message, branch }) {
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      message,
      content: utf8ToBase64(content),
      branch,
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`GitHub API ${res.status}: ${detail.slice(0, 200)}`);
  }
  return res.json();
}

function enqueue(item) {
  const queue = loadQueue();
  queue.push(item);
  saveQueue(queue);
  updateQueueStatus();
}

async function flushQueue() {
  const settings = loadSettings();
  if (!settings.token) return;

  const queue = loadQueue();
  if (!queue.length) return;

  const remaining = [];
  for (const item of queue) {
    try {
      await pushToGitHub({ ...settings, ...item });
    } catch {
      remaining.push(item); // keep it queued, try again next time
    }
  }
  saveQueue(remaining);
  updateQueueStatus();
}

function updateQueueStatus() {
  const el = document.getElementById('queue-status');
  if (!el) return;
  const n = loadQueue().length;
  el.textContent = n ? `${n} note(s) waiting to sync` : '';
}

function setStatus(msg, isError = false) {
  const el = document.getElementById('save-status');
  el.textContent = msg;
  el.className = isError ? 'status error' : 'status ok';
}

document.addEventListener('DOMContentLoaded', () => {
  const settings = loadSettings();
  document.getElementById('gh-token').value = settings.token || '';
  document.getElementById('gh-owner').value = settings.owner || '';
  document.getElementById('gh-repo').value = settings.repo || '';
  document.getElementById('gh-path').value = settings.path || 'vault';
  document.getElementById('gh-branch').value = settings.branch || 'main';

  updateQueueStatus();
  flushQueue();

  document.getElementById('settings-save-btn').addEventListener('click', () => {
    saveSettings({
      token: document.getElementById('gh-token').value.trim(),
      owner: document.getElementById('gh-owner').value.trim(),
      repo: document.getElementById('gh-repo').value.trim(),
      path: document.getElementById('gh-path').value.trim() || 'vault',
      branch: document.getElementById('gh-branch').value.trim() || 'main',
    });
    setStatus('Settings saved.');
  });

  document.getElementById('note-save-btn').addEventListener('click', async () => {
    const s = loadSettings();
    if (!s.token || !s.owner || !s.repo) {
      setStatus('Fill in Settings first (token, owner, repo).', true);
      return;
    }

    const project = document.getElementById('project').value.trim();
    const tags = document.getElementById('tags').value.trim();
    const summary = document.getElementById('summary').value.trim();
    const body = document.getElementById('body').value;

    const created = new Date().toISOString().slice(0, 10);
    const markdown = buildMarkdown({ project, tags, summary, body, created });
    const slug = slugify(summary || body.slice(0, 40));
    const path = `${s.path}/${timestampUTC()}-${slug}.md`;
    const message = `Capture: ${project || 'note'} — ${summary || slug}`;

    const item = { path, content: markdown, message, branch: s.branch };

    try {
      await pushToGitHub({ ...s, ...item });
      setStatus('Saved.');
      document.getElementById('note-form').reset();
    } catch (err) {
      const message = err && err.message ? err.message : String(err);
      // A true connectivity failure throws before any response comes back
      // (browsers report this as "Failed to fetch" / "NetworkError" / "Load
      // failed"). Anything else means the request reached GitHub and got a
      // real answer back — retrying with the same settings would just fail
      // again, so show the actual reason instead of masking it.
      const looksOffline = !navigator.onLine || /failed to fetch|networkerror|load failed/i.test(message);
      if (looksOffline) {
        enqueue(item);
        setStatus('Offline — queued, will retry automatically.', true);
      } else {
        setStatus(`Save failed: ${message}`, true);
      }
    }
  });

  window.addEventListener('online', flushQueue);

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
});
