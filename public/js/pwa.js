/**
 * PWA Initialization - Service Worker Registration & PWA Features
 * Mendukung offline mode, caching, dan app-like experience
 */

(function() {
  'use strict';

  // ─────────────────────────────────────────────────────────────
  // 1. SERVICE WORKER REGISTRATION
  // ─────────────────────────────────────────────────────────────
  
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js', { scope: '/' })
        .then(reg => {
          console.log('✓ Service Worker registered:', reg.scope);
          
          // Check for updates setiap jam
          setInterval(() => {
            reg.update().catch(err => console.warn('Update check failed:', err));
          }, 3600000);
        })
        .catch(err => console.warn('Service Worker registration failed:', err));
    });
  }

  // ─────────────────────────────────────────────────────────────
  // 2. INSTALL PROMPT (UNTUK MOBILE & DESKTOP)
  // ─────────────────────────────────────────────────────────────
  
  let deferredPrompt;
  let installButton = null;

  // Tangkap event beforeinstallprompt
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    
    // Tampilkan tombol install jika tersedia
    const installElement = document.getElementById('pwa-install-btn');
    if (installElement) {
      installElement.style.display = 'block';
      installButton = installElement;
    }
  });

  // Tangani klik tombol install
  document.addEventListener('DOMContentLoaded', () => {
    const installBtn = document.getElementById('pwa-install-btn');
    if (installBtn) {
      installBtn.addEventListener('click', async () => {
        if (!deferredPrompt) return;
        
        // Tampilkan prompt install
        deferredPrompt.prompt();
        
        // Tunggu user memilih
        const choiceResult = await deferredPrompt.userChoice;
        if (choiceResult.outcome === 'accepted') {
          console.log('✓ PWA installed');
        } else {
          console.log('✗ PWA installation dismissed');
        }
        
        deferredPrompt = null;
        if (installBtn) installBtn.style.display = 'none';
      });
    }
  });

  // Tampilkan pesan setelah install
  window.addEventListener('appinstalled', () => {
    console.log('✓ PWA berhasil diinstall');
    deferredPrompt = null;
    if (installButton) installButton.style.display = 'none';
  });

  // ─────────────────────────────────────────────────────────────
  // 3. DETECT APP MODE (STANDALONE VS BROWSER)
  // ─────────────────────────────────────────────────────────────
  
  function isAppMode() {
    return window.matchMedia('(display-mode: standalone)').matches ||
           navigator.standalone === true ||
           document.referrer.includes('android-app://');
  }

  if (isAppMode()) {
    document.documentElement.classList.add('app-mode');
    console.log('✓ Running in app mode (standalone)');
  }

  // ─────────────────────────────────────────────────────────────
  // 4. HANDLE ONLINE/OFFLINE EVENTS
  // ─────────────────────────────────────────────────────────────
  
  let isOnline = navigator.onLine;

  window.addEventListener('online', () => {
    isOnline = true;
    document.documentElement.classList.remove('offline-mode');
    showOfflineNotification(false);
    console.log('✓ Connected to internet');
  });

  window.addEventListener('offline', () => {
    isOnline = false;
    document.documentElement.classList.add('offline-mode');
    showOfflineNotification(true);
    console.log('✗ Disconnected from internet');
  });

  function showOfflineNotification(offline) {
    const notifId = 'offline-notification';
    let notif = document.getElementById(notifId);
    
    if (offline) {
      if (!notif) {
        notif = document.createElement('div');
        notif.id = notifId;
        notif.style.cssText = `
          position: fixed;
          top: 0;
          left: 0;
          right: 0;
          background: #dc2626;
          color: white;
          padding: 12px 20px;
          text-align: center;
          font-weight: 500;
          z-index: 9999;
          box-shadow: 0 4px 6px rgba(0,0,0,0.1);
        `;
        notif.textContent = '⚠️ Offline - Beberapa fitur mungkin tidak tersedia';
        document.body.insertBefore(notif, document.body.firstChild);
      }
    } else {
      if (notif) {
        notif.style.transition = 'opacity 0.3s ease';
        notif.style.opacity = '0';
        setTimeout(() => notif?.remove(), 300);
      }
    }
  }

  // ─────────────────────────────────────────────────────────────
  // 5. PERIODIC SYNC (UNTUK UPDATE BACKGROUND)
  // ─────────────────────────────────────────────────────────────
  
  if ('periodicSync' in ServiceWorkerRegistration.prototype) {
    navigator.serviceWorker.ready.then(reg => {
      // Jalankan sync setiap 24 jam untuk cek update
      reg.periodicSync.register('check-update', {
        minInterval: 24 * 60 * 60 * 1000
      }).catch(err => console.warn('Periodic sync registration failed:', err));
    });
  }

  // ─────────────────────────────────────────────────────────────
  // 6. NOTIFICATION PERMISSION
  // ─────────────────────────────────────────────────────────────
  
  if ('Notification' in window && Notification.permission === 'default') {
    // Cek apakah user already dismissed notification, jika tidak tanya
    const notifAsked = localStorage.getItem('pwa-notification-asked');
    if (!notifAsked && isAppMode()) {
      setTimeout(() => {
        Notification.requestPermission().then(perm => {
          localStorage.setItem('pwa-notification-asked', 'true');
          if (perm === 'granted') {
            console.log('✓ Notification permission granted');
          }
        });
      }, 2000);
    }
  }

  // ─────────────────────────────────────────────────────────────
  // 7. APP LIFECYCLE EVENTS
  // ─────────────────────────────────────────────────────────────
  
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      console.log('📱 App paused');
    } else {
      console.log('📱 App resumed');
      // Check connection ketika app di-resume
      if (isOnline && 'serviceWorker' in navigator) {
        navigator.serviceWorker.controller?.postMessage({
          type: 'CHECK_UPDATES'
        });
      }
    }
  });

  // ─────────────────────────────────────────────────────────────
  // 8. PUBLIC API
  // ─────────────────────────────────────────────────────────────
  
  window.PWA = {
    isOnline: () => isOnline,
    isAppMode: isAppMode,
    checkUpdate: () => {
      if ('serviceWorker' in navigator) {
        navigator.serviceWorker.ready.then(reg => {
          reg.update();
        });
      }
    },
    getInstallPrompt: () => deferredPrompt,
    showInstallPrompt: async () => {
      if (!deferredPrompt) {
        console.warn('Install prompt tidak tersedia');
        return false;
      }
      deferredPrompt.prompt();
      const result = await deferredPrompt.userChoice;
      deferredPrompt = null;
      return result.outcome === 'accepted';
    }
  };

  console.log('✓ PWA module initialized');
})();
