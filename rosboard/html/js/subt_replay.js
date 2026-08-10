"use strict";

// Segment replay picker for the observer condition.
//
// The participant is not driving here: they watch a recorded autonomous
// approach up to the point the robot stops at the takeover location. Playback
// is server-side (`ros2 bag play`), which republishes the recorded topics onto
// the live graph, so the normal rosboard viewers render the replay with no
// changes. This panel only chooses which segment runs.
//
// Enable via window.SUBT.replay.enabled in subt_config.js. It stays hidden in
// the driving condition so participants never see a transport control.

(function () {
  const config = (window.SUBT && window.SUBT.replay) || {};
  // "auto" (the default) shows the picker only when the container was launched
  // with MODE=replay, so the driving conditions never get a transport control
  // and the two settings cannot drift apart. true/false force it either way.
  const gate = config.enabled === undefined ? "auto" : config.enabled;
  if (gate === false) return;

  const POLL_MS = config.pollMs || 500;
  let segments = [];
  let playing = false;

  function el(tag, style, text) {
    const node = document.createElement(tag);
    if (style) Object.assign(node.style, style);
    if (text !== undefined) node.textContent = text;
    return node;
  }

  const panel = el("div", {
    position: "fixed",
    left: "16px",
    bottom: "16px",
    // Above the study-flow overlay (2147483645) and the practice button
    // (999999). This is a debug control that has to stay reachable even while
    // a flow screen is up, so it deliberately sits on top of everything.
    zIndex: "2147483646",
    background: "rgba(24,24,24,0.95)",
    border: "1px solid #3a3a3a",
    borderRadius: "6px",
    padding: "10px 12px",
    font: "13px sans-serif",
    color: "#e8e8e8",
    boxShadow: "0 4px 16px rgba(0,0,0,0.5)",
    minWidth: "260px",
  });

  panel.appendChild(el("div", {
    fontWeight: "bold",
    marginBottom: "8px",
    fontSize: "12px",
    letterSpacing: "0.04em",
    color: "#bdbdbd",
  }, "SEGMENT REPLAY"));

  const select = el("select", {
    width: "100%",
    padding: "5px",
    marginBottom: "8px",
    background: "#101010",
    color: "#e8e8e8",
    border: "1px solid #3a3a3a",
    borderRadius: "4px",
  });
  panel.appendChild(select);

  const buttonRow = el("div", { display: "flex", gap: "6px" });
  const playButton = el("button", { flex: "1", padding: "6px", cursor: "pointer" }, "Play");
  const stopButton = el("button", { flex: "1", padding: "6px", cursor: "pointer" }, "Stop");
  buttonRow.appendChild(playButton);
  buttonRow.appendChild(stopButton);
  panel.appendChild(buttonRow);

  const status = el("div", {
    marginTop: "8px",
    fontSize: "11px",
    color: "#9a9a9a",
    minHeight: "14px",
  }, "loading segments...");
  panel.appendChild(status);

  function describe(segment) {
    const duration = segment.duration ? segment.duration.toFixed(1) + "s" : "?";
    // Surface a truncated recording so a bad stimulus is obvious in the list
    // rather than discovered mid-trial.
    const suspect = segment.stop_reason && segment.stop_reason !== "arrived_at_takeover";
    return segment.name + "  (" + duration + (suspect ? ", " + segment.stop_reason : "") + ")";
  }

  function loadSegments() {
    return fetch("/segments/list")
      .then((response) => response.json())
      .then((data) => {
        // Under "auto", any condition other than video gets no picker at all.
        if (gate === "auto" && data.condition !== "video") {
          panel.remove();
          return false;
        }
        segments = data.segments || [];
        select.innerHTML = "";
        if (!segments.length) {
          status.textContent = "no segments in " + (data.segment_dir || "?");
          playButton.disabled = true;
          return true;
        }
        segments.forEach((segment) => {
          const option = document.createElement("option");
          option.value = segment.name;
          option.textContent = describe(segment);
          select.appendChild(option);
        });
        playButton.disabled = false;
        status.textContent = segments.length + " segment(s) available";
        return true;
      })
      .catch((error) => {
        status.textContent = "could not list segments: " + error;
        return false;
      });
  }

  function post(path, body) {
    return fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
    }).then((response) => response.json());
  }

  playButton.addEventListener("click", () => {
    if (!select.value) return;
    status.textContent = "starting " + select.value + "...";
    post("/segments/play", { name: select.value, loop: !!config.loop })
      .then((data) => {
        if (!data.ok) status.textContent = "error: " + (data.error || data.message);
      })
      .catch((error) => {
        status.textContent = "play failed: " + error;
      });
  });

  stopButton.addEventListener("click", () => {
    post("/segments/stop").catch(() => {});
  });

  function poll() {
    fetch("/segments/status")
      .then((response) => response.json())
      .then((data) => {
        playing = !!data.playing;
        playButton.disabled = playing || !segments.length;
        stopButton.disabled = !playing;
        if (playing) {
          const elapsed = data.elapsed !== null ? data.elapsed.toFixed(1) : "?";
          const total = data.duration ? data.duration.toFixed(1) : "?";
          status.textContent = "playing " + data.segment + "  " + elapsed + "s / " + total + "s";
        } else if (segments.length) {
          status.textContent = segments.length + " segment(s) available";
        }
      })
      .catch(() => {});
  }

  // The study flow plays whatever the operator has selected here, so the
  // selection has to be readable from outside this module.
  window.SUBT.getSelectedSegment = function () {
    return select.value || (segments.length ? segments[0].name : null);
  };

  function install() {
    document.body.appendChild(panel);
    // Only poll once the picker is confirmed to belong on this page; a
    // non-replay session removes the panel and should stay completely inert.
    loadSegments().then((active) => {
      if (active) setInterval(poll, POLL_MS);
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", install);
  } else {
    install();
  }
})();
