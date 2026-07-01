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
    // First press starts trial 1; afterwards it advances to the next trial.
    btn.textContent = cfg.startLabel || "Start ▶";

    var lbl = document.createElement("div");
    css(lbl, { position: "fixed", left: "24px", bottom: "70px", fontSize: "11px",
      color: "#ffa726", fontFamily: "sans-serif", zIndex: 99999 });
    function setLabel(t, c) { lbl.textContent = "experiment: " + t; lbl.style.color = c; }
    setLabel("connecting…", "#ffa726");

    // run_config_sequence.py waits for TWO advances per trial: one to START the
    // trial (unpause -> robot drives autonomously) and one to STOP it and prep the
    // next. So a single "advance = next trial" click must send different pulse
    // counts: the first press just STARTs trial 1 (1 pulse); every later press
    // both STOPs the current trial and STARTs the next (2 pulses). stdin is
    // buffered, so the START fires the instant the reset finishes.
    function pulse() { advance.publish(new ROSLIB.Message({})); }   // std_msgs/Empty

    var started = false;
    var debounceUntil = 0;
    btn.addEventListener("click", function () {
      if (!connected) return;
      var now = +new Date();
      if (now < debounceUntil) return;          // guard against double-steps
      debounceUntil = now + (cfg.debounceMs || 800);

      if (!started) {
        started = true;
        pulse();                                 // START trial 1
        btn.textContent = cfg.label || "Next trial ▶";
      } else {
        pulse();                                 // STOP current trial
        setTimeout(pulse, 120);                  // START next trial
      }
      // Re-arm the joystick to autonomous for the (re)started trial. (The joystick
      // also re-arms itself off /experiment/advance; this is the instant path.)
      if (typeof window.SUBT.setJoystickManual === "function")
        window.SUBT.setJoystickManual(false);
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
