"""Serve recorded SubT segments for replay through rosboard.

rosboard already renders whatever is live on the ROS graph, so replaying a
segment needs no new rendering path: running ``ros2 bag play`` republishes the
recorded topics and the existing viewers pick them up unchanged. All that is
missing is a way to pick a bag and start it, which is what these handlers add.

Deliberately kept to plain subprocess control of ``ros2 bag play``. The
observer condition is pure playback -- no Gazebo, no planner -- so there is no
simulator state to coordinate with, and one process per playback is the whole
lifecycle.

Endpoints:
  GET  /segments/list    -> available segments with duration and stop reason
  POST /segments/play    -> {"name": "config_1"} start (replaces any current)
  POST /segments/stop    -> stop whatever is playing
  GET  /segments/status  -> what is playing right now
"""

import json
import os
import signal
import subprocess
import threading
import time

import tornado.web

try:
    import yaml
except ImportError:  # pragma: no cover - rosboard always ships pyyaml via ROS
    yaml = None


# Where recorded segments live. Inside a session container ~ is /root and only
# the bind-mounted session directory is visible, so the host path the bags were
# recorded to is not reachable by default. SUBT_SEGMENT_DIR lets the launcher
# point rosboard at whatever path it mounted them on.
DEFAULT_SEGMENT_DIR = os.path.expanduser(
    os.environ.get('SUBT_SEGMENT_DIR') or '~/subt_run_data/subt_stimulus_bags')


def read_bag_times(bag_path):
    """Return (start_epoch_sec, duration_sec) from metadata.yaml.

    The start time matters because rosbag2's Seek service takes an absolute
    stamp, so turning a scrub-bar fraction into a seek target needs the bag's
    own origin. The message count sizes scrub bursts. Returns
    (None, None, 0) when unreadable.
    """
    meta_path = os.path.join(bag_path, 'metadata.yaml')
    if yaml is None or not os.path.isfile(meta_path):
        return None, None, 0
    try:
        with open(meta_path, 'r', encoding='utf-8') as handle:
            data = yaml.safe_load(handle) or {}
    except (OSError, ValueError):
        return None, None, 0
    info = data.get('rosbag2_bagfile_information', {})
    duration = info.get('duration', {}).get('nanoseconds')
    start = info.get('starting_time', {}).get('nanoseconds_since_epoch')
    return (start * 1e-9 if start else None,
            round(duration * 1e-9, 2) if duration else None,
            int(info.get('message_count', 0)))


def read_bag_duration(bag_path):
    """Return playback seconds from metadata.yaml, or None if unreadable."""
    return read_bag_times(bag_path)[1]


def read_sidecar(bag_path):
    """Return the recorder's segment sidecar, if it wrote one."""
    sidecar = '{}_segment.json'.format(bag_path)
    if not os.path.isfile(sidecar):
        return {}
    try:
        with open(sidecar, 'r', encoding='utf-8') as handle:
            return json.load(handle) or {}
    except (OSError, ValueError):
        return {}


PLAYER_NS = '/rosbag2_player'


def _ros_node():
    """Return the live rclpy node, or None outside ROS 2.

    rosboard already owns a node and spins it on a background thread, so
    transport clients are created on that node and their futures complete
    without spinning here -- calling spin_until_future_complete() against an
    already-spinning node (as rospy2.ServiceProxy does) would deadlock.
    """
    try:
        from rosboard import rospy2
    except ImportError:
        return None
    return getattr(rospy2, '_node', None)


class SegmentPlayer(object):
    """Owns at most one ``ros2 bag play`` process and its transport."""

    # Bag time a scrub burst should cover. Long enough to include the slowest
    # displayed topic (the lidar preview, a few Hz), short enough that the
    # playhead barely moves from where the handle was dropped.
    BURST_SECONDS = 0.6

    # How close to the end counts as "at the end". Must exceed one /clock
    # tick so the guard cannot be stepped over between updates.
    END_GUARD_SEC = 0.15

    def __init__(self, segment_dir):
        self.segment_dir = segment_dir
        self.process = None
        self.current = None
        self.started_at = None
        self.duration = None
        self.bag_start = None
        self.lock = threading.Lock()
        self.clients = {}
        self.position = 0.0
        self.paused = False
        self.rate = 1.0
        self.burst_size = 400
        self.loop_requested = False
        self._end_pause_pending = False
        self._clock_sub = None

    # -- library ---------------------------------------------------------

    def list_segments(self):
        """Return every playable bag in the segment directory, sorted."""
        if not os.path.isdir(self.segment_dir):
            return []

        segments = []
        for name in sorted(os.listdir(self.segment_dir)):
            path = os.path.join(self.segment_dir, name)
            if not os.path.isdir(path):
                continue
            if not os.path.isfile(os.path.join(path, 'metadata.yaml')):
                continue
            sidecar = read_sidecar(path)
            segments.append({
                'name': name,
                'duration': read_bag_duration(path),
                'stop_reason': sidecar.get('stop_reason'),
                'world': sidecar.get('world'),
            })
        return segments

    def resolve(self, name):
        """Map a segment name to a bag path, refusing anything outside the dir."""
        if not name or os.path.sep in name or name.startswith('.'):
            return None
        path = os.path.join(self.segment_dir, name)
        if not os.path.isfile(os.path.join(path, 'metadata.yaml')):
            return None
        return path

    # -- transport -------------------------------------------------------

    def play(self, name, loop=False, rate=1.0, paused=False):
        """Start a segment. ``paused`` opens the bag without advancing it.

        Priming a segment paused matters for the study flow: its readiness
        check waits for every whitelist topic to have a publisher, and in the
        video condition nothing publishes them until a bag is open. rosbag2
        creates its publishers when the player starts, before playback, so a
        paused player satisfies that check without showing anything yet.
        """
        path = self.resolve(name)
        if path is None:
            return False, 'Unknown segment: {}'.format(name)

        with self.lock:
            self._stop_locked()
            # A running simulator publishes the same /tf, /state_estimation and
            # /clock the bag does. With both live, viewers interleave the two
            # and the robot appears to slide between its spawn pose and its
            # replayed pose without ever arriving. Pausing the world stops the
            # sim's sensor and clock updates, leaving the bag as sole
            # publisher. Best-effort: in CONDITION=video there is no sim to
            # pause and this is a no-op.
            self._pause_sim(read_sidecar(path).get('world'))
            cmd = [
                'ros2', 'bag', 'play', path,
                '--clock', '200',
                '--rate', str(rate),
                '--disable-keyboard-controls',
            ]
            if paused:
                cmd.append('--start-paused')
            # Always loop, even when the caller did not ask for it. A
            # non-looping player EXITS on reaching the end, which tears down
            # the transport and resets the scrub bar -- you could not drag
            # back from the end. Looping keeps the process alive; the
            # end-guard in _on_clock pauses on arrival at the last frame so it
            # parks there instead of wrapping around.
            cmd.append('--loop')
            self.loop_requested = bool(loop)
            try:
                # Own process group so stopping kills the whole player tree.
                self.process = subprocess.Popen(cmd, preexec_fn=os.setsid)
            except OSError as exc:
                return False, 'Could not start playback: {}'.format(exc)
            self.current = name
            self.started_at = time.time()
            self.bag_start, self.duration, count = read_bag_times(path)
            # Messages per second of bag time -> how many to burst to cover
            # BURST_SECONDS, which is what makes a paused scrub repaint the
            # slow topics (lidar) and not just the camera.
            density = (count / self.duration) if (count and self.duration) else 1000.0
            self.burst_size = max(50, int(density * self.BURST_SECONDS))
            self.position = 0.0
            self.paused = paused
            self.rate = rate
        self._ensure_clock_sub()
        return True, 'Playing {}'.format(name)

    # -- transport (scrubbing) -------------------------------------------

    def _ensure_clock_sub(self):
        """Track the playhead from /clock, published by the player itself.

        The player has no "where am I" service, but it is started with
        --clock, so clock time is bag time and (clock - bag_start) is the
        position. Subscribed BEST_EFFORT because that is what rosbag2
        publishes; a RELIABLE subscription silently never matches it.
        """
        if self._clock_sub is not None:
            return
        node = _ros_node()
        if node is None:
            return
        try:
            from rclpy.qos import (QoSDurabilityPolicy, QoSHistoryPolicy,
                                   QoSProfile, QoSReliabilityPolicy)
            from rosgraph_msgs.msg import Clock
        except ImportError:
            return
        qos = QoSProfile(
            history=QoSHistoryPolicy.KEEP_LAST, depth=1,
            reliability=QoSReliabilityPolicy.BEST_EFFORT,
            durability=QoSDurabilityPolicy.VOLATILE,
        )
        self._clock_sub = node.create_subscription(
            Clock, '/clock', self._on_clock, qos)

    def _on_clock(self, msg):
        if self.bag_start is None:
            return
        stamp = float(msg.clock.sec) + float(msg.clock.nanosec) * 1e-9
        pos = stamp - self.bag_start
        if self.duration:
            pos = max(0.0, min(self.duration, pos))
        self.position = pos

        # Park at the last frame rather than wrapping. The player is always
        # started with --loop so it survives the end, so something has to stop
        # it there; without this it would silently restart from zero.
        if (self.duration and not self.paused and not self.loop_requested
                and pos >= self.duration - self.END_GUARD_SEC):
            self._pause_at_end()

    def _pause_at_end(self):
        """Pause from the clock callback without blocking the executor.

        toggle_paused() waits on a service future, and this runs on the
        subscription callback thread -- waiting here would block the very
        executor that has to complete it. Hand off to a short-lived thread.
        """
        if self._end_pause_pending:
            return
        self._end_pause_pending = True

        def run():
            try:
                self.toggle_paused()
            finally:
                self._end_pause_pending = False

        threading.Thread(target=run, daemon=True).start()

    def _client(self, name, srv_type):
        node = _ros_node()
        if node is None:
            return None
        if name not in self.clients:
            self.clients[name] = node.create_client(
                srv_type, '{}/{}'.format(PLAYER_NS, name))
        return self.clients[name]

    def _call(self, name, srv_type, request, timeout=2.0):
        """Fire a player service call; the node's spin thread completes it."""
        client = self._client(name, srv_type)
        if client is None:
            return None
        # The player advertises its services a moment after the process
        # starts, so the first control press would otherwise be swallowed.
        # Wait briefly for discovery rather than dropping the request.
        ready_by = time.time() + timeout
        while not client.service_is_ready():
            if time.time() > ready_by:
                return None
            time.sleep(0.02)
        future = client.call_async(request)
        deadline = time.time() + timeout
        while time.time() < deadline:
            if future.done():
                return future.result()
            time.sleep(0.01)
        return None

    def toggle_paused(self):
        try:
            from rosbag2_interfaces.srv import IsPaused, TogglePaused
        except ImportError:
            return False, 'rosbag2_interfaces unavailable'
        # Resuming while parked at the end would hit the end-guard again and
        # pause immediately, so play from the top instead -- what a video
        # player does when you press play on a finished clip.
        if (self.paused and self.duration
                and self.position >= self.duration - self.END_GUARD_SEC):
            self.seek(0.0)
        if self._call('toggle_paused', TogglePaused, TogglePaused.Request()) is None:
            return False, 'player not responding'
        result = self._call('is_paused', IsPaused, IsPaused.Request())
        if result is not None:
            self.paused = bool(result.paused)
        else:
            self.paused = not self.paused
        return True, 'paused' if self.paused else 'playing'

    def seek(self, offset):
        """Seek to an absolute offset in seconds from the start of the bag."""
        try:
            from builtin_interfaces.msg import Time as TimeMsg
            from rosbag2_interfaces.srv import Seek
        except ImportError:
            return False, 'rosbag2_interfaces unavailable'
        if self.bag_start is None:
            return False, 'nothing playing'
        offset = max(0.0, min(self.duration or offset, offset))
        target = self.bag_start + offset
        request = Seek.Request()
        request.time = TimeMsg(sec=int(target),
                               nanosec=int(round((target % 1.0) * 1e9)))
        result = self._call('seek', Seek, request)
        if result is None or not result.success:
            return False, 'seek rejected'
        self.position = offset
        # While playing, the seek alone repaints the sensor views because
        # playback continues from the new point. While paused, nothing is
        # published, so scrubbing would move the playhead without changing
        # the picture. Bursting a short run of messages emits the frames at
        # the new position so the view tracks the drag.
        if self.paused:
            self._burst_one_frame()
            # The burst consumes messages, so it leaves the player ~BURST_SECONDS
            # past where the handle was dropped -- the playhead would creep
            # forward on its own after every paused scrub. Seek back so the
            # player rests exactly on the requested offset. No second burst:
            # the views keep the frame the burst already painted.
            self._call('seek', Seek, request)
            self.position = offset
        return True, 'seek {:.1f}s'.format(offset)

    def _burst_one_frame(self):
        """Emit a short burst so paused views repaint at the new position.

        A burst is used rather than play_next because one message is whatever
        topic comes first -- overwhelmingly /clock or /tf, not a sensor. The
        size is derived from the bag's own message density rather than fixed:
        the camera is ~2% of messages and the lidar preview ~0.6%, so a small
        burst reliably repaints neither. Covering BURST_SECONDS of bag time
        picks up both while moving the playhead only a fraction of a second.
        """
        try:
            from rosbag2_interfaces.srv import Burst
        except ImportError:
            return
        request = Burst.Request()
        request.num_messages = self.burst_size
        self._call('burst', Burst, request, timeout=2.0)

    def set_rate(self, rate):
        try:
            from rosbag2_interfaces.srv import SetRate
        except ImportError:
            return False, 'rosbag2_interfaces unavailable'
        rate = max(0.1, min(10.0, float(rate)))
        request = SetRate.Request()
        request.rate = rate
        result = self._call('set_rate', SetRate, request)
        if result is None or not result.success:
            return False, 'rate rejected'
        self.rate = rate
        return True, '{:.2f}x'.format(rate)

    def _pause_sim(self, world):
        """Pause the Gazebo world so it stops competing with the bag.

        Deliberately not unpaused afterwards: resuming would immediately put a
        second publisher back on the replay topics. A session that needs the
        sim running again is a sim session, which should not be replaying bags.
        """
        if not world:
            return
        try:
            subprocess.run(
                ['gz', 'service', '-s', '/world/{}/control'.format(world),
                 '--reqtype', 'gz.msgs.WorldControl',
                 '--reptype', 'gz.msgs.Boolean',
                 '--timeout', '2000', '--req', 'pause: true'],
                capture_output=True, timeout=5.0)
        except (subprocess.TimeoutExpired, OSError):
            pass

    def stop(self):
        with self.lock:
            self._stop_locked()
        return True, 'Stopped'

    def _stop_locked(self):
        process = self.process
        if process is None or process.poll() is not None:
            self.process = None
            self.current = None
            return
        os.killpg(os.getpgid(process.pid), signal.SIGINT)
        for escalation in (signal.SIGTERM, signal.SIGKILL):
            try:
                process.wait(timeout=3.0)
                break
            except subprocess.TimeoutExpired:
                os.killpg(os.getpgid(process.pid), escalation)
        self.process = None
        self.current = None

    def status(self):
        with self.lock:
            playing = self.process is not None and self.process.poll() is None
            if not playing:
                self.current = None
            return {
                'playing': playing,
                'segment': self.current,
                'duration': self.duration if playing else None,
                # Playhead from /clock, so it stays correct across pauses and
                # seeks -- wall time since start would drift on both.
                'position': round(self.position, 2) if playing else None,
                'paused': self.paused if playing else None,
                'rate': self.rate if playing else None,
                'elapsed': (round(time.time() - self.started_at, 2)
                            if playing and self.started_at else None),
            }


class _BaseHandler(tornado.web.RequestHandler):
    def initialize(self, player):
        self.player = player

    def set_default_headers(self):
        self.set_header('Content-Type', 'application/json')
        self.set_header('Cache-Control', 'no-store')

    def respond(self, payload, status=200):
        self.set_status(status)
        self.finish(json.dumps(payload))


class SegmentListHandler(_BaseHandler):
    def get(self):
        # `condition` lets the browser decide whether to show the picker at
        # all, instead of that being a separately-maintained flag that can
        # disagree with how the container was actually launched.
        self.respond({
            'segment_dir': self.player.segment_dir,
            'condition': os.environ.get('CONDITION', 'sim'),
            'segments': self.player.list_segments(),
        })


class SegmentPlayHandler(_BaseHandler):
    def post(self):
        try:
            body = json.loads(self.request.body or b'{}')
        except ValueError:
            return self.respond({'ok': False, 'error': 'Malformed JSON'}, 400)

        ok, message = self.player.play(
            body.get('name'),
            loop=bool(body.get('loop', False)),
            rate=float(body.get('rate', 1.0) or 1.0),
            paused=bool(body.get('paused', False)),
        )
        self.respond({'ok': ok, 'message': message}, 200 if ok else 404)


class SegmentStopHandler(_BaseHandler):
    def post(self):
        ok, message = self.player.stop()
        self.respond({'ok': ok, 'message': message})


class SegmentStatusHandler(_BaseHandler):
    def get(self):
        self.respond(self.player.status())


class SegmentTransportHandler(_BaseHandler):
    """Scrub-bar controls: toggle pause, seek to an offset, change rate."""

    def initialize(self, player, action):
        self.player = player
        self.action = action

    def post(self):
        try:
            body = json.loads(self.request.body or b'{}')
        except ValueError:
            return self.respond({'ok': False, 'error': 'Malformed JSON'}, 400)

        if self.action == 'toggle':
            ok, message = self.player.toggle_paused()
        elif self.action == 'seek':
            ok, message = self.player.seek(float(body.get('offset', 0.0)))
        elif self.action == 'rate':
            ok, message = self.player.set_rate(body.get('rate', 1.0))
        else:
            ok, message = False, 'unknown action'
        self.respond({'ok': ok, 'message': message, 'status': self.player.status()},
                     200 if ok else 409)


class SubtEnvHandler(tornado.web.RequestHandler):
    """Serve the session's condition as a synchronously-loadable script.

    The joystick and the study flow decide what to show at load time, before
    any fetch could resolve, so the condition has to be available as a plain
    global. Serving it as JS lets index.html pull it in ahead of the other
    scripts instead of every consumer racing an async request.
    """

    def set_default_headers(self):
        self.set_header('Content-Type', 'application/javascript')
        self.set_header('Cache-Control', 'no-store')

    def get(self):
        env = {
            'condition': os.environ.get('CONDITION', 'sim'),
            'mode': os.environ.get('MODE', 'sim'),
        }
        self.finish('window.SUBT_ENV = {};\n'.format(json.dumps(env)))


def make_handlers(segment_dir=None):
    """Return (routes, player) to splice into rosboard's tornado app."""
    player = SegmentPlayer(os.path.expanduser(segment_dir or DEFAULT_SEGMENT_DIR))
    routes = [
        (r'/subt_env.js', SubtEnvHandler),
        (r'/segments/list', SegmentListHandler, {'player': player}),
        (r'/segments/play', SegmentPlayHandler, {'player': player}),
        (r'/segments/stop', SegmentStopHandler, {'player': player}),
        (r'/segments/status', SegmentStatusHandler, {'player': player}),
        (r'/segments/toggle', SegmentTransportHandler, {'player': player, 'action': 'toggle'}),
        (r'/segments/seek', SegmentTransportHandler, {'player': player, 'action': 'seek'}),
        (r'/segments/rate', SegmentTransportHandler, {'player': player, 'action': 'rate'}),
    ]
    return routes, player
