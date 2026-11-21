#!/usr/bin/env python3
"""Send one heartbeat to a Necromancer guard, with retries (Python 3.8+, stdlib only).

    export HEARTBEAT_URL="http://192.168.1.8:8123/api/necromancer/heartbeat/<name>_<token>"
    ./backup.sh; python3 ping.py $?     # pass the job's exit code: 0 = success, else failure
    python3 ping.py                     # no argument = success
    python3 ping.py fail                # report a failure without a code

Or from your own Python job:

    from ping import send_heartbeat
    send_heartbeat("0" if ok else "fail")

Retries on no connection, 404, 429 and 5xx (Home Assistant restarting, Necromancer
reloading) every HEARTBEAT_DELAY seconds, HEARTBEAT_ATTEMPTS times in all (default
11 x 60 s, about 10 minutes; a missing, invalid or < 1 value means the default). Stops
at once on 2xx (done), on 400/403 (wrong setup, retrying cannot help) and on a
redirect (3xx: not followed, a redirected POST would come back as a GET and get 405).
Never prints the URL: the token in it is the secret.

Exit code: 0 delivered, 1 rejected (400/403/3xx/unexpected), 2 gave up after all attempts.
"""

import http.client
import math
import os
import re
import sys
import time
import urllib.error
import urllib.request

RETRY = {404, 429}  # plus 0 (no connection) and every 5xx


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """Do not follow redirects: the 3xx comes back as an HTTPError with its code."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


_OPENER = urllib.request.build_opener(_NoRedirect)


def _post(url: str) -> int:
    """POST without a body; return the HTTP status, 0 when there was no connection."""
    request = urllib.request.Request(url, data=b"", method="POST")
    try:
        with _OPENER.open(request, timeout=10) as response:
            return response.status
    except urllib.error.HTTPError as err:
        return err.code
    except (urllib.error.URLError, OSError, http.client.HTTPException):
        # No connection, timeout, or a connection cut mid-answer (HA restarting).
        return 0


def _env_number(name: str, default: float, minimum: float) -> float:
    """A number from the environment; missing, invalid or below `minimum` = default."""
    try:
        value = float(os.environ.get(name, ""))
    except ValueError:
        return default
    return value if math.isfinite(value) and value >= minimum else default


def send_heartbeat(status=None):
    """Send the ping; `status` None = success. Returns the exit code described above."""
    url = os.environ.get("HEARTBEAT_URL", "")
    attempts = int(_env_number("HEARTBEAT_ATTEMPTS", 11, 1))
    delay = _env_number("HEARTBEAT_DELAY", 60, 0)
    if not url:
        print("heartbeat: HEARTBEAT_URL is not set", file=sys.stderr)
        return 1
    if status is not None:
        # Plain values only: Home Assistant answers 400 to odd characters in a
        # query. Anything else still counts as a failure, so send it as "fail".
        if not re.fullmatch(r"[A-Za-z0-9_-]*", status):
            status = "fail"
        url += ("&" if "?" in url else "?") + "status=" + status

    for attempt in range(1, attempts + 1):
        code = _post(url)
        if 200 <= code < 300:
            return 0
        if 300 <= code < 400:
            print(
                f"heartbeat: HTTP {code} - the URL redirects (e.g. a proxy sends http to"
                " https). Put the final URL in HEARTBEAT_URL. Not retrying.",
                file=sys.stderr,
            )
            return 1
        if code == 400:
            print(
                "heartbeat: HTTP 400 - Home Assistant refused the request (odd characters"
                " in the status, or a proxy sends X-Forwarded-For that Home Assistant is"
                " not set up for). Not retrying.",
                file=sys.stderr,
            )
            return 1
        if code == 403:
            print(
                "heartbeat: HTTP 403 - this host does not count as a local network (guard"
                " has 'Local network only'). Use Home Assistant's IPv4 address."
                " Not retrying.",
                file=sys.stderr,
            )
            return 1
        if code != 0 and code not in RETRY and code < 500:
            print(f"heartbeat: unexpected HTTP {code}. Not retrying.", file=sys.stderr)
            return 1
        if attempt < attempts:
            time.sleep(delay)

    why = {
        0: "no connection to Home Assistant",
        404: "unknown token (wrong or regenerated URL) or Necromancer not loaded",
    }.get(code, f"HTTP {code}")
    print(f"heartbeat: gave up after {attempts} attempts - {why}.", file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(send_heartbeat(sys.argv[1] if len(sys.argv) > 1 else None))
