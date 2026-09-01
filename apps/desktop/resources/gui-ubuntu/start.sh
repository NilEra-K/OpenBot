#!/bin/sh
# OpenBot GUI 容器常驻入口（plan-computer-use Step 1）：
# Xvfb 虚拟显示 → openbox 窗口管理 → sleep 挂起保持容器。DISPLAY=:0 对全部子进程可见
# （exec 的 xdotool/scrot 依赖同一 DISPLAY——computer 工具与用户注入共用这条通路）。
set -e

Xvfb :0 -screen 0 "${SCREEN_W:-1280}x${SCREEN_H:-800}x24" -nolisten tcp &
sleep 1  # 等 X 就绪（openbox 连不上会退——容器内无竞态，1s 实测够）
openbox-session &
sleep infinity
