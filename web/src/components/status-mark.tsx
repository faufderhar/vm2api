import type { StatusTone } from '@/types/status'
import { cn } from '@/lib/utils'

type ShapeName = 'dot' | 'triangle' | 'half' | 'cross' | 'ring' | 'square'

const SHAPE: Record<string, { shape: ShapeName; color: string; bg: string }> = {
  ok: { shape: 'dot', color: 'var(--status-ok)', bg: 'var(--status-ok-bg)' },
  caution: {
    shape: 'triangle',
    color: 'var(--status-caution)',
    bg: 'var(--status-caution-bg)',
  },
  warn: {
    shape: 'half',
    color: 'var(--status-warn)',
    bg: 'var(--status-warn-bg)',
  },
  bad: {
    shape: 'cross',
    color: 'var(--status-bad)',
    bg: 'var(--status-bad-bg)',
  },
  none: {
    shape: 'ring',
    color: 'var(--status-none)',
    bg: 'var(--status-none-bg)',
  },
  off: {
    shape: 'square',
    color: 'var(--status-none)',
    bg: 'var(--status-none-bg)',
  },
}

/** tier 标记不属于健康状态轴，走中性 pill，不参与形状编码 */
const TIER = new Set(['max', 'pro', 'grok'])

const STROKE = 1.5

function Shape({ name }: { name: ShapeName }) {
  const common = {
    width: 12,
    height: 12,
    viewBox: '0 0 12 12',
    fill: 'none',
    'aria-hidden': true,
    focusable: false,
    className: 'shrink-0',
  } as const

  switch (name) {
    case 'dot':
      return (
        <svg {...common}>
          <circle cx='6' cy='6' r='3.6' fill='currentColor' />
        </svg>
      )
    case 'triangle':
      return (
        <svg {...common}>
          <path
            d='M6 1.9 10.6 9.9H1.4z'
            fill='currentColor'
            stroke='currentColor'
            strokeWidth={STROKE}
            strokeLinejoin='round'
          />
        </svg>
      )
    case 'half':
      return (
        <svg {...common}>
          <path d='M6 2.1A3.9 3.9 0 0 1 6 9.9z' fill='currentColor' />
          <circle
            cx='6'
            cy='6'
            r='3.9'
            stroke='currentColor'
            strokeWidth={STROKE}
          />
        </svg>
      )
    case 'cross':
      return (
        <svg {...common}>
          <path
            d='m2.6 2.6 6.8 6.8M9.4 2.6 2.6 9.4'
            stroke='currentColor'
            strokeWidth={STROKE}
            strokeLinecap='round'
          />
        </svg>
      )
    case 'ring':
      return (
        <svg {...common}>
          <circle
            cx='6'
            cy='6'
            r='3.9'
            stroke='currentColor'
            strokeWidth={STROKE}
            strokeDasharray='2.2 1.8'
            strokeLinecap='round'
          />
        </svg>
      )
    case 'square':
      return (
        <svg {...common}>
          <rect
            x='2.4'
            y='2.4'
            width='7.2'
            height='7.2'
            rx='1.2'
            fill='currentColor'
          />
        </svg>
      )
  }
}

export function StatusMark({
  tone,
  variant = 'mark',
  className,
}: {
  tone: StatusTone
  /** `mark` 表格内紧凑（形状 + 文案）；`pill` 详情/KPI 内浅底深字 */
  variant?: 'mark' | 'pill'
  className?: string
}) {
  const text = tone.label || tone.text
  const aria = tone.text || tone.label || ''

  if (TIER.has(tone.cls)) {
    return (
      <span
        role='img'
        aria-label={aria}
        className={cn(
          'inline-flex w-fit shrink-0 items-center rounded-md px-1.5 py-0.5 text-xs font-medium whitespace-nowrap text-muted-foreground tabular-nums',
          variant === 'pill' ? 'bg-muted' : 'bg-transparent',
          className
        )}
      >
        <span aria-hidden='true'>{text}</span>
      </span>
    )
  }

  const spec = SHAPE[tone.cls] ?? SHAPE.none

  return (
    <span
      role='img'
      aria-label={aria}
      style={{
        color: spec.color,
        ...(variant === 'pill' ? { backgroundColor: spec.bg } : null),
      }}
      className={cn(
        'inline-flex w-fit shrink-0 items-center gap-1.5 rounded-md text-xs font-medium whitespace-nowrap tabular-nums',
        variant === 'pill' ? 'px-2 py-0.5' : 'px-0.5 py-0',
        className
      )}
    >
      <Shape name={spec.shape} />
      <span aria-hidden='true'>{text}</span>
    </span>
  )
}
