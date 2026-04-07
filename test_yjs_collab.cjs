/**
 * Test: verifies Supabase Broadcast + Yjs CRDT sync between two clients.
 *
 * Phase 1: Raw broadcast — does Client B receive a message from Client A?
 * Phase 2: Yjs via SupabaseBroadcastProvider — does a Y.Doc update propagate?
 *
 * Usage: node test_yjs_collab.cjs
 */

const { createClient } = require('./frontend/node_modules/@supabase/supabase-js')

const SUPABASE_URL = 'http://127.0.0.1:54321'
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0'

const USER_A_EMAIL = 'alice@example.com'
const USER_B_EMAIL = 'bob@example.com'
const PASSWORD = 'password123'

async function main() {
  // ── Sign in ──────────────────────────────────────────────────────────
  const clientA = createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
  const clientB = createClient(SUPABASE_URL, SUPABASE_ANON_KEY)

  console.log('Signing in User A...')
  const { error: errA } = await clientA.auth.signInWithPassword({ email: USER_A_EMAIL, password: PASSWORD })
  if (errA) { console.error('User A sign-in failed:', errA.message); process.exit(1) }
  console.log('  ✓ User A signed in')

  console.log('Signing in User B...')
  const { error: errB } = await clientB.auth.signInWithPassword({ email: USER_B_EMAIL, password: PASSWORD })
  if (errB) { console.error('User B sign-in failed:', errB.message); process.exit(1) }
  console.log('  ✓ User B signed in')

  // ────────────────────────────────────────────────────────────────────
  // Phase 1: Raw Broadcast test
  // ────────────────────────────────────────────────────────────────────
  console.log('\n═══ Phase 1: Raw Broadcast ═══')

  const CHANNEL_NAME = `test-broadcast-${Date.now()}`
  let rawReceived = false

  const chanB = clientB.channel(CHANNEL_NAME, {
    config: { broadcast: { self: false } },
  })
  chanB.on('broadcast', { event: 'ping' }, (msg) => {
    console.log('  ✅ Client B received raw broadcast:', JSON.stringify(msg))
    rawReceived = true
  })

  const chanA = clientA.channel(CHANNEL_NAME, {
    config: { broadcast: { self: false } },
  })

  // Subscribe both — with timeout
  const subResult = await Promise.race([
    new Promise((resolve) => {
      let count = 0
      const check = (status) => {
        console.log('  Phase 1 subscribe status:', status)
        if (status === 'SUBSCRIBED' && ++count === 2) resolve('ok')
        if (status === 'CLOSED' || status === 'CHANNEL_ERROR') resolve('failed: ' + status)
      }
      chanB.subscribe(check)
      chanA.subscribe(check)
    }),
    new Promise(resolve => setTimeout(() => resolve('timeout'), 8000))
  ])
  console.log('  Subscribe result:', subResult)
  if (subResult !== 'ok') {
    console.log('  ❌ Phase 1 failed to subscribe. Broadcast may not be supported or Realtime is down.')
    cleanup()
    return
  }
  console.log('  Both clients subscribed to:', CHANNEL_NAME)

  // Give channels a moment to stabilise
  await new Promise(r => setTimeout(r, 500))

  console.log('  Client A sending broadcast...')
  const sendResult = await chanA.send({
    type: 'broadcast',
    event: 'ping',
    payload: { hello: 'world', ts: Date.now() },
  })
  console.log('  send() returned:', JSON.stringify(sendResult))

  // Wait up to 5 seconds
  await new Promise(r => setTimeout(r, 5000))

  if (!rawReceived) {
    console.log('  ❌ Raw broadcast NOT received. Broadcast delivery is broken.')
    console.log('     → Check Supabase Realtime server logs.')
    cleanup()
    return
  }

  clientA.removeChannel(chanA)
  clientB.removeChannel(chanB)

  // ────────────────────────────────────────────────────────────────────
  // Phase 2: Yjs over Broadcast
  // ────────────────────────────────────────────────────────────────────
  console.log('\n═══ Phase 2: Yjs over Broadcast ═══')

  // Dynamic import for ESM modules
  const Y = await import('./frontend/node_modules/yjs/dist/yjs.mjs')
  const { fromUint8Array, toUint8Array } = await import('./frontend/node_modules/js-base64/base64.mjs')

  const DOC_CHANNEL = `doc-collab-test-${Date.now()}`
  let yjsReceived = false

  // Client B: Y.Doc + channel
  const ydocB = new Y.Doc()
  const ytextB = ydocB.getText('content')
  ytextB.insert(0, 'initial content')

  const chanB2 = clientB.channel(DOC_CHANNEL, {
    config: { broadcast: { self: false } },
  })
  chanB2.on('broadcast', { event: 'yjs-update' }, ({ payload }) => {
    console.log('  Client B received yjs-update, payload keys:', Object.keys(payload))
    try {
      const update = toUint8Array(payload.update)
      console.log('  Decoded update length:', update.length)
      Y.applyUpdate(ydocB, update, 'remote')
      const text = ytextB.toString()
      console.log('  ✅ Client B Y.Text after apply:', JSON.stringify(text))
      yjsReceived = true
    } catch (err) {
      console.error('  ❌ Error applying update:', err.message)
    }
  })

  // Client A: Y.Doc + channel
  const ydocA = new Y.Doc()
  const ytextA = ydocA.getText('content')
  ytextA.insert(0, 'initial content')

  const chanA2 = clientA.channel(DOC_CHANNEL, {
    config: { broadcast: { self: false } },
  })

  // Broadcast A's updates
  ydocA.on('update', (update, origin) => {
    if (origin === 'remote') return
    console.log('  Client A ydoc update fired, origin:', origin, 'length:', update.length)
    chanA2.send({
      type: 'broadcast',
      event: 'yjs-update',
      payload: { update: fromUint8Array(update) },
    })
  })

  // Subscribe both — with timeout
  const subResult2 = await Promise.race([
    new Promise((resolve) => {
      let count = 0
      const check = (status) => {
        console.log('  Phase 2 subscribe status:', status)
        if (status === 'SUBSCRIBED' && ++count === 2) resolve('ok')
        if (status === 'CLOSED' || status === 'CHANNEL_ERROR') resolve('failed: ' + status)
      }
      chanB2.subscribe(check)
      chanA2.subscribe(check)
    }),
    new Promise(resolve => setTimeout(() => resolve('timeout'), 8000))
  ])
  console.log('  Subscribe result:', subResult2)
  if (subResult2 !== 'ok') {
    console.log('  ❌ Phase 2 failed to subscribe.')
    cleanup()
    return
  }
  console.log('  Both clients subscribed to Yjs channel:', DOC_CHANNEL)

  await new Promise(r => setTimeout(r, 500))

  // Client A types " — hello from A"
  console.log('  Client A inserting text...')
  ytextA.insert(ytextA.toString().length, ' — hello from A')
  console.log('  Client A Y.Text:', JSON.stringify(ytextA.toString()))

  // Wait up to 5 seconds
  await new Promise(r => setTimeout(r, 5000))

  if (yjsReceived) {
    const finalB = ytextB.toString()
    const finalA = ytextA.toString()
    console.log('\n  Client A final:', JSON.stringify(finalA))
    console.log('  Client B final:', JSON.stringify(finalB))
    if (finalA === finalB) {
      console.log('  ✅ Both docs converged!')
    } else {
      console.log('  ❌ Docs diverged!')
    }
  } else {
    console.log('  ❌ Yjs update NOT received by Client B within 5 seconds.')
  }

  cleanup()

  function cleanup() {
    clientA.removeChannel(chanA2)
    clientB.removeChannel(chanB2)
    ydocA.destroy()
    ydocB.destroy()
    setTimeout(() => process.exit(rawReceived && yjsReceived ? 0 : 1), 500)
  }
}

main().catch(err => { console.error(err); process.exit(1) })
