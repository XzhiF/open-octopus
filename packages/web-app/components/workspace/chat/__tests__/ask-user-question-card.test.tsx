import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AskUserQuestionCard } from '../ask-user-question-card'

vi.mock('@/lib/utils', () => ({
  cn: (...args: string[]) => args.filter(Boolean).join(' '),
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

function makeMessage(toolInput: unknown) {
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
  }
}

describe("AskUserQuestionCard", () => {
  it("renders single-select question with radio buttons", () => {
    render(<AskUserQuestionCard message={makeMessage(singleSelectQuestions)} onAnswer={vi.fn()} />)

    expect(screen.getByText("AI 想要确认以下问题")).toBeInTheDocument()
    expect(screen.getByText("YAML 类型")).toBeInTheDocument()
    expect(screen.getByText("你希望创建什么类型的 YAML 文件？")).toBeInTheDocument()
    expect(screen.getByText("工作流定义")).toBeInTheDocument()
    expect(screen.getByText("CI/CD 流水线")).toBeInTheDocument()

    // All options should be radio inputs
    const radios = screen.getAllByRole("radio")
    expect(radios).toHaveLength(3)
  })

  it("renders multi-select question with checkboxes", () => {
    render(<AskUserQuestionCard message={makeMessage(multiSelectQuestions)} onAnswer={vi.fn()} />)

    expect(screen.getByText("功能选择")).toBeInTheDocument()
    expect(screen.getByText("（多选）")).toBeInTheDocument()

    const checkboxes = screen.getAllByRole("checkbox")
    expect(checkboxes).toHaveLength(3)
  })

  it("renders multiple questions in order", () => {
    render(<AskUserQuestionCard message={makeMessage(multipleQuestions)} onAnswer={vi.fn()} />)

    // Check header badges specifically
    const typeBadge = screen.getByText("类型")
    const funcBadge = screen.getByText("功能")
    expect(typeBadge).toBeInTheDocument()
    expect(funcBadge).toBeInTheDocument()

    const radioInputs = screen.getAllByRole("radio")
    expect(radioInputs).toHaveLength(2)

    const checkboxes = screen.getAllByRole("checkbox")
    expect(checkboxes).toHaveLength(2)
  })

  it("selects a single-select option and updates state", async () => {
    const user = userEvent.setup()
    render(<AskUserQuestionCard message={makeMessage(singleSelectQuestions)} onAnswer={vi.fn()} />)

    const option = screen.getByText("工作流定义")
    await user.click(option)

    const radio = screen.getByLabelText(/工作流定义/)
    expect(radio.getAttribute("data-state")).toBe("checked")
  })

  it("selects multiple options for multi-select", async () => {
    const user = userEvent.setup()
    render(<AskUserQuestionCard message={makeMessage(multiSelectQuestions)} onAnswer={vi.fn()} />)

    await user.click(screen.getByText("自动保存"))
    await user.click(screen.getByText("日志记录"))

    expect(screen.getByLabelText(/自动保存/).getAttribute("data-state")).toBe("checked")
    expect(screen.getByLabelText(/日志记录/).getAttribute("data-state")).toBe("checked")
    expect(screen.getByLabelText(/邮件通知/).getAttribute("data-state")).toBe("unchecked")
  })

  it("keeps submit button disabled when not all questions answered", () => {
    render(<AskUserQuestionCard message={makeMessage(multipleQuestions)} onAnswer={vi.fn()} />)

    const button = screen.getByText("提交答案")
    expect(button).toBeDisabled()
    expect(screen.getByText("请回答所有问题")).toBeInTheDocument()
  })

  it("calls onAnswer with formatted content when submitted", async () => {
    const onAnswer = vi.fn()
    const user = userEvent.setup()
    render(<AskUserQuestionCard message={makeMessage(singleSelectQuestions)} onAnswer={onAnswer} />)

    await user.click(screen.getByText("工作流定义"))
    await user.click(screen.getByText("提交答案"))

    expect(onAnswer).toHaveBeenCalledTimes(1)
    const content = onAnswer.mock.calls[0][0] as string
    expect(content).toContain("用户回答了以下问题")
    expect(content).toContain("YAML 类型")
    expect(content).toContain("工作流定义")
  })

  it("disables all inputs after submission", async () => {
    const user = userEvent.setup()
    render(<AskUserQuestionCard message={makeMessage(singleSelectQuestions)} onAnswer={vi.fn()} />)

    await user.click(screen.getByText("工作流定义"))
    await user.click(screen.getByText("提交答案"))

    const radios = screen.getAllByRole("radio")
    radios.forEach(r => expect(r).toBeDisabled())
    expect(screen.getByText("答案已提交")).toBeInTheDocument()
  })

  it("shows empty state for missing questions", () => {
    render(<AskUserQuestionCard message={makeMessage(null)} onAnswer={vi.fn()} />)

    expect(screen.getByText("无法解析问题数据")).toBeInTheDocument()
  })

  it("shows question descriptions next to option labels", () => {
    render(<AskUserQuestionCard message={makeMessage(singleSelectQuestions)} onAnswer={vi.fn()} />)

    expect(screen.getByText(/定义自动化任务流程/)).toBeInTheDocument()
    expect(screen.getByText(/GitHub Actions CI\/CD 流程配置/)).toBeInTheDocument()
  })

  })