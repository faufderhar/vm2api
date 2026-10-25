import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { AccountFileField, Seg } from './credential-panel-parts'

const noop = () => {}

function field(over: Partial<Parameters<typeof AccountFileField>[0]> = {}) {
  return renderToStaticMarkup(
    <AccountFileField
      id='x-import-text'
      label='账号文件'
      allowUpload
      rows={8}
      placeholder='paste'
      busy={false}
      text=''
      setText={noop}
      pickedFile={null}
      setPickedFile={noop}
      fileError=''
      setFileError={noop}
      {...over}
    />
  )
}

describe('credential-panel-parts', () => {
  it('Seg marks the selected tab', () => {
    const html = renderToStaticMarkup(
      <Seg
        label='方式'
        value='b'
        options={[
          { id: 'a', label: 'A' },
          { id: 'b', label: 'B' },
        ]}
        onChange={noop}
      />
    )
    expect(html).toContain('aria-label="方式"')
    expect(html.match(/aria-selected="true"/g)).toHaveLength(1)
  })

  it('AccountFileField shows textarea, upload and error', () => {
    const html = field({ fileError: '文件读取失败' })
    expect(html).toContain('id="x-import-text"')
    expect(html).toContain('上传文件')
    expect(html).toContain('文件读取失败')
    expect(field({ allowUpload: false })).not.toContain('上传文件')
  })

  it('AccountFileField hides raw text once a file is picked', () => {
    const html = field({
      text: 'SECRET',
      pickedFile: { name: 'auth.json', size: 2048 },
    })
    expect(html).toContain('auth.json')
    expect(html).toContain('2.0 KB')
    expect(html).not.toContain('SECRET')
    expect(field({ pickedFile: { name: 'a', size: 12 } })).toContain('12 B')
  })
})
