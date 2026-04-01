// bundle-barrel-imports: import createClient directly, not from a barrel re-export
import { createClient } from '@supabase/supabase-js'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error(
    'Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY in .env',
  )
}

// Module-level singleton — one client for the entire app lifetime
/** @type {import('@supabase/supabase-js').SupabaseClient<import('../database.types').Database>} */
export const supabase = createClient(supabaseUrl, supabaseAnonKey)
