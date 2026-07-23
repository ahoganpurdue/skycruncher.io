@echo off
rem Mechanical build entrypoint: guarantees cwd-based .cargo/config.toml discovery
rem (target-dir on D:, target-cpu=native). Usage: build.cmd [cargo args...]
rem Examples: build.cmd build --release | build.cmd test | build.cmd run -p solver-cli -- --help
cd /d "%~dp0"
"C:\Users\ahoga\.cargo\bin\cargo.exe" %*
