"use client"

import { useState } from "react"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { useNaturalLanguageCron } from "@/hooks/use-cron-parse"
import { Loader2, Wand2 } from "lucide-react"

interface Props {
  onResult: (expression: string) => void
}

export function NaturalLanguageInput({ onResult }: Props) {
  const [input, setInput] = useState("")
  const { loading, error, convert } = useNaturalLanguageCron()

  const handleConvert = async () => {
    const result = await convert(input)
    if (result && result.confidence !== "error") {
      onResult(result.expression)
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <Input
          placeholder="e.g. Every day at 9am, every Monday at 3pm..."
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") handleConvert()
          }}
          disabled={loading}
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={handleConvert}
          disabled={loading || !input.trim()}
        >
          {loading ? (
            <Loader2 className="mr-1 h-3 w-3 animate-spin" />
          ) : (
            <Wand2 className="mr-1 h-3 w-3" />
          )}
          Generate
        </Button>
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  )
}
