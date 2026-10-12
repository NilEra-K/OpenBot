/**
 * Type-safe entry for the zero-dependency BotBall browser engine.
 *
 * The readable runtime and geometry live in bot-ball.js. Importing this file
 * loads that same runtime, then exposes its public contract to TypeScript.
 *
 * 来源与许可声明见 README 致谢节。
 */
import './bot-ball.js';

export type BuiltInEmotionId =
  | '00' | '01' | '02' | '03' | '04' | '05' | '06' | '07'
  | '10' | '11' | '12' | '13' | '14' | '15' | '16' | '17'
  | '18' | '19' | '20' | '21'
  | '30' | '31' | '32' | '33' | '34' | '35' | '36' | '37'
  | '38' | '39' | '40' | '41';

export type EmotionId = BuiltInEmotionId | (string & {});
export type EmotionGroupKey = 'life' | 'emotion' | 'agent' | 'custom';
export type BodyShape = 'blob' | 'wedge' | 'gem';

export interface EmotionGroup {
  key: EmotionGroupKey;
  name: string;
  en?: string;
}

export interface EmotionSummary {
  id: EmotionId;
  group: EmotionGroupKey;
  name: string;
  desc: string;
  color: `#${string}`;
}

export interface IdleOptions {
  standbyAfter?: number;
  sleepAfter?: number;
  standbyId?: EmotionId;
  sleepId?: EmotionId;
}

export interface BotBallCreateOptions {
  emotion?: EmotionId;
  color?: `#${string}`;
  eyeColor?: `#${string}`;
  eyeScale?: number;
  shape?: BodyShape;
  label?: string;
  fallbackId?: EmotionId;
  autostart?: boolean;
  lite?: boolean;
  idle?: boolean | IdleOptions;
}

export interface AgentEmotionMessage {
  emotionId: EmotionId;
  tips?: string;
}

export type BotBallEvent = 'change' | 'tips' | 'error';
export type BotBallEventHandler = (payload: unknown) => void;

export interface BotBallEngine {
  readonly emotionId: EmotionId | null;
  readonly touring: boolean;
  setEmotion(id: EmotionId, options?: { auto?: boolean }): boolean;
  handleAIMessage(message: AgentEmotionMessage | string): boolean;
  setGaze(nx: number, ny: number): this;
  clearGaze(): this;
  setStyle(style: { sketch?: number }): this;
  spin(turns?: number, direction?: -1 | 1): this;
  burst(count?: number): this;
  bounce(): this;
  setActive(active: boolean): void;
  replay(): void;
  startTour(ids: EmotionId[], interval?: number): void;
  stopTour(): void;
  resetIdle(): void;
  on(event: BotBallEvent, handler: BotBallEventHandler): this;
  off(event: BotBallEvent, handler: BotBallEventHandler): this;
  registerEmotion(config: unknown): unknown;
  destroy(): void;
}

export interface BotBallConfigApi {
  get(id: EmotionId): unknown | null;
  list(group?: EmotionGroupKey): unknown[];
  groups(): EmotionGroup[];
  register(config: unknown): unknown;
  exportConfig(): string;
  importConfig(config: string | unknown): unknown;
}

export interface BotBallStatic {
  readonly version: string;
  readonly EMOTIONS: EmotionSummary[];
  readonly GROUPS: EmotionGroup[];
  readonly config: BotBallConfigApi;
  create(target: string | Element, options?: BotBallCreateOptions): BotBallEngine;
}

declare global {
  interface Window {
    BotBall: BotBallStatic;
  }
}

export const BotBall: BotBallStatic = window.BotBall;

/** Apply a structured Agent response without coupling application code to IDs. */
export function applyAgentEmotion(
  engine: BotBallEngine,
  message: AgentEmotionMessage | string,
): boolean {
  return engine.handleAIMessage(message);
}

export default BotBall;
