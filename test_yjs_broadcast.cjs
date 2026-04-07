/**
 * Focused test: Yjs CRDT sync over Supabase Broadcast between two clients.
 * Uses fresh clients — no prior channel recycling.
 *
 * Usage: node test_yjs_broadcast.cjs
 */

const { createClient } = require('./frontend/node_modules/@supabase/supabase-js')

const SUPABASE_URL = 'http://127.0.0.1:54321'
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0'

const USER_A_EMAIL = 'alice@example.com'
const USER_B_EMAIL = 'bob@example.com'
const PASSWORD = 'password123'

async function main() {
  const Y = await import('./frontend/node_modules/yjs/dist/yjs.mjs')
  const { fromUint8Array, toUint8Array } = await import('./frontend/node_modules/js-base64/base64.mjs')

  const clientA = createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
  const clientB = createClient(SUPABASE_URL, SUPABASE_ANON_KEY)

  console.log('Signing in...')
  const { error: errA } = await clientA.auth.signInWithPassword({ email: USER_A_EMAIL, password: PASSWORD })
  if (errA) { console.error('User A sign-in failed:', errA.message); process.exit(1) }
  const { error: errB } = await clientB.auth.signInWithPassword({ email: USER_B_EMAIL, password: PASSWORD })
  if (errB) { console.error('User B sign-in failed:', errB.message); process.exit(1) }
  console.log('Both users signed in.')

  const CHANNEL = `doc-collab-yjs-test-${Date.now()}`
  let received = false

  // ── Client A: create the "source of truth" Y.Doc ──────────────────────
  // In the real app, when yjs_state is persisted, both clients load from it
  // and get identical CRDT structure.  When it's NULL (legacy), only ONE
  // client should seed — the other gets state via sync-request/response.
  const ydocA = new Y.Doc()
  const ytextA = ydocA.getText('content')
  ytextA.insert(0, 'initial')

  // Simulate persisting the state then loading on Client B
  const sharedState = Y.encodeStateAsUpdate(ydocA)
  console.log('Shared CRDT state size:', sharedState.length, 'bytes')

  // ── Client B: load from the same persisted CRDT state ─────────────────
  const ydocB = new Y.Doc()
  const ytextB = ydocB.getText('content')
  Y.applyUpdate(ydocB, sharedState)
  console.log('[B] After loading shared state, ytextB:', JSON.stringify(ytextB.toString()))

  // ── Channels ───────────────────────────────────────────────────────────
  const chanB = clientB.channel(CHANNEL, { config: { broadcast: { self: false } } })
  chanB.on('broadcast', { event: 'yjs-update' }, ({ payload }) => {
    console.log('[B] Received yjs-update, update length (base64):', payload.update.length)
    try {
      const update = toUint8Array(payload.update)
      Y.applyUpdate(ydocB, update, 'remote')
      console.log('[B] After apply, ytextB:', JSON.stringify(ytextB.toString()))
      received = true
    } catch (err) {
      console.error('[B] Error applying update:', err.message)
    }
  })

  const chanA = clientA.channel(CHANNEL, { config: { broadcast: { self: false } } })
  chanA.on('broadcast', { event: 'yjs-update' }, ({ payload }) => {
    console.log('[A] Received yjs-update (from B)')
  })

  ydocA.on('update', (update, origin) => {
    if (origin === 'remote') return
    console.log('[A] ydoc update, origin:', JSON.stringify(origin), 'len:', update.length)
    const encoded = fromUint8Array(update)
    console.log('[A] Broadcasting update, base64 length:', encoded.length)
    chanA.send({
      type: 'broadcast',
      event: 'yjs-update',
      payload: { update: encoded },
    }).then(result => {
      console.log('[A] send() result:', result)
    }).catch(err => {
      console.error('[A] send() error:', err)
    })
  })

  // ── Subscribe both ────────────────────────────────────────────────────
  console.log('\nSubscribing to channel:', CHANNEL)
  const subOk = await new Promise((resolve) => {
    let count = 0
    const check = (label) => (status) => {
      console.log(`[${label}] subscribe status: ${status}`)
      if (status === 'SUBSCRIBED' && ++count === 2) resolve(true)
      if (status === 'CLOSED' || status === 'CHANNEL_ERROR') resolve(false)
    }
    chanB.subscribe(check('B'))
    chanA.subscribe(check('A'))
    setTimeout(() => resolve(false), 10000)
  })

  if (!subOk) {
    console.log('\nFailed to subscribe. Aborting.')
    process.exit(1)
  }
  console.log('Both subscribed.\n')

  // Give the channels a moment to stabilise
  await new Promise(r => setTimeout(r, 1000))

  // Check channel states
  console.log('[A] channel state:', chanA.state)
  console.log('[B] channel state:', chanB.state)

  // ── Client A types ────────────────────────────────────────────────────
  console.log('\n[A] Inserting " world" into ytext...')
  ytextA.insert(ytextA.toString().length, ' world')
  console.log('[A] ytextA:', JSON.stringify(ytextA.toString()))

  // Wait up to 5 seconds for B to receive
  for (let i = 0; i < 50 && !received; i++) {
    await new Promise(r => setTimeout(r, 100))
  }

  console.log('\n── Results ──')
  console.log('[A] ytextA:', JSON.stringify(ytextA.toString()))
  console.log('[B] ytextB:', JSON.stringify(ytextB.toString()))

  if (received && ytextA.toString() === ytextB.toString()) {
    console.log('✅ SUCCESS: Both docs converged.')
  } else if (received) {
    console.log('⚠️  B received update but docs diverged.')
  } else {
    console.log('❌ FAIL: B never received the update.')
  }

  clientA.removeChannel(chanA)
  clientB.removeChannel(chanB)
  ydocA.destroy()
  ydocB.destroy()
  setTimeout(() => process.exit(received ? 0 : 1), 500)
}

main().catch(err => { console.error(err); process.exit(1) })
