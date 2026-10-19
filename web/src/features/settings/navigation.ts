import {
  Activity,
  Archive,
  BellRing,
  Bot,
  Fingerprint,
  Gauge,
  Info,
  Layers,
  ListChecks,
  Magnet,
  Network,
  PackageCheck,
  RadioTower,
  ScrollText,
  type LucideIcon,
} from 'lucide-react'

export const SETTINGS_TABS = [
  ['sticky', '粘性'],
  ['pool', '账号池'],
  ['quota', '配额'],
  ['openai', 'OpenAI'],
  ['grok', 'Grok'],
  ['logs', '日志'],
  ['protocol', '协议'],
  ['whitelist', '白名单'],
  ['init', '初装'],
  ['health', '探测'],
  ['notify', '通知'],
  ['telemetry', '遥测'],
  ['socks5', 'SOCKS5'],
  ['backup', '备份'],
  ['about', '关于'],
] as const

export type SettingsTabId = (typeof SETTINGS_TABS)[number][0]

/**
 * 设置页左侧分组导航。id 必须来自 SETTINGS_TABS（类型层面约束），
 * 分组只改呈现顺序，不改路由与合法 tab 集合。同一 tab 可出现在多组。
 */
export const SETTINGS_NAV_GROUPS: {
  label: string
  items: { id: SettingsTabId; icon: LucideIcon }[]
}[] = [
  {
    label: '调度',
    items: [
      { id: 'sticky', icon: Magnet },
      { id: 'pool', icon: Layers },
      { id: 'quota', icon: Gauge },
      { id: 'openai', icon: Bot },
      { id: 'grok', icon: Bot },
    ],
  },
  {
    label: '协议',
    items: [
      { id: 'protocol', icon: Fingerprint },
      { id: 'whitelist', icon: ListChecks },
    ],
  },
  {
    label: '槽位',
    items: [
      { id: 'init', icon: PackageCheck },
      { id: 'health', icon: Activity },
      { id: 'openai', icon: Bot },
      { id: 'grok', icon: Bot },
      { id: 'telemetry', icon: RadioTower },
      { id: 'socks5', icon: Network },
    ],
  },
  {
    label: '运维',
    items: [
      { id: 'notify', icon: BellRing },
      { id: 'logs', icon: ScrollText },
      { id: 'backup', icon: Archive },
      { id: 'about', icon: Info },
    ],
  },
]

export const SETTINGS_TAB_LABELS = Object.fromEntries(SETTINGS_TABS) as Record<
  SettingsTabId,
  string
>

export function settingsTabId(tab: string | undefined): SettingsTabId {
  return SETTINGS_TABS.some((item) => item[0] === tab)
    ? (tab as SettingsTabId)
    : 'sticky'
}

export function settingsNavItemKey(
  groupLabel: string,
  id: SettingsTabId
): string {
  return `${groupLabel}:${id}`
}

/** 桌面指示条锚在第一处出现的激活项，避免重复 OpenAI 入口抢 ref。 */
export function firstSettingsNavKey(active: SettingsTabId): string {
  for (const group of SETTINGS_NAV_GROUPS) {
    for (const item of group.items) {
      if (item.id === active) return settingsNavItemKey(group.label, item.id)
    }
  }
  return settingsNavItemKey(SETTINGS_NAV_GROUPS[0]?.label ?? '', active)
}

/** 窄屏 pill 去重，两组入口仍指向同一 tab。 */
export const SETTINGS_NAV_UNIQUE_ITEMS: {
  id: SettingsTabId
  icon: LucideIcon
}[] = (() => {
  const seen = new Set<SettingsTabId>()
  const items: { id: SettingsTabId; icon: LucideIcon }[] = []
  for (const group of SETTINGS_NAV_GROUPS) {
    for (const item of group.items) {
      if (seen.has(item.id)) continue
      seen.add(item.id)
      items.push(item)
    }
  }
  return items
})()
