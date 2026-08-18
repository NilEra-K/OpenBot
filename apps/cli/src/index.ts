/**
 * @openbot/cli —— 无壳冒烟（P1）：mock llm + mock box 跑通 chat → A2A → box exec 全链路。
 * 壳规则（ARCHITECTURE.md §2 铁律 3）：本文件是装配点（P1 将 import coordinator 装配内核），
 * 业务面只走 transport 客户端。
 */
export async function main(): Promise<void> {
  console.log('OpenBot CLI 骨架已就绪——P1 实现全链路冒烟')
}
