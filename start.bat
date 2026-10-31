@echo off
setlocal
cd /d "%~dp0"

echo ===================================================
echo             nodez2ai - Windows Starter
echo ===================================================

where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [ERROR] Node.js is not installed or not in PATH!
    echo Please install Node.js ^(version 18 or newer^) from https://nodejs.org
    pause
    exit /b 1
)

if not exist ".env" (
    echo [.env] Creating .env from .env.example...
    copy .env.example .env >nul
)

if not exist "node_modules\" (
    echo [INSTALL] Installing dependencies...
    call npm install
    if %errorlevel% neq 0 (
        echo [ERROR] npm install failed.
        pause
        exit /b %errorlevel%
    )
)

echo [START] Starting nodez2ai...
call npm run dev

pause
