import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'

/**
 * Subscribes to Supabase auth state and returns the current session/user.
 *
 * @returns {{ session: import('@supabase/supabase-js').Session | null, user: import('@supabase/supabase-js').User | null, loading: boolean }}
 */
export function useAuth() {
  // Start as loading=true until we hear back from getSession()
  const [session, setSession] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    // Fetch the existing session once on mount
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session)
      setLoading(false)
    })

    // Subscribe to future auth changes (sign in, sign out, token refresh)
    const { data: listener } = supabase.auth.onAuthStateChange((_event, newSession) => {
      setSession(newSession)
    })

    return () => {
      listener.subscription.unsubscribe()
    }
  }, []) // runs once — auth client is a stable singleton

  return { session, user: session?.user ?? null, loading }
}
