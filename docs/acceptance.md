# 真机手动验收清单（作者执行——自动化不碰真系统）

> 滚动总账：各批散落提交信息里的「待作者手动」事项收口于此（v0.1.91 起维护）；验收通过即勾选并注明日期与版本。
> 原则：自动化只覆盖 mock 对称链路（`OPENBOT_E2E=1` 全链不触真系统安装/提权），真机链路必须人工过一遍。

## 容器运行时（docs/plan-v020-runtime-install.md）

- [ ] **Podman 一键实装**（v0.1.87 挂账；digest 校验链最完整）：设置页矩阵 Podman 行「一键安装」→ UAC → MSI 静默装完 → 行转已装；自选安装位置时 MSI `INSTALLDIR` 生效（装到非默认目录）
- [ ] **Docker Desktop 启动链**（v0.1.89 报障本体）：托盘退出 DD → 重进设置页（或切分节）→ DD 行显示「启动」（非一键安装）→ 点击 → 行内「启动中…」→ 就绪转「已可用」；「取消等待」后行回「启动」
- [ ] **引擎看门狗**（v0.1.90）：agent 绑 docker 跑长任务 → 外部退出 DD → ≤60s 收到「沙箱引擎已停止」toast → 重启 DD → 「已恢复」toast + 矩阵翻转
- [ ] **mac 启动链**（v0.1.90，Windows 开发机不可验）：DD 行 `open -a Docker` / colima `colima start` / Podman machine start 三条；brew 装后从 GUI 启动的应用内 PATH 回退生效
- [ ] **linux docker 启动链**（v0.1.90）：行「启动」→ launchConfirm 模态（polkit 告知）→ 授权 → `systemctl start docker` → 就绪；无 polkit agent 的桌面环境验证 sudo 指引文案
- [ ] **wsl2 组件未启用分列**（v0.1.91，需在 `wsl --install` 未启用组件的机器上验）：行显示一键安装 + 说明「WSL 组件未启用」

## 沙箱载体（docs/platforms.md）

- [ ] nspawn 载体真机链路（P6 起记档未验——machinectl 写操作需 root/polkit）
- [ ] UTM 载体真机链路（P6 起记档未验；utmctl 需 macOS GUI 登录会话）

## 插件

- [x] **首个 Python 插件实跑**（2026-10-27 v0.1.92 闭账，`openbot.hello-python`）：单测真实 python 握手 + E2E 全链（安装→运行中→Agent 调工具→审批→上行事件 toast——UTF-8 中文实证）已过；本机 anaconda python 3.14.6 上 where 解析生效（自动化即真机——此链不需另手动验）。

## 历史遗留（裁定维持，不修）

- pass 轮残留清扫边界：全员 pass 轮的遗留思考记录清扫不到（v0.1.79 已知边界——新数据源头已分流无此问题；开新会话/清空即隐去）。作者 2026-10-27 认可维持记档。
