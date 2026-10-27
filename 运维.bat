@echo off
chcp 65001 >nul
title Stronghold Ops
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0deploy\ops-menu.ps1"
if errorlevel 1 pause
