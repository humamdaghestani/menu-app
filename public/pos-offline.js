'use strict';

// ─── IndexedDB wrapper ────────────────────────────────────────────────────────
const _idb = (() => {
  let _db = null;

  function open() {
    return new Promise((res, rej) => {
      if (_db) return res(_db);
      const r = indexedDB.open('pos_v1', 1);
      r.onupgradeneeded = e => {
        const d = e.target.result;
        if (!d.objectStoreNames.contains('queue'))
          d.createObjectStore('queue', { keyPath: 'id', autoIncrement: true });
      };
      r.onsuccess = e => { _db = e.target.result; res(_db); };
      r.onerror   = e => rej(e.target.error);
    });
  }

  function _store(name, mode) { return _db.transaction(name, mode).objectStore(name); }

  async function put(s, v)  { await open(); return new Promise((r,j) => { const q=_store(s,'readwrite').put(v); q.onsuccess=()=>r(q.result); q.onerror=()=>j(q.error); }); }
  async function all(s)     { await open(); return new Promise((r,j) => { const q=_store(s).getAll();           q.onsuccess=()=>r(q.result); q.onerror=()=>j(q.error); }); }
  async function del(s, k)  { await open(); return new Promise((r,j) => { const q=_store(s,'readwrite').delete(k); q.onsuccess=()=>r();         q.onerror=()=>j(q.error); }); }

  return { put, all, del };
})();

// ─── Offline banner ───────────────────────────────────────────────────────────
let _offline = !navigator.onLine;

function _showBanner(show) {
  let b = document.getElementById('_pos_offline_banner');
  if (!b) {
    b = document.createElement('div');
    b.id = '_pos_offline_banner';
    Object.assign(b.style, {
      position: 'fixed', top: '0', left: '0', right: '0', zIndex: '9999',
      background: '#c0392b', color: '#fff', textAlign: 'center',
      padding: '9px 16px', fontSize: '.81rem', fontWeight: '700',
      display: 'none', fontFamily: 'Segoe UI,sans-serif',
      boxShadow: '0 2px 12px rgba(0,0,0,.4)',
    });
    b.textContent = '📶 No internet — order items are saved locally and will sync automatically when you reconnect';
    document.body.prepend(b);
  }
  b.style.display = show ? 'block' : 'none';
}

// ─── Queue & sync ────────────────────────────────────────────────────────────
async function _flush() {
  const items = await _idb.all('queue');
  if (!items.length) return;
  let allOk = true;
  for (const item of items) {
    try {
      const res = await fetch(item.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(item.body),
      });
      if (res.ok) {
        await _idb.del('queue', item.id);
      } else {
        allOk = false;
        break;
      }
    } catch {
      allOk = false;
      break;
    }
  }
  if (allOk) {
    // Queue empty — refresh page to show server-confirmed state
    window.location.reload();
  }
}

window.addEventListener('online', () => {
  _offline = false;
  _showBanner(false);
  _flush();
});
window.addEventListener('offline', () => {
  _offline = true;
  _showBanner(true);
});

if (_offline) {
  document.addEventListener('DOMContentLoaded', () => _showBanner(true));
}

// ─── Main action dispatcher ───────────────────────────────────────────────────
// url: POST endpoint, body: JSON body, applyFn: called immediately when offline
// Returns { ok, data, offline }
async function posAction(url, body, applyFn) {
  if (!_offline) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {}),
      });
      if (res.ok) {
        const data = await res.json();
        return { ok: true, data };
      }
      const err = await res.json().catch(() => ({}));
      return { ok: false, error: err.error || 'Server error', data: err };
    } catch {
      _offline = true;
      _showBanner(true);
    }
  }
  // Offline path — queue and apply locally
  await _idb.put('queue', { url, body: body || {}, ts: Date.now() });
  if (applyFn) applyFn();
  return { ok: true, offline: true };
}

// ─── Service Worker registration ──────────────────────────────────────────────
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}
