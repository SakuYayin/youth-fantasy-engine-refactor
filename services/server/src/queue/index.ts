/**
 * 队列模块的对外出口。
 *
 * 只导出运行器：执行器由调用方注入（`services/server/src/index.ts` 之类的装配点），
 * 队列模块自己不 import 任何业务代码——依赖方向永远是"业务 → 队列"，
 * 反过来就会让队列被某一条 AI 流水线绑死。
 */

export { createJobRunner } from './runner.js'
export type {
  JobExecutor,
  JobExecutorContext,
  JobRunner,
  JobRunnerOptions,
  RunnerJobStatus,
  RunnerOutcome,
} from './runner.js'
