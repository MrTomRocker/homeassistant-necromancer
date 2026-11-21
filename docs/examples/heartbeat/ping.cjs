#!/usr/bin/env node
// Send one heartbeat to a Necromancer guard, with retries (Node.js 18+, no packages).
//
//   export HEARTBEAT_URL="http://192.168.1.8:8123/api/necromancer/heartbeat/<name>_<token>"
//   ./backup.sh; node ping.cjs $?     # pass the job's exit code: 0 = success, else failure
//   node ping.cjs                     # no argument = success
//   node ping.cjs fail                # report a failure without a code
//
// Or from your own Node job, CommonJS or ES module alike:
//
//   const { sendHeartbeat } = require("./ping.cjs");   // CommonJS
//   import { sendHeartbeat } from "./ping.cjs";         // ES module
//   await sendHeartbeat(ok ? "0" : "fail");
//
// The .cjs extension makes Node load this file as CommonJS whatever the nearest
// package.json says ("type": "module" included), so it runs as a script and imports
// from both module systems without changes.
//
// Retries on no connection, 404, 429 and 5xx (Home Assistant restarting, Necromancer
// reloading) every HEARTBEAT_DELAY seconds, HEARTBEAT_ATTEMPTS times in all (default
// 11 x 60 s, about 10 minutes; a missing, invalid or < 1 value means the default). Stops
// at once on 2xx (done), on 400/403 (wrong setup, retrying cannot help) and on a
// redirect (3xx: not followed, a redirected POST would come back as a GET and get 405).
// Never prints the URL: the token in it is the secret.
//
// Exit code: 0 delivered, 1 rejected (400/403/3xx/unexpected), 2 gave up after all attempts.

"use strict";

const RETRY = new Set([404, 429]); // plus 0 (no connection) and every 5xx

async function post(url) {
  // POST without a body; the HTTP status, 0 when there was no connection.
  try {
    const response = await fetch(url, {
      method: "POST",
      redirect: "manual", // a 3xx comes back as is, see above
      signal: AbortSignal.timeout(10000),
    });
    return response.status;
  } catch {
    return 0;
  }
}

function envNumber(name, fallback, minimum) {
  // A number from the environment; missing, invalid or below `minimum` = fallback.
  const raw = process.env[name];
  const value = raw === undefined || raw.trim() === "" ? NaN : Number(raw);
  return Number.isFinite(value) && value >= minimum ? value : fallback;
}

async function sendHeartbeat(status) {
  let url = process.env.HEARTBEAT_URL || "";
  const attempts = Math.trunc(envNumber("HEARTBEAT_ATTEMPTS", 11, 1));
  const delay = envNumber("HEARTBEAT_DELAY", 60, 0);
  if (!url) {
    console.error("heartbeat: HEARTBEAT_URL is not set");
    return 1;
  }
  if (status !== undefined) {
    // Plain values only: Home Assistant answers 400 to odd characters in a query.
    // Anything else still counts as a failure, so send it as "fail".
    if (!/^[A-Za-z0-9_-]*$/.test(status)) status = "fail";
    url += (url.includes("?") ? "&" : "?") + "status=" + status;
  }

  let code = 0;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    code = await post(url);
    if (code >= 200 && code < 300) return 0;
    if (code >= 300 && code < 400) {
      console.error(
        `heartbeat: HTTP ${code} - the URL redirects (e.g. a proxy sends http to https). ` +
          "Put the final URL in HEARTBEAT_URL. Not retrying."
      );
      return 1;
    }
    if (code === 400) {
      console.error(
        "heartbeat: HTTP 400 - Home Assistant refused the request (odd characters in the " +
          "status, or a proxy sends X-Forwarded-For that Home Assistant is not set up for). " +
          "Not retrying."
      );
      return 1;
    }
    if (code === 403) {
      console.error(
        "heartbeat: HTTP 403 - this host does not count as a local network (guard has " +
          "'Local network only'). Use Home Assistant's IPv4 address. Not retrying."
      );
      return 1;
    }
    if (code !== 0 && !RETRY.has(code) && code < 500) {
      console.error(`heartbeat: unexpected HTTP ${code}. Not retrying.`);
      return 1;
    }
    if (attempt < attempts) {
      await new Promise((resolve) => setTimeout(resolve, delay * 1000));
    }
  }

  const why =
    code === 0
      ? "no connection to Home Assistant"
      : code === 404
        ? "unknown token (wrong or regenerated URL) or Necromancer not loaded"
        : `HTTP ${code}`;
  console.error(`heartbeat: gave up after ${attempts} attempts - ${why}.`);
  return 2;
}

module.exports = { sendHeartbeat };

if (require.main === module) {
  sendHeartbeat(process.argv[2]).then((exitCode) => process.exit(exitCode));
}
