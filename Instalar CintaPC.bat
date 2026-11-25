@echo off
setlocal EnableExtensions
title Instalar CintaPC
rem ------------------------------------------------------------------------
rem  Instalador de CintaPC. Solo hay que ejecutarlo UNA vez.
rem  Instala todo en %LOCALAPPDATA%\CintaPC (sin permisos de administrador)
rem  y crea el acceso directo "CintaPC" en el escritorio. A partir de ahi,
rem  la app se actualiza sola cada vez que se abre.
rem ------------------------------------------------------------------------
set "REPO=lukasauri/cinta-correr"
set "NODEVER=v22.23.4"
set "NODESHA=cbc74b5e0982c9dbb41525fd8fb5dcd32fbee237863f7829072f4639a1ce5f20"
if not defined CINTAPC_BASE set "CINTAPC_BASE=%LOCALAPPDATA%\CintaPC"
set "BASE=%CINTAPC_BASE%"
set "ZIP=%BASE%\node.zip"

echo.
echo   Instalando CintaPC
echo   ------------------
echo   No cierres esta ventana. La primera vez tarda unos minutos.
echo.
where curl.exe >nul 2>nul || goto :old_windows
where tar.exe >nul 2>nul || goto :old_windows
if not exist "%BASE%" mkdir "%BASE%" || goto :error

if exist "%BASE%\node\node.exe" goto :have_node
echo   - Descargando Node.js...
curl.exe -fsSL --retry 3 -o "%ZIP%" "https://nodejs.org/dist/%NODEVER%/node-%NODEVER%-win-x64.zip" || goto :error
set "HASH="
for /f "skip=1 delims=" %%h in ('certutil -hashfile "%ZIP%" SHA256') do if not defined HASH set "HASH=%%h"
set "HASH=%HASH: =%"
if /i not "%HASH%"=="%NODESHA%" (
  echo   La descarga de Node.js esta danada. Vuelve a ejecutar el instalador.
  del "%ZIP%" >nul 2>nul
  goto :error
)
if exist "%BASE%\node-%NODEVER%-win-x64" rmdir /s /q "%BASE%\node-%NODEVER%-win-x64"
"%SystemRoot%\System32\tar.exe" -xf "%ZIP%" -C "%BASE%" || goto :error
move "%BASE%\node-%NODEVER%-win-x64" "%BASE%\node" >nul || goto :error
del "%ZIP%" >nul 2>nul
:have_node

echo   - Descargando CintaPC...
curl.exe -fsSL --retry 3 -o "%BASE%\lanzar.mjs" "https://raw.githubusercontent.com/%REPO%/main/scripts/lanzar.mjs" || goto :error
"%BASE%\node\node.exe" "%BASE%\lanzar.mjs" --instalar || goto :error

echo.
echo   Listo. A partir de ahora abre CintaPC con el icono del escritorio.
echo   Esta ventana se cerrara sola.
timeout /t 8 >nul
exit /b 0

:old_windows
echo   Este instalador necesita Windows 10 (version de 2018) o posterior.
goto :error

:error
echo.
echo   Algo ha fallado durante la instalacion. Comprueba la conexion a internet
echo   y vuelve a ejecutar este archivo.
pause
exit /b 1
