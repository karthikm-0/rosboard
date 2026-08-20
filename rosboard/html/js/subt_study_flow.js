"use strict";

// High-level participant procedure. This layer renders consent/instruction/
// questionnaire pages and calls window.SUBT.experimentController for robot
// trials. The ROS runner remains the lower-level trial executor.
(function () {
  var cfg = (window.SUBT && window.SUBT.studyFlow) || {};
  if (!cfg.enabled) return;
  var aborted = false;
  var textCache = {};

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $all(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  function initWhenReady() {
    if (!(window.SUBT && window.SUBT.experimentController)) {
      setTimeout(initWhenReady, 100);
      return;
    }
    start().catch(function (err) {
      console.error("study flow failed", err);
      showRawPage("<h1>Study Flow Error</h1><p>" + escapeHtml(String(err)) + "</p>", "Close");
    });
  }

  function flowPath() {
    var qp = new URLSearchParams(location.search);
    var fromUrl = qp.get("flow");
    if (fromUrl && fromUrl !== "off") return "study_flows/" + fromUrl.replace(/\.json$/, "") + ".json";
    return cfg.flowFile || "study_flows/operator_readiness_pilot.json";
  }

  function conditionOrder(flow) {
    var qp = new URLSearchParams(location.search);
    var raw = qp.get("condition_order") || qp.get("order") || "";
    var order = raw ? raw.split(/[,\s-]+/).join("").toUpperCase().split("") : null;
    if (!order || order.length < 2) order = cfg.conditionOrder || flow.defaultConditionOrder || ["D", "R"];
    return order.map(function (c) { return c.toUpperCase(); }).filter(function (c) { return c === "D" || c === "R"; });
  }

  function getCondition(order, slot) {
    return order[Math.max(0, slot - 1)] || order[0] || "D";
  }

  function reportWhenReadySliderEnabled() {
    return cfg.reportWhenReadySliderEnabled === true;
  }

  function contentForCondition(prefix, condition) {
    return "content/" + prefix + "_" + condition.toLowerCase() + (prefix === "task" ? "_intro" : "_instructions") + ".html";
  }

  function fetchText(path) {
    if (!textCache[path]) {
      textCache[path] = fetch(path, { cache: "no-store" }).then(function (r) {
        if (!r.ok) throw new Error("Could not load " + path + " (" + r.status + ")");
        return r.text();
      });
    }
    return textCache[path];
  }

  function preloadImage(path) {
    var img = new Image();
    img.src = path;
  }

  function preloadVideo(path) {
    var video = document.createElement("video");
    video.preload = "auto";
    video.muted = true;
    video.src = path;
    try { video.load(); } catch (e) {}
  }

  function preloadFlowContent(flow) {
    var paths = {};
    (flow.steps || []).forEach(function (step) {
      if (step.content) paths[step.content] = true;
    });
    ["D", "R"].forEach(function (condition) {
      paths[contentForCondition("task", condition)] = true;
      paths[contentForCondition("set", condition)] = true;
    });
    Object.keys(paths).forEach(function (path) {
      fetchText(path).catch(function (err) {
        console.warn("study-flow preload failed", path, err);
      });
    });
    preloadImage("assets/instructions/whackamole_preview.png");
    preloadImage("assets/instructions/RobotDrivingTask.png");
    preloadImage("assets/instructions/YourRobotDrivingTask.png");
    preloadImage("assets/instructions/joystick_preview.png");
    preloadVideo("assets/instructions/RobotConsoleLoop.mp4");
    preloadVideo("assets/instructions/ReportConditionTraining.mp4");
  }

  function fetchJson(path) {
    return fetch(path, { cache: "no-store" }).then(function (r) {
      if (!r.ok) throw new Error("Could not load " + path + " (" + r.status + ")");
      return r.json();
    });
  }

  function ensureShell() {
    var shell = $(".subt-flow-shell");
    if (shell) return shell;
    shell = document.createElement("div");
    shell.className = "subt-flow-shell";
    shell.innerHTML = '<div class="subt-flow-panel"></div>';
    document.body.appendChild(shell);
    return shell;
  }

  function panel() { return $(".subt-flow-panel", ensureShell()); }

  function hideShell() {
    var shell = $(".subt-flow-shell");
    if (shell) shell.style.display = "none";
  }

  function abortFlow() {
    aborted = true;
    var shell = $(".subt-flow-shell");
    if (shell) {
      try { shell.remove(); } catch (e) { shell.style.display = "none"; }
    }
  }

  function showShell() {
    ensureShell().style.display = "flex";
  }

  function applyVariant(root, variant) {
    if (!variant) return;
    $all("[data-variant]", root).forEach(function (el) {
      el.style.display = el.getAttribute("data-variant") === variant ? "" : "none";
    });
  }

  // Broker + participant from URL params (broker sets them when redirecting
  // to the sim). Both required for /collect; without them we log-only.
  function collectContext() {
    var qp = new URLSearchParams(location.search);
    return {
      brokerUrl: (qp.get("broker") || "").replace(/\/$/, ""),
      pid: qp.get("pid") || "",
    };
  }

  function collectFields(root, kind) {
    var data = {};
    $all("input, textarea, select", root).forEach(function (el) {
      if (!el.name) return;
      if ((el.type === "radio" || el.type === "checkbox") && !el.checked) return;
      data[el.name] = el.type === "checkbox" ? !!el.checked : el.value;
    });
    console.log("study-flow data", kind || "(no-kind)", data);
    // Persist to broker/data/<PID>/responses.jsonl. Best-effort: a POST failure
    // (broker down, network hiccup) never blocks flow progression -- the
    // console.log above is the local fallback log.
    var ctx = collectContext();
    if (ctx.brokerUrl && ctx.pid) {
      var payload = { kind: kind || "unknown" };
      var ec = window.SUBT && window.SUBT.experimentController;
      if (ec && typeof ec.currentTrial === "function") payload.trial = ec.currentTrial();
      Object.keys(data).forEach(function (k) { payload[k] = data[k]; });
      fetch(ctx.brokerUrl + "/collect?pid=" + encodeURIComponent(ctx.pid), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      }).catch(function (e) { console.warn("collect POST failed", e); });
    }
    return data;
  }

  function wireConditionalFields(root) {
    $all("[data-show-if]", root).forEach(function (el) {
      var spec = el.getAttribute("data-show-if") || "";
      var parts = spec.split(":");
      if (parts.length !== 2) return;
      var name = parts[0];
      var accepted = parts[1].split(",").map(function (s) { return s.trim(); });
      var sync = function () {
        var checked = $('input[name="' + name + '"]:checked', root);
        var show = checked && accepted.indexOf(checked.value) >= 0;
        el.style.visibility = show ? "" : "hidden";
        el.style.pointerEvents = show ? "" : "none";
        el.setAttribute("aria-hidden", show ? "false" : "true");
        $all("input, textarea, select", el).forEach(function (field) {
          field.disabled = !show;
        });
        if (!show) {
          $all("input, textarea, select", el).forEach(function (field) {
            if (field.type === "radio" || field.type === "checkbox") field.checked = false;
            else field.value = "";
          });
        }
      };
      $all('input[name="' + name + '"]', root).forEach(function (input) {
        input.addEventListener("change", sync);
      });
      sync();
    });
  }

  function wireConsent(root) {
    var agree = $("[data-flow-consent]", root);
    var proceed = $('[data-flow-action="proceed"]', root);
    var exit = $('[data-flow-action="exit"]', root);
    if (agree && proceed) {
      var syncProceed = function () { proceed.disabled = !agree.checked; };
      syncProceed();
      agree.addEventListener("input", syncProceed);
      agree.addEventListener("change", syncProceed);
      agree.addEventListener("click", function () { setTimeout(syncProceed, 0); });
    }
    if (exit) exit.addEventListener("click", function (e) {
      e.preventDefault();
      e.stopPropagation();
      if (e.stopImmediatePropagation) e.stopImmediatePropagation();
      abortFlow();
      window.SUBT.experimentController.exitStudy();
    });
  }

  function renderHtml(html, opts) {
    opts = opts || {};
    setViewerActive(false);
    showShell();
    panel().innerHTML = html;
    applyVariant(panel(), opts.variant);
    wireConditionalFields(panel());
    wireConsent(panel());
    return panel();
  }

  function showContent(path, opts) {
    opts = opts || {};
    return fetchText(path).then(function (html) {
      var root = renderHtml(html, opts);
      return new Promise(function (resolve) {
        var actions = $(".subt-flow-actions", root);
        if (!actions) {
          actions = document.createElement("div");
          actions.className = "subt-flow-actions";
          root.appendChild(actions);
        }
        if (opts.requiresConsent) {
          var proceed = $('[data-flow-action="proceed"]', root);
          if (proceed) {
            proceed.addEventListener("click", function () {
              if (aborted) return;
              var agree = $("[data-flow-consent]", root);
              if (agree && !agree.checked) return;
              collectFields(root, opts.collect || "consent");
              resolve();
            });
          }
          return;
        }
        var next = document.createElement("button");
        next.type = "button";
        next.textContent = opts.buttonLabel || "Next";
        actions.appendChild(next);
        next.addEventListener("click", function () {
          if (aborted) return;
          if (opts.collect) collectFields(root, opts.collect);
          resolve();
        });
      });
    });
  }

  function setViewerActive(active) {
    if (window.SUBT && typeof window.SUBT.setViewerActive === "function") {
      window.SUBT.setViewerActive(active);
    } else if (window.SUBT) {
      window.SUBT.viewerActive = !!active;
    }
  }

  function activateViewer() {
    setViewerActive(true);
    return new Promise(function (resolve) {
      if (window.SUBT && typeof window.SUBT.onViewerReady === "function") {
        window.SUBT.onViewerReady(resolve, 5000);
      } else {
        resolve();
      }
    });
  }

  function hideExperimentOverlay() {
    if (window.SUBT && window.SUBT.experimentController &&
        typeof window.SUBT.experimentController.hideOverlay === "function") {
      window.SUBT.experimentController.hideOverlay();
    }
  }

  function waitForRobotReady(opts) {
    opts = opts || {};
    return new Promise(function (resolve) {
      if (!(window.SUBT && window.SUBT.experimentController)) return resolve();
      if (window.SUBT.experimentController.isReady()) return resolve();
      // Silent: caller (e.g. runTrialSet's parallel path) is showing its own
      // coverage (the whackamole). Skipping this overlay avoids the stale
      // "Preparing simulation..." leaking through when the whackamole ends.
      if (!opts.silent) {
        window.SUBT.experimentController.showOverlay("Preparing simulation...");
      }
      window.SUBT.experimentController.onReady(resolve);
    });
  }

  function showRawPage(html, buttonLabel) {
    renderHtml('<section class="subt-flow-page">' + html + '</section>');
    return new Promise(function (resolve) {
      var actions = document.createElement("div");
      actions.className = "subt-flow-actions";
      var next = document.createElement("button");
      next.type = "button";
      next.textContent = buttonLabel || "Next";
      actions.appendChild(next);
      panel().appendChild(actions);
      next.addEventListener("click", function () {
        if (aborted) return;
        resolve();
      });
    });
  }

  function whackamolePractice() {
    setViewerActive(false);
    hideShell();
    return new Promise(function (resolve) {
      if (window.SUBT && typeof window.SUBT.showMinigame === "function") {
        window.SUBT.showMinigame(resolve, { doneLabel: "End Practice", allowEarlyEnd: true });
      } else {
        showRawPage("<h1>Practice Skipped</h1><p>The whack-a-mole game is not loaded.</p>", "Continue")
          .then(resolve);
      }
    });
  }

  // Debug fast-forward: set via subt_config.js `experiment.debugFast` OR the
  // `?debug=1` URL param. Skips consent/instruction/questionnaire steps,
  // skips both practices, and clamps whackamole rounds to 1.5s.
  function debugMode() {
    var expCfg = (window.SUBT && window.SUBT.experiment) || {};
    var qp = new URLSearchParams(location.search);
    return !!(expCfg.debugFast || qp.get("debug") === "1");
  }
  // Expose so other files (subt_replay.js, subt_draw_replay.js) can gate
  // debug-only UI without recomputing the URL/config check.
  window.SUBT = window.SUBT || {};
  window.SUBT.isDebugMode = debugMode;
  console.log("[study-flow] debugMode:", debugMode(), "url:", location.search);

  function trialWhackamoleOptions(trialNumber) {
    var expCfg = (window.SUBT && window.SUBT.experiment) || {};
    var qp = new URLSearchParams(location.search);
    var durationMs = expCfg.whackamoleDebugDurationMs;
    if (qp.has("whackamole_seconds")) {
      durationMs = Number(qp.get("whackamole_seconds")) * 1000;
    }
    if (debugMode() && durationMs == null) durationMs = 1500;    // fast default
    var opts = { seed: "operator-readiness-trial-" + String(trialNumber) };
    if (durationMs != null && isFinite(durationMs)) {
      opts.durationMs = Math.max(0, durationMs);
    }
    return opts;
  }

  function formatSeconds(t) {
    t = Math.max(0, Number(t) || 0);
    return t.toFixed(1) + " s";
  }

  // Trial counter, rendered into the blue app bar. Numbering is per SET, not
  // across the whole study: the participant is introduced to one set at a
  // time, so "Trial 3 of 5" is the position they can actually place
  // themselves in -- a running 1..10 across both sets wouldn't match the set
  // they were just given instructions for.
  var progressEl = null;

  function progressBanner() {
    if (progressEl) return progressEl;
    progressEl = document.createElement("span");
    progressEl.className = "subt-flow-progress";
    // Lives in the MDL header row so it sits inside the blue bar and moves
    // with it. Falls back to the body if the layout chrome isn't there.
    var row = $(".mdl-layout__header-row");
    (row || document.body).appendChild(progressEl);
    return progressEl;
  }

  function showTrialProgress(n, count) {
    var el = progressBanner();
    el.textContent = count > 0 ? "Trial " + n + " of " + count : "Trial " + n;
    el.style.display = "";
  }

  function hideTrialProgress() {
    if (progressEl) progressEl.style.display = "none";
  }

  function wireReportTimeWidget(root) {
    var input = $("#reported-ready-time", root);
    var output = $("#reported-ready-time-output", root);
    if (!input || !output) return;
    var update = function () { output.textContent = formatSeconds(input.value); };
    input.addEventListener("input", update);
    update();
  }

  function showReportWhenReadyQuestion(maxSeconds) {
    maxSeconds = Math.max(1, Number(maxSeconds) || 30);
    var maxLabel = formatSeconds(maxSeconds);
    return new Promise(function (resolve) {
      renderHtml(
        '<section class="subt-flow-page">' +
        '<h1>Report When Ready</h1>' +
        '<p>Set the slider to the time when you would have felt ready to take over.</p>' +
        '<div class="subt-flow-question subt-flow-report-time">' +
        '<label for="reported-ready-time">Reported ready time</label>' +
        '<output id="reported-ready-time-output" for="reported-ready-time">' + maxLabel + '</output>' +
        '<input id="reported-ready-time" name="reported_ready_time" type="range" min="0" max="' + maxSeconds.toFixed(1) + '" step="0.1" value="' + maxSeconds.toFixed(1) + '">' +
        '<div class="subt-flow-scale-labels"><span>0.0 s</span><span>' + maxLabel + '</span></div>' +
        '</div>' +
        '</section>'
      );
      wireReportTimeWidget(panel());
      var actions = document.createElement("div");
      actions.className = "subt-flow-actions";
      var next = document.createElement("button");
      next.type = "button";
      next.textContent = "Next";
      actions.appendChild(next);
      panel().appendChild(actions);
      next.addEventListener("click", function () {
        collectFields(panel(), "report_ready");
        resolve();
      });
    });
  }

  function waitForTrialButton(label) {
    return new Promise(function (resolve) {
      var btn = document.createElement("button");
      btn.className = "subt-flow-button";
      btn.type = "button";
      btn.textContent = label;
      btn.style.position = "fixed";
      btn.style.right = "24px";
      btn.style.bottom = "24px";
      btn.style.zIndex = "999999";
      document.body.appendChild(btn);
      btn.addEventListener("click", function () {
        btn.disabled = true;
        try { btn.remove(); } catch (e) {}
        resolve();
      });
    });
  }

  function issueQuestions() {
    return showContent("content/trial_issue_questions.html", { collect: "trial_issue" });
  }

  // onSetupDone (optional): fires when the sim setup phase completes (readiness
  // + viewer activation + startTrial's done). Used by runTrialSet to keep the
  // whackamole overlay up until the real sim is ready, so the participant
  // never sees a "Starting trial N" gap. When provided, the readiness overlay
  // and startTrial's own overlay are both suppressed (whackamole is covering).
  function runRobotTrial(condition, label, onSetupDone) {
    var silent = typeof onSetupDone === "function";
    return waitForRobotReady({ silent: silent }).then(function () { return new Promise(function (resolve) {
      hideShell();
      activateViewer().then(function () {
        window.SUBT.experimentController.startTrial({ condition: condition, noOverlay: silent }, function () {
          if (silent) { try { onSetupDone(); } catch (e) {} }
          var clock = null;
          var lastElapsed = 0;
          if (condition === "R") {
            clock = document.createElement("div");
            clock.className = "subt-flow-clock";
            document.body.appendChild(clock);
            var tick = function () {
              if (!clock) return;
              lastElapsed = window.SUBT.experimentController.trialElapsedSimSec();
              clock.textContent = "Elapsed: " + formatSeconds(lastElapsed);
              requestAnimationFrame(tick);
            };
            tick();
          }
          waitForTrialButton(condition === "R" ? "Stop Scenario" : "End Robot Trial").then(function () {
            if (clock) { clock.remove(); clock = null; }
            hideShell();
            window.SUBT.experimentController.stopTrial(function () {
              setViewerActive(false);
              var elapsed = window.SUBT.experimentController.trialElapsedSimSec() || lastElapsed;
              var afterStop = condition === "R" && reportWhenReadySliderEnabled()
                ? showReportWhenReadyQuestion(elapsed)
                : Promise.resolve();
              afterStop.then(issueQuestions).then(resolve);
            });
          });
        });
      });
    }); });
  }

  // In the video condition there is no simulator, so a "robot practice" step
  // has to be the same rehearsal through the video interface rather than a
  // live drive. The flow, its buttons and its ordering are unchanged; only the
  // medium differs, so a participant never sees a sim in a video session.
  function runVideoPractice(step) {
    return new Promise(function (resolve) {
      hideExperimentOverlay();
      hideShell();
      activateViewer().then(function () {
        hideExperimentOverlay();
        var name = (step.videoSegment
          || (window.SUBT.getSelectedSegment && window.SUBT.getSelectedSegment()));
        var started = name
          ? fetch("/segments/play", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ name: name }),
            }).catch(function () {})
          : Promise.resolve();

        started.then(function () {
          waitForTrialButton(step.stopLabel || "End Practice").then(function () {
            fetch("/segments/stop", { method: "POST" })
              .catch(function () {})
              .then(function () {
                setViewerActive(false);
                resolve();
              });
          });
        });
      });
    });
  }

  function runRobotPractice(step, order) {
    if (window.SUBT.isReplay) return runVideoPractice(step);
    var condition = step.condition || getCondition(order, step.conditionSlot);
    return waitForRobotReady().then(function () { return new Promise(function (resolve) {
      hideExperimentOverlay();
      hideShell();
      activateViewer().then(function () {
        hideExperimentOverlay();
        window.SUBT.experimentController.startTrial({
          condition: condition,
          isPractice: true,
          label: step.title || "Practice",
          goal: step.goal,
          takeover: step.takeover,
        }, function () {
          waitForTrialButton(step.stopLabel || "End Practice").then(function () {
            window.SUBT.experimentController.stopTrial(function () {
              setViewerActive(false);
              resolve();
            });
          });
        });
      });
    }); });
  }

  function runConditionTraining(flow, step, order) {
    var condition = getCondition(order, step.conditionSlot);
    var plans = (flow.conditionTraining || {})[condition] || [];
    return plans.reduce(function (p, plan) {
      return p.then(function () {
        if (plan.type === "condition_intro") {
          return showContent(contentForCondition("task", condition), {
            buttonLabel: plan.buttonLabel || "Next",
          });
        }
        if (plan.type === "content") {
          return showContent(plan.content, { buttonLabel: plan.buttonLabel || "Next" });
        }
        return runRobotPractice({
          title: plan.title,
          condition: condition,
          stopLabel: plan.stopLabel,
          goal: plan.goal,
          takeover: plan.takeover,
        }, order);
      });
    }, Promise.resolve());
  }

  function runTrialSet(condition, count) {
    var p = Promise.resolve();
    for (var i = 0; i < count; i++) {
      (function (n) {
        p = p.then(function () {
          return new Promise(function (resolve) {
            hideShell();
            showTrialProgress(n, count);
            // Start the trial's setup NOW (in the background). runRobotTrial
            // returns a promise for the FULL trial (setup + participant end +
            // questions). It invokes onSetupDone as soon as its own setup
            // phase completes (readiness + viewer active + first pulse done).
            // The minigame stays up until both its timer runs out AND
            // onSetupDone fires -- so the "Starting trial N" overlay never
            // shows and there's no visible gap into the trial view.
            var setupDone;
            var setupPromise = new Promise(function (r) { setupDone = r; });
            var trialFullPromise = runRobotTrial(condition, "Robot Trial " + n, setupDone);

            if (window.SUBT && typeof window.SUBT.showMinigame === "function") {
              var current = window.SUBT.experimentController.currentTrial();
              var opts = trialWhackamoleOptions(current + 1);
              // Debug: skip the setup gate so whackamole ends on its own
              // timer instead of waiting up to ~15s for sensor readiness.
              // Production still gates on setup to guarantee zero visible gap.
              if (!debugMode()) opts.waitFor = setupPromise;
              window.SUBT.showMinigame(function () {
                // Minigame gone, sim visible. Wait for the participant to
                // finish the trial (end-button + stop + questions).
                trialFullPromise.then(resolve);
              }, opts);
            } else {
              trialFullPromise.then(resolve);
            }
          });
        });
      })(i + 1);
    }
    return p.then(hideTrialProgress);
  }

  function trialCountForSet(flow, setIndex, total) {
    var sets = flow.trialSets || [];
    var set = sets[setIndex - 1] || {};
    if (total > 0) return Math.floor(total / 2) + (setIndex === 1 ? total % 2 : 0);
    return set.defaultCount || 10;
  }

  function runStep(step, flow, order) {
    if (aborted) return Promise.resolve();
    var total = window.SUBT.experimentController.totalTrials();
    var fast = debugMode();
    // In debug fast-forward, skip everything that isn't a real trial. The
    // final `finish` content step is preserved so the participant is still
    // released cleanly (broker /release fires + Prolific redirect).
    if (fast) {
      var skipTypes = {
        whackamole_practice: 1,
        robot_practice: 1,
        condition_training: 1,      // driving/scenario practice per condition
        condition_intro: 1,          // task-explanation page
        set_instructions: 1,         // set intro page
      };
      if (skipTypes[step.type]) {
        console.log("[debugFast] skipping step:", step.type);
        return Promise.resolve();
      }
      if (step.type === "content" && !step.finish) {
        console.log("[debugFast] skipping content:", step.content);
        return Promise.resolve();
      }
    }
    if (step.type === "content") {
      return showContent(step.content, {
        buttonLabel: step.buttonLabel || (step.finish ? "Finish" : "Next"),
        collect: step.collect,
        requiresConsent: step.requiresConsent,
      }).then(function () {
        if (step.finish) window.SUBT.experimentController.finishAndRelease();
      });
    }
    if (step.type === "whackamole_practice") return whackamolePractice();
    if (step.type === "robot_practice") return runRobotPractice(step, order);
    if (step.type === "condition_training") return runConditionTraining(flow, step, order);
    if (step.type === "condition_intro") {
      var c1 = getCondition(order, step.conditionSlot);
      return showContent(contentForCondition("task", c1));
    }
    if (step.type === "set_instructions") {
      var c2 = getCondition(order, step.conditionSlot);
      return showContent(contentForCondition("set", c2), { buttonLabel: "Begin Trials" });
    }
    if (step.type === "trial_set") {
      var c3 = getCondition(order, step.conditionSlot);
      return runTrialSet(c3, trialCountForSet(flow, step.conditionSlot, total));
    }
    return Promise.resolve();
  }

  function start() {
    return fetchJson(flowPath()).then(function (flow) {
      var order = conditionOrder(flow);
      preloadFlowContent(flow);
      hideExperimentOverlay();
      return (flow.steps || []).reduce(function (p, step) {
        return p.then(function () {
          if (aborted) return Promise.resolve();
          return runStep(step, flow, order);
        });
      }, Promise.resolve());
    });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c];
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initWhenReady);
  else initWhenReady();
})();
