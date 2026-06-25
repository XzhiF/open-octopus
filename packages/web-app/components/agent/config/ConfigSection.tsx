import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'

interface ConfigSectionProps {
  title: string
  description?: string
  saving?: boolean
  onSave?: () => void
  children: React.ReactNode
}

export function ConfigSection({ title, description, saving, onSave, children }: ConfigSectionProps) {
  return (
    <section className="rounded-xl border border-agent-divider bg-agent-surface-raised overflow-hidden">
      <div className="px-5 py-4 border-b border-agent-divider">
        <h3 className="text-sm font-semibold">{title}</h3>
        {description && <p className="text-xs text-muted-foreground mt-1">{description}</p>}
      </div>
      <div className="px-5 py-4 space-y-4">
        {children}
      </div>
      {onSave && (
        <>
          <Separator />
          <div className="px-5 py-3 flex justify-end">
            <Button
              onClick={onSave}
              disabled={saving}
              size="sm"
              className="bg-agent-primary hover:bg-agent-primary-hover text-agent-primary-foreground"
            >
              {saving ? '保存中...' : '保存'}
            </Button>
          </div>
        </>
      )}
    </section>
  )
}
