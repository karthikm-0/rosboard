"use strict";

// Mouse/touch joystick overlay that drives the robot via rosbridge (rosboard
// itself is view-only and cannot publish). Self-contained: DOM + roslibjs.
//
// Two control paths (see subt_config.js -> joystick.useJoy):
//   useJoy:true  -> publishes sensor_msgs/Joy on /joy, so the robot is driven
//                   THROUGH the CMU pathFollower. Axis 2 = mode: the trial starts
//                   autonomous (planner drives to the takeover point); the
//                   "Take control" button flips to manual (axis 4 = forward,
//                   axis 3 = yaw). pathFollower stays the sole /cmd_vel publisher,
//                   so takeover matches the gamepad experiment with no conflict.
//   useJoy:false -> publishes geometry_msgs/Twist straight to cmdVelTopic
//                   (direct drive, bypasses the planner, no takeover handoff).
(function () {
  var cfg = (window.SUBT && window.SUBT.joystick) || {};
  if (!cfg.enabled) return;

  var useJoy = cfg.useJoy !== false;

  function init() {
    // --- resolve rosbridge URL ---
    // Behind an HTTPS tunnel/proxy, rosbridge is reverse-proxied under the same
    // origin at cfg.rosbridgePath, so one public URL serves rosboard + rosbridge
    // and wss:// is mandatory. For direct localhost/SSH use, fall back to the
    // separate host port (rosboard 888i / rosbridge 909i via the +210 offset).
    // ?rb= overrides: a full ws(s):// URL, or a bare port number (legacy).
    var params = new URLSearchParams(location.search);
    var override = params.get("rb");
    var url;
    if (override && /^wss?:\/\//.test(override)) {
      url = override;
    } else if (location.protocol === "https:") {
      url = "wss://" + location.host + (cfg.rosbridgePath || "/rosbridge");
    } else {
      var port = override
        || (location.port
              ? (parseInt(location.port, 10) + (cfg.rosbridgePortOffset || 0))
              : (cfg.rosbridgePortDefault || 9090));
      url = "ws://" + location.hostname + ":" + port;
    }

    // --- connection ---
    var ros = new ROSLIB.Ros({ url: url });
    var outTopic = new ROSLIB.Topic({
      ros: ros,
      name: useJoy ? (cfg.joyTopic || "/joy") : cfg.cmdVelTopic,
      messageType: useJoy ? (cfg.joyType || "sensor_msgs/msg/Joy") : cfg.cmdVelType,
    });
    var connected = false;
    ros.on("connection", function () { connected = true; setStatus("connected", "#66bb6a"); });
    ros.on("error", function () { setStatus("error", "#ef5350"); });
    ros.on("close", function () {
      connected = false; setStatus("reconnecting…", "#ffa726");
      setTimeout(function () { ros.connect(url); }, 2000);
    });

    // --- mode state (useJoy only): start autonomous, participant takes over ---
    var manual = useJoy ? (cfg.startAutonomous === false) : true;

    // Re-arm to autonomous on each new trial. Self-contained: subscribe to the
    // experiment advance topic on our OWN rosbridge connection, so this works
    // regardless of subt_experiment.js's timing/connection state. setManual is a
    // hoisted function declaration below, so referencing it here is safe.
    if (useJoy) {
      var advTopic = (window.SUBT.experiment && window.SUBT.experiment.advanceTopic) || "/experiment/advance";
      new ROSLIB.Topic({ ros: ros, name: advTopic, messageType: "std_msgs/msg/Empty" })
        .subscribe(function () { setManual(false); });
    }

    // --- UI ---
    var wrap = document.createElement("div");
    wrap.id = "subt-joystick";
    css(wrap, { position: "fixed", right: "24px", bottom: "24px", width: "170px",
      height: "212px", zIndex: 99999, userSelect: "none", touchAction: "none",
      fontFamily: "sans-serif" });
    var label = document.createElement("div");
    css(label, { position: "absolute", top: "0", width: "100%", textAlign: "center",
      fontSize: "11px", color: "#ffa726" });
    label.textContent = "joystick: connecting…";

    // Mode caption: no button -- moving the stick itself takes over (see down()).
    var modeLbl = document.createElement("div");
    css(modeLbl, { position: "absolute", top: "16px", width: "100%",
      textAlign: "center", fontSize: "11px", fontWeight: "bold",
      lineHeight: "1.25", display: useJoy ? "block" : "none" });

    var base = document.createElement("div");
    css(base, { position: "absolute", bottom: "0", width: "170px", height: "170px",
      borderRadius: "50%", background: "rgba(38,38,38,0.55)",
      border: "2px solid #888", boxSizing: "border-box" });
    var knob = document.createElement("div");
    css(knob, { position: "absolute", width: "62px", height: "62px",
      borderRadius: "50%", background: "#3f51b5", left: "54px", top: "54px",
      cursor: "grab", boxShadow: "0 2px 6px rgba(0,0,0,0.5)" });
    base.appendChild(knob);
    wrap.appendChild(label); wrap.appendChild(modeLbl); wrap.appendChild(base);
    document.body.appendChild(wrap);
    function setStatus(t, c) { label.textContent = "joystick: " + t; label.style.color = c; }

    // Reflect current mode in the caption + knob styling. No button: the robot
    // drives autonomously until the participant grabs the stick (see down()).
    function updateModeUI() {
      if (!useJoy) return;
      if (manual) {
        modeLbl.textContent = "MANUAL — you are driving";
        modeLbl.style.color = "#66bb6a";
        base.style.opacity = "1"; knob.style.background = "#3f51b5";
        knob.style.cursor = "grab";
      } else {
        modeLbl.textContent = "AUTONOMOUS\nmove the stick to take over";
        modeLbl.style.whiteSpace = "pre";
        modeLbl.style.color = "#ffa726";
        base.style.opacity = "0.55"; knob.style.background = "#3f51b5";
        knob.style.cursor = "grab";
      }
    }
    updateModeUI();

    // Flip modes. Exposed so the "Next trial" button can re-arm autonomy per trial.
    function setManual(v) { manual = !!v; if (!manual) reset(); updateModeUI(); }
    window.SUBT.setJoystickManual = setManual;   // hook for subt_experiment.js

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
    function down(e) {
      active = true;
      if (useJoy && !manual) setManual(true);   // grabbing the stick = takeover
      var p = pt(e); moveKnob(p.clientX, p.clientY); e.preventDefault();
    }
    function move(e) { if (!active) return; var p = pt(e); moveKnob(p.clientX, p.clientY); e.preventDefault(); }

    knob.addEventListener("mousedown", down);
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", reset);
    knob.addEventListener("touchstart", down, { passive: false });
    window.addEventListener("touchmove", move, { passive: false });
    window.addEventListener("touchend", reset);

    // --- publish loop ---
    // useJoy: continuous /joy heartbeat. Autonomous = trigger held (axis2=-1) with
    // sticks centered (planner drives); manual = trigger released (axis2=+1) with
    // live stick values -- exactly mirroring the gamepad operator.
    var driveAxis = cfg.driveAxis != null ? cfg.driveAxis : 4;
    var yawAxis   = cfg.yawAxis   != null ? cfg.yawAxis   : 3;
    var modeAxis  = cfg.autonomyAxis != null ? cfg.autonomyAxis : 2;
    var driveSign = cfg.driveSign != null ? cfg.driveSign : 1;
    var yawSign   = cfg.yawSign   != null ? cfg.yawSign   : -1;
    var nAxes = Math.max(driveAxis, yawAxis, modeAxis) + 1;
    if (nAxes < 6) nAxes = 6;

    setInterval(function () {
      if (!connected) return;
      if (useJoy) {
        var axes = new Array(nAxes).fill(0);
        axes[modeAxis]  = manual ? 1.0 : -1.0;             // released vs held
        axes[driveAxis] = manual ? driveSign * ny : 0;
        axes[yawAxis]   = manual ? yawSign  * nx : 0;
        outTopic.publish(new ROSLIB.Message({
          header: { stamp: { sec: 0, nanosec: 0 }, frame_id: "" },
          axes: axes,
          buttons: new Array(8).fill(0),
        }));
      } else {
        outTopic.publish(new ROSLIB.Message({
          linear:  { x: ny * (cfg.maxLinear || 1.0), y: 0, z: 0 },
          angular: { x: 0, y: 0, z: -nx * (cfg.maxAngular || 1.0) },
        }));
      }
    }, 1000 / (cfg.rateHz || 10));
  }

  function css(el, o) { for (var k in o) el.style[k] = o[k]; }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
