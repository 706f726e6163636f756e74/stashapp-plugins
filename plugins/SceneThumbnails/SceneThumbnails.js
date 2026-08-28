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
  const GALLERY_IDRE = /^\/galleries\/(\d+)(?:\/|$)/;
  const GALLERY_LIST_RE = /^\/(galleries|performers\/\d+\/galleries|studios\/\d+\/galleries|tags\/\d+\/galleries)\/?$/;
  const COL_OPTIONS = [12, 6, 4, 3, 2, 1];
  const TILE_GAP = 2;

  function isMobile() {
    return window.matchMedia("(max-width: 768px)").matches;
  }

  const VIDEO_EVENTS = ["timeupdate", "seeked", "loadedmetadata", "durationchange", "play"];

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
  let currentSceneId = null;
  let toolbarBtnEl = null;
  let drawerEl = null;
  let drawerContent = null;
  let sizesEl = null;
  let backdropEl = null;
  let drawerOpen = false;
  let drawerHistoryId = null;
  let nextHistoryId = 0;
  let isDismissingHistory = false;

  function isCurrentDrawerHistoryEntry() {
    const s = window.history.state;
    if (!s || typeof s !== "object") return false;
    const drawer = s.sceneThumbsDrawer;
    return drawer && drawer.id === drawerHistoryId;
  }

  function pushDrawerHistory() {
    const id = nextHistoryId + 1;
    nextHistoryId = id;
    drawerHistoryId = id;
    isDismissingHistory = false;
    try {
      window.history.pushState(
        Object.assign(
          {},
          typeof window.history.state === "object" && window.history.state !== null
            ? window.history.state
            : {},
          { sceneThumbsDrawer: { id } }
        ),
        "",
        window.location.href
      );
    } catch (e) { }
  }
  let drawerMaximized = false;
  let sceneData = null;
  let tileSets = [];
  let lastVideoTime = 0;
  let dataCache = new Map();
  let drawerSceneId = null;
  let drawerMode = null;
  let galleryData = null;
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
    if (!cw) return 80;
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
    if (dataCache.has(id)) return Promise.resolve(dataCache.get(id));
    return loadSceneData(id).then((data) => {
      dataCache.set(id, data);
      return data;
    });
  }

  function loadGalleryData(id) {
    return graphql(
      "query($id: ID!) { findImages(filter: { per_page: -1, sort: \"path\" }, image_filter: { galleries: { modifier: INCLUDES, value: [$id] } }) { images { id paths { thumbnail } visual_files { ... on ImageFile { width height } } } } }",
      { id }
    )
      .then((j) => {
        const images = j.data && j.data.findImages && j.data.findImages.images;
        if (!images || !images.length) return null;
        return images.map((img) => ({
          imageId: img.id,
          thumbnailUrl: img.paths.thumbnail,
          w: img.visual_files && img.visual_files[0] ? img.visual_files[0].width : 0,
          h: img.visual_files && img.visual_files[0] ? img.visual_files[0].height : 0,
        }));
      })
      .catch(() => null);
  }

  function getGalleryData(id) {
    const key = "gallery:" + id;
    if (dataCache.has(key)) return Promise.resolve(dataCache.get(key));
    return loadGalleryData(id).then((data) => {
      dataCache.set(key, data);
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
    if (!sceneData || !set.tiles.length) return;
    const cues = sceneData.cues;
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
    if (!sceneData) return;
    for (const set of tileSets) highlightSet(set, t);
  }

  function syncTime() {
    try {
      const player = window.PluginApi.utils.InteractiveUtils.getPlayer();
      const t = player
        ? player.currentTime()
        : currentVideo && currentVideo.currentTime;
      if (t) lastVideoTime = t;
    } catch (err) { }
    updateHighlight(lastVideoTime);
  }

  function attachListeners(video) {
    if (video === currentVideo) {
      syncTime();
      return;
    }
    if (currentVideo) {
      for (const evt of VIDEO_EVENTS) currentVideo.removeEventListener(evt, syncTime);
    }
    currentVideo = video || null;
    if (syncTimer) clearInterval(syncTimer);
    syncTimer = null;
    if (currentVideo) {
      for (const evt of VIDEO_EVENTS) currentVideo.addEventListener(evt, syncTime);
      syncTimer = setInterval(syncTime, 500);
    }
    syncTime();
  }

  function buildTiles(cont, data, sceneId) {
    const set = { tiles: [], highlighted: null };
    tileSets.push(set);
    sceneData = data;

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
          const player = window.PluginApi.utils.InteractiveUtils.getPlayer();
          if (player) {
            seekTo(t);
            closeDrawer();
            window.scrollTo({ top: 0, behavior: "smooth" });
          } else if (sceneId) {
            window.location.assign("/scenes/" + sceneId + "?t=" + Math.round(t));
          }
        };
      })(c.t));
      cont.appendChild(tile);
      set.tiles.push(tile);
    }
    updateHighlight(lastVideoTime);
  }

  function buildGalleryTiles(cont, images) {
    const set = { tiles: [], highlighted: null };
    tileSets.push(set);
    galleryData = images;

    const n = tilesPerRow();
    const sizeW = tileWidthForRow();
    const tileH = sizeW;
    const tileWidthPct = "calc((100% - " + TILE_GAP + "px * " + (n - 1) + ") / " + n + ")";

    for (let i = 0; i < images.length; i++) {
      const img = images[i];
      const tile = document.createElement("button");
      tile.type = "button";
      tile.title = img.imageId;
      tile.className = "scene-thumbs-tile-img";
      tile.style.cssText =
        "width:" + tileWidthPct +
        ";height:" + tileH +
        "px;max-width:" + tileWidthPct +
        ";flex:0 0 0%;flex-basis:" + tileWidthPct +
        ";cursor:pointer;position:relative;border:none;background:0 0;padding:0;overflow:hidden;" +
        (img.w && img.h ? "aspect-ratio:" + img.w + " / " + img.h + ";height:auto;" : "");
      const imgEl = document.createElement("img");
      imgEl.loading = "lazy";
      imgEl.src = img.thumbnailUrl;
      imgEl.style.cssText = "width:100%;height:100%;object-fit:cover;display:block;";
      tile.appendChild(imgEl);
      tile.addEventListener("click", (function (imageId) {
        return function () {
          window.location.assign("/images/" + imageId);
        };
      })(img.imageId));
      cont.appendChild(tile);
      set.tiles.push(tile);
    }
  }

  function ensureStyles() {
    if (document.getElementById("scene-thumbs-styles")) return;
    const s = document.createElement("style");
    s.id = "scene-thumbs-styles";
    s.textContent =
      ".scene-thumbs-backdrop{position:fixed;inset:0;z-index:1040;background:rgba(0,0,0,.2);opacity:0;pointer-events:none;transition:opacity .2s ease;}" +
      ".scene-thumbs-backdrop.open{opacity:1;pointer-events:auto;}" +
      ".scene-thumbs-drawer{position:fixed;left:0;right:0;bottom:0;z-index:1050;height:66vh;max-height:66vh;display:flex;flex-direction:column;overflow:hidden;background:#202b33;border-top:1px solid #394b59;border-radius:.5rem .5rem 0 0;box-shadow:0 -4px 16px rgba(0,0,0,.35);transform:translateY(105%);transition:transform .25s ease,height .25s ease,max-height .25s ease,border-radius .25s ease;}" +
      ".scene-thumbs-drawer.open{transform:translateY(0);}" +
      ".scene-thumbs-drawer.maximized{height:100vh;height:100dvh;max-height:100vh;max-height:100dvh;border-radius:0;}" +
      ".scene-thumbs-drawer .scene-thumbs-header{padding:0;display:flex;align-items:stretch;}" +
      ".scene-thumbs-drawer .scene-thumbs-header-btn{display:flex;flex:1;align-items:center;gap:.35rem;padding:.55rem 1rem;border-radius:.25rem;}" +
      ".scene-thumbs-drawer .scene-thumbs-header-btn .scene-thumbs-chevron{margin-left:auto;}" +
      ".scene-thumbs-drawer .scene-thumbs-toolbar{display:flex;justify-content:flex-end;align-items:center;margin-top:.5rem;padding:0 .5rem;}" +
      ".scene-thumbs-drawer .scene-thumbs-size-control{display:flex;align-items:center;gap:.5rem;margin:.5rem 0;}" +
      ".scene-thumbs-drawer .scene-thumbs-content{flex:1 1 auto;display:flex;flex-wrap:wrap;gap:2px;justify-content:flex-start;align-content:flex-start;min-height:0;overflow-y:auto;overscroll-behavior:contain;margin-top:.5rem;padding:.5rem .5rem 5rem .5rem;}" +
      ".scene-thumbs-tile-img img{width:100%;height:100%;object-fit:cover;display:block;}";
    document.head.appendChild(s);
  }

  function buildHeader(title) {
    const head = document.createElement("div");
    head.className = "scene-thumbs-header";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "minimal scene-thumbs-header-btn";
    btn.title = "Close";
    btn.appendChild(faIconNode(faLib.faGrip));
    const label = document.createElement("span");
    label.className = "scene-thumbs-header-label";
    label.textContent = title || "Scene Thumbnails";
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

    const maxBtn = document.createElement("button");
    maxBtn.type = "button";
    maxBtn.className = "minimal scene-thumbs-header-btn scene-thumbs-maximize";
    maxBtn.title = drawerMaximized ? "Restore" : "Maximize";
    maxBtn.style.flex = "0";
    const maxChevron = document.createElement("span");
    maxChevron.className = "scene-thumbs-chevron";
    maxChevron.appendChild(faIconNode(drawerMaximized ? faLib.faArrowsDownToLine : faLib.faArrowsUpToLine));
    maxBtn.appendChild(maxChevron);
    maxBtn.addEventListener("click", (e) => {
      e.preventDefault();
      toggleMaximize();
    });
    head.appendChild(maxBtn);

    return head;
  }

  function setHeaderCount(drawer, count) {
    if (!drawer) return;
    const label = drawer.querySelector(".scene-thumbs-header-label");
    if (label) label.textContent = label.textContent + " (" + count + ")";
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
    btn.appendChild(faIconNode(faLib.faGrip));
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

  function buildSizeInput() {
    let input;
    if (isMobile()) {
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
        const rawIndex = parseInt(input.value, 10);
        const index = isNaN(rawIndex) ? colIndex : Math.max(0, Math.min(COL_OPTIONS.length - 1, rawIndex));
        setColsPerRow(index);
      });
    } else {
      input = document.createElement("input");
      input.type = "range";
      input.min = "0";
      input.max = String(COL_OPTIONS.length - 1);
      input.step = "1";
      input.className = "zoom-slider";
      input.setAttribute("aria-label", "Thumbnails per row");
      updateSizeInput(input);
      input.addEventListener("input", () => {
        const rawIndex = parseInt(input.value, 10);
        const index = isNaN(rawIndex) ? colIndex : Math.max(0, Math.min(COL_OPTIONS.length - 1, rawIndex));
        setColsPerRow(index);
      });
    }
    return input;
  }

  function buildSizes() {
    const wrap = document.createElement("div");
    wrap.className = "scene-thumbs-toolbar";

    const control = document.createElement("div");
    control.className = "scene-thumbs-size-control";
    control.style.justifyContent = "flex-end";
    control.appendChild(buildSizeInput());

    wrap.appendChild(control);

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
    if (drawerEl) {
      drawerEl.classList.toggle("maximized", drawerMaximized);
      const btn = drawerEl.querySelector(".scene-thumbs-maximize");
      if (btn) {
        btn.title = drawerMaximized ? "Restore" : "Maximize";
        const chevron = btn.querySelector(".scene-thumbs-chevron");
        if (chevron) {
          chevron.innerHTML = "";
          chevron.appendChild(faIconNode(drawerMaximized ? faLib.faArrowsDownToLine : faLib.faArrowsUpToLine));
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
    if (!drawerContent) return;
    tileSets = [];
    drawerContent.innerHTML = "";
    if (drawerMode === "gallery" && galleryData) {
      buildGalleryTiles(drawerContent, galleryData);
    } else if (sceneData) {
      buildTiles(drawerContent, sceneData, drawerSceneId);
    }
  }

  function resizeTiles() {
    if (!tileSets.length) return;
    const n = tilesPerRow();
    const sizeW = tileWidthForRow();
    const tileWidthPct = "calc((100% - " + TILE_GAP + "px * " + (n - 1) + ") / " + n + ")";
    if (drawerMode === "gallery" && galleryData) {
      const tileH = sizeW;
      for (const set of tileSets) {
        for (let i = 0; i < set.tiles.length; i++) {
          const tile = set.tiles[i];
          const img = galleryData[i];
          tile.style.width = tileWidthPct;
          tile.style.maxWidth = tileWidthPct;
          tile.style.flexBasis = tileWidthPct;
          if (img && img.w && img.h) {
            tile.style.aspectRatio = img.w + " / " + img.h;
            tile.style.height = "auto";
          } else {
            tile.style.height = tileH + "px";
          }
        }
      }
      return;
    }
    if (!sceneData) return;
    const cues = sceneData.cues;
    const scale = sizeW / cues[0].w;
    const tileH = Math.max(1, Math.round(cues[0].h * scale));
    const bgSize =
      Math.round(sceneData.spriteW * scale) + "px " + Math.round(sceneData.spriteH * scale) + "px";
    for (const set of tileSets) {
      for (let i = 0; i < set.tiles.length; i++) {
        const tile = set.tiles[i];
        const c = cues[i];
        tile.style.width = tileWidthPct;
        tile.style.height = tileH + "px";
        tile.style.maxWidth = tileWidthPct;
        tile.style.flexBasis = tileWidthPct;
        tile.style.backgroundSize = bgSize;
        tile.style.backgroundPosition =
          -Math.round(c.x * scale) + "px " + -Math.round(c.y * scale) + "px";
      }
    }
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
    const headerH = drawerEl ? drawerEl.querySelector(".scene-thumbs-header")?.offsetHeight || 0 : 0;
    scroller.scrollTop += tr.top - cr.top - headerH - (cr.height - tr.height) / 2;
    scroller.scrollLeft += tr.left - cr.left - (cr.width - tr.width) / 2;
  }

  function openDrawer(skipHistory) {
    const wasOpen = drawerOpen;
    drawerOpen = true;
    document.body.style.overflow = "hidden";
    if (drawerEl) drawerEl.classList.add("open");
    if (backdropEl) backdropEl.classList.add("open");
    if (!wasOpen && !skipHistory) {
      pushDrawerHistory();
    }
    updateToggle();
    syncTime();
    renderTiles();
    scrollToHighlight();
  }

  function closeDrawer() {
    const wasOpen = drawerOpen;
    drawerOpen = false;
    document.body.style.overflow = "";
    if (drawerEl) drawerEl.classList.remove("open");
    if (backdropEl) backdropEl.classList.remove("open");
    if (wasOpen) {
      if (isCurrentDrawerHistoryEntry()) {
        if (isDismissingHistory) return;
        isDismissingHistory = true;
        try { window.history.back(); } catch (e) { isDismissingHistory = false; }
        return;
      }
    }
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
    if (drawerEl && drawerEl.isConnected && drawerSceneId === id) return;
    if (drawerEl) { drawerEl.remove(); drawerEl = null; }
    drawerSceneId = id;
    drawerMode = "scene";
    sceneData = null;
    galleryData = null;
    tileSets = [];
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

    if (data) {
      setHeaderCount(drawer, data.cues ? data.cues.length : 0);
      buildTiles(content, data, id);
      return;
    }

    const loading = document.createElement("div");
    loading.style.cssText = "padding:2rem;text-align:center;color:#999;";
    loading.textContent = "Loading thumbnails...";
    content.appendChild(loading);

    getData(id).then((d) => {
      if (loading.isConnected) loading.remove();
      if (!d) return;
      if (drawerSceneId !== id) return;
      setHeaderCount(drawer, d.cues ? d.cues.length : 0);
      tileSets = [];
      buildTiles(content, d, id);
      scrollToHighlight();
    });
  }

  function buildGalleryDrawer(id) {
    if (drawerEl && drawerEl.isConnected && drawerSceneId === id) return;
    if (drawerEl) { drawerEl.remove(); drawerEl = null; }
    drawerSceneId = id;
    drawerMode = "gallery";
    sceneData = null;
    galleryData = null;
    tileSets = [];
    ensureStyles();
    buildBackdrop();

    const drawer = document.createElement("div");
    drawer.id = "scene-thumbs-drawer";
    drawer.className = "scene-thumbs-section scene-thumbs-drawer" + (drawerMaximized ? " maximized" : "");

    const content = document.createElement("div");
    content.className = "scene-thumbs-content";

    drawer.appendChild(buildHeader("Gallery Images"));
    sizesEl = buildSizes();
    drawer.appendChild(sizesEl);
    drawer.appendChild(content);
    document.body.appendChild(drawer);

    drawerEl = drawer;
    drawerContent = content;

    const loading = document.createElement("div");
    loading.style.cssText = "padding:2rem;text-align:center;color:#999;";
    loading.textContent = "Loading thumbnails...";
    content.appendChild(loading);

    getGalleryData(id).then((images) => {
      if (loading.isConnected) loading.remove();
      if (!images) return;
      if (drawerSceneId !== id) return;
      setHeaderCount(drawer, images.length);
      tileSets = [];
      buildGalleryTiles(content, images);
    });
  }

  function teardown() {
    document.body.style.overflow = "";
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
    drawerMode = null;
    galleryData = null;
    sizesEl = null;
    drawerOpen = false;
    if (backdropEl) {
      try {
        backdropEl.remove();
      } catch (e) { }
    }
    backdropEl = null;
    tileSets = [];
    drawerHistoryId = null;
    isDismissingHistory = false;
    if (syncTimer) {
      clearInterval(syncTimer);
      syncTimer = null;
    }
    if (currentVideo) {
      for (const evt of VIDEO_EVENTS) currentVideo.removeEventListener(evt, syncTime);
      currentVideo = null;
    }
  }

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && drawerOpen) closeDrawer();
  });

  window.addEventListener("popstate", (e) => {
    const s = e.state;
    const historyId =
      s && typeof s === "object" && s.sceneThumbsDrawer
        ? s.sceneThumbsDrawer.id
        : undefined;
    if (drawerHistoryId !== undefined && historyId === drawerHistoryId) {
      if (!drawerOpen) {
        isDismissingHistory = false;
        openDrawer(true);
      }
      return;
    }
    if (drawerOpen) closeDrawer();
  });

  let lastIsMobile = isMobile();

  function onResize() {
    if (drawerOpen) {
      resizeTiles();
      const mobile = isMobile();
      if (mobile !== lastIsMobile) {
        lastIsMobile = mobile;
        const oldControl = sizesEl && sizesEl.querySelector(".scene-thumbs-size-control");
        if (oldControl) {
          const newInput = buildSizeInput();
          oldControl.textContent = "";
          oldControl.appendChild(newInput);
        }
      }
    }
  }
  window.addEventListener("resize", onResize);

  function init() {
    const m = location.pathname.match(IDRE);
    if (m) {
      const id = m[1];

      const player = window.PluginApi.utils.InteractiveUtils.getPlayer();
      if (!player) return;

      if (currentSceneId !== id) {
        teardown();
        currentSceneId = id;
      }

      const video = player.el().querySelector("video") ?? null;
      attachListeners(video);

      getData(id).then((data) => {
        if (!data) return;
        buildToolbarButton();
        buildDrawer(id, data);
      });
      return;
    }

    if (location.pathname === "/") {
      initScenesList();
      initGalleriesList();
      return;
    }

    if (/^\/(scenes|performers\/\d+\/scenes|studios\/\d+\/scenes|tags\/\d+\/scenes)\/?$/.test(location.pathname)) {
      initScenesList();
      return;
    }

    if (GALLERY_LIST_RE.test(location.pathname)) {
      initGalleriesList();
      return;
    }

    teardown();
  }

  function initScenesList() {
    document.querySelectorAll(".scene-card").forEach((card) => {
      if (card.querySelector(".scene-thumbs-popover")) return;
      const link = card.querySelector('a[href^="/scenes/"]');
      if (!link) return;
      const m = link.getAttribute("href").match(/\/scenes\/(\d+)/);
      if (!m) return;
      const id = m[1];
      const wrap = document.createElement("div");
      wrap.className = "scene-thumbs-popover";
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "minimal btn btn-secondary";
      btn.title = "Scene Thumbnails";
      btn.appendChild(faIconNode(faLib.faGrip));
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        lastVideoTime = 0;
        graphql("query($id: ID!){ findScene(id: $id) { resume_time files { duration } } }", { id })
          .then((r) => {
            const scene = r.data && r.data.findScene;
            if (scene && scene.resume_time > 0 && scene.files && scene.files[0]) {
              lastVideoTime = scene.resume_time;
            }
            buildDrawer(id);
            requestAnimationFrame(() => {
              requestAnimationFrame(() => {
                openDrawer();
              });
            });
          });
      });
      wrap.appendChild(btn);
      const popovers = card.querySelector(".card-popovers");
      if (popovers) popovers.appendChild(wrap);
    });
  }

  function initGalleriesList() {
    document.querySelectorAll(".gallery-card").forEach((card) => {
      if (card.querySelector(".scene-thumbs-popover")) return;
      const link = card.querySelector('a[href^="/galleries/"]');
      if (!link) return;
      const m = link.getAttribute("href").match(/\/galleries\/(\d+)/);
      if (!m) return;
      const id = m[1];
      const wrap = document.createElement("div");
      wrap.className = "scene-thumbs-popover";
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "minimal btn btn-secondary";
      btn.title = "Gallery Images";
      btn.appendChild(faIconNode(faLib.faGrip));
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        buildGalleryDrawer(id);
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            openDrawer();
          });
        });
      });
      wrap.appendChild(btn);
      const popovers = card.querySelector(".card-popovers");
      if (popovers) popovers.appendChild(wrap);
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
