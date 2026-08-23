import { describe, expect, it, beforeEach } from 'vitest'
import { DEFAULT_SERVER_URL, getServerUrl, setServerUrl } from './settings'
import { initOptions } from './options'

async function setupOptions(): Promise<{
  input: HTMLInputElement
  saveBtn: HTMLButtonElement
  resetBtn: HTMLButtonElement
  statusLine: HTMLElement
}> {
  // Initialize the options page
  await initOptions()

  const root = document.getElementById('root')!

  // Get references to the elements
  const input = root.querySelector('input[type="url"]') as HTMLInputElement
  const saveBtn = root.querySelector('button[data-action="save"]') as HTMLButtonElement
  const resetBtn = root.querySelector('button[data-action="reset"]') as HTMLButtonElement
  const statusLine = root.querySelector('[role="status"]') as HTMLElement

  return { input, saveBtn, resetBtn, statusLine }
}

describe('options page', () => {
  beforeEach(() => {
    // Ensure root div exists
    if (!document.getElementById('root')) {
      const root = document.createElement('div')
      root.id = 'root'
      document.body.appendChild(root)
    }
  })

  it('renders with the input prefilled from storage', async () => {
    await setServerUrl('https://fw.example')
    const { input } = await setupOptions()
    expect(input.value).toBe('https://fw.example')
  })

  it('prefills with DEFAULT_SERVER_URL when storage is empty', async () => {
    // Storage is reset by beforeEach in vitest.setup.ts
    const { input } = await setupOptions()
    expect(input.value).toBe(DEFAULT_SERVER_URL)
  })

  it('Save with a valid URL persists via setServerUrl and shows "Saved"', async () => {
    const { input, saveBtn, statusLine } = await setupOptions()

    input.value = 'http://localhost:8100'
    saveBtn.click()

    // Check that it was persisted
    const stored = await getServerUrl()
    expect(stored).toBe('http://localhost:8100')

    // Check that status shows "Saved"
    expect(statusLine.textContent).toBe('Saved')
  })

  it('Save with an invalid URL shows validation message and does NOT persist', async () => {
    await setServerUrl('https://fw.example')
    const { input, saveBtn, statusLine } = await setupOptions()

    input.value = 'fw.example'
    saveBtn.click()

    // Storage should still have the original value
    const stored = await getServerUrl()
    expect(stored).toBe('https://fw.example')

    // Status should show the validation message (not "Saved")
    expect(statusLine.textContent).not.toBe('Saved')
    expect(statusLine.textContent).toBeTruthy()
  })

  it('Reset writes DEFAULT_SERVER_URL', async () => {
    await setServerUrl('https://fw.example')
    const { resetBtn } = await setupOptions()

    resetBtn.click()

    // Check that storage was updated to DEFAULT_SERVER_URL
    const stored = await getServerUrl()
    expect(stored).toBe(DEFAULT_SERVER_URL)
  })
})
