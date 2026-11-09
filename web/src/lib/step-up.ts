type StepUpPrompt = () => Promise<boolean>

let prompt: StepUpPrompt | null = null
let pending: Promise<boolean> | null = null

export function setStepUpPrompt(next: StepUpPrompt | null) {
  prompt = next
}

/**
 * Resolves true once the session has confirmed its password. Concurrent refusals
 * share one dialog. With no dialog mounted the caller keeps the refusal it got.
 */
export function askStepUp(): Promise<boolean> {
  if (!prompt) return Promise.resolve(false)
  if (!pending) {
    pending = prompt().finally(() => {
      pending = null
    })
  }
  return pending
}
