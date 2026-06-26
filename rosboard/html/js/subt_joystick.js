"use strict";

// Mouse/touch joystick overlay that publishes geometry_msgs/Twist to the robot
// via rosbridge (rosboard itself is view-only and cannot publish). Self-
// contained: no external joystick library, just DOM + roslibjs.
(function () {
  var cfg = (window.SUBT && window.SUBT.joystick) || {};
  if (!cfg.enabled) return;

  function init() {
    // --- resolve rosbridge URL (different host port than rosboard) ---
    var params = new URLSearchParams(location.search);
    var port = params.get("rb");
    if (!port) {
      port = location.port
        ? (parseInt(location.port, 10) + (cfg.rosbridgePortOffset || 0))
        : (cfg.rosbridgePortDefault || 9090);
    }
    var url = "ws://" + location.hostname + ":" + port;

    // --- connection ---
    var ros = new ROSLIB.Ros({ url: url });
    var cmdVel = new ROSLIB.Topic({
      ros: ros, name: cfg.cmdVelTopic, messageType: cfg.cmdVelType,
    });
    var connected = false;
    ros.on("connection", function () { connected = true; setStatus("connected", "#66bb6a"); });
    ros.on("error", function () { setStatus("error", "#ef5350"); });
    ros.on("close", function () {
      connected = false; setStatus("reconnecting…", "#ffa726");
      setTimeout(function () { ros.connect(url); }, 2000);
    });

    // --- UI ---
    var wrap = document.createElement("div");
    wrap.id = "subt-joystick";
    css(wrap, { position: "fixed", right: "24px", bottom: "24px", width: "170px",
      height: "196px", zIndex: 99999, userSelect: "none", touchAction: "none",
      fontFamily: "sans-serif" });
    var label = document.createElement("div");
    css(label, { position: "absolute", top: "0", width: "100%", textAlign: "center",
      fontSize: "11px", color: "#ffa726" });
    label.textContent = "joystick: connecting…";
    var base = document.createElement("div");
    css(base, { position: "absolute", bottom: "0", width: "170px", height: "170px",
      borderRadius: "50%", background: "rgba(38,38,38,0.55)",
      border: "2px solid #888", boxSizing: "border-box" });
    var knob = document.createElement("div");
    css(knob, { position: "absolute", width: "62px", height: "62px",
      borderRadius: "50%", background: "#3f51b5", left: "54px", top: "54px",
      cursor: "grab", boxShadow: "0 2px 6px rgba(0,0,0,0.5)" });
    base.appendChild(knob); wrap.appendChild(label); wrap.appendChild(base);
    document.body.appendChild(wrap);
    function setStatus(t, c) { label.textContent = "joystick: " + t; label.style.color = c; }

    // --- drag → normalized (nx, ny) in [-1, 1] ---
    var R = 54, HALF = 85, KNOB0 = 54;     // travel radius, base half-size, knob rest
    var active = false, nx = 0, ny = 0;

    function moveKnob(clientX, clientY) {
      var r = base.getBoundingClientRect();
      var dx = clientX - (r.left + HALF), dy = clientY - (r.top + HALF);
      var dist = Math.hypot(dx, dy);
      if (dist > R) { dx = dx / dist * R; dy = dy / dist * R; }
      knob.style.left = (KNOB0 + dx) + "px";
      knob.style.top = (KNOB0 + dy) + "px";
      nx = dx / R;        // right = +
      ny = -dy / R;       // up (forward) = +
    }
    function reset() { active = false; nx = 0; ny = 0;
      knob.style.left = KNOB0 + "px"; knob.style.top = KNOB0 + "px"; }
    function pt(e) { return e.touches ? e.touches[0] : e; }
    function down(e) { active = true; var p = pt(e); moveKnob(p.clientX, p.clientY); e.preventDefault(); }
    function move(e) { if (!active) return; var p = pt(e); moveKnob(p.clientX, p.clientY); e.preventDefault(); }

    knob.addEventListener("mousedown", down);
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", reset);
    knob.addEventListener("touchstart", down, { passive: false });
    window.addEventListener("touchmove", move, { passive: false });
    window.addEventListener("touchend", reset);

    // --- publish loop (zeros when centered keep the robot stopped) ---
    setInterval(function () {
      if (!connected) return;
      cmdVel.publish(new ROSLIB.Message({
        linear:  { x: ny * (cfg.maxLinear || 1.0), y: 0, z: 0 },
        angular: { x: 0, y: 0, z: -nx * (cfg.maxAngular || 1.0) },
      }));
    }, 1000 / (cfg.rateHz || 10));
  }

  function css(el, o) { for (var k in o) el.style[k] = o[k]; }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
