@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo ============================================
echo   ShootLab 投篮动作分析 - 本地预览
echo ============================================
echo.
echo 页面用了 ES module 加载浏览器端姿态模型，
echo 必须通过 http 打开，双击 index.html 是不行的。
echo.

start "" http://127.0.0.1:8931/index.html
python tools\serve.py 8931 prototype

echo.
echo 服务已退出。如果提示端口被占用，改端口：
echo   python tools\serve.py 8932 prototype
pause
