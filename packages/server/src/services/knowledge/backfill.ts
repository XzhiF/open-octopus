import { IngestError, RawIngestService, type IngestResult } from "./raw"
import { resolveKnowledgeRoot } from "./global-paths"

/**
 * BackfillService — 回填通道（知识中心票13 AC4，spec 故事 14「探索复利」）。
 *
 * 链路：策展人对话中的有价值合成答案 →（回填卡 [编进 wiki]）→ **对话摘录落 raw**
 * （票02 冻结契约原样：front-matter hash/不可变/同内容幂等；origin 信道 =
 * `chat:<session>`，sources 语义即 chat:session）→ 触发编译（curatorTasks.submit
 * 经全局队列，diff 卡跟随）。
 *
 * 窄口纪律（票面 AC4 负断言）：**执行中 agent 的产出不自动回填**——本服务是回填的
 * 唯一入口，且只由知识中心对话/显式 API 调用；巡检消费 executions 只产 stale
 * finding（patrol 面），零编译零落 raw（wiki-patrol.test 钉死）。
 */

export interface BackfillInput {
  /** 对话摘录正文（合成答案原文） */
  text: string
  /** 新页候选标题（slug 与 raw title 消费；缺省按日期命名） */
  title?: string
  /** 来源会话 id（回填指针；进 origin 与摘录头） */
  sessionId?: string
}

export interface BackfillResult {
  mode: "backfill"
  deduped: boolean
  raw: IngestResult["raw"]
  /** 编译回执（curatorTasks.submit 形态）；未接线时 null（离线/测试注入形态） */
  compileTask: { taskId: string; status: string } | null
}

export interface BackfillDeps {
  root?: string
  now?: () => Date
  /** 编译投递 seam（生产 = curatorTasks.submit 包装；测试 = 捕获） */
  trigger?: (rawPath: string) => { taskId: string; status: string }
}

export class BackfillService {
  private readonly raw: RawIngestService
  private readonly root: string
  private readonly now: () => Date
  private readonly trigger?: BackfillDeps["trigger"]

  constructor(deps: BackfillDeps = {}) {
    this.root = resolveKnowledgeRoot(deps.root)
    this.raw = new RawIngestService({ root: this.root, now: deps.now })
    this.now = deps.now ?? (() => new Date())
    if (deps.trigger) this.trigger = deps.trigger
  }

  backfill(input: BackfillInput): BackfillResult {
    const text = typeof input.text === "string" ? input.text.trim() : ""
    if (text === "") {
      throw new IngestError("INVALID_PARAM", "text is required（回填需要对话摘录正文）", 400)
    }
    const date = this.now().toISOString().slice(0, 10)
    const session = input.sessionId?.trim() || "knowledge-center"
    const title = input.title?.trim() || `chat 回填 ${date}`
    // 摘录头进正文（不可变源自带出处；raw front-matter origin 记 chat 信道）
    const payload = [
      `> 对话摘录回填 · session ${session} · ${date}`,
      "> 窄口纪律：由知识中心回填卡 [编进 wiki] 显式触发，非执行产出自动入库。",
      "",
      text,
      "",
    ].join("\n")
    const res = this.raw.ingestText({
      text: payload,
      title,
      dir: "inbox",
      origin: `chat:${session}`,
    })
    const compileTask = this.trigger ? this.trigger(res.raw.path) : null
    return { mode: "backfill", deduped: res.deduped, raw: res.raw, compileTask }
  }
}
