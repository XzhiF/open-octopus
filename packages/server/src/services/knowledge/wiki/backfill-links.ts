import fs from "fs"
import path from "path"
import { WikiArticleDAO } from "../../../db/dao/wiki-article-dao"
import { GLOBAL_WIKI_ORG } from "../global-paths"
import { parseWikiFile } from "./format"
import { computeArticleLinks, wikiLinkTargets } from "./lint"

/**
 * wiki_articles.links 一次性回灌（反链倒排的落库基础，知识中心改版·右栏反链）。
 *
 * 纪律：只跑在**启动**（index.ts applySchema 之后一处），运行时零扫盘——tree 端点
 * 只消费 links 列。NULL 行=列引入前的历史行；盘真源优先（front-matter links 面
 * 不在 DB body 列），盘缺文件回退正文 [[…]] 面；解析坏留 stderr 不阻断。
 * 幂等：跑过的行 links 非 NULL 不再进扫描面。新编译/退役/恢复/回滚通道写 links
 * 与盘同步（compile/page-retire/page-restore/revert 全链），无需再回灌。
 */
export function backfillWikiArticleLinks(articles: WikiArticleDAO, wikiRoot: string): number {
  const rows = articles.listByOrg(GLOBAL_WIKI_ORG).filter(r => r.links == null)
  for (const r of rows) {
    let links: string[]
    const abs = r.path ? path.join(wikiRoot, r.path) : ""
    try {
      if (abs && fs.existsSync(abs)) {
        const parsed = parseWikiFile(fs.readFileSync(abs, "utf-8"))
        links = parsed.kind === "page" ? computeArticleLinks(parsed.meta.links, parsed.body) : wikiLinkTargets(parsed.body)
      } else {
        links = wikiLinkTargets(r.body)
      }
    } catch (err) {
      process.stderr.write(`[wiki-links-backfill] 解析异常回退正文链面 ${r.path}: ${err instanceof Error ? err.message : String(err)}\n`)
      links = wikiLinkTargets(r.body)
    }
    const { updated_at: _ut, ...upsert } = r
    articles.upsert({ ...upsert, links })
  }
  return rows.length
}
