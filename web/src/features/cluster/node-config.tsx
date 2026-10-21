import { useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type {
  ClusterApiNode,
  ClusterNodePatch,
  ClusterNodeUpdateProbe,
} from '@/types/panel-cluster'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import {
  connectionDraft,
  connectionNodePatch,
  NodeEditRequests,
  nodeEditError,
  renameNodePatch,
  type NodeConnectionDraft,
} from './node-edit'
import {
  CLUSTER_LOCAL_KEY,
  CLUSTER_NODES_KEY,
  probeNodeUpdate,
  updateClusterNode,
} from './queries'

type EditMode = 'label' | 'connection'
type Counts = { vmCount: number | null; dependentCount: number }

export function NodeConfig({
  node,
  vmCount,
  dependentCount,
}: { node: ClusterApiNode } & Counts) {
  const [editing, setEditing] = useState<{
    base: ClusterApiNode
    mode: EditMode
  } | null>(null)
  return (
    <section className='space-y-3 border-t pt-4'>
      <h3 className='text-sm font-medium'>节点配置</h3>
      {editing ? (
        <NodeEditForm
          base={editing.base}
          mode={editing.mode}
          current={node}
          vmCount={vmCount}
          dependentCount={dependentCount}
          onClose={() => setEditing(null)}
        />
      ) : (
        <>
          <div className='flex flex-wrap gap-2'>
            <Button
              size='sm'
              variant='outline'
              onClick={() => setEditing({ base: node, mode: 'label' })}
            >
              编辑名称
            </Button>
            <Button
              size='sm'
              variant='outline'
              disabled={dependentCount > 0}
              onClick={() => setEditing({ base: node, mode: 'connection' })}
            >
              编辑连接
            </Button>
          </div>
          {dependentCount > 0 ? (
            <p className='text-xs text-muted-foreground'>
              {dependentCount}{' '}
              个节点经由此节点连接，暂不能修改连接配置；名称仍可修改。
            </p>
          ) : null}
        </>
      )}
    </section>
  )
}

function NodeEditForm({
  base,
  current,
  mode,
  vmCount,
  dependentCount,
  onClose,
}: {
  base: ClusterApiNode
  current: ClusterApiNode
  mode: EditMode
  onClose: () => void
} & Counts) {
  const qc = useQueryClient()
  // `base` is captured when editing starts. Polling updates `current`, never this draft.
  const [label, setLabel] = useState(base.label)
  const [draft, setDraft] = useState(() => connectionDraft(base))
  const [pending, setPending] = useState<'probe' | 'save' | null>(null)
  const [error, setError] = useState('')
  const [blockedError, setBlockedError] = useState('')
  const [probe, setProbe] = useState<{
    result: ClusterNodeUpdateProbe
    request: ReturnType<NodeEditRequests['begin']>
  } | null>(null)
  const requests = useRef(new NodeEditRequests())
  useEffect(() => {
    const scope = requests.current
    return () => scope.cancel()
  }, [])

  const conflicted = current.updated_at !== base.updated_at
  let problem = ''
  let payload: ClusterNodePatch | undefined
  try {
    payload =
      mode === 'label'
        ? renameNodePatch(base, label)
        : connectionNodePatch(base, draft, { vmCount, dependentCount })
  } catch (err) {
    problem = nodeEditError(err)
  }
  const blocked = conflicted || !!blockedError || !!problem || pending !== null
  const verified =
    !!probe &&
    requests.current.accepts(probe.request) &&
    probe.result.dependent_count === 0 &&
    (probe.result.vm_count === 0 ||
      probe.result.docker.ok ||
      probe.result.platform === 'darwin')
  const usernameLocked = vmCount !== 0

  function invalidate() {
    requests.current.cancel()
    setProbe(null)
    setError('')
    setPending(null)
  }

  function change<K extends keyof NodeConnectionDraft>(
    key: K,
    value: NodeConnectionDraft[K]
  ) {
    invalidate()
    setDraft((old) => ({ ...old, [key]: value }))
  }

  function changeAuth(authType: NodeConnectionDraft['authType']) {
    invalidate()
    setDraft((old) => ({
      ...old,
      authType,
      replaceCredentials: true,
      privateKey: '',
      passphrase: '',
      password: '',
    }))
  }

  function close() {
    requests.current.cancel()
    onClose()
  }

  function showError(err: unknown) {
    const code = (err as { code?: string } | null)?.code
    if (code === 'node_edit_conflict' || code === 'node_not_found') {
      setBlockedError(nodeEditError(err))
    } else setError(nodeEditError(err))
  }

  async function testConnection() {
    if (blocked || !payload) return
    const request = requests.current.begin()
    setPending('probe')
    setError('')
    setProbe(null)
    try {
      const result = await probeNodeUpdate(base.id, payload, request.signal)
      if (requests.current.accepts(request)) setProbe({ result, request })
    } catch (err) {
      if (requests.current.accepts(request)) showError(err)
    } finally {
      if (requests.current.accepts(request)) setPending(null)
    }
  }

  async function save() {
    if (blocked || !payload || (mode === 'connection' && !verified)) return
    if (
      mode === 'connection' &&
      (!probe || !requests.current.accepts(probe.request))
    )
      return
    const request = requests.current.begin()
    setPending('save')
    setError('')
    try {
      const saved = await updateClusterNode(base.id, payload, request.signal)
      qc.setQueryData<ClusterApiNode[]>(CLUSTER_NODES_KEY, (nodes) =>
        nodes?.map((node) => (node.id === saved.id ? saved : node))
      )
      if (requests.current.accepts(request)) {
        toast.success(mode === 'label' ? '节点名称已保存' : '连接配置已保存')
        onClose()
      }
    } catch (err) {
      if (requests.current.accepts(request)) {
        showError(err)
        setProbe(null)
      }
    } finally {
      if (requests.current.accepts(request)) setPending(null)
      // A cancelled HTTP request may already have committed; always refresh by node id.
      void qc.invalidateQueries({ queryKey: CLUSTER_NODES_KEY })
      void qc.invalidateQueries({ queryKey: CLUSTER_LOCAL_KEY })
      void qc.invalidateQueries({ queryKey: ['panel', 'cluster', base.id] })
    }
  }

  return (
    <div className='space-y-3 rounded-md border p-3'>
      {mode === 'label' ? (
        <div className='space-y-1.5'>
          <Label htmlFor='node-edit-label'>名称</Label>
          <Input
            id='node-edit-label'
            autoFocus
            maxLength={64}
            value={label}
            disabled={pending === 'save'}
            onChange={(e) => {
              invalidate()
              setLabel(e.target.value)
            }}
          />
          <p className='text-xs text-muted-foreground'>
            只更新显示名称，离线也可保存，不会重连。
          </p>
        </div>
      ) : (
        <>
          <p className='text-xs text-muted-foreground'>
            更新同一台主机的连接信息，保留固定指纹与槽位。保存时会再次验证，成功后重连
            SSH。
          </p>
          <fieldset
            disabled={pending === 'save'}
            className='grid gap-3 sm:grid-cols-2'
          >
            <div className='space-y-1.5'>
              <Label htmlFor='node-edit-host'>主机</Label>
              <Input
                id='node-edit-host'
                autoComplete='off'
                spellCheck={false}
                value={draft.host}
                onChange={(e) => change('host', e.target.value)}
              />
            </div>
            <div className='space-y-1.5'>
              <Label htmlFor='node-edit-port'>端口</Label>
              <Input
                id='node-edit-port'
                inputMode='numeric'
                value={draft.port}
                onChange={(e) => change('port', e.target.value)}
              />
            </div>
            <div className='space-y-1.5'>
              <Label htmlFor='node-edit-user'>SSH 用户</Label>
              <Input
                id='node-edit-user'
                autoComplete='off'
                spellCheck={false}
                readOnly={usernameLocked}
                value={draft.username}
                onChange={(e) => change('username', e.target.value)}
              />
              {usernameLocked ? (
                <p className='text-xs text-muted-foreground'>
                  {vmCount === null
                    ? '槽位信息未加载，暂不能更改用户名。'
                    : `已有 ${vmCount} 台槽位，用户名与运行目录关联，不能更改。`}
                </p>
              ) : null}
            </div>
            <div className='space-y-1.5'>
              <Label htmlFor='node-edit-auth'>认证方式</Label>
              <Select
                value={draft.authType}
                onValueChange={(v) =>
                  changeAuth(v as NodeConnectionDraft['authType'])
                }
                disabled={pending === 'save'}
              >
                <SelectTrigger id='node-edit-auth'>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value='key'>私钥</SelectItem>
                  <SelectItem value='password'>密码</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className='space-y-2 sm:col-span-2'>
              {draft.authType === base.auth_type ? (
                <label className='flex items-center gap-2 text-sm'>
                  <input
                    type='checkbox'
                    checked={draft.replaceCredentials}
                    onChange={(e) => {
                      invalidate()
                      setDraft((old) => ({
                        ...old,
                        replaceCredentials: e.target.checked,
                        privateKey: '',
                        passphrase: '',
                        password: '',
                      }))
                    }}
                  />
                  更换凭证
                </label>
              ) : (
                <p className='text-xs text-muted-foreground'>
                  切换认证方式需要填写新凭证。
                </p>
              )}
              {draft.replaceCredentials || draft.authType !== base.auth_type ? (
                draft.authType === 'key' ? (
                  <>
                    <Label htmlFor='node-edit-key'>新私钥</Label>
                    <Textarea
                      id='node-edit-key'
                      autoComplete='off'
                      spellCheck={false}
                      className='h-28 font-mono text-xs'
                      value={draft.privateKey}
                      onChange={(e) => change('privateKey', e.target.value)}
                    />
                    <Label htmlFor='node-edit-passphrase'>新私钥口令</Label>
                    <Input
                      id='node-edit-passphrase'
                      type='password'
                      autoComplete='new-password'
                      value={draft.passphrase}
                      onChange={(e) => change('passphrase', e.target.value)}
                    />
                    <p className='text-xs text-muted-foreground'>
                      留空表示新私钥没有口令，并清除原口令。
                    </p>
                  </>
                ) : (
                  <>
                    <Label htmlFor='node-edit-password'>新密码</Label>
                    <Input
                      id='node-edit-password'
                      type='password'
                      autoComplete='new-password'
                      value={draft.password}
                      onChange={(e) => change('password', e.target.value)}
                    />
                  </>
                )
              ) : (
                <p className='text-xs text-muted-foreground'>
                  保留已保存凭证，不读取或回显密码、私钥。
                </p>
              )}
            </div>
          </fieldset>
          <p className='text-xs text-muted-foreground'>
            经由节点保持原配置，本次不支持修改。
          </p>
        </>
      )}
      {blockedError ? (
        <p role='alert' className='text-xs text-red-3'>
          {blockedError}
        </p>
      ) : conflicted ? (
        <p role='alert' className='text-xs text-red-3'>
          节点配置已被修改，请取消后重新编辑。
        </p>
      ) : null}
      {error ? (
        <p role='alert' className='text-xs text-red-3'>
          {error}
        </p>
      ) : null}
      {problem && !conflicted ? (
        <p className='text-xs text-muted-foreground'>{problem}</p>
      ) : null}
      {probe && verified && !conflicted ? (
        <div className='space-y-1 rounded-md bg-muted/30 p-3 text-xs'>
          <p>连接验证通过，主机指纹与原记录一致。</p>
          <p className='font-mono break-all'>
            {probe.result.host_key.alg} {probe.result.host_key.sha256}
          </p>
          <p>
            {probe.result.platform === 'darwin'
              ? 'macOS 原生节点，不使用 Docker。'
              : `Docker：${
                  probe.result.docker.ok
                    ? '可用'
                    : `不可用（${probe.result.docker.error || '未响应'}），当前没有槽位，仍可保存。`
                }`}
          </p>
        </div>
      ) : null}
      <div className='flex flex-wrap justify-end gap-2'>
        <Button size='sm' variant='outline' onClick={close}>
          {pending === 'save' ? '关闭' : '取消'}
        </Button>
        {mode === 'connection' ? (
          <Button
            size='sm'
            variant='outline'
            disabled={blocked}
            loading={pending === 'probe'}
            onClick={() => void testConnection()}
          >
            测试连接
          </Button>
        ) : null}
        <Button
          size='sm'
          disabled={blocked || (mode === 'connection' && !verified)}
          loading={pending === 'save'}
          onClick={() => void save()}
        >
          {mode === 'label' ? '保存名称' : '保存并重连'}
        </Button>
      </div>
    </div>
  )
}
