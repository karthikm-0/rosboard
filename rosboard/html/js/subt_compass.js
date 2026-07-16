"use strict";

// Compass mini-map OVERLAID on the top-left of the camera view -- a browser port
// of the visuals of compass_graphic_node.py.
//
// Robot-centric by default: the robot faces UP and the goal/takeover markers are
// rotated into the robot frame, so the compass matches the FPS camera ("what's
// ahead of me"). Set compass.robotCentric = false for a world/north-up map.
//
// NO ROS topics: it renders from window.SUBT.robotPose (populated read-only by
// index.js from odometry). Goal/takeover come from config (compass.goal/takeover)
// or window.SUBT.compassGoal / compassTakeover -- never a subscription. It is
// attached to the camera card by patching ImageViewer (upstream stays pristine).
(function () {
  var cfg = (window.SUBT && window.SUBT.compass) || {};
  if (!cfg.enabled) return;

  var RANGE = cfg.rangeM || 10;
  var S = cfg.sizePx || 160;
  var C = S / 2, RAD = S / 2 - 8, SCALE = RAD / RANGE;
  var robotCentric = cfg.robotCentric !== false;

  // Which card to overlay: the whitelisted Image topic (or an explicit override).
  function cameraTopic() {
    if (cfg.cameraTopic) return cfg.cameraTopic;
    var w = (window.SUBT && window.SUBT.whitelist) || [];
    for (var i = 0; i < w.length; i++)
      if (/Image/.test(w[i].topicType || "")) return w[i].topicName;
    return "/X1/front/image_raw";
  }

  function pose() { return (window.SUBT && window.SUBT.robotPose) || null; }

  // World point -> canvas pixel. robotCentric rotates into the robot frame so
  // forward = up (x-up, y-left); else world-fixed. Clamp to the ring beyond range.
  function toPx(px, py, rp) {
    var dx = px - rp.x, dy = py - rp.y, xr, yr;
    if (robotCentric) {
      xr = dx * Math.cos(rp.yaw) + dy * Math.sin(rp.yaw);   // forward
      yr = -dx * Math.sin(rp.yaw) + dy * Math.cos(rp.yaw);   // left
    } else { xr = dx; yr = dy; }
    var dist = Math.hypot(xr, yr), th = Math.atan2(yr, xr);
    if (dist <= RANGE) return [C - yr * SCALE, C - xr * SCALE];
    return [C - Math.sin(th) * RAD, C - Math.cos(th) * RAD];
  }

  function dot(ctx, x, y, r, fill) {
    ctx.beginPath(); ctx.arc(x, y, r, 0, 2 * Math.PI);
    ctx.fillStyle = fill; ctx.fill();
    ctx.lineWidth = 1; ctx.strokeStyle = "#fff"; ctx.stroke();
  }

  // Build a self-rendering compass canvas (drives its own rAF loop).
  function makeCanvas() {
    var cv = document.createElement("canvas");
    cv.width = S; cv.height = S;
    cv.style.cssText = "position:absolute;top:8px;left:8px;z-index:20;" +
      "background:rgba(20,20,20,0.45);border-radius:50%;pointer-events:none;";
    var ctx = cv.getContext("2d");
    (function render() {
      ctx.clearRect(0, 0, S, S);
      ctx.beginPath(); ctx.arc(C, C, RAD, 0, 2 * Math.PI);
      ctx.lineWidth = 2; ctx.strokeStyle = "#c8c8c8"; ctx.stroke();
      ctx.beginPath(); ctx.arc(C, C, 3, 0, 2 * Math.PI);
      ctx.fillStyle = "#c8c8c8"; ctx.fill();

      var rp = pose();
      if (rp) {
        // heading needle: robot-centric -> straight up (forward); else world yaw
        var nx = robotCentric ? C : C - 20 * Math.sin(rp.yaw);
        var ny = robotCentric ? C - 20 : C - 20 * Math.cos(rp.yaw);
        ctx.beginPath(); ctx.moveTo(C, C); ctx.lineTo(nx, ny);
        ctx.lineWidth = 3; ctx.strokeStyle = "#42a5f5"; ctx.stroke();

        var g = window.SUBT.compassGoal || cfg.goal;
        var t = window.SUBT.compassTakeover || cfg.takeover;
        if (g) { var gp = toPx(g.x, g.y, rp); dot(ctx, gp[0], gp[1], 5, "#00ffff"); }
        if (t) { var tp = toPx(t.x, t.y, rp); dot(ctx, tp[0], tp[1], 5, "#ff5252"); }
      }
      requestAnimationFrame(render);
    })();
    return cv;
  }

  // Patch ImageViewer so the camera card gets the overlay when it's created.
  function applyPatch() {
    if (typeof ImageViewer === "undefined") return false;
    if (ImageViewer.prototype.__subtCompassPatched) return true;
    ImageViewer.prototype.__subtCompassPatched = true;

    var origOnCreate = ImageViewer.prototype.onCreate;
    ImageViewer.prototype.onCreate = function () {
      origOnCreate.call(this);
      if (this.topicName !== cameraTopic()) return;   // only the camera card
      this.viewerNode.css("position", "relative");
      this.viewerNode.append(makeCanvas());
    };
    return true;
  }

  // ImageViewer is defined at load; retry briefly for load-order safety.
  if (!applyPatch()) {
    var n = 0;
    var iv = setInterval(function () {
      if (applyPatch() || ++n > 100) clearInterval(iv);
    }, 50);
  }
})();
