#!/bin/sh
# OpenBot GUI 容器常驻入口（裁定 A2：xfce 全桌面）：Xvfb 虚拟显示 → dbus 会话 → xfce4 桌面
# → sleep 挂起保持容器。DISPLAY=:0 对全部子进程可见（exec 的 xdotool/scrot 依赖它——
# computer 工具与用户注入共用这条通路）。
set -e

Xvfb :0 -screen 0 "${SCREEN_W:-1920}x${SCREEN_H:-1080}x24" -nolisten tcp &
sleep 2  # 等 X 就绪（xfce 连不上会退；1080p 下 2s 稳）
# dbus-run-session：xfce4 面板/会话管理依赖会话总线（容器内无 systemd——dbus-x11 提供）
dbus-run-session -- startxfce4 &
sleep infinity
