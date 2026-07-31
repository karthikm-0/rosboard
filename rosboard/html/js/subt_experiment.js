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
    // "ready" here means: rosbridge is up AND advance_to_stdin has subscribed
    // to /experiment/advance. If the participant clicks Start before the sub
    // exists, ROS 2 default QoS silently drops the pulse and the runner never
    // advances. We poll rosapi for subscribers and only enable Start once one
    // shows up; also block clicks (btn.disabled) so it can't fire early.
    var simReady = false;
    var subsClient = new ROSLIB.Service({
      ros: ros, name: "/rosapi/subscribers",
      serviceType: "rosapi_msgs/srv/Subscribers",
    });
    // Readiness = TWO signals both true:
    //  (a) /experiment/advance has a subscriber -- advance_to_stdin.py is up,
    //      so a START pulse won't be dropped.
    //  (b) EVERY whitelisted sensor topic has a publisher -- Gazebo bridges
    //      have launched, so once the runner unpauses there's real data to
    //      display. Without (b), clicking Start too early means an empty sensor
    //      view for several seconds while the sim finishes booting.
    var pubsClient = new ROSLIB.Service({
      ros: ros, name: "/rosapi/publishers",
      serviceType: "rosapi_msgs/srv/Publishers",
    });
    var whitelist = (window.SUBT && window.SUBT.whitelist) || [];
    var readyPoll = null;
    function beginReadinessPolling() {
      if (readyPoll) return;
      var advReq = new ROSLIB.ServiceRequest({
        topic: cfg.advanceTopic || "/experiment/advance"
      });
      readyPoll = setInterval(function () {
        if (!connected || simReady) return;
        // (a) advance subscriber check
        subsClient.callService(advReq, function (res) {
          var subs = (res && res.subscribers) || [];
          if (subs.length === 0) return;
          // (b) publisher check on every whitelisted topic
          var pending = whitelist.length, allPresent = true;
          if (pending === 0) return markReady();
          whitelist.forEach(function (t) {
            pubsClient.callService(
              new ROSLIB.ServiceRequest({ topic: t.topicName }),
              function (r) {
                if (!((r && r.publishers) || []).length) allPresent = false;
                if (--pending === 0 && allPresent) markReady();
              },
              function () { allPresent = false; if (--pending === 0) { } }
            );
          });
        }, function () { /* rosapi call failed; keep polling */ });
      }, 500);
    }
    function markReady() {
      if (simReady) return;
      simReady = true;
      setLabel("ready", "#66bb6a");
      btn.disabled = false; btn.style.opacity = "1"; btn.style.cursor = "pointer";
      // Overlay stays UP -- swap text to "Ready, click Start". Only the
      // Start-click hides it (with a short buffer so the first sensor frames
      // land before the participant sees the cards).
      showOverlay("Ready");
      overlaySub.textContent = "Click Start ▶ in the bottom-right when you're ready to begin.";
      clearInterval(readyPoll); readyPoll = null;
    }
    ros.on("connection", function () {
      connected = true;
      setLabel("connected, waiting for sim…", "#ffa726");
      beginReadinessPolling();
    });
    ros.on("error", function () { setLabel("error", "#ef5350"); });
    ros.on("close", function () {
      connected = false; simReady = false;
      if (readyPoll) { clearInterval(readyPoll); readyPoll = null; }
      btn.disabled = true; btn.style.opacity = "0.5"; btn.style.cursor = "not-allowed";
      setLabel("reconnecting…", "#ffa726");
      showOverlay("Reconnecting to simulation…");
      setTimeout(function () { ros.connect(url); }, 2000);
    });

    // --- UI ---
    var btn = document.createElement("button");
    btn.id = "subt-next-btn";
    // z-index above the loading overlay (999998) so the corner button remains
    // clickable while the "Ready — click Start" overlay is up.
    css(btn, {
      position: "fixed", right: "24px", bottom: "24px", zIndex: 999999,
      padding: "14px 22px", fontSize: "16px", fontWeight: "bold", color: "#fff",
      background: "#3f51b5", border: "none", borderRadius: "8px", cursor: "pointer",
      boxShadow: "0 2px 6px rgba(0,0,0,0.5)", fontFamily: "sans-serif",
      userSelect: "none"
    });
    // First press starts trial 1; afterwards it advances to the next trial.
    // Starts DISABLED -- enabled once rosbridge is connected AND advance_to_stdin
    // has subscribed, so an early click can't silently drop the START pulse.
    btn.textContent = cfg.startLabel || "Start ▶";
    btn.disabled = true;
    btn.style.opacity = "0.5";
    btn.style.cursor = "not-allowed";

    var lbl = document.createElement("div");
    css(lbl, {
      position: "fixed", right: "24px", bottom: "70px", fontSize: "11px",
      color: "#ffa726", fontFamily: "sans-serif", zIndex: 99999
    });
    function setLabel(t, c) { lbl.textContent = "experiment: " + t; lbl.style.color = c; }
    setLabel("connecting…", "#ffa726");

    // Trial counter, top-right. "Trial N / total" once the participant has
    // started. Before Start: shows "Ready" so they know something's coming.
    var trialLbl = document.createElement("div");
    css(trialLbl, {
      position: "fixed", top: "16px", right: "16px", zIndex: 99999,
      padding: "8px 14px", fontSize: "14px", fontWeight: "bold",
      color: "#fff", background: "rgba(0,0,0,0.6)", borderRadius: "6px",
      fontFamily: "sans-serif", userSelect: "none"
    });
    document.body.appendChild(trialLbl);
    function setTrialLabel(n) {
      if (n <= 0) {
        trialLbl.textContent = total > 0 ? "Ready · " + total + " trials" : "Ready";
      } else if (total > 0 && n > total) {
        trialLbl.textContent = "Study complete";
      } else if (total > 0) {
        trialLbl.textContent = "Trial " + n + " / " + total;
      } else {
        trialLbl.textContent = "Trial " + n;
      }
    }
    setTrialLabel(0);

    // Loading overlay -- covers the sensor cards during the initial sim boot
    // and briefly at each trial transition. Without this, participants see
    // stale frames after clicking Next (the runner needs ~1-2s to reset the
    // robot to the next spawn) and mash the button thinking nothing happened.
    var overlay = document.createElement("div");
    css(overlay, {
      position: "fixed", inset: "0", zIndex: "999998",
      background: "rgba(0,0,0,0.92)", color: "#fff",
      display: "flex", flexDirection: "column",
      alignItems: "center", justifyContent: "center",
      fontFamily: "sans-serif"
    });
    var overlayTitle = document.createElement("div");
    css(overlayTitle, { fontSize: "28px", fontWeight: "bold", marginBottom: "16px" });
    var overlaySub = document.createElement("div");
    css(overlaySub, { fontSize: "14px", color: "#ffa726" });
    overlaySub.textContent = "Please wait — do not close this tab";
    overlay.appendChild(overlayTitle);
    overlay.appendChild(overlaySub);
    document.body.appendChild(overlay);
    function showOverlay(title) { overlayTitle.textContent = title; overlay.style.display = "flex"; }
    function hideOverlay() { overlay.style.display = "none"; }
    showOverlay("Preparing simulation…");
    var transitionMs = cfg.transitionOverlayMs || 4000;

    // Wait for the first message on every whitelisted sensor topic, then run
    // `done`. If it takes longer than safetyMs (sim slow, DDS glitch, plugin
    // stalled), fall back to hiding the overlay anyway so we don't strand the
    // participant behind it. Fires done() exactly once.
    // Rides on the experiment's own rosbridge connection (separate from
    // rosboard's), so subscriptions here don't affect the sensor cards.
    function waitForFirstFrames(safetyMs, done) {
      var wl = (window.SUBT && window.SUBT.whitelist) || [];
      if (!wl.length || !connected) { setTimeout(done, safetyMs); return; }
      var remaining = wl.length, called = false;
      function finish() { if (called) return; called = true; done(); }
      var subs = [];
      var timer = setTimeout(function () {
        subs.forEach(function (s) { try { s.unsubscribe(); } catch (e) { } });
        finish();
      }, safetyMs);
      wl.forEach(function (t) {
        var sub = new ROSLIB.Topic({
          ros: ros, name: t.topicName, messageType: t.topicType,
          throttle_rate: 500,       // rate-limit; we only need ONE frame each
        });
        subs.push(sub);
        sub.subscribe(function () {
          try { sub.unsubscribe(); } catch (e) { }
          if (--remaining === 0) { clearTimeout(timer); finish(); }
        });
      });
    }

    // run_config_sequence.py waits for TWO advances per trial: one to START the
    // trial (unpause -> robot drives autonomously) and one to STOP it and prep
    // the next. So the button sends different pulse counts depending on where
    // in the sequence we are:
    //   press 1                     : START trial 1                  (1 pulse)
    //   press 2 .. total            : STOP current + START next      (2 pulses)
    //   press total+1  ("Finish")   : STOP last trial + POST /release (1 pulse)
    // stdin is buffered, so the START fires the instant the runner's reset ends.
    function pulse() { advance.publish(new ROSLIB.Message({})); }   // std_msgs/Empty

    // Broker query params (present when the page was reached via broker /start):
    //   pid    = P##          participant id in the counterbalancing matrix
    //   total  = trial count  (from broker; falls back to cfg.totalTrials or 0)
    //   broker = broker URL   (falls back to cfg.brokerUrl)
    // If total <= 0, the Finish path never engages -- button acts as "Next trial"
    // forever (useful for open-ended local testing).
    var qp = new URLSearchParams(location.search);
    var pid = qp.get("pid") || "";
    var total = parseInt(qp.get("total") || cfg.totalTrials || 0, 10);
    var brokerUrl = qp.get("broker") || cfg.brokerUrl || "";
    var finishLabel = cfg.finishLabel || "Finish study ✓";

    function labelForCount(n) {
      if (n === 0) return cfg.startLabel || "Start ▶";
      if (total > 0 && n >= total) return finishLabel;
      return cfg.label || "Next trial ▶";
    }
    function paintFinishStyle() { btn.style.background = "#ff5252"; }

    function completePage() {
      document.body.innerHTML =
        '<div style="font:16px sans-serif;color:#eee;background:#111;'
        + 'position:fixed;inset:0;text-align:center;padding-top:120px">'
        + '<h2>Study complete</h2><p>Thank you for participating!</p>'
        + '<p>You may now close this tab.</p></div>';
    }

    // Ask the broker for trial N's goal/takeover coordinates (from the AEDE
    // yaml) and hand them to the compass. Silent no-op when broker/pid are
    // absent (local testing without the assign flow) -- compass just omits
    // the markers. Called on load (trial 1) and after each Next click.
    function refreshCompassForTrial(n) {
      if (!brokerUrl || !pid || n < 1 || (total > 0 && n > total)) return;
      fetch(brokerUrl.replace(/\/$/, "") + "/trial-info?pid="
        + encodeURIComponent(pid) + "&trial=" + n)
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (j) {
          if (!j) return;
          window.SUBT.compassGoal = j.goal || null;
          window.SUBT.compassTakeover = j.takeover || null;
        })
        .catch(function () { /* leave prior markers as-is */ });
    }
    refreshCompassForTrial(1);

    function finishAndRelease() {
      // Best-effort notify the broker; whether it responds or not, take the
      // participant to the Prolific completion URL (or a local thank-you).
      if (!brokerUrl || !pid) return completePage();
      fetch(brokerUrl.replace(/\/$/, "") + "/release?PROLIFIC_PID="
        + encodeURIComponent(pid), { method: "POST" })
        .then(function (r) { return r.json().catch(function () { return {}; }); })
        .then(function (j) {
          if (j && j.completion_url && !/REPLACE_ME/.test(j.completion_url))
            location.href = j.completion_url;
          else completePage();
        })
        .catch(completePage);
    }

    var pressCount = 0;
    var debounceUntil = 0;
    btn.addEventListener("click", function () {
      if (!connected) return;
      // Duplicate-tab guard: only the primary tab can advance the runner.
      if (window.SUBT && window.SUBT.duplicateTab) return;
      var now = +new Date();
      if (now < debounceUntil) return;          // guard against double-steps
      debounceUntil = now + (cfg.debounceMs || 800);
      pressCount++;

      // Safety timeout for waitForFirstFrames -- 3x the fixed transition
      // window. If sensors don't publish by then, we hide the overlay anyway.
      var safetyMs = Math.max(transitionMs * 3, 15000);

      if (pressCount === 1) {
        pulse();                                 // START trial 1
        // First press: overlay was showing "Ready" -- swap to "Starting trial 1…"
        // and keep it up until the first camera/lidar frame ACTUALLY arrives, so
        // the participant never sees stale "waiting for data" cards.
        showOverlay("Starting trial 1…");
        overlaySub.textContent = "Please wait — do not close this tab";
        waitForFirstFrames(safetyMs, hideOverlay);
      } else if (total > 0 && pressCount > total) {
        pulse();                                 // STOP last trial
        btn.disabled = true;
        setTrialLabel(pressCount);
        finishAndRelease();
        return;
      } else {
        pulse();                                 // STOP current trial
        // Runs the deferred start-next-trial + overlay + first-frames wait.
        // Extracted so we can invoke it either directly (no minigame) OR from
        // the minigame's onDone callback.
        var startNext = function () {
          setTimeout(pulse, 120);                    // START next trial
          refreshCompassForTrial(pressCount);
          showOverlay("Loading trial " + pressCount + "…");
          overlaySub.textContent = "Please wait — do not close this tab";
          waitForFirstFrames(safetyMs, hideOverlay);
        };
        // cfg.minigameBetweenTrials (bool): if true and the minigame is loaded,
        // show it between trials; otherwise skip straight to the next trial.
        // Toggle in subt_config.js -> experiment.minigameBetweenTrials.
        if (cfg.minigameBetweenTrials &&
            window.SUBT && typeof window.SUBT.showMinigame === "function") {
          window.SUBT.showMinigame(startNext);
        } else {
          startNext();
        }
      }

      btn.textContent = labelForCount(pressCount);
      setTrialLabel(pressCount);
      // Re-arm the joystick to autonomous for the (re)started trial. (The joystick
      // also re-arms itself off /experiment/advance; this is the instant path.)
      if (typeof window.SUBT.setJoystickManual === "function")
        window.SUBT.setJoystickManual(false);
      var orig = btn.style.background;
      btn.style.background = "#66bb6a";
      setTimeout(function () {
        if (total > 0 && pressCount >= total) paintFinishStyle();
        else btn.style.background = orig;
      }, 200);
    });

    document.body.appendChild(btn);
    document.body.appendChild(lbl);
  }

  function css(el, o) { for (var k in o) el.style[k] = o[k]; }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
