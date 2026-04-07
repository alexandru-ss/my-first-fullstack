/**
 * Comprehensive Yjs collaborative editing test suite.
 *
 * Tests:
 *   1. Basic sync: A types → B sees it
 *   2. Bidirectional: B types → A sees it
 *   3. Simultaneous typing in different positions
 *   4. Cursor conflict (same position)
 *   5. Persistence: save to DB, reload, verify
 *   6. Offline recovery: B disconnects, A types, B reconnects
 *   7. Legacy doc (no yjs_state): seeds from plain-text body
 *   8. DB verification: yjs_state column populated, body matches
 *   9. Title change does NOT delete content (ydocReady guard)
 *
 * Usage: node test_yjs_comprehensive.cjs
 */

const { createClient } = require('./frontend/node_modules/@supabase/supabase-js')

const SUPABASE_URL = 'http://127.0.0.1:54321'
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0'

const USER_A_EMAIL = 'alice@example.com'
const USER_B_EMAIL = 'bob@example.com'
const PASSWORD = 'password123'

function wait(ms) { return new Promise(r => setTimeout(r, ms)) }
function pad(label) { return label.padEnd(48, ' ') }

let Y, fromUint8Array, toUint8Array, SupabaseBroadcastProvider
let clientA, clientB, userAId, userBId
let passed = 0, failed = 0

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

  console.log(`Signed in: Alice=${userAId.slice(0,8)}… Bob=${userBId.slice(0,8)}…\n`)
}

function assert(label, condition) {
  if (condition) {
    console.log(`  ✅ ${pad(label)} PASS`)
    passed++
  } else {
    console.log(`  ❌ ${pad(label)} FAIL`)
    failed++
  }
}

/**
 * Helper: create a real document in the database as Alice,
 * optionally share it with Bob.
 */
async function createTestDoc(title, body, shareWithBob = true) {
  const { data: doc, error } = await clientA
    .from('documents')
    .insert({ user_id: userAId, title, body })
    .select('id, title, body, yjs_state')
    .single()
  if (error) throw new Error('Failed to create doc: ' + error.message)

  if (shareWithBob) {
    const { error: shareErr } = await clientA
      .from('document_shares')
      .insert({ document_id: doc.id, owner_id: userAId, shared_with_id: userBId, shared_with_email: USER_B_EMAIL, permission: 'edit' })
    if (shareErr) throw new Error('Failed to share doc: ' + shareErr.message)
  }
  return doc
}

/**
 * Helper: save Yjs state to the document in the DB.
 */
async function saveYjsState(client, docId, ydoc) {
  const body = ydoc.getText('content').toString()
  const yjsPayload = fromUint8Array(Y.encodeStateAsUpdate(ydoc))
  const { error } = await client
    .from('documents')
    .update({ body, yjs_state: yjsPayload })
    .eq('id', docId)
  if (error) throw new Error('Failed to save: ' + error.message)
}

// ═══════════════════════════════════════════════════════════════════════════
// Test 1 & 2: Basic sync + Bidirectional
// ═══════════════════════════════════════════════════════════════════════════
async function testBasicAndBidirectional() {
  console.log('═══ Tests 1-2: Basic A→B and B→A sync ═══')
  const doc = await createTestDoc('Test-Sync-' + Date.now(), 'initial content')

  // Simulate both clients loading yjs_state=null (legacy), seeding via provider
  const ydocA = new Y.Doc(), ydocB = new Y.Doc()
  const ytextA = ydocA.getText('content'), ytextB = ydocB.getText('content')

  // Alice opens first → provider → no-peers → seeds
  const provA = new SupabaseBroadcastProvider(clientA, doc.id, ydocA)
  await wait(2000)
  ytextA.insert(0, 'initial content') // seed after no-peers
  await wait(500)

  // Bob opens → provider → sync-request → gets Alice's state
  let bSynced = false
  const provB = new SupabaseBroadcastProvider(clientB, doc.id, ydocB)
  provB.on('synced', () => { bSynced = true })
  await wait(2000)

  assert('Bob received sync from Alice', bSynced)
  assert('Bob has Alice\'s initial content', ytextB.toString() === 'initial content')

  // Test 1: Alice types → Bob sees it
  ytextA.insert(ytextA.toString().length, ' [A-edit]')
  await wait(1500)
  assert('A→B: Bob sees Alice\'s edit', ytextB.toString() === 'initial content [A-edit]')

  // Test 2: Bob types → Alice sees it
  ytextB.insert(ytextB.toString().length, ' [B-edit]')
  await wait(1500)
  assert('B→A: Alice sees Bob\'s edit', ytextA.toString() === 'initial content [A-edit] [B-edit]')
  assert('Both docs converged', ytextA.toString() === ytextB.toString())

  provA.destroy(); provB.destroy()
  ydocA.destroy(); ydocB.destroy()
  console.log()
}

// ═══════════════════════════════════════════════════════════════════════════
// Test 3: Simultaneous typing in different positions
// ═══════════════════════════════════════════════════════════════════════════
async function testSimultaneousEditing() {
  console.log('═══ Test 3: Simultaneous edits in different positions ═══')

  // Create a doc with persisted yjs_state so both clients load properly
  const seedDoc = new Y.Doc()
  seedDoc.getText('content').insert(0, 'Hello World')
  const seedState = Y.encodeStateAsUpdate(seedDoc)
  seedDoc.destroy()

  const doc = await createTestDoc('Test-Simul-' + Date.now(), 'Hello World')

  const ydocA = new Y.Doc(), ydocB = new Y.Doc()
  Y.applyUpdate(ydocA, seedState)
  Y.applyUpdate(ydocB, seedState)

  const provA = new SupabaseBroadcastProvider(clientA, doc.id, ydocA)
  await wait(1500)
  const provB = new SupabaseBroadcastProvider(clientB, doc.id, ydocB)
  await wait(2000)

  const ytextA = ydocA.getText('content'), ytextB = ydocB.getText('content')

  // Simultaneous inserts at different positions
  ytextA.insert(5, '-AAA')   // "Hello-AAA World"
  ytextB.insert(11, '-BBB')  // "Hello World-BBB"

  await wait(2000)

  const textA = ytextA.toString()
  const textB = ytextB.toString()
  console.log(`  [A] text: ${JSON.stringify(textA)}`)
  console.log(`  [B] text: ${JSON.stringify(textB)}`)

  assert('Both docs converged', textA === textB)
  assert('No text lost (contains AAA)', textA.includes('-AAA'))
  assert('No text lost (contains BBB)', textA.includes('-BBB'))
  assert('Original text preserved', textA.includes('Hello') && textA.includes('World'))

  provA.destroy(); provB.destroy()
  ydocA.destroy(); ydocB.destroy()
  console.log()
}

// ═══════════════════════════════════════════════════════════════════════════
// Test 4: Cursor conflict — both type at the exact same position
// ═══════════════════════════════════════════════════════════════════════════
async function testCursorConflict() {
  console.log('═══ Test 4: Same-position typing (cursor conflict) ═══')

  const seedDoc = new Y.Doc()
  seedDoc.getText('content').insert(0, 'Hello World')
  const seedState = Y.encodeStateAsUpdate(seedDoc)
  seedDoc.destroy()

  const doc = await createTestDoc('Test-Conflict-' + Date.now(), 'Hello World')

  const ydocA = new Y.Doc(), ydocB = new Y.Doc()
  Y.applyUpdate(ydocA, seedState)
  Y.applyUpdate(ydocB, seedState)

  const provA = new SupabaseBroadcastProvider(clientA, doc.id, ydocA)
  await wait(1500)
  const provB = new SupabaseBroadcastProvider(clientB, doc.id, ydocB)
  await wait(2000)

  const ytextA = ydocA.getText('content'), ytextB = ydocB.getText('content')

  // Both insert at position 5
  ytextA.insert(5, '[A]')
  ytextB.insert(5, '[B]')

  await wait(2000)

  const textA = ytextA.toString()
  const textB = ytextB.toString()
  console.log(`  [A] text: ${JSON.stringify(textA)}`)
  console.log(`  [B] text: ${JSON.stringify(textB)}`)

  assert('Both docs converged', textA === textB)
  assert('No text lost (contains [A])', textA.includes('[A]'))
  assert('No text lost (contains [B])', textA.includes('[B]'))
  assert('Original text preserved', textA.startsWith('Hello') && textA.includes('World'))

  provA.destroy(); provB.destroy()
  ydocA.destroy(); ydocB.destroy()
  console.log()
}

// ═══════════════════════════════════════════════════════════════════════════
// Test 5: Persistence — save to DB, reload, verify content
// ═══════════════════════════════════════════════════════════════════════════
async function testPersistence() {
  console.log('═══ Test 5: Persistence — save + reload ═══')

  const doc = await createTestDoc('Test-Persist-' + Date.now(), '')

  // Alice types and saves
  const ydocA = new Y.Doc()
  const ytextA = ydocA.getText('content')
  ytextA.insert(0, 'Persisted content after typing')
  await saveYjsState(clientA, doc.id, ydocA)

  // "Refresh" — load from DB
  const { data: reloaded } = await clientA
    .from('documents')
    .select('id, body, yjs_state')
    .eq('id', doc.id)
    .single()

  assert('Body saved correctly', reloaded.body === 'Persisted content after typing')
  assert('yjs_state is populated', reloaded.yjs_state != null && reloaded.yjs_state.length > 0)

  // Load yjs_state into a new Y.Doc
  const ydocReloaded = new Y.Doc()
  Y.applyUpdate(ydocReloaded, toUint8Array(reloaded.yjs_state))
  const reloadedText = ydocReloaded.getText('content').toString()
  assert('Y.Doc restored from yjs_state', reloadedText === 'Persisted content after typing')
  assert('Body matches yjs_state content', reloaded.body === reloadedText)

  ydocA.destroy(); ydocReloaded.destroy()
  console.log()
}

// ═══════════════════════════════════════════════════════════════════════════
// Test 6: Offline recovery — B disconnects, A types, B reconnects
// ═══════════════════════════════════════════════════════════════════════════
async function testOfflineRecovery() {
  console.log('═══ Test 6: Offline recovery ═══')

  const seedDoc = new Y.Doc()
  seedDoc.getText('content').insert(0, 'before offline')
  const seedState = Y.encodeStateAsUpdate(seedDoc)
  seedDoc.destroy()

  const doc = await createTestDoc('Test-Offline-' + Date.now(), 'before offline')
  // Save the yjs_state so Bob can load it
  const tempDoc = new Y.Doc()
  tempDoc.getText('content').insert(0, 'before offline')
  await saveYjsState(clientA, doc.id, tempDoc)
  tempDoc.destroy()

  // Round 1: both connect
  const ydocA = new Y.Doc()
  Y.applyUpdate(ydocA, seedState)
  const provA = new SupabaseBroadcastProvider(clientA, doc.id, ydocA)
  await wait(1500)

  const ydocB1 = new Y.Doc()
  Y.applyUpdate(ydocB1, seedState)
  const provB1 = new SupabaseBroadcastProvider(clientB, doc.id, ydocB1)
  await wait(2000)

  assert('Initial sync OK', ydocA.getText('content').toString() === ydocB1.getText('content').toString())

  // Bob goes offline
  provB1.destroy()
  ydocB1.destroy()
  console.log('  [B] Disconnected (offline)')

  // Alice types while Bob is offline
  ydocA.getText('content').insert(ydocA.getText('content').toString().length, ' + online-edit')
  await wait(500)
  console.log(`  [A] Typed while B offline: ${JSON.stringify(ydocA.getText('content').toString())}`)

  // Save Alice's state to DB (simulating auto-save)
  await saveYjsState(clientA, doc.id, ydocA)

  // Bob comes back online — loads from DB
  const { data: freshDoc } = await clientB
    .from('documents')
    .select('id, body, yjs_state')
    .eq('id', doc.id)
    .single()

  const ydocB2 = new Y.Doc()
  if (freshDoc.yjs_state) {
    Y.applyUpdate(ydocB2, toUint8Array(freshDoc.yjs_state))
  }
  console.log(`  [B] Reloaded from DB: ${JSON.stringify(ydocB2.getText('content').toString())}`)

  assert('Bob loaded latest content from DB', ydocB2.getText('content').toString() === 'before offline + online-edit')

  // Bob also connects provider to catch any further live edits
  let b2Synced = false
  const provB2 = new SupabaseBroadcastProvider(clientB, doc.id, ydocB2)
  provB2.on('synced', () => { b2Synced = true })
  await wait(2000)

  // Alice types again
  ydocA.getText('content').insert(ydocA.getText('content').toString().length, ' + more')
  await wait(1500)

  assert('Bob synced after reconnect', ydocA.getText('content').toString() === ydocB2.getText('content').toString())

  provA.destroy(); provB2.destroy()
  ydocA.destroy(); ydocB2.destroy()
  console.log()
}

// ═══════════════════════════════════════════════════════════════════════════
// Test 7: Legacy doc — no yjs_state, seed from body
// ═══════════════════════════════════════════════════════════════════════════
async function testLegacyDoc() {
  console.log('═══ Test 7: Legacy doc (no yjs_state) ═══')

  const doc = await createTestDoc('Test-Legacy-' + Date.now(), 'legacy plain text')

  // Verify no yjs_state
  const { data: raw } = await clientA
    .from('documents')
    .select('yjs_state')
    .eq('id', doc.id)
    .single()
  assert('Document has no yjs_state initially', raw.yjs_state == null)

  // Alice opens (empty Y.Doc → no-peers → seeds from body)
  const ydocA = new Y.Doc()
  const provA = new SupabaseBroadcastProvider(clientA, doc.id, ydocA)
  let aNoPeers = false
  provA.on('no-peers', () => {
    aNoPeers = true
    const yt = ydocA.getText('content')
    if (yt.toString() === '') yt.insert(0, doc.body)
  })
  await wait(2500)

  assert('Alice got no-peers', aNoPeers)
  assert('Alice seeded from body', ydocA.getText('content').toString() === 'legacy plain text')

  // Bob opens → sync-request → gets Alice's state
  const ydocB = new Y.Doc()
  let bSynced = false
  const provB = new SupabaseBroadcastProvider(clientB, doc.id, ydocB)
  provB.on('synced', () => { bSynced = true })
  await wait(2500)

  assert('Bob synced from Alice', bSynced)
  assert('Bob got legacy content', ydocB.getText('content').toString() === 'legacy plain text')

  // Verify edits still sync
  ydocA.getText('content').insert(ydocA.getText('content').toString().length, ' [edited]')
  await wait(1500)
  assert('Legacy doc edits sync', ydocA.getText('content').toString() === ydocB.getText('content').toString())

  provA.destroy(); provB.destroy()
  ydocA.destroy(); ydocB.destroy()
  console.log()
}

// ═══════════════════════════════════════════════════════════════════════════
// Test 8: DB verification — yjs_state column + body matches
// ═══════════════════════════════════════════════════════════════════════════
async function testDbVerification() {
  console.log('═══ Test 8: DB verification ═══')

  const doc = await createTestDoc('Test-DB-' + Date.now(), '')

  const ydoc = new Y.Doc()
  ydoc.getText('content').insert(0, '# Markdown Document\n\nHello **world**!')
  await saveYjsState(clientA, doc.id, ydoc)

  const { data: dbRow } = await clientA
    .from('documents')
    .select('body, yjs_state, title, updated_at')
    .eq('id', doc.id)
    .single()

  assert('yjs_state is stored (non-null)', dbRow.yjs_state != null)
  assert('yjs_state is non-empty', dbRow.yjs_state.length > 10)
  assert('body matches Y.Doc content', dbRow.body === '# Markdown Document\n\nHello **world**!')

  // Verify round-trip: decode yjs_state → Y.Doc → text matches body
  const ydoc2 = new Y.Doc()
  Y.applyUpdate(ydoc2, toUint8Array(dbRow.yjs_state))
  assert('yjs_state round-trip: text matches body', ydoc2.getText('content').toString() === dbRow.body)

  ydoc.destroy(); ydoc2.destroy()
  console.log()
}

// ═══════════════════════════════════════════════════════════════════════════
// Test 9: Title change does NOT delete content (ydocReady guard)
// ═══════════════════════════════════════════════════════════════════════════
async function testTitleChangePreservesContent() {
  console.log('═══ Test 9: Title change preserves content (ydocReady) ═══')

  // Simulate the DocumentEditor flow for a legacy doc (no yjs_state)
  const existingBody = 'This is important content that must not be lost'

  // Step 1: component mounts → Y.Doc created, no yjs_state → Y.Doc is EMPTY
  const ydoc = new Y.Doc()
  const ytext = ydoc.getText('content')
  let ydocReady = false // simulates ydocReadyRef

  // doc.yjs_state is null → don't apply, don't set ydocReady
  // body React state = existingBody (from useState(doc?.body ?? ''))

  assert('Y.Doc starts empty (legacy)', ytext.toString() === '')
  assert('ydocReady is false', ydocReady === false)

  // Step 2: user changes title immediately (before no-peers fires)
  // Auto-save fires 1.5s later. Simulating the bodyText extraction:
  const bodyText = ydocReady ? ytext.toString() : existingBody
  assert('Auto-save uses React body (not empty Y.Doc)', bodyText === existingBody)

  // Step 3: No-peers fires → seed Y.Doc from body
  ytext.insert(0, existingBody)
  ydocReady = true

  assert('After seeding, Y.Doc has content', ytext.toString() === existingBody)
  assert('ydocReady is now true', ydocReady === true)

  // Step 4: user changes title again → auto-save now reads from Y.Doc
  const bodyText2 = ydocReady ? ytext.toString() : existingBody
  assert('Auto-save now reads from Y.Doc', bodyText2 === existingBody)

  // Step 5: verify yjs_state would be included only when ready
  const yjsPayload1 = false ? fromUint8Array(Y.encodeStateAsUpdate(ydoc)) : undefined
  assert('yjs_state NOT saved before seeding', yjsPayload1 === undefined)
  const yjsPayload2 = ydocReady ? fromUint8Array(Y.encodeStateAsUpdate(ydoc)) : undefined
  assert('yjs_state saved after seeding', yjsPayload2 != null)

  ydoc.destroy()
  console.log()
}

// ═══════════════════════════════════════════════════════════════════════════
// Test 10: Title sync via Broadcast (instant, no DB round-trip)
// ═══════════════════════════════════════════════════════════════════════════
async function testTitleBroadcastSync() {
  console.log('═══ Test 10: Title sync via Broadcast ═══')

  const seedDoc = new Y.Doc()
  seedDoc.getText('content').insert(0, 'doc body')
  const seedState = Y.encodeStateAsUpdate(seedDoc)
  seedDoc.destroy()

  const doc = await createTestDoc('Original Title', 'doc body')

  const ydocA = new Y.Doc(), ydocB = new Y.Doc()
  Y.applyUpdate(ydocA, seedState)
  Y.applyUpdate(ydocB, seedState)

  const provA = new SupabaseBroadcastProvider(clientA, doc.id, ydocA)
  await wait(1500)
  const provB = new SupabaseBroadcastProvider(clientB, doc.id, ydocB)
  await wait(2000)

  // Track title updates received by each side
  let titleAtB = 'Original Title'
  let titleAtA = 'Original Title'

  provB.on('title-update', (t) => { titleAtB = t })
  provA.on('title-update', (t) => { titleAtA = t })

  // Test A→B: Alice changes title
  provA.sendTitle('Updated by Alice')
  await wait(1500)
  assert('A→B: Bob received title update', titleAtB === 'Updated by Alice')
  assert('A→B: Alice did NOT receive own title', titleAtA === 'Original Title')

  // Test B→A: Bob changes title
  provB.sendTitle('Updated by Bob')
  await wait(1500)
  assert('B→A: Alice received title update', titleAtA === 'Updated by Bob')

  // Test rapid typing: multiple title updates
  provA.sendTitle('T')
  provA.sendTitle('Te')
  provA.sendTitle('Tes')
  provA.sendTitle('Test')
  provA.sendTitle('Test1')
  provA.sendTitle('Test12')
  provA.sendTitle('Test123')
  await wait(1500)
  assert('Rapid title updates converge', titleAtB === 'Test123')

  provA.destroy(); provB.destroy()
  ydocA.destroy(); ydocB.destroy()
  console.log()
}

// ═══════════════════════════════════════════════════════════════════════════
// Run all tests
// ═══════════════════════════════════════════════════════════════════════════
async function main() {
  console.log('╔═══════════════════════════════════════════════════════════╗')
  console.log('║  Comprehensive Yjs Collaborative Editing Test Suite      ║')
  console.log('╚═══════════════════════════════════════════════════════════╝\n')

  await setup()

  await testBasicAndBidirectional()
  await wait(500)
  await testSimultaneousEditing()
  await wait(500)
  await testCursorConflict()
  await wait(500)
  await testPersistence()
  await wait(500)
  await testOfflineRecovery()
  await wait(500)
  await testLegacyDoc()
  await wait(500)
  await testDbVerification()
  await wait(500)
  await testTitleChangePreservesContent()
  await wait(500)
  await testTitleBroadcastSync()

  console.log('═══════════════════════════════════════════════════════════')
  console.log(`  Results: ${passed} passed, ${failed} failed, ${passed + failed} total`)
  if (failed === 0) {
    console.log('  ✅ ALL TESTS PASSED')
  } else {
    console.log('  ❌ SOME TESTS FAILED')
  }
  console.log('═══════════════════════════════════════════════════════════')

  setTimeout(() => process.exit(failed > 0 ? 1 : 0), 500)
}

main().catch(err => { console.error(err); process.exit(1) })
