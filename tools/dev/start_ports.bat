@echo off
rem SkyCruncher persistent dev servers.
rem 3005 = owner's desktop application (protected manual instance)
rem 5603 = overnight rig
rem To make persistent across logons: press Win+R, type  shell:startup  , Enter,
rem then copy THIS FILE into the folder that opens. Windows runs it at every logon.
rem (strictPort means an already-running instance wins; relaunch is a harmless no-op.)
start "SkyCruncher Desktop 3005" /min /d "%~dp0..\.." cmd /c "npx vite --port 3005 --strictPort --host 127.0.0.1"
start "SkyCruncher Overnight 5603" /min /d "%~dp0..\.." cmd /c "npx vite --port 5603 --strictPort --host 127.0.0.1"
