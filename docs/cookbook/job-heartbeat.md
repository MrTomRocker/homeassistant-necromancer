# Know when a nightly backup didn't run — and re-run it

> A job outside Home Assistant has no entity to watch, so let the job report in: it pings a secret URL when it's done, and Necromancer raises the alarm — or wakes the server and re-runs the job — when the ping is late or reports a failure.

**Concepts shown:** heartbeat source · period + grace (*Wait before reacting*) · exit code in the alert · ready-made senders with retries · crontab / Synology / systemd · repair + Health Check verified by the next ping
**Use it for:** backups, cron and systemd jobs, NAS tasks, sync and export scripts — anything that runs on a schedule outside Home Assistant.

## The problem

Your NAS backs itself up every night at 03:00. One day the script starts failing on a full disk,
or the cron daemon stops after an update, or the NAS just stays asleep. Nothing turns red: the
backup job has no entity in Home Assistant, and a job that *didn't run* writes no error anywhere.
You find out the day you need the backup.

The fix is a dead man's switch: the job reports *"I ran, and here's how it went"* after every run,
and something notices when that report doesn't come.

**Which one do I need?** If the thing you watch *does* have an entity in Home Assistant (a Node-RED
value, an MQTT feed, a sensor), you don't need a heartbeat — check its `last_reported` with a
template, see [Freshness watchdog (Node-RED)](https://github.com/MrTomRocker/homeassistant-necromancer/blob/main/docs/cookbook/nodered-heartbeat.md).
This recipe is for jobs **outside** Home Assistant.

## The guard

**Health Source:** *Heartbeat (ping URL)*.

```text
Name:                Nightly Backup
Period:              1 day       # how often the job reports success
Local network only:  on          # the NAS is in the LAN
Strategy:            Notify only (a repair variant follows below)
Wait before reacting: 2 h        # the grace: the job may run late
```

The wizard's last step shows the guard's URL and three commands to copy. There's no copy button —
**triple-click** a line to select it. The URL looks like
`http://192.168.1.8:8123/api/necromancer/heartbeat/nightly_backup_<token>`; the token is the only
secret, so keep the URL out of command lines and git.

A notify action (see [Notifications](https://github.com/MrTomRocker/homeassistant-necromancer#notifications)):

```yaml
- action: notify.mobile_app_phone
  data:
    title: "{{ name }}"
    message: "{{ event_text }}"   # "Problem detected. Failure reported, exit code 3."
```

## Send the ping

Use one of the ready-made senders in
[`docs/examples/heartbeat`](https://github.com/MrTomRocker/homeassistant-necromancer/tree/main/docs/examples/heartbeat)
— here [`ping.sh`](https://github.com/MrTomRocker/homeassistant-necromancer/blob/main/docs/examples/heartbeat/ping.sh)
(bash + curl). It `POST`s once, passes the exit code as `status`, and retries for about 10 minutes
while Home Assistant restarts (no connection, `404`, `429`, `5xx`) — but stops at once on `400` /
`403`, where retrying can't help. It reads the URL from `HEARTBEAT_URL`, never from its arguments.

Put the URL in a file only root can read:

```bash
# /etc/heartbeat/nightly-backup.env   (chmod 600)
HEARTBEAT_URL=http://192.168.1.8:8123/api/necromancer/heartbeat/nightly_backup_<token>
```

### crontab

```bash
# m h dom mon dow  command
0 3 * * *  set -a; . /etc/heartbeat/nightly-backup.env; set +a; /usr/local/bin/backup.sh; /usr/local/bin/ping.sh $?
```

`$?` is the backup's exit code: `0` reports success, anything else a failure with that code in
the alert. The sender is the last step, so its retries don't hold anything up.

Better, once there's more than one place that starts the job — a small wrapper that also makes a
second start harmless (you'll want that for the repair below):

```bash
#!/bin/bash
# /usr/local/bin/run-backup — run the backup once, then report
exec 9>/run/lock/nightly-backup.lock
flock -n 9 || exit 0     # already running: that run will report
set -a; . /etc/heartbeat/nightly-backup.env; set +a
/usr/local/bin/backup.sh
/usr/local/bin/ping.sh $?
```

```bash
0 3 * * *  /usr/local/bin/run-backup
```

### Synology Task Scheduler

*Control Panel → Task Scheduler → Create → Scheduled Task → User-defined script*, user `root`,
schedule daily 03:00. Copy `ping.sh` and the env file to `/volume1/scripts/`
(`chmod 600 heartbeat.env`) and put this in *Run command*:

```bash
set -a; . /volume1/scripts/heartbeat.env; set +a
/volume1/scripts/backup.sh
/volume1/scripts/ping.sh $?
```

DSM ships bash and curl, nothing else to install. Keep the URL in the env file, not in the task's
command box — the box is visible to every admin.

### systemd

A systemd job reports from `ExecStopPost`, which runs after success **and** failure and gets the
result in `$EXIT_STATUS` (a number, or a signal name like `TERM` when the job was killed):

```ini
# /etc/systemd/system/nightly-backup.service
[Unit]
Description=Nightly backup

[Service]
Type=oneshot
ExecStart=/usr/local/bin/backup.sh
ExecStopPost=/bin/sh -c 'exec /usr/local/bin/heartbeat-notify nightly-backup "$${EXIT_STATUS:-fail}"'
```

(`$$` is systemd's escape for a literal `$`; `:-fail` reports a failure if the job never started.)
Schedule it with a `nightly-backup.timer` as usual.

`ExecStopPost` shouldn't block for 10 minutes of retries, so `heartbeat-notify` hands the ping to
a **transient unit** and returns at once:

```sh
#!/bin/sh
# /usr/local/bin/heartbeat-notify <check> <status>
check="$1"
unit="heartbeat-ping-$check"
# One ping per check in flight: a newer run replaces an older one still retrying.
systemctl stop "$unit" 2>/dev/null
systemctl reset-failed "$unit" 2>/dev/null
systemd-run --no-block --collect --unit="$unit" --description="heartbeat ping $check" \
  -p EnvironmentFile="/etc/heartbeat/$check.env" \
  /usr/local/bin/ping.sh "$2"
exit 0
```

Why it's built this way:

- **`systemd-run`, not `setsid … &`.** A background process would stay in the job's cgroup, and
  systemd kills everything left in it once `ExecStopPost` returns — the retries would never happen.
- **`--collect`.** If the sender is ever killed, the transient unit would otherwise stay loaded as
  `failed`, and every later `systemd-run` with the same name would fail — silently, because the
  wrapper always returns 0. `reset-failed` above is the second safety net.
- **`EnvironmentFile`.** Only the check name and the status are on the command line, which ends up
  in the journal. The URL with its token is read inside the unit.

Errors (`403`, gave up, …) land in `journalctl -u heartbeat-ping-nightly-backup`.

## How it works

- **Deadline** = the last successful ping + **period**. A new guard waits grey (`blind`,
  *"Waiting for the first heartbeat."*) for its first successful ping — up to its first deadline
  (creation + period); without a ping by then it turns `suspect` like an overdue job.
- When the deadline passes, the guard turns `suspect` for its **Wait before reacting** — the grace
  for a late run. A ping inside the grace ends it silently; after it, the notify action runs:
  *"Nightly Backup: Problem detected. No heartbeat for 26 hours, expected every 24 hours."*
- **A failure ping skips the grace** — the job said itself that it failed:
  *"Nightly Backup: Problem detected. Failure reported, exit code 3."*
- The next successful ping makes the guard healthy again right away.

The grace counts from the deadline, so a Home Assistant restart in between doesn't postpone the
alarm. Short outages while the job pings are bridged by the sender's retries.

## The clever bit: repair it, don't just report it

A heartbeat guard can run any recovery strategy, and **the next successful ping is its Health
Check**. So "fixed" means the backup really ran again, not that a command returned.

Switch the strategy to **Run an action**, keep **Health Check** on, and wake the NAS before
re-running the job:

```yaml
# Recovery: Run an action
- action: wake_on_lan.send_magic_packet   # needs `wake_on_lan:` in configuration.yaml
  data:
    mac: "00:11:32:aa:bb:cc"
- delay: "00:02:00"                        # let the NAS boot
- action: shell_command.rerun_backup
```

```yaml
# configuration.yaml — shell_command stops after 60 s, so start the job in the background
shell_command:
  rerun_backup: >-
    ssh -i /config/.ssh/id_ed25519 -o StrictHostKeyChecking=accept-new root@192.168.1.10
    'nohup /usr/local/bin/run-backup >/dev/null 2>&1 &'
```

```text
Wait before reacting: 2 h
Boot window:          1 h     # at least the backup's runtime — 1 h is the maximum
Max attempts:         1       # one re-run; if that fails too, escalate
```

Now: no ping by 05:05 → wake the NAS → re-run → the guard sits in `verify` until `run-backup` pings.
Success ping within the hour → `recovered`. A failure ping or no ping → `escalated`, and you're
told. The wrapper's `flock` makes a re-run harmless if the original run was still going.

The same shape fits other jobs: restart the service or container that runs it, power-cycle a
frozen Raspberry Pi through its smart plug (**Power-cycle a switch**), restart a VM or an add-on.
The README lists them under
[Repair a job](https://github.com/MrTomRocker/homeassistant-necromancer#repair-a-job).

## A ping got lost

The backup ran, but Home Assistant was down longer than the sender's 10 minutes of retries? Record
the heartbeat by hand — `necromancer.reset` won't do, the heartbeat would still be overdue:

```yaml
type: button
name: Backup ran — mark as OK
icon: mdi:heart-pulse
tap_action:
  action: perform-action
  perform_action: necromancer.heartbeat_ping
  target:
    entity_id: sensor.nightly_backup_status
  confirmation:
    text: Record a successful heartbeat for the nightly backup now?
```

## Adapt it to your setup

- **Period.** How often the job *should* succeed: 1 day for a nightly job, 7 days for a weekly one,
  1 hour for an hourly sync. At least 1 minute.
- **Grace (*Wait before reacting*).** How late a run may be before it counts as missed — the job's
  usual runtime plus some slack. 1 h by default, up to 1 day.
- **Python, Node.js or Windows?** Same rules, other senders:
  [`ping.py`](https://github.com/MrTomRocker/homeassistant-necromancer/blob/main/docs/examples/heartbeat/ping.py),
  [`ping.cjs`](https://github.com/MrTomRocker/homeassistant-necromancer/blob/main/docs/examples/heartbeat/ping.cjs),
  [`ping.ps1`](https://github.com/MrTomRocker/homeassistant-necromancer/blob/main/docs/examples/heartbeat/ping.ps1)
  (Task Scheduler: `powershell.exe -NoProfile -ExecutionPolicy Bypass -File …`, `HEARTBEAT_URL` as
  an environment variable).
- **Back to normal.** Want a message when an escalated backup finally pings again? Trigger on the
  status sensor `from: escalated` `to: ok` — see
  [On your dashboard & in automations](https://github.com/MrTomRocker/homeassistant-necromancer#on-your-dashboard--in-automations).

## Gotchas & variations

- **Always pass the status.** A sender that calls the URL without `status` reports success even
  when the job failed. An empty `status=` counts as a failure on purpose — it's usually an unset
  variable.
- **`403` in the sender's log.** The sender doesn't count as local. Use Home Assistant's **IPv4
  address** in the URL: a host name may resolve to a global IPv6 address.
- **`404` that doesn't go away.** Wrong URL, or the token was regenerated. A `404` during Home
  Assistant's start is normal — Necromancer isn't loaded yet — and the sender retries.
- **Long jobs.** The repair is verified within the boot window, at most 1 h. A job that runs
  longer is a case for **Notify only**.
- **A hanging job** shows up at its deadline, not earlier: there's no "job started" signal. With
  a daily job that's barely later — a backup that hangs at 03:00 is reported at deadline + grace.
- **Home Assistant itself** can't be watched from inside Home Assistant. Keep one external check
  for that.
- More on answers, `http` vs `https` and security:
  [Heartbeat](https://github.com/MrTomRocker/homeassistant-necromancer#heartbeat).
