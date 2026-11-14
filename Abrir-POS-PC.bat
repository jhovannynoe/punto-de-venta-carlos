@echo off
title Punto de Venta Carlos (App PC)
REM Abre el Punto de Venta en modo ventana de aplicacion nativa de Windows (sin barras de navegador)
where chrome >nul 2>nul
if %ERRORLEVEL% EQU 0 (
  start "" chrome --app=https://punto-de-venta-carlos.onrender.com
  exit
)
if exist "C:\Program Files\Google\Chrome\Application\chrome.exe" (
  start "" "C:\Program Files\Google\Chrome\Application\chrome.exe" --app=https://punto-de-venta-carlos.onrender.com
  exit
)
if exist "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" (
  start "" "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" --app=https://punto-de-venta-carlos.onrender.com
  exit
)
start https://punto-de-venta-carlos.onrender.com
