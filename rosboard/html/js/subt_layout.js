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

  function relayout() { positionJoystick(); }
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
