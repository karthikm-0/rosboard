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
  },
};

window.SUBT.isWhitelisted = function (topicName) {
  return window.SUBT.whitelist.some(t => t.topicName === topicName);
};

// In lockdown, hide the topic drawer + its toggle so users can't add views.
if (window.SUBT.lockdown) {
  var subtStyle = document.createElement("style");
  subtStyle.textContent =
    ".mdl-layout__drawer,.mdl-layout__drawer-button{display:none !important;}";
  document.head.appendChild(subtStyle);
}
