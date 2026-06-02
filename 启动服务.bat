@echo off
cd /d "C:\Users\X1 Yoga\WorkBuddy\2026-05-17-task-6"
echo =================================
echo   美团眼科运营AI助手
echo =================================
echo 启动中...
start "" http://localhost:3000/meituan-agent.html
node server.js
pause
