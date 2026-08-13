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

  // 250ms keeps the playhead visibly smooth; the status call is cheap.
  const POLL_MS = config.pollMs || 250;
  // Material indigo -- the accent the rest of the board already uses.
  const ACCENT = "#3f51b5";
  const SKIP_SEC = 5;

  // Material-style transport glyphs, drawn as SVG so they render identically
  // everywhere; unicode media characters fall back to wildly different shapes
  // (or tofu) depending on the installed fonts.
  const ICONS = {
    play: "M8 5v14l11-7z",
    pause: "M6 19h4V5H6v14zm8-14v14h4V5h-4z",
    back: "M11 18V6l-8.5 6 8.5 6zm.5-6l8.5 6V6l-8.5 6z",
    forward: "M4 18l8.5-6L4 6v12zm9-12v12l8.5-6L13 6z",
  };

  function iconButton(iconName, title, onClick) {
    const button = el("button", {
      flex: "1",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      padding: "6px 0",
      cursor: "pointer",
      background: "#232323",
      border: "1px solid #3a3a3a",
      borderRadius: "4px",
      color: "#e8e8e8",
    });
    button.title = title;
    button.appendChild(makeIcon(iconName));
    button.addEventListener("click", onClick);
    return button;
  }

  function makeIcon(name) {
    const NS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("width", "18");
    svg.setAttribute("height", "18");
    const path = document.createElementNS(NS, "path");
    path.setAttribute("d", ICONS[name]);
    path.setAttribute("fill", "currentColor");
    svg.appendChild(path);
    return svg;
  }

  function setIcon(button, name) {
    button.replaceChildren(makeIcon(name));
  }
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
    // Placed by reposition() to span the full card-grid width (camera left
    // edge to lidar right edge). left/width/bottom overwritten there.
    left: "50%",
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

  // --- scrub bar -----------------------------------------------------
  // Range input rather than a custom canvas: it gives keyboard access and
  // native drag handling for free. `input` fires continuously while dragging,
  // so seeks are issued on `change` (release) to avoid flooding the player,
  // with the label tracking the handle live so the drag still feels direct.
  const scrub = el("input", {
    width: "100%",
    margin: "2px 0 4px 0",
    cursor: "pointer",
    // Without this the range input uses the browser/OS default accent, which
    // is where the stray pink came from. #3f51b5 is the indigo the rest of
    // the board already uses (joystick, controls).
    accentColor: ACCENT,
  });
  scrub.type = "range";
  scrub.min = 0;
  scrub.max = 1000;
  scrub.value = 0;
  scrub.disabled = true;
  panel.appendChild(scrub);

  const timeRow = el("div", {
    display: "flex", justifyContent: "space-between",
    fontSize: "11px", color: "#c8c8c8", marginBottom: "6px",
  });
  const timeNow = el("span", null, "0:00.0");
  const timeTotal = el("span", null, "0:00.0");
  timeRow.appendChild(timeNow);
  timeRow.appendChild(timeTotal);
  panel.appendChild(timeRow);

  let scrubbing = false;
  let duration = 0;
  let loadedSegment = null;
  // While the server is switching segments, its /status still reports the
  // OLD segment's duration/position for a beat -- if we render off it, the
  // scrubber jerks against a stale playhead. Set on switch, cleared once
  // the poll sees the new segment loaded.
  let pendingSegment = null;
  // Latest playhead, so the skip buttons seek relative to where playback
  // actually is rather than to the last place the handle was dragged.
  let currentPosition = 0;

  function fmt(s) {
    s = Math.max(0, s || 0);
    return Math.floor(s / 60) + ":" + (s % 60).toFixed(1).padStart(4, "0");
  }

  // Seek live while dragging so the sensor views repaint to the frame under
  // the handle, the way a video scrubber does. Throttled and single-flight:
  // `input` fires far faster than a seek round-trip, and queueing them would
  // leave the view chasing the drag long after the handle stopped.
  let seekInFlight = false;
  let pendingSeek = null;
  let lastSeekAt = 0;
  // Min gap between seek POSTs while dragging. Sized so each scrub burst
  // (SCRUB_BURST_SIZE = ~150 msgs of camera+lidar+tf+clock through the
  // GIL-bound rosbridge pipeline) has time to finish before the next fires.
  // Too small -> bursts pile up, camera and lidar visibly desync. The drag
  // itself stays live because the thumb + time label update on every
  // `input` event locally, independent of the seek round-trip.
  const SEEK_MIN_MS = 500;

  function flushSeek() {
    if (seekInFlight || pendingSeek === null) return;
    const now = Date.now();
    if (now - lastSeekAt < SEEK_MIN_MS) {
      setTimeout(flushSeek, SEEK_MIN_MS - (now - lastSeekAt));
      return;
    }
    const offset = pendingSeek;
    pendingSeek = null;
    seekInFlight = true;
    lastSeekAt = now;
    const wasScrub = pendingScrub;
    pendingScrub = false;
    post("/segments/seek", { offset: offset, scrub: wasScrub })
      .catch(function () {})
      .then(function () {
        seekInFlight = false;
        flushSeek();
      });
  }

  function requestSeek(offset, scrub) {
    pendingSeek = offset;
    pendingScrub = !!scrub;                          // pass-through to server
    flushSeek();
  }
  let pendingScrub = false;

  // YouTube-style scrub:
  //  - Grabbing the handle pauses playback if it was running (so the video
  //    isn't advancing under the cursor). Resume is up to the user via play.
  //  - Every `input` fires a LIGHT seek (scrub=true) -- server does a tiny
  //    burst so frames update at the handle position, cheaply enough that
  //    dragging stays smooth even with the camera on.
  //  - `change` (release) fires a FULL seek (scrub=false) for a clean snap
  //    with all slow topics (lidar) refreshed.
  let wasPlayingBeforeScrub = false;
  let currentlyPaused = true;                       // updated on every /status poll
  scrub.addEventListener("mousedown", function () {
    wasPlayingBeforeScrub = !currentlyPaused;
    if (wasPlayingBeforeScrub) post("/segments/toggle", {}).catch(function () {});
  });
  scrub.addEventListener("touchstart", function () {
    wasPlayingBeforeScrub = !currentlyPaused;
    if (wasPlayingBeforeScrub) post("/segments/toggle", {}).catch(function () {});
  }, { passive: true });
  scrub.addEventListener("input", function () {
    scrubbing = true;
    if (!duration) return;
    const offset = (scrub.value / 1000) * duration;
    timeNow.textContent = fmt(offset);
    requestSeek(offset, true);                       // scrub=true -> tiny burst
  });
  scrub.addEventListener("change", function () {
    scrubbing = false;
    if (duration) requestSeek((scrub.value / 1000) * duration, false);   // full burst
    // Resume playback if the user grabbed the handle while playing. Small
    // delay so the final seek+burst above lands before the toggle unpauses.
    if (wasPlayingBeforeScrub) {
      wasPlayingBeforeScrub = false;
      setTimeout(function () {
        post("/segments/toggle", {}).catch(function () {});
      }, 150);
    }
  });

  // One button for play/pause, as in any video player: it starts the selected
  // segment when nothing is loaded and toggles from then on.
  const buttonRow = el("div", { display: "flex", gap: "6px", alignItems: "stretch" });

  function skip(delta) {
    if (!duration) return;
    const target = Math.max(0, Math.min(duration, currentPosition + delta));
    scrub.value = Math.round((target / duration) * 1000);
    timeNow.textContent = fmt(target);
    requestSeek(target);
  }

  const backButton = iconButton("back", "Back " + SKIP_SEC + "s", () => skip(-SKIP_SEC));
  const playButton = iconButton("play", "Play / Pause", onPlayPause);
  const forwardButton = iconButton("forward", "Forward " + SKIP_SEC + "s", () => skip(SKIP_SEC));
  playButton.style.flex = "2";
  playButton.style.background = ACCENT;
  playButton.style.borderColor = ACCENT;

  buttonRow.appendChild(backButton);
  buttonRow.appendChild(playButton);
  buttonRow.appendChild(forwardButton);
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

  // Kick a segment switch: reset UI immediately, stop old, start new (paused
  // if requested). Poll will pick up the real state once the server transitions.
  function loadSegment(name, paused) {
    if (!name) return;
    pendingSegment = name;
    // Zero the scrub UI right now so the playhead doesn't limp across the
    // OLD segment's timeline while the server unloads it.
    scrub.value = 0;
    duration = 0;
    currentPosition = 0;
    timeNow.textContent = fmt(0);
    timeTotal.textContent = fmt(0);
    scrub.disabled = true;
    status.textContent = (paused ? "loading " : "starting ") + name + "...";
    post("/segments/play", { name: name, loop: !!config.loop, paused: !!paused })
      .then((data) => {
        if (!data.ok) {
          status.textContent = "error: " + (data.error || data.message);
          pendingSegment = null;
        }
      })
      .catch((error) => {
        status.textContent = "play failed: " + error;
        pendingSegment = null;
      });
  }

  function onPlayPause() {
    // Already on this segment -> plain toggle. Otherwise start the picked one.
    if (playing && select.value === loadedSegment) {
      post("/segments/toggle", {}).catch(function () {});
      return;
    }
    loadSegment(select.value, false);            // play immediately
  }

  // Picking a different segment in the dropdown auto-loads it PAUSED. No need
  // to press play just to see the switch happen -- the old one unloads right
  // away, the new one primes at frame 0. Press play (or scrub) to interact.
  select.addEventListener("change", function () {
    if (!select.value || select.value === loadedSegment) return;
    loadSegment(select.value, true);
  });

  function poll() {
    fetch("/segments/status")
      .then((response) => response.json())
      .then((data) => {
        playing = !!data.playing;
        loadedSegment = playing ? data.segment : null;
        playButton.disabled = !segments.length;
        backButton.disabled = !playing;
        forwardButton.disabled = !playing;
        scrub.disabled = !playing;

        // During a switch, the server may still report the OLD segment for a
        // beat. Ignore its numbers until it confirms the pending segment is
        // loaded -- prevents the playhead from limping on the stale timeline.
        if (pendingSegment && data.segment !== pendingSegment) {
          return;
        }
        pendingSegment = null;
        if (playing) {
          duration = data.duration || 0;
          currentPosition = data.position || 0;
          currentlyPaused = !!data.paused;                 // tracked for scrub-pause
          setIcon(playButton, data.paused ? "play" : "pause");
          timeTotal.textContent = fmt(duration);
          // Never fight the user's hand: while dragging, the handle and the
          // time label are driven by the drag, not by the poll.
          if (!scrubbing && duration) {
            scrub.value = Math.round((data.position / duration) * 1000);
            timeNow.textContent = fmt(data.position);
          }
          status.textContent = data.segment
            + (data.paused ? "  [paused]" : "")
            + (data.rate && data.rate !== 1 ? "  " + data.rate.toFixed(2) + "x" : "");
        } else {
          duration = 0;
          currentPosition = 0;
          setIcon(playButton, "play");
          scrub.value = 0;
          timeNow.textContent = fmt(0);
          timeTotal.textContent = fmt(0);
          if (segments.length) {
            status.textContent = segments.length + " segment(s) available";
          }
        }
      })
      .catch(() => {});
  }

  // The study flow plays whatever the operator has selected here, so the
  // selection has to be readable from outside this module.
  window.SUBT.getSelectedSegment = function () {
    return select.value || (segments.length ? segments[0].name : null);
  };

  // Keep the player centred under the sensor cards at any window size.
  // Anchors to the .grid that holds them (subt_layout.js centres it with
  // `margin: auto`), so the player tracks the cards rather than the viewport
  // if the two ever diverge. Falls back to viewport-bottom-centre when the
  // grid is absent, and clamps so a tall grid can never push the controls
  // off-screen.
  // The panel lives on document.body, so without this it would sit on top of
  // consent, instructions and questionnaire screens too. The study flow
  // already marks when a sensor viewer is on screen; the controls belong only
  // to those steps. With no study flow (plain rosboard) there is nothing to
  // hide behind, so it stays visible.
  function shouldShow() {
    const flow = window.SUBT && window.SUBT.studyFlow;
    if (!flow || !flow.enabled) return true;
    return !!(window.SUBT && window.SUBT.viewerActive);
  }

  // Show/hide the segment DROPDOWN. Only visible in DEBUG mode -- production
  // participants must not be able to swap the config the trial is running.
  // Scrub bar, play/pause, and skip buttons stay visible for participant use.
  function updateSelectVisibility() {
    const dbg = window.SUBT && typeof window.SUBT.isDebugMode === "function"
      && window.SUBT.isDebugMode();
    select.style.display = dbg ? "" : "none";
  }

  function updateVisibility() {
    const show = shouldShow();
    panel.style.display = show ? "block" : "none";
    return show;
  }

  function reposition() {
    if (panel.style.display === "none") return;
    // Measure the actual card elements, not the .grid container (which
    // spans the whole page width). Find leftmost and rightmost cards; the
    // panel spans between their outer edges.
    const cards = document.querySelectorAll(".grid .card");
    if (!cards.length) {
      panel.style.left = "50%";
      panel.style.width = "auto";
      panel.style.transform = "translateX(-50%)";
      panel.style.top = "auto";
      panel.style.bottom = "16px";
      return;
    }
    let minLeft = Infinity, maxRight = -Infinity, maxBottom = 0;
    cards.forEach(function (c) {
      const b = c.getBoundingClientRect();
      if (!b.width) return;                           // hidden / not laid out
      if (b.left < minLeft) minLeft = b.left;
      if (b.right > maxRight) maxRight = b.right;
      if (b.bottom > maxBottom) maxBottom = b.bottom;
    });
    if (!isFinite(minLeft) || !isFinite(maxRight)) {
      panel.style.left = "50%";
      panel.style.width = "auto";
      panel.style.transform = "translateX(-50%)";
      panel.style.top = "auto";
      panel.style.bottom = "16px";
      return;
    }
    const maxTop = window.innerHeight - panel.offsetHeight - 12;
    const top = Math.min(maxBottom + 12, maxTop);
    panel.style.left = minLeft + "px";
    panel.style.width = (maxRight - minLeft) + "px";
    panel.style.transform = "none";
    panel.style.boxSizing = "border-box";
    panel.style.top = Math.max(12, top) + "px";
    panel.style.bottom = "auto";
  }

  function install() {
    document.body.appendChild(panel);
    updateVisibility();
    updateSelectVisibility();
    reposition();
    window.addEventListener("resize", reposition);
    // The grid resizes when cards appear, when a viewer swaps type, or when
    // the study flow shows/hides the shell -- none of which fire `resize`.
    const grid = document.querySelector(".grid");
    if (grid && window.ResizeObserver) {
      new ResizeObserver(reposition).observe(grid);
    }
    // Cards are created after this script runs, so re-check for a while.
    let settle = 0;
    const settleTimer = setInterval(function () {
      reposition();
      if (++settle > 20) clearInterval(settleTimer);
    }, 500);
    // viewerActive flips as the flow moves between steps, with no event to
    // listen for, so it is polled. Cheap: a boolean read and a style write.
    setInterval(function () {
      updateSelectVisibility();
      if (updateVisibility()) reposition();
    }, 250);
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
