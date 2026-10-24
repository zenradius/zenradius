@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"

echo ========================================================
echo  ZenRadius - Update Lokal ke GitHub
echo  Repo: https://github.com/zenradius/zenradius
echo ========================================================
echo.

rem Argumen pertama menentukan jenis kenaikan versi.
rem   update.bat            -^> patch (1.15.4 -^> 1.15.5)
rem   update.bat minor      -^> 1.15.5 -^> 1.16.0
rem   update.bat major      -^> 1.16.0 -^> 2.0.0
rem   update.bat 1.20.0     -^> set versi eksplisit
set "BUMP=%~1"
if "%BUMP%"=="" set "BUMP=patch"

rem Tolak argumen yang tidak dikenal agar tidak diam-diam jadi patch.
echo %BUMP% | findstr /R /C:"^patch$" /C:"^minor$" /C:"^major$" /C:"^[0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*$" >nul
if errorlevel 1 (
  echo.
  echo [ERROR] Argumen versi tidak dikenal: "%BUMP%"
  echo         Gunakan: update.bat [patch^|minor^|major] [x.y.z] ["pesan commit"]
  pause
  exit /b 2
)

echo [1/4] Memeriksa status repository...
for /f "delims=" %%i in ('git status --porcelain') do (
  set "DIRTY=1"
)
if not defined DIRTY (
  echo.
  echo [INFO] Tidak ada perubahan yang perlu di-commit.
  echo        Versi saat ini:
  node scripts/bump-version.js --check
  echo.
  pause
  exit /b 0
)

echo.
echo [2/4] Menaikkan versi ^(%BUMP%^)...
node scripts/bump-version.js %BUMP%
if errorlevel 1 (
  echo.
  echo [ERROR] Gagal menaikkan versi. Periksa argumen: patch ^| minor ^| major ^| x.y.z
  pause
  exit /b 1
)

echo.
set "MSG=%~2"
if "%MSG%"=="" set /p MSG= Pesan commit [kosong = "chore: update %BUMP%"]: 
if "%MSG%"=="" set "MSG=chore: update %BUMP%"

echo.
echo [3/4] Commit perubahan...
git add -A
git commit -m "%MSG%"
if errorlevel 1 (
  echo.
  echo [WARN] Commit gagal atau tidak ada perubahan pada berkas yang dilacak.
  pause
  exit /b 1
)

echo.
echo [4/4] Push ke GitHub...
git push origin main
if errorlevel 1 (
  echo.
  echo [ERROR] Push gagal. Periksa koneksi atau kredensial GitHub.
  echo         Commit lokal tetap tersimpan; jalankan: git push origin main
  pause
  exit /b 1
)

echo.
echo ========================================================
echo  BERHASIL - Perubahan sudah di-push ke GitHub.
echo.
echo  Langkah berikutnya di VPS:
echo    1. Buka dashboard: Admin -^> Update Aplikasi
echo    2. Klik "Cek Update", lalu "Update Sekarang"
echo    3. Setelah selesai, klik "Restart Aplikasi" (PM2)
echo ========================================================
node scripts/bump-version.js --check
echo.
pause
