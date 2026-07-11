// Swarm UI Components — Public API
//
// 追溯矩阵 (页面ID × STORY-X × TC-Y):
//   P1 × US-07 × TC-023: SwarmNode (DAG 流程图 swarm 节点视觉区分)
//   P2 × US-07 × TC-024: SwarmDetailDialog (5 Tab 弹窗切换)
//   P2 × US-07 × TC-025: MessageTimelineTab (SSE expert_message 2s 内追加)
//   P2 × US-07 × TC-026: SwarmDetailDialog (回放模式 Badge)
//   P3 × US-07 × TC-023: SwarmSummaryRow (执行列表 swarm 摘要行)
//   P2 × US-01 × TC-001: ExpertListTab (review 3 专家并行展示)
//   P2 × US-02 × TC-005: ConsensusChartTab (共识度曲线 + 阈值线)
//   P2 × US-03 × TC-008: InternalDagTab (dispatch DAG 分层可视化)
//   P2 × US-04 × TC-011: RouterDecisionCard (Router 推理链展示)
//   P2 × US-09 × TC-029: TokenBar / MetricCard (预算 90% 预警)
//   P2 × US-10 × TC-031: ExpertRow source 标记 (predefined/dynamic)
//   P2 × US-14 × TC-037: HostReportTab hostDegraded 横幅
//   P2 × US-15 × TC-039: ExpertRow failed/skipped 状态
//   P5.10 × R-28 × TC-P1-005: StatsDashboard (swarm 执行统计)
//
//   ── MOA Swarm Mode ──
//   P1 × STORY-2.4.1 × TC-016: MoaConfigPanel (MOA 节点配置面板)
//   P2 × STORY-2.4.1 × TC-017: MoaConfigPanel (experts<2 保存禁用)
//   P4 × STORY-2.4.2 × TC-018: ModelResolveBadge (模型解析三态)
//   P5 × STORY-2.4.3 × TC-019: YamlSyncModal (YAML 导出 + 复制)
//   P5 × STORY-2.4.3 × TC-020: YamlSyncModal (YAML 导入错误行号)
//   P7 × STORY-2.5.1 × TC-021: MoaResultTab (五态 + 三栏布局)
//   P7 × STORY-2.5.1 × TC-022: MoaResultTab (部分 expert 失败)
//   P8 × STORY-2.5.2 × TC-023: MoaResultTab compare (并排对比)
//   P7 × STORY-2.5.1 × TC-028: MoaResultTab Collapsible (展开全部)
//   P1 × STORY-2.1.1 × TC-001: SwarmBadge mode="moa" (靛蓝紫)

// Types
export type {
  SwarmMode,
  ExpertStatus,
  SwarmStatus,
  ExpertInfo,
  SwarmMessage,
  ConsensusDataPoint,
  RouterDecision,
  TaskBreakdown,
  FileConflict,
  SwarmStatsResponse,
  ExpertSpawnEvent,
  ExpertMessageEvent,
  ExpertCompleteEvent,
  ConsensusCheckEvent,
  SwarmRoundEndEvent,
  SwarmCompleteEvent,
} from "@/lib/swarm-types"

// Atoms
export { SwarmBadge } from "./atoms/swarm-badge"
export type { SwarmBadgeProps } from "./atoms/swarm-badge"

export { ExpertAvatar } from "./atoms/expert-avatar"
export type { ExpertAvatarProps } from "./atoms/expert-avatar"

export { StatusDot } from "./atoms/status-dot"
export type { StatusDotProps } from "./atoms/status-dot"

export { MetricCard } from "./atoms/metric-card"
export type { MetricCardProps } from "./atoms/metric-card"

export { RoundDivider } from "./atoms/round-divider"
export type { RoundDividerProps } from "./atoms/round-divider"

export { AlertBanner } from "./atoms/alert-banner"
export type { AlertBannerProps } from "./atoms/alert-banner"

export { TokenBar } from "./atoms/token-bar"
export type { TokenBarProps } from "./atoms/token-bar"

// Molecules
export { ExpertRow } from "./molecules/expert-row"
export type { ExpertRowProps } from "./molecules/expert-row"

export { MessageBubble } from "./molecules/message-bubble"
export type { MessageBubbleProps } from "./molecules/message-bubble"

export { DispatchDagNode } from "./molecules/dispatch-dag-node"
export type { DispatchDagNodeData } from "./molecules/dispatch-dag-node"

export { SwarmHeaderBar } from "./molecules/swarm-header-bar"
export type { SwarmHeaderBarProps } from "./molecules/swarm-header-bar"

export { SwarmSummaryRow } from "./molecules/swarm-summary-row"
export type { SwarmSummaryRowProps } from "./molecules/swarm-summary-row"

export { RouterDecisionCard } from "./molecules/router-decision-card"
export type { RouterDecisionCardProps } from "./molecules/router-decision-card"

// Organisms
export { SwarmDetailDialog } from "./organisms/swarm-detail-dialog"
export type { SwarmDetailDialogProps } from "./organisms/swarm-detail-dialog"

export { ExpertListTab } from "./organisms/expert-list-tab"
export type { ExpertListTabProps } from "./organisms/expert-list-tab"

export { MessageTimelineTab } from "./organisms/message-timeline-tab"
export type { MessageTimelineTabProps } from "./organisms/message-timeline-tab"

export { ConsensusChartTab } from "./organisms/consensus-chart-tab"
export type { ConsensusChartTabProps } from "./organisms/consensus-chart-tab"

export { InternalDagTab } from "./organisms/internal-dag-tab"
export type { InternalDagTabProps } from "./organisms/internal-dag-tab"

export { HostReportTab } from "./organisms/host-report-tab"
export type { HostReportTabProps } from "./organisms/host-report-tab"

export { SwarmDialogSkeleton } from "./organisms/swarm-dialog-skeleton"

export { SwarmNode } from "./organisms/swarm-node"
export type { SwarmNodeData } from "./organisms/swarm-node"

// MOA components
export { ModelResolveBadge } from "./atoms/model-resolve-badge"
export type { ModelResolveBadgeProps } from "./atoms/model-resolve-badge"

export { MoaConfigPanel } from "./organisms/moa-config-panel"
export type { MoaConfigPanelProps } from "./organisms/moa-config-panel"

export { MoaResultTab } from "./organisms/moa-result-tab"

export { YamlSyncModal } from "./molecules/yaml-sync-modal"
export type { YamlSyncModalProps } from "./molecules/yaml-sync-modal"

// Stats
export { StatsDashboard } from "./stats-dashboard"
export type { StatsDashboardProps } from "./stats-dashboard"
