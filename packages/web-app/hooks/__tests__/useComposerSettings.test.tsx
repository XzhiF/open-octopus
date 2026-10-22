import { act, renderHook, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it } from "vitest"
import { useComposerSettings } from "../useComposerSettings"

beforeEach(() => {
  window.localStorage.clear()
})

describe("useComposerSettings", () => {
  it("每个模型独立保存 effort/context，切换模型显示自己的 preset", async () => {
    const { result } = renderHook(() => useComposerSettings())
    await waitFor(() => expect(result.current.model).toBe("pro"))
    expect(result.current.effort).toBe("high")
    expect(result.current.context).toBe("200k")

    act(() => result.current.setModel("pro-max"))
    expect(result.current.effort).toBe("high")
    expect(result.current.context).toBe("1m")

    act(() => result.current.setEffort("max"))
    act(() => result.current.setContext("200k"))
    expect(result.current.presets["pro-max"]).toMatchObject({ effort: "max", context: "200k" })

    act(() => result.current.setModel("pro"))
    expect(result.current.effort).toBe("high")
    expect(result.current.context).toBe("200k")

    act(() => result.current.setModel("pro-max"))
    expect(result.current.effort).toBe("max")
    expect(result.current.context).toBe("200k")
  })
})
