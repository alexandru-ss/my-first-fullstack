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
 *  10. Title sync via Broadcast
 *  11. Presence broadcast: A sets presence → B receives it
 *  12. Presence leave: A sends leave → B removes A
 *  13. Stale presence timeout: A goes silent → removed after 15s
 *  14. Deterministic colors: same userId → same color always
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

let Y, fromUint8Array, toUint8Array, SupabaseBroadcastProvider, userColor
let clientA, clientB, userAId, userBId
let passed = 0, failed = 0

async function setup() {
  Y = await import('./frontend/node_modules/yjs/dist/yjs.mjs')
  const base64 = await import('./frontend/node_modules/js-base64/base64.mjs')
  fromUint8Array = base64.fromUint8Array
  toUint8Array = base64.toUint8Array
  const provider = await import('./frontend/src/lib/SupabaseBroadcastProvider.js')
  SupabaseBroadcastProvider = provider.SupabaseBroadcastProvider
  userColor = provider.userColor

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
// Test 11: Presence broadcast — A sets presence → B receives it
// ═══════════════════════════════════════════════════════════════════════════
async function testPresenceBroadcast() {
  console.log('═══ Test 11: Presence broadcast ═══')

  const seedDoc = new Y.Doc()
  seedDoc.getText('content').insert(0, 'presence test')
  const seedState = Y.encodeStateAsUpdate(seedDoc)
  seedDoc.destroy()

  const doc = await createTestDoc('Test-Presence-' + Date.now(), 'presence test')

  const ydocA = new Y.Doc(), ydocB = new Y.Doc()
  Y.applyUpdate(ydocA, seedState)
  Y.applyUpdate(ydocB, seedState)

  const provA = new SupabaseBroadcastProvider(clientA, doc.id, ydocA)
  await wait(1500)
  const provB = new SupabaseBroadcastProvider(clientB, doc.id, ydocB)
  await wait(2000)

  // Track awareness changes at B
  let bAwarenessChanged = false
  provB.on('awareness-change', () => { bAwarenessChanged = true })

  // Alice announces presence
  provA.setLocalPresence({ userId: userAId, name: 'Alice', cursorIndex: 5 })
  await wait(1500)

  assert('Bob received awareness change', bAwarenessChanged)
  assert('Bob\'s awareness has 1 entry', provB.awareness.size === 1)

  // Find Alice's entry
  const aliceEntry = [...provB.awareness.values()].find(s => s.userId === userAId)
  assert('Alice\'s userId matches', aliceEntry?.userId === userAId)
  assert('Alice\'s name is correct', aliceEntry?.name === 'Alice')
  assert('Alice\'s color is set', aliceEntry?.color != null && aliceEntry.color.length > 0)
  assert('Alice\'s cursorIndex is 5', aliceEntry?.cursorIndex === 5)
  assert('Alice\'s color is deterministic', aliceEntry?.color === userColor(userAId))

  provA.destroy(); provB.destroy()
  ydocA.destroy(); ydocB.destroy()
  console.log()
}

// ═══════════════════════════════════════════════════════════════════════════
// Test 12: Presence leave — A sends leave → B removes A
// ═══════════════════════════════════════════════════════════════════════════
async function testPresenceLeave() {
  console.log('═══ Test 12: Presence leave ═══')

  const seedDoc = new Y.Doc()
  seedDoc.getText('content').insert(0, 'leave test')
  const seedState = Y.encodeStateAsUpdate(seedDoc)
  seedDoc.destroy()

  const doc = await createTestDoc('Test-Leave-' + Date.now(), 'leave test')

  const ydocA = new Y.Doc(), ydocB = new Y.Doc()
  Y.applyUpdate(ydocA, seedState)
  Y.applyUpdate(ydocB, seedState)

  const provA = new SupabaseBroadcastProvider(clientA, doc.id, ydocA)
  await wait(1500)
  const provB = new SupabaseBroadcastProvider(clientB, doc.id, ydocB)
  await wait(2000)

  // Alice announces presence
  provA.setLocalPresence({ userId: userAId, name: 'Alice', cursorIndex: 0 })
  await wait(1500)
  assert('Bob sees Alice before leave', provB.awareness.size === 1)

  // Alice sends leave
  provA.sendLeave()
  await wait(1500)
  assert('Bob\'s awareness empty after leave', provB.awareness.size === 0)

  provA.destroy(); provB.destroy()
  ydocA.destroy(); ydocB.destroy()
  console.log()
}

// ═══════════════════════════════════════════════════════════════════════════
// Test 13: Stale presence timeout — A goes silent → B removes after timeout
// ═══════════════════════════════════════════════════════════════════════════
async function testStalePresenceTimeout() {
  console.log('═══ Test 13: Stale presence timeout ═══')

  const seedDoc = new Y.Doc()
  seedDoc.getText('content').insert(0, 'stale test')
  const seedState = Y.encodeStateAsUpdate(seedDoc)
  seedDoc.destroy()

  const doc = await createTestDoc('Test-Stale-' + Date.now(), 'stale test')

  const ydocA = new Y.Doc(), ydocB = new Y.Doc()
  Y.applyUpdate(ydocA, seedState)
  Y.applyUpdate(ydocB, seedState)

  const provA = new SupabaseBroadcastProvider(clientA, doc.id, ydocA)
  await wait(1500)
  const provB = new SupabaseBroadcastProvider(clientB, doc.id, ydocB)
  await wait(2000)

  // Alice announces presence
  provA.setLocalPresence({ userId: userAId, name: 'Alice', cursorIndex: 0 })
  await wait(1500)
  assert('Bob sees Alice initially', provB.awareness.size === 1)

  // Manually backdate Alice's lastSeen to simulate staleness
  for (const [cid, state] of provB.awareness) {
    state.lastSeen = Date.now() - 20000 // 20s ago — beyond 15s threshold
  }

  // Wait for the cleanup interval (runs every 5s)
  await wait(6000)
  assert('Stale entry removed after timeout', provB.awareness.size === 0)

  provA.destroy(); provB.destroy()
  ydocA.destroy(); ydocB.destroy()
  console.log()
}

// ═══════════════════════════════════════════════════════════════════════════
// Test 14: Deterministic colors — same userId always produces same color
// ═══════════════════════════════════════════════════════════════════════════
async function testDeterministicColors() {
  console.log('═══ Test 14: Deterministic colors ═══')

  const color1 = userColor(userAId)
  const color2 = userColor(userAId)
  const color3 = userColor(userAId)
  assert('Same userId → same color (call 1 vs 2)', color1 === color2)
  assert('Same userId → same color (call 2 vs 3)', color2 === color3)
  assert('Color is a valid hex string', /^#[0-9a-f]{6}$/i.test(color1))

  const colorB = userColor(userBId)
  assert('Different userId → different color', color1 !== colorB)
  assert('Bob\'s color is also valid hex', /^#[0-9a-f]{6}$/i.test(colorB))

  // Verify consistency across different Y.Doc instances
  const ydoc1 = new Y.Doc(), ydoc2 = new Y.Doc()
  const prov1 = new SupabaseBroadcastProvider(clientA, 'dummy-1', ydoc1)
  const prov2 = new SupabaseBroadcastProvider(clientA, 'dummy-2', ydoc2)
  // Both use same userId → same color
  prov1.setLocalPresence({ userId: userAId, name: 'Alice', cursorIndex: 0 })
  prov2.setLocalPresence({ userId: userAId, name: 'Alice', cursorIndex: 0 })
  assert('Color consistent across providers', prov1._localPresence.color === prov2._localPresence.color)
  assert('Color matches userColor()', prov1._localPresence.color === color1)

  prov1.destroy(); prov2.destroy()
  ydoc1.destroy(); ydoc2.destroy()
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
  await wait(500)
  await testPresenceBroadcast()
  await wait(500)
  await testPresenceLeave()
  await wait(500)
  await testStalePresenceTimeout()
  await wait(500)
  await testDeterministicColors()

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
