"use strict";

// "Next trial" button for online experiments. Publishes std_msgs/Empty to
// /experiment/advance via rosbridge; the in-container shim (advance_to_stdin.py)
// turns each message into the "Enter" that steps run_config_sequence.py. Rides
// the same rosbridge path as the joystick. No auto-advance -- the participant
// clicks to step, and a debounce guards against accidental double-steps.
(function () {
  var cfg = (window.SUBT && window.SUBT.experiment) || {};
  if (!cfg.enabled) return;

  // Resolve the rosbridge URL exactly like the joystick: same-origin wss behind
  // an HTTPS tunnel, else the localhost host-port (rosboard 888i / rosbridge 909i).
  function rosbridgeUrl() {
    var params = new URLSearchParams(location.search);
    var override = params.get("rb");
    if (override && /^wss?:\/\//.test(override)) return override;
    if (location.protocol === "https:")
      return "wss://" + location.host + (cfg.rosbridgePath || "/rosbridge");
    var jc = (window.SUBT && window.SUBT.joystick) || {};
    var port = override || (location.port
      ? (parseInt(location.port, 10) + (jc.rosbridgePortOffset || 210))
      : (jc.rosbridgePortDefault || 9090));
    return "ws://" + location.hostname + ":" + port;
  }

  function init() {
    var url = rosbridgeUrl();
    var ros = new ROSLIB.Ros({ url: url });
    var advance = new ROSLIB.Topic({
      ros: ros,
      name: cfg.advanceTopic || "/experiment/advance",
      messageType: "std_msgs/msg/Empty",
    });

    var connected = false;
    ros.on("connection", function () { connected = true; setLabel("ready", "#66bb6a"); });
    ros.on("error", function () { setLabel("error", "#ef5350"); });
    ros.on("close", function () {
      connected = false; setLabel("reconnecting…", "#ffa726");
      setTimeout(function () { ros.connect(url); }, 2000);
    });

    // --- UI ---
    var btn = document.createElement("button");
    btn.id = "subt-next-btn";
    css(btn, { position: "fixed", left: "24px", bottom: "24px", zIndex: 99999,
      padding: "14px 22px", fontSize: "16px", fontWeight: "bold", color: "#fff",
      background: "#3f51b5", border: "none", borderRadius: "8px", cursor: "pointer",
      boxShadow: "0 2px 6px rgba(0,0,0,0.5)", fontFamily: "sans-serif",
      userSelect: "none" });
    btn.textContent = cfg.label || "Next trial ▶";

    var lbl = document.createElement("div");
    css(lbl, { position: "fixed", left: "24px", bottom: "70px", fontSize: "11px",
      color: "#ffa726", fontFamily: "sans-serif", zIndex: 99999 });
    function setLabel(t, c) { lbl.textContent = "experiment: " + t; lbl.style.color = c; }
    setLabel("connecting…", "#ffa726");

    var debounceUntil = 0;
    btn.addEventListener("click", function () {
      if (!connected) return;
      var now = +new Date();
      if (now < debounceUntil) return;          // guard against double-steps
      debounceUntil = now + (cfg.debounceMs || 800);
      advance.publish(new ROSLIB.Message({}));   // std_msgs/Empty
      var orig = btn.style.background;
      btn.style.background = "#66bb6a";
      setTimeout(function () { btn.style.background = orig; }, 200);
    });

    document.body.appendChild(btn);
    document.body.appendChild(lbl);
  }

  function css(el, o) { for (var k in o) el.style[k] = o[k]; }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
