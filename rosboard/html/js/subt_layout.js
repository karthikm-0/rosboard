"use strict";

// SubT layout: fixed-ratio widths for the camera + lidar cards (scales with
// viewport) and positions the joystick under the camera column. Rosboard's
// stock CSS gives every card the same responsive % width; this overrides that
// per-topic so the study view is consistent across monitors.
//
// Tagging: rosboard doesn't put the topic name on the card DOM, so we wrap
// Viewer.onCreate to add `data-topic="/..."` -- CSS then targets each card
// specifically. Upstream Viewer.js stays pristine.
(function () {
  var cfg = (window.SUBT && window.SUBT.layout) || {};
  if (cfg.enabled === false) return;

  // Wrap Viewer.onCreate to tag each card with its topic name.
  function patchViewer() {
    if (typeof Viewer === "undefined") return false;
    if (Viewer.prototype.__subtLayoutPatched) return true;
    Viewer.prototype.__subtLayoutPatched = true;
    function tagCard(viewer) {
      if (viewer.card && viewer.topicName) {
        viewer.card.attr("data-topic", viewer.topicName);
      }
    }
    var orig = Viewer.prototype.onCreate;
    Viewer.prototype.onCreate = function () {
      if (orig) orig.call(this);
      tagCard(this);
    };

    // Space3DViewer overrides onCreate without calling super.onCreate(), so
    // lidar cards would otherwise miss data-topic. Patch it too when present.
    if (typeof Space3DViewer !== "undefined" && !Space3DViewer.prototype.__subtLayoutPatched) {
      Space3DViewer.prototype.__subtLayoutPatched = true;
      var orig3d = Space3DViewer.prototype.onCreate;
      Space3DViewer.prototype.onCreate = function () {
        if (orig3d) orig3d.call(this);
        tagCard(this);
      };
    }
    return true;
  }
  if (!patchViewer()) {
    var n = 0;
    var iv = setInterval(function () {
      if (patchViewer() || ++n > 100) clearInterval(iv);
    }, 50);
  }

  // Per-topic widths. Fractions of viewport width (vw). Use whatever pair of
  // topics is in the whitelist; defaults match SubT's camera + preview cloud.
  var camTopic = cfg.cameraTopic || "/X1/front/image_raw";
  var lidTopic = cfg.lidarTopic || "/X1/points_preview";
  var camVw = cfg.cameraVw || 33;
  var lidVw = cfg.lidarVw || 33;
  var minPx = cfg.minCardPx || 320;

  var style = document.createElement("style");
  style.textContent =
    // Override rosboard's responsive .card sizing for these two topics only.
    // Uses vw (viewport-width) so cards scale with the browser, capped by a
    // minimum so they don't collapse below usable size on small screens.
    // CSS grid on .grid dictates both cell sizes -- cards can't disagree
    // because the grid enforces cell dimensions. This replaces the older
    // per-card width/height rules that lost to Space3DViewer's default sizing.
    // Grid handled below in the .grid selector (2 equal columns, one 4:3 row).
    // Cards inside just fill their cells.
    '.card{' +
      'width:100% !important; height:100% !important;' +
      'overflow:hidden;' +
      'box-sizing:border-box;' +
    '}' +
    // Hide the "ROSboard: <hostname>" label in the top bar -- irrelevant to the
    // participant. Override with cfg.showTitle: true to bring it back.
    (cfg.showTitle ? '' : '.mdl-layout-title{visibility:hidden !important;}') +
    // Hide the per-card topic-name row. Participants don't need "/X1/front/image_raw"
    // above their video. Override with cfg.showCardTitles: true to keep them.
    (cfg.showCardTitles ? '' : '.card-title{display:none !important;}') +
    // Center-align the card grid using flexbox instead of masonry's flush-left
    // layout. Cards flow left-to-right and wrap; whole row is centered so the
    // camera+lidar pair sits in the middle of the viewport regardless of screen
    // size. Overrides masonry's absolute positioning (which is disabled below).
    '.grid{' +
      'display:grid !important;' +
      // Two columns of identical width; height is a fixed proportion of the
      // COLUMN width so both cells are guaranteed the same rectangle.
      'grid-template-columns:repeat(2, ' + camVw + 'vw);' +
      'grid-auto-rows:calc(' + camVw + 'vw * 0.75);' +
      'gap:20pt;' +
      'justify-content:center;' +
      'align-items:start;' +
      'margin:20pt auto !important;' +
      'padding:0 !important;' +
    '}' +
    '.grid > *{' +
      'position:relative !important;' +
      'left:auto !important; top:auto !important;' +
      'margin:0 !important;' +
      'min-width:0; min-height:0;' +   // let grid clamp children
    '}';
  document.head.appendChild(style);

  // Position the joystick DIRECTLY below the cards, regardless of viewport
  // size. Rosboard's default put the joystick at `position:fixed; bottom:24px`
  // -- which pins it to the viewport bottom, so on tall/wide monitors it
  // ends up hundreds of pixels below the cards. This positions it so the
  // gap between the tallest card's bottom and the joystick's top stays
  // constant across ANY window size, and centered horizontally on the
  // camera+lidar pair.
  var JOY_GAP_PX = 12;

  // Force sizing via JS. CSS was losing to something (WebGL canvas intrinsic
  // sizing? rosboard layout hooks?). Setting inline styles directly + on every
  // resize guarantees identical width AND height on both cards regardless of
  // what else runs. Height derived from actual measured width * 0.75 -->
  // handles the min-width clamp too.
  // sizeCards removed: CSS grid on .grid dictates both cells' size (see the
  // grid-template-columns / grid-auto-rows rule above). Cards fill the cells
  // via `width:100%; height:100%`; the compass canvas keeps its own overlay
  // sizing since we no longer touch child canvases.

  // MJPEG override for the camera card. web_video_server (started by
  // session-entry.sh on port 8080 inside the container, mapped to 8080+slot
  // on the host) serves the raw camera as an HTTP MJPEG stream. We swap the
  // rosboard-created <img>.src to that stream and stop rosboard's
  // ImageViewer from overwriting it. This bypasses rosboard's
  // single-threaded Python WS serializer, which was CPU-pinning at ~90-100%
  // and causing bursty visual lag under the compressed camera load.
  function mjpegBaseUrl() {
    if (cfg.mjpegBaseUrl) return cfg.mjpegBaseUrl;
    // Same-origin via HTTPS: assume a video subdomain (e.g. video1.<domain>)
    // is set up in cloudflared ingress alongside sim1/ws1. If not, override
    // with cfg.mjpegBaseUrl in subt_config.js.
    if (location.protocol === "https:") {
      return location.protocol + "//" + location.hostname.replace(/^sim/, "video");
    }
    // Local: rosboard on 888N, web_video_server on 808N.
    var port = parseInt(location.port, 10);
    if (!isNaN(port) && port >= 8881 && port <= 8899) {
      return "http://" + location.hostname + ":" + (port - 800);
    }
    return "http://" + location.hostname + ":8080";
  }
  function mjpegUrlFor(topic) {
    // NOTE: do NOT encodeURIComponent the topic name -- web_video_server +
    // image_transport don't decode %2F before concatenating with the
    // transport suffix, so the subscription silently fails with
    // "Invalid topic name: %2FX1%2F.../compressed". Slashes in query
    // strings are legal per RFC 3986, so leave them raw.
    var baseTopic = topic.replace(/\/compressed$/, "");
    return mjpegBaseUrl() + "/stream?topic=" + baseTopic
           + "&type=mjpeg&default_transport=compressed";
  }

  // Create our OWN camera card. Doesn't wait for rosboard's ImageViewer,
  // doesn't share DOM with it, doesn't get its src overwritten. The card
  // carries data-topic so subt_compass.js finds it (compass anchor).
  function ensureCameraCard() {
    var grid = document.querySelector(".grid");
    if (!grid) return false;
    var existing = grid.querySelector('.card[data-topic="' + camTopic + '"]');
    if (existing && existing.__subtSynthetic) return true;
    if (existing) existing.remove();       // remove any rosboard-created one
    var card = document.createElement("div");
    card.className = "card";
    card.setAttribute("data-topic", camTopic);
    card.__subtSynthetic = true;
    card.style.position = "relative";
    card.style.overflow = "hidden";
    card.style.background = "#000";
    // Empty placeholder card. The actual MJPEG img is a body-level
    // position:fixed element (created below in installFixedCameraImg) that
    // reprojects onto this card's bounding box every frame. This exact
    // element pattern is the one that was proven to render live MJPEG in
    // the earlier "yellow box" test -- any variation (img inside card,
    // iframe, <video>+vp8/h264) failed in this specific browser+CF combo.
    // Put camera FIRST so grid order stays camera | lidar.
    if (grid.firstChild) grid.insertBefore(card, grid.firstChild);
    else grid.appendChild(card);
    return true;
  }
  var mjpegPoll = setInterval(function () {
    if (ensureCameraCard()) {
      clearInterval(mjpegPoll);
      // In case rosboard creates a second camera card later (from its
      // whitelist subscription), sweep it periodically for a short window.
      var sweepCount = 0;
      var sweep = setInterval(function () {
        document.querySelectorAll('.card[data-topic="' + camTopic + '"]').forEach(function (c) {
          if (!c.__subtSynthetic) c.remove();
        });
        if (++sweepCount > 40) clearInterval(sweep);   // ~10s
      }, 250);
    }
  }, 100);

  // Body-level fixed-position MJPEG img that overlays the camera
  // placeholder card. MJPEG-in-img has a memory-leak footgun: the browser
  // buffers the never-ending multipart response forever, growing to hundreds
  // of MB and then stalling. We cycle the img element every REFRESH_SEC to
  // force the browser to close the old connection + release its buffer.
  // Doubled buffer trick: create a hidden next img and wait for its first
  // frame before killing the old one, so there's no visible black flicker.
  // 5s → max ~25 MB buffered per cycle at 30 fps × ~180 KB/frame. Longer
  // intervals let the browser accumulate hundreds of MB and stall the tab.
  // Shorter (e.g. 2s) risks visible reconnect flicker.
  var REFRESH_SEC = 5;
  var fixedCameraImg = null;
  function makeImg() {
    var img = document.createElement("img");
    img.style.cssText =
      "position:fixed;z-index:1;object-fit:cover;background:#000;display:none;";
    // Cache-bust so the browser opens a fresh connection each cycle.
    img.src = mjpegUrlFor(camTopic).replace(/&type=[^&]+/, "&type=mjpeg")
              + "&_t=" + Date.now();
    document.body.appendChild(img);
    return img;
  }
  function ensureFixedCameraImg() {
    if (fixedCameraImg) return fixedCameraImg;
    fixedCameraImg = makeImg();
    return fixedCameraImg;
  }
  // Periodic recycle. Every REFRESH_SEC: spin up a new img, once it's
  // rendering, swap it in and destroy the old one. This closes the old
  // WS/HTTP connection and frees the buffered stream memory.
  setInterval(function () {
    if (!fixedCameraImg) return;
    var next = makeImg();
    // Wait until the new img has decoded at least one frame, then swap.
    // Fallback timer in case the load event never fires.
    var swapped = false;
    var doSwap = function () {
      if (swapped) return;
      swapped = true;
      var old = fixedCameraImg;
      fixedCameraImg = next;
      positionFixedCameraImg();
      // Killing src + removing releases the buffered stream.
      try { old.src = ""; old.remove(); } catch (e) {}
    };
    next.addEventListener("load", doSwap);
    setTimeout(doSwap, 3000);
  }, REFRESH_SEC * 1000);
  function positionFixedCameraImg() {
    var img = ensureFixedCameraImg();
    var placeholder = document.querySelector('.card[data-topic="' + camTopic + '"]');
    if (!placeholder) { img.style.display = "none"; return; }
    var r = placeholder.getBoundingClientRect();
    if (!r.width || !r.height) { img.style.display = "none"; return; }
    img.style.display = "block";
    img.style.left = r.left + "px";
    img.style.top = r.top + "px";
    img.style.width = r.width + "px";
    img.style.height = r.height + "px";
  }

  function positionJoystick() {
    var joy = document.getElementById("subt-joystick");
    if (!joy) return;
    var cards = document.querySelectorAll(".grid .card");
    if (!cards.length) return;
    var minLeft = Infinity, maxRight = -Infinity, maxBottom = 0;
    cards.forEach(function (c) {
      var b = c.getBoundingClientRect();
      if (!b.width) return;
      if (b.left < minLeft) minLeft = b.left;
      if (b.right > maxRight) maxRight = b.right;
      if (b.bottom > maxBottom) maxBottom = b.bottom;
    });
    if (!isFinite(minLeft) || !isFinite(maxRight)) return;
    var joyW = joy.offsetWidth || 170;
    var centerX = (minLeft + maxRight) / 2;
    joy.style.position = "fixed";
    joy.style.left = (centerX - joyW / 2) + "px";
    joy.style.top = (maxBottom + JOY_GAP_PX) + "px";
    joy.style.right = "auto";
    joy.style.bottom = "auto";
    joy.style.margin = "0";
  }

  function relayout() { positionJoystick(); positionFixedCameraImg(); }
  // Poll -- cards can appear late, rosboard re-renders, viewers swap type,
  // etc. Cheap: a few reads + inline style writes.
  setInterval(relayout, 250);
  window.addEventListener("resize", relayout);
  if (window.ResizeObserver) {
    var g = document.querySelector(".grid");
    if (g) new ResizeObserver(relayout).observe(g);
  }

  // Rosboard initializes masonry on .grid at DOMContentLoaded; masonry
  // absolutely-positions each card, which fights our flexbox centering.
  // Wait briefly for masonry to attach, then destroy it so the browser lays
  // the cards out with our CSS flex rules instead.
  function killMasonry() {
    if (typeof $ === "undefined") return false;
    var g = $(".grid");
    if (!g.length) return false;
    var inst = g.data("masonry");
    if (!inst) return false;
    g.masonry("destroy");
    return true;
  }
  if (!killMasonry()) {
    var m = 0;
    var mv = setInterval(function () {
      if (killMasonry() || ++m > 100) clearInterval(mv);
    }, 50);
  }
})();
