import { useRef } from 'react'
import { Upload } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'

/** 凭证面板共用的分段按钮（role=tablist）。 */
export function Seg<T extends string>({
  label,
  value,
  options,
  onChange,
  disabled,
}: {
  label: string
  value: T
  options: { id: T; label: string }[]
  onChange: (next: T) => void
  disabled?: boolean
}) {
  return (
    <div
      role='tablist'
      aria-label={label}
      className='flex flex-wrap items-center gap-1.5'
    >
      {options.map((o) => (
        <Button
          key={o.id}
          type='button'
          role='tab'
          size='sm'
          aria-selected={value === o.id}
          disabled={disabled}
          variant={value === o.id ? 'default' : 'outline'}
          onClick={() => onChange(o.id)}
        >
          {o.label}
        </Button>
      ))}
    </div>
  )
}

export function Hint({ children }: { children: React.ReactNode }) {
  return <p className='text-xs text-muted-foreground'>{children}</p>
}

function fileSizeLabel(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  return `${Math.max(0.1, bytes / 1024).toFixed(1)} KB`
}

export type PickedFile = { name: string; size: number }

/** 账号文件 / Token 输入区：可上传 JSON 文件（不展示原文）或直接粘贴。 */
export function AccountFileField({
  id,
  label,
  allowUpload,
  rows,
  placeholder,
  busy,
  text,
  setText,
  pickedFile,
  setPickedFile,
  fileError,
  setFileError,
}: {
  id: string
  label: React.ReactNode
  allowUpload: boolean
  rows: number
  placeholder: string
  busy: boolean
  text: string
  setText: (next: string) => void
  pickedFile: PickedFile | null
  setPickedFile: (next: PickedFile | null) => void
  fileError: string
  setFileError: (next: string) => void
}) {
  const fileRef = useRef<HTMLInputElement>(null)

  async function onPickFile(file: File | undefined) {
    setFileError('')
    if (!file) return
    try {
      const raw = await file.text()
      setText(raw)
      setPickedFile({ name: file.name, size: file.size })
    } catch {
      setPickedFile(null)
      setFileError('文件读取失败')
    }
  }

  return (
    <>
      <div className='flex flex-wrap items-center justify-between gap-2'>
        <Label htmlFor={id}>{label}</Label>
        {allowUpload ? (
          <>
            <input
              ref={fileRef}
              type='file'
              accept='application/json,.json'
              className='hidden'
              onChange={(event) => {
                const file = event.target.files?.[0]
                event.target.value = ''
                void onPickFile(file)
              }}
            />
            <Button
              type='button'
              size='sm'
              variant='outline'
              disabled={busy}
              onClick={() => fileRef.current?.click()}
            >
              <Upload className='size-3.5' aria-hidden='true' />
              上传文件
            </Button>
          </>
        ) : null}
      </div>
      {pickedFile ? (
        <div className='flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2'>
          <div className='min-w-0'>
            <p className='truncate text-sm'>{pickedFile.name}</p>
            <p className='text-xs text-muted-foreground'>
              {fileSizeLabel(pickedFile.size)} · 已读取，不展示原文
            </p>
          </div>
          <Button
            type='button'
            size='sm'
            variant='ghost'
            disabled={busy}
            onClick={() => {
              setPickedFile(null)
              setText('')
              setFileError('')
            }}
          >
            清除
          </Button>
        </div>
      ) : (
        <Textarea
          id={id}
          rows={rows}
          value={text}
          disabled={busy}
          onChange={(event) => {
            setFileError('')
            setText(event.target.value)
          }}
          placeholder={placeholder}
        />
      )}
      {fileError ? (
        <p className='text-xs text-destructive'>{fileError}</p>
      ) : null}
    </>
  )
}
