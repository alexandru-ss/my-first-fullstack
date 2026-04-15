/**
 * DEBUG TEST: Isolate the exact realtime sync failure.
 *
 * Tests THREE independent transport layers:
 *   1. Broadcast channel (yjs-update events) — both directions
 *   2. postgres_changes on documents table — from owner's save
 *   3. Full Yjs provider flow — provider A↔B end-to-end
 *
 * Each test logs EVERY state change so we can pinpoint exactly what fails.
 *
 * Usage: node test_debug_realtime.cjs
 */

const { createClient } = require('./frontend/node_modules/@supabase/supabase-js')

const SUPABASE_URL = 'http://127.0.0.1:54321'
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0'

const USER_A_EMAIL = 'alice@example.com'
const USER_B_EMAIL = 'bob@example.com'
const PASSWORD = 'password123'

function wait(ms) { return new Promise(r => setTimeout(r, ms)) }

let Y, fromUint8Array, toUint8Array, SupabaseBroadcastProvider
let clientA, clientB, userAId, userBId

async function setup() {
  Y = await import('./frontend/node_modules/yjs/dist/yjs.mjs')
  const base64 = await import('./frontend/node_modules/js-base64/base64.mjs')
  fromUint8Array = base64.fromUint8Array
  toUint8Array = base64.toUint8Array
  const provider = await import('./frontend/src/lib/SupabaseBroadcastProvider.js')
  SupabaseBroadcastProvider = provider.SupabaseBroadcastProvider

  clientA = createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
  clientB = createClient(SUPABASE_URL, SUPABASE_ANON_KEY)

  const { data: dA, error: eA } = await clientA.auth.signInWithPassword({ email: USER_A_EMAIL, password: PASSWORD })
  if (eA) throw new Error('User A sign-in failed: ' + eA.message)
  userAId = dA.user.id

  const { data: dB, error: eB } = await clientB.auth.signInWithPassword({ email: USER_B_EMAIL, password: PASSWORD })
  if (eB) throw new Error('User B sign-in failed: ' + eB.message)
  userBId = dB.user.id

  console.log(`Signed in: Alice=${userAId.slice(0,8)}… Bob=${userBId.slice(0,8)}…`)
}

async function createSharedDoc(title, body) {
  const { data: doc, error } = await clientA
    .from('documents')
    .insert({ user_id: userAId, title, body })
    .select('id, title, body, yjs_state')
    .single()
  if (error) throw new Error('Create doc failed: ' + error.message)

  const { error: shareErr } = await clientA
    .from('document_shares')
    .insert({
      document_id: doc.id,
      owner_id: userAId,
      shared_with_id: userBId,
      shared_with_email: USER_B_EMAIL,
      permission: 'edit',
    })
  if (shareErr) throw new Error('Share doc failed: ' + shareErr.message)

  return doc
}

// ═══════════════════════════════════════════════════════════════════════════
// TEST 1: Raw Broadcast — can two clients exchange broadcast messages?
// ═══════════════════════════════════════════════════════════════════════════
async function testRawBroadcast() {
  console.log('\n══════════════════════════════════════════════════════')
  console.log('TEST 1: Raw Broadcast Channel')
  console.log('══════════════════════════════════════════════════════')

  const channelName = `test-broadcast-${Date.now()}`
  const received = { a: [], b: [] }

  // Client A channel
  const chA = clientA.channel(channelName, { config: { broadcast: { self: false } } })
  chA.on('broadcast', { event: 'ping' }, ({ payload }) => {
    console.log(`  [A] RECEIVED broadcast 'ping': ${JSON.stringify(payload)}`)
    received.a.push(payload)
  })

  // Client B channel
  const chB = clientB.channel(channelName, { config: { broadcast: { self: false } } })
  chB.on('broadcast', { event: 'ping' }, ({ payload }) => {
    console.log(`  [B] RECEIVED broadcast 'ping': ${JSON.stringify(payload)}`)
    received.b.push(payload)
  })

  // Subscribe both
  let statusA = null, statusB = null
  chA.subscribe((s) => { statusA = s; console.log(`  [A] channel status: ${s}`) })
  chB.subscribe((s) => { statusB = s; console.log(`  [B] channel status: ${s}`) })

  await wait(3000)
  console.log(`  [A] final status: ${statusA}`)
  console.log(`  [B] final status: ${statusB}`)

  if (statusA !== 'SUBSCRIBED' || statusB !== 'SUBSCRIBED') {
    console.log('  ❌ FAILURE POINT: Channel subscription failed')
    clientA.removeChannel(chA); clientB.removeChannel(chB)
    return false
  }

  // A sends to B
  console.log('  [A] Sending broadcast ping → B …')
  chA.send({ type: 'broadcast', event: 'ping', payload: { from: 'A', msg: 'hello' } })
  await wait(2000)

  if (received.b.length === 0) {
    console.log('  ❌ FAILURE POINT A: Broadcast NOT received by B')
  } else {
    console.log(`  ✅ B received ${received.b.length} message(s) from A`)
  }

  // B sends to A
  console.log('  [B] Sending broadcast ping → A …')
  chB.send({ type: 'broadcast', event: 'ping', payload: { from: 'B', msg: 'world' } })
  await wait(2000)

  if (received.a.length === 0) {
    console.log('  ❌ FAILURE POINT B: Broadcast NOT received by A')
  } else {
    console.log(`  ✅ A received ${received.a.length} message(s) from B`)
  }

  clientA.removeChannel(chA)
  clientB.removeChannel(chB)

  const ok = received.a.length > 0 && received.b.length > 0
  console.log(ok ? '  ✅ TEST 1 PASSED: Broadcast works' : '  ❌ TEST 1 FAILED: Broadcast broken')
  return ok
}

// ═══════════════════════════════════════════════════════════════════════════
// TEST 2: postgres_changes — does the shared user receive UPDATE events?
// ═══════════════════════════════════════════════════════════════════════════
async function testPostgresChanges() {
  console.log('\n══════════════════════════════════════════════════════')
  console.log('TEST 2: postgres_changes on documents table')
  console.log('══════════════════════════════════════════════════════')

  const doc = await createSharedDoc('Debug-PG-' + Date.now(), 'initial body')
  console.log(`  Created doc id=${doc.id}`)

  const receivedByA = []
  const receivedByB = []

  // Owner (A) subscribes to postgres_changes
  const chA = clientA.channel(`debug-pg-a-${doc.id}`)
    .on('postgres_changes',
      { event: 'UPDATE', schema: 'public', table: 'documents', filter: `id=eq.${doc.id}` },
      (payload) => {
        console.log(`  [A] postgres_changes UPDATE received! title=${payload.new?.title}, body=${payload.new?.body?.slice(0,50)}…, has yjs_state=${payload.new?.yjs_state != null}`)
        receivedByA.push(payload)
      })

  // Shared user (B) subscribes to postgres_changes
  const chB = clientB.channel(`debug-pg-b-${doc.id}`)
    .on('postgres_changes',
      { event: 'UPDATE', schema: 'public', table: 'documents', filter: `id=eq.${doc.id}` },
      (payload) => {
        console.log(`  [B] postgres_changes UPDATE received! title=${payload.new?.title}, body=${payload.new?.body?.slice(0,50)}…, has yjs_state=${payload.new?.yjs_state != null}`)
        receivedByB.push(payload)
      })

  let statusA = null, statusB = null
  chA.subscribe((s) => { statusA = s; console.log(`  [A] pg_changes channel status: ${s}`) })
  chB.subscribe((s) => { statusB = s; console.log(`  [B] pg_changes channel status: ${s}`) })

  await wait(3000)
  console.log(`  [A] final status: ${statusA}`)
  console.log(`  [B] final status: ${statusB}`)

  if (statusA !== 'SUBSCRIBED' || statusB !== 'SUBSCRIBED') {
    console.log('  ❌ FAILURE POINT: postgres_changes subscription failed')
    clientA.removeChannel(chA); clientB.removeChannel(chB)
    return false
  }

  // Owner updates the document
  console.log('  [A] Updating document body via Supabase client…')
  const { error: updErr } = await clientA
    .from('documents')
    .update({ body: 'updated body from alice', title: 'Debug-PG-Updated' })
    .eq('id', doc.id)
  if (updErr) {
    console.log(`  ❌ Update failed: ${updErr.message}`)
    clientA.removeChannel(chA); clientB.removeChannel(chB)
    return false
  }
  console.log('  [A] Update sent, waiting for events…')
  await wait(3000)

  console.log(`  [A] received ${receivedByA.length} event(s)`)
  console.log(`  [B] received ${receivedByB.length} event(s)`)

  if (receivedByA.length === 0) {
    console.log('  ❌ FAILURE: Owner did NOT receive postgres_changes UPDATE')
  } else {
    console.log('  ✅ Owner received postgres_changes UPDATE')
  }

  if (receivedByB.length === 0) {
    console.log('  ❌ FAILURE: Shared user did NOT receive postgres_changes UPDATE')
    console.log('  → This means RLS blocks the shared user from seeing the Realtime event')
    console.log('  → Check documents SELECT policy allows shared users')
  } else {
    console.log('  ✅ Shared user received postgres_changes UPDATE')
  }

  clientA.removeChannel(chA); clientB.removeChannel(chB)

  const ok = receivedByA.length > 0 && receivedByB.length > 0
  console.log(ok ? '  ✅ TEST 2 PASSED' : '  ❌ TEST 2 FAILED')
  return ok
}

// ═══════════════════════════════════════════════════════════════════════════
// TEST 3: Yjs Provider — full end-to-end sync
// ═══════════════════════════════════════════════════════════════════════════
async function testYjsProvider() {
  console.log('\n══════════════════════════════════════════════════════')
  console.log('TEST 3: Yjs SupabaseBroadcastProvider end-to-end')
  console.log('══════════════════════════════════════════════════════')

  const doc = await createSharedDoc('Debug-Yjs-' + Date.now(), 'yjs test body')
  console.log(`  Created doc id=${doc.id}`)

  // Seed a Y.Doc with the body so Alice has content
  const ydocA = new Y.Doc()
  const ytextA = ydocA.getText('content')

  console.log('  [A] Creating provider…')
  const provA = new SupabaseBroadcastProvider(clientA, doc.id, ydocA)

  let aSynced = false, aNoPeers = false
  provA.on('synced', () => { aSynced = true; console.log('  [A] EVENT: synced') })
  provA.on('no-peers', () => { aNoPeers = true; console.log('  [A] EVENT: no-peers') })

  await wait(3000)
  console.log(`  [A] provider._subscribed=${provA._subscribed}, synced=${provA.synced}, aSynced=${aSynced}, aNoPeers=${aNoPeers}`)

  if (!provA._subscribed) {
    console.log('  ❌ FAILURE POINT: Provider A channel never reached SUBSCRIBED')
    provA.destroy(); ydocA.destroy()
    return false
  }

  // Seed content into Alice's Y.Doc now (simulates "no-peers" seeding)
  console.log('  [A] Seeding Y.Doc with "yjs test body"')
  ytextA.insert(0, 'yjs test body')
  console.log(`  [A] Y.Doc content: "${ytextA.toString()}"`)

  // Wait a moment, then connect Bob
  await wait(500)

  const ydocB = new Y.Doc()
  const ytextB = ydocB.getText('content')

  console.log('  [B] Creating provider…')
  const provB = new SupabaseBroadcastProvider(clientB, doc.id, ydocB)

  let bSynced = false, bNoPeers = false
  provB.on('synced', () => { bSynced = true; console.log('  [B] EVENT: synced') })
  provB.on('no-peers', () => { bNoPeers = true; console.log('  [B] EVENT: no-peers') })

  await wait(3000)
  console.log(`  [B] provider._subscribed=${provB._subscribed}, synced=${provB.synced}, bSynced=${bSynced}, bNoPeers=${bNoPeers}`)
  console.log(`  [B] Y.Doc content: "${ytextB.toString()}"`)

  if (!provB._subscribed) {
    console.log('  ❌ FAILURE POINT: Provider B channel never reached SUBSCRIBED')
    provA.destroy(); provB.destroy(); ydocA.destroy(); ydocB.destroy()
    return false
  }

  // Check initial sync
  if (ytextB.toString() === 'yjs test body') {
    console.log('  ✅ Initial sync: B received A\'s content via sync-response')
  } else if (ytextB.toString() === '') {
    console.log('  ❌ FAILURE: B has empty content — sync-request/response failed')
    console.log('  → Provider A may have missed the sync-request')
    console.log('  → Or Provider A was in synced=false when sync-request arrived')
  } else {
    console.log(`  ⚠️ B has unexpected content: "${ytextB.toString()}"`)
  }

  // Now test live incremental updates: A types → B sees it
  console.log('\n  --- Live update test: A types → B ---')
  ytextA.insert(ytextA.toString().length, ' [LIVE-A]')
  console.log(`  [A] After typing: "${ytextA.toString()}"`)

  await wait(2000)
  console.log(`  [B] After wait: "${ytextB.toString()}"`)

  if (ytextB.toString().includes('[LIVE-A]')) {
    console.log('  ✅ A→B live update received')
  } else {
    console.log('  ❌ FAILURE: A→B live update NOT received')
    console.log(`  → A._subscribed=${provA._subscribed}, A.destroyed=${provA.destroyed}`)
    console.log(`  → B._subscribed=${provB._subscribed}, B.destroyed=${provB.destroyed}`)
  }

  // B types → A sees it
  console.log('\n  --- Live update test: B types → A ---')
  ytextB.insert(ytextB.toString().length, ' [LIVE-B]')
  console.log(`  [B] After typing: "${ytextB.toString()}"`)

  await wait(2000)
  console.log(`  [A] After wait: "${ytextA.toString()}"`)

  if (ytextA.toString().includes('[LIVE-B]')) {
    console.log('  ✅ B→A live update received')
  } else {
    console.log('  ❌ FAILURE: B→A live update NOT received')
  }

  const converged = ytextA.toString() === ytextB.toString()
  console.log(`\n  Final A: "${ytextA.toString()}"`)
  console.log(`  Final B: "${ytextB.toString()}"`)
  console.log(converged ? '  ✅ Documents converged' : '  ❌ Documents diverged')

  provA.destroy(); provB.destroy(); ydocA.destroy(); ydocB.destroy()

  console.log(converged ? '  ✅ TEST 3 PASSED' : '  ❌ TEST 3 FAILED')
  return converged
}

// ═══════════════════════════════════════════════════════════════════════════
// TEST 4: postgres_changes body fallback — does Yjs state from DB update
//         reach a shared user's Y.Doc?
// ═══════════════════════════════════════════════════════════════════════════
async function testPgChangesYjsFallback() {
  console.log('\n══════════════════════════════════════════════════════')
  console.log('TEST 4: postgres_changes yjs_state fallback sync')
  console.log('══════════════════════════════════════════════════════')

  const doc = await createSharedDoc('Debug-Fallback-' + Date.now(), 'fallback body')
  console.log(`  Created doc id=${doc.id}`)

  // Alice creates & saves yjs_state to DB
  const ydocSave = new Y.Doc()
  ydocSave.getText('content').insert(0, 'persisted crdt content')
  const yjsPayload = fromUint8Array(Y.encodeStateAsUpdate(ydocSave))

  const { error: saveErr } = await clientA
    .from('documents')
    .update({ body: 'persisted crdt content', yjs_state: yjsPayload })
    .eq('id', doc.id)
  if (saveErr) throw new Error('Save failed: ' + saveErr.message)
  console.log('  [A] Saved yjs_state to DB')
  ydocSave.destroy()

  // Bob subscribes to postgres_changes AND has a Y.Doc ready
  const ydocB = new Y.Doc()
  const ytextB = ydocB.getText('content')
  let pgEventReceived = false

  const chB = clientB.channel(`debug-fallback-${doc.id}`)
    .on('postgres_changes',
      { event: 'UPDATE', schema: 'public', table: 'documents', filter: `id=eq.${doc.id}` },
      ({ new: newRow }) => {
        pgEventReceived = true
        console.log(`  [B] postgres_changes received! has yjs_state=${newRow.yjs_state != null}, yjs_state length=${newRow.yjs_state?.length ?? 0}`)

        if (newRow.yjs_state) {
          try {
            const decoded = toUint8Array(newRow.yjs_state)
            console.log(`  [B] Decoded yjs_state: ${decoded.length} bytes`)
            Y.applyUpdate(ydocB, decoded, 'remote')
            console.log(`  [B] After Y.applyUpdate: "${ytextB.toString()}"`)
          } catch (e) {
            console.log(`  [B] ❌ Y.applyUpdate FAILED: ${e.message}`)
          }
        }
      })

  let chBStatus = null
  chB.subscribe((s) => { chBStatus = s; console.log(`  [B] pg channel status: ${s}`) })

  await wait(3000)

  if (chBStatus !== 'SUBSCRIBED') {
    console.log('  ❌ FAILURE: Bob\'s channel not SUBSCRIBED')
    clientB.removeChannel(chB); ydocB.destroy()
    return false
  }

  // Alice updates the document again (triggers postgres_changes)
  const ydocSave2 = new Y.Doc()
  ydocSave2.getText('content').insert(0, 'updated crdt content from alice')
  const yjsPayload2 = fromUint8Array(Y.encodeStateAsUpdate(ydocSave2))

  console.log('  [A] Updating document with new yjs_state…')
  const { error: upd2Err } = await clientA
    .from('documents')
    .update({ body: 'updated crdt content from alice', yjs_state: yjsPayload2 })
    .eq('id', doc.id)
  if (upd2Err) throw new Error('Update failed: ' + upd2Err.message)
  ydocSave2.destroy()

  await wait(4000)

  console.log(`  [B] pgEventReceived=${pgEventReceived}`)
  console.log(`  [B] Final Y.Doc: "${ytextB.toString()}"`)

  if (!pgEventReceived) {
    console.log('  ❌ FAILURE: postgres_changes event NOT received by shared user')
    console.log('  → RLS blocks. Check SELECT policy on documents for shared users.')
  } else if (ytextB.toString() === '') {
    console.log('  ❌ FAILURE: Event received but Y.applyUpdate had no effect')
    console.log('  → Possible yjs_state encoding mismatch (base64 vs bytea)')
  } else if (ytextB.toString() === 'updated crdt content from alice') {
    console.log('  ✅ Full fallback pipeline works')
  } else {
    console.log(`  ⚠️ Unexpected content: "${ytextB.toString()}"`)
  }

  clientB.removeChannel(chB); ydocB.destroy()
  const ok = ytextB.toString() === 'updated crdt content from alice'
  console.log(ok ? '  ✅ TEST 4 PASSED' : '  ❌ TEST 4 FAILED')
  return ok
}

// ═══════════════════════════════════════════════════════════════════════════
// TEST 5: StrictMode simulation — mount, destroy, remount
// ═══════════════════════════════════════════════════════════════════════════
async function testStrictModeSimulation() {
  console.log('\n══════════════════════════════════════════════════════')
  console.log('TEST 5: StrictMode mount→destroy→remount')
  console.log('══════════════════════════════════════════════════════')

  const doc = await createSharedDoc('Debug-StrictMode-' + Date.now(), 'strictmode body')
  console.log(`  Created doc id=${doc.id}`)

  // Simulate StrictMode: create→destroy→create provider
  const ydocA = new Y.Doc()
  ydocA.getText('content').insert(0, 'strictmode body')

  console.log('  [A] First mount — creating provider…')
  const prov1 = new SupabaseBroadcastProvider(clientA, doc.id, ydocA)
  // Immediately destroy (simulating StrictMode cleanup)
  console.log('  [A] Destroying first provider (StrictMode cleanup)…')
  prov1.destroy()
  
  console.log('  [A] Second mount — creating provider…')
  const prov2 = new SupabaseBroadcastProvider(clientA, doc.id, ydocA)

  let aSynced = false, aNoPeers = false
  prov2.on('synced', () => { aSynced = true; console.log('  [A] EVENT: synced') })
  prov2.on('no-peers', () => { aNoPeers = true; console.log('  [A] EVENT: no-peers') })

  await wait(3000)
  console.log(`  [A] prov2._subscribed=${prov2._subscribed}, synced=${prov2.synced}`)

  if (!prov2._subscribed) {
    console.log('  ❌ FAILURE: After StrictMode cycle, provider never subscribed')
    console.log('  → Channel name collision or server rejecting duplicate JOIN')
    prov2.destroy(); ydocA.destroy()
    return false
  }

  // Now Bob connects
  const ydocB = new Y.Doc()
  console.log('  [B] Creating provider…')
  const provB = new SupabaseBroadcastProvider(clientB, doc.id, ydocB)
  let bSynced = false
  provB.on('synced', () => { bSynced = true; console.log('  [B] EVENT: synced') })
  provB.on('no-peers', () => { console.log('  [B] EVENT: no-peers (unexpected)') })

  await wait(3000)
  console.log(`  [B] synced=${bSynced}, content="${ydocB.getText('content').toString()}"`)

  // Live update test after StrictMode
  ydocA.getText('content').insert(ydocA.getText('content').toString().length, ' [POST-SM]')
  await wait(2000)

  const bContent = ydocB.getText('content').toString()
  console.log(`  [B] after A types: "${bContent}"`)

  const ok = bContent.includes('strictmode body') && bContent.includes('[POST-SM]')
  prov2.destroy(); provB.destroy(); ydocA.destroy(); ydocB.destroy()

  console.log(ok ? '  ✅ TEST 5 PASSED: StrictMode cycle works' : '  ❌ TEST 5 FAILED')
  return ok
}

// ═══════════════════════════════════════════════════════════════════════════
// Runner
// ═══════════════════════════════════════════════════════════════════════════
async function main() {
  console.log('╔═══════════════════════════════════════════════════════╗')
  console.log('║  Realtime Debug Test Suite                           ║')
  console.log('╚═══════════════════════════════════════════════════════╝')

  await setup()

  const results = {}
  results['1-broadcast'] = await testRawBroadcast()
  results['2-pg-changes'] = await testPostgresChanges()
  results['3-yjs-provider'] = await testYjsProvider()
  results['4-pg-yjs-fallback'] = await testPgChangesYjsFallback()
  results['5-strictmode'] = await testStrictModeSimulation()

  console.log('\n═══════════════════════════════════════════════════════')
  console.log('SUMMARY:')
  for (const [test, ok] of Object.entries(results)) {
    console.log(`  ${ok ? '✅' : '❌'} ${test}`)
  }
  console.log('═══════════════════════════════════════════════════════')

  // Diagnose based on results
  console.log('\nDIAGNOSIS:')
  if (!results['1-broadcast']) {
    console.log('  A) SUBSCRIPTION NOT WORKING — broadcast channels fail entirely')
  }
  if (!results['2-pg-changes']) {
    console.log('  B) EVENTS NOT FIRING — postgres_changes not delivered (RLS or publication)')
  }
  if (results['1-broadcast'] && !results['3-yjs-provider']) {
    console.log('  C/D) STATE NOT UPDATING or YJS NOT APPLYING — broadcast works but provider flow broken')
  }
  if (results['2-pg-changes'] && !results['4-pg-yjs-fallback']) {
    console.log('  D) YJS NOT APPLYING — events received but yjs_state decode/apply fails')
  }
  if (!results['5-strictmode']) {
    console.log('  E) STRICTMODE RACE — provider breaks after mount→destroy→remount cycle')
  }
  if (Object.values(results).every(Boolean)) {
    console.log('  All transport layers work at the protocol level.')
    console.log('  The bug is likely in React component wiring (effect deps, ref timing, etc.)')
  }

  const allPassed = Object.values(results).every(Boolean)
  process.exit(allPassed ? 0 : 1)
}

main().catch(e => { console.error('FATAL:', e); process.exit(1) })
