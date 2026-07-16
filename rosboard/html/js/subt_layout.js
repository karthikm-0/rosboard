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
    var orig = Viewer.prototype.onCreate;
    Viewer.prototype.onCreate = function () {
      if (orig) orig.call(this);
      if (this.card && this.topicName) {
        this.card.attr("data-topic", this.topicName);
      }
    };
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
    '}' +
    '.card[data-topic="' + lidTopic + '"]{' +
      'width:calc(' + lidVw + 'vw - 40pt) !important;' +
      'min-width:' + minPx + 'px !important;' +
    '}';
  document.head.appendChild(style);
})();
