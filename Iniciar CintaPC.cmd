@echo off
setlocal
title CintaPC
pushd "%~dp0"
if errorlevel 1 (
  echo No se puede abrir la carpeta de CintaPC.
  pause
  exit /b 1
)

where node.exe >nul 2>nul
if errorlevel 1 (
  echo No se encuentra Node.js en este equipo.
  echo Instala Node.js 22.12 o posterior desde https://nodejs.org/ y vuelve a abrir este archivo.
  pause
  popd
  exit /b 1
)

node.exe "%~dp0scripts\iniciar.mjs"
set "cinta_result=%errorlevel%"
if not "%cinta_result%"=="0" (
  echo.
  echo No se ha podido abrir CintaPC. Revisa el error indicado arriba.
  pause
)
popd
exit /b %cinta_result%
