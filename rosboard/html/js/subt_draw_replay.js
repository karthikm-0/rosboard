"use strict";

// Replay + draw condition.
//
// CONDITION=draw is the browser analogue of the March OpenCV prototype:
// play a recorded segment, let the participant stop it, then draw a path on
// the lidar view. The drawn path is saved by rosboard's /paths/save endpoint.
(function () {
  if (!(window.SUBT && window.SUBT.isDraw)) return;

  var cfg = window.SUBT.drawReplay || {};
  var lidarTopic = cfg.lidarTopic || "/X1/points_preview";
  var segments = [];
  var currentSegment = null;
  var drawing = false;
  var pointerDown = false;
  var visible = false;
  var startedForThisView = false;
  var stoppedForDrawing = false;
  var points = [];
  var overlay = null;
  var pathLine = null;

  function el(tag, style, text) {
    var node = document.createElement(tag);
    if (style) Object.assign(node.style, style);
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function post(path, body) {
    return fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
    }).then(function (response) { return response.json(); });
  }

  var panel = el("div", {
    position: "fixed",
    // Placed by reposition() to span the sensor card group, matching the
    // segment replay controls.
    left: "50%",
    bottom: "16px",
    zIndex: "2147483646",
    background: "rgba(24,24,24,0.96)",
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
  }, "REPLAY PATH DRAWING"));

  var select = el("select", {
    width: "100%",
    padding: "5px",
    marginBottom: "8px",
    background: "#101010",
    color: "#e8e8e8",
    border: "1px solid #3a3a3a",
    borderRadius: "4px",
  });
  panel.appendChild(select);

  var row = el("div", { display: "flex", gap: "6px" });
  function button(label, color) {
    return el("button", {
      flex: "1",
      padding: "7px 8px",
      cursor: "pointer",
      background: color || "#232323",
      border: "1px solid " + (color || "#3a3a3a"),
      borderRadius: "4px",
      color: "#e8e8e8",
      fontWeight: "bold",
    }, label);
  }
  var stopButton = button("Stop and draw", "#b23b3b");
  var clearButton = button("Clear");
  var saveButton = button("Save", "#2e7d32");
  var continueButton = button("Continue", "#3f51b5");
  row.appendChild(stopButton);
  row.appendChild(clearButton);
  row.appendChild(saveButton);
  row.appendChild(continueButton);
  panel.appendChild(row);
  clearButton.style.display = "none";
  saveButton.style.display = "none";
  continueButton.style.display = "none";

  var status = el("div", {
    marginTop: "8px",
    fontSize: "11px",
    color: "#9a9a9a",
    minHeight: "14px",
  }, "loading segments...");
  panel.appendChild(status);

  function lidarCanvas() {
    var card = document.querySelector('.card[data-topic="' + lidarTopic + '"]');
    if (card) return card.querySelector("canvas");

    // Fallback for older/broken card tagging. The compass is also a canvas,
    // but it lives inside the camera card next to an <img>; ignore camera
    // cards and pick the largest remaining canvas, which is the lidar WebGL
    // viewer.
    var canvases = Array.prototype.slice.call(document.querySelectorAll(".card canvas"));
    var visibleCanvases = canvases.filter(function (canvas) {
      var r = canvas.getBoundingClientRect();
      var parentCard = canvas.closest(".card");
      var isCameraCard = parentCard && parentCard.querySelector("img");
      return !isCameraCard && r.width > 50 && r.height > 50;
    }).sort(function (a, b) {
      var ar = a.getBoundingClientRect();
      var br = b.getBoundingClientRect();
      return (br.width * br.height) - (ar.width * ar.height);
    });
    return visibleCanvases.length ? visibleCanvases[0] : null;
  }

  function ensureOverlay(silent) {
    var target = lidarCanvas();
    if (!target) {
      if (!silent) status.textContent = "waiting for lidar view...";
      return false;
    }
    if (!overlay) {
      overlay = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      overlay.style.position = "fixed";
      overlay.style.zIndex = "2147483645";
      overlay.style.pointerEvents = "none";
      overlay.style.touchAction = "none";
      overlay.style.cursor = "crosshair";
      overlay.style.background = "rgba(0,0,0,0.001)";
      overlay.style.border = "2px solid rgba(0,255,102,0.85)";
      overlay.style.boxSizing = "border-box";
      document.body.appendChild(overlay);
      pathLine = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
      pathLine.setAttribute("fill", "none");
      pathLine.setAttribute("stroke", "#00ff66");
      pathLine.setAttribute("stroke-width", "4");
      pathLine.setAttribute("stroke-linecap", "round");
      pathLine.setAttribute("stroke-linejoin", "round");
      pathLine.setAttribute("vector-effect", "non-scaling-stroke");
      pathLine.style.filter = "drop-shadow(0 0 3px rgba(0,0,0,0.9))";
      overlay.appendChild(pathLine);
      document.addEventListener("pointerdown", onPointerDown, true);
      document.addEventListener("pointermove", onPointerMove, true);
      document.addEventListener("pointerup", onPointerUp, true);
      window.addEventListener("resize", positionOverlay);
    }
    positionOverlay();
    return true;
  }

  function positionOverlay() {
    if (!overlay) return;
    var target = lidarCanvas();
    if (!target) {
      overlay.style.display = "none";
      return;
    }
    // Use the parent .card's bounding rect, not the canvas's. Space3DViewer
    // sizes its canvas as a square that matches the card WIDTH -- so on a
    // 4:3 card the canvas overflows vertically. The card clips it visually
    // via overflow:hidden, but the canvas's getBoundingClientRect still
    // reports the taller-than-card size, and the green border would draw
    // where the canvas thinks it is (off the bottom of the card). Anchoring
    // to the card makes the border match the visible clipped region.
    var card = target.closest(".card") || target;
    var r = card.getBoundingClientRect();
    overlay.style.display = panel.style.display === "none" ? "none" : "block";
    overlay.style.left = r.left + "px";
    overlay.style.top = r.top + "px";
    overlay.style.width = r.width + "px";
    overlay.style.height = r.height + "px";
    overlay.setAttribute("width", Math.max(1, Math.round(r.width)));
    overlay.setAttribute("height", Math.max(1, Math.round(r.height)));
    overlay.setAttribute("viewBox", "0 0 " + Math.max(1, r.width) + " " + Math.max(1, r.height));
    redraw();
  }

  function localPoint(event) {
    var r = overlay.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(r.width, event.clientX - r.left)),
      y: Math.max(0, Math.min(r.height, event.clientY - r.top)),
      nx: r.width ? (event.clientX - r.left) / r.width : 0,
      ny: r.height ? (event.clientY - r.top) / r.height : 0,
      t: Date.now() / 1000,
    };
  }

  function isInsideOverlay(event) {
    if (!overlay) return false;
    var r = overlay.getBoundingClientRect();
    return event.clientX >= r.left && event.clientX <= r.right
      && event.clientY >= r.top && event.clientY <= r.bottom;
  }

  function redraw() {
    if (!pathLine) return;
    pathLine.setAttribute("points", points.map(function (p) {
      return p.x.toFixed(1) + "," + p.y.toFixed(1);
    }).join(" "));
  }

  function onPointerDown(event) {
    if (!drawing || !isInsideOverlay(event)) return;
    event.preventDefault();
    event.stopPropagation();
    pointerDown = true;
    points = [localPoint(event)];
    redraw();
  }

  function onPointerMove(event) {
    if (!drawing || !pointerDown || !points.length) return;
    event.preventDefault();
    event.stopPropagation();
    points.push(localPoint(event));
    redraw();
  }

  function onPointerUp(event) {
    if (drawing && pointerDown) {
      event.preventDefault();
      event.stopPropagation();
    }
    pointerDown = false;
    if (!drawing) return;
    redraw();
  }

  function enterDrawing(attempt) {
    attempt = attempt || 0;
    if (!ensureOverlay()) {
      if (attempt < 20) setTimeout(function () { enterDrawing(attempt + 1); }, 100);
      return;
    }
    drawing = true;
    pointerDown = false;
    overlay.style.pointerEvents = "none";
    overlay.style.borderColor = "rgba(0,255,102,0.85)";
    stopButton.style.display = "none";
    clearButton.style.display = "block";
    saveButton.style.display = "block";
    continueButton.style.display = "none";
    status.textContent = "draw a path on the lidar, then Save";
  }

  function exitDrawing() {
    drawing = false;
    if (overlay) {
      overlay.style.pointerEvents = "none";
      overlay.style.borderColor = "rgba(0,255,102,0.25)";
    }
    stopButton.style.display = "block";
    clearButton.style.display = "none";
    saveButton.style.display = "none";
    continueButton.style.display = "none";
  }

  function showSavedState(count) {
    drawing = false;
    pointerDown = false;
    if (overlay) {
      overlay.style.pointerEvents = "none";
      overlay.style.borderColor = "rgba(0,255,102,0.25)";
    }
    stopButton.style.display = "none";
    clearButton.style.display = "none";
    saveButton.style.display = "none";
    continueButton.style.display = "block";
    status.textContent = "saved " + count + " points; continue when ready";
  }

  function continueTrial() {
    var flowButton = document.querySelector(".subt-flow-button");
    if (flowButton) {
      flowButton.click();
    } else {
      status.textContent = "saved; use the study Continue button to advance";
    }
  }

  function describe(segment) {
    var duration = segment.duration ? segment.duration.toFixed(1) + "s" : "?";
    return segment.name + " (" + duration + ")";
  }

  function loadSegments() {
    return fetch("/segments/list")
      .then(function (response) { return response.json(); })
      .then(function (data) {
        segments = data.segments || [];
        select.innerHTML = "";
        segments.forEach(function (segment) {
          var option = document.createElement("option");
          option.value = segment.name;
          option.textContent = describe(segment);
          select.appendChild(option);
        });
        stopButton.disabled = !segments.length;
        saveButton.disabled = true;
        status.textContent = segments.length
          ? "ready"
          : "no segments in " + (data.segment_dir || "?");
      })
      .catch(function (error) {
        status.textContent = "could not list segments: " + error;
      });
  }

  function startPlayback() {
    if (!select.value) return;
    exitDrawing();
    stoppedForDrawing = false;
    points = [];
    if (overlay) redraw();
    currentSegment = select.value;
    status.textContent = "playing " + currentSegment + "...";
    post("/segments/play", { name: currentSegment })
      .then(function (data) {
        if (!data.ok) status.textContent = "error: " + (data.error || data.message);
        else saveButton.disabled = false;
      })
      .catch(function (error) { status.textContent = "play failed: " + error; });
  }

  stopButton.addEventListener("click", function () {
    stoppedForDrawing = true;
    post("/segments/stop", {}).catch(function () {}).then(function () {
      enterDrawing();
    });
  });

  clearButton.addEventListener("click", function () {
    points = [];
    redraw();
    status.textContent = drawing ? "path cleared" : "cleared";
  });

  saveButton.addEventListener("click", function () {
    if (!points.length) {
      status.textContent = "draw a path before saving";
      return;
    }
    var target = lidarCanvas();
    var r = target ? target.getBoundingClientRect() : { width: 0, height: 0 };
    post("/paths/save", {
      segment: currentSegment || select.value,
      topic: lidarTopic,
      canvas: { width: r.width, height: r.height },
      points: points,
    }).then(function (data) {
      if (data.ok) {
        showSavedState(data.count);
      } else {
        status.textContent = "save failed: " + (data.error || data.message);
      }
    }).catch(function (error) {
      status.textContent = "save failed: " + error;
    });
  });

  continueButton.addEventListener("click", continueTrial);

  function shouldShow() {
    var flow = window.SUBT && window.SUBT.studyFlow;
    if (!flow || !flow.enabled) return true;
    return !!(window.SUBT && window.SUBT.viewerActive
      && document.querySelector(".subt-flow-button"));
  }

  function updateVisibility() {
    var nowVisible = shouldShow();
    if (!nowVisible) {
      startedForThisView = false;
      stoppedForDrawing = false;
      exitDrawing();
    }
    panel.style.display = nowVisible ? "block" : "none";
    if (overlay) overlay.style.display = panel.style.display;
    if (panel.style.display === "block") {
      visible = true;
      ensureOverlay(true);
      positionOverlay();
      reposition();
      if (!startedForThisView && !stoppedForDrawing && segments.length) {
        startedForThisView = true;
        startPlayback();
      }
    } else {
      visible = false;
    }
  }

  function reposition() {
    if (panel.style.display === "none") return;
    var cards = document.querySelectorAll(".grid .card");
    if (!cards.length) {
      panel.style.left = "50%";
      panel.style.width = "auto";
      panel.style.transform = "translateX(-50%)";
      panel.style.top = "auto";
      panel.style.bottom = "16px";
      return;
    }
    var minLeft = Infinity;
    var maxRight = -Infinity;
    var maxBottom = 0;
    cards.forEach(function (card) {
      var b = card.getBoundingClientRect();
      if (!b.width) return;
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
    var maxTop = window.innerHeight - panel.offsetHeight - 12;
    var top = Math.min(maxBottom + 12, maxTop);
    panel.style.left = minLeft + "px";
    panel.style.width = (maxRight - minLeft) + "px";
    panel.style.transform = "none";
    panel.style.boxSizing = "border-box";
    panel.style.top = Math.max(12, top) + "px";
    panel.style.bottom = "auto";
  }

  function install() {
    document.body.appendChild(panel);
    loadSegments();
    reposition();
    window.addEventListener("resize", reposition);
    var grid = document.querySelector(".grid");
    if (grid && window.ResizeObserver) {
      new ResizeObserver(reposition).observe(grid);
    }
    var settle = 0;
    var settleTimer = setInterval(function () {
      reposition();
      if (++settle > 20) clearInterval(settleTimer);
    }, 500);
    setInterval(updateVisibility, 250);
    setInterval(function () {
      if (visible) reposition();
      if (drawing || (overlay && overlay.style.display !== "none")) positionOverlay();
    }, 500);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", install);
  } else {
    install();
  }
})();
