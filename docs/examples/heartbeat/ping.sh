#!/usr/bin/env bash
# Send one heartbeat to a Necromancer guard, with retries.
#
#   export HEARTBEAT_URL="http://192.168.1.8:8123/api/necromancer/heartbeat/<name>_<token>"
#   ./backup.sh; ./ping.sh $?        # pass the job's exit code: 0 = success, anything else = failure
#   ./ping.sh                        # no argument = success
#   ./ping.sh fail                   # report a failure without a code
#
# Retries on no connection, 404, 429 and 5xx (Home Assistant restarting, Necromancer
# reloading) every HEARTBEAT_DELAY seconds, HEARTBEAT_ATTEMPTS times in all (default
# 11 x 60 s, about 10 minutes; a missing, invalid or < 1 value means the default). Stops
# at once on 2xx (done), on 400/403 (wrong setup, retrying cannot help) and on a
# redirect (3xx; it is not followed, see below). Never prints the URL: the token in it
# is the secret, so it is handed to curl on stdin (`-K -`), not as an argument that
# every local user could read in the process list.
#
# Exit code: 0 delivered, 1 rejected (400/403/3xx/unexpected), 2 gave up after all attempts.
# Needs: bash, curl.

set -u

url="${HEARTBEAT_URL:-}"
attempts="${HEARTBEAT_ATTEMPTS:-}"
delay="${HEARTBEAT_DELAY:-}"
# A whole number >= 1, else the default.
case "$attempts" in
  '' | *[!0-9]*) attempts=11 ;;
esac
[ "$attempts" -ge 1 ] 2>/dev/null || attempts=11
# Seconds, e.g. 60 or 0.5; anything else falls back to the default.
case "$delay" in
  '' | . | *[!0-9.]* | *.*.*) delay=60 ;;
esac

if [ -z "$url" ]; then
  echo "heartbeat: HEARTBEAT_URL is not set" >&2
  exit 1
fi

if [ "$#" -ge 1 ]; then
  status="$1"
  # Plain values only: Home Assistant answers 400 to odd characters in a query.
  # Anything else still counts as a failure, so send it as "fail".
  case "$status" in
    *[!A-Za-z0-9_-]*) status="fail" ;;
  esac
  case "$url" in
    *\?*) url="${url}&status=${status}" ;;
    *) url="${url}?status=${status}" ;;
  esac
fi

# The URL goes to curl as a config line on stdin (`-K -`), never as an argument:
# arguments are visible to every local user (ps, /proc/<pid>/cmdline). printf is a
# bash builtin, so it starts no process of its own. A real URL has no quote,
# backslash or line break; one with them would break the config line.
case "$url" in
  *[\"\\]* | *$'\n'* | *$'\r'*)
    echo "heartbeat: HEARTBEAT_URL contains a quote, backslash or line break - check the variable." >&2
    exit 1
    ;;
esac
config="url = \"${url}\""

i=1
while :; do
  # curl does not follow redirects (no -L): a redirected POST would come back as a
  # GET and get 405. curl's own error text is dropped on purpose: it can quote the URL.
  code=$(printf '%s\n' "$config" | curl -K - -s -m 10 -o /dev/null -w '%{http_code}' -X POST 2>/dev/null) || code="000"
  case "$code" in
    2??)
      exit 0
      ;;
    3??)
      echo "heartbeat: HTTP $code - the URL redirects (e.g. a proxy sends http to https). Put the final URL in HEARTBEAT_URL. Not retrying." >&2
      exit 1
      ;;
    400)
      echo "heartbeat: HTTP 400 - Home Assistant refused the request (odd characters in the status, or a proxy sends X-Forwarded-For that Home Assistant is not set up for). Not retrying." >&2
      exit 1
      ;;
    403)
      echo "heartbeat: HTTP 403 - this host does not count as a local network (guard has 'Local network only'). Use Home Assistant's IPv4 address. Not retrying." >&2
      exit 1
      ;;
    000 | 404 | 429 | 5??)
      ;; # retry below
    *)
      echo "heartbeat: unexpected HTTP $code. Not retrying." >&2
      exit 1
      ;;
  esac
  if [ "$i" -ge "$attempts" ]; then
    case "$code" in
      000) why="no connection to Home Assistant" ;;
      404) why="unknown token (wrong or regenerated URL) or Necromancer not loaded" ;;
      *) why="HTTP $code" ;;
    esac
    echo "heartbeat: gave up after $i attempts - $why." >&2
    exit 2
  fi
  i=$((i + 1))
  sleep "$delay"
done
