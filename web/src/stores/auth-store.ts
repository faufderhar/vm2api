import type { MeResponse } from '@/types/panel-auth'
import { create } from 'zustand'
import { logoutRequest } from '@/lib/api'
import { clearSession, hasSession, setSession, storedUser } from '@/lib/session'

type AuthState = {
  token: string
  user: string
  me: MeResponse | null
  setMe: (me: MeResponse | null) => void
  signIn: (user: string) => void
  signOut: () => void
}

export const useAuthStore = create<AuthState>()((set) => ({
  token: '',
  user: storedUser(),
  me: null,
  setMe: (me) =>
    set({
      me,
      user: me?.user || storedUser(),
    }),
  signIn: (user) => {
    setSession(user)
    set({ token: '', user, me: null })
  },
  signOut: () => {
    logoutRequest()
    clearSession()
    set({ token: '', user: '', me: null })
  },
}))

export function isSignedIn(): boolean {
  return hasSession()
}
