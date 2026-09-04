# OpenBot GUI 容器模板（2026-09-03 用户裁定 A2：xfce 全桌面——v0.1.6 openbox 轻栈升级）
# 目标：VMWare 式可接管桌面——Xvfb 虚拟显示 + xfce4 完整桌面（面板/桌面图标/应用菜单/窗口管理）
# + xdotool（输入注入）/ scrot（截图）工具对。agent 与用户共用同一条 xdotool/scrot 通路（CLI 即接口）。
#
# 构建（podman 为例；docker 同）：
#   podman build -t openbot-gui:24.04 -f Dockerfile .
# 运行不是手动做的——desktop 装配把该镜像作为 Box 创建：
#   OPENBOT_SANDBOX=podman OPENBOT_PODMAN_IMAGE=openbot-gui:24.04 OPENBOT_COMPUTER=1 OPENBOT_GUI_DISPLAY=:0

FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive \
    DISPLAY=:0 \
    SCREEN_W=1920 \
    SCREEN_H=1080

# 国内源加速（machine 内直连官方源慢；24.04 为 deb822 格式 ubuntu.sources）。
# 镜像选型实测（2026-09-03，machine 内 DNS 有污染）：tuna 1.55MB/s ✓ / 华为云 1.40MB/s ✓ /
# aliyun 被污染到假 IP 111KB/s ✗ / 腾讯云假 IP 0 ✗——锁定 tuna
RUN sed -i 's|archive.ubuntu.com|mirrors.tuna.tsinghua.edu.cn|g; s|security.ubuntu.com|mirrors.tuna.tsinghua.edu.cn|g' /etc/apt/sources.list.d/ubuntu.sources

# 桌面栈：Xvfb 虚拟显示 + xfce4 元包（会话+面板+thunar 文件管理+窗口管理）+ 终端/编辑器
# + 工具对 + 中文字体（坑记档：首版清单漏 xvfb——容器能起但入口报 Xvfb: not found，
# scrot 连不上 :0，排查靠 podman logs 看入口 stderr）
# ffmpeg（二期 30fps 实况流）：x11grab 采集 + mjpeg 管道输出，帧经 backend.openPipe 原始字节
# 直出（PTY 文本链路会毁 jpeg）；包体 ~100MB 如实记档（plan-computer-use 二期风险项）
RUN apt-get update && apt-get install -y --no-install-recommends \
      xvfb \
      xfce4 xfce4-terminal mousepad \
      dbus-x11 x11-utils \
      xdotool scrot imagemagick \
      ffmpeg \
      fonts-noto-cjk \
      wget ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# firefox 走 Mozilla 官方 apt 仓：24.04 的 apt firefox 是 snap 空壳、容器内 snap 不可用（坑记档）
RUN install -d -m 0755 /etc/apt/keyrings \
    && wget -q -O /etc/apt/keyrings/packages.mozilla.org.asc https://packages.mozilla.org/apt/repo-signing-key.gpg \
    && echo "deb [signed-by=/etc/apt/keyrings/packages.mozilla.org.asc] https://packages.mozilla.org/apt mozilla main" > /etc/apt/sources.list.d/mozilla.list \
    && printf 'Package: *\nPin: origin packages.mozilla.org\nPin-Priority: 1000\n' > /etc/apt/preferences.d/mozilla \
    && apt-get update && apt-get install -y --no-install-recommends firefox \
    && rm -rf /var/lib/apt/lists/*

# 常驻入口：Xvfb 起虚拟显示 → dbus 会话包裹 xfce4 桌面 → sleep 保持容器存活
COPY start.sh /usr/local/bin/openbot-gui-start
RUN chmod +x /usr/local/bin/openbot-gui-start

ENTRYPOINT ["/usr/local/bin/openbot-gui-start"]
