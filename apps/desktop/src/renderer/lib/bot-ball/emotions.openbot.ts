/**
 * OpenBot 表情资产层（v0.1.65 内化）：OpenBot agent 状态 → BotBall 引擎表情的映射，
 * 以及未来自研表情注册的唯一维护位。
 *
 * 维护纪律：引擎（bot-ball.js / index.ts）结构性代码永不修改；我们的表情语义全部收在
 * 本文件——加状态/换表情/注册自研表情只动这里，组件与调用点零改动（新状态需在调用点
 * 传入，见 BotBallAvatar 的 state prop）。
 *
 * 引擎表情 id 语义速查（bot-ball.js 内 EMOTION_SEED；三组：life 00-07 / emotion 10-21 / agent 30-41）：
 *   agent 组——30 思考中 / 31 接收任务 / 32 处理中忙碌 / 33 任务完成 / 34 出错 /
 *   35 等待输入 / 36 联网加载 / 37 复述回忆 / 38 拒绝受限 / 39 输出回复 / 40 检索资料 / 41 停止终止
 */

/** OpenBot 侧 agent 表情状态（领域枚举——扩展只加这里与映射表） */
export type BallState = 'idle' | 'working'

/** 状态 → 引擎表情 id；缺省回退待机（读取端容错，不抛） */
const STATE_EMOTION: Record<BallState, string> = {
  idle: '02', // 待机放空：左看右看 + 呼吸 + 偶尔眨眼
  working: '32', // 处理中忙碌：眯眼快节奏
}

export const emotionOf = (state: BallState): string => STATE_EMOTION[state] ?? '02'

/** 新建 agent 向导大球轮播清单（v0.1.66「自由变换表情」）：好奇 → 开心 → 专注 →
 *  思考中 → 处理中忙碌 → 任务完成 → 检索资料 → 惊讶——展示 agent 全周期神态 */
export const WIZARD_TOUR: readonly string[] = ['03', '10', '16', '30', '32', '33', '40', '13']
