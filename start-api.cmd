@echo off
echo ===================================================
echo Starting College Library Student API Server...
echo ===================================================
cd /d "%~dp0"

if not exist "node_modules\" (
    echo [Setup] First time run detected: Installing required npm packages...
    call npm install
)

echo.
echo [Server] Starting Student API on port 5000...
node server.js
pause
