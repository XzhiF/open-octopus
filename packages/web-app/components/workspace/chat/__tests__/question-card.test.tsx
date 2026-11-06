import { describe, it, expect, vi } from "vitest"
import { render, screen, act } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { QuestionCard } from "../question-card"

vi.mock("@/lib/utils", () => ({
  cn: (...args: string[]) => args.filter(Boolean).join(" "),
}))

const singleSelectQuestions = {
  questions: [
    {
      question: "你希望创建什么类型的 YAML 文件？",
      header: "YAML 类型",
      multiSelect: false,
      options: [
        { label: "工作流定义", description: "定义自动化任务流程" },
        { label: "CI/CD 流水线", description: "GitHub Actions CI/CD 流程配置" },
        { label: "项目编排配置", description: "指定项目间的操作顺序" },
      ],
    },
  ],
}

const multiSelectQuestions = {
  questions: [
    {
      question: "你希望开启哪些功能？",
      header: "功能选择",
      multiSelect: true,
      options: [
        { label: "自动保存", description: "" },
        { label: "邮件通知", description: "" },
        { label: "日志记录", description: "" },
      ],
    },
  ],
}

const multipleQuestions = {
  questions: [
    {
      question: "选择类型",
      header: "类型",
      multiSelect: false,
      options: [
        { label: "A", description: "选项 A" },
        { label: "B", description: "选项 B" },
      ],
    },
    {
      question: "选择功能",
      header: "功能",
      multiSelect: true,
      options: [
        { label: "X", description: "" },
        { label: "Y", description: "" },
      ],
    },
  ],
}

function makeMessage(toolInput: unknown, overrides?: Record<string, unknown>) {
  return {
    id: "msg-1",
    sessionId: "s-1",
    role: "assistant" as const,
    displayType: "ask_user_question" as const,
    content: "",
    toolCallId: "tool-1",
    toolName: "AskUserQuestion",
    toolInput,
    toolStatus: "done" as const,
    timestamp: new Date().toISOString(),
    ...overrides,
  }
}

describe("QuestionCard", () => {
  describe("preparing phase (disabled=true)", () => {
    it("shows spinner when no questions loaded yet", () => {
      render(
        <QuestionCard
          message={makeMessage(undefined, { displayType: "tool_call", toolStatus: "running" })}
          onAnswer={vi.fn()}
          disabled={true}
        />
      )

      expect(screen.getByText("正在准备问题…")).toBeInTheDocument()
      // Should not show question content
      expect(screen.queryByText("YAML 类型")).not.toBeInTheDocument()
    })

    it("shows preview with question titles when questions loaded but streaming", () => {
      render(
        <QuestionCard
          message={makeMessage(singleSelectQuestions, { displayType: "tool_call", toolStatus: "done" })}
          onAnswer={vi.fn()}
          disabled={true}
        />
      )

      expect(screen.getByText("正在准备问题…")).toBeInTheDocument()
      expect(screen.getByText("YAML 类型")).toBeInTheDocument()
      expect(screen.getByText("你希望创建什么类型的 YAML 文件？")).toBeInTheDocument()
      expect(screen.getByText("··· 即将展开")).toBeInTheDocument()
      // Options NOT in DOM during preparing — can't be interacted with
      expect(screen.queryByRole("radio")).not.toBeInTheDocument()
      expect(screen.queryByText("提交答案")).not.toBeInTheDocument()
    })

    it("uses the paper card tint throughout preparing phase (2026-11-06)", () => {
      const { container } = render(
        <QuestionCard
          message={makeMessage(singleSelectQuestions, { displayType: "tool_call" })}
          onAnswer={vi.fn()}
          disabled={true}
        />
      )

      const card = container.querySelector("[class*='bg-pop-paper']")
      expect(card).toBeInTheDocument()
      expect(container.querySelector("[class*='bg-pop-green-soft']")).not.toBeInTheDocument()
    })
  })

  describe("ready phase (disabled=false)", () => {
    it("renders single-select question with radio buttons + built-in Other", () => {
      render(<QuestionCard message={makeMessage(singleSelectQuestions)} onAnswer={vi.fn()} />)

      expect(screen.getByText("AI 想要确认以下问题")).toBeInTheDocument()
      expect(screen.getByText("YAML 类型")).toBeInTheDocument()
      expect(screen.getByText("你希望创建什么类型的 YAML 文件？")).toBeInTheDocument()
      expect(screen.getByText("工作流定义")).toBeInTheDocument()
      expect(screen.getByText("CI/CD 流水线")).toBeInTheDocument()

      // 3 个模型选项 + 恒带的「其他」（2026-11-06 对齐 CLI）
      const radios = screen.getAllByRole("radio")
      expect(radios).toHaveLength(4)
      expect(screen.getByText("其他")).toBeInTheDocument()
    })

    it("renders multi-select question with checkboxes + built-in Other", () => {
      render(<QuestionCard message={makeMessage(multiSelectQuestions)} onAnswer={vi.fn()} />)

      expect(screen.getByText("功能选择")).toBeInTheDocument()
      expect(screen.getByText("（多选）")).toBeInTheDocument()

      const checkboxes = screen.getAllByRole("checkbox")
      expect(checkboxes).toHaveLength(4)
    })

    it("renders multiple questions in order", () => {
      render(<QuestionCard message={makeMessage(multipleQuestions)} onAnswer={vi.fn()} />)

      expect(screen.getByText("类型")).toBeInTheDocument()
      expect(screen.getByText("功能")).toBeInTheDocument()

      // 每题各带一个「其他」
      const radioInputs = screen.getAllByRole("radio")
      expect(radioInputs).toHaveLength(3)

      const checkboxes = screen.getAllByRole("checkbox")
      expect(checkboxes).toHaveLength(3)
    })

    it("keeps submit button disabled when not all questions answered", () => {
      render(<QuestionCard message={makeMessage(multipleQuestions)} onAnswer={vi.fn()} />)

      const button = screen.getByText("提交答案")
      expect(button).toBeDisabled()
      expect(screen.getByText("请回答所有问题")).toBeInTheDocument()
    })

    it("calls onAnswer with formatted content when submitted", async () => {
      const onAnswer = vi.fn()
      const user = userEvent.setup()
      render(<QuestionCard message={makeMessage(singleSelectQuestions)} onAnswer={onAnswer} />)

      await user.click(screen.getByText("工作流定义"))
      await user.click(screen.getByText("提交答案"))

      expect(onAnswer).toHaveBeenCalledTimes(1)
      const content = onAnswer.mock.calls[0][0] as string
      expect(content).toContain("用户回答了以下问题")
      expect(content).toContain("YAML 类型")
      expect(content).toContain("工作流定义")
    })

    it("submits an Other-only answer for a multi-select question (2026-11-06 对齐 CLI)", async () => {
      const onAnswer = vi.fn()
      const user = userEvent.setup()
      render(<QuestionCard message={makeMessage(multiSelectQuestions)} onAnswer={onAnswer} />)

      // 一个普通选项都不勾，只勾「其他」并输入 —— 也必须能提交。
      await user.click(screen.getByLabelText(/其他/))
      await user.type(screen.getByTestId("aq-other-input-0"), "以上都不合适，按周报的格式来")
      await user.click(screen.getByText("提交答案"))

      const content = onAnswer.mock.calls[0][0] as string
      expect(content).toContain("以上都不合适，按周报的格式来")
    })

    it("combines selected options with the Other text in multi-select", async () => {
      const onAnswer = vi.fn()
      const user = userEvent.setup()
      render(<QuestionCard message={makeMessage(multiSelectQuestions)} onAnswer={onAnswer} />)

      await user.click(screen.getByText("自动保存"))
      await user.click(screen.getByText("日志记录"))
      await user.click(screen.getByLabelText(/其他/))
      await user.type(screen.getByTestId("aq-other-input-0"), "再加一个每日汇总")
      await user.click(screen.getByText("提交答案"))

      const content = onAnswer.mock.calls[0][0] as string
      expect(content).toContain("自动保存, 日志记录, 再加一个每日汇总")
    })

    it("uses the Other input as the answer for single-select", async () => {
      const onAnswer = vi.fn()
      const user = userEvent.setup()
      render(<QuestionCard message={makeMessage(singleSelectQuestions)} onAnswer={onAnswer} />)

      await user.click(screen.getByLabelText(/其他/))
      await user.type(screen.getByTestId("aq-other-input-0"), "放到独立服务里")
      await user.click(screen.getByText("提交答案"))

      const content = onAnswer.mock.calls[0][0] as string
      expect(content).toContain("→ 放到独立服务里")
    })

    it("sends a clarifying message via Chat about this instead of answering", async () => {
      const onAnswer = vi.fn()
      const user = userEvent.setup()
      render(<QuestionCard message={makeMessage(singleSelectQuestions)} onAnswer={onAnswer} />)

      await user.click(screen.getByTestId("aq-chat-about"))
      expect(onAnswer).toHaveBeenCalledTimes(1)
      const content = onAnswer.mock.calls[0][0] as string
      expect(content).toContain("用户想先讨论这些问题")
      expect(content).toContain("你希望创建什么类型的 YAML 文件？")
      // 不是答案提交
      expect(content).not.toContain("用户回答了以下问题")
    })

    it("does not show Chat about this for a multi-select-only card", () => {
      render(<QuestionCard message={makeMessage(multiSelectQuestions)} onAnswer={vi.fn()} />)
      expect(screen.queryByTestId("aq-chat-about")).not.toBeInTheDocument()
    })

    it("does not require an answer note to submit a normal selection", async () => {
      const onAnswer = vi.fn()
      const user = userEvent.setup()
      render(<QuestionCard message={makeMessage(singleSelectQuestions)} onAnswer={onAnswer} />)

      await user.click(screen.getByText("工作流定义"))
      await user.click(screen.getByText("提交答案"))

      expect(onAnswer).toHaveBeenCalledTimes(1)
      expect(onAnswer.mock.calls[0][0] as string).not.toContain("补充")
    })

    it("shows question descriptions next to option labels", () => {
      render(<QuestionCard message={makeMessage(singleSelectQuestions)} onAnswer={vi.fn()} />)

      expect(screen.getByText(/定义自动化任务流程/)).toBeInTheDocument()
      expect(screen.getByText(/GitHub Actions CI\/CD 流程配置/)).toBeInTheDocument()
    })

    it("shows empty state for missing questions", () => {
      render(<QuestionCard message={makeMessage(null)} onAnswer={vi.fn()} />)

      expect(screen.getByText("无法解析问题数据")).toBeInTheDocument()
    })
  })

  describe("answered phase", () => {
    it("disables all inputs after submission", async () => {
      const user = userEvent.setup()
      render(<QuestionCard message={makeMessage(singleSelectQuestions)} onAnswer={vi.fn()} />)

      await user.click(screen.getByText("工作流定义"))
      await user.click(screen.getByText("提交答案"))

      const radios = screen.getAllByRole("radio")
      radios.forEach((r) => expect(r).toBeDisabled())
      expect(screen.getByText("答案已提交")).toBeInTheDocument()
    })

    it("transitions sticker tint to green after submission", async () => {
      const { container } = render(
        <QuestionCard message={makeMessage(singleSelectQuestions)} onAnswer={vi.fn()} />
      )

      // Initially the normal card background (paper, 2026-11-06)
      expect(container.querySelector("[class*='bg-pop-paper']")).toBeInTheDocument()

      const user = userEvent.setup()
      await user.click(screen.getByText("工作流定义"))
      await user.click(screen.getByText("提交答案"))

      // After submission, green-soft sticker
      expect(container.querySelector("[class*='bg-pop-green-soft']")).toBeInTheDocument()
    })

    it("shows answered header after submission", async () => {
      const user = userEvent.setup()
      render(<QuestionCard message={makeMessage(singleSelectQuestions)} onAnswer={vi.fn()} />)

      await user.click(screen.getByText("工作流定义"))
      await user.click(screen.getByText("提交答案"))

      expect(screen.getByText("已回答")).toBeInTheDocument()
      expect(screen.queryByText("AI 想要确认以下问题")).not.toBeInTheDocument()
    })
  })

  describe("phase transitions (morphing)", () => {
    it("stays preparing after stream ends, then expands after delay", async () => {
      const { rerender } = render(
        <QuestionCard
          message={makeMessage(singleSelectQuestions, { displayType: "tool_call", toolStatus: "done" })}
          onAnswer={vi.fn()}
          disabled={true}
        />
      )

      // Preparing state: preview visible, options NOT in DOM
      expect(screen.getByText("正在准备问题…")).toBeInTheDocument()
      expect(screen.getByText("··· 即将展开")).toBeInTheDocument()
      expect(screen.queryByRole("radio")).not.toBeInTheDocument()
      expect(screen.queryByText("提交答案")).not.toBeInTheDocument()

      // Stream ends (disabled → false): card stays preparing for 300ms
      rerender(
        <QuestionCard
          message={makeMessage(singleSelectQuestions, { displayType: "ask_user_question", toolStatus: "done" })}
          onAnswer={vi.fn()}
          disabled={false}
        />
      )

      // Immediately after stream end — still preparing (green status bar is visible)
      expect(screen.getByText("正在准备问题…")).toBeInTheDocument()

      // After the 300ms expansion delay — card fully interactive
      await act(async () => {
        await new Promise(r => setTimeout(r, 400))
      })

      expect(screen.getByText("AI 想要确认以下问题")).toBeInTheDocument()
      expect(screen.queryByText("正在准备问题…")).not.toBeInTheDocument()
      expect(screen.getAllByRole("radio")).toHaveLength(4)
      expect(screen.getByText("提交答案")).toBeInTheDocument()
    })

    it("does not delay when starting directly in ready phase (loaded from DB)", () => {
      // When loading a previously completed AskUserQuestion from DB,
      // disabled starts as false — no morphing delay
      render(
        <QuestionCard
          message={makeMessage(singleSelectQuestions)}
          onAnswer={vi.fn()}
          disabled={false}
        />
      )

      // Should immediately show ready state, no preparing delay
      expect(screen.getByText("AI 想要确认以下问题")).toBeInTheDocument()
      expect(screen.getAllByRole("radio")).toHaveLength(4)
    })
  })
})