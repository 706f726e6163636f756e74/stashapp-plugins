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

  const faLib = window.PluginApi.libraries.FontAwesomeSolid;

  let currentVideo = null;
  let syncTimer = null;
  let scrubberFor = null;
  let toolbarBtnEl = null;
  let drawerEl = null;
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
    const el = drawerContent || document.querySelector(".scene-thumbs-content");
    const cw = el ? el.clientWidth : 0;
    if (!cw || !scrubberData) return 80;
    const n = tilesPerRow();
    return Math.max(1, (cw - TILE_GAP * (n - 1)) / n);
  }

  const gqlTag = window.PluginApi.libraries.Apollo.gql;
  const apolloClient = window.PluginApi.utils.StashService.getClient();

  function graphql(query, variables) {
    return apolloClient.query({ query: gqlTag(query), variables })
      .then((r) => ({ data: r.data }));
  }

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = src;
    });
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
        if (!text || typeof window.WebVTT === "undefined") return null;
        const cues = [];
        const parser = new window.WebVTT.Parser(window, window.WebVTT.StringDecoder());
        parser.oncue = (cue) => {
          const m = cue.text.match(/#xywh=(\d+),(\d+),(\d+),(\d+)/i);
          if (m) {
            cues.push({ t: cue.startTime, x: +m[1], y: +m[2], w: +m[3], h: +m[4] });
          }
        };
        parser.parse(text);
        parser.flush();
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
    const player = window.PluginApi.utils.InteractiveUtils.getPlayer();
    if (!player) return;
    const doSeek = () => {
      try { player.currentTime(t); } catch (e) { }
      player.play().catch(() => { });
    };
    if (player.readyState() >= 1) {
      doSeek();
    } else {
      player.one("loadedmetadata", doSeek);
      player.play().catch(() => { });
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
      const player = window.PluginApi.utils.InteractiveUtils.getPlayer();
      const t = player
        ? player.currentTime()
        : currentVideo && currentVideo.currentTime;
      lastVideoTime = t || 0;
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
      const tile = document.createElement("button");
      tile.type = "button";
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
        ";cursor:pointer;position:relative;border:none;background:0 0;padding:0;font:inherit;" +
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
      timeEl.className = "scene-thumbs-item-time";
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
    if (document.getElementById("scene-thumbs-styles")) return;
    const s = document.createElement("style");
    s.id = "scene-thumbs-styles";
    s.textContent =
      ".scene-thumbs-backdrop{position:fixed;inset:0;z-index:1040;background:rgba(0,0,0,.2);opacity:0;pointer-events:none;transition:opacity .2s ease;}" +
      ".scene-thumbs-backdrop.open{opacity:1;pointer-events:auto;}" +
      ".scene-thumbs-drawer{position:fixed;left:0;right:0;bottom:0;z-index:1050;height:66vh;max-height:66vh;display:flex;flex-direction:column;overflow:hidden;background:#202b33;border-top:1px solid #394b59;border-radius:.5rem .5rem 0 0;box-shadow:0 -4px 16px rgba(0,0,0,.35);transform:translateY(105%);transition:transform .25s ease;}" +
      ".scene-thumbs-drawer.open{transform:translateY(0);}" +
      ".scene-thumbs-drawer.maximized{height:100vh;height:100dvh;max-height:100vh;max-height:100dvh;border-radius:0;}" +
      ".scene-thumbs-drawer.scene-thumbs-section{border-bottom:none;}" +
      ".scene-thumbs-drawer .scene-thumbs-header{padding:0;display:flex;align-items:stretch;}" +
      ".scene-thumbs-drawer .scene-thumbs-header-btn{display:flex;flex:1;align-items:center;gap:.35rem;padding:.55rem 1rem;border-radius:.25rem;}" +
      ".scene-thumbs-drawer .scene-thumbs-header-btn .scene-thumbs-chevron{margin-left:auto;}" +
      ".scene-thumbs-drawer .scene-thumbs-toolbar{display:flex;justify-content:space-between;align-items:center;margin-top:.5rem;padding:0 .5rem;}" +
      ".scene-thumbs-drawer .scene-thumbs-size-control{display:flex;align-items:center;gap:.5rem;}" +
      ".scene-thumbs-drawer .scene-thumbs-content{flex:1 1 auto;display:flex;flex-wrap:wrap;gap:2px;justify-content:flex-start;align-content:flex-start;min-height:0;overflow-y:auto;margin-top:.5rem;padding:.5rem .5rem 5rem .5rem;}";
    document.head.appendChild(s);
  }

  function buildHeader() {
    const head = document.createElement("div");
    head.className = "scene-thumbs-header";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "minimal scene-thumbs-header-btn";
    btn.title = "Close";
    btn.appendChild(faIconNode(faLib.faPanorama));
    const label = document.createElement("span");
    label.textContent = "Scene Thumbnails";
    const chevronIcon = document.createElement("span");
    chevronIcon.className = "scene-thumbs-chevron";
    chevronIcon.appendChild(faIconNode(faLib.faChevronDown));
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
    b.className = "scene-thumbs-backdrop";
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
    btn.className = "btn btn-secondary minimal scene-thumbs-toggle";
    btn.title = "Scene Thumbnails";
    btn.setAttribute("aria-label", "Scene Thumbnails");
    btn.appendChild(faIconNode(faLib.faPanorama));
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
    wrap.className = "scene-thumbs-toolbar";

    const control = document.createElement("div");
    control.className = "scene-thumbs-size-control";
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
    maxBtn.className = "btn btn-secondary btn-sm scene-thumbs-maximize";
    maxBtn.title = drawerMaximized ? "Restore" : "Maximize";
    maxBtn.appendChild(faIconNode(drawerMaximized ? faLib.faCompress : faLib.faExpand));
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
      const btn = sizesEl.querySelector(".scene-thumbs-maximize");
      if (btn) {
        btn.title = drawerMaximized ? "Restore" : "Maximize";
        btn.innerHTML = "";
        btn.appendChild(faIconNode(drawerMaximized ? faLib.faCompress : faLib.faExpand));
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
    if (!drawerContent || !scrubberData) return;
    tileSets = [];
    drawerContent.innerHTML = "";
    buildTiles(drawerContent, scrubberData);
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
    syncTime();
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
    drawer.id = "scene-thumbs-drawer";
    drawer.className = "scene-thumbs-section scene-thumbs-drawer" + (drawerMaximized ? " maximized" : "");

    const content = document.createElement("div");
    content.className = "scene-thumbs-content";

    drawer.appendChild(buildHeader());
    sizesEl = buildSizes();
    drawer.appendChild(sizesEl);
    drawer.appendChild(content);
    document.body.appendChild(drawer);

    drawerEl = drawer;
    drawerContent = content;
    buildTiles(content, data);
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

    const player = window.PluginApi.utils.InteractiveUtils.getPlayer();
    if (!player) return;

    if (scrubberFor !== id) {
      teardown();
      scrubberFor = id;
    }

    const video = player.el().querySelector("video") || player.el();
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
