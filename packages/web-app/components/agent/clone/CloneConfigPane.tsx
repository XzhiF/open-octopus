'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Lock, Plus, RotateCcw, Save, Sparkles, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { listMainAgentFiles, updateCloneSettings } from '@/lib/agent/api'
import type { CloneInfo } from '@/lib/agent/types'
import { CloneVersionsTab } from './CloneVersionsTab'
import { Card, Field, Toggle, inputCls } from '../shared/agent-ui'

interface CloneConfigPaneProps {
  clone: CloneInfo
  onSaved: () => void
}

export function CloneConfigPane({ clone, onSaved }: CloneConfigPaneProps) {
  const [displayName, setDisplayName] = useState(clone.display_name)
  const [memoryScope, setMemoryScope] = useState<'shared' | 'isolated'>(clone.memory_scope)
  const [skills, setSkills] = useState<string[]>(clone.skills ?? [])
  const [saving, setSaving] = useState(false)

  const [inheritedSkills, setInheritedSkills] = useState<string[]>([])
  const [newSkill, setNewSkill] = useState('')

  useEffect(() => {
    setDisplayName(clone.display_name)
    setMemoryScope(clone.memory_scope)
    setSkills(clone.skills ?? [])
  }, [clone])

  useEffect(() => {
    let cancelled = false
    listMainAgentFiles({ path: 'skills' })
      .then((skillsRes) => {
        if (cancelled) return
        setInheritedSkills(
          skillsRes.files.filter((file) => file.type === 'directory').map((file) => file.name),
        )
      })
      .catch(() => {
        if (!cancelled) setInheritedSkills([])
      })
    return () => {
      cancelled = true
    }
  }, [])

  const dirty = useMemo(() => {
    const baseline = clone.skills ?? []
    return (
      displayName !== clone.display_name
      || memoryScope !== clone.memory_scope
      || skills.length !== baseline.length
      || skills.some((skill) => !baseline.includes(skill))
    )
  }, [clone, displayName, memoryScope, skills])

  const reset = () => {
    setDisplayName(clone.display_name)
    setMemoryScope(clone.memory_scope)
    setSkills(clone.skills ?? [])
  }

  const save = useCallback(async () => {
    if (!displayName.trim()) {
      toast.error('显示名称不能为空')
      return
    }
    setSaving(true)
    try {
      await updateCloneSettings(clone.name, {
        display_name: displayName.trim(),
        memory_scope: memoryScope,
        skills,
      })
      toast.success('分身配置已保存')
      onSaved()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }, [clone.name, displayName, memoryScope, skills, onSaved])

  const addSkill = useCallback(() => {
    const name = newSkill.trim()
    if (!name) return
    setSkills((prev) => (prev.includes(name) ? prev : [...prev, name]))
    setNewSkill('')
  }, [newSkill])

  const knownSkills = inheritedSkills.filter((name) => !skills.includes(name))

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-auto p-3">
        <div className="flex flex-col gap-[11px]">
          <Card title="身份" tag="IDENTITY">
            <div className="grid grid-cols-2 gap-3">
              <Field label="显示名称">
                <input
                  value={displayName}
                  onChange={(event) => setDisplayName(event.target.value)}
                  className={inputCls}
                />
              </Field>
              <Field label={<span className="flex items-center gap-1"><Lock className="size-2.5" />英文代号</span>}>
                <input value={clone.name} readOnly className={`${inputCls} font-mono`} />
              </Field>
            </div>
            <Field label="记忆范围">
              <div className="flex gap-[3px] rounded-[9px] border-[1.5px] border-pop-bd bg-pop-inset p-[3px]">
                {([
                  ['isolated', '独立记忆'],
                  ['shared', '共享主 Agent'],
                ] as const).map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    onClick={() => setMemoryScope(value)}
                    className={`h-[25px] flex-1 rounded-[6px] text-[10.5px] font-bold transition-colors ${
                      memoryScope === value
                        ? 'bg-pop-purple-soft text-pop-purple'
                        : 'text-pop-dim hover:text-pop-ink'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </Field>
          </Card>

          <Card title="技能" tag="SKILLS">
            <div className="flex items-center gap-1.5 text-[10.5px] text-pop-ink">
              <Sparkles className="size-3 text-pop-purple" />
              继承 Skills
              <span className="ml-auto rounded-[5px] border border-pop-bd bg-pop-idle px-1.5 py-px font-mono text-[9px] text-pop-dim">
                {inheritedSkills.length}
              </span>
            </div>
            <div className="flex flex-col gap-1">
              {skills.length === 0 && (
                <div className="rounded-[7px] border border-dashed border-pop-bd px-2.5 py-2 text-center text-[10px] text-pop-dim">
                  这个分身还没有专属技能
                </div>
              )}
              {skills.map((skill) => (
                <div
                  key={skill}
                  className="flex items-center gap-2 rounded-[7px] border border-pop-bd bg-pop-idle px-2.5 py-1.5"
                >
                  <span className="grid size-5 flex-none place-items-center rounded-[5px] border border-pop-purple/30 bg-pop-purple-soft text-pop-purple">
                    <Sparkles className="size-2.5" />
                  </span>
                  <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-pop-ink">{skill}</span>
                  <button
                    type="button"
                    title="移除技能"
                    onClick={() => setSkills((prev) => prev.filter((name) => name !== skill))}
                    className="text-pop-dim transition-colors hover:text-pop-red"
                  >
                    <Trash2 className="size-3" />
                  </button>
                </div>
              ))}
            </div>

            <div className="flex items-center gap-1.5">
              <input
                value={newSkill}
                onChange={(event) => setNewSkill(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    addSkill()
                  }
                }}
                list="clone-skill-options"
                placeholder="输入技能名添加…"
                className={`${inputCls} font-mono`}
              />
              <datalist id="clone-skill-options">
                {knownSkills.map((name) => (
                  <option key={name} value={name} />
                ))}
              </datalist>
              <button
                type="button"
                onClick={addSkill}
                disabled={!newSkill.trim()}
                className="inline-flex h-8 flex-none items-center gap-1 rounded-[7px] border-[1.5px] border-pop-bd bg-pop-idle px-2.5 text-[10px] font-bold text-pop-ink transition-colors hover:border-pop-purple/45 disabled:opacity-40"
              >
                <Plus className="size-3" />
                添加
              </button>
            </div>
          </Card>

          <Card
            title="版本"
            tag="CLONE ONLY"
            bodyClassName="p-0"
          >
            <div className="h-[320px]">
              <CloneVersionsTab agentName={clone.name} />
            </div>
          </Card>
        </div>
      </div>

      <div className="flex flex-none items-center gap-3 border-t-[1.5px] border-pop-bd bg-pop-paper px-4 py-2">
        <span className={`flex items-center gap-1.5 text-[10px] ${dirty ? 'text-pop-yellow' : 'text-pop-dim'}`}>
          <i className={`inline-block size-[5px] rounded-full ${dirty ? 'bg-pop-yellow' : 'bg-pop-green'}`} />
          {dirty ? '配置变更尚未保存' : '配置已保存'}
        </span>
        <span className="ml-auto flex items-center gap-1.5">
          <button
            type="button"
            onClick={reset}
            disabled={!dirty || saving}
            className="inline-flex h-7 items-center gap-1 rounded-[7px] px-2.5 text-[10.5px] font-bold text-pop-dim transition-colors hover:text-pop-ink disabled:opacity-40"
          >
            <RotateCcw className="size-3" />
            重置
          </button>
          <button
            type="button"
            onClick={save}
            disabled={!dirty || saving}
            className="inline-flex h-7 items-center gap-1.5 rounded-[7px] border-[1.5px] border-pop-purple/45 bg-pop-purple-soft px-3 text-[10.5px] font-bold text-pop-purple transition-colors hover:bg-pop-purple/15 disabled:opacity-50"
          >
            <Save className="size-3" />
            {saving ? '保存中…' : '保存分身配置'}
          </button>
        </span>
      </div>
    </div>
  )
}
