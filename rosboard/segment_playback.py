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


def read_bag_duration(bag_path):
    """Return playback seconds from metadata.yaml, or None if unreadable."""
    meta_path = os.path.join(bag_path, 'metadata.yaml')
    if yaml is None or not os.path.isfile(meta_path):
        return None
    try:
        with open(meta_path, 'r', encoding='utf-8') as handle:
            data = yaml.safe_load(handle) or {}
    except (OSError, ValueError):
        return None
    info = data.get('rosbag2_bagfile_information', {})
    nanoseconds = info.get('duration', {}).get('nanoseconds')
    return round(nanoseconds * 1e-9, 2) if nanoseconds else None


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


class SegmentPlayer(object):
    """Owns at most one ``ros2 bag play`` process."""

    def __init__(self, segment_dir):
        self.segment_dir = segment_dir
        self.process = None
        self.current = None
        self.started_at = None
        self.duration = None
        self.lock = threading.Lock()

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
            if loop:
                cmd.append('--loop')
            try:
                # Own process group so stopping kills the whole player tree.
                self.process = subprocess.Popen(cmd, preexec_fn=os.setsid)
            except OSError as exc:
                return False, 'Could not start playback: {}'.format(exc)
            self.current = name
            self.started_at = time.time()
            self.duration = read_bag_duration(path)
        return True, 'Playing {}'.format(name)

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
    ]
    return routes, player
