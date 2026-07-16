"use strict";

// SubT top-down lidar view -- self-contained patch.
//
// Keeps rosboard's upstream Space3DViewer.js PRISTINE: instead of editing that
// shared base class, we wrap its prototype here so that ONLY the configured
// lidar topic (window.SUBT.lidarTopdown.lidarTopic) renders as a locked,
// top-down, robot-following, forward-up view. Every other 3D view -- any other
// point cloud or laser scan you add -- is left exactly as stock rosboard.
//
// View-only: this reads window.SUBT.robotPose (populated read-only from
// odometry in index.js) purely to aim the WebGL camera. It never transforms,
// republishes, or re-frames any ROS data, and does not affect recordings.

(function () {
  function lockedTopic() {
    var c = window.SUBT && window.SUBT.lidarTopdown;
    return (c && c.enabled) ? c.lidarTopic : null;
  }

  function pose() {
    return (window.SUBT && window.SUBT.robotPose)
      ? window.SUBT.robotPose
      : { x: 0, y: 0, z: 0, yaw: 0 };
  }

  function applyPatch() {
    if (typeof Space3DViewer === "undefined") return false;
    if (Space3DViewer.prototype.__subtTopdownPatched) return true;
    Space3DViewer.prototype.__subtTopdownPatched = true;

    // --- onCreate: after stock setup, lock the camera for the lidar topic only.
    var origOnCreate = Space3DViewer.prototype.onCreate;
    Space3DViewer.prototype.onCreate = function () {
      origOnCreate.call(this);

      var lt = lockedTopic();
      this.topdownFollow = !!(lt && this.topicName === lt);
      if (!this.topdownFollow) return; // any other 3D view stays stock

      var that = this;
      this.cam_r = (window.SUBT.lidarTopdown.height || 30);

      // Fixed view: no rotate / pan / zoom.
      this.gl.onmouse = function () {};
      this.gl.onmousewheel = function () {};

      // Top-down follow camera: directly above the robot looking straight down.
      // Orientation is WORLD-FIXED by default (map north-up: world +x = screen
      // right, world +y = screen up) -- the map does not spin as the robot turns,
      // it only pans to keep the robot centered. Set lidarTopdown.followYaw = true
      // to instead lock the robot's forward direction to screen-up (FPS style).
      var followYaw = !!(window.SUBT.lidarTopdown && window.SUBT.lidarTopdown.followYaw);
      // World-fixed screen orientation, rotated to match RViz. 0 = world +y up;
      // 90 = world +x up (RViz/compass x-up convention). Try 90 / -90 / 180 if the
      // map comes out rotated the wrong way. Ignored in followYaw mode.
      var rot = ((window.SUBT.lidarTopdown && window.SUBT.lidarTopdown.viewRotationDeg) || 0) * DEG2RAD;
      this.updatePerspective = function () {
        var p = pose();
        that.cam_pos[0] = p.x;
        that.cam_pos[1] = p.y;
        that.cam_pos[2] = p.z + that.cam_r;
        mat4.perspective(that.proj, 45 * DEG2RAD,
          that.gl.canvas.width / that.gl.canvas.height, 0.1, 1000);
        var up = followYaw
          ? [Math.cos(p.yaw), Math.sin(p.yaw), 0]
          : [Math.sin(rot), Math.cos(rot), 0];
        mat4.lookAt(that.view, that.cam_pos, [p.x, p.y, p.z], up);
        mat4.multiply(that.mvp, that.proj, that.view);
      };

      // Refresh the camera every frame so it tracks the moving robot.
      var origOndraw = this.gl.ondraw;
      this.gl.ondraw = function () {
        that.updatePerspective();
        origOndraw();
      };

      this.updatePerspective();
    };

    // --- draw: for the locked view, strip the stock static grid + origin axes
    //     and draw body axes at the robot (red = forward) as the heading
    //     indicator. The world-aligned grid is opt-in via
    //     lidarTopdown.showGrid; default off since the point cloud itself
    //     provides plenty of motion cue.
    var origDraw = Space3DViewer.prototype.draw;
    Space3DViewer.prototype.draw = function (drawObjects) {
      origDraw.call(this, drawObjects);
      if (!this.topdownFollow) return;

      var self = this;
      var p = pose();
      var i;
      var showGrid = !!(window.SUBT.lidarTopdown && window.SUBT.lidarTopdown.showGrid);

      // Body axes at the robot: red = forward, green = left, blue = up. In the
      // world-fixed view the red arrow rotates with the robot to show heading
      // (like a compass needle on a map); in followYaw mode it points up.
      var L = 2.5, az = 0.15;
      var fx = Math.cos(p.yaw), fy = Math.sin(p.yaw);
      var lx = -Math.sin(p.yaw), ly = Math.cos(p.yaw);
      var av = [
        p.x, p.y, az,  p.x + fx * L, p.y + fy * L, az,   // x forward
        p.x, p.y, az,  p.x + lx * L, p.y + ly * L, az,   // y left
        p.x, p.y, az,  p.x, p.y, az + L                  // z up
      ];
      var ac = [
        1, 0, 0, 1,   1, 0, 0, 1,        // red   (forward)
        0, 1, 0, 1,   0, 1, 0, 1,        // green (left)
        0, 0.5, 1, 1, 0, 0.5, 1, 1       // blue  (up)
      ];
      var axes = GL.Mesh.load({ vertices: av, colors: ac }, null, null, this.gl);

      // Drop the stock static grid + axes (matched by reference).
      this.drawObjectsGl = this.drawObjectsGl.filter(function (o) {
        return o.mesh !== self.gridMesh && o.mesh !== self.axesMesh;
      });
      if (showGrid) {
        // Optional world-aligned grid (1 m) around the robot -- lines sit at
        // integer world coords so they scroll past as the robot moves.
        var R = Math.max(8, Math.round(this.cam_r * 0.5));
        var cx = Math.round(p.x), cy = Math.round(p.y), gz = 0, gv = [], gc = [];
        for (var x = cx - R; x <= cx + R; x++) {
          gv.push(x, cy - R, gz, x, cy + R, gz);
          for (i = 0; i < 8; i++) gc.push(0.5);
        }
        for (var y = cy - R; y <= cy + R; y++) {
          gv.push(cx - R, y, gz, cx + R, y, gz);
          for (i = 0; i < 8; i++) gc.push(0.5);
        }
        var grid = GL.Mesh.load({ vertices: gv, colors: gc }, null, null, this.gl);
        this.drawObjectsGl.unshift({ type: "lines", mesh: grid });
      }
      this.drawObjectsGl.push({ type: "lines", mesh: axes });
    };

    return true;
  }

  // Space3DViewer is imported synchronously at the top of index.js, so by the
  // time this deferred script runs it normally exists. Retry briefly just in
  // case of load-order surprises.
  if (!applyPatch()) {
    var tries = 0;
    var iv = setInterval(function () {
      if (applyPatch() || ++tries > 100) clearInterval(iv);
    }, 50);
  }
})();
