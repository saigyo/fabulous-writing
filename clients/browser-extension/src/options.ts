import { DEFAULT_SERVER_URL, getServerUrl, normalizeServerUrl, setServerUrl } from './settings'

export async function initOptions(): Promise<void> {
  const root = document.getElementById('root')!
  root.innerHTML = ''

  // Create the form elements
  const label = document.createElement('label')
  label.textContent = 'Server URL:'

  const input = document.createElement('input')
  input.type = 'url'
  input.value = await getServerUrl()

  const note = document.createElement('div')
  note.textContent = 'Your Fabulous Writing server. The panel reloads on change.'
  note.style.fontSize = '0.875rem'
  note.style.marginTop = '0.5rem'
  note.style.color = '#666'

  const saveBtn = document.createElement('button')
  saveBtn.textContent = 'Save'
  saveBtn.setAttribute('data-action', 'save')

  const resetBtn = document.createElement('button')
  resetBtn.textContent = 'Reset to default'
  resetBtn.setAttribute('data-action', 'reset')

  const statusLine = document.createElement('div')
  statusLine.setAttribute('role', 'status')
  statusLine.textContent = ''

  // Event handlers
  saveBtn.addEventListener('click', async () => {
    const normalized = normalizeServerUrl(input.value)
    if (normalized) {
      await setServerUrl(normalized)
      statusLine.textContent = 'Saved'
    } else {
      statusLine.textContent = 'Invalid URL format. Use http://localhost:8100 or https://example.com'
    }
  })

  resetBtn.addEventListener('click', async () => {
    await setServerUrl(DEFAULT_SERVER_URL)
    input.value = DEFAULT_SERVER_URL
    statusLine.textContent = ''
  })

  // Assemble the form
  const form = document.createElement('div')
  form.style.display = 'flex'
  form.style.flexDirection = 'column'
  form.style.gap = '1rem'
  form.style.padding = '1rem'

  form.appendChild(label)
  form.appendChild(input)
  form.appendChild(note)

  const buttonContainer = document.createElement('div')
  buttonContainer.style.display = 'flex'
  buttonContainer.style.gap = '0.5rem'
  buttonContainer.appendChild(saveBtn)
  buttonContainer.appendChild(resetBtn)

  form.appendChild(buttonContainer)
  form.appendChild(statusLine)

  root.appendChild(form)
}

initOptions().catch(console.error)
console.debug('fw: options loaded')
