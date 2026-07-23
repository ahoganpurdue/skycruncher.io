@echo off
REM SkyCruncher telemetry collector — double-click to run in a console window.
REM Close the window (or Ctrl+C) to stop collecting. Claude Code only emits
REM telemetry if it was STARTED while CLAUDE_CODE_ENABLE_TELEMETRY env is set —
REM so: start this first, then (re)start Claude Code.
cd /d "%~dp0..\.."
if not exist "test_results\otel" mkdir "test_results\otel"
"%~dp0bin\otelcol-contrib.exe" --config "%~dp0otel-collector-config.yaml"
pause
