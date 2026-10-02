/* Global App UI: toast + dialog custom (menggantikan alert/confirm/prompt) */
(function () {
  if (window.__appToastLoaded) return;
  window.__appToastLoaded = true;
  var css = ".app-toast{position:fixed;bottom:28px;right:28px;z-index:99999;min-width:320px;max-width:460px;padding:14px 18px;border-radius:12px;display:flex;align-items:flex-start;gap:12px;font-size:13.5px;color:var(--text,#edf7f5);background:var(--bg2,rgba(17,29,36,0.97));border:1px solid rgba(255,255,255,0.12);box-shadow:0 18px 50px rgba(0,0,0,0.5);animation:appToastIn .28s cubic-bezier(.21,1.02,.73,1)}@keyframes appToastIn{from{opacity:0;transform:translateY(20px) scale(.96)}to{opacity:1;transform:none}}.app-toast-leave{animation:appToastOut .25s ease forwards!important}@keyframes appToastOut{from{opacity:1;transform:none}to{opacity:0;transform:translateY(14px) scale(.96)}}.app-toast-i{font-size:20px;line-height:1;margin-top:1px}.app-toast-b{flex:1;display:flex;flex-direction:column;gap:3px}.app-toast-t{font-weight:800;font-size:13px;color:#fff}.app-toast-m{color:var(--muted,#a8bec2);font-size:12.5px;line-height:1.5;white-space:pre-wrap;word-break:break-word}.app-toast-x{background:none;border:none;color:var(--muted,#94a3b8);cursor:pointer;padding:2px;font-size:15px}.app-modal-overlay{position:fixed;inset:0;z-index:100000;background:rgba(2,8,12,0.66);backdrop-filter:blur(3px);display:flex;align-items:center;justify-content:center;padding:20px}.app-modal-box{background:var(--bg2,#12242e);border:1px solid rgba(255,255,255,0.14);border-radius:16px;width:100%;max-width:440px;box-shadow:0 24px 80px rgba(0,0,0,0.6);padding:22px}.app-modal-i{font-size:40px;line-height:1;margin-bottom:8px;text-align:center}.app-modal-ttl{font-size:16px;font-weight:800;color:#fff;margin-bottom:6px;text-align:center}.app-modal-msg{font-size:13px;line-height:1.6;color:var(--muted,#a8bec2);white-space:pre-wrap;word-break:break-word;margin:4px 0 18px;text-align:center}.app-modal-inp{width:100%;padding:11px 13px;font-size:13.5px;color:var(--text,#fff);background:rgba(255,255,255,0.06);border:1px solid rgba(190,239,255,0.22);border-radius:10px;outline:none;margin-bottom:16px}.app-modal-inp:focus{border-color:rgba(45,212,191,.55);box-shadow:0 0 0 3px rgba(45,212,191,.14)}.app-modal-act{display:flex;gap:10px;justify-content:flex-end}.app-modal-btn{padding:9px 18px;font-size:13px;font-weight:800;border-radius:10px;cursor:pointer;border:1px solid rgba(255,255,255,0.14);color:var(--text,#fff)}.app-modal-btn.primary{background:linear-gradient(135deg,var(--primary,#2dd4bf),var(--accent,#22a7f0));border-color:transparent;color:#06121a}.app-modal-btn.primary:hover{filter:brightness(1.1)}.app-modal-btn.danger{background:rgba(248,81,73,0.16);color:#ff7b72;border-color:rgba(248,81,73,0.4)}.app-modal-btn.danger:hover{background:#dc2626;color:#fff}.app-modal-btn.ghost{background:rgba(255,255,255,0.06)}.app-modal-btn.ghost:hover{background:rgba(255,255,255,0.12)}@media(max-width:480px){.app-toast{left:16px;right:16px;min-width:0}.app-modal-act{flex-direction:column-reverse}.app-modal-btn{width:100%}}";
  var st = document.createElement("style"); st.textContent = css; document.head.appendChild(st);
  var CFG = { success:{ico:"bi-check-circle-fill",color:"var(--success,#34d399)",title:"Berhasil"}, error:{ico:"bi-x-circle-fill",color:"var(--danger,#f87171)",title:"Gagal"}, warning:{ico:"bi-exclamation-triangle-fill",color:"var(--warning,#fbbf24)",title:"Perhatian"} };
  function mapT(t){ return t==="error"?"error":(t==="warning"?"warning":"success"); }
  function esc(s){ return String(s==null?"":s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }
  function rmToast(t){ if(!t||!t.parentNode)return; t.classList.add("app-toast-leave"); setTimeout(function(){ if(t.parentNode) t.parentNode.removeChild(t); },260); }
  window.appNotify = function (msg, type) {
    type = mapT(type);
    document.querySelectorAll(".app-toast").forEach(rmToast);
    var c = CFG[type];
    var t = document.createElement("div");
    t.className = "app-toast";
    t.innerHTML = '<i class="bi ' + c.ico + ' app-toast-i" style="color:' + c.color + '"></i><div class="app-toast-b"><div class="app-toast-t">' + esc(c.title) + '</div><div class="app-toast-m">' + esc(msg) + '</div></div><button class="app-toast-x" onclick="this.closest(\'.app-toast\').classList.add(\'app-toast-leave\')"><i class="bi bi-x-lg"></i></button>';
    document.body.appendChild(t);
    setTimeout(function(){ if(t.parentNode) t.classList.add("app-toast-leave"); setTimeout(function(){ if(t.parentNode) t.parentNode.removeChild(t); },260); }, 4800);
  };
  /* Patch window.alert agar memakai UI custom (aman: tidak sinkron) */
  window.alert = function (msg) { window.appNotify(String(msg == null ? "" : msg), "error"); };

  /* Dialog konfirmasi → Promise<boolean> (pakai appConfirm di kode handler async) */
  window.appConfirm = function (msg, opts) {
    opts = opts || {};
    return new Promise(function (resolve) {
      var ov = document.createElement("div");
      ov.className = "app-modal-overlay";
      var danger = !!opts.danger;
      var ico = danger ? "bi-exclamation-triangle-fill" : "bi-question-circle-fill";
      var icoC = danger ? "var(--danger,#f87171)" : "var(--primary,#2dd4bf)";
      ov.innerHTML = '<div class="app-modal-box">' +
        '<div class="app-modal-i"><i class="bi ' + ico + '" style="color:' + icoC + '"></i></div>' +
        '<div class="app-modal-ttl">' + esc(opts.title || "Konfirmasi") + '</div>' +
        '<div class="app-modal-msg">' + esc(msg) + '</div>' +
        '<div class="app-modal-act">' +
        '<button class="app-modal-btn ghost" data-v="0">' + esc(opts.cancelText || "Batal") + '</button>' +
        '<button class="app-modal-btn ' + (danger ? "danger" : "primary") + '" data-v="1">' + esc(opts.okText || (danger ? "Ya, Lanjutkan" : "OK")) + '</button>' +
        '</div></div>';
      document.body.appendChild(ov);
      var done = false;
      function close(v) { if (done) return; done = true; if (ov.parentNode) ov.parentNode.removeChild(ov); resolve(!!v); }
      ov.querySelector('[data-v="0"]').onclick = function () { close(false); };
      ov.querySelector('[data-v="1"]').onclick = function () { close(true); };
      ov.addEventListener("click", function (e) { if (e.target === ov) close(false); });
      document.addEventListener("keydown", function h(k) { if (k.key === "Escape") { close(false); document.removeEventListener("keydown", h); } });
    });
  };

  /* Dialog prompt → Promise<string|null> (null jika batal) */
  window.appPrompt = function (msg, opts) {
    opts = opts || {};
    return new Promise(function (resolve) {
      var ov = document.createElement("div");
      ov.className = "app-modal-overlay";
      ov.innerHTML = '<div class="app-modal-box">' +
        '<div class="app-modal-i"><i class="bi bi-pencil-square" style="color:var(--primary,#2dd4bf)"></i></div>' +
        '<div class="app-modal-ttl">' + esc(opts.title || "Masukkan Data") + '</div>' +
        '<div class="app-modal-msg">' + esc(msg) + '</div>' +
        '<input class="app-modal-inp" value="' + esc(opts.value || "") + '" placeholder="' + esc(opts.placeholder || "") + '">' +
        '<div class="app-modal-act">' +
        '<button class="app-modal-btn ghost" data-v="0">' + esc(opts.cancelText || "Batal") + '</button>' +
        '<button class="app-modal-btn primary" data-v="1">' + esc(opts.okText || "Simpan") + '</button>' +
        '</div></div>';
      document.body.appendChild(ov);
      var inp = ov.querySelector(".app-modal-inp");
      var done = false;
      function close(v) { if (done) return; done = true; if (ov.parentNode) ov.parentNode.removeChild(ov); resolve(v); }
      ov.querySelector('[data-v="0"]').onclick = function () { close(null); };
      ov.querySelector('[data-v="1"]').onclick = function () { close(String(inp.value || "")); };
      ov.addEventListener("click", function (e) { if (e.target === ov) close(null); });
      inp.addEventListener("keydown", function (k) { if (k.key === "Enter") { close(String(inp.value || "")); } });
      setTimeout(function () { inp.focus(); }, 60);
    });
  };

  /* ── Intercept form dengan confirm bawaan → dialog custom ──
     Menangani: onsubmit="return confirm('...')" maupun data-confirm-msg.
     Karena async, kita hentikan submit asli lalu submit ulang setelah OK. */
  document.addEventListener("submit", function (e) {
    var f = e.target;
    if (!f || !f.tagName || f.tagName.toLowerCase() !== "form") return;
    if (f.__appConfirmHandled) return;
    var msg = f.getAttribute("data-confirm-msg");
    if (!msg) {
      // cari onsubmit inline dengan confirm(...) lalu ekstrak string pertama
      var attr = f.getAttribute("onsubmit") || "";
      var m = attr.match(/confirm\s*\(\s*(?:'([^']*)'|"([^"]*)")/);
      if (m) msg = m[1] || m[2] || "";
    }
    if (!msg) return;
    var danger = (f.getAttribute("data-confirm-danger") === "true");
    e.preventDefault();
    e.stopPropagation();
    f.__appConfirmHandled = true;
    window.appConfirm(String(msg), { danger: danger, okText: danger ? "Ya, Lanjutkan" : "OK" }).then(function (ok) {
      if (ok) {
        f.removeAttribute("onsubmit");
        f.removeAttribute("data-confirm-msg");
        // submit manual
        if (typeof f.submit === "function") f.submit(); else f.dispatchEvent(new Event("submit", { cancelable: true }));
      }
      f.__appConfirmHandled = false;
    });
  }, true);
})();