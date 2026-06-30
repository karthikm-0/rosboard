"use strict";

// SubT experiment UI customization for rosboard.
// All participant-facing behavior is controlled from here.
window.SUBT = {
  // Only these topics are shown. With lockdown on, the topic sidebar is hidden
  // and any attempt to subscribe to anything else is blocked.
  whitelist: [
    { topicName: "/X1/front/image_raw", topicType: "sensor_msgs/msg/Image" },
    { topicName: "/registered_scan", topicType: "sensor_msgs/msg/PointCloud2" },
  ],

  // true  = locked participant view (fixed whitelist, no topic browser, no close)
  // false = stock rosboard (browse/add/remove any topic)
  lockdown: true,

  // Mouse joystick that publishes velocity commands via rosbridge.
  joystick: {
    enabled: true,
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
    lidarTopic: "/registered_scan",   // ONLY this 3D view is locked top-down; others unaffected
    orientTopic: "/state_estimation", // nav_msgs/msg/Odometry, robot pose in map frame
    height: 30,                       // camera height above robot in metres; wheel still zooms
  },

  // "Next trial" button for online experiments. Publishes std_msgs/Empty to
  // advanceTopic via rosbridge; the in-container shim (advance_to_stdin.py) turns
  // each message into the Enter that steps run_config_sequence.py (MODE=online).
  // Manual only -- no auto-advance. Disable for the plain streaming/test view.
  experiment: {
    enabled: true,
    advanceTopic: "/experiment/advance",
    label: "Next trial ▶",
    rosbridgePath: "/rosbridge",      // same-origin wss path behind the tunnel
    debounceMs: 800,                  // ignore repeat clicks within this window
  },
};

// Latest robot pose ({x,y,z,yaw}) captured from orientTopic; read by the lidar
// top-down camera each frame. Null until the first odometry message arrives.
window.SUBT.robotPose = null;

window.SUBT.isWhitelisted = function (topicName) {
  return window.SUBT.whitelist.some(t => t.topicName === topicName);
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
