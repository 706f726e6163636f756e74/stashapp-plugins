/* Scene Thumbnails - a thumbnail grid for Stash scene pages.
 *
 * Portions (the scene-sprite/WebVTT data pipeline) are
 * derived from Mosaic Poster
 * (https://discourse.stashapp.cc/t/mosaic-poster/12358), part of
 * stashapp/CommunityScripts (https://github.com/stashapp/CommunityScripts),
 * licensed under the GNU Affero General Public License v3.0. Modified
 * 2026-08-06: the poster overlay was replaced with a scrubber shown in a
 * drawer that hovers above the bottom of the scene page, styled like the
 * Stash collapsible sidebar sections, with a live playback highlight and a
 * thumbnail-size toggle and a full-height toggle. The drawer is opened via a
 * film icon button in the scene page toolbar (next to the organized and
 * operations controls) and dismissed by clicking a tile, the backdrop, the
 * header, or Escape. The thumbnail grid fills the width
  * of the drawer; the slider selects how many thumbnails sit per row (1, 2, 3, 4,
  * 6, or 12 — divisors of 12 so each row fills completely; left-to-right the
  * slider goes small-to-large, i.e. 12 → 1 per row) using the gallery's
 * zoom-slider component, with a constant 2px gutter between tiles.
 *
 * This file is licensed under the GNU Affero General Public License v3.0.
 * See LICENSE for the full text.
 */
(() => {
  "use strict";

  const IDRE = /^\/scenes\/(\d+)(?:\/|$)/;
  const COL_OPTIONS = [12, 6, 4, 3, 2, 1];
  const TILE_GAP = 2;
  const COL_OPTION_COUNT = COL_OPTIONS.length;

  function faIconNode(iconDef) {
    const [width, height, , , pathData] = iconDef.icon;
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 " + width + " " + height);
    svg.classList.add("svg-inline--fa", "fa-icon");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("fill", "currentColor");
    path.setAttribute("d", pathData);
    svg.appendChild(path);
    return svg;
  }

  const faLib =
    (window.PluginApi && window.PluginApi.libraries && window.PluginApi.libraries.FontAwesomeSolid) || null;

  let currentVideo = null;
  let syncTimer = null;
  let scrubberFor = null;
  let toolbarBtnEl = null;
  let drawerEl = null;
  let drawerTiles = null;
  let drawerContent = null;
  let sizesEl = null;
  let backdropEl = null;
  let drawerOpen = false;
  let drawerMaximized = false;
  let scrubberData = null;
  let tileSets = [];
  let lastVideoTime = 0;
  let dataCache = null;
  let colIndex = 4;

  try {
    const stored = localStorage.getItem("sceneThumbnails.colsPerRow");
    const val = parseInt(stored, 10);
    if (stored != null && !isNaN(val)) {
      const idx = COL_OPTIONS.indexOf(val);
      if (idx !== -1) colIndex = idx;
    }
  } catch (e) { }

  try {
    drawerMaximized = localStorage.getItem("sceneThumbnails.maximized") === "1";
  } catch (e) { }

  function tilesPerRow() {
    return COL_OPTIONS[colIndex];
  }

  function tileWidthForRow() {
    const el = drawerTiles || document.querySelector(".full-scrubber-tiles");
    const cw = el ? el.clientWidth : 0;
    if (!cw || !scrubberData) return 80;
    const n = tilesPerRow();
    return Math.max(1, (cw - TILE_GAP * (n - 1)) / n);
  }

  function graphql(query, variables) {
    return fetch("/graphql", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ query, variables }),
    }).then((r) => r.json());
  }

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = src;
    });
  }

  function vttSeconds(s) {
    const parts = String(s).trim().split(":");
    let sec = 0;
    for (const p of parts) sec = sec * 60 + parseFloat(p || 0);
    return Number.isNaN(sec) ? 0 : sec;
  }

  function fmt(t) {
    t = Math.max(0, Math.floor(t));
    const s = t % 60;
    const m = Math.floor(t / 60) % 60;
    const h = Math.floor(t / 3600);
    return (h ? h + ":" : "") + String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0");
  }

  function fetchCues(vttUrl) {
    return fetch(vttUrl, { credentials: "same-origin" })
      .then((r) => (r.ok ? r.text() : ""))
      .then((text) => {
        const cues = [];
        const lines = text.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          const arrow = lines[i].indexOf("-->");
          if (arrow < 0) continue;
          const start = vttSeconds(lines[i].slice(0, arrow));
          for (
            let j = i + 1;
            j < lines.length && lines[j].indexOf("-->") < 0;
            j++
          ) {
            const m = lines[j].match(/#xywh=(\d+),(\d+),(\d+),(\d+)/);
            if (m) {
              cues.push({ t: start, x: +m[1], y: +m[2], w: +m[3], h: +m[4] });
              break;
            }
          }
        }
        return cues.length ? cues : null;
      });
  }

  function loadSceneData(id) {
    return graphql("query($id: ID!){ findScene(id: $id) { paths { sprite vtt } } }", {
      id,
    })
      .then((j) => {
        const scene = j.data && j.data.findScene;
        const paths = scene && scene.paths;
        return paths && paths.sprite ? paths : null;
      })
      .then((paths) => {
        if (!paths) return null;
        const vttUrl =
          paths.vtt || paths.sprite.replace(/_sprite\.jpg(\?.*)?$/, "_thumbs.vtt");
        return Promise.all([fetchCues(vttUrl), loadImage(paths.sprite)]).then(
          ([cues, img]) =>
            cues
              ? {
                cues,
                img,
                spriteUrl: paths.sprite,
                spriteW: img.naturalWidth,
                spriteH: img.naturalHeight,
              }
              : null
        );
      })
      .catch(() => null);
  }

  function getData(id) {
    if (dataCache && dataCache.id === id) return Promise.resolve(dataCache.data);
    return loadSceneData(id).then((data) => {
      dataCache = { id, data };
      return data;
    });
  }

  function seekTo(t) {
    const playerEl = document.querySelector(".video-js");
    const video =
      (playerEl &&
        (playerEl.querySelector("video") || playerEl.querySelector(".vjs-tech"))) ||
      document.querySelector(".vjs-tech") ||
      document.querySelector("video");
    if (!video) return;
    const doSeek = () => {
      try {
        video.currentTime = t;
      } catch (e) { }
      video.play().catch(() => { });
    };
    if (video.readyState >= 1) {
      doSeek();
    } else {
      video.addEventListener("loadedmetadata", doSeek, { once: true });
      video.play().catch(() => { });
    }
  }

  function highlightSet(set, t) {
    if (!scrubberData || !set.tiles.length) return;
    const cues = scrubberData.cues;
    let idx = 0;
    for (let i = 0; i < cues.length; i++) {
      if (cues[i].t <= t) idx = i;
      else break;
    }
    if (idx === set.highlighted) return;
    if (set.highlighted != null && set.tiles[set.highlighted]) {
      const prev = set.tiles[set.highlighted];
      prev.style.outline = "";
      prev.style.zIndex = "";
    }
    if (set.tiles[idx]) {
      const cur = set.tiles[idx];
      cur.style.outline = "4px solid #4a9eff";
      cur.style.zIndex = "2";
    }
    set.highlighted = idx;
  }

  function updateHighlight(t) {
    if (!scrubberData) return;
    for (const set of tileSets) highlightSet(set, t);
  }

  function syncTime() {
    try {
      lastVideoTime = (currentVideo && currentVideo.currentTime) || 0;
    } catch (err) {
      lastVideoTime = 0;
    }
    updateHighlight(lastVideoTime);
  }

  function onTime() {
    syncTime();
  }

  function attachListeners(video) {
    if (video === currentVideo) {
      syncTime();
      return;
    }
    if (currentVideo) {
      currentVideo.removeEventListener("timeupdate", onTime);
      currentVideo.removeEventListener("seeked", onTime);
      currentVideo.removeEventListener("loadedmetadata", onTime);
      currentVideo.removeEventListener("durationchange", onTime);
      currentVideo.removeEventListener("play", onTime);
    }
    currentVideo = video || null;
    if (syncTimer) clearInterval(syncTimer);
    syncTimer = null;
    if (currentVideo) {
      currentVideo.addEventListener("timeupdate", onTime);
      currentVideo.addEventListener("seeked", onTime);
      currentVideo.addEventListener("loadedmetadata", onTime);
      currentVideo.addEventListener("durationchange", onTime);
      currentVideo.addEventListener("play", onTime);
      syncTimer = setInterval(syncTime, 500);
    }
    syncTime();
  }

  function buildTiles(cont, data) {
    const set = { tiles: [], highlighted: null };
    tileSets.push(set);
    scrubberData = data;

    const cues = data.cues;
    const n = tilesPerRow();
    const sizeW = tileWidthForRow();
    const scale = sizeW / cues[0].w;
    const tileH = Math.max(1, Math.round(cues[0].h * scale));
    const bgSize =
      Math.round(data.spriteW * scale) + "px " + Math.round(data.spriteH * scale) + "px";
    const tileWidthPct = "calc((100% - " + TILE_GAP + "px * " + (n - 1) + ") / " + n + ")";

    for (let i = 0; i < cues.length; i++) {
      const c = cues[i];
      const nextStart = i + 1 < cues.length ? cues[i + 1].t : c.t + (c.t - (cues[i - 1]?.t || 0)) || 0;
      const startStr = fmt(c.t);
      const endStr = fmt(nextStart);
      const tile = document.createElement("div");
      tile.title = startStr + " - " + endStr;
      tile.style.cssText =
        "width:" +
        tileWidthPct +
        ";height:" +
        tileH +
        "px;max-width:" +
        tileWidthPct +
        ";flex:0 0 0%;flex-basis:" +
        tileWidthPct +
        ";cursor:pointer;position:relative;" +
        "background-image:url('" +
        data.spriteUrl +
        "');" +
        "background-size:" +
        bgSize +
        ";" +
        "background-position:" +
        -Math.round(c.x * scale) +
        "px " +
        -Math.round(c.y * scale) +
        "px;";
      const timeEl = document.createElement("div");
      timeEl.className = "scrubber-item-time";
      timeEl.textContent = startStr + " - " + endStr;
      timeEl.style.cssText =
        "color:white;font-size:10px;position:absolute;bottom:0;left:0;right:0;" +
        "text-align:center;text-shadow:1px 1px black;pointer-events:none;";
      tile.appendChild(timeEl);
      tile.addEventListener("click", (function (t) {
        return function () {
          seekTo(t);
          closeDrawer();
          window.scrollTo({ top: 0, behavior: "smooth" });
        };
      })(c.t));
      cont.appendChild(tile);
      set.tiles.push(tile);
    }
    updateHighlight(lastVideoTime);
  }

  function ensureStyles() {
    if (document.getElementById("full-scrubber-styles")) return;
    const s = document.createElement("style");
    s.id = "full-scrubber-styles";
    s.textContent =
      ".full-scrubber-backdrop{position:fixed;inset:0;z-index:1040;background:rgba(0,0,0,.2);opacity:0;pointer-events:none;transition:opacity .2s ease;}" +
      ".full-scrubber-backdrop.open{opacity:1;pointer-events:auto;}" +
      ".full-scrubber-drawer{position:fixed;left:0;right:0;bottom:0;z-index:1050;height:66vh;max-height:66vh;display:flex;flex-direction:column;overflow:hidden;background:#202b33;border-top:1px solid #394b59;border-radius:.5rem .5rem 0 0;box-shadow:0 -4px 16px rgba(0,0,0,.35);transform:translateY(105%);transition:transform .25s ease;}" +
      ".full-scrubber-drawer.open{transform:translateY(0);}" +
      ".full-scrubber-drawer.maximized{height:100vh;height:100dvh;max-height:100vh;max-height:100dvh;border-radius:0;}" +
      ".full-scrubber-drawer.sidebar-section{border-bottom:none;}" +
      ".full-scrubber-drawer .collapse-header{padding:0;}" +
      ".full-scrubber-drawer .collapse,.full-scrubber-drawer .collapsing{padding-top:0;}" +
      ".full-scrubber-drawer .collapse-button{display:inline-flex;align-items:center;gap:.35rem;padding:.55rem 1rem;border-radius:.25rem;}" +
      ".full-scrubber-drawer .collapse-button .full-scrubber-chevron{margin-left:auto;}" +
      ".full-scrubber-drawer .full-scrubber-sizes{display:flex;justify-content:space-between;align-items:center;margin-top:.5rem;padding:0 .5rem;}" +
      ".full-scrubber-drawer .full-scrubber-size-control{display:flex;align-items:center;gap:.5rem;}" +
      ".full-scrubber-drawer .full-scrubber-content{flex:1 1 auto;min-height:0;overflow-y:auto;margin-top:.5rem;padding-bottom:5rem;}" +
      ".full-scrubber-tiles{display:flex;flex-wrap:wrap;gap:2px;justify-content:flex-start;overflow-y:auto;padding:0 .5rem .5rem;}";
    document.head.appendChild(s);
  }

  function buildHeader() {
    const head = document.createElement("div");
    head.className = "collapse-header";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "minimal collapse-button";
    btn.title = "Close";
    if (faLib && faLib.faTable) {
      btn.appendChild(faIconNode(faLib.faTable));
    } else {
      const fallback = document.createElement("i");
      fallback.className = "fas fa-table fa-fw";
      btn.appendChild(fallback);
    }
    const label = document.createElement("span");
    label.textContent = "Scene Thumbnails";
    const chevronIcon = document.createElement("span");
    chevronIcon.className = "full-scrubber-chevron";
    if (faLib && faLib.faChevronDown) {
      chevronIcon.appendChild(faIconNode(faLib.faChevronDown));
    } else {
      chevronIcon.innerHTML = '<i class="fas fa-chevron-down fa-fw"></i>';
    }
    btn.appendChild(label);
    btn.appendChild(chevronIcon);
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      closeDrawer();
    });
    head.appendChild(btn);
    return head;
  }

  function buildBackdrop() {
    if (backdropEl && backdropEl.isConnected) return;
    const b = document.createElement("div");
    b.className = "full-scrubber-backdrop";
    b.addEventListener("click", closeDrawer);
    document.body.appendChild(b);
    backdropEl = b;
  }

  function buildToolbarButton() {
    if (toolbarBtnEl && toolbarBtnEl.isConnected) return;
    const toolbar = document.querySelector(".scene-tabs .scene-toolbar");
    if (!toolbar) return;
    const groups = toolbar.querySelectorAll(".scene-toolbar-group");
    const group = groups[groups.length - 1];
    if (!group) return;
    const wrap = document.createElement("span");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn btn-secondary minimal full-scrubber-toolbar-btn";
    btn.title = "Scene Thumbnails";
    btn.setAttribute("aria-label", "Scene Thumbnails");
    if (faLib && faLib.faTable) {
      btn.appendChild(faIconNode(faLib.faTable));
    } else {
      const fallback = document.createElement("i");
      fallback.className = "fas fa-table fa-fw";
      btn.appendChild(fallback);
    }
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      toggleDrawer();
    });
    wrap.appendChild(btn);
    const opsBtn = group.querySelector("#operation-menu");
    const opsSpan = opsBtn ? opsBtn.closest("span") : null;
    if (opsSpan && opsSpan.parentNode === group) group.insertBefore(wrap, opsSpan);
    else group.appendChild(wrap);
    toolbarBtnEl = btn;
    updateToggle();
  }

  function buildSizes() {
    const wrap = document.createElement("div");
    wrap.className = "full-scrubber-sizes";

    const control = document.createElement("div");
    control.className = "full-scrubber-size-control";
    control.style.justifyContent = "flex-end";

    const isMobile = window.matchMedia("(max-width: 768px)").matches;
    let input;
    if (isMobile) {
      input = document.createElement("select");
      input.className = "btn-secondary form-control";
      input.style.width = "120px";
      input.setAttribute("aria-label", "Thumbnails per row");
      COL_OPTIONS.forEach((cols, i) => {
        const opt = document.createElement("option");
        opt.value = String(i);
        opt.textContent = `${cols} per row`;
        input.appendChild(opt);
      });
      updateSizeSelect(input);
      input.addEventListener("change", () => {
        const v = parseInt(input.value, 10);
        const n = isNaN(v) ? 2 : Math.max(0, Math.min(COL_OPTION_COUNT - 1, v));
        setColsPerRow(n);
      });
      control.appendChild(input);
    } else {
      input = document.createElement("input");
      input.type = "range";
      input.min = "0";
      input.max = String(COL_OPTION_COUNT - 1);
      input.step = "1";
      input.className = "zoom-slider";
      input.setAttribute("aria-label", "Thumbnails per row");
      updateSizeInput(input);
      input.addEventListener("input", () => {
        const v = parseInt(input.value, 10);
        const n = isNaN(v) ? 2 : Math.max(0, Math.min(COL_OPTION_COUNT - 1, v));
        setColsPerRow(n);
      });
      control.appendChild(input);
    }

    wrap.appendChild(control);

    const maxBtn = document.createElement("button");
    maxBtn.type = "button";
    maxBtn.className = "btn btn-secondary btn-sm full-scrubber-maximize";
    maxBtn.title = drawerMaximized ? "Restore" : "Maximize";
    if (faLib) {
      const iconDef = drawerMaximized ? faLib.faCompress : faLib.faExpand;
      if (iconDef) maxBtn.appendChild(faIconNode(iconDef));
    }
    if (!maxBtn.firstChild) {
      const fallback = document.createElement("i");
      fallback.className = "fas " + (drawerMaximized ? "fa-compress" : "fa-expand") + " fa-fw";
      maxBtn.appendChild(fallback);
    }
    maxBtn.addEventListener("click", (e) => {
      e.preventDefault();
      toggleMaximize();
    });
    wrap.appendChild(maxBtn);

    return wrap;
  }

  function updateSizeInput(input) {
    input.value = String(colIndex);
  }

  function updateSizeSelect(select) {
    select.value = String(colIndex);
  }

  function toggleMaximize() {
    drawerMaximized = !drawerMaximized;
    try {
      localStorage.setItem("sceneThumbnails.maximized", drawerMaximized ? "1" : "0");
    } catch (e) { }
    if (drawerEl) drawerEl.classList.toggle("maximized", drawerMaximized);
    if (sizesEl) {
      const btn = sizesEl.querySelector(".full-scrubber-maximize");
      if (btn) {
        btn.title = drawerMaximized ? "Restore" : "Maximize";
        btn.innerHTML = "";
        if (faLib) {
          const iconDef = drawerMaximized ? faLib.faCompress : faLib.faExpand;
          if (iconDef) btn.appendChild(faIconNode(iconDef));
        }
        if (!btn.firstChild) {
          const fallback = document.createElement("i");
          fallback.className = "fas " + (drawerMaximized ? "fa-compress" : "fa-expand") + " fa-fw";
          btn.appendChild(fallback);
        }
      }
    }
  }

  function setColsPerRow(n) {
    if (n === colIndex) return;
    colIndex = n;
    try {
      localStorage.setItem("sceneThumbnails.colsPerRow", String(COL_OPTIONS[colIndex]));
    } catch (e) { }
    if (sizesEl) {
      const input = sizesEl.querySelector("input[type=range], select.btn-secondary.form-control");
      if (input) {
        if (input.tagName === "SELECT") updateSizeSelect(input);
        else updateSizeInput(input);
      }
    }
    renderTiles();
  }

  function renderTiles() {
    if (!drawerTiles || !scrubberData) return;
    tileSets = [];
    drawerTiles.innerHTML = "";
    buildTiles(drawerTiles, scrubberData);
  }

  function scrollToHighlight() {
    if (!drawerContent) return;
    const scroller = drawerContent;
    let tile = null;
    for (const set of tileSets) {
      if (set.highlighted != null && set.tiles[set.highlighted]) {
        tile = set.tiles[set.highlighted];
        break;
      }
    }
    if (!tile) return;
    const cr = scroller.getBoundingClientRect();
    const tr = tile.getBoundingClientRect();
    scroller.scrollTop += tr.top - cr.top - (cr.height - tr.height) / 2;
    scroller.scrollLeft += tr.left - cr.left - (cr.width - tr.width) / 2;
  }

  function openDrawer() {
    drawerOpen = true;
    if (drawerEl) drawerEl.classList.add("open");
    if (backdropEl) backdropEl.classList.add("open");
    updateToggle();
    updateHighlight(lastVideoTime);
    renderTiles();
    scrollToHighlight();
  }

  function closeDrawer() {
    drawerOpen = false;
    if (drawerEl) drawerEl.classList.remove("open");
    if (backdropEl) backdropEl.classList.remove("open");
    updateToggle();
  }

  function toggleDrawer() {
    if (drawerOpen) closeDrawer();
    else openDrawer();
  }

  function updateToggle() {
    if (!toolbarBtnEl) return;
    toolbarBtnEl.classList.toggle("active", drawerOpen);
    toolbarBtnEl.title = drawerOpen ? "Hide Scene Thumbnails" : "Scene Thumbnails";
    toolbarBtnEl.setAttribute("aria-pressed", String(drawerOpen));
  }

  function buildDrawer(id, data) {
    if (drawerEl && drawerEl.isConnected) return;
    ensureStyles();
    buildBackdrop();

    const drawer = document.createElement("div");
    drawer.id = "full-scrubber-drawer";
    drawer.className = "sidebar-section full-scrubber-drawer" + (drawerMaximized ? " maximized" : "");

    const content = document.createElement("div");
    content.className = "collapse show full-scrubber-content";

    const tiles = document.createElement("div");
    tiles.className = "full-scrubber-tiles";
    content.appendChild(tiles);

    drawer.appendChild(buildHeader());
    sizesEl = buildSizes();
    drawer.appendChild(sizesEl);
    drawer.appendChild(content);
    document.body.appendChild(drawer);

    drawerEl = drawer;
    drawerTiles = tiles;
    drawerContent = content;
    buildTiles(tiles, data);
  }

  function teardown() {
    if (toolbarBtnEl) {
      const toolbarWrap = toolbarBtnEl.parentNode;
      try {
        toolbarBtnEl.remove();
      } catch (e) { }
      if (toolbarWrap && toolbarWrap.tagName === "SPAN" && !toolbarWrap.firstChild) {
        try {
          toolbarWrap.remove();
        } catch (e) { }
      }
    }
    toolbarBtnEl = null;
    if (drawerEl) {
      try {
        drawerEl.remove();
      } catch (e) { }
    }
    drawerEl = null;
    drawerTiles = null;
    drawerContent = null;
    sizesEl = null;
    drawerOpen = false;
    if (backdropEl) {
      try {
        backdropEl.remove();
      } catch (e) { }
    }
    backdropEl = null;
    tileSets = [];
    if (syncTimer) {
      clearInterval(syncTimer);
      syncTimer = null;
    }
    if (currentVideo) {
      currentVideo.removeEventListener("timeupdate", onTime);
      currentVideo.removeEventListener("seeked", onTime);
      currentVideo.removeEventListener("loadedmetadata", onTime);
      currentVideo.removeEventListener("durationchange", onTime);
      currentVideo.removeEventListener("play", onTime);
      currentVideo = null;
    }
  }

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && drawerOpen) closeDrawer();
  });

  let lastIsMobile = window.matchMedia("(max-width: 768px)").matches;

  function onResize() {
    if (drawerOpen) {
      renderTiles();
      const isMobile = window.matchMedia("(max-width: 768px)").matches;
      if (isMobile !== lastIsMobile) {
        lastIsMobile = isMobile;
        if (sizesEl && sizesEl.parentNode) {
          const newControl = buildSizes();
          sizesEl.replaceWith(newControl);
          sizesEl = newControl;
        }
      }
    }
  }
  window.addEventListener("resize", onResize);

  function init() {
    const m = location.pathname.match(IDRE);
    if (!m) {
      teardown();
      return;
    }
    const id = m[1];

    const playerEl = document.querySelector(".video-js");
    if (!playerEl) return;

    if (scrubberFor !== id) {
      teardown();
      scrubberFor = id;
    }

    const video = playerEl.querySelector("video") || playerEl.querySelector(".vjs-tech");
    attachListeners(video);

    getData(id).then((data) => {
      if (!data) return;
      buildToolbarButton();
      buildDrawer(id, data);
    });
  }

  let timer = null;
  function schedule() {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      init();
    }, 100);
  }

  const obs = new MutationObserver(schedule);
  obs.observe(document.documentElement, { childList: true, subtree: true });
  schedule();
})();
