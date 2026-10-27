@echo off
chcp 65001 >nul 2>&1
title Stronghold Protocol - Start Server
cd /d "%~dp0"

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0deploy\start-server.ps1"
