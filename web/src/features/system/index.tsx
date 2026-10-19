import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { VIEW_TITLES } from '@/config/nav'
import type { Dashboard } from '@/types/panel-overview'
import { toast } from 'sonner'
import { api, patchVm } from '@/lib/api'
import { protocolPersonaSaveToast } from '@/lib/persona-template'
import { cn } from '@/lib/utils'
import { isClaudeVm } from '@/lib/vm-kind'
import { PageHeader } from '@/components/page-header'
import { QueryGate } from '@/components/query-gate'
import { dashboardQueryOptions } from '@/features/overview/queries'
import { inheritProtocolOnSlots } from '@/features/settings/protocol-authority'
import { routingQueryOptions } from '@/features/settings/queries'
import { SaveBar } from '@/features/settings/save-bar'
import { SettingsSkeleton } from '@/features/settings/settings-skeleton'
import { SystemPromptWorkspace } from '@/features/system/prompt-workspace'
import { compatibilityPatch } from './compat-patch'

type RoutingSaveResult = {
  compatibility?: Record<string, unknown>
  kernel_persona?: { updated?: number; skipped?: number } | null
}

function followError(message: string) {
  if (/config_missing|kernel_start_failed|wrap_cli_missing/i.test(message)) {
    return '内核文件缺失，先到内核页拉取 wrap/crag 二进制再同步'
  }
  return message
}

export function SystemPromptPage() {
  const routing = useQuery(routingQueryOptions())
  const qc = useQueryClient()
  const [draft, setDraft] = useState<Record<string, unknown>>({})
  const [personaProblems, setPersonaProblems] = useState<string[]>([])
  const [discardKey, setDiscardKey] = useState(0)

  useEffect(() => {
    if (routing.data) setDraft(routing.data)
  }, [routing.data])

  const save = useMutation({
    mutationFn: () => {
      const body = compatibilityPatch(
        (draft.compatibility as Record<string, unknown>) || {},
        routing.data?.compatibility as Record<string, unknown> | undefined
      )
      return api<RoutingSaveResult>('/api/panel/routing', {
        method: 'PUT',
        body: JSON.stringify(body),
      })
    },
    onSuccess: async (saved) => {
      const compat =
        saved?.compatibility ||
        (draft.compatibility as Record<string, unknown> | undefined)
      let inherited = 0
      try {
        const dash = await api<Dashboard>('/api/panel/dashboard')
        const follow = await inheritProtocolOnSlots(
          (dash.vms || []).filter((vm) => isClaudeVm(vm)),
          patchVm
        )
        inherited = follow.changed
        if (follow.errors.length) {
          toast.error(
            `已保存，${follow.errors.length} 个槽位未跟随：${follow.errors
              .slice(0, 3)
              .map((item) => `${item.id} ${followError(item.message)}`)
              .join('；')}`
          )
        }
      } catch (error) {
        toast.error(
          `已保存，槽位未跟随全局：${followError(
            error instanceof Error ? error.message : String(error)
          )}`
        )
      }
      toast.success(
        protocolPersonaSaveToast(compat, inherited, saved?.kernel_persona)
      )
      await Promise.all([
        qc.invalidateQueries({ queryKey: routingQueryOptions().queryKey }),
        qc.invalidateQueries({ queryKey: dashboardQueryOptions().queryKey }),
      ])
    },
    onError: (error: Error) => toast.error(followError(error.message)),
  })

  const serverJson = routing.data ? JSON.stringify(routing.data) : null
  const dirty =
    serverJson !== null &&
    Object.keys(draft).length > 0 &&
    JSON.stringify(draft) !== serverJson
  const blocked = personaProblems.length > 0

  const discard = () => {
    setDraft(routing.data ?? {})
    setPersonaProblems([])
    setDiscardKey((k) => k + 1)
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key !== 's') return
      e.preventDefault()
      if (!dirty || save.isPending) return
      if (blocked) {
        toast.error(personaProblems[0])
        return
      }
      save.mutate()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  return (
    <PageHeader title={VIEW_TITLES.system}>
      <div className={cn(dirty && 'pb-16')}>
        <QueryGate
          loading={routing.isLoading}
          error={routing.error}
          skeleton={<SettingsSkeleton />}
        >
          <SystemPromptWorkspace
            key={discardKey}
            compat={
              (draft.compatibility as Record<string, unknown> | undefined) || {}
            }
            server={
              routing.data?.compatibility as Record<string, unknown> | undefined
            }
            onChange={(next) => setDraft({ ...draft, compatibility: next })}
            onProblemsChange={setPersonaProblems}
          />
        </QueryGate>
      </div>
      {dirty ? (
        <SaveBar
          blockedReason={blocked ? personaProblems[0] : undefined}
          saving={save.isPending}
          onSave={() => save.mutate()}
          onDiscard={discard}
        />
      ) : null}
    </PageHeader>
  )
}
