"use strict";

// Same-browser duplicate-tab guard.
//
// Any two tabs on this browser opened with the same PROLIFIC_PID (via ?pid=)
// would both publish /joy at 10Hz, and their manual/autonomous flags would
// fight -- pathFollower sees axes[2] alternating and the robot drifts between
// planner-driven and joystick-driven behavior. This detects the duplicate at
// load and locks out the newer tab: overlay is shown, and window.SUBT.duplicateTab
// flips true so subt_joystick.js + subt_experiment.js can skip their publish
// calls (they check the flag on every publish).
//
// Same-browser only (BroadcastChannel). Cross-browser (laptop + phone, or two
// different browsers) needs server-side session tokens; deferred.
(function () {
  window.SUBT = window.SUBT || {};
  window.SUBT.duplicateTab = false;

  var qp = new URLSearchParams(location.search);
  var pid = qp.get("pid");
  if (!pid) return;   // no PID -> can't scope a channel, no guard possible

  if (typeof BroadcastChannel === "undefined") {
    console.warn("subt: BroadcastChannel unavailable; duplicate-tab guard off");
    return;
  }

  var bc = new BroadcastChannel("subt-sim-" + pid);

  bc.onmessage = function (e) {
    if (e.data === "hello") {
      // Another tab just arrived. If we're the primary, announce ourselves so
      // they know to back off. Duplicates stay silent.
      if (!window.SUBT.duplicateTab) bc.postMessage("here");
    } else if (e.data === "here") {
      // A reply to our hello -> a primary already exists in another tab.
      if (!window.SUBT.duplicateTab) markAsDuplicate();
    }
  };

  bc.postMessage("hello");

  function markAsDuplicate() {
    window.SUBT.duplicateTab = true;
    showOverlay();
  }

  function showOverlay() {
    var d = document.createElement("div");
    d.style.cssText = "position:fixed;inset:0;z-index:2147483647;" +
      "background:rgba(0,0,0,0.92);color:#eee;" +
      "font:16px sans-serif;text-align:center;padding-top:120px;" +
      "user-select:none;";
    d.innerHTML =
      '<h1 style="font-size:24px;margin-bottom:16px">Session already open</h1>' +
      '<p>This study is already open in another tab of this browser.</p>' +
      '<p>Please <strong>close this tab</strong> and return to the original.</p>' +
      '<p style="margin-top:24px;font-size:12px;color:#aaa">' +
        'If the original was closed, refresh this page to continue here.</p>';
    document.body.appendChild(d);
  }
})();
