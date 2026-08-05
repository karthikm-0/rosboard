"use strict";

// Browser-side controller for stepping run_config_sequence.py through rosbridge.
// The study-flow layer can call startTrial()/stopTrial(); when studyFlow is
// disabled this file falls back to the old single Next button behavior.
(function () {
  var cfg = (window.SUBT && window.SUBT.experiment) || {};
  if (!cfg.enabled) return;

  function css(el, o) { for (var k in o) el.style[k] = o[k]; }

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
    var qp = new URLSearchParams(location.search);
    var pid = qp.get("pid") || "";
    var total = parseInt(qp.get("total") || cfg.totalTrials || 0, 10);
    var brokerUrl = qp.get("broker") || cfg.brokerUrl || "";
    var transitionMs = cfg.transitionOverlayMs || 4000;

    var ros = new ROSLIB.Ros({ url: rosbridgeUrl() });
    var advance = new ROSLIB.Topic({
      ros: ros,
      name: cfg.advanceTopic || "/experiment/advance",
      messageType: "std_msgs/msg/Empty",
    });
    var clockTopic = new ROSLIB.Topic({
      ros: ros,
      name: cfg.clockTopic || "/clock",
      messageType: "rosgraph_msgs/msg/Clock",
    });
    var subsClient = new ROSLIB.Service({
      ros: ros, name: "/rosapi/subscribers",
      serviceType: "rosapi_msgs/srv/Subscribers",
    });
    var pubsClient = new ROSLIB.Service({
      ros: ros, name: "/rosapi/publishers",
      serviceType: "rosapi_msgs/srv/Publishers",
    });
    var whitelist = (window.SUBT && window.SUBT.whitelist) || [];
    var connected = false;
    var simReady = false;
    var readyCallbacks = [];
    var readyPoll = null;
    var currentTrial = 0;
    var trialActive = false;
    var trialIsPractice = false;
    var simTimeSec = null;
    var trialStartSimSec = null;
    var trialElapsedSimSec = 0;

    var btn = document.createElement("button");
    btn.id = "subt-next-btn";
    css(btn, {
      position: "fixed", right: "24px", bottom: "24px", zIndex: 999999,
      padding: "14px 22px", fontSize: "16px", fontWeight: "bold", color: "#fff",
      background: "#3f51b5", border: "none", borderRadius: "8px", cursor: "pointer",
      boxShadow: "0 2px 6px rgba(0,0,0,0.5)", fontFamily: "sans-serif",
      userSelect: "none"
    });
    btn.textContent = cfg.startLabel || "Start";
    btn.disabled = true;
    btn.style.opacity = "0.5";
    btn.style.cursor = "not-allowed";

    var lbl = document.createElement("div");
    css(lbl, {
      position: "fixed", right: "24px", bottom: "70px", fontSize: "11px",
      color: "#ffa726", fontFamily: "sans-serif", zIndex: 99999
    });
    function setLabel(t, c) { lbl.textContent = "experiment: " + t; lbl.style.color = c; }
    setLabel("connecting...", "#ffa726");

    var trialLbl = document.createElement("div");
    css(trialLbl, {
      position: "fixed", top: "16px", right: "16px", zIndex: 99999,
      padding: "8px 14px", fontSize: "14px", fontWeight: "bold",
      color: "#fff", background: "rgba(0,0,0,0.6)", borderRadius: "6px",
      fontFamily: "sans-serif", userSelect: "none"
    });
    document.body.appendChild(trialLbl);
    function setTrialLabel(n) {
      if (n <= 0) trialLbl.textContent = total > 0 ? "Ready · " + total + " trials" : "Ready";
      else if (total > 0 && n > total) trialLbl.textContent = "Study complete";
      else trialLbl.textContent = total > 0 ? "Trial " + n + " / " + total : "Trial " + n;
    }
    setTrialLabel(0);

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
    overlay.appendChild(overlayTitle);
    overlay.appendChild(overlaySub);
    document.body.appendChild(overlay);
    function showOverlay(title, sub) {
      overlayTitle.textContent = title;
      overlaySub.textContent = sub || "Please wait - do not close this tab";
      overlay.style.display = "flex";
    }
    function hideOverlay() { overlay.style.display = "none"; }
    if (window.SUBT.studyFlow && window.SUBT.studyFlow.enabled) hideOverlay();
    else showOverlay("Preparing simulation...");

    function pulse() { advance.publish(new ROSLIB.Message({})); }

    function clockToSec(msg) {
      var c = msg && msg.clock;
      if (!c) return null;
      return Number(c.sec || 0) + Number(c.nanosec || 0) / 1e9;
    }

    clockTopic.subscribe(function (msg) {
      var t = clockToSec(msg);
      if (t == null) return;
      simTimeSec = t;
      if (trialActive && trialStartSimSec != null) {
        trialElapsedSimSec = Math.max(0, simTimeSec - trialStartSimSec);
      }
    });

    function beginReadinessPolling() {
      if (readyPoll) return;
      var advReq = new ROSLIB.ServiceRequest({ topic: cfg.advanceTopic || "/experiment/advance" });
      readyPoll = setInterval(function () {
        if (!connected || simReady) return;
        subsClient.callService(advReq, function (res) {
          if (!((res && res.subscribers) || []).length) return;
          var pending = whitelist.length;
          var allPresent = true;
          if (pending === 0) return markReady();
          whitelist.forEach(function (t) {
            pubsClient.callService(
              new ROSLIB.ServiceRequest({ topic: t.topicName }),
              function (r) {
                if (!((r && r.publishers) || []).length) allPresent = false;
                if (--pending === 0 && allPresent) markReady();
              },
              function () { allPresent = false; pending--; }
            );
          });
        }, function () {});
      }, 500);
    }

    function markReady() {
      if (simReady) return;
      simReady = true;
      setLabel("ready", "#66bb6a");
      btn.disabled = false;
      btn.style.opacity = "1";
      btn.style.cursor = "pointer";
      if (!(window.SUBT.studyFlow && window.SUBT.studyFlow.enabled)) {
        showOverlay("Ready", "Click Start when you are ready to begin.");
      }
      clearInterval(readyPoll); readyPoll = null;
      var cbs = readyCallbacks.slice();
      readyCallbacks = [];
      cbs.forEach(function (cb) { try { cb(); } catch (e) {} });
    }

    function expectNextSim() {
      simReady = false;
      if (readyPoll) { clearInterval(readyPoll); readyPoll = null; }
      beginReadinessPolling();
    }

    function waitForViewerSettled(done) {
      // Do not subscribe to camera/lidar through rosbridge here. The participant
      // viewer already receives those streams through rosboard's throttled
      // transport; duplicating them through rosbridge makes joystick control lag.
      setTimeout(done, cfg.viewerSettleMs || 1200);
    }

    function waitForFreshSimTick(before, done) {
      if (before == null && simTimeSec != null) {
        done();
        return;
      }
      if (before != null && simTimeSec != null && simTimeSec > before + 0.05) {
        done();
        return;
      }
      var started = Date.now();
      var timer = setInterval(function () {
        if (before == null && simTimeSec != null) {
          clearInterval(timer);
          done();
        } else if (before != null && simTimeSec != null && simTimeSec > before + 0.05) {
          clearInterval(timer);
          done();
        } else if (Date.now() - started > 5000) {
          clearInterval(timer);
          done();
        }
      }, 50);
    }

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
        .catch(function () {});
    }
    function completePage() {
      document.body.innerHTML =
        '<div style="font:16px sans-serif;color:#eee;background:#111;'
        + 'position:fixed;inset:0;text-align:center;padding-top:120px">'
        + '<h2>Study complete</h2><p>Thank you for participating.</p>'
        + '<p>You may now close this tab.</p></div>';
    }

    function releaseToBroker(done, withdrew) {
      if (!brokerUrl || !pid) {
        if (done) done({});
        return;
      }
      var url = brokerUrl.replace(/\/$/, "") + "/release?PROLIFIC_PID="
        + encodeURIComponent(pid);
      if (withdrew) url += "&withdrew=1";
      fetch(url, { method: "POST" })
        .then(function (r) { return r.json().catch(function () { return {}; }); })
        .then(function (j) { if (done) done(j || {}); })
        .catch(function () { if (done) done({}); });
    }

    window.SUBT.experimentController = {
      totalTrials: function () { return total; },
      currentTrial: function () { return currentTrial; },
      isReady: function () { return simReady; },
      onReady: function (cb) { if (simReady) cb(); else readyCallbacks.push(cb); },
      showOverlay: showOverlay,
      hideOverlay: hideOverlay,
      expectNextSim: expectNextSim,
      setChromeVisible: function (visible) {
        btn.style.display = visible ? "block" : "none";
        lbl.style.display = visible ? "block" : "none";
        trialLbl.style.display = visible ? "block" : "none";
      },
      setJoystickVisible: function (visible) {
        var joy = document.getElementById("subt-joystick");
        if (joy) joy.style.display = visible ? "block" : "none";
      },
      startTrial: function (opts, done) {
        opts = opts || {};
        if (!connected || !simReady || trialActive) return false;
        var isPractice = !!opts.isPractice;
        if (!isPractice) currentTrial += 1;
        trialActive = true;
        trialIsPractice = isPractice;
        trialStartSimSec = simTimeSec;
        trialElapsedSimSec = 0;
        if (isPractice) {
          window.SUBT.compassGoal = opts.goal || null;
          window.SUBT.compassTakeover = opts.takeover || null;
        } else {
          refreshCompassForTrial(currentTrial);
        }
        if (opts.condition === "R") {
          if (typeof window.SUBT.setJoystickManual === "function") window.SUBT.setJoystickManual(false);
          this.setJoystickVisible(false);
        } else {
          this.setJoystickVisible(true);
          if (typeof window.SUBT.setJoystickManual === "function") window.SUBT.setJoystickManual(false);
        }
        var beforeAdvanceSimSec = simTimeSec;
        pulse();
        if (trialStartSimSec == null && simTimeSec != null) trialStartSimSec = simTimeSec;
        if (isPractice) trialLbl.textContent = opts.label || "Practice";
        else setTrialLabel(currentTrial);
        showOverlay(isPractice ? "Preparing " + (opts.label || "practice") + "..." : "Starting trial " + currentTrial + "...");
        waitForFreshSimTick(beforeAdvanceSimSec, function () {
          waitForViewerSettled(function () {
            hideOverlay();
            if (done) done();
          });
        });
        return true;
      },
      stopTrial: function (done) {
        if (!trialActive) { if (done) done(); return false; }
        pulse();
        var wasPractice = trialIsPractice;
        trialActive = false;
        trialIsPractice = false;
        if (simTimeSec != null && trialStartSimSec != null) {
          trialElapsedSimSec = Math.max(0, simTimeSec - trialStartSimSec);
        }
        if (wasPractice) expectNextSim();
        if (done) done();
        return true;
      },
      simTimeSec: function () { return simTimeSec; },
      trialElapsedSimSec: function () { return trialElapsedSimSec; },
      finishAndRelease: function () {
        releaseToBroker(function (j) {
          if (j && j.completion_url && !/REPLACE_ME/.test(j.completion_url))
            location.href = j.completion_url;
          else completePage();
        }, false);
      },
      exitStudy: function () {
        releaseToBroker(function (j) {
          if (j && j.withdrawal_url && !/REPLACE_ME/.test(j.withdrawal_url))
            location.href = j.withdrawal_url;
          else {
            document.body.innerHTML =
              '<div style="font:16px sans-serif;color:#eee;background:#111;'
              + 'position:fixed;inset:0;text-align:center;padding-top:120px">'
              + '<h2>You have exited the study</h2>'
              + '<p>If you are using Prolific, please return the assignment.</p>'
              + '<p>You may now close this tab.</p></div>';
          }
        }, true);
      }
    };

    ros.on("connection", function () {
      connected = true;
      setLabel("connected, waiting for sim...", "#ffa726");
      beginReadinessPolling();
    });
    ros.on("error", function () { setLabel("error", "#ef5350"); });
    ros.on("close", function () {
      connected = false; simReady = false;
      if (readyPoll) { clearInterval(readyPoll); readyPoll = null; }
      btn.disabled = true;
      btn.style.opacity = "0.5";
      btn.style.cursor = "not-allowed";
      setLabel("reconnecting...", "#ffa726");
      showOverlay("Reconnecting to simulation...");
      setTimeout(function () { ros.connect(rosbridgeUrl()); }, 2000);
    });

    // Legacy local/debug button mode. The richer study flow hides this button
    // and drives the same controller methods itself.
    if (!(window.SUBT.studyFlow && window.SUBT.studyFlow.enabled)) {
      var debounceUntil = 0;
      btn.addEventListener("click", function () {
        if (window.SUBT && window.SUBT.duplicateTab) return;
        var now = +new Date();
        if (now < debounceUntil) return;
        debounceUntil = now + (cfg.debounceMs || 800);
        if (!trialActive) {
          window.SUBT.experimentController.startTrial({}, function () {});
          btn.textContent = (total > 0 && currentTrial >= total) ? (cfg.finishLabel || "Finish") : (cfg.label || "Next trial");
        } else if (total > 0 && currentTrial >= total) {
          window.SUBT.experimentController.stopTrial(function () {
            window.SUBT.experimentController.finishAndRelease();
          });
        } else {
          window.SUBT.experimentController.stopTrial(function () {
            if (cfg.minigameBetweenTrials && window.SUBT && typeof window.SUBT.showMinigame === "function") {
              window.SUBT.showMinigame(function () {
                window.SUBT.experimentController.startTrial({}, function () {});
              });
            } else {
              window.SUBT.experimentController.startTrial({}, function () {});
            }
          });
        }
      });
      document.body.appendChild(btn);
      document.body.appendChild(lbl);
    } else {
      document.body.appendChild(btn);
      document.body.appendChild(lbl);
      window.SUBT.experimentController.setChromeVisible(false);
    }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
