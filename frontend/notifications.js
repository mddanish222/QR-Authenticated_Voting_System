/* ============================================================
   notifications.js — drop-in replacements for alert/confirm
   Inject once per page, use anywhere:
     Notify.alert('message', 'success'|'error'|'info'|'warn')
     Notify.confirm('Are you sure?') → returns Promise<boolean>
   ============================================================ */

;(function () {

  /* ── inject styles once ── */
  if (!document.getElementById('notify-styles')) {
    const style = document.createElement('style')
    style.id = 'notify-styles'
    style.textContent = `
      /* ── TOAST ── */
      #notify-toast-wrap {
        position: fixed;
        bottom: clamp(16px, 4vw, 28px);
        left: 50%;
        transform: translateX(-50%);
        z-index: 99999;
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 8px;
        pointer-events: none;
        width: max-content;
        max-width: calc(100vw - 32px);
      }
      .notify-toast {
        background: rgba(15,23,42,0.93);
        border: 1px solid rgba(255,255,255,0.13);
        border-radius: 12px;
        padding: 12px 20px;
        display: flex;
        align-items: center;
        gap: 10px;
        font-size: 14px;
        font-family: 'DM Sans', sans-serif;
        font-weight: 500;
        color: #e2e8f0;
        box-shadow: 0 8px 32px rgba(0,0,0,0.28);
        opacity: 0;
        transform: translateY(16px);
        transition: opacity 0.35s cubic-bezier(.34,1.56,.64,1),
                    transform 0.35s cubic-bezier(.34,1.56,.64,1);
        pointer-events: auto;
        white-space: nowrap;
        max-width: calc(100vw - 32px);
      }
      .notify-toast.show {
        opacity: 1;
        transform: translateY(0);
      }
      .notify-toast-icon { font-size: 16px; flex-shrink: 0; }
      .notify-toast.t-success { border-color: rgba(5,150,105,0.45); }
      .notify-toast.t-error   { border-color: rgba(220,38,38,0.45); }
      .notify-toast.t-warn    { border-color: rgba(217,119,6,0.45); }
      .notify-toast.t-info    { border-color: rgba(99,102,241,0.45); }

      /* ── CONFIRM MODAL ── */
      #notify-confirm-overlay {
        display: none;
        position: fixed;
        inset: 0;
        background: rgba(15,23,42,0.52);
        backdrop-filter: blur(8px);
        -webkit-backdrop-filter: blur(8px);
        z-index: 99998;
        align-items: center;
        justify-content: center;
        padding: 20px;
      }
      #notify-confirm-overlay.show {
        display: flex;
        animation: notify-fadein 0.22s ease;
      }
      @keyframes notify-fadein {
        from { opacity: 0; }
        to   { opacity: 1; }
      }
      #notify-confirm-box {
        background: rgba(255,255,255,0.94);
        backdrop-filter: blur(20px);
        -webkit-backdrop-filter: blur(20px);
        border: 1px solid rgba(255,255,255,0.90);
        border-radius: 20px;
        padding: clamp(22px,4vw,32px) clamp(18px,4vw,28px);
        max-width: min(100%, 380px);
        width: 100%;
        box-shadow: 0 20px 60px rgba(15,23,42,0.20);
        animation: notify-slideup 0.3s cubic-bezier(.34,1.2,.64,1);
        text-align: center;
      }
      @keyframes notify-slideup {
        from { transform: translateY(20px) scale(0.97); opacity: 0; }
        to   { transform: translateY(0) scale(1); opacity: 1; }
      }
      #notify-confirm-icon {
        font-size: 40px;
        margin-bottom: 12px;
        display: block;
      }
      #notify-confirm-title {
        font-family: 'Syne', 'DM Sans', sans-serif;
        font-size: clamp(15px,3.5vw,18px);
        font-weight: 700;
        color: #0f172a;
        margin-bottom: 8px;
        line-height: 1.3;
      }
      #notify-confirm-sub {
        font-size: 13px;
        color: #64748b;
        font-family: 'DM Sans', sans-serif;
        margin-bottom: 22px;
        line-height: 1.5;
      }
      #notify-confirm-actions {
        display: flex;
        gap: 10px;
      }
      #notify-confirm-no {
        flex: 1;
        height: 42px;
        background: rgba(255,255,255,0.75);
        border: 1px solid rgba(100,130,180,0.28);
        color: #334155;
        border-radius: 10px;
        font-family: 'Syne', 'DM Sans', sans-serif;
        font-size: 13px;
        font-weight: 700;
        letter-spacing: 0.05em;
        text-transform: uppercase;
        cursor: pointer;
        transition: all 0.2s;
      }
      #notify-confirm-no:hover { background: rgba(255,255,255,0.95); }
      #notify-confirm-yes {
        flex: 1;
        height: 42px;
        border: none;
        border-radius: 10px;
        font-family: 'Syne', 'DM Sans', sans-serif;
        font-size: 13px;
        font-weight: 700;
        letter-spacing: 0.05em;
        text-transform: uppercase;
        cursor: pointer;
        transition: all 0.2s;
        color: #fff;
      }
      #notify-confirm-yes:hover { filter: brightness(1.10); transform: translateY(-1px); }
      #notify-confirm-yes.c-danger {
        background: linear-gradient(135deg, #dc2626, #b91c1c);
        box-shadow: 0 4px 14px rgba(220,38,38,0.28);
      }
      #notify-confirm-yes.c-primary {
        background: linear-gradient(135deg, #1a56db, #3b82f6);
        box-shadow: 0 4px 14px rgba(26,86,219,0.28);
      }

      /* ── ALERT MODAL ── */
      #notify-alert-overlay {
        display: none;
        position: fixed;
        inset: 0;
        background: rgba(15,23,42,0.52);
        backdrop-filter: blur(8px);
        -webkit-backdrop-filter: blur(8px);
        z-index: 99998;
        align-items: center;
        justify-content: center;
        padding: 20px;
      }
      #notify-alert-overlay.show {
        display: flex;
        animation: notify-fadein 0.22s ease;
      }
      #notify-alert-box {
        background: rgba(255,255,255,0.94);
        backdrop-filter: blur(20px);
        -webkit-backdrop-filter: blur(20px);
        border: 1px solid rgba(255,255,255,0.90);
        border-radius: 20px;
        padding: clamp(22px,4vw,32px) clamp(18px,4vw,28px);
        max-width: min(100%, 380px);
        width: 100%;
        box-shadow: 0 20px 60px rgba(15,23,42,0.20);
        animation: notify-slideup 0.3s cubic-bezier(.34,1.2,.64,1);
        text-align: center;
      }
      #notify-alert-icon { font-size: 40px; margin-bottom: 12px; display: block; }
      #notify-alert-title {
        font-family: 'Syne', 'DM Sans', sans-serif;
        font-size: clamp(15px,3.5vw,18px);
        font-weight: 700;
        color: #0f172a;
        margin-bottom: 8px;
        line-height: 1.3;
      }
      #notify-alert-sub {
        font-size: 13px;
        color: #64748b;
        font-family: 'DM Sans', sans-serif;
        margin-bottom: 22px;
        line-height: 1.5;
      }
      #notify-alert-ok {
        width: 100%;
        height: 42px;
        border: none;
        border-radius: 10px;
        font-family: 'Syne', 'DM Sans', sans-serif;
        font-size: 13px;
        font-weight: 700;
        letter-spacing: 0.05em;
        text-transform: uppercase;
        cursor: pointer;
        color: #fff;
        background: linear-gradient(135deg, #1a56db, #3b82f6);
        box-shadow: 0 4px 14px rgba(26,86,219,0.28);
        transition: all 0.2s;
      }
      #notify-alert-ok.a-danger {
        background: linear-gradient(135deg, #dc2626, #b91c1c);
        box-shadow: 0 4px 14px rgba(220,38,38,0.28);
      }
      #notify-alert-ok.a-success {
        background: linear-gradient(135deg, #059669, #10b981);
        box-shadow: 0 4px 14px rgba(5,150,105,0.28);
      }
      #notify-alert-ok:hover { filter: brightness(1.10); transform: translateY(-1px); }
    `
    document.head.appendChild(style)
  }

  /* ── build DOM once ── */
  function ensureDOM() {
    if (!document.getElementById('notify-toast-wrap')) {
      const wrap = document.createElement('div')
      wrap.id = 'notify-toast-wrap'
      document.body.appendChild(wrap)
    }

    if (!document.getElementById('notify-confirm-overlay')) {
      const html = `
        <div id="notify-confirm-overlay">
          <div id="notify-confirm-box">
            <span id="notify-confirm-icon">❓</span>
            <div id="notify-confirm-title"></div>
            <div id="notify-confirm-sub"></div>
            <div id="notify-confirm-actions">
              <button id="notify-confirm-no">Cancel</button>
              <button id="notify-confirm-yes" class="c-danger">Confirm</button>
            </div>
          </div>
        </div>`
      document.body.insertAdjacentHTML('beforeend', html)
    }

    if (!document.getElementById('notify-alert-overlay')) {
      const html = `
        <div id="notify-alert-overlay">
          <div id="notify-alert-box">
            <span id="notify-alert-icon">ℹ️</span>
            <div id="notify-alert-title"></div>
            <div id="notify-alert-sub"></div>
            <button id="notify-alert-ok">OK</button>
          </div>
        </div>`
      document.body.insertAdjacentHTML('beforeend', html)
    }
  }

  /* ── TOAST ── */
  const TOAST_ICONS = {
    success: '✅',
    error:   '❌',
    warn:    '⚠️',
    info:    'ℹ️'
  }

  function showToast(msg, type = 'info', duration = 3800) {
    ensureDOM()
    const wrap  = document.getElementById('notify-toast-wrap')
    const toast = document.createElement('div')
    toast.className = `notify-toast t-${type}`
    toast.innerHTML = `
      <span class="notify-toast-icon">${TOAST_ICONS[type] || TOAST_ICONS.info}</span>
      <span>${msg}</span>`
    wrap.appendChild(toast)
    requestAnimationFrame(() => {
      requestAnimationFrame(() => toast.classList.add('show'))
    })
    setTimeout(() => {
      toast.classList.remove('show')
      setTimeout(() => toast.remove(), 400)
    }, duration)
  }

  /* ── ALERT MODAL ── */
  function showAlert(msg, type = 'info') {
    ensureDOM()
    return new Promise(resolve => {
      const icons = { success: '✅', error: '❌', warn: '⚠️', info: 'ℹ️' }

      const overlay = document.getElementById('notify-alert-overlay')
      const iconEl  = document.getElementById('notify-alert-icon')
      const titleEl = document.getElementById('notify-alert-title')
      const subEl   = document.getElementById('notify-alert-sub')
      const okBtn   = document.getElementById('notify-alert-ok')

      // Split on first newline for title vs sub
      const parts = msg.split('\n')
      iconEl.textContent  = icons[type] || icons.info
      titleEl.textContent = parts[0]
      subEl.textContent   = parts.slice(1).join('\n')
      subEl.style.display = parts.length > 1 ? '' : 'none'

      okBtn.className = ''
      if (type === 'error')   okBtn.classList.add('a-danger')
      if (type === 'success') okBtn.classList.add('a-success')

      overlay.classList.add('show')

      function done() {
        overlay.classList.remove('show')
        okBtn.removeEventListener('click', done)
        resolve(true)
      }

      okBtn.addEventListener('click', done)

      // close on backdrop
      overlay.addEventListener('click', function handler(e) {
        if (e.target === overlay) {
          overlay.classList.remove('show')
          overlay.removeEventListener('click', handler)
          resolve(true)
        }
      })
    })
  }

  /* ── CONFIRM MODAL ── */
  function showConfirm(msg, opts = {}) {
    ensureDOM()
    return new Promise(resolve => {
      const {
        type      = 'danger',   // 'danger' | 'primary'
        yesLabel  = 'Confirm',
        noLabel   = 'Cancel',
        icon      = '⚠️'
      } = opts

      const overlay = document.getElementById('notify-confirm-overlay')
      const iconEl  = document.getElementById('notify-confirm-icon')
      const titleEl = document.getElementById('notify-confirm-title')
      const subEl   = document.getElementById('notify-confirm-sub')
      const yesBtn  = document.getElementById('notify-confirm-yes')
      const noBtn   = document.getElementById('notify-confirm-no')

      const parts = msg.split('\n')
      iconEl.textContent  = icon
      titleEl.textContent = parts[0]
      subEl.textContent   = parts.slice(1).join('\n')
      subEl.style.display = parts.length > 1 ? '' : 'none'

      yesBtn.textContent = yesLabel
      noBtn.textContent  = noLabel
      yesBtn.className   = `c-${type}`

      overlay.classList.add('show')

      function cleanup() {
        overlay.classList.remove('show')
        yesBtn.removeEventListener('click', yes)
        noBtn.removeEventListener('click', no)
      }

      function yes() { cleanup(); resolve(true) }
      function no()  { cleanup(); resolve(false) }

      yesBtn.addEventListener('click', yes)
      noBtn.addEventListener('click', no)

      overlay.addEventListener('click', function handler(e) {
        if (e.target === overlay) {
          cleanup()
          overlay.removeEventListener('click', handler)
          resolve(false)
        }
      })
    })
  }

  /* ── EXPOSE globally ── */
  window.Notify = { toast: showToast, alert: showAlert, confirm: showConfirm }

  /* ── PWA: register service worker ── */
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js').catch(() => {})
    })
  }

})()