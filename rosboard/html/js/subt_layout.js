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
    '.card[data-topic="' + camTopic + '"]{' +
      'width:calc(' + camVw + 'vw - 40pt) !important;' +
      'min-width:' + minPx + 'px !important;' +
      'aspect-ratio:4/3;' +           // matches camera image ratio
    '}' +
    '.card[data-topic="' + lidTopic + '"]{' +
      'width:calc(' + lidVw + 'vw - 40pt) !important;' +
      'min-width:' + minPx + 'px !important;' +
      'aspect-ratio:4/3;' +           // same shape so both cards match height
    '}' +
    // Stretch the lidar canvas to fill its card (Space3DViewer defaults to a
    // fixed square canvas; without stretch it leaves whitespace inside a wider
    // card and looks shorter).
    '.card[data-topic="' + lidTopic + '"] canvas{' +
      'width:100% !important; height:100% !important; display:block;' +
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
      'display:flex !important;' +
      'flex-wrap:wrap;' +
      'justify-content:center;' +
      'align-items:flex-start;' +
      'gap:20pt;' +
      'margin:20pt auto !important;' +
      'padding:0 !important;' +
    '}' +
    '.card{' +
      'position:relative !important;' +
      'left:auto !important; top:auto !important;' +
      'margin:0 !important;' +
    '}';
  document.head.appendChild(style);

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
