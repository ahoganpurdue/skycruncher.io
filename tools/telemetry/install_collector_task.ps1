# One-time (optional): register a per-user logon task so the telemetry
# collector starts automatically at every logon. No admin needed.
#   powershell -ExecutionPolicy Bypass -File tools/telemetry/install_collector_task.ps1
# Remove later with:
#   schtasks /Delete /TN SkyCruncherOtelCollector /F
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$exe = Join-Path $here 'bin\otelcol-contrib.exe'
$cfg = Join-Path $here 'otel-collector-config.yaml'
$repo = Resolve-Path (Join-Path $here '..\..')
# Run the exe directly (not the .cmd) so no console window lingers; CWD must be
# the repo root for the relative exporter paths in the config.
$action = "powershell -WindowStyle Hidden -Command `"Set-Location '$repo'; & '$exe' --config '$cfg'`""
schtasks /Create /TN "SkyCruncherOtelCollector" /TR $action /SC ONLOGON /RL LIMITED /F
Write-Host "Registered ONLOGON task 'SkyCruncherOtelCollector'."
Write-Host "It starts at next logon — for right now, run start_collector.cmd (or let the current session's collector keep running)."
