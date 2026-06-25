import {
  Terminal,
  Code2,
  Bot,
  GitBranch,
  ShieldCheck,
  Repeat,
  Network,
  type LucideIcon,
} from "lucide-react"

export interface NodeIconConfig {
  icon: LucideIcon
  color: string
  bgColor: string
  borderColor: string
  label: string
}

export const nodeIconConfigs: Record<string, NodeIconConfig> = {
  bash: {
    icon: Terminal,
    color: "text-green-600",
    bgColor: "bg-green-50",
    borderColor: "border-green-200",
    label: "Bash",
  },
  python: {
    icon: Code2,
    color: "text-blue-600",
    bgColor: "bg-blue-50",
    borderColor: "border-blue-200",
    label: "Python",
  },
  agent: {
    icon: Bot,
    color: "text-purple-600",
    bgColor: "bg-purple-50",
    borderColor: "border-purple-200",
    label: "Agent",
  },
  condition: {
    icon: GitBranch,
    color: "text-amber-600",
    bgColor: "bg-amber-50",
    borderColor: "border-amber-200",
    label: "Condition",
  },
  approval: {
    icon: ShieldCheck,
    color: "text-emerald-600",
    bgColor: "bg-emerald-50",
    borderColor: "border-emerald-200",
    label: "Approval",
  },
  loop: {
    icon: Repeat,
    color: "text-orange-600",
    bgColor: "bg-orange-50",
    borderColor: "border-orange-200",
    label: "Loop",
  },
  swarm: {
    icon: Network,
    color: "text-cyan-600",
    bgColor: "bg-cyan-50",
    borderColor: "border-cyan-200",
    label: "Swarm",
  },
}