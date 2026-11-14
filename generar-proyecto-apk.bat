@echo off
title Generar Proyecto Android APK - Punto de Venta Carlos
cd /d "%~dp0"
echo ========================================================
echo 1. Instalando Capacitor para empaquetar APK Android...
echo ========================================================
call npm.cmd install
if not exist "android" (
  echo ========================================================
  echo 2. Creando carpeta nativa Android...
  echo ========================================================
  call npx.cmd cap add android
)
echo ========================================================
echo 3. Sincronizando archivos web (www) con Android...
echo ========================================================
call npx.cmd cap sync android
echo.
echo Proyecto Android listo en la carpeta "android/".
echo Para abrir en Android Studio y generar el archivo .apk ejecuta:
echo   npx.cmd cap open android
pause
