#!/bin/sh
# OpenBot GUI 工具集共用预置脚本（plan-image-firstclass P8-1 B1）：镜像内工具集的单一真相源——
# 容器模板（gui-ubuntu Dockerfile）与 SSH/VM 载体（provision）共用同一份包清单与桌面会话启动。
#
# 用法：
#   sh provision-gui.sh packages      # 只装 GUI 工具集（容器构建 / 已有桌面的 VM 补工具）
#   sh provision-gui.sh start-desktop # 启动虚拟桌面会话（Xvfb :0 + dbus + xfce4）——容器 ENTRYPOINT
#   sh provision-gui.sh               # VM 全流程 = packages + 安装 start-desktop + 启动 + 打印接入提示
#
# 环境：
#   MIRROR=tuna   换清华源（容器构建默认网络慢；VM 按需——已配国内源的机器不必设）
#   SCREEN_W/H    虚拟桌面分辨率（缺省 1920x1080）
#
# 桌面栈清单与 gui-ubuntu 容器模板同源：Xvfb 虚拟显示 + xfce4 完整桌面 + xdotool/scrot
# 工具对（agent 与用户共用同一条注入/截图通路）+ ffmpeg（实况流 x11grab 采集，包体 ~100MB 如实）。
# 坑记档：清单漏 xvfb 会「容器能起但入口报 Xvfb: not found」；24.04 的 apt firefox 是 snap
# 空壳（firefox 走 Mozilla 官方仓，属容器模板 Dockerfile 专属块，VM 上直接 apt install firefox）。
set -u

PKG_LIST="xvfb xfce4 xfce4-terminal mousepad dbus-x11 x11-utils xdotool scrot imagemagick ffmpeg fonts-noto-cjk wget ca-certificates"
SELF_PATH="${0:-provision-gui.sh}"

maybe_swap_mirror() {
  if [ "${MIRROR:-}" != "tuna" ]; then return 0; fi
  # 24.04 为 deb822 格式 ubuntu.sources；旧版仍是 sources.list——两处都在场时都换（幂等）
  for f in /etc/apt/sources.list.d/ubuntu.sources /etc/apt/sources.list; do
    if [ -f "$f" ]; then
      sed -i 's|archive.ubuntu.com|mirrors.tuna.tsinghua.edu.cn|g; s|security.ubuntu.com|mirrors.tuna.tsinghua.edu.cn|g' "$f"
    fi
  done
}

install_packages() {
  if [ "$(id -u)" != "0" ] && ! command -v sudo >/dev/null 2>&1; then
    echo "[provision] 需要 root 权限安装软件包（sudo 不在场）" >&2
    exit 1
  fi
  maybe_swap_mirror
  SUDO=""
  if [ "$(id -u)" != "0" ]; then SUDO="sudo"; fi
  export DEBIAN_FRONTEND=noninteractive
  $SUDO apt-get update
  # --no-install-recommends 与容器模板同款（包体最小面）
  $SUDO apt-get install -y --no-install-recommends $PKG_LIST
  $SUDO rm -rf /var/lib/apt/lists/*
  # 关键工具就绪校验（缺席只告警不回滚——apt 退出码已是第一事实，缺哪个补哪个）
  for p in Xvfb xdotool scrot ffmpeg; do
    if ! command -v "$p" >/dev/null 2>&1; then
      echo "[provision] 警告：$p 不在 PATH（安装可能未完成）" >&2
    fi
  done
  echo "[provision] GUI 工具集安装完成"
}

# 启动虚拟桌面会话（容器 ENTRYPOINT 与 VM 通用）：X lock 幂等清理（坑⑲：硬停后残留
# /tmp/.X0-lock——Xvfb 起不来、xfce 误判「X server already running」全链崩；会话环境本就该
# 每次干净，删 lock 零风险）→ Xvfb :0 → dbus-run-session 包裹 startxfce4（面板/会话管理依赖
# 会话总线）→ sleep 挂起保持会话存活。
start_desktop() {
  rm -f /tmp/.X0-lock
  rm -f /tmp/.X11-unix/X0

  Xvfb :0 -screen 0 "${SCREEN_W:-1920}x${SCREEN_H:-1080}x24" -nolisten tcp &
  sleep 2 # 等 X 就绪（xfce 连不上会退；1080p 下 2s 稳）
  dbus-run-session -- startxfce4 &
  sleep infinity
}

vm_provision() {
  install_packages
  # start-desktop 安装为系统入口（VM 重启后的自启挂载点：systemd unit / 桌面 autostart）
  SUDO=""
  if [ "$(id -u)" != "0" ]; then SUDO="sudo"; fi
  $SUDO install -m 0755 "$SELF_PATH" /usr/local/bin/provision-gui.sh
  echo "[provision] 已安装 /usr/local/bin/provision-gui.sh（start-desktop 子命令 = 桌面会话入口）"
  echo "[provision] 后台启动桌面会话……"
  DISPLAY=:0 nohup sh /usr/local/bin/provision-gui.sh start-desktop >/tmp/openbot-desktop.log 2>&1 &
  echo "[provision] 完成。OpenBot 侧接入（env）："
  echo "  OPENBOT_SANDBOX=ssh"
  echo "  OPENBOT_SSH_HOST=<本机地址>  OPENBOT_SSH_USER=<用户>  OPENBOT_SSH_KEY=<私钥路径>"
  echo "  OPENBOT_GUI_DISPLAY=:0  OPENBOT_COMPUTER=1"
}

case "${1:-all}" in
  packages) install_packages ;;
  start-desktop) start_desktop ;;
  all) vm_provision ;;
  *) echo "用法：sh provision-gui.sh [packages|start-desktop|all]" >&2; exit 2 ;;
esac
