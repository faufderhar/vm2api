import { useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { onboardingQueryOptions } from '@/features/welcome/queries'

/** First sign-in with the guide unused: send the operator to the setup guide. */
export function GuideGate() {
  const navigate = useNavigate()
  const onboarding = useQuery(onboardingQueryOptions())
  const unused = onboarding.data?.guide_used === false
  useEffect(() => {
    if (!unused) return
    void navigate({ to: '/welcome', search: { setup: true }, replace: true })
  }, [unused, navigate])
  return null
}
