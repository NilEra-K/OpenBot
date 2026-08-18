# Clean-room 声明与致谢

## 声明

OpenBot 是独立实现，不包含 OpenGrokBot、Grok Bot 或任何第三方项目的源代码。
架构层面（排他调度、A2A / 群聊协议语义、幂等账本、事件网关等**思想**）的借鉴不受版权保护；
全部实现由 OpenBot 自研，以 Apache-2.0 授权——与参考库的 GPL-3.0 无许可纠缠。

2026-08-18：参考库 open-grokbot-main 已从工作区整体移除，物理上不存在可拷贝的代码。

## 三条纪律

1. 参考资料只读不拷——任何外部仓库永远不进 OpenBot 的 import 图
2. 命名与文件结构按 OpenBot 自己的语义——不镜像外部项目的模块名
3. 本文件常驻致谢与边界声明

## 致谢

- **OpenGrokBot**（GPL-3.0，对 Grok Bot 类桌面 agent 平台架构的 clean-room 还原工程）——
  其公开文档为 OpenBot 的分层与协议设计提供了架构研究参照
- **Grok Bot 及同类产品**——多 agent 社交控制台的产品形态源头

相关名称与商标归各自所有者；OpenBot 不主张任何从属或合作关系。
