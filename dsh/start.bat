@echo off
chcp 65001 >nul
cd /d "%~dp0"
if "%PORT%"=="" set PORT=3210
if "%HOST%"=="" set HOST=127.0.0.1
echo [dongfang-review] 启动中... 打开 http://%HOST%:%PORT%
echo [dongfang-review] 规则审阅离线可用；模型审阅需先设置 ARK_API_KEY
node server.mjs
if errorlevel 1 pause
