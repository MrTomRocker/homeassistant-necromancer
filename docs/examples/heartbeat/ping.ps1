#!/usr/bin/env pwsh
# Send one heartbeat to a Necromancer guard, with retries.
# Runs in Windows PowerShell 5.1 (built into Windows 10/11) and PowerShell 7+.
#
#   $env:HEARTBEAT_URL = "http://192.168.1.8:8123/api/necromancer/heartbeat/<name>_<token>"
#   & .\backup.exe; .\ping.ps1 $LASTEXITCODE   # pass the job's exit code: 0 = success, else failure
#   .\ping.ps1                                 # no argument = success
#   .\ping.ps1 fail                            # report a failure without a code
#
# In Windows Task Scheduler: program `powershell.exe` (or `pwsh.exe`), arguments
#   -NoProfile -ExecutionPolicy Bypass -File C:\scripts\backup-and-ping.ps1
# and set HEARTBEAT_URL as a user or system environment variable, not in the arguments.
# A task starts in C:\Windows\System32, so the wrapper needs full paths:
#   & 'C:\Program Files\Backup\backup.exe'
#   & "$PSScriptRoot\ping.ps1" $LASTEXITCODE
#   exit $LASTEXITCODE
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
$attempts = [Math]::Truncate((Get-EnvNumber 'HEARTBEAT_ATTEMPTS' 11 1))
$delay = Get-EnvNumber 'HEARTBEAT_DELAY' 60 0

if (-not $url) {
    [Console]::Error.WriteLine("heartbeat: HEARTBEAT_URL is not set")
    exit 1
}

if ($PSBoundParameters.ContainsKey('Status')) {
    # Plain values only: Home Assistant answers 400 to odd characters in a query.
    # Anything else still counts as a failure, so send it as "fail".
    if ($Status -notmatch '\A[A-Za-z0-9_-]*\z') { $Status = 'fail' }
    $sep = if ($url.Contains('?')) { '&' } else { '?' }
    $url = "$url${sep}status=$Status"
}

# .NET HttpClient instead of Invoke-WebRequest: Windows PowerShell 5.1 has no
# -SkipHttpErrorCheck and throws on every non-2xx answer. HttpClient behaves the same
# in 5.1 and 7: it returns any status, and AllowAutoRedirect = $false reports a
# redirect instead of following it (see above).
Add-Type -AssemblyName System.Net.Http
if ($PSVersionTable.PSEdition -ne 'Core') {
    # Windows PowerShell 5.1 may start with old TLS versions only (Ssl3/Tls); add TLS 1.2
    # for an https URL (a reverse proxy). Leave SystemDefault alone: there Windows already
    # picks TLS 1.2/1.3. Plain http on the LAN does not need any of this.
    $sp = [Net.ServicePointManager]::SecurityProtocol
    if ($sp -ne [Net.SecurityProtocolType]::SystemDefault) {
        [Net.ServicePointManager]::SecurityProtocol = $sp -bor [Net.SecurityProtocolType]::Tls12
    }
}
$handler = New-Object System.Net.Http.HttpClientHandler
$handler.AllowAutoRedirect = $false
$client = New-Object System.Net.Http.HttpClient($handler)
$client.Timeout = [TimeSpan]::FromSeconds(10)
$client.DefaultRequestHeaders.UserAgent.ParseAdd('necromancer-heartbeat')

function Send-Post([string] $Target) {
    # POST with an empty body; the HTTP status, 0 when there was no connection.
    try {
        $body = [System.Net.Http.StringContent]::new('')
        $response = $client.PostAsync([Uri] $Target, $body).GetAwaiter().GetResult()
        $code = [int] $response.StatusCode
        $response.Dispose()
        return $code
    }
    catch {
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
    if ($attempt -lt $attempts) {
        Start-Sleep -Milliseconds ([int] [Math]::Min($delay * 1000, [int]::MaxValue))
    }
}

$why = switch ($code) {
    0 { 'no connection to Home Assistant' }
    404 { 'unknown token (wrong or regenerated URL) or Necromancer not loaded' }
    default { "HTTP $code" }
}
[Console]::Error.WriteLine("heartbeat: gave up after $attempts attempts - $why.")
exit 2
