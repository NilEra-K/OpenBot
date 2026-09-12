# OpenBot GUI 容器模板（2026-09-03 用户裁定 A2：xfce 全桌面——v0.1.6 openbox 轻栈升级）
# 目标：VMWare 式可接管桌面——Xvfb 虚拟显示 + xfce4 完整桌面（面板/桌面图标/应用菜单/窗口管理）
# + xdotool（输入注入）/ scrot（截图）工具对。agent 与用户共用同一条 xdotool/scrot 通路（CLI 即接口）。
#
# 包清单与桌面会话启动共用 tools/provision-gui.sh（plan-image-firstclass P8-1 B1：
# 镜像内工具集单一真相源——SSH/VM 载体与容器同源）。
#
# 构建（构建上下文是 tools/ 目录——provision-gui.sh 经 COPY 进镜像；仓库根执行，podman/docker 同）：
#   podman build -t openbot-gui:24.04 -f apps/desktop/resources/gui-ubuntu/Dockerfile tools
# 运行不是手动做的——desktop 装配把该镜像作为 Box 创建：
#   OPENBOT_SANDBOX=podman OPENBOT_PODMAN_IMAGE=openbot-gui:24.04 OPENBOT_COMPUTER=1 OPENBOT_GUI_DISPLAY=:0
# SSH/VM 载体不用本镜像——在远端机器跑 tools/provision-gui.sh（见脚本头注）。

FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive \
    DISPLAY=:0 \
    SCREEN_W=1920 \
    SCREEN_H=1080

# GUI 工具集：共用预置脚本（MIRROR=tuna——machine 内直连官方源慢且 DNS 有污染，tuna 实测
# 1.55MB/s；aliyun/腾讯云被污染到假 IP——锁定 tuna；坑记档：首版清单漏 xvfb——容器能起但
# 入口报 Xvfb: not found，scrot 连不上 :0，排查靠容器 logs 看入口 stderr。
# ffmpeg 二期起在场：x11grab 采集 + mjpeg/h264 管道输出，帧经 backend.openPipe 原始字节直出
# （PTY 文本链路会毁 jpeg）；包体 ~100MB 如实记档）
COPY provision-gui.sh /usr/local/bin/provision-gui.sh
RUN MIRROR=tuna sh /usr/local/bin/provision-gui.sh packages

# firefox 走 Mozilla 官方 apt 仓：24.04 的 apt firefox 是 snap 空壳、容器内 snap 不可用（坑记档；
# VM 载体 snap 可用，直接 apt install firefox 即可——此块为容器专属）
RUN install -d -m 0755 /etc/apt/keyrings \
    && wget -q -O /etc/apt/keyrings/packages.mozilla.org.asc https://packages.mozilla.org/apt/repo-signing-key.gpg \
    && echo "deb [signed-by=/etc/apt/keyrings/packages.mozilla.org.asc] https://packages.mozilla.org/apt mozilla main" > /etc/apt/sources.list.d/mozilla.list \
    && printf 'Package: *\nPin: origin packages.mozilla.org\nPin-Priority: 1000\n' > /etc/apt/preferences.d/mozilla \
    && apt-get update && apt-get install -y --no-install-recommends firefox \
    && rm -rf /var/lib/apt/lists/*

# 常驻入口：共用脚本的 start-desktop 子命令（Xvfb :0 → dbus 会话 → xfce4 桌面 → sleep 保持
# 容器存活；DISPLAY=:0 对 exec 会话由本镜像 ENV 提供——computer 工具与用户注入共用这条通路）
ENTRYPOINT ["sh", "/usr/local/bin/provision-gui.sh", "start-desktop"]
