import {
  Terminal,
  Code2,
  Bot,
  GitBranch,
  ShieldCheck,
  Repeat,
  Network,
  MessageCircle,
  Workflow,
  Sparkles,
  type LucideIcon,
} from "lucide-react"

export interface NodeIconConfig {
  icon: LucideIcon
  color: string
  bgColor: string
  borderColor: string
  label: string
}

// 🎪 波普贴纸配色:pop 家族只有 6 个色相,类型间允许邻近合族;
// loop 用墨色图标 + 黄贴片保证可读性(text-yellow 在白纸上不可读)。
export const nodeIconConfigs: Record<string, NodeIconConfig> = {
  bash: {
    icon: Terminal,
    color: "text-pop-green",
    bgColor: "bg-pop-green-soft",
    borderColor: "border-pop-green/30",
    label: "Bash",
  },
  python: {
    icon: Code2,
    color: "text-pop-cyan",
    bgColor: "bg-pop-cyan-soft",
    borderColor: "border-pop-cyan/30",
    label: "Python",
  },
  agent: {
    icon: Bot,
    color: "text-pop-purple",
    bgColor: "bg-pop-purple-soft",
    borderColor: "border-pop-purple/30",
    label: "Agent",
  },
  condition: {
    icon: GitBranch,
    color: "text-pop-amber",
    bgColor: "bg-pop-amber-soft",
    borderColor: "border-pop-amber/30",
    label: "Condition",
  },
  approval: {
    icon: ShieldCheck,
    color: "text-pop-green",
    bgColor: "bg-pop-green-soft",
    borderColor: "border-pop-green/30",
    label: "Approval",
  },
  loop: {
    icon: Repeat,
    color: "text-pop-ink",
    bgColor: "bg-pop-yellow-soft",
    borderColor: "border-pop-yellow/40",
    label: "Loop",
  },
  swarm: {
    icon: Network,
    color: "text-pop-cyan",
    bgColor: "bg-pop-cyan-soft",
    borderColor: "border-pop-cyan/30",
    label: "Swarm",
  },
  interaction: {
    icon: MessageCircle,
    color: "text-pop-purple",
    bgColor: "bg-pop-purple-soft",
    borderColor: "border-pop-purple/30",
    label: "Interaction",
  },
  sub_workflow: {
    icon: Workflow,
    color: "text-pop-purple",
    bgColor: "bg-pop-purple-soft",
    borderColor: "border-pop-purple/30",
    label: "Sub Workflow",
  },
  dynamic_sub_workflow: {
    icon: Sparkles,
    color: "text-pop-pink",
    bgColor: "bg-pop-pink-soft",
    borderColor: "border-pop-pink/30",
    label: "Dynamic DAG",
  },
  octopus_agent: {
    icon: Bot,
    color: "text-pop-red",
    bgColor: "bg-pop-pink-soft",
    borderColor: "border-pop-red/30",
    label: "Octopus Agent",
  },
}
