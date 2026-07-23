@echo off
rem Claude Desktop bridge launcher — starts the stdio MCP server with repo cwd guaranteed.
rem Referenced by %APPDATA%\Claude\claude_desktop_config.json (mcpServers.skycruncher).
cd /d "%~dp0..\.."
node tools\mcp\server.mjs
