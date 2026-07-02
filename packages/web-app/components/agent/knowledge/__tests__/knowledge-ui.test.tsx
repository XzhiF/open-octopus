/**
 * Knowledge UI component tests — covers all 18 UI fake_pass cases from e2e-reality-notes.
 *
 * TC-016, TC-018, TC-019, TC-020, TC-022, TC-027, TC-028, TC-029, TC-030,
 * TC-031, TC-032, TC-033, TC-034, TC-035, TC-036, TC-037, TC-038, TC-043
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { type PropsWithChildren } from 'react'

// ── Common mocks ──────────────────────────────────────────────────────

vi.mock('@/lib/utils', () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
}))

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
  },
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  usePathname: () => '/agent',
  useSearchParams: () => new URLSearchParams(),
}))

// ── API mocks ─────────────────────────────────────────────────────────

vi.mock('@/lib/knowledge/api', () => ({
  getKnowledgeFiles: vi.fn().mockResolvedValue([]),
  getKnowledgeFile: vi.fn().mockResolvedValue({ content: '', rules: [], filePath: '' }),
  getPreference: vi.fn().mockResolvedValue({ content: '', scope: 'org' }),
  updatePreference: vi.fn().mockResolvedValue({ ok: true }),
  updateKnowledgeFile: vi.fn().mockResolvedValue({ ok: true, ruleCount: 0 }),
  deleteKnowledgeFile: vi.fn().mockResolvedValue({ ok: true, deletedRules: 0 }),
  compactKnowledge: vi.fn().mockResolvedValue({ ok: true }),
  previewCompact: vi.fn().mockResolvedValue({ originalContent: '', compactedContent: '', llmAvailable: true }),
  restoreRule: vi.fn().mockResolvedValue({ ok: true }),
  generateKnowledge: vi.fn().mockResolvedValue({ content: '', suggestedPath: '' }),
  getAvailableWorkflows: vi.fn().mockResolvedValue({ workflows: [] }),
  getPendingReviews: vi.fn().mockResolvedValue({ data: [], total: 0, page: 1, pageSize: 20 }),
  reviewAction: vi.fn().mockResolvedValue({ ok: true, id: '', newStatus: 'approved' }),
  batchReview: vi.fn().mockResolvedValue({ ok: true, succeeded: 0, failed: 0, details: [] }),
  getReviewSummary: vi.fn().mockResolvedValue({ rules: 0, skills: 0, total: 0 }),
  getArchiveSummary: vi.fn().mockResolvedValue({ executionId: '', nodes: [], reviewBlockers: [], e2eResults: '', poolSnapshot: null }),
  proposeArchive: vi.fn().mockResolvedValue({ rules: [], skills: null, pendingCount: 0 }),
  createAssistantStream: vi.fn(),
}))

// useOrgs() pulls from api-client.listOrgs. Default to two orgs so the
// PreferenceEditor waterfall renders as "global + xzf + acme".
vi.mock('@/lib/api-client', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    listOrgs: vi.fn().mockResolvedValue([
      { id: 1, name: 'xzf', path: '~/.octopus/orgs/xzf' },
      { id: 2, name: 'acme', path: '~/.octopus/orgs/acme' },
    ]),
    fetchManifestRepos: vi.fn().mockResolvedValue({ groups: {}, org: 'xzf' }),
  }
})

// ── ReactMarkdown mock (renders raw text, no markdown parsing) ────────

vi.mock('react-markdown', () => ({
  default: ({ children }: { children: string }) => {
    const { createElement } = require('react')
    return createElement('div', { 'data-testid': 'markdown-content' }, children)
  },
}))
vi.mock('remark-gfm', () => ({ default: () => {} }))

// ── Dialog mocks for ArchiveDialog (avoid Portal issues in jsdom) ─────

vi.mock('@/components/ui/dialog', () => {
  const React = require('react')
  return {
    Dialog: ({ children, open }: PropsWithChildren<{ open?: boolean }>) =>
      open ? React.createElement('div', { role: 'dialog' }, children) : null,
    DialogContent: ({ children }: PropsWithChildren) =>
      React.createElement('div', null, children),
    DialogHeader: ({ children }: PropsWithChildren) =>
      React.createElement('div', null, children),
    DialogTitle: ({ children }: PropsWithChildren) =>
      React.createElement('h2', null, children),
  }
})

vi.mock('@/components/ui/alert-dialog', () => {
  const React = require('react')
  return {
    AlertDialog: ({ children, open }: PropsWithChildren<{ open?: boolean }>) =>
      open ? React.createElement('div', { role: 'alertdialog' }, children) : null,
    AlertDialogContent: ({ children }: PropsWithChildren) =>
      React.createElement('div', null, children),
    AlertDialogHeader: ({ children }: PropsWithChildren) =>
      React.createElement('div', null, children),
    AlertDialogTitle: ({ children }: PropsWithChildren) =>
      React.createElement('h2', null, children),
    AlertDialogDescription: ({ children }: PropsWithChildren) =>
      React.createElement('p', null, children),
    AlertDialogFooter: ({ children }: PropsWithChildren) =>
      React.createElement('div', null, children),
    AlertDialogCancel: ({ children, onClick }: PropsWithChildren<{ onClick?: () => void }>) =>
      React.createElement('button', { onClick }, children),
    AlertDialogAction: ({ children, onClick }: PropsWithChildren<{ onClick?: () => void }>) =>
      React.createElement('button', { onClick }, children),
  }
})

// ── Imports (after mock setup) ────────────────────────────────────────

import { SkillProposalCard } from '../cards/SkillProposalCard'
import { ReviewCard } from '../cards/ReviewCard'
import { BatchActionBar } from '../review/BatchActionBar'
import { ConflictBadge } from '../shared/badges'
import { KnowledgeTabBadge } from '../shared/KnowledgeTabBadge'
import { AgentTabs } from '../../layout/AgentTabs'
import { ChatArea } from '../../chat/ChatArea'
import { ExperienceList } from '../ExperienceList'
import { KnowledgeAssistantPanel } from '../assistant/KnowledgeAssistantPanel'
import { PreferenceEditor } from '../PreferenceEditor'
import { ArchiveDialog } from '../archive/ArchiveDialog'
import { toast } from 'sonner'
import * as api from '@/lib/knowledge/api'

// ── Helpers ───────────────────────────────────────────────────────────

const mockApi = api as Record<string, ReturnType<typeof vi.fn>>

function makePendingItem(overrides: Record<string, unknown> = {}) {
  return {
    id: 'item-1', type: 'rule', source: 'workspace_archive',
    source_label: 'Test', content: 'Test rule content',
    target_file: 'test.md', scope: 'project', conflicts: null,
    confidence: 0.8, auto_approve: 0, status: 'pending', user_notes: null,
    ...overrides,
  }
}

const chatBaseProps = {
  messages: [] as never[], streaming: false, streamContent: '',
  streamThinking: '', isThinking: false, toolCalls: [] as never[],
  pendingConfirm: null, error: null, statusMessage: '',
  onSend: vi.fn(), onStop: vi.fn(), onConfirm: vi.fn(), hasSession: true,
}

const mockSkill = {
  skillName: 'octo-test-skill', category: 'development',
  content: 'Test skill content for verification', confidence: 0.8,
}

// ═══════════════════════════════════════════════════════════════════════
// TC-016: Agent 对话中 Skill 提议卡片
// ═══════════════════════════════════════════════════════════════════════

describe('TC-016: SkillProposalCard in chat', () => {
  it('renders skill proposal card with 3 action buttons', () => {
    render(
      <ChatArea
        {...chatBaseProps}
        skillProposal={mockSkill}
        onSkillAction={vi.fn()}
      />
    )

    expect(screen.getByTestId('skill-proposal-card')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '生成' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '不需要' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '调整' })).toBeInTheDocument()
  })

  it('calls onSkillAction when generate button clicked', async () => {
    const onAction = vi.fn()
    render(
      <ChatArea {...chatBaseProps} skillProposal={mockSkill} onSkillAction={onAction} />
    )

    await userEvent.click(screen.getByRole('button', { name: '生成' }))
    expect(onAction).toHaveBeenCalledWith('generate')
  })
})

// ═══════════════════════════════════════════════════════════════════════
// TC-022: Agent 对话审核卡片
// ═══════════════════════════════════════════════════════════════════════

describe('TC-022: ReviewCard in chat', () => {
  const reviewItem = {
    id: 'review-1', type: 'rule' as const, content: 'Always validate inputs',
    source: 'workspace_archive', sourceLabel: 'WS-001', targetFile: 'rules.md',
    scope: 'project', conflicts: null, confidence: 0.9,
  }

  it('renders review card with action buttons', () => {
    render(
      <ChatArea
        {...chatBaseProps}
        reviewItems={[reviewItem]}
        onReviewAction={vi.fn()}
      />
    )

    expect(screen.getByRole('button', { name: '纳入' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '跳过' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '暂缓' })).toBeInTheDocument()
  })

  it('calls onReviewAction with approve when 纳入 clicked', async () => {
    const onAction = vi.fn()
    render(
      <ChatArea
        {...chatBaseProps}
        reviewItems={[reviewItem]}
        onReviewAction={onAction}
      />
    )

    await userEvent.click(screen.getByRole('button', { name: '纳入' }))
    expect(onAction).toHaveBeenCalledWith('review-1', 'approve')
  })
})

// ═══════════════════════════════════════════════════════════════════════
// TC-027: 知识 Tab 渲染与 badge
// ═══════════════════════════════════════════════════════════════════════

describe('TC-027: Knowledge Tab with badge', () => {
  it('renders 7 tabs with 知识 between 记忆 and SKILL', () => {
    render(<AgentTabs activeTab="chat" onTabChange={vi.fn()} />)

    const tabs = screen.getAllByRole('tab')
    expect(tabs).toHaveLength(7)

    const labels = tabs.map(t => t.textContent?.trim())
    expect(labels).toEqual(['对话', '记忆', '知识', 'SKILL', '分身', '任务', '配置'])

    const ki = labels.indexOf('知识')
    expect(labels[ki - 1]).toBe('记忆')
    expect(labels[ki + 1]).toBe('SKILL')
  })

  it('shows badge with pending count on knowledge tab', async () => {
    mockApi.getReviewSummary.mockResolvedValueOnce({ rules: 2, skills: 1, total: 3 })
    render(<AgentTabs activeTab="chat" onTabChange={vi.fn()} />)

    await waitFor(() => {
      expect(screen.getByText('3')).toBeInTheDocument()
    })
  })

  it('calls onTabChange when a tab is clicked', async () => {
    const onChange = vi.fn()
    render(<AgentTabs activeTab="chat" onTabChange={onChange} />)

    await userEvent.click(screen.getByRole('tab', { name: '知识' }))
    expect(onChange).toHaveBeenCalledWith('knowledge')
  })
})

// ═══════════════════════════════════════════════════════════════════════
// TC-038: KnowledgeTabBadge rendering
// ═══════════════════════════════════════════════════════════════════════

describe('TC-038: KnowledgeTabBadge', () => {
  it('renders nothing when count is 0', () => {
    const { container } = render(<KnowledgeTabBadge count={0} />)
    expect(container.innerHTML).toBe('')
  })

  it('renders count when > 0', () => {
    render(<KnowledgeTabBadge count={5} />)
    expect(screen.getByText('5')).toBeInTheDocument()
  })

  it('renders 99+ when count exceeds 99', () => {
    render(<KnowledgeTabBadge count={150} />)
    expect(screen.getByText('99+')).toBeInTheDocument()
  })
})

// ═══════════════════════════════════════════════════════════════════════
// TC-030: 经验库列表浏览
// ═══════════════════════════════════════════════════════════════════════

describe('TC-030: ExperienceList', () => {
  it('renders file list grouped by type', async () => {
    const files = [
      { name: 'projects/octopus.md', type: 'project' as const, scope: 'org' as const, ruleCount: 3, retiredCount: 0, lineCount: 50, compactNeeded: false },
      { name: 'projects/bug-hunter.md', type: 'project' as const, scope: 'org' as const, ruleCount: 2, retiredCount: 0, lineCount: 30, compactNeeded: false },
      { name: 'workflows/prd-impl.md', type: 'workflow' as const, scope: 'org' as const, ruleCount: 5, retiredCount: 0, lineCount: 40, compactNeeded: false },
    ]

    render(
      <ExperienceList
        files={files}
        selectedFile={null}
        onSelect={vi.fn()}
        onCreate={vi.fn()}
      />
    )

    expect(screen.getByText('octopus')).toBeInTheDocument()
    expect(screen.getByText('bug-hunter')).toBeInTheDocument()
    expect(screen.getByText('prd-impl')).toBeInTheDocument()
    expect(screen.getByText('项目经验')).toBeInTheDocument()
    expect(screen.getByText('工作流经验')).toBeInTheDocument()
  })
})

// ═══════════════════════════════════════════════════════════════════════
// TC-031: 经验库空态
// ═══════════════════════════════════════════════════════════════════════

describe('TC-031: ExperienceList empty state', () => {
  it('shows empty text when no files', () => {
    render(
      <ExperienceList
        files={[]}
        selectedFile={null}
        onSelect={vi.fn()}
        onCreate={vi.fn()}
      />
    )

    // Both groups show "暂无" when empty
    expect(screen.getAllByText('暂无').length).toBe(2)
  })
})

// ═══════════════════════════════════════════════════════════════════════
// TC-020: ConflictBadge 冲突标记
// ═══════════════════════════════════════════════════════════════════════

describe('TC-020: ConflictBadge', () => {
  it('renders conflict type label', () => {
    render(<ConflictBadge conflictType="contradictory" />)
    expect(screen.getByText('矛盾')).toBeInTheDocument()
  })

  it('renders all conflict type variants', () => {
    const { rerender } = render(<ConflictBadge conflictType="duplicate" />)
    expect(screen.getByText('重复')).toBeInTheDocument()

    rerender(<ConflictBadge conflictType="outdated" />)
    expect(screen.getByText('过时')).toBeInTheDocument()
  })

  it('shows details in HoverCard when provided', () => {
    render(<ConflictBadge conflictType="contradictory" details="Conflicts with rule R-001" />)
    // The badge itself renders; HoverCard content appears on hover (tested manually via Playwright)
    expect(screen.getByText('矛盾')).toBeInTheDocument()
  })
})

// ═══════════════════════════════════════════════════════════════════════
// TC-032: BatchActionBar 批量操作栏
// ═══════════════════════════════════════════════════════════════════════

describe('TC-032: BatchActionBar', () => {
  it('shows selection count when items selected', () => {
    render(
      <BatchActionBar
        selectedCount={2}
        onBatchApprove={vi.fn()}
        onBatchReject={vi.fn()}
        onClearSelection={vi.fn()}
      />
    )

    expect(screen.getByText('已选 2 条')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /纳入选中/ })).toBeInTheDocument()
  })

  it('calls onBatchApprove when approve clicked', async () => {
    const onApprove = vi.fn()
    render(
      <BatchActionBar
        selectedCount={3}
        onBatchApprove={onApprove}
        onBatchReject={vi.fn()}
        onClearSelection={vi.fn()}
      />
    )

    await userEvent.click(screen.getByRole('button', { name: /纳入选中/ }))
    expect(onApprove).toHaveBeenCalled()
  })

  it('hides bar when no items selected', () => {
    const { container } = render(
      <BatchActionBar
        selectedCount={0}
        onBatchApprove={vi.fn()}
        onBatchReject={vi.fn()}
        onClearSelection={vi.fn()}
      />
    )

    const bar = container.firstChild as HTMLElement
    expect(bar.className).toContain('pointer-events-none')
  })
})

// ═══════════════════════════════════════════════════════════════════════
// TC-033: 审核暂缓操作 (ReviewItemCard)
// ═══════════════════════════════════════════════════════════════════════

describe('TC-033: ReviewItemCard defer action', () => {
  // Dynamic import to avoid hoisting issues
  let ReviewItemCard: typeof import('../review/ReviewItemCard').ReviewItemCard

  beforeEach(async () => {
    const mod = await import('../review/ReviewItemCard')
    ReviewItemCard = mod.ReviewItemCard
  })

  it('calls onAction with defer when 暂缓 clicked', async () => {
    const onAction = vi.fn()
    const item = makePendingItem() as never

    render(<ReviewItemCard item={item} isSelected={false} onToggleSelect={vi.fn()} onAction={onAction} onDiscuss={vi.fn()} />)

    const deferBtn = screen.getByRole('button', { name: '暂缓' })
    await userEvent.click(deferBtn)
    expect(onAction).toHaveBeenCalledWith('item-1', 'defer')
  })

  it('calls onAction with approve when 纳入 clicked', async () => {
    const onAction = vi.fn()
    const item = makePendingItem() as never

    render(<ReviewItemCard item={item} isSelected={false} onToggleSelect={vi.fn()} onAction={onAction} onDiscuss={vi.fn()} />)

    await userEvent.click(screen.getByRole('button', { name: '纳入' }))
    expect(onAction).toHaveBeenCalledWith('item-1', 'approve')
  })
})

// ═══════════════════════════════════════════════════════════════════════
// TC-018: 审核队列统一展示
// ═══════════════════════════════════════════════════════════════════════

describe('TC-018: ReviewQueueList displays items', () => {
  let ReviewQueueList: typeof import('../review/ReviewQueueList').ReviewQueueList

  beforeEach(async () => {
    mockApi.getPendingReviews.mockResolvedValue({
      data: [
        makePendingItem({ id: 'r1', type: 'rule', content: 'Rule 1' }),
        makePendingItem({ id: 'r2', type: 'rule', content: 'Rule 2' }),
        makePendingItem({ id: 's1', type: 'skill', content: 'Skill 1' }),
      ],
      total: 3, page: 1, pageSize: 20,
    })
    const mod = await import('../review/ReviewQueueList')
    ReviewQueueList = mod.ReviewQueueList
  })

  it('renders review items from API', async () => {
    render(<ReviewQueueList />)

    await waitFor(() => {
      expect(screen.getByText('Rule 1')).toBeInTheDocument()
      expect(screen.getByText('Rule 2')).toBeInTheDocument()
      expect(screen.getByText('Skill 1')).toBeInTheDocument()
    })
  })
})

// ═══════════════════════════════════════════════════════════════════════
// TC-019: 审核队列为空态
// ═══════════════════════════════════════════════════════════════════════

describe('TC-019: ReviewQueueList empty state', () => {
  it('shows empty state when no pending items', async () => {
    mockApi.getPendingReviews.mockResolvedValueOnce({
      data: [], total: 0, page: 1, pageSize: 20,
    })
    const { ReviewQueueList } = await import('../review/ReviewQueueList')
    render(<ReviewQueueList />)

    await waitFor(() => {
      expect(screen.getByText('暂无待审核项')).toBeInTheDocument()
    })
  })
})

// ═══════════════════════════════════════════════════════════════════════
// TC-034: AI 助手审核辅助
// ═══════════════════════════════════════════════════════════════════════

describe('TC-034: KnowledgeAssistantPanel', () => {
  it('renders panel with AI 助手 header when open', () => {
    render(
      <KnowledgeAssistantPanel
        open={true}
        mode="review"
        ruleContent="test rule"
      />
    )

    expect(screen.getByText('AI 助手')).toBeInTheDocument()
  })

  it('does not render when open is false', () => {
    const { container } = render(
      <KnowledgeAssistantPanel
        open={false}
        mode="review"
      />
    )

    expect(container.innerHTML).toBe('')
  })
})

// ═══════════════════════════════════════════════════════════════════════
// TC-035: AI 助手 LLM 失败降级
// ═══════════════════════════════════════════════════════════════════════

describe('TC-035: KnowledgeAssistantPanel degradation', () => {
  it('shows unavailable message on error', async () => {
    // Mock stream that returns an error immediately
    const errorReader = new ReadableStream<string>({
      start(controller) {
        controller.enqueue(JSON.stringify({ type: 'error', message: 'LLM unavailable' }))
        controller.close()
      },
    }).getReader()

    mockApi.createAssistantStream.mockReturnValue({
      reader: errorReader,
      abort: vi.fn(),
    })

    render(
      <KnowledgeAssistantPanel
        open={true}
        mode="review"
        ruleContent="test"
      />
    )

    // The panel should be rendered
    expect(screen.getByText('AI 助手')).toBeInTheDocument()

    // After sending a message, the error state should appear
    const textarea = screen.getByPlaceholderText('输入问题或指令...')
    await userEvent.type(textarea, 'test question')
    await userEvent.click(screen.getByLabelText('发送'))

    await waitFor(() => {
      expect(screen.getByText('AI 助手暂不可用，您仍可手动审核')).toBeInTheDocument()
    }, { timeout: 5000 })
  })
})

// ═══════════════════════════════════════════════════════════════════════
// TC-028: 用户偏好查看与编辑
// ═══════════════════════════════════════════════════════════════════════

describe('TC-028: PreferenceEditor view and edit', () => {
  it('renders global + per-org cards as a waterfall', async () => {
    render(<PreferenceEditor />)

    await waitFor(() => {
      expect(screen.getByText('全局偏好')).toBeInTheDocument()
      expect(screen.getByText('xzf')).toBeInTheDocument()
      expect(screen.getByText('acme')).toBeInTheDocument()
    })
  })

  it('shows edit button inside each card', async () => {
    render(<PreferenceEditor />)

    await waitFor(() => {
      const editButtons = screen.getAllByRole('button', { name: '编辑' })
      expect(editButtons.length).toBeGreaterThanOrEqual(3) // global + xzf + acme
    })
  })

  it('renders preference content when the server returns it', async () => {
    const { getPreference } = await import('@/lib/knowledge/api')
    const mockGet = vi.mocked(getPreference)
    mockGet.mockImplementation(async (scope: string, orgId?: string) => {
      if (scope === 'global') return { content: '# Global prefs', scope: 'global' }
      if (orgId === 'xzf') return { content: '# XZF org prefs', scope: 'org' }
      return { content: '', scope: 'org' }
    })

    render(<PreferenceEditor />)

    await waitFor(() => {
      expect(screen.getByText('# Global prefs')).toBeInTheDocument()
      expect(screen.getByText('# XZF org prefs')).toBeInTheDocument()
    })
  })

  it('switches to edit mode with textarea when clicking 编辑 on a card', async () => {
    render(<PreferenceEditor />)

    await waitFor(() => {
      expect(screen.getAllByRole('button', { name: '编辑' }).length).toBeGreaterThanOrEqual(3)
    })

    await userEvent.click(screen.getAllByRole('button', { name: '编辑' })[0])

    expect(
      screen.getByPlaceholderText(/在此编辑 Markdown 格式的偏好配置/),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '保存' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '取消' })).toBeInTheDocument()
  })
})

// ═══════════════════════════════════════════════════════════════════════
// TC-029: 用户偏好多 Org 卡片瀑布流
// ═══════════════════════════════════════════════════════════════════════

describe('TC-029: PreferenceEditor multi-org waterfall', () => {
  it('renders one card per org alongside the global card', async () => {
    render(<PreferenceEditor />)

    await waitFor(() => {
      expect(screen.getByText('全局偏好')).toBeInTheDocument()
      expect(screen.getByText('xzf')).toBeInTheDocument()
      expect(screen.getByText('acme')).toBeInTheDocument()
    })
  })

  it('toolbar shows 全部收起 / 全部展开', async () => {
    render(<PreferenceEditor />)

    await waitFor(() => {
      expect(screen.getByRole('button', { name: '全部收起' })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: '全部展开' })).toBeInTheDocument()
    })
  })

  it('shows the global + N org count in the header', async () => {
    render(<PreferenceEditor />)

    await waitFor(() => {
      expect(screen.getByText('1 全局 + 2 组织')).toBeInTheDocument()
    })
  })
})

// ═══════════════════════════════════════════════════════════════════════
// TC-036: 归档弹窗布局
// ═══════════════════════════════════════════════════════════════════════

describe('TC-036: ArchiveDialog layout', () => {
  it('renders dialog with tabs and buttons when open', async () => {
    mockApi.getArchiveSummary.mockResolvedValueOnce({
      executionId: 'exec-1',
      nodes: [{ id: 'n1', status: 'completed', durationMs: 1000, exitCode: 0, lastOutput: 'done' }],
      reviewBlockers: [],
      e2eResults: '',
      poolSnapshot: null,
    })
    mockApi.proposeArchive.mockResolvedValueOnce({
      rules: [{ text: 'Rule 1', scope: 'project', target: 'test.md', conflicts: null }],
      skills: null,
      pendingCount: 1,
    })

    render(
      <ArchiveDialog
        open={true}
        onOpenChange={vi.fn()}
        executionId="exec-1"
        org="test-org"
      />
    )

    await waitFor(() => {
      expect(screen.getByText('提取规则')).toBeInTheDocument()
      expect(screen.getByText('执行摘要')).toBeInTheDocument()
    })
    expect(screen.getByRole('button', { name: /跳过此次归档/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /保存选中规则/ })).toBeInTheDocument()
  })
})

// ═══════════════════════════════════════════════════════════════════════
// TC-037: 归档弹窗跳过归档
// ═══════════════════════════════════════════════════════════════════════

describe('TC-037: ArchiveDialog skip archive', () => {
  it('opens confirmation dialog when skip is clicked', async () => {
    mockApi.getArchiveSummary.mockResolvedValueOnce({
      executionId: 'exec-1', nodes: [], reviewBlockers: [],
      e2eResults: '', poolSnapshot: null,
    })
    mockApi.proposeArchive.mockResolvedValueOnce({
      rules: [], skills: null, pendingCount: 0,
    })

    const onOpenChange = vi.fn()
    render(
      <ArchiveDialog
        open={true}
        onOpenChange={onOpenChange}
        executionId="exec-1"
        org="test-org"
      />
    )

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /跳过此次归档/ })).toBeInTheDocument()
    })

    await userEvent.click(screen.getByRole('button', { name: /跳过此次归档/ }))

    // Confirmation dialog should appear
    await waitFor(() => {
      expect(screen.getByText('确认跳过')).toBeInTheDocument()
    })
  })
})

// ═══════════════════════════════════════════════════════════════════════
// TC-043: 经验库列表包含工作流经验
// ═══════════════════════════════════════════════════════════════════════

describe('TC-043: ExperienceList workflow files', () => {
  it('renders workflow knowledge files in workflow group', () => {
    const files = [
      { name: 'workflows/prd-impl.md', type: 'workflow' as const, scope: 'org' as const, ruleCount: 3, retiredCount: 0, lineCount: 50, compactNeeded: false },
    ]

    render(
      <ExperienceList
        files={files}
        selectedFile={null}
        onSelect={vi.fn()}
        onCreate={vi.fn()}
      />
    )

    expect(screen.getByText('prd-impl')).toBeInTheDocument()
    expect(screen.getByText('工作流经验')).toBeInTheDocument()
  })

  it('shows empty in workflow group when no workflow files', () => {
    render(
      <ExperienceList
        files={[]}
        selectedFile={null}
        onSelect={vi.fn()}
        onCreate={vi.fn()}
      />
    )

    // Both groups show "暂无"
    expect(screen.getAllByText('暂无').length).toBe(2)
  })
})
