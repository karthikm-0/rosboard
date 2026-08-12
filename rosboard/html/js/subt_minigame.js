"use strict";

// Whack-a-mole minigame overlay -- meant to be shown between trials to keep
// participants engaged during trial reset time.
//
// Not auto-wired to anything yet -- call:
//   window.SUBT.showMinigame(function (score) { console.log(score); });
// and it renders full-screen. For between-trial rounds, the onDone callback
// fires immediately when the timer ends. Practice rounds can expose a button.
//
// 3x3 grid of holes; moles pop up pseudo-randomly and disappear after a short
// window unless clicked. Trial rounds can pass opts.seed for repeatability.
(function () {
  var COLS = 3, ROWS = 3;
  var HOLE_PX = 110;                              // per-hole size
  var GAP_PX = 18;
  var GAME_MS = 10000;                            // default round duration
  var MOLE_UP_MIN_MS = 700, MOLE_UP_MAX_MS = 1600;   // mole visible window
  var SPAWN_GAP_MIN_MS = 450, SPAWN_GAP_MAX_MS = 1100; // spawn cadence

  function hashSeed(text) {
    var h = 2166136261;
    text = String(text || "");
    for (var i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  function seededRandom(seed) {
    var s = seed >>> 0;
    return function () {
      s += 0x6D2B79F5;
      var t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function css(el, o) { for (var k in o) el.style[k] = o[k]; }

  function makeRand(opts) {
    var random = opts.seed == null ? Math.random : seededRandom(hashSeed(opts.seed));
    return {
      rand: function (lo, hi) { return lo + random() * (hi - lo); },
      randInt: function (lo, hi) { return Math.floor(lo + random() * (hi - lo + 1)); },
    };
  }

  window.SUBT = window.SUBT || {};
  var isOpen = false;

  window.SUBT.showMinigame = function (onDone, opts) {
    opts = opts || {};
    if (isOpen) return;
    isOpen = true;
    var rng = makeRand(opts);

    // --- root overlay ---
    var wrap = document.createElement("div");
    css(wrap, {
      position: "fixed", inset: "0", zIndex: "2147483646",
      background: "rgba(0,0,0,0.94)", color: "#eee",
      display: "flex", flexDirection: "column",
      alignItems: "center", justifyContent: "center",
      fontFamily: "sans-serif", userSelect: "none",
    });

    // --- title ---
    var title = document.createElement("div");
    title.textContent = "Whack the mole!";
    css(title, { fontSize: "28px", fontWeight: "bold", marginBottom: "8px" });

    var sub = document.createElement("div");
    sub.textContent = "Click the moles as they pop up.";
    css(sub, { fontSize: "13px", color: "#aaa", marginBottom: "20px" });

    // --- HUD ---
    var hud = document.createElement("div");
    css(hud, {
      marginBottom: "18px",
      fontSize: "18px", fontWeight: "bold", color: "#42a5f5"
    });
    var scoreEl = document.createElement("span");
    hud.appendChild(scoreEl);

    // --- grid of holes ---
    var grid = document.createElement("div");
    css(grid, {
      display: "grid",
      gridTemplateColumns: "repeat(" + COLS + ", " + HOLE_PX + "px)",
      gridTemplateRows: "repeat(" + ROWS + ", " + HOLE_PX + "px)",
      gap: GAP_PX + "px",
    });

    var holes = [];
    for (var i = 0; i < COLS * ROWS; i++) {
      var hole = document.createElement("div");
      css(hole, {
        width: HOLE_PX + "px", height: HOLE_PX + "px", borderRadius: "50%",
        background: "#3a2818",
        boxShadow: "inset 0 10px 22px rgba(0,0,0,0.7), 0 3px 4px rgba(0,0,0,0.4)",
        position: "relative", overflow: "hidden", cursor: "crosshair",
      });
      grid.appendChild(hole);
      holes.push({ el: hole, hasMole: false, mole: null });
    }

    // --- optional practice/end button ---
    var doneBtn = document.createElement("button");
    doneBtn.textContent = opts.doneLabel || "Continue";
    css(doneBtn, {
      marginTop: "22px", padding: "12px 22px", fontSize: "16px",
      fontWeight: "bold", color: "#fff", background: "#66bb6a",
      border: "none", borderRadius: "8px", cursor: "pointer",
      display: opts.allowEarlyEnd ? "inline-block" : "none",
      boxShadow: "0 2px 6px rgba(0,0,0,0.5)",
    });

    wrap.appendChild(title);
    wrap.appendChild(sub);
    wrap.appendChild(hud);
    wrap.appendChild(grid);
    wrap.appendChild(doneBtn);
    document.body.appendChild(wrap);

    // --- state ---
    var score = 0, hits = 0, misses = 0;
    var startMs = Date.now();
    var gameMs = Math.max(0, Number(opts.durationMs || GAME_MS));
    var running = true;
    var spawnTimer = null;

    function updateHud() {
      scoreEl.textContent = "Score: " + score;
    }

    // --- one mole cycle ---
    function popMole() {
      var free = holes.filter(function (h) { return !h.hasMole; });
      if (!free.length) return;
      var h = free[rng.randInt(0, free.length - 1)];

      var mole = document.createElement("div");
      css(mole, {
        position: "absolute", left: "10%", right: "10%",
        bottom: "-90%", width: "80%", height: "80%",
        borderRadius: "48% 48% 30% 30%",
        background: "radial-gradient(circle at 50% 38%, #a06840, #5a3820)",
        transition: "bottom 0.16s ease-out",
        cursor: "crosshair",
      });
      // face: two eyes + tiny nose
      mole.innerHTML =
        '<span style="position:absolute;left:22%;top:32%;width:14%;height:14%;' +
        'background:#fff;border-radius:50%;box-shadow:inset 0 0 0 2px #111"></span>' +
        '<span style="position:absolute;right:22%;top:32%;width:14%;height:14%;' +
        'background:#fff;border-radius:50%;box-shadow:inset 0 0 0 2px #111"></span>' +
        '<span style="position:absolute;left:44%;top:50%;width:12%;height:8%;' +
        'background:#3a2010;border-radius:50%"></span>';

      h.el.appendChild(mole);
      h.hasMole = true;
      h.mole = mole;

      // Animate up on next frame so the transition triggers.
      requestAnimationFrame(function () { mole.style.bottom = "8%"; });

      var upMs = rng.randInt(MOLE_UP_MIN_MS, MOLE_UP_MAX_MS);

      function hit(e) {
        e.preventDefault(); e.stopPropagation();
        if (!h.hasMole) return;
        score += 1; hits += 1;
        updateHud();
        // brief hit flash before retracting
        mole.style.background = "radial-gradient(circle at 50% 38%, #ffce55, #a06840)";
        clearMole(h, 100);
      }
      mole.addEventListener("mousedown", hit);
      mole.addEventListener("touchstart", hit, { passive: false });

      // auto-retract if not hit
      setTimeout(function () {
        if (h.hasMole) { misses += 1; clearMole(h, 0); }
      }, upMs);
    }

    function clearMole(h, delayMs) {
      if (!h.mole) { h.hasMole = false; return; }
      h.hasMole = false;                          // no more hits credited
      var m = h.mole;
      h.mole = null;
      setTimeout(function () {
        m.style.bottom = "-90%";
        setTimeout(function () { try { m.remove(); } catch (e) { } }, 180);
      }, delayMs || 0);
    }

    function scheduleSpawn() {
      if (!running) return;
      spawnTimer = setTimeout(function () {
        popMole();
        scheduleSpawn();
      }, rng.randInt(SPAWN_GAP_MIN_MS, SPAWN_GAP_MAX_MS));
    }

    function tick() {
      if (!running) return;
      updateHud();
      // End only when BOTH the timer has elapsed AND (if a waitFor was
      // passed) the caller says it's ready. Otherwise moles keep popping.
      if (Date.now() - startMs >= gameMs && waitForResolved) return endGame();
      requestAnimationFrame(tick);
    }

    // If the caller passed opts.waitFor (a promise), the game keeps running
    // past its scheduled end until that promise resolves -- moles keep
    // popping so the participant stays engaged and gets pulled out mid-play
    // the instant the sim is ready. Reason: this study is about operator
    // UN-readiness -- a "Get ready" message defeats the point.
    var waitForResolved = false;
    if (opts.waitFor && typeof opts.waitFor.then === "function") {
      opts.waitFor.then(function () {
        console.log("[minigame] waitFor resolved -- game can end when timer done");
        waitForResolved = true;
      }, function () {
        console.log("[minigame] waitFor rejected -- game can end when timer done");
        waitForResolved = true;
      });
    } else {
      waitForResolved = true;
    }

    function finish() {
      running = false;
      if (spawnTimer) clearTimeout(spawnTimer);
      holes.forEach(function (h) { clearMole(h, 0); });
      try { wrap.remove(); } catch (e) { }
      isOpen = false;
      if (typeof onDone === "function") onDone({ score: score, hits: hits, misses: misses });
    }

    function endGame() {
      if (!opts.allowEarlyEnd) return finish();
      running = false;
      if (spawnTimer) clearTimeout(spawnTimer);
      holes.forEach(function (h) { clearMole(h, 0); });
      title.textContent = "Round complete";
      sub.textContent = "Nice work.";
      doneBtn.style.display = "inline-block";
    }

    doneBtn.addEventListener("click", function () {
      finish();
    });

    updateHud();
    scheduleSpawn();
    tick();
  };
})();
