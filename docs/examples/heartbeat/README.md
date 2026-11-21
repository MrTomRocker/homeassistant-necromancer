# Heartbeat senders

Ready-to-use senders for a Necromancer [heartbeat guard](https://github.com/MrTomRocker/homeassistant-necromancer#heartbeat).
Each one sends **one** ping with the right retry rule, so a ping isn't lost while Home Assistant
restarts:

| File | Runs on | Needs |
|---|---|---|
| [`ping.sh`](https://github.com/MrTomRocker/homeassistant-necromancer/blob/main/docs/examples/heartbeat/ping.sh) | Linux, macOS, NAS (cron, Synology task, systemd) | bash, curl |
| [`ping.py`](https://github.com/MrTomRocker/homeassistant-necromancer/blob/main/docs/examples/heartbeat/ping.py) | anything with Python 3.8+ | standard library only |
| [`ping.cjs`](https://github.com/MrTomRocker/homeassistant-necromancer/blob/main/docs/examples/heartbeat/ping.cjs) | anything with Node.js 18+ | no packages (built-in `fetch`) |
| [`ping.ps1`](https://github.com/MrTomRocker/homeassistant-necromancer/blob/main/docs/examples/heartbeat/ping.ps1) | Windows, Task Scheduler | PowerShell 7+ |

## Use

The URL comes from the environment, never from the command line (a command line ends up in
process lists and logs, and the token in the URL is the only secret). `ping.sh` hands it on to
curl through stdin (`curl -K -`), so it doesn't show up in curl's command line either; the other
three send the request themselves and start no other program:

```bash
export HEARTBEAT_URL="http://192.168.1.8:8123/api/necromancer/heartbeat/<name>_<token>"

/usr/local/bin/backup.sh; ./ping.sh $?   # the job's exit code: 0 = success, anything else = failure
./ping.sh                                # no argument = success
./ping.sh fail                           # a failure without a code
```

`ping.py`, `ping.cjs` and `ping.ps1` take the same argument (`python3 ping.py $?`,
`node ping.cjs $?`, `.\ping.ps1 $LASTEXITCODE`). `ping.py` and `ping.cjs` can also be imported
(`send_heartbeat(...)` / `sendHeartbeat(...)`) when the job itself is Python or Node.

`ping.cjs` is CommonJS on purpose, and the `.cjs` extension makes Node load it as CommonJS even in
a project whose `package.json` says `"type": "module"`. So it runs as a script anywhere, and both
`require("./ping.cjs")` and `import { sendHeartbeat } from "./ping.cjs"` work. Keep the extension
when you copy it — renamed to `.js` inside an ES-module project it fails with
`require is not defined`.

A status other than plain letters, digits, `_` and `-` is sent as `fail` — it is a failure
anyway, and Home Assistant would refuse odd characters in the query with `400`.

## What they do

- **`POST` only**, no body. A `GET` gets `405`.
- **Retry** on no connection, `404`, `429` and `5xx` — Home Assistant is restarting, Necromancer
  is still loading or reloading. By default 11 attempts, 60 s apart (about 10 minutes).
- **Stop at once** on `2xx` (done), and on `400` / `403` with an error on stderr: retrying can't
  fix a wrong setup.
- **Don't follow redirects.** A redirected `POST` comes back as a `GET` and gets `405`, which
  would hide the real cause. A `3xx` (typically a proxy sending `http` to `https`) stops with
  *"the URL redirects … Put the final URL in HEARTBEAT_URL"* — use the address it redirects to.
- **Never print the URL.** Error messages name the HTTP code only.

| Exit code | Meaning |
|---|---|
| `0` | delivered (`2xx`) |
| `1` | refused: `400`, `403`, a redirect (`3xx`) or an unexpected answer — fix the setup |
| `2` | gave up after all attempts — the message names the last reason |

| Environment variable | Default | |
|---|---|---|
| `HEARTBEAT_URL` | — | the guard's URL (required) |
| `HEARTBEAT_ATTEMPTS` | `11` | attempts in all, a whole number (at least 1); a fraction is cut off (`1.5` → 1), except in `ping.sh`, where it is invalid and means the default |
| `HEARTBEAT_DELAY` | `60` | seconds between attempts (`0` or more) |

An invalid value, or one below the minimum, means the default.

The retries can block for up to ~10 minutes. Call the sender as the **last** step of the job, or
start it detached — the [job heartbeat recipe](https://github.com/MrTomRocker/homeassistant-necromancer/blob/main/docs/cookbook/job-heartbeat.md)
shows crontab, Synology and systemd setups.
