# SubT experiment customizations

This is a fork of [dheera/rosboard](https://github.com/dheera/rosboard) adapted
for participant-facing SubT/AEDE experiments. Upstream is tracked as the `upstream`
remote; experiment changes live on `feature/subt-experiment-ui`.

## What changed (small, isolated diff)

New files (all under `rosboard/html/js/`):
- **`subt_config.js`** — single place that controls everything: the topic
  whitelist, the `lockdown` flag, and the joystick settings.
- **`subt_joystick.js`** — a mouse/touch joystick overlay that publishes
  `geometry_msgs/Twist` to `/X1/cmd_vel` via **rosbridge** (rosboard is
  view-only and cannot publish, so the joystick uses roslibjs → rosbridge).
- **`roslib.min.js`** — vendored roslibjs (used by the joystick).

Edited:
- **`html/index.html`** — loads the three scripts above.
- **`html/js/index.js`** — four small guarded hooks, all behind
  `window.SUBT.lockdown`:
  - auto-subscribe only to the whitelist on connect,
  - skip rendering the topic sidebar (no browsing/adding),
  - block subscribing to anything off the whitelist,
  - ignore the viewer close button (views are fixed).

## Configure

Edit `rosboard/html/js/subt_config.js`:
- `whitelist` — the only topics participants can see (default: front camera +
  registered scan).
- `lockdown: true|false` — locked participant view vs. stock rosboard.
- `joystick` — topic, max speeds, publish rate. The joystick finds rosbridge on
  `location.port + rosbridgePortOffset` (210, matching the session port scheme);
  override per-page with `?rb=<port>`.

## How it's served

The Docker session/experiment containers bind-mount this fork to
`/opt/rosboard_fork` and run it instead of the baked-in clone, so edits here are
live on a browser refresh (no image rebuild). See `subt_aede/docker/`.
