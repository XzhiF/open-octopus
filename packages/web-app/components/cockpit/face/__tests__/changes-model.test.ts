// 本舱变更窗的纯模型（v22 十三轮 · 问题 #1）：统计条 / 目录树 / 过滤。
import { describe, it, expect } from 'vitest'
import type { CabinWorktreeChangeRepo } from '@/lib/cabin-api'
import {
  buildChangeTree, changeKey, changeTotals, collectChangeFiles, compactChangeDir, filterChanges,
} from '../changes-model'

function repo(name: string, files: CabinWorktreeChangeRepo['files'], over: Partial<CabinWorktreeChangeRepo> = {}): CabinWorktreeChangeRepo {
  return {
    name,
    dir: `D:/ws/${name}`,
    branch: `feat/${name}`,
    head: '8ab30d2',
    error: null,
    truncated: false,
    files,
    ...over,
  }
}

describe('changes-model · 统计', () => {
  it('目录有改动 / 文件 / ±行 / 未跟踪 / 干净仓', () => {
    const tot = changeTotals([
      repo('ledger', [
        { path: 'src/a.ts', status: 'M', adds: 5, dels: 2 },
        { path: 'src/new.ts', status: '?', adds: 3, dels: 0, untracked: true },
      ]),
      repo('edge', []),
    ])
    expect(tot).toEqual({ dirs: 1, files: 2, adds: 8, dels: 2, untracked: 1, clean: 1 })
  })
})

describe('changes-model · 树 / 过滤', () => {
  const repos = [
    repo('ledger', [
      { path: 'src/settlement/reconcile.ts', status: 'M', adds: 58, dels: 21 },
      { path: 'src/ledger/post.ts', status: '?', adds: 26, dels: 0, untracked: true },
    ]),
  ]
  const entries = collectChangeFiles(repos)

  it('键 = repo:path，拍平所有仓', () => {
    expect(entries.map((e) => e.key)).toEqual([
      changeKey('ledger', 'src/settlement/reconcile.ts'),
      changeKey('ledger', 'src/ledger/post.ts'),
    ])
  })

  it('目录树按路径分段，文件挂在叶节点', () => {
    const tree = buildChangeTree(entries)
    expect([...tree.dirs.keys()].sort()).toEqual(['src'])
    const src = tree.dirs.get('src')!
    expect([...src.dirs.keys()].sort()).toEqual(['ledger', 'settlement'])
    expect(src.dirs.get('settlement')!.files.map((e) => e.file.path)).toEqual(['src/settlement/reconcile.ts'])
    expect(src.files).toEqual([])
  })

  it('目录压缩：单链无文件一路接起来', () => {
    const tree = buildChangeTree(entries)
    const src = tree.dirs.get('src')!
    // src 有 2 个子目录（分叉）→ 不压缩
    expect(compactChangeDir(src)).toEqual({ label: 'src', target: src })
    // settlement 只有一个文件 → 压缩到自身（有文件即停）
    const settlement = src.dirs.get('settlement')!
    expect(compactChangeDir(settlement)).toEqual({ label: 'settlement', target: settlement })
  })

  it('过滤：命中文件 + 展开匹配链（按 repo/path 搜索）', () => {
    const { files, keep } = filterChanges(entries, 'post')
    expect(files.map((e) => e.key)).toEqual([changeKey('ledger', 'src/ledger/post.ts')])
    expect([...(keep ?? [])].sort()).toEqual([
      changeKey('ledger', 'src'),
      changeKey('ledger', 'src/ledger'),
    ])
    // 空查询 = 全量 + 不强制展开
    expect(filterChanges(entries, '  ').keep).toBeNull()
    // 按仓名也能搜到
    expect(filterChanges(entries, 'ledger/').files).toHaveLength(2)
  })
})
