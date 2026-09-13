/**
 * ZenRadius Custom Toast Notification & Scroll Helpers
 */
(function() {
  // 1. Toast Notification Container Setup
  const toastContainer = document.createElement('div');
  toastContainer.id = 'zt-container';
  toastContainer.style.cssText = `
    position: fixed;
    top: 20px;
    right: 20px;
    z-index: 10000;
    display: flex;
    flex-direction: column;
    gap: 10px;
    max-width: 380px;
    width: calc(100% - 40px);
    pointer-events: none;
  `;
  document.body.appendChild(toastContainer);

  // Global show toast function
  window.showAlertToast = function(message, type = 'success') {
    const toast = document.createElement('div');
    toast.className = `zt-toast ${type}`;
    toast.style.cssText = `
      background: rgba(27, 70, 86, 0.7);
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      border: 1px solid rgba(190, 239, 255, 0.2);
      border-radius: 12px;
      padding: 12px 18px;
      color: #edf7f5;
      font-size: 13px;
      font-weight: 500;
      box-shadow: 0 12px 30px rgba(10, 41, 50, 0.35);
      display: flex;
      align-items: center;
      gap: 10px;
      transform: translateY(-20px) scale(0.95);
      opacity: 0;
      transition: all 0.3s cubic-bezier(0.34, 1.56, 0.64, 1);
      pointer-events: auto;
      word-break: break-word;
    `;

    // Ambil aksen border kiri sesuai tipe
    let icon = '<i class="bi bi-check-circle-fill" style="color:#34D399;font-size:16px"></i>';
    if (type === 'danger' || type === 'error') {
      toast.style.borderLeft = '4px solid #F87171';
      icon = '<i class="bi bi-x-circle-fill" style="color:#F87171;font-size:16px"></i>';
    } else if (type === 'warning') {
      toast.style.borderLeft = '4px solid #FBBF24';
      icon = '<i class="bi bi-exclamation-triangle-fill" style="color:#FBBF24;font-size:16px"></i>';
    } else if (type === 'info') {
      toast.style.borderLeft = '4px solid #60A5FA';
      icon = '<i class="bi bi-info-circle-fill" style="color:#60A5FA;font-size:16px"></i>';
    } else {
      toast.style.borderLeft = '4px solid #34D399';
    }

    toast.innerHTML = `
      ${icon}
      <div style="flex:1">${message}</div>
      <button type="button" style="background:none;border:none;color:#a8bec2;cursor:pointer;font-size:16px;line-height:1;padding:0" onclick="this.parentElement.remove()">&times;</button>
    `;

    toastContainer.appendChild(toast);

    // Trigger transition reflow
    setTimeout(() => {
      toast.style.transform = 'translateY(0) scale(1)';
      toast.style.opacity = '1';
    }, 50);

    // Auto dismiss after 3.5 seconds
    setTimeout(() => {
      toast.style.transform = 'translateY(-20px) scale(0.9)';
      toast.style.opacity = '0';
      setTimeout(() => toast.remove(), 300);
    }, 3500);
  };

  // Override standard window.alert to beautiful toast
  const originalAlert = window.alert;
  window.alert = function(msg) {
    if (typeof msg === 'string') {
      const lower = msg.toLowerCase();
      const isErr = lower.includes('gagal') || lower.includes('salah') || lower.includes('error') || lower.includes('failed');
      window.showAlertToast(msg, isErr ? 'danger' : 'success');
    } else {
      window.showAlertToast(String(msg), 'info');
    }
  };

  // 2. Scroll To Top Button Setup
  const scrollTopBtn = document.createElement('button');
  scrollTopBtn.id = 'zt-scroll-top';
  scrollTopBtn.type = 'button';
  scrollTopBtn.setAttribute('aria-label', 'Scroll ke atas');
  scrollTopBtn.style.cssText = `
    position: fixed;
    bottom: calc(75px + env(safe-area-inset-bottom, 0px)); /* letak di atas bottom nav */
    right: 20px;
    width: 42px;
    height: 42px;
    border-radius: 50%;
    background: linear-gradient(135deg, #236060 0%, #183f51 100%);
    border: 1px solid rgba(126, 231, 219, 0.4);
    box-shadow: 0 8px 20px rgba(10, 41, 50, 0.4);
    color: #22D3EE;
    font-size: 18px;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
    opacity: 0;
    transform: translateY(20px) scale(0.8);
    transition: all 0.3s cubic-bezier(0.34, 1.56, 0.64, 1);
    pointer-events: none;
  `;
  scrollTopBtn.innerHTML = '<i class="bi bi-arrow-up-short"></i>';
  document.body.appendChild(scrollTopBtn);

  // Hover animations
  scrollTopBtn.addEventListener('mouseenter', () => {
    scrollTopBtn.style.background = 'linear-gradient(135deg, #2d7774 0%, #1d5264 100%)';
    scrollTopBtn.style.transform = 'translateY(0) scale(1.1)';
  });
  scrollTopBtn.addEventListener('mouseleave', () => {
    scrollTopBtn.style.background = 'linear-gradient(135deg, #236060 0%, #183f51 100%)';
    scrollTopBtn.style.transform = 'translateY(0) scale(1)';
  });

  scrollTopBtn.addEventListener('click', () => {
    window.scrollTo({ top: 0, behavior: 'smooth' });
    const mwNode = document.querySelector('.mw');
    if (mwNode) mwNode.scrollTo({ top: 0, behavior: 'smooth' });
  });

  // Scroll visibility handler (check standard scroll & .mw block container scrolls)
  function handleScroll() {
    const mwNode = document.querySelector('.mw');
    const scrollY = window.scrollY || (mwNode ? mwNode.scrollTop : 0);
    if (scrollY > 300) {
      scrollTopBtn.style.opacity = '1';
      scrollTopBtn.style.transform = 'translateY(0) scale(1)';
      scrollTopBtn.style.pointerEvents = 'auto';
    } else {
      scrollTopBtn.style.opacity = '0';
      scrollTopBtn.style.transform = 'translateY(20px) scale(0.8)';
      scrollTopBtn.style.pointerEvents = 'none';
    }
  }

  window.addEventListener('scroll', handleScroll, { passive: true });
  setTimeout(() => {
    const mwNode = document.querySelector('.mw');
    if (mwNode) mwNode.addEventListener('scroll', handleScroll, { passive: true });
  }, 1000);
})();
