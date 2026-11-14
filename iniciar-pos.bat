@echo off
title Punto de Venta Carlos - Servidor Web (Neon DB)
cd /d "%~dp0"
echo Iniciando Punto de Venta conectado a Neon PostgreSQL...
start http://localhost:3000
node server.js
pause
