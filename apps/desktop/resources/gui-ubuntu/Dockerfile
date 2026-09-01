# OpenBot GUI 容器模板（plan-computer-use 裁定 A 轻栈）
# 目标：给 computer-use 工具族一张可操作的操作面——xvfb 虚拟显示 + openbox 轻窗口管理
# （不装完整桌面：一期目标是「操作 GUI 应用」不是「仿真桌面」）+ xdotool（输入注入）/
# scrot（截图）工具对。agent 与用户共用同一条 xdotool/scrot 通路（CLI 即接口）。
#
# 构建（podman 为例；docker 同）：
#   podman build -t openbot-gui:24.04 -f Dockerfile .
# 运行不是手动做的——desktop 装配把该镜像作为 Box 创建（OPENBOT_GUI_IMAGE 覆盖镜像名）。

FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive \
    DISPLAY=:0 \
    SCREEN_W=1280 \
    SCREEN_H=800

# 最小 GUI 集：显示栈（xvfb/openbox）+ 工具（xdotool/scrot/imagemagick 截图缩放）+
# 常用应用（firefox 浏览器 / pcmanfm 文件管理器 / xterm 终端）+ 中文字体（截图可读）
RUN apt-get update && apt-get install -y --no-install-recommends \
      xvfb openbox xdotool scrot imagemagick \
      firefox pcmanfm xterm \
      fonts-noto-cjk \
      x11-utils \
    && rm -rf /var/lib/apt/lists/*

# 常驻入口：Xvfb 起虚拟显示 → openbox 接管窗口管理 → 尾随 sleep 保持容器存活。
# DISPLAY 环境对 exec 会话可见（computer 工具的 xdotool/scrot 依赖它）。
COPY start.sh /usr/local/bin/openbot-gui-start
RUN chmod +x /usr/local/bin/openbot-gui-start

ENTRYPOINT ["/usr/local/bin/openbot-gui-start"]
