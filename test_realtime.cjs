/*
 * Test script: verifies Realtime event delivery for shared documents.
 *
 * Creates two authenticated Supabase clients (User A = owner, User B = shared user).
 * User B subscribes to documents Realtime UPDATE events.
 * User A updates a document.
 * If User B receives the event within 10 seconds → Realtime works.
 *
 * Usage: node test_realtime.cjs
 * Requires: seed data with users and a document share (migration _017 + seed.sql).
 */

const { createClient } = require('@supabase/supabase-js')

const SUPABASE_URL = 'http://127.0.0.1:54321'
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0'

// Seed data credentials (from seed.sql)
const USER_A_EMAIL = 'alice@test.com'  // adjust to match your seed
const USER_B_EMAIL = 'bob@test.com'    // adjust to match your seed
const PASSWORD = 'Password1!'          // adjust to match your seed

async function main() {
  const clientA = createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
  const clientB = createClient(SUPABASE_URL, SUPABASE_ANON_KEY)

  // Sign in both users
  console.log('Signing in User A...')
  const { data: authA, error: errA } = await clientA.auth.signInWithPassword({
    email: USER_A_EMAIL, password: PASSWORD
  })
  if (errA) { console.error('User A sign-in failed:', errA.message); process.exit(1) }
  console.log('  User A ID:', authA.user.id)

  console.log('Signing in User B...')
  const { data: authB, error: errB } = await clientB.auth.signInWithPassword({
    email: USER_B_EMAIL, password: PASSWORD
  })
  if (errB) { console.error('User B sign-in failed:', errB.message); process.exit(1) }
  console.log('  User B ID:', authB.user.id)

  // Find a document owned by User A that is shared with User B
  const { data: shares } = await clientB.from('document_shares')
    .select('document_id, permission')
    .eq('shared_with_id', authB.user.id)
    .limit(1)
    .single()

  if (!shares) {
    console.error('No shared document found. Check seed data.')
    process.exit(1)
  }
  const docId = shares.document_id
  console.log(`\nShared document ID: ${docId} (permission: ${shares.permission})`)

  // User B subscribes to Realtime UPDATE on this document
  let received = false
  console.log('\nUser B subscribing to Realtime on documents...')

  const channel = clientB
    .channel(`test-rt-${docId}`)
    .on(
      'postgres_changes',
      { event: 'UPDATE', schema: 'public', table: 'documents', filter: `id=eq.${docId}` },
      (payload) => {
        received = true
        console.log('\n✅ User B RECEIVED Realtime UPDATE event!')
        console.log('  new title:', payload.new.title)
        console.log('  new body:', payload.new.body?.slice(0, 80))
        cleanup()
      }
    )
    .subscribe((status) => {
      console.log('  Subscription status:', status)
    })

  // Wait for subscription to be ready
  await new Promise(r => setTimeout(r, 3000))

  // User A updates the document
  const newTitle = `RT Test ${Date.now()}`
  console.log(`\nUser A updating document ${docId} title to "${newTitle}"...`)
  const { error: updateErr } = await clientA
    .from('documents')
    .update({ title: newTitle })
    .eq('id', docId)

  if (updateErr) {
    console.error('Update failed:', updateErr.message)
    cleanup()
    return
  }
  console.log('  Update succeeded. Waiting for Realtime event...')

  // Wait up to 10 seconds for the event
  await new Promise(r => setTimeout(r, 10000))

  if (!received) {
    console.log('\n❌ User B did NOT receive the Realtime event within 10 seconds.')
    console.log('   This confirms the Realtime delivery bug.')
  }

  cleanup()

  function cleanup() {
    clientB.removeChannel(channel)
    setTimeout(() => process.exit(received ? 0 : 1), 500)
  }
}

main().catch(err => { console.error(err); process.exit(1) })
