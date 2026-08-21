"use strict";

// Demo-only condition switcher.
//
// The condition (sim/video/draw) is baked into the container at launch --
// sim boots Gazebo, video/draw boot bag playback instead -- so there is no
// way to flip it client-side. What this control does instead is send the
// browser back to the broker's /start with a different ?condition=, which
// tears the session down and relaunches it in the chosen arm. The broker's
// splash page then polls until the new container is up and redirects back
// here, so from the demo-giver's point of view it is one click plus a wait.
//
// Rendered ONLY when the broker put ?demo=1 in the sim URL, which it does
// only while dev.allow_participant_override is on. A real participant's
// session never carries the flag, so this file is inert for them.
(function () {
  var qp = new URLSearchParams(location.search);
  if (qp.get("demo") !== "1") return;

  // All baked into the sim URL by broker.loading_page(). `ppid` is the
  // session's real primary key in the broker's DB; `pid` (P01) is only a
  // display label and is NOT unique across sessions -- a run started with a
  // Prolific ID is keyed on that ID, not on local_p01, so sending the
  // P-number back would address a different row and the broker would reject
  // the swap as "P01 is already active".
  var broker = qp.get("broker");
  var ppid = qp.get("ppid");
  var label = (qp.get("pid") || "").match(/(\d+)/);
  if (!broker || !ppid) return;

  var ARMS = [
    { id: "sim", label: "Sim", hint: "live simulator, participant drives" },
    { id: "video", label: "Video", hint: "watch a recorded segment" },
    { id: "draw", label: "Draw", hint: "watch, then draw a path" },
  ];
  var current = (window.SUBT && window.SUBT.condition) || "sim";

  var style = document.createElement("style");
  style.textContent =
    // One above the study-flow overlay (2147483645) so the control stays
    // reachable on the consent/instruction/questionnaire pages too -- the
    // whole point is showing the workflow end to end in each arm.
    "#subt-demo{position:fixed;left:12px;bottom:12px;z-index:2147483646;" +
      "font:13px/1.4 sans-serif;background:rgba(20,20,24,.94);color:#eee;" +
      "border:1px solid #3a3a44;border-radius:8px;padding:8px 10px;" +
      "box-shadow:0 4px 14px rgba(0,0,0,.5);user-select:none}" +
    "#subt-demo .hd{font-size:10px;letter-spacing:.08em;text-transform:uppercase;" +
      "color:#8a8a96;margin-bottom:6px}" +
    "#subt-demo .arms{display:flex;gap:4px}" +
    "#subt-demo button{font:inherit;color:#ddd;background:#2a2a33;cursor:pointer;" +
      "border:1px solid #3a3a44;border-radius:5px;padding:5px 11px}" +
    "#subt-demo button:hover:not(:disabled){background:#343440;color:#fff}" +
    "#subt-demo button.on{background:#42a5f5;border-color:#42a5f5;color:#08121c;" +
      "font-weight:600;cursor:default}" +
    "#subt-demo button:disabled{opacity:.5;cursor:progress}" +
    "#subt-demo .ft{margin-top:6px;font-size:11px;color:#8a8a96;min-height:1.4em}";
  document.head.appendChild(style);

  var box = document.createElement("div");
  box.id = "subt-demo";
  var head = document.createElement("div");
  head.className = "hd";
  head.textContent = "Demo" + (label ? " · P" + ("0" + label[1]).slice(-2) : "");
  var arms = document.createElement("div");
  arms.className = "arms";
  var foot = document.createElement("div");
  foot.className = "ft";
  foot.textContent = "Switching restarts the session (~30s).";

  var buttons = [];
  ARMS.forEach(function (arm) {
    var b = document.createElement("button");
    b.textContent = arm.label;
    b.title = arm.hint;
    if (arm.id === current) b.className = "on";
    b.addEventListener("click", function () {
      if (arm.id === current) return;
      buttons.forEach(function (o) { o.disabled = true; });
      foot.textContent = "Restarting in " + arm.label.toLowerCase() + "…";
      // Fast-forward is not carried here: DEBUG is a broker-process env var,
      // so the relaunched session inherits whatever the broker was started
      // with. Nothing to pass through.
      var url = new URL(broker.replace(/\/+$/, "") + "/start");
      url.searchParams.set("PROLIFIC_PID", ppid);
      url.searchParams.set("condition", arm.id);
      location.href = url.toString();
    });
    buttons.push(b);
    arms.appendChild(b);
  });

  box.appendChild(head);
  box.appendChild(arms);
  box.appendChild(foot);

  function mount() { document.body.appendChild(box); }
  if (document.body) mount();
  else document.addEventListener("DOMContentLoaded", mount);
})();
