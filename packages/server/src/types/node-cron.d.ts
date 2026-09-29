// B5 票5B4：node-cron@3.0.3 无自带类型且未装 @types/node-cron（并行期不动 package.json——B4 铁律沿用）。
// 仅声明 scheduler-engine 实际消费的 surface：schedule(expr, fn, {timezone}) + ScheduledTask.stop()。
// 升级 @types/node-cron 归票6/B6 依赖收口。
declare module 'node-cron' {
  export interface ScheduledTask {
    start(): void
    stop(): void
    destroy?(): void
  }

  export interface ScheduleOptions {
    scheduled?: boolean
    timezone?: string
    name?: string
  }

  export function schedule(
    expression: string,
    func: () => void | Promise<void>,
    options?: ScheduleOptions,
  ): ScheduledTask

  export function validate(expression: string): boolean

  const nodeCron: { schedule: typeof schedule; validate: typeof validate }
  export default nodeCron
}
