"use strict";

// SubT experiment UI customization for rosboard.
// All participant-facing behavior is controlled from here.
window.SUBT = {
  // Only these topics are shown. With lockdown on, the topic sidebar is hidden
  // and any attempt to subscribe to anything else is blocked.
  whitelist: [
    // Camera temporarily disabled to isolate rosboard's throughput -- was
    // ~74 MB/s raw feeding rosboard's Python compressor. Re-enable after
    // shrinking source resolution in subt_gz/models/x1/model.sdf.
    { topicName: "/X1/front/image_raw", topicType: "sensor_msgs/msg/Image" },
    // Use the decimated preview cloud (row_stride=2, col_stride=4 = 8x fewer
    // points) instead of the raw /registered_scan. aede_registered_scan_bridge
    // publishes it when publish_lidar_preview:=true in x1_world.launch.py.
    { topicName: "/X1/points_preview", topicType: "sensor_msgs/msg/PointCloud2" },
  ],
  viewerMaxUpdateRateHz: 2,

  // true  = locked participant view (fixed whitelist, no topic browser, no close)
  // false = stock rosboard (browse/add/remove any topic)
  lockdown: true,
  viewerActive: false,

  // Mouse joystick that publishes control input via rosbridge.
  joystick: {
    enabled: true,

    // Control path:
    //  useJoy:true  -> publish sensor_msgs/Joy on /joy, driving the robot THROUGH
    //                  the CMU pathFollower. This reuses the real experiment's
    //                  autonomous<->manual takeover: axis 2 = mode (held/autonomous
    //                  vs released/manual), axis 4 = forward, axis 3 = yaw. The
    //                  planner is the sole /cmd_vel publisher, so there is no
    //                  cmd_vel conflict and takeover behaves exactly like the
    //                  gamepad study. USE THIS for experiment/online.
    //  useJoy:false -> publish geometry_msgs/Twist straight to cmdVelTopic. Simple
    //                  direct drive, but it bypasses the planner and has NO clean
    //                  autonomous->manual handoff. Only for the plain streaming sim.
    useJoy: true,
    joyTopic: "/joy",
    joyType: "sensor_msgs/msg/Joy",
    autonomyAxis: 2,   // pathFollower: > -0.1 = manual, <= -0.1 = autonomous
    driveAxis: 4,      // forward/back (+ = forward)
    yawAxis: 3,        // turn
    // Knob->axis signs. Defaults chosen to match the old Twist feel; if a quick
    // drive test shows drive or turn reversed, flip the offending sign here (no
    // JS edit needed). driveSign*ny -> driveAxis, yawSign*nx -> yawAxis.
    driveSign: 1,
    yawSign: -1,
    // The trial starts autonomous (planner drives to the takeover point). There
    // is no button: the moment the participant grabs the joystick, control
    // latches to manual (takeover) for the rest of the trial. Re-arms to
    // autonomous automatically at each new trial (on /experiment/advance).
    startAutonomous: true,

    // Legacy direct-Twist path (only used when useJoy:false).
    cmdVelTopic: "/X1/cmd_vel",
    cmdVelType: "geometry_msgs/msg/Twist",
    maxLinear: 1.0,   // m/s at full forward deflection
    maxAngular: 1.0,  // rad/s at full sideways deflection
    rateHz: 10,
    // rosbridge runs on a different host port than rosboard. In the session/
    // experiment containers the mapping is rosboard 8880+i / rosbridge 9090+i,
    // i.e. a fixed +210 offset. Override in the URL with ?rb=<port> if needed.
    rosbridgePortOffset: 210,
    rosbridgePortDefault: 9090,
    // Behind an HTTPS tunnel/proxy, rosbridge is reverse-proxied here on the same
    // origin (see docker/web-sessions.sh). Used only when the page is served over
    // https; localhost/SSH use still goes through the port offset above.
    rosbridgePath: "/rosbridge",
  },

  // Lidar (/registered_scan) view: lock to a top-down camera that follows the
  // robot and keeps the robot's forward direction pointing up (FPS-aligned),
  // instead of the default draggable oblique view that needs manual rotation.
  // /registered_scan is in the map frame, so we need the robot pose to center
  // and orient the view -- captured from orientTopic below.
  lidarTopdown: {
    enabled: true,
    // /X1/points_preview -- decimated (8x lighter) map-frame cloud published
    // by aede_registered_scan_bridge when publish_lidar_preview:=true. Same
    // frame as /registered_scan, so the top-down camera math below is unchanged;
    // any other map-frame PointCloud2 topic could be substituted here.
    lidarTopic: "/X1/points_preview",
    orientTopic: "/state_estimation", // nav_msgs/msg/Odometry, robot pose in map frame
    height: 30,                       // camera height above robot in metres; wheel still zooms
    // false (default) = WORLD-fixed orientation (north-up map that only pans to
    //                   keep the robot centered -- does not spin as it turns).
    // true            = FPS: robot forward is always screen-up (view rotates).
    followYaw: false,
    // Rotate the world-fixed view to match RViz. 0 = world +y up; 90 = world +x
    // up (RViz/compass x-up convention). Change to -90/180 if it comes out flipped.
    viewRotationDeg: 90,
  },

  // Compass mini-map OVERLAID on the top-left of the camera view (mirrors the
  // visuals of compass_graphic_node.py). No ROS topics -- renders purely from
  // robotPose (captured by index.js). Optional goal/takeover markers below.
  compass: {
    enabled: true,
    // true (default) = robot-centric: robot faces up, markers rotate into the
    //                  robot frame -- matches the FPS camera it sits on.
    // false          = world/north-up map.
    robotCentric: true,
    rangeM: 10,      // ring radius in metres
    sizePx: 160,     // on-screen diameter of the overlay
    cameraTopic: "/X1/front/image_raw",  // card to overlay (defaults to the whitelisted Image)
    // Goal/takeover markers come from window.SUBT.compassGoal / compassTakeover,
    // set per-trial by subt_experiment.js when it fetches broker /trial-info.
    // No fallback here -- if we don't know the current trial's geometry the
    // compass simply omits the markers (renders robot + heading only).
    goal: null,
    takeover: null,
  },

  // Fixed-ratio widths for camera + lidar cards. Percentages of viewport width
  // (vw), so widgets scale with browser size but stay in a consistent 33/33
  // layout across monitors. minCardPx clamps on small screens.
  layout: {
    enabled: true,
    cameraTopic: "/X1/front/image_raw",
    lidarTopic: "/X1/points_preview",
    cameraVw: 33,
    lidarVw: 33,
    minCardPx: 320,
  },

  // "Next trial" button for online experiments. Publishes std_msgs/Empty to
  // advanceTopic via rosbridge; the in-container shim (advance_to_stdin.py) turns
  // each message into the Enter that steps run_config_sequence.py (MODE=online).
  // Manual only -- no auto-advance. Disable for the plain streaming/test view.
  experiment: {
    enabled: true,
    advanceTopic: "/experiment/advance",
    clockTopic: "/clock",
    // Button label / behavior progresses across the sequence:
    //   press 1              -> startLabel  ("Start ▶")       : STARTs trial 1
    //   press 2..totalTrials -> label       ("Next trial ▶")  : STOP+START
    //   press totalTrials+1  -> finishLabel ("Finish study ✓"): STOP + /release
    // totalTrials + broker URL are normally injected by the broker via URL query
    // (?total=&broker=); the values below are fallbacks for local testing (0 =
    // Finish path never engages, button acts as "Next trial" forever).
    startLabel: "Start ▶",
    label: "Next trial ▶",
    finishLabel: "Finish study ✓",
    totalTrials: 0,
    brokerUrl: "",
    rosbridgePath: "/rosbridge",      // same-origin wss path behind the tunnel
    debounceMs: 800,                  // ignore repeat clicks within this window
    viewerSettleMs: 1200,             // short delay after sim advance before showing live view
    // Show the whack-a-mole minigame (subt_minigame.js) between trials. When
    // false, Next → immediately starts the next trial (previous behavior).
    // Study-design toggle -- flip while iterating without touching the runner.
    minigameBetweenTrials: true,
    // Debug/local testing only. Null uses the minigame default. Can also be
    // overridden in the URL with ?whackamole_seconds=N.
    whackamoleDebugDurationMs: null,
  },

  // High-level participant procedure: consent, instructions, whack-a-mole
  // practice, D/R task sets, per-trial questions, set-end questions, and final
  // questionnaire. The flow file can be overridden locally with ?flow=<name>
  // and the condition order with ?order=DR or ?condition_order=D,R.
  studyFlow: {
    enabled: true,
    flowFile: "study_flows/operator_readiness_pilot.json",
    // Production order comes from the broker as ?condition_order=DR or RD.
    // Leave unset here so local tests use the flow file's default only.
    conditionOrder: null,
  },
};

// Latest robot pose ({x,y,z,yaw}) captured from orientTopic; read by the lidar
// top-down camera each frame. Null until the first odometry message arrives.
window.SUBT.robotPose = null;

window.SUBT.isWhitelisted = function (topicName) {
  return window.SUBT.whitelist.some(t => t.topicName === topicName);
};

// Observer condition: a picker that replays recorded segments server-side via
// `ros2 bag play`. The replayed topics arrive on the live graph, so the same
// viewers above render them. Turn this off for the driving condition -- a
// participant who is meant to drive should never see a transport control.
// The session's condition, served by rosboard from the container's CONDITION
// env var (see /subt_env.js). "video" means no simulator is running at all.
window.SUBT.condition = (window.SUBT_ENV && window.SUBT_ENV.condition) || "sim";
window.SUBT.isVideo = window.SUBT.condition === "video";
window.SUBT.isDraw = window.SUBT.condition === "draw";
window.SUBT.isReplay = window.SUBT.isVideo || window.SUBT.isDraw;

// Nothing to drive in the video condition, so the joystick would be a control
// that silently does nothing. Turn it off rather than show a dead interface.
if (window.SUBT.isReplay && window.SUBT.joystick) {
  window.SUBT.joystick.enabled = false;
}

// enabled: "auto" (default) shows the picker only when the container was
// launched with CONDITION=video -- the same switch that decides whether a sim
// runs at all. Set true/false to force it regardless of condition.
window.SUBT.replay = {
  enabled: "auto",
  pollMs: 500,
  loop: false,
};

// In lockdown, hide the topic drawer + its toggle so users can't add views.
if (window.SUBT.lockdown) {
  var subtStyle = document.createElement("style");
  subtStyle.textContent =
    ".mdl-layout__drawer,.mdl-layout__drawer-button{display:none !important;}" +
    // hide per-card controls (viewer-type switch, pause, close) so participants
    // can't change or remove the fixed views.
    ".card-buttons{display:none !important;}";
  document.head.appendChild(subtStyle);
}
