import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import {
  downloadReleaseKernel,
  isAllowedKernelUrl,
  kernelReleaseHttpStatus,
  selectKernelAsset,
  selectCliNodeAsset,
} from '../../src/lib/admin/release-kernel.mjs'

const DIGEST_64_ZERO = `sha256:${crypto.createHash('sha256').update(Buffer.alloc(64)).digest('hex')}`

function sha256Digest(bytes) {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`
}

function fakeElf64Amd64() {
  const buf = Buffer.alloc(64)
  buf[0] = 0x7f
  buf[1] = 0x45
  buf[2] = 0x4c
  buf[3] = 0x46
  buf[4] = 2
  buf[5] = 1
  buf.writeUInt16LE(3, 16)
  buf.writeUInt16LE(62, 18)
  return buf
}

test('selectKernelAsset accepts only the kin-kernel GitHub asset', () => {
  const picked = selectKernelAsset({
    tag_name: 'v1.3.2',
    assets: [
      { name: 'kin-worker', url: 'https://api.github.com/repos/dofastted/vm2api/releases/assets/1' },
      {
        name: 'kin-kernel',
        size: 64,
        url: 'https://api.github.com/repos/dofastted/vm2api/releases/assets/9',
        browser_download_url: 'https://evil.example/kin-kernel',
        digest: DIGEST_64_ZERO,
      },
    ],
  })
  assert.equal(picked.ok, true)
  assert.equal(picked.tag, 'v1.3.2')
  assert.equal(picked.url, 'https://api.github.com/repos/dofastted/vm2api/releases/assets/9')
  assert.equal(selectKernelAsset({ tag_name: 'v1.3.2', assets: [] }).code, 'kernel_asset_missing')
  assert.equal(
    selectCliNodeAsset({
      tag_name: 'v1.3.2',
      assets: [
        {
          name: 'cli-node',
          size: 64,
          url: 'https://api.github.com/repos/dofastted/vm2api/releases/assets/8',
          digest: DIGEST_64_ZERO,
        },
      ],
    }).asset,
    'cli-node',
  )
  assert.equal(selectCliNodeAsset({ tag_name: 'v1.3.2', assets: [] }).code, 'cli_node_asset_missing')
  assert.equal(
    selectKernelAsset({
      tag_name: 'v1.3.2',
      assets: [{ name: 'kin-kernel', size: 64, url: 'https://evil.example/kin-kernel' }],
    }).code,
    'kernel_asset_url',
  )
  assert.equal(
    selectKernelAsset({
      tag_name: 'v1.3.2',
      assets: [
        {
          name: 'kin-kernel',
          size: 33 * 1024 * 1024,
          url: 'https://api.github.com/repos/dofastted/vm2api/releases/assets/9',
        },
      ],
    }).code,
    'kernel_too_large',
  )
})

test('kernel download follows GitHub asset redirects and refuses other hosts', async () => {
  assert.equal(isAllowedKernelUrl('http://api.github.com/repos/dofastted/vm2api/releases/latest'), false)
  assert.equal(isAllowedKernelUrl('https://api.github.com/repos/dofastted/vm2api/releases/tags/v1.2.3'), true)
  assert.equal(isAllowedKernelUrl('https://evil.example/kin-kernel', { redirect: true }), false)
  const elf = fakeElf64Amd64()
  const seen = []
  const fetched = await downloadReleaseKernel({
    tag: '1.2.3',
    fetchImpl: async (url, opts) => {
      seen.push(String(url))
      assert.equal(opts.redirect, 'manual')
      if (String(url).endsWith('/releases/tags/v1.2.3')) {
        return new Response(
          JSON.stringify({
            tag_name: 'v1.2.3',
            assets: [
              {
                name: 'kin-kernel',
                size: elf.length,
                browser_download_url: 'https://github.com/dofastted/vm2api/releases/download/v1.2.3/kin-kernel',
                digest: sha256Digest(elf),
              },
              {
                name: 'cli-node',
                size: elf.length,
                browser_download_url: 'https://github.com/dofastted/vm2api/releases/download/v1.2.3/cli-node',
                digest: sha256Digest(elf),
              },
              {
                name: 'cc-node',
                size: elf.length,
                browser_download_url: 'https://github.com/dofastted/vm2api/releases/download/v1.2.3/cc-node',
                digest: sha256Digest(elf),
              },
              {
                name: 'kin-kernel-crag',
                size: elf.length,
                browser_download_url: 'https://github.com/dofastted/vm2api/releases/download/v1.2.3/kin-kernel-crag',
                digest: sha256Digest(elf),
              },
            ],
          }),
          { status: 200 },
        )
      }
      if (String(url) === 'https://github.com/dofastted/vm2api/releases/download/v1.2.3/kin-kernel') {
        return new Response(null, {
          status: 302,
          headers: {
            location: 'https://release-assets.githubusercontent.com/github-production-release-asset/kin-kernel',
          },
        })
      }
      if (String(url).includes('release-assets.githubusercontent.com')) {
        assert.equal(opts.headers.Authorization, undefined)
        return new Response(elf, { status: 200 })
      }
      if (
        String(url) === 'https://github.com/dofastted/vm2api/releases/download/v1.2.3/cli-node' ||
        String(url) === 'https://github.com/dofastted/vm2api/releases/download/v1.2.3/cc-node' ||
        String(url) === 'https://github.com/dofastted/vm2api/releases/download/v1.2.3/kin-kernel-crag'
      ) {
        return new Response(elf, { status: 200 })
      }
      throw new Error(`unexpected ${url}`)
    },
  })
  assert.equal(fetched.ok, true, fetched.error)
  assert.equal(fetched.tag, 'v1.2.3')
  assert.ok(Buffer.from(fetched.bytes).equals(elf))
  assert.ok(Buffer.from(fetched.cliNode.bytes).equals(elf))
  assert.ok(Buffer.from(fetched.ccNode.bytes).equals(elf))
  assert.ok(Buffer.from(fetched.crag.bytes).equals(elf))
  assert.equal(fetched.crag.skipped, undefined)
  assert.equal(seen.length, 6)
  assert.equal(isAllowedKernelUrl('https://github.com/dofastted/vm2api/releases/download/v1.2.3/cc-node'), true)

  const blocked = await downloadReleaseKernel({
    fetchImpl: async (url) => {
      if (String(url).endsWith('/releases/latest')) {
        return new Response(
          JSON.stringify({
            tag_name: 'v9.9.9',
            assets: [
              {
                name: 'kin-kernel',
                size: 64,
                url: 'https://api.github.com/repos/dofastted/vm2api/releases/assets/4',
                digest: DIGEST_64_ZERO,
              },
              {
                name: 'cli-node',
                size: 64,
                url: 'https://api.github.com/repos/dofastted/vm2api/releases/assets/5',
                digest: DIGEST_64_ZERO,
              },
              {
                name: 'cc-node',
                size: 64,
                url: 'https://api.github.com/repos/dofastted/vm2api/releases/assets/6',
                digest: DIGEST_64_ZERO,
              },
              {
                name: 'kin-kernel-crag',
                size: 64,
                url: 'https://api.github.com/repos/dofastted/vm2api/releases/assets/7',
                digest: DIGEST_64_ZERO,
              },
            ],
          }),
          { status: 200 },
        )
      }
      return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/secret' } })
    },
  })
  assert.equal(blocked.ok, false)
  assert.equal(blocked.code, 'kernel_redirect_blocked')
  assert.equal(
    await downloadReleaseKernel({
      tag: 'v1.2;rm',
      fetchImpl: async () => {
        throw new Error('fetched')
      },
    }).then((r) => r.code),
    'kernel_tag_invalid',
  )
})

function releaseWith(files) {
  return async (url) => {
    const href = String(url)
    if (href.endsWith('/releases/latest')) {
      return new Response(
        JSON.stringify({
          tag_name: 'v1.2.3',
          assets: files.map((file) => ({
            name: file.name,
            size: file.bytes.length,
            browser_download_url: `https://github.com/dofastted/vm2api/releases/download/v1.2.3/${file.name}`,
            ...(file.digest === undefined ? {} : { digest: file.digest }),
          })),
        }),
        { status: 200 },
      )
    }
    const file = files.find((f) => href.endsWith(`/download/v1.2.3/${f.name}`))
    if (file) return new Response(file.served ?? file.bytes, { status: 200 })
    throw new Error(`unexpected ${url}`)
  }
}

function releaseFiles(elf) {
  return ['kin-kernel', 'cli-node', 'cc-node', 'kin-kernel-crag'].map((name) => ({
    name,
    bytes: elf,
    digest: sha256Digest(elf),
  }))
}

test('a release asset without a sha256 digest is refused before anything is downloaded', async () => {
  const elf = fakeElf64Amd64()
  for (const digest of [undefined, null, '', 'md5:0123', `sha256:${'g'.repeat(64)}`, 'sha256:abc']) {
    const files = releaseFiles(elf)
    files[1].digest = digest
    let downloads = 0
    const fetchImpl = releaseWith(files)
    const result = await downloadReleaseKernel({
      fetchImpl: async (url, opts) => {
        if (!String(url).endsWith('/releases/latest')) downloads += 1
        return fetchImpl(url, opts)
      },
    })
    assert.equal(result.ok, false, String(digest))
    assert.equal(result.code, 'cli_node_digest_missing', String(digest))
    assert.equal(downloads, 0)
  }
  assert.equal(kernelReleaseHttpStatus('cli_node_digest_missing'), 502)
})

test('bytes that do not hash to the published sha256 are refused', async () => {
  const elf = fakeElf64Amd64()
  const tampered = Buffer.from(elf)
  tampered[63] = 0x01
  for (const index of [0, 1, 2, 3]) {
    const files = releaseFiles(elf)
    files[index].served = tampered
    const result = await downloadReleaseKernel({ fetchImpl: releaseWith(files) })
    assert.equal(result.ok, false)
    assert.equal(result.code, ['kernel', 'cli_node', 'cc_node', 'crag'][index] + '_digest_mismatch')
    assert.equal(result.bytes, undefined)
    assert.equal(kernelReleaseHttpStatus(result.code), 502)
  }
  const upper = releaseFiles(elf).map((file) => ({
    ...file,
    digest: file.digest.toUpperCase().replace('SHA256', 'sha256'),
  }))
  assert.equal((await downloadReleaseKernel({ fetchImpl: releaseWith(upper) })).ok, true)
})
