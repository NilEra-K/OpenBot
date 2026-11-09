# 真机手动验收清单（作者执行——自动化不碰真系统）

> 滚动总账：各批散落提交信息里的「待作者手动」事项收口于此（v0.1.91 起维护）；验收通过即勾选并注明日期与版本。
> 原则：自动化只覆盖 mock 对称链路（`OPENBOT_E2E=1` 全链不触真系统安装/提权），真机链路必须人工过一遍。

## 容器运行时（docs/plan-v020-runtime-install.md）

- [x] **Podman 一键实装**（v0.1.87 挂账；2026-11-09 v0.2.0 验收闭账，v0.1.129 装链 + v0.1.130 修复）：卸旧 5.8.3 后设置页「一键安装」→ UAC → **v6.1.4 MSI 静默装成**（digest 校验链实证——v0.1.87 修的资产链真机通过）；默认位安装**免重启**行转「已安装」+「需初始化」chip（v0.1.89 分层语义逐点吻合）。**记档**：①INSTALLDIR 自选位真机未验（本轮默认位，另验需再卸装轮，挂账后置）；②附带发现 done 模态「立即启动」未分流 machine-missing → 上游 vmnotfound 原文直出——**v0.1.130 已修**（模态分流 + launcher 稳定码 `RUNTIME_LAUNCH_MACHINE_MISSING`，E2E mock-mm 全链断言，真机复验以 E2E 为准记档跳过）
- [x] **Docker Desktop 启动链**（v0.1.89 报障本体；2026-11-09 v0.2.0 验收闭账）：引擎停态行显「启动」（非一键安装）→ 点击行内「启动中…」→ 就绪转「已可用」→ 再启动后即时「取消等待」回「启动」——全链过
- [x] **引擎看门狗**（v0.1.90；2026-11-09 v0.2.0 验收闭账）：`OPENBOT_SANDBOX=docker` 装配（看门狗挂 chosen 后端，Box 执行面因预检镜像被墙降级 mock 不影响）→ 退出 DD ≤60s「沙箱引擎已停止」toast → 重启 DD「已恢复」toast；顺带实证手动「⟳ 刷新状态」即时翻转矩阵（v0.1.97 链路）。**记档**：验收单「agent 绑 docker 跑长任务」场景再现省略——看门狗装配与 agent 任务无关（选定后端即装配），以装配 + toast 链为实质验收
- [ ] **mac 启动链**（v0.1.90，Windows 开发机不可验）：DD 行 `open -a Docker` / colima `colima start` / Podman machine start 三条；brew 装后从 GUI 启动的应用内 PATH 回退生效
- [ ] **linux docker 启动链**（v0.1.90）：行「启动」→ launchConfirm 模态（polkit 告知）→ 授权 → `systemctl start docker` → 就绪；无 polkit agent 的桌面环境验证 sudo 指引文案
- [ ] **wsl2 组件未启用分列**（v0.1.91，需在 `wsl --install` 未启用组件的机器上验）：行显示一键安装 + 说明「WSL 组件未启用」

## 沙箱载体（docs/platforms.md）

- [ ] nspawn 载体真机链路（P6 起记档未验——machinectl 写操作需 root/polkit）
- [ ] UTM 载体真机链路（P6 起记档未验；utmctl 需 macOS GUI 登录会话）

## 插件

- [x] **首个 Python 插件实跑**（2026-10-27 v0.1.92 闭账，`openbot.hello-python`）：单测真实 python 握手 + E2E 全链（安装→运行中→Agent 调工具→审批→上行事件 toast——UTF-8 中文实证）已过；本机 anaconda python 3.14.6 上 where 解析生效（自动化即真机——此链不需另手动验）。

## 真机发现记档（随验收新增）

- **backend-probe 镜像拉取国内网络必败**（2026-11-09 A4 前置实证）：docker 后端装配预检拉 `backend-probe:latest` 走 registry-1.docker.io——被墙环境下 exit 125 → 按语义降级 mock，**docker 后端在此类网络恒不可用**。backlog 候选：预检镜像本地化（随包/预导入）或经镜像源解析（与 platforms.md 国内网络适配同议题）
- **自选安装位置 + 运行中应用旧 PATH 边界**（2026-11-09 代码层预判，未真机实证）：CLI 回退表只含官方默认位，自选 INSTALLDIR 装完行状态需重启应用才识别（默认位免重启已实证）——与 INSTALLDIR 自选位验收挂账同批补验

## 历史遗留（裁定维持，不修）

- pass 轮残留清扫边界：全员 pass 轮的遗留思考记录清扫不到（v0.1.79 已知边界——新数据源头已分流无此问题；开新会话/清空即隐去）。作者 2026-10-27 认可维持记档。
