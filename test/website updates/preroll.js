/* =====================================================
   NUTCRACKER GAMES: 5-second ad frame before a game opens
   Upload this file next to index.html and add this one line
   just before </body> in index.html (after the main script):
       <script src="preroll.js"></script>
   ===================================================== */
(function () {
  /* ---------- settings ---------- */
  var MODE = "house";   // "house"  = your own promo frame (works now, no approval needed)
                        // "adsense" = Google Ad Placement API (needs "H5 Games Ads" approval)
  var SECONDS = 5;      // length of the frame in "house" mode
  var EVERY_N_MINUTES = 0;  // 0 = show every time. 5 = at most once per 5 minutes.

  /* Your own sponsor / promo banners (optional).
     Leave the list empty to promote your other games instead.
     Example: { title: "Follow us on Instagram", text: "Daily game updates",
                img: "https://nutcrackergames.fun/promo.jpg", url: "https://instagram.com/yourname" } */
  var HOUSE_ADS = [];
  /* -------------------------------- */

  if (typeof openGame !== "function") return;     // main script not found
  var originalOpen = openGame;
  var busy = false, timer = 0;

  /* Google Ad Placement API hookup (only used in "adsense" mode) */
  if (MODE === "adsense") {
    window.adsbygoogle = window.adsbygoogle || [];
    window.adBreak = window.adConfig = function (o) { window.adsbygoogle.push(o); };
    window.adConfig({ preloadAdBreaks: "on", sound: "on" });
  }

  /* ---------- styles ---------- */
  var css = document.createElement("style");
  css.textContent =
    ".pre{position:fixed;inset:0;z-index:60;display:none;align-items:center;justify-content:center;padding:16px;background:rgba(0,0,0,.86)}" +
    ".pre.open{display:flex;animation:preIn .2s ease-out}" +
    "@keyframes preIn{from{opacity:0}to{opacity:1}}" +
    ".pre-card{width:100%;max-width:320px;padding:4px;background:#f2a51c;" +
      "clip-path:polygon(18px 0,100% 0,100% calc(100% - 18px),calc(100% - 18px) 100%,0 100%,0 18px)}" +
    ".pre-in{background:#0e0d0c;padding:12px 14px 14px;text-align:center;color:#f6f1e6;font-family:'Barlow',system-ui,sans-serif;" +
      "clip-path:polygon(15px 0,100% 0,100% calc(100% - 15px),calc(100% - 15px) 100%,0 100%,0 15px)}" +
    ".pre-top{display:flex;justify-content:space-between;align-items:center;font-size:.8rem;letter-spacing:.08em;text-transform:uppercase;color:#a99f88}" +
    ".pre-tag{background:#f6f1e6;color:#1a1a1a;font-weight:700;padding:2px 8px}" +
    ".pre-title{font-family:'Russo One','Arial Black',Impact,sans-serif;font-size:1.1rem;margin:8px 0 8px}" +
    ".pre-title b{color:#f2a51c}" +
    ".pre-ad{display:block;text-decoration:none;color:inherit}" +
    ".pre-art{position:relative;aspect-ratio:16/9;background:#000;border:2px solid #f2a51c;display:grid;place-items:center;overflow:hidden}" +
    ".pre-art img{position:absolute;inset:0;width:100%;height:100%;object-fit:contain}" +
    ".pre-art span{font-family:'Russo One','Arial Black',Impact,sans-serif;font-size:3.4rem;color:#f2a51c}" +
    ".pre-ad h3{font-family:'Russo One','Arial Black',Impact,sans-serif;font-weight:400;font-size:1rem;margin-top:8px}" +
    ".pre-ad p{color:#cfc8b8;font-size:.88rem;line-height:1.35}" +
    ".pre-bar{height:10px;margin-top:10px;border:2px solid #f2a51c;background:#000;overflow:hidden}" +
    ".pre-fill{height:100%;width:0;background:#f2a51c}" +
    ".pre-cancel{margin-top:8px;background:none;border:0;color:#a99f88;font:inherit;font-size:.85rem;cursor:pointer;text-decoration:underline}" +
    ".pre-cancel:hover{color:#ffcd5c}" +
    "@media (prefers-reduced-motion:reduce){.pre.open{animation:none}}";
  document.head.appendChild(css);

  /* ---------- markup ---------- */
  var pre = document.createElement("div");
  pre.className = "pre";
  pre.setAttribute("role", "dialog");
  pre.setAttribute("aria-modal", "true");
  pre.setAttribute("aria-label", "Ad before the game starts");
  pre.innerHTML =
    '<div class="pre-card"><div class="pre-in">' +
      '<div class="pre-top"><span class="pre-tag">Ad</span><span id="preSec"></span></div>' +
      '<div class="pre-title">Your game starts in <b id="preNum">5</b></div>' +
      '<div id="preAd"></div>' +
      '<div class="pre-bar"><div class="pre-fill" id="preFill"></div></div>' +
      '<button class="pre-cancel" id="preCancel" type="button">Cancel</button>' +
    '</div></div>';
  document.body.appendChild(pre);
  var elNum = pre.querySelector("#preNum"), elFill = pre.querySelector("#preFill"),
      elAd = pre.querySelector("#preAd"), elSec = pre.querySelector("#preSec");

  function pickAd(current) {
    if (HOUSE_ADS.length) return HOUSE_ADS[Math.floor(Math.random() * HOUSE_ADS.length)];
    var others = (typeof GAMES !== "undefined" ? GAMES : []).filter(function (x) { return x.id !== current.id; });
    if (!others.length) return null;
    var g = others[Math.floor(Math.random() * others.length)];
    return { title: "Also try " + g.title, text: g.blurb, img: g.thumb, url: "", letter: g.title.charAt(0).toUpperCase() };
  }

  function renderAd(ad) {
    elAd.innerHTML = "";
    if (!ad) return;
    var box = document.createElement(ad.url ? "a" : "div");
    box.className = "pre-ad";
    if (ad.url) { box.href = ad.url; box.target = "_blank"; box.rel = "noopener sponsored"; }
    var art = document.createElement("div"); art.className = "pre-art";
    if (ad.img) {
      var im = document.createElement("img"); im.alt = ""; im.src = ad.img;
      im.onerror = function () { im.remove(); art.innerHTML = "<span>" + (ad.letter || "") + "</span>"; };
      art.appendChild(im);
    } else {
      art.innerHTML = "<span>" + (ad.letter || ad.title.charAt(0)) + "</span>";
    }
    var h = document.createElement("h3"); h.textContent = ad.title;
    var p = document.createElement("p"); p.textContent = ad.text || "";
    box.appendChild(art); box.appendChild(h); box.appendChild(p);
    elAd.appendChild(box);
  }

  function hide() {
    clearInterval(timer);
    pre.classList.remove("open");
    document.body.style.overflow = "";
    busy = false;
  }

  function dueForAd() {
    if (!EVERY_N_MINUTES) return true;
    try {
      var last = parseInt(sessionStorage.getItem("ng_pre_last"), 10) || 0;
      return Date.now() - last > EVERY_N_MINUTES * 60000;
    } catch (e) { return true; }
  }
  function markShown() { try { sessionStorage.setItem("ng_pre_last", String(Date.now())); } catch (e) {} }

  /* ---------- the new openGame ---------- */
  window.openGame = function (g, updateHash) {
    if (busy) return;
    if (!dueForAd()) { originalOpen(g, updateHash); return; }
    busy = true; markShown();

    /* Google ad mode */
    if (MODE === "adsense") {
      var done = false;
      var go = function () { if (done) return; done = true; busy = false; originalOpen(g, updateHash); };
      setTimeout(go, 8000);                               // safety: never block the game
      try {
        window.adBreak({ type: "start", name: "start-" + g.id, adBreakDone: go });
      } catch (e) { go(); }
      return;
    }

    /* own frame mode */
    renderAd(pickAd(g));
    elSec.textContent = g.title;
    var left = SECONDS;
    elNum.textContent = left;
    elFill.style.transition = "none"; elFill.style.width = "0";
    pre.classList.add("open");
    document.body.style.overflow = "hidden";
    void elFill.offsetWidth;                              // restart the bar animation
    elFill.style.transition = "width " + SECONDS + "s linear"; elFill.style.width = "100%";
    pre.querySelector("#preCancel").focus();

    timer = setInterval(function () {
      left--;
      elNum.textContent = Math.max(left, 0);
      if (left <= 0) { hide(); originalOpen(g, updateHash); }
    }, 1000);
  };

  pre.querySelector("#preCancel").addEventListener("click", hide);
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && pre.classList.contains("open")) hide();
  });
})();
