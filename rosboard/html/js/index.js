"use strict";

importJsOnce("js/viewers/meta/Viewer.js");
importJsOnce("js/viewers/meta/Space2DViewer.js");
importJsOnce("js/viewers/meta/Space3DViewer.js");

importJsOnce("js/viewers/ImageViewer.js");
importJsOnce("js/viewers/LogViewer.js");
importJsOnce("js/viewers/ProcessListViewer.js");
importJsOnce("js/viewers/MapViewer.js");
importJsOnce("js/viewers/LaserScanViewer.js");
importJsOnce("js/viewers/GeometryViewer.js");
importJsOnce("js/viewers/PolygonViewer.js");
importJsOnce("js/viewers/DiagnosticViewer.js");
importJsOnce("js/viewers/TimeSeriesPlotViewer.js");
importJsOnce("js/viewers/PointCloud2Viewer.js");
importJsOnce("js/viewers/ImuViewer.js");
importJsOnce("js/viewers/JointStateViewer.js");

// GenericViewer must be last
importJsOnce("js/viewers/GenericViewer.js");

importJsOnce("js/transports/WebSocketV1Transport.js");

var snackbarContainer = document.querySelector('#demo-toast-example');

let subscriptions = {};

// SubT: the participant view is defined entirely by the server-advertised
// whitelist (auto-subscribed in onTopics). Ignore any stored subscriptions so a
// stale browser localStorage can never alter or blank a participant's view.
if(window.SUBT && window.SUBT.whitelist) {
  subscriptions = {};
  try { if(window.localStorage) window.localStorage.removeItem('subscriptions'); } catch(e) {}
} else if(window.localStorage && window.localStorage.subscriptions) {
  if(window.location.search && window.location.search.indexOf("reset") !== -1) {
    subscriptions = {};
    updateStoredSubscriptions();
    window.location.href = "?";
  } else {
    try {
      subscriptions = JSON.parse(window.localStorage.subscriptions);
    } catch(e) {
      console.log(e);
      subscriptions = {};
    }
  }
}

let $grid = null;
$(() => {
  $grid = $('.grid').masonry({
    itemSelector: '.card',
    gutter: 10,
    percentPosition: true,
  });
  $grid.masonry("layout");
});

setInterval(() => {
  if(currentTransport && subtViewerActive() && !currentTransport.isConnected()) {
    console.log("attempting to reconnect ...");
    currentTransport.connect();
  }
}, 5000);

function updateStoredSubscriptions() {
  if(window.localStorage) {
    let storedSubscriptions = {};
    for(let topicName in subscriptions) {
      storedSubscriptions[topicName] = {
        topicType: subscriptions[topicName].topicType,
      };
    }
    window.localStorage['subscriptions'] = JSON.stringify(storedSubscriptions);
  }
}

function newCard() {
  // creates a new card, adds it to the grid, and returns it.
  let card = $("<div></div>").addClass('card')
    .appendTo($('.grid'));
  return card;
}

function newTopicCard(topicName) {
  let card = newCard();
  if(topicName) card.attr("data-topic", topicName);
  return card;
}

function gridMasonry(method, arg) {
  if(!$grid || !$grid.length || !$grid.data("masonry")) return;
  if(arg !== undefined) $grid.masonry(method, arg);
  else $grid.masonry(method);
}

let onOpen = function() {
  // SubT lockdown: ignore stored/URL subscriptions. The whitelist is subscribed
  // from onTopics instead (so the grid is ready and the type matches the server).
  if (window.SUBT && window.SUBT.lockdown) {
    return;
  }

  const urlParams = new URLSearchParams(window.location.search);

  for( let [key, value] of urlParams ){
    key = key.replace(/\\/g, '/');
    value = value.replace(/\\/g, '/');

    console.log("Auto subscribing to " + key + " of type " + value);
      
    const subscriptions = JSON.parse(window.localStorage.getItem('subscriptions') || '{}');
    if (!(key in subscriptions)) {
      initSubscribe({topicName: key, topicType: value});
    }
  }          
  
  for(let topic_name in subscriptions) {
    console.log("Re-subscribing to " + topic_name);
    initSubscribe({topicName: topic_name, topicType: subscriptions[topic_name].topicType});
  }


}

let onSystem = function(system) {
  if(system.hostname) {
    console.log("hostname: " + system.hostname);
    $('.mdl-layout-title').text("ROSboard: " + system.hostname);
  }

  if(system.version) {
    console.log("server version: " + system.version);
    versionCheck(system.version);
  }
}

let onMsg = function(msg) {
  // SubT: capture robot pose for the lidar top-down camera. This is a read-only
  // use of odometry to orient the *view* only -- the data is never republished
  // or re-framed. Not a visual topic, so consume it here and return.
  if(window.SUBT && window.SUBT.lidarTopdown && msg._topic_name === window.SUBT.lidarTopdown.orientTopic) {
    let pp = (msg.pose && msg.pose.pose) ? msg.pose.pose : null;
    if(pp && pp.position && pp.orientation) {
      let q = pp.orientation, pos = pp.position;
      let yaw = Math.atan2(2*(q.w*q.z + q.x*q.y), 1 - 2*(q.y*q.y + q.z*q.z));
      window.SUBT.robotPose = {x: pos.x, y: pos.y, z: pos.z, yaw: yaw};
    }
    return;
  }
  if(!subscriptions[msg._topic_name]) {
    console.log("Received unsolicited message", msg);
  } else if(!subscriptions[msg._topic_name].viewer) {
    console.log("Received msg but no viewer", msg);
  } else {
    subscriptions[msg._topic_name].viewer.update(msg);
  }
}

let currentTopics = {};
let currentTopicsStr = "";
let subtViewerReadyCallbacks = [];

function subtViewerActive() {
  return !(window.SUBT && window.SUBT.lockdown && window.SUBT.viewerActive === false);
}

function subtViewerReady() {
  if(!(window.SUBT && window.SUBT.whitelist && subtViewerActive())) return false;
  return window.SUBT.whitelist.every(t => subscriptions[t.topicName] && subscriptions[t.topicName].viewer);
}

function subtWhitelistedTopicNames() {
  if(!(window.SUBT && window.SUBT.whitelist)) return new Set();
  return new Set(window.SUBT.whitelist.map(t => t.topicName));
}

function subtRemoveOrphanCards() {
  if(!(window.SUBT && window.SUBT.lockdown)) return;
  let allowed = subtWhitelistedTopicNames();
  $(".grid .card").each(function() {
    let topicName = $(this).attr("data-topic");
    if(!topicName || !allowed.has(topicName)) {
      $(this).remove();
    }
  });
  gridMasonry("layout");
}

function subtNotifyViewerReady() {
  if(!subtViewerReady()) return;
  let callbacks = subtViewerReadyCallbacks.slice();
  subtViewerReadyCallbacks = [];
  callbacks.forEach(cb => {
    try { cb(); } catch(e) {}
  });
}

function removeSubscription(topicName) {
  if(!subscriptions[topicName]) return;
  if(currentTransport && currentTransport.isConnected()) currentTransport.unsubscribe({topicName: topicName});
  if(subscriptions[topicName].viewer) {
    let card = subscriptions[topicName].viewer.card;
    try { subscriptions[topicName].viewer.destroy(); } catch(e) {}
    if($grid && card) {
      gridMasonry("remove", card);
      gridMasonry("layout");
    } else if(card) {
      card.remove();
    }
  }
  delete(subscriptions[topicName]);
  updateStoredSubscriptions();
}

function subtSyncViewerSubscriptions() {
  if(!(window.SUBT && window.SUBT.whitelist)) return;
  if(window.SUBT.lockdown) {
    let allowed = subtWhitelistedTopicNames();
    Object.keys(subscriptions).forEach(topicName => {
      if(!allowed.has(topicName)) removeSubscription(topicName);
    });
    subtRemoveOrphanCards();
  }
  if(!subtViewerActive()) {
    window.SUBT.whitelist.forEach(t => removeSubscription(t.topicName));
    return;
  }
  if(!currentTransport) {
    initDefaultTransport();
    return;
  }
  window.SUBT.whitelist.forEach(t => {
    let serverType = currentTopics[t.topicName];
    if(serverType && !subscriptions[t.topicName]) {
      initSubscribe({topicName: t.topicName, topicType: serverType});
    }
  });
}

if(window.SUBT) {
  window.SUBT.setViewerActive = function(active) {
    window.SUBT.viewerActive = !!active;
    subtSyncViewerSubscriptions();
    subtNotifyViewerReady();
  };
  window.SUBT.onViewerReady = function(cb, timeoutMs) {
    if(subtViewerReady()) {
      setTimeout(cb, 0);
      return;
    }
    subtViewerReadyCallbacks.push(cb);
    if(timeoutMs) {
      setTimeout(function() {
        let idx = subtViewerReadyCallbacks.indexOf(cb);
        if(idx >= 0) {
          subtViewerReadyCallbacks.splice(idx, 1);
          cb();
        }
      }, timeoutMs);
    }
  };
}

let onTopics = function(topics) {
  currentTopics = topics;
  // SubT: auto-subscribe the whitelisted topics as soon as the server advertises
  // them, so the fixed participant view (camera + scan) loads deterministically.
  if (window.SUBT && window.SUBT.whitelist) {
    subtSyncViewerSubscriptions();
    subtNotifyViewerReady();
  }

  // SubT: read-only background subscription to the orient topic (no visible
  // panel) so the lidar top-down camera can follow the robot's pose. Re-sent
  // each topics tick so it survives a websocket reconnect. This is a plain ROS
  // subscriber -- it never writes/republishes data.
  if (window.SUBT && window.SUBT.lidarTopdown && window.SUBT.lidarTopdown.enabled && currentTransport) {
    let ot = window.SUBT.lidarTopdown.orientTopic;
    if (topics[ot]) currentTransport.subscribe({topicName: ot});
  }

  // SubT lockdown: no topic browser -- stop here so the sidebar isn't built.
  if (window.SUBT && window.SUBT.lockdown) {
    return;
  }

  // check if topics has actually changed, if not, don't do anything
  // lazy shortcut to deep compares, might possibly even be faster than
  // implementing a deep compare due to
  // native optimization of JSON.stringify
  let newTopicsStr = JSON.stringify(topics);
  if(newTopicsStr === currentTopicsStr) return;
  currentTopicsStr = newTopicsStr;
  
  let topicTree = treeifyPaths(Object.keys(topics));
  
  $("#topics-nav-ros").empty();
  $("#topics-nav-system").empty();
  
  addTopicTreeToNav(topicTree[0], $('#topics-nav-ros'));

  $('<a></a>')
  .addClass("mdl-navigation__link")
  .click(() => { initSubscribe({topicName: "_dmesg", topicType: "rcl_interfaces/msg/Log"}); })
  .text("dmesg")
  .appendTo($("#topics-nav-system"));

  $('<a></a>')
  .addClass("mdl-navigation__link")
  .click(() => { initSubscribe({topicName: "_top", topicType: "rosboard_msgs/msg/ProcessList"}); })
  .text("Processes")
  .appendTo($("#topics-nav-system"));

  $('<a></a>')
  .addClass("mdl-navigation__link")
  .click(() => { initSubscribe({topicName: "_system_stats", topicType: "rosboard_msgs/msg/SystemStats"}); })
  .text("System stats")
  .appendTo($("#topics-nav-system"));
}

function addTopicTreeToNav(topicTree, el, level = 0, path = "") {
  topicTree.children.sort((a, b) => {
    if(a.name>b.name) return 1;
    if(a.name<b.name) return -1;
    return 0;
  });
  topicTree.children.forEach((subTree, i) => {
    let subEl = $('<div></div>')
    .css(level < 1 ? {} : {
      "padding-left": "0pt",
      "margin-left": "12pt",
      "border-left": "1px dashed #808080",
    })
    .appendTo(el);
    let fullTopicName = path + "/" + subTree.name;
    let topicType = currentTopics[fullTopicName];
    if(topicType) {
      $('<a></a>')
        .addClass("mdl-navigation__link")
        .css({
          "padding-left": "12pt",
          "margin-left": 0,
        })
        .click(() => { initSubscribe({topicName: fullTopicName, topicType: topicType}); })
        .text(subTree.name)
        .appendTo(subEl);
    } else {
      $('<a></a>')
      .addClass("mdl-navigation__link")
      .attr("disabled", "disabled")
      .css({
        "padding-left": "12pt",
        "margin-left": 0,
        opacity: 0.5,
      })
      .text(subTree.name)
      .appendTo(subEl);
    }
    addTopicTreeToNav(subTree, subEl, level + 1, path + "/" + subTree.name);
  });
}

function initSubscribe({topicName, topicType}) {
  // SubT lockdown: block anything not on the whitelist.
  if (window.SUBT && window.SUBT.lockdown && !window.SUBT.isWhitelisted(topicName)) {
    console.log("Blocked non-whitelisted subscribe: " + topicName);
    return;
  }
  console.log( "Subscribing to " + topicName + " of type " + topicType);
  // creates a subscriber for topicName
  // and also initializes a viewer (if it doesn't already exist)
  // in advance of arrival of the first data
  // this way the user gets a snappy UI response because the viewer appears immediately
  if(!subscriptions[topicName]) {
    subscriptions[topicName] = {
      topicType: topicType,
    }
  }  
  let maxUpdateRate = (window.SUBT && window.SUBT.viewerMaxUpdateRateHz) || 24.0;
  currentTransport.subscribe({topicName: topicName, maxUpdateRate: maxUpdateRate});
  if(!subscriptions[topicName].viewer) {
    let card = newTopicCard(topicName);
    let viewer = Viewer.getDefaultViewerForType(topicType);
    try {
      subscriptions[topicName].viewer = new viewer(card, topicName, topicType);
    } catch(e) {
      console.log(e);
      card.remove();
    }
    gridMasonry("appended", card);
    gridMasonry("layout");
  }
  updateStoredSubscriptions();
}

let currentTransport = null;

function initDefaultTransport() {
  currentTransport = new WebSocketV1Transport({
    path: "/rosboard/v1",
    onOpen: onOpen,
    onMsg: onMsg,
    onTopics: onTopics,
    onSystem: onSystem,
  });
  currentTransport.connect();
}

function treeifyPaths(paths) {
  // turn a bunch of ros topics into a tree
  let result = [];
  let level = {result};

  paths.forEach(path => {
    path.split('/').reduce((r, name, i, a) => {
      if(!r[name]) {
        r[name] = {result: []};
        r.result.push({name, children: r[name].result})
      }
      
      return r[name];
    }, level)
  });
  return result;
}

let lastBotherTime = 0.0;
function versionCheck(currentVersionText) {
  $.get("https://raw.githubusercontent.com/dheera/rosboard/release/setup.py").done((data) => {
    let matches = data.match(/version='(.*)'/);
    if(matches.length < 2) return;
    let latestVersion = matches[1].split(".").map(num => parseInt(num, 10));
    let currentVersion = currentVersionText.split(".").map(num => parseInt(num, 10));
    let latestVersionInt = latestVersion[0] * 1000000 + latestVersion[1] * 1000 + latestVersion[2];
    let currentVersionInt = currentVersion[0] * 1000000 + currentVersion[1] * 1000 + currentVersion[2];
    if(currentVersion < latestVersion && Date.now() - lastBotherTime > 1800000) {
      lastBotherTime = Date.now();
      snackbarContainer.MaterialSnackbar.showSnackbar({
        message: "New version of ROSboard available (" + currentVersionText + " -> " + matches[1] + ").",
        actionText: "Check it out",
        actionHandler: ()=> {window.location.href="https://github.com/dheera/rosboard/"},
      });
    }
  });
}

$(() => {
  if(window.location.href.indexOf("rosboard.com") === -1) {
    if(!(window.SUBT && window.SUBT.studyFlow && window.SUBT.studyFlow.enabled && !subtViewerActive())) {
      initDefaultTransport();
    }
  }
});

Viewer.onClose = function(viewerInstance) {
  // SubT lockdown: views are fixed — ignore the close button.
  if (window.SUBT && window.SUBT.lockdown) return;

  let topicName = viewerInstance.topicName;
  let topicType = viewerInstance.topicType;
  currentTransport.unsubscribe({topicName:topicName});
  gridMasonry("remove", viewerInstance.card);
  gridMasonry("layout");
  delete(subscriptions[topicName].viewer);
  delete(subscriptions[topicName]);
  updateStoredSubscriptions();
}

Viewer.onSwitchViewer = (viewerInstance, newViewerType) => {
  let topicName = viewerInstance.topicName;
  let topicType = viewerInstance.topicType;
  if(!subscriptions[topicName].viewer === viewerInstance) console.error("viewerInstance does not match subscribed instance");
  let card = subscriptions[topicName].viewer.card;
  subscriptions[topicName].viewer.destroy();
  delete(subscriptions[topicName].viewer);
  subscriptions[topicName].viewer = new newViewerType(card, topicName, topicType);
};
