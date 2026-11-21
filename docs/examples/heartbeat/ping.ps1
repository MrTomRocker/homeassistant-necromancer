#!/usr/bin/env pwsh
# Send one heartbeat to a Necromancer guard, with retries (PowerShell 7+).
#
#   $env:HEARTBEAT_URL = "http://192.168.1.8:8123/api/necromancer/heartbeat/<name>_<token>"
#   & .\backup.exe; .\ping.ps1 $LASTEXITCODE   # pass the job's exit code: 0 = success, else failure
#   .\ping.ps1                                 # no argument = success
#   .\ping.ps1 fail                            # report a failure without a code
#
# In Windows Task Scheduler: program `pwsh.exe`, arguments
#   -NoProfile -File C:\scripts\backup-and-ping.ps1
# and set HEARTBEAT_URL as a user or system environment variable, not in the arguments.
#
# Retries on no connection, 404, 429 and 5xx (Home Assistant restarting, Necromancer
# reloading) every HEARTBEAT_DELAY seconds, HEARTBEAT_ATTEMPTS times in all (default
# 11 x 60 s, about 10 minutes; a missing, invalid or < 1 value means the default). Stops
# at once on 2xx (done), on 400/403 (wrong setup, retrying cannot help) and on a
# redirect (3xx: not followed, a redirected POST would come back as a GET and get 405).
# Never prints the URL: the token in it is the secret.
#
# Exit code: 0 delivered, 1 rejected (400/403/3xx/unexpected), 2 gave up after all attempts.

param(
    [Parameter(Position = 0)]
    [AllowEmptyString()]
    [string] $Status
)

function Get-EnvNumber([string] $Name, [double] $Default, [double] $Minimum) {
    # A number from the environment; missing, invalid or below $Minimum = $Default.
    $value = 0.0
    $raw = [Environment]::GetEnvironmentVariable($Name)
    if ([double]::TryParse($raw, [Globalization.NumberStyles]::Float,
            [Globalization.CultureInfo]::InvariantCulture, [ref] $value) -and
        -not [double]::IsInfinity($value) -and $value -ge $Minimum) {
        return $value
    }
    return $Default
}

$url = $env:HEARTBEAT_URL
$attempts = [int] [Math]::Truncate((Get-EnvNumber 'HEARTBEAT_ATTEMPTS' 11 1))
$delay = Get-EnvNumber 'HEARTBEAT_DELAY' 60 0

if (-not $url) {
    [Console]::Error.WriteLine("heartbeat: HEARTBEAT_URL is not set")
    exit 1
}

if ($PSBoundParameters.ContainsKey('Status')) {
    # Plain values only: Home Assistant answers 400 to odd characters in a query.
    # Anything else still counts as a failure, so send it as "fail".
    if ($Status -notmatch '^[A-Za-z0-9_-]*$') { $Status = 'fail' }
    $sep = if ($url.Contains('?')) { '&' } else { '?' }
    $url = "$url${sep}status=$Status"
}

function Send-Post([string] $Target) {
    # POST without a body; the HTTP status, 0 when there was no connection.
    # -MaximumRedirection 0: a redirect is not followed but reported (see above).
    try {
        $response = Invoke-WebRequest -Uri $Target -Method Post -TimeoutSec 10 `
            -MaximumRedirection 0 -SkipHttpErrorCheck -ErrorAction Stop
        return [int] $response.StatusCode
    }
    catch {
        # Some PowerShell versions throw on a 3xx even with -SkipHttpErrorCheck;
        # the exception still carries the answer's status.
        if ($_.Exception.Response) { return [int] $_.Exception.Response.StatusCode }
        return 0
    }
}

$code = 0
for ($attempt = 1; $attempt -le $attempts; $attempt++) {
    $code = Send-Post $url
    if ($code -ge 200 -and $code -lt 300) { exit 0 }
    if ($code -ge 300 -and $code -lt 400) {
        [Console]::Error.WriteLine("heartbeat: HTTP $code - the URL redirects (e.g. a proxy sends http to https). Put the final URL in HEARTBEAT_URL. Not retrying.")
        exit 1
    }
    if ($code -eq 400) {
        [Console]::Error.WriteLine("heartbeat: HTTP 400 - Home Assistant refused the request (odd characters in the status, or a proxy sends X-Forwarded-For that Home Assistant is not set up for). Not retrying.")
        exit 1
    }
    if ($code -eq 403) {
        [Console]::Error.WriteLine("heartbeat: HTTP 403 - this host does not count as a local network (guard has 'Local network only'). Use Home Assistant's IPv4 address. Not retrying.")
        exit 1
    }
    if ($code -ne 0 -and $code -ne 404 -and $code -ne 429 -and $code -lt 500) {
        [Console]::Error.WriteLine("heartbeat: unexpected HTTP $code. Not retrying.")
        exit 1
    }
    if ($attempt -lt $attempts) { Start-Sleep -Seconds $delay }
}

$why = switch ($code) {
    0 { 'no connection to Home Assistant' }
    404 { 'unknown token (wrong or regenerated URL) or Necromancer not loaded' }
    default { "HTTP $code" }
}
[Console]::Error.WriteLine("heartbeat: gave up after $attempts attempts - $why.")
exit 2
