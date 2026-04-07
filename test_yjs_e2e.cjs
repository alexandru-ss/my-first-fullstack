/**
 * End-to-end test: simulates two clients using SupabaseBroadcastProvider.
 *
 * Test 1: Both clients load from the same persisted yjs_state → type → sync
 * Test 2: Legacy doc (no yjs_state) — first client seeds, second gets state via sync-request
 *
 * Usage: node test_yjs_e2e.cjs
 */

const { createClient } = require('./frontend/node_modules/@supabase/supabase-js')

const SUPABASE_URL = 'http://127.0.0.1:54321'
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0'

const USER_A_EMAIL = 'alice@example.com'
const USER_B_EMAIL = 'bob@example.com'
const PASSWORD = 'password123'

function wait(ms) { return new Promise(r => setTimeout(r, ms)) }

async function main() {
  const Y = await import('./frontend/node_modules/yjs/dist/yjs.mjs')
  const { fromUint8Array, toUint8Array } = await import('./frontend/node_modules/js-base64/base64.mjs')
  // Dynamic import of the ESM provider
  const { SupabaseBroadcastProvider } = await import('./frontend/src/lib/SupabaseBroadcastProvider.js')

  const clientA = createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
  const clientB = createClient(SUPABASE_URL, SUPABASE_ANON_KEY)

  console.log('Signing in...')
  const { error: errA } = await clientA.auth.signInWithPassword({ email: USER_A_EMAIL, password: PASSWORD })
  if (errA) { console.error('User A sign-in failed:', errA.message); process.exit(1) }
  const { error: errB } = await clientB.auth.signInWithPassword({ email: USER_B_EMAIL, password: PASSWORD })
  if (errB) { console.error('User B sign-in failed:', errB.message); process.exit(1) }
  console.log('Both users signed in.\n')

  let allPassed = true

  // ═══════════════════════════════════════════════════════════════════════
  // Test 1: Both clients load from persisted yjs_state
  // ═══════════════════════════════════════════════════════════════════════
  console.log('═══ Test 1: Shared persisted yjs_state ═══')
  {
    // Simulate a saved document with yjs_state
    const seedDoc = new Y.Doc()
    seedDoc.getText('content').insert(0, 'Hello from database')
    const persistedState = Y.encodeStateAsUpdate(seedDoc)
    seedDoc.destroy()

    const docId = 'test1-' + Date.now()

    // Client A: load from persisted state
    const ydocA = new Y.Doc()
    Y.applyUpdate(ydocA, persistedState)
    console.log('[A] Loaded from yjs_state:', JSON.stringify(ydocA.getText('content').toString()))

    const providerA = new SupabaseBroadcastProvider(clientA, docId, ydocA)
    await wait(2000) // Wait for A to subscribe + no-peers timeout

    // Client B: load from same persisted state + connect
    const ydocB = new Y.Doc()
    Y.applyUpdate(ydocB, persistedState)
    console.log('[B] Loaded from yjs_state:', JSON.stringify(ydocB.getText('content').toString()))

    let bSynced = false
    const providerB = new SupabaseBroadcastProvider(clientB, docId, ydocB)
    providerB.on('synced', () => { bSynced = true; console.log('[B] Received sync from A') })
    await wait(2000)
    console.log('[B] Provider synced:', bSynced)

    // Client A types
    console.log('[A] Inserting " - edited"...')
    ydocA.getText('content').insert(ydocA.getText('content').toString().length, ' - edited')
    await wait(2000)

    const textA = ydocA.getText('content').toString()
    const textB = ydocB.getText('content').toString()
    console.log('[A] text:', JSON.stringify(textA))
    console.log('[B] text:', JSON.stringify(textB))

    if (textA === textB && textA === 'Hello from database - edited') {
      console.log('✅ Test 1 PASSED\n')
    } else {
      console.log('❌ Test 1 FAILED\n')
      allPassed = false
    }

    providerA.destroy()
    providerB.destroy()
    ydocA.destroy()
    ydocB.destroy()
  }

  await wait(1000)

  // ═══════════════════════════════════════════════════════════════════════
  // Test 2: Legacy doc — no yjs_state, seed from body via no-peers
  // ═══════════════════════════════════════════════════════════════════════
  console.log('═══ Test 2: Legacy doc (no yjs_state) ═══')
  {
    const docId = 'test2-' + Date.now()

    // Client A opens legacy doc: empty Y.Doc, waits for no-peers to seed
    const ydocA = new Y.Doc()
    const ytextA = ydocA.getText('content')
    console.log('[A] Created empty Y.Doc (legacy mode)')

    let aNoPeers = false
    const providerA = new SupabaseBroadcastProvider(clientA, docId, ydocA)
    providerA.on('no-peers', () => {
      aNoPeers = true
      console.log('[A] no-peers fired — seeding from body')
      ytextA.insert(0, 'Legacy document content')
    })

    // Wait for A to get no-peers and seed
    await wait(2500)
    console.log('[A] Seeded:', aNoPeers, 'text:', JSON.stringify(ytextA.toString()))

    // Client B opens same doc (no yjs_state): empty Y.Doc, relies on sync-request
    const ydocB = new Y.Doc()
    const ytextB = ydocB.getText('content')
    console.log('[B] Created empty Y.Doc (legacy mode)')

    let bSynced = false
    const providerB = new SupabaseBroadcastProvider(clientB, docId, ydocB)
    providerB.on('synced', () => {
      bSynced = true
      console.log('[B] Received sync from A, text:', JSON.stringify(ytextB.toString()))
    })
    providerB.on('no-peers', () => {
      console.log('[B] no-peers fired (should NOT seed — A should have responded!)')
    })

    await wait(2500)
    console.log('[B] synced:', bSynced, 'text:', JSON.stringify(ytextB.toString()))

    // Client A types more
    console.log('[A] Inserting " - updated"...')
    ytextA.insert(ytextA.toString().length, ' - updated')
    await wait(2000)

    const textA = ytextA.toString()
    const textB = ytextB.toString()
    console.log('[A] text:', JSON.stringify(textA))
    console.log('[B] text:', JSON.stringify(textB))

    if (textA === textB && textA === 'Legacy document content - updated') {
      console.log('✅ Test 2 PASSED\n')
    } else {
      console.log('❌ Test 2 FAILED\n')
      allPassed = false
    }

    providerA.destroy()
    providerB.destroy()
    ydocA.destroy()
    ydocB.destroy()
  }

  console.log(allPassed ? '\n✅ ALL TESTS PASSED' : '\n❌ SOME TESTS FAILED')
  setTimeout(() => process.exit(allPassed ? 0 : 1), 500)
}

main().catch(err => { console.error(err); process.exit(1) })
