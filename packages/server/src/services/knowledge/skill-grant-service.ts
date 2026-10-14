// packages/server/src/services/knowledge/skill-grant-service.ts
//
// skill 授予/撤销机械链 — P3 票05 主服务（spec §skill 草案管线「授予机械链」逐字；
// 故事 18-23）。票04 产草案，本票让人裁一键生效：**授予=正链，撤销=逆链**。
//
// 正链（grant）：
//   ① 草案 → 目标层技能目录（窄口默认=分身层 ADR-0005：built-in/{clone}/skills 或
//      clones/{clone}/skills；「授给所有分身」target='*' = 共享层 agent/skills/）。
//      SKILL.md 重排 front-matter 只留 name/description（票04 §八.4：治理键不带进
//      SDK 件——status/source/origin 是 drafts 区账，不是技能正文）。
//   ② **官方 resource upgrade 原语 installOrUpgrade** 同步运行时预置源
//      （resources/installed/skills/built-in/{name}，sourceDir 通道=草案镜像目录）。
//      P0/P1 血泪教训的直接兑现：裸写文件 + 重启 = registerBuiltins 只自愈幻影行
//      不刷内容（resource-manager.ts 注释逐字），永远不生效；经原语则 registry/
//      lock/audit 三账与文件同更，preflight→provisioner 链现取现用。
//   ③ agent_versions 发布现行版（AgentVersionService.publish 既有事务：
//      DB published 行 → versions/{name}/{ver} 目录 → current_version_id）。
//      仅 config.versioned 分身走版本账（全局坑单 #8：task-doer 等非版本化分身
//      的 live 生效不靠版本——聊天面 getPlugins 直扫目录；publish 对它们是审计面，
//      且会给未版本化分身制造快照解析路径改变——不自作，回执如实报 null）。
//      **快照保真坑**（snapshotToFiles 只从共享层拷技能字节，分身层授予件缺则静默
//      跳）：publish 后由本服务显式 top-up 版本目录 skills/{name}（从分身 live 目录
//      整目录拷），让 versions 快照对分身层授予件保真——不改 AgentVersionService
//      的快照数据契约（那是难逆转取舍，spec 治理节预设的 ADR 评估点；top-up 是
//      可逆的调用方补位）。
//   ④ 草案状态翻面（setDraftGrantState：draft→granted，grantedTo 并集）。
//   ⑤ 回执卡（Lane A 重发同址 skl-{name}，action=granted + receipt）+ 回执返回。
//
// 逆链（revoke）：①/②/③/④/⑤ 的反向——技能目录**显式删除**（copyDirOverwrite
// 只覆盖不删除，rollback 自己移不掉授予件——实锤坑，必须显式 rm）、预置源同步
// （还有其它授予目标→镜像重装剩余真相；撤干净→官方 uninstall 逆原语）、
// **版本逆位**：agent_versions 含该件的发布行 archive（listAllPublished 的引擎
// 'latest' 解析按版本号不按 current_version_id——不 archive 则回退后 'latest'
// 仍命中授予版，撤销在业务工作流域不生效），再 rollback 到最高既有发布版（还原
// persona/config + 指针；previous_version null 桩语义与「无前一版」如实进回执），
// status→revoked（撤到空）/granted 缩清单，回执卡 action=revoked。
//
// 幂等：重复授予同版（目标已在 grantedTo 且分身目录字节=草案渲染）⇒ 零写、
// 零三账操作、零发版，回执 idempotent=true。
// 边界（红线）：**授予不经 wiki 写队列**（非 wiki 写——本文件零 compile-queue/
// enqueue import，S1/S3 负断言钉死）；零 prompt 文本注入（生效=ADR-0006 原生
// 发现，红线4）；agent 记忆域/K11/user_preference 零触碰（红线5）；granted 态
// 的 drafts 文件本服务是唯一写入者（票04 服务对其只读拒写 409）。

import fs from "fs"
import path from "path"
import type { KcCardEvent, KcSkillDraftCardData, ResourceEntry } from "@octopus/shared"
import type { SkillGrantReceipt } from "@octopus/shared"
import type { ResourceManager } from "@octopus/shared"
import { resolveKnowledgeRoot } from "./global-paths"
import { readDraft, setDraftGrantState, type SkillDraftRecord } from "./skill-draft-store"
import { SkillDraftError } from "./skill-draft-service"
import {
  getAgentSkillsDir,
  getBuiltInCloneDir,
  getCloneDir,
  getCloneSkillsDir,
  getVersionSkillsDir,
} from "../agent/paths"
import { isBuiltinClone } from "../agent/builtin-clones"
import type { AgentVersionService } from "../agent/agent-version-service"

/** 授予件的预置源槽组（resources/installed/skills/built-in/{name}——provisioner 按名取 installPath 的既有解析面）。 */
const GRANT_GROUP = "built-in"

/** 「授给所有分身」哨兵目标（=共享技能层，ADR-0005 两层模型；卡面选择器的固定项）。 */
export const GRANT_TARGET_ALL = "*"

// ── 内部形制 ────────────────────────────────────────────────────────────

interface GrantTargetRef {
  target: string
  layer: "clone" | "shared"
  /** 分身目录类型（shared 层无此位） */
  cloneType: "built-in" | "user" | null
  /** 分身 live 目录（config.json 读取位） */
  cloneDir: string | null
}

function isValidTargetName(name: string): boolean {
  return /^[a-zA-Z0-9._-]{1,64}$/.test(name) && !name.includes("..") && name !== "."
}

/** 授予件的 SKILL.md 全文：治理键重排为 SDK 形态（只留 name/description——票04 §八.4 建议兑现）。 */
export function renderGrantSkillFile(name: string, description: string, body: string): string {
  const oneLine = (s: string): string => s.replace(/\s*\n\s*/g, " ").trim()
  return `---\nname: ${name}\ndescription: ${oneLine(description)}\n---\n\n${body.replace(/\s+$/, "")}\n`
}

/** 整目录拷贝（readdir+copyFileSync 递归——禁 fs.cpSync：Node24/Windows 中文段猝死）。 */
function copyDirSync(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true })
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name)
    const d = path.join(dest, entry.name)
    if (entry.isDirectory()) copyDirSync(s, d)
    else fs.copyFileSync(s, d)
  }
}

/** 语义化的整目录移除（撤销的「显式删除」——copyDirOverwrite 不清目录坑的对偶）。 */
function removeDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true })
}

function parseVersionParts(version: string): [number, number, number] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-.+)?$/.exec(version)
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}

function compareVersionDesc(a: string, b: string): number {
  const pa = parseVersionParts(a) ?? [0, 0, 0]
  const pb = parseVersionParts(b) ?? [0, 0, 0]
  return pb[0] - pa[0] || pb[1] - pa[1] || pb[2] - pa[2]
}

// ── Deps ────────────────────────────────────────────────────────────────

export interface SkillGrantServiceDeps {
  /** 知识根（注入 tmpdir；缺省 resolveKnowledgeRoot()——服务层同族律） */
  root?: string
  /** 预置源原语入口（生产 = getResourceRegistry().get() 惰性；测试 = 假 home 实例） */
  manager: () => ResourceManager
  /** 版本账入口（生产 = getAgentVersionService() 惰性——db 未初始化时构造即抛，故函数注入；仅 versioned 分身触达） */
  versionService?: () => AgentVersionService
  /** 回执卡 Lane A 生产者（index.ts 接 appendKnowledgeSessionCards；抛错吞 stderr——通知失败不毁机械链，先做后知同律） */
  announce?: (event: KcCardEvent) => void
  now?: () => Date
}

// ── Service ─────────────────────────────────────────────────────────────

export class SkillGrantService {
  readonly root: string
  private readonly manager: () => ResourceManager
  private readonly versionService?: () => AgentVersionService
  private readonly announce?: (event: KcCardEvent) => void
  private readonly now: () => Date

  constructor(deps: SkillGrantServiceDeps) {
    this.root = resolveKnowledgeRoot(deps.root)
    this.manager = deps.manager
    this.versionService = deps.versionService
    this.announce = deps.announce
    this.now = deps.now ?? (() => new Date())
  }

  // ── 目标解析 ──────────────────────────────────────────────────────────

  private resolveTarget(target: string): GrantTargetRef {
    if (target === GRANT_TARGET_ALL) {
      return { target, layer: "shared", cloneType: null, cloneDir: null }
    }
    if (!isValidTargetName(target)) {
      throw new SkillDraftError("INVALID_TARGET", `分身名不合规：'${target}'（要求 [a-zA-Z0-9._-]≤64，无 ..）`, 400)
    }
    if (isBuiltinClone(target)) {
      const dir = getBuiltInCloneDir(target)
      if (!fs.existsSync(dir)) throw new SkillDraftError("CLONE_NOT_FOUND", `built-in 分身目录不在盘：${target}`, 404)
      return { target, layer: "clone", cloneType: "built-in", cloneDir: dir }
    }
    const dir = getCloneDir(target)
    if (!fs.existsSync(dir)) throw new SkillDraftError("CLONE_NOT_FOUND", `分身不在盘（既非 built-in 也无 clones/ 目录）：${target}`, 404)
    return { target, layer: "clone", cloneType: "user", cloneDir: dir }
  }

  /** 分身是否 config.versioned（config.json 顶层位=启动落盘面，filesToSnapshot/VersionResolver 同读此处）。 */
  private isVersionedClone(ref: GrantTargetRef): boolean {
    if (ref.layer !== "shared" && ref.cloneDir === null) return false
    if (ref.cloneDir === null) return false
    try {
      const cfg = JSON.parse(fs.readFileSync(path.join(ref.cloneDir, "config.json"), "utf-8")) as { versioned?: unknown }
      return cfg.versioned === true
    } catch {
      return false
    }
  }

  private liveSkillsDir(ref: GrantTargetRef): string {
    return ref.layer === "shared"
      ? getAgentSkillsDir()
      : getCloneSkillsDir(ref.target, ref.cloneType === "built-in" ? "built-in" : "user")
  }

  // ── 授予（正链）────────────────────────────────────────────────────────

  async grant(draftName: string, target: string): Promise<SkillGrantReceipt> {
    const rec = readDraft(this.root, draftName)
    if (!rec) throw new SkillDraftError("DRAFT_NOT_FOUND", `草案不在盘或坏形：${draftName}`, 404)
    if (rec.fm.status === "revoked") {
      throw new SkillDraftError("DRAFT_REVOKED", "已退役草案不可授予（重提议走检测出新草案——票04 留档纪律）", 409)
    }
    const ref = this.resolveTarget(target)
    const skillName = rec.fm.name
    const grantText = renderGrantSkillFile(skillName, rec.fm.description, rec.body)

    // 撞名闸：`skill:{name}` 注册槽全局唯一（registry 按 type:name 键），占用者是
    // core-pack builtin 行或他组 local 行 ⇒ 拒绝——防「窄口授予劫持平台技能预置源」
    // （全局坑单 #2 的泄漏面在此闭合：授予件绝不覆盖 builtin 槽行）。
    const clash = this.clashRow(skillName)
    if (clash) {
      throw new SkillDraftError("GRANT_NAME_CLASH", `技能名 '${skillName}' 已被占用（${clash.source}:${clash.group}）——改名草案重提议，授予不劫持既有槽`, 409)
    }

    const liveDir = path.join(this.liveSkillsDir(ref), skillName)
    const grantedNow = new Set(rec.fm.grantedTo ?? [])

    // 幂等（票面逐字「重复授予同版不重复发布」）：目标已在清单且分身件字节=草案渲染
    // ⇒ 零写零账零发版，回执 idempotent。字节漂移/件被外删 ⇒ 修复重落+重同步，
    // 但目标已在清单=同一授予事实，不再堆版本账（repair 不发版）。
    const repair = rec.fm.status === "granted" && grantedNow.has(target)
    if (repair) {
      let sameBytes = false
      try {
        sameBytes = fs.readFileSync(path.join(liveDir, "SKILL.md"), "utf-8") === grantText
      } catch {
        sameBytes = false
      }
      if (sameBytes) {
        return this.buildReceipt(rec.fm.name, skillName, ref, "granted", [...grantedNow].sort(), {
          version: this.currentPublishedVersion(ref),
          published: false,
          rolledBackTo: null,
          presetSync: { ok: true, installPath: this.slotPath(skillName), detail: "重复授予同版：零写、零三账、零发版（幂等）" },
          idempotent: true,
        })
      }
    }

    // ① 分身/共享技能目录落件（先清后写——copyDirSync 不清多余文件的对偶纪律）
    removeDir(liveDir)
    fs.mkdirSync(liveDir, { recursive: true })
    fs.writeFileSync(path.join(liveDir, "SKILL.md"), grantText, "utf-8")

    // ② 官方 upgrade 原语同步运行时预置源（三账+文件同更；失败如实进回执不静默）
    const presetSync = await this.syncPreset(skillName, liveDir)

    // ③ 版本账（仅 versioned 分身；共享层无版本行概念，非 versioned 分身保持原账语义）
    let version: string | null = this.currentPublishedVersion(ref)
    let published = false
    if (!repair && ref.layer === "clone" && this.isVersionedClone(ref)) {
      const next = this.nextVersion(ref.target)
      const svc = this.versionService?.()
      if (!svc) {
        throw new SkillDraftError("GRANT_PUBLISH_FAILED", `versioned 分身 ${ref.target} 需版本账，但 versionService 未注入`, 500)
      }
      try {
        svc.publish(ref.target, {
          version: next,
          stage: "stable",
          changelog: `skill-grant: ${draftName} → ${ref.target}`,
          published_by: "skill-grant",
        })
      } catch (err) {
        throw new SkillDraftError("GRANT_PUBLISH_FAILED", `agent_versions 发布失败：${err instanceof Error ? err.message : String(err)}`, 500)
      }
      // 快照保真补位（snapshotToFiles 只从共享层拷字节的实锤坑）：版本目录显式带授予件
      this.topUpVersionSkillsDir(ref.target, next, skillName, liveDir)
      version = next
      published = true
    }

    // ④ 草案状态翻面（grantedTo 并集）
    grantedNow.add(target)
    const grantedTo = [...grantedNow].sort()
    const st = setDraftGrantState(this.root, draftName, { status: "granted", grantedTo, now: this.now().toISOString() })
    if (!st.ok) {
      throw new SkillDraftError(st.reason ?? "GRANT_STATE_FAILED", st.detail ?? `状态翻面失败：${draftName}`, 500)
    }

    // ⑤ 回执卡 + 回执
    const fresh = readDraft(this.root, draftName)!
    const receipt = this.buildReceipt(fresh.fm.name, skillName, ref, "granted", grantedTo, {
      version,
      published,
      rolledBackTo: null,
      presetSync,
      idempotent: false,
    })
    this.announceReceipt(fresh, "granted", grantedTo, receipt)
    return receipt
  }

  // ── 撤销（逆链）────────────────────────────────────────────────────────

  async revoke(draftName: string, target: string): Promise<SkillGrantReceipt> {
    const rec = readDraft(this.root, draftName)
    if (!rec) throw new SkillDraftError("DRAFT_NOT_FOUND", `草案不在盘或坏形：${draftName}`, 404)
    if (rec.fm.status !== "granted") {
      throw new SkillDraftError("DRAFT_NOT_GRANTED", `草案未授予（status=${rec.fm.status}），无撤销可言`, 409)
    }
    const granted = new Set(rec.fm.grantedTo ?? [])
    if (!granted.has(target)) {
      throw new SkillDraftError("GRANT_TARGET_NOT_FOUND", `该草案未授予过 '${target}'（现清单：${[...granted].join(", ") || "空"}）`, 409)
    }
    const ref = this.resolveTarget(target)
    const skillName = rec.fm.name

    // ①′ 逆-技能目录：显式删除（rollback 的 copyDirOverwrite 不清多余目录——撤销必须自己删，实锤坑）
    removeDir(path.join(this.liveSkillsDir(ref), skillName))

    // ②′ 逆-预置源同步：仍有其它授予目标 ⇒ 镜像重装剩余真相；撤干净 ⇒ 官方 uninstall 逆原语
    granted.delete(target)
    const grantedTo = [...granted].sort()
    let presetSync = { ok: true, installPath: null as string | null, detail: "" }
    if (grantedTo.length > 0) {
      const survivor = grantedTo[0]!
      const survRef = this.resolveTarget(survivor)
      const survDir = path.join(this.liveSkillsDir(survRef), skillName)
      if (fs.existsSync(path.join(survDir, "SKILL.md"))) {
        presetSync = await this.syncPreset(skillName, survDir)
      } else {
        presetSync = { ok: false, installPath: this.slotPath(skillName), detail: `镜像重装失败：幸存目标 ${survivor} 的 live 件不在盘` }
      }
    } else {
      presetSync = await this.unsyncPreset(skillName)
    }

    // ③′ 逆-版本账：archive 含该件的发布行（引擎 'latest' 按版本号解析，不 archive 则
    // 撤销在业务工作流域不生效）+ rollback 还原 persona/config 与现行版指针。
    let rolledBackTo: string | null = null
    const versionNote: string[] = []
    if (ref.layer === "clone" && this.isVersionedClone(ref)) {
      const svc = this.versionService?.()
      if (svc) {
        for (const row of svc.list(ref.target).versions) {
          if (row.status !== "published") continue
          let skills: string[] = []
          try {
            skills = (JSON.parse(row.snapshot) as { skills?: string[] }).skills ?? []
          } catch { /* 坏快照跳过审计位 */ }
          if (skills.includes(skillName)) {
            try {
              svc.archive(ref.target, row.version)
            } catch (err) {
              versionNote.push(`archive(${row.version}) 失败：${err instanceof Error ? err.message : String(err)}`)
            }
          }
        }
        const prev = svc.list(ref.target, { status: "published" }).versions
          .map(r => r.version)
          .sort(compareVersionDesc)[0]
        if (prev) {
          try {
            // rollback 返回 {success, previous_version}——后者现是 null 桩（坑单 #3），
            // 回退目标版本以本服务自算的 prev 为准进回执。
            svc.rollback(ref.target, prev)
            rolledBackTo = prev
          } catch (err) {
            versionNote.push(`rollback(${prev}) 失败：${err instanceof Error ? err.message : String(err)}`)
          }
        } else {
          versionNote.push("无前一发布版可回退（previous_version 桩语义：null）")
        }
      } else {
        versionNote.push("versionService 未注入：版本账未逆位（如实报告）")
      }
    }

    // ④′ 状态翻面（撤到空 ⇒ revoked 终态；仍有目标 ⇒ granted 缩清单）
    const toStatus = grantedTo.length > 0 ? "granted" : "revoked"
    const st = setDraftGrantState(this.root, draftName, { status: toStatus, grantedTo, now: this.now().toISOString() })
    if (!st.ok) {
      throw new SkillDraftError(st.reason ?? "GRANT_STATE_FAILED", st.detail ?? `撤销状态翻面失败：${draftName}`, 500)
    }

    const fresh = readDraft(this.root, draftName)!
    const receipt = this.buildReceipt(fresh.fm.name, skillName, ref, toStatus, grantedTo, {
      version: rolledBackTo,
      published: false,
      rolledBackTo,
      presetSync: versionNote.length > 0 ? { ...presetSync, detail: `${presetSync.detail}；${versionNote.join("；")}` } : presetSync,
      idempotent: false,
    })
    this.announceReceipt(fresh, "revoked", grantedTo, receipt)
    return receipt
  }

  // ── 机械链零件 ────────────────────────────────────────────────────────

  private slotPath(skillName: string): string {
    return path.join(this.manager().basePath, "installed", "skills", GRANT_GROUP, skillName)
  }

  /** 撞名闸：返回占用 `skill:{name}` 槽且不属于授予链的行（builtin 行或异组行）。 */
  private clashRow(skillName: string): ResourceEntry | null {
    const row = this.manager().get("skill", skillName)
    if (!row) return null
    if (row.source === "local" && row.group === GRANT_GROUP) return null // 自家槽（重复授予/修复）
    return row
  }

  /** ② 正-预置源同步：官方 upgrade 原语 sourceDir 通道（source=local 行——registerBuiltins 对非 builtin 行不刷内容，安全）。 */
  private async syncPreset(skillName: string, sourceDir: string): Promise<SkillGrantReceipt["presetSync"]> {
    try {
      const res = await this.manager().installOrUpgrade({
        ref: `local:${skillName}`,
        type: "skill",
        group: GRANT_GROUP,
        sourceDir,
        caller: "cli",
      })
      return { ok: true, installPath: res.installPath, detail: `installOrUpgrade 三账+文件同更（status=${res.status}）` }
    } catch (err) {
      return { ok: false, installPath: this.slotPath(skillName), detail: `预置源同步失败：${err instanceof Error ? err.message : String(err)}` }
    }
  }

  /** ② 逆-预置源移除：官方 uninstall 逆原语（行已不在=幂等 ok）。 */
  private async unsyncPreset(skillName: string): Promise<SkillGrantReceipt["presetSync"]> {
    const row = this.manager().get("skill", skillName)
    if (!row) return { ok: true, installPath: null, detail: "预置源槽已不在（幂等）" }
    if (!(row.source === "local" && row.group === GRANT_GROUP)) {
      return { ok: false, installPath: row.installPath, detail: `槽位归属非授予链（source=${row.source}:${row.group}），不逆` }
    }
    try {
      const res = await this.manager().uninstall({ name: skillName, type: "skill", caller: "cli" })
      return { ok: res.verified, installPath: null, detail: `uninstall 逆原语完成（verified=${res.verified}）` }
    } catch (err) {
      return { ok: false, installPath: row.installPath, detail: `预置源移除失败：${err instanceof Error ? err.message : String(err)}` }
    }
  }

  private currentPublishedVersion(ref: GrantTargetRef): string | null {
    if (ref.layer !== "clone" || !this.isVersionedClone(ref)) return null
    const svc = this.versionService?.()
    if (!svc) return null
    return svc.list(ref.target, { status: "published" }).versions.map(r => r.version).sort(compareVersionDesc)[0] ?? null
  }

  private nextVersion(agentName: string): string {
    const svc = this.versionService?.()
    const rows = svc ? svc.list(agentName).versions : []
    const max = rows
      .map(r => r.version)
      .sort(compareVersionDesc)[0]
    const parts = max ? parseVersionParts(max) : null
    if (!parts) return "1.0.0"
    return `${parts[0]}.${parts[1]}.${parts[2] + 1}`
  }

  /** 快照保真补位：versions/{name}/{ver}/skills/{skill} 整目录镜像分身 live 件。 */
  private topUpVersionSkillsDir(agentName: string, version: string, skillName: string, liveSkillDir: string): void {
    const dest = path.join(getVersionSkillsDir(agentName, version), skillName)
    removeDir(dest)
    copyDirSync(liveSkillDir, dest)
  }

  private buildReceipt(
    draftName: string,
    skillName: string,
    ref: GrantTargetRef,
    status: "granted" | "revoked",
    grantedTo: string[],
    rest: Pick<SkillGrantReceipt, "version" | "published" | "rolledBackTo" | "presetSync" | "idempotent">,
  ): SkillGrantReceipt {
    return {
      draftName,
      skillName,
      target: ref.target,
      layer: ref.layer,
      status,
      grantedTo,
      ...rest,
      receiptAt: this.now().toISOString(),
    }
  }

  /** 回执卡（Lane A 重发同址 skl-{name}——票04 §六「action 位扩 granted/revoked」插座兑现）。 */
  private announceReceipt(
    rec: SkillDraftRecord,
    action: "granted" | "revoked",
    grantedTo: string[],
    receipt: SkillGrantReceipt,
  ): void {
    if (!this.announce) return
    try {
      const data: KcSkillDraftCardData = {
        draftName: rec.fm.name,
        description: rec.fm.description,
        status: rec.fm.status,
        origin: rec.fm.origin,
        source: rec.fm.source,
        skillPath: rec.relPath,
        content: rec.body,
        sourceRefs: [{ kind: "exec", pointer: rec.fm.source, label: "来源指针（front-matter 原样）" }],
        skillName: rec.fm.name,
        grantedTo,
        receipt,
        action,
      }
      this.announce({ id: `skl-${rec.fm.name}`, kind: "skill-draft", ts: receipt.receiptAt, data })
    } catch (err) {
      process.stderr.write(`[skill-grant] announce failed for ${rec.fm.name}: ${err instanceof Error ? err.message : String(err)}\n`)
    }
  }
}
