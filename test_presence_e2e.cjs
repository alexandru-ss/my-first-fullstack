/**
 * End-to-end presence & awareness test suite.
 *
 * Simulates the manual browser test plan programmatically:
 *   1. Presence appears: A opens doc → B opens same doc → both see each other
 *   2. Consistent colors: A reconnects → color stays the same
 *   3. User leaves: B closes tab (destroy) → A sees B disappear immediately
 *   4. Rapid reconnect: B reopens quickly → single entry, no duplicate
 *   5. Cursor position: B moves cursor → A sees updated position
 *   6. Multiple users: A, B, C all connected → each sees the other two
 *   7. Name display: awareness entries contain correct display names
 *
 * Usage: node test_presence_e2e.cjs
 */

const { createClient } = require('./frontend/node_modules/@supabase/supabase-js')

const SUPABASE_URL = 'http://127.0.0.1:54321'
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0'

const USER_A_EMAIL = 'alice@example.com'
const USER_B_EMAIL = 'bob@example.com'
const USER_C_EMAIL = 'charlie@example.com'
const PASSWORD = 'password123'

function wait(ms) { return new Promise(r => setTimeout(r, ms)) }
function pad(label) { return label.padEnd(52, ' ') }

let Y, fromUint8Array, toUint8Array, SupabaseBroadcastProvider, userColor
let clientA, clientB, clientC, userAId, userBId, userCId
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
  clientC = createClient(SUPABASE_URL, SUPABASE_ANON_KEY)

  const { data: dA, error: eA } = await clientA.auth.signInWithPassword({ email: USER_A_EMAIL, password: PASSWORD })
  if (eA) throw new Error('Alice sign-in failed: ' + eA.message)
  userAId = dA.user.id

  const { data: dB, error: eB } = await clientB.auth.signInWithPassword({ email: USER_B_EMAIL, password: PASSWORD })
  if (eB) throw new Error('Bob sign-in failed: ' + eB.message)
  userBId = dB.user.id

  const { data: dC, error: eC } = await clientC.auth.signInWithPassword({ email: USER_C_EMAIL, password: PASSWORD })
  if (eC) throw new Error('Charlie sign-in failed: ' + eC.message)
  userCId = dC.user.id

  console.log(`Signed in: Alice=${userAId.slice(0,8)}… Bob=${userBId.slice(0,8)}… Charlie=${userCId.slice(0,8)}…\n`)
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

async function createTestDoc(title, body) {
  const { data: doc, error } = await clientA
    .from('documents')
    .insert({ user_id: userAId, title, body })
    .select('id, title, body, yjs_state')
    .single()
  if (error) throw new Error('Failed to create doc: ' + error.message)

  // Share with Bob and Charlie
  const { error: e1 } = await clientA
    .from('document_shares')
    .insert({ document_id: doc.id, owner_id: userAId, shared_with_id: userBId, shared_with_email: USER_B_EMAIL, permission: 'edit' })
  if (e1) throw new Error('Failed to share with Bob: ' + e1.message)

  const { error: e2 } = await clientA
    .from('document_shares')
    .insert({ document_id: doc.id, owner_id: userAId, shared_with_id: userCId, shared_with_email: USER_C_EMAIL, permission: 'edit' })
  if (e2) throw new Error('Failed to share with Charlie: ' + e2.message)

  return doc
}

/** Helper: create a Y.Doc + provider pair, set initial content, announce presence. */
function openDoc(client, docId, seedState, userId, name) {
  const ydoc = new Y.Doc()
  if (seedState) Y.applyUpdate(ydoc, seedState)
  const provider = new SupabaseBroadcastProvider(client, docId, ydoc)
  // Announce presence once subscribed (provider does this internally after setLocalPresence)
  return { ydoc, provider, userId, name }
}

/** Helper: read awareness as array, optionally excluding a clientId. */
function getRemoteUsers(provider, excludeClientId) {
  const users = []
  for (const [cid, state] of provider.awareness) {
    if (cid !== excludeClientId) users.push({ clientId: cid, ...state })
  }
  return users
}

// ═══════════════════════════════════════════════════════════════════════════
// Test 1: Presence appears — A opens, then B opens, both see each other
// ═══════════════════════════════════════════════════════════════════════════
async function testPresenceAppears() {
  console.log('═══ Test 1: Presence appears ═══')

  const seedDoc = new Y.Doc()
  seedDoc.getText('content').insert(0, 'presence test content')
  const seedState = Y.encodeStateAsUpdate(seedDoc)
  seedDoc.destroy()

  const doc = await createTestDoc('Presence-Appears-' + Date.now(), 'presence test content')

  // Alice opens the document
  const a = openDoc(clientA, doc.id, seedState, userAId, 'Alice')
  await wait(1500)

  // Alice announces presence
  a.provider.setLocalPresence({ userId: userAId, name: 'Alice', cursorIndex: 0 })
  await wait(500)

  // No one else is here yet — Alice's awareness should be empty (self is excluded via channel config)
  assert('Alice sees 0 remote users initially', getRemoteUsers(a.provider, a.ydoc.clientID).length === 0)

  // Bob opens the document
  const b = openDoc(clientB, doc.id, seedState, userBId, 'Bob')
  await wait(2000)
  b.provider.setLocalPresence({ userId: userBId, name: 'Bob', cursorIndex: 0 })
  await wait(1500)

  // Both should see each other
  const aliceSees = getRemoteUsers(a.provider, a.ydoc.clientID)
  const bobSees = getRemoteUsers(b.provider, b.ydoc.clientID)

  assert('Alice sees 1 remote user (Bob)', aliceSees.length === 1)
  assert('Alice sees Bob\'s name', aliceSees[0]?.name === 'Bob')
  assert('Alice sees Bob\'s userId', aliceSees[0]?.userId === userBId)

  assert('Bob sees 1 remote user (Alice)', bobSees.length === 1)
  assert('Bob sees Alice\'s name', bobSees[0]?.name === 'Alice')
  assert('Bob sees Alice\'s userId', bobSees[0]?.userId === userAId)

  a.provider.destroy(); b.provider.destroy()
  a.ydoc.destroy(); b.ydoc.destroy()
  console.log()
}

// ═══════════════════════════════════════════════════════════════════════════
// Test 2: Consistent colors — A reconnects, color is the same
// ═══════════════════════════════════════════════════════════════════════════
async function testConsistentColors() {
  console.log('═══ Test 2: Consistent colors across reconnects ═══')

  const seedDoc = new Y.Doc()
  seedDoc.getText('content').insert(0, 'color test')
  const seedState = Y.encodeStateAsUpdate(seedDoc)
  seedDoc.destroy()

  const doc = await createTestDoc('Color-Consistency-' + Date.now(), 'color test')

  // Bob opens and waits
  const b = openDoc(clientB, doc.id, seedState, userBId, 'Bob')
  await wait(1500)
  b.provider.setLocalPresence({ userId: userBId, name: 'Bob', cursorIndex: 0 })

  // Alice opens — first session
  const a1 = openDoc(clientA, doc.id, seedState, userAId, 'Alice')
  await wait(2000)
  a1.provider.setLocalPresence({ userId: userAId, name: 'Alice', cursorIndex: 0 })
  await wait(1500)

  // Record Alice's color as seen by Bob
  const bobSeesRound1 = getRemoteUsers(b.provider, b.ydoc.clientID)
  const aliceColorRound1 = bobSeesRound1.find(u => u.userId === userAId)?.color
  assert('Bob sees Alice (round 1)', aliceColorRound1 != null)
  console.log(`  [info] Alice's color round 1: ${aliceColorRound1}`)

  // Alice "refreshes" — destroy + recreate
  a1.provider.destroy()
  a1.ydoc.destroy()
  await wait(1500)

  const a2 = openDoc(clientA, doc.id, seedState, userAId, 'Alice')
  await wait(2000)
  a2.provider.setLocalPresence({ userId: userAId, name: 'Alice', cursorIndex: 0 })
  await wait(1500)

  // Record Alice's color again
  const bobSeesRound2 = getRemoteUsers(b.provider, b.ydoc.clientID)
  const aliceColorRound2 = bobSeesRound2.find(u => u.userId === userAId)?.color
  assert('Bob sees Alice (round 2)', aliceColorRound2 != null)
  console.log(`  [info] Alice's color round 2: ${aliceColorRound2}`)

  assert('Color is identical after refresh', aliceColorRound1 === aliceColorRound2)
  assert('Color matches userColor(userId)', aliceColorRound1 === userColor(userAId))

  a2.provider.destroy(); b.provider.destroy()
  a2.ydoc.destroy(); b.ydoc.destroy()
  console.log()
}

// ═══════════════════════════════════════════════════════════════════════════
// Test 3: User leaves — B closes tab → A sees B disappear
// ═══════════════════════════════════════════════════════════════════════════
async function testUserLeaves() {
  console.log('═══ Test 3: User leaves (destroy sends leave) ═══')

  const seedDoc = new Y.Doc()
  seedDoc.getText('content').insert(0, 'leave test')
  const seedState = Y.encodeStateAsUpdate(seedDoc)
  seedDoc.destroy()

  const doc = await createTestDoc('Leave-Test-' + Date.now(), 'leave test')

  const a = openDoc(clientA, doc.id, seedState, userAId, 'Alice')
  await wait(1500)
  a.provider.setLocalPresence({ userId: userAId, name: 'Alice', cursorIndex: 0 })

  const b = openDoc(clientB, doc.id, seedState, userBId, 'Bob')
  await wait(2000)
  b.provider.setLocalPresence({ userId: userBId, name: 'Bob', cursorIndex: 0 })
  await wait(1500)

  const beforeLeave = getRemoteUsers(a.provider, a.ydoc.clientID)
  assert('Alice sees Bob before leave', beforeLeave.length === 1 && beforeLeave[0].userId === userBId)

  // Bob closes his tab (simulated by provider.destroy() which calls sendLeave())
  b.provider.destroy()
  b.ydoc.destroy()
  await wait(1500)

  const afterLeave = getRemoteUsers(a.provider, a.ydoc.clientID)
  assert('Alice sees 0 users after Bob leaves', afterLeave.length === 0)

  a.provider.destroy()
  a.ydoc.destroy()
  console.log()
}

// ═══════════════════════════════════════════════════════════════════════════
// Test 4: Rapid reconnect — B leaves and rejoins quickly, no duplicates
// ═══════════════════════════════════════════════════════════════════════════
async function testRapidReconnect() {
  console.log('═══ Test 4: Rapid reconnect (no duplicates) ═══')

  const seedDoc = new Y.Doc()
  seedDoc.getText('content').insert(0, 'reconnect test')
  const seedState = Y.encodeStateAsUpdate(seedDoc)
  seedDoc.destroy()

  const doc = await createTestDoc('Reconnect-' + Date.now(), 'reconnect test')

  const a = openDoc(clientA, doc.id, seedState, userAId, 'Alice')
  await wait(1500)
  a.provider.setLocalPresence({ userId: userAId, name: 'Alice', cursorIndex: 0 })

  // Bob connects first time
  let b = openDoc(clientB, doc.id, seedState, userBId, 'Bob')
  await wait(2000)
  b.provider.setLocalPresence({ userId: userBId, name: 'Bob', cursorIndex: 0 })
  await wait(1500)

  assert('Alice sees Bob initially', getRemoteUsers(a.provider, a.ydoc.clientID).length === 1)

  // Bob leaves
  b.provider.destroy()
  b.ydoc.destroy()
  await wait(500) // Brief gap — rapid reconnect

  // Bob immediately rejoins
  b = openDoc(clientB, doc.id, seedState, userBId, 'Bob')
  await wait(2000)
  b.provider.setLocalPresence({ userId: userBId, name: 'Bob', cursorIndex: 0 })
  await wait(1500)

  const aliceSees = getRemoteUsers(a.provider, a.ydoc.clientID)
  assert('Alice sees exactly 1 user after reconnect', aliceSees.length === 1)
  assert('That user is Bob', aliceSees[0]?.userId === userBId)
  assert('No duplicate entries', aliceSees.filter(u => u.userId === userBId).length === 1)

  a.provider.destroy(); b.provider.destroy()
  a.ydoc.destroy(); b.ydoc.destroy()
  console.log()
}

// ═══════════════════════════════════════════════════════════════════════════
// Test 5: Cursor position — B moves cursor → A sees updated position
// ═══════════════════════════════════════════════════════════════════════════
async function testCursorPosition() {
  console.log('═══ Test 5: Cursor position updates ═══')

  const content = 'Line 1\nLine 2\nLine 3\nLine 4\nLine 5'
  const seedDoc = new Y.Doc()
  seedDoc.getText('content').insert(0, content)
  const seedState = Y.encodeStateAsUpdate(seedDoc)
  seedDoc.destroy()

  const doc = await createTestDoc('Cursor-Pos-' + Date.now(), content)

  const a = openDoc(clientA, doc.id, seedState, userAId, 'Alice')
  await wait(1500)
  a.provider.setLocalPresence({ userId: userAId, name: 'Alice', cursorIndex: 0 })

  const b = openDoc(clientB, doc.id, seedState, userBId, 'Bob')
  await wait(2000)

  // Bob places cursor at beginning of "Line 3" (index = 14: "Line 1\nLine 2\n" = 14 chars)
  b.provider.setLocalPresence({ userId: userBId, name: 'Bob', cursorIndex: 14 })
  await wait(1500)

  let aliceSees = getRemoteUsers(a.provider, a.ydoc.clientID)
  const bobEntry1 = aliceSees.find(u => u.userId === userBId)
  assert('Alice sees Bob\'s cursor at index 14', bobEntry1?.cursorIndex === 14)

  // Verify line calculation: index 14 → line 2 (0-indexed)
  const line1 = content.slice(0, 14).split('\n').length - 1
  assert('Cursor at index 14 = line 2 (0-indexed)', line1 === 2)

  // Bob moves cursor to "Line 5" (index = 28: "Line 1\nLine 2\nLine 3\nLine 4\n" = 28 chars)
  b.provider.setLocalPresence({ userId: userBId, name: 'Bob', cursorIndex: 28 })
  await wait(1500)

  aliceSees = getRemoteUsers(a.provider, a.ydoc.clientID)
  const bobEntry2 = aliceSees.find(u => u.userId === userBId)
  assert('Alice sees Bob\'s cursor moved to index 28', bobEntry2?.cursorIndex === 28)

  const line2 = content.slice(0, 28).split('\n').length - 1
  assert('Cursor at index 28 = line 4 (0-indexed)', line2 === 4)

  // Bob moves cursor to beginning (index 0)
  b.provider.setLocalPresence({ userId: userBId, name: 'Bob', cursorIndex: 0 })
  await wait(1500)

  aliceSees = getRemoteUsers(a.provider, a.ydoc.clientID)
  const bobEntry3 = aliceSees.find(u => u.userId === userBId)
  assert('Cursor moved back to index 0', bobEntry3?.cursorIndex === 0)

  a.provider.destroy(); b.provider.destroy()
  a.ydoc.destroy(); b.ydoc.destroy()
  console.log()
}

// ═══════════════════════════════════════════════════════════════════════════
// Test 6: Multiple users — A, B, C all connected, each sees the other two
// ═══════════════════════════════════════════════════════════════════════════
async function testMultipleUsers() {
  console.log('═══ Test 6: Multiple users (3-way presence) ═══')

  const seedDoc = new Y.Doc()
  seedDoc.getText('content').insert(0, 'three users')
  const seedState = Y.encodeStateAsUpdate(seedDoc)
  seedDoc.destroy()

  const doc = await createTestDoc('Multi-User-' + Date.now(), 'three users')

  // All three connect
  const a = openDoc(clientA, doc.id, seedState, userAId, 'Alice')
  await wait(1500)
  a.provider.setLocalPresence({ userId: userAId, name: 'Alice', cursorIndex: 0 })

  const b = openDoc(clientB, doc.id, seedState, userBId, 'Bob')
  await wait(2000)
  b.provider.setLocalPresence({ userId: userBId, name: 'Bob', cursorIndex: 5 })
  await wait(1500)

  const c = openDoc(clientC, doc.id, seedState, userCId, 'Charlie')
  await wait(2000)
  c.provider.setLocalPresence({ userId: userCId, name: 'Charlie', cursorIndex: 10 })
  await wait(1500)

  // Each should see the other two
  const aSees = getRemoteUsers(a.provider, a.ydoc.clientID)
  const bSees = getRemoteUsers(b.provider, b.ydoc.clientID)
  const cSees = getRemoteUsers(c.provider, c.ydoc.clientID)

  assert('Alice sees 2 remote users', aSees.length === 2)
  assert('Alice sees Bob', aSees.some(u => u.userId === userBId && u.name === 'Bob'))
  assert('Alice sees Charlie', aSees.some(u => u.userId === userCId && u.name === 'Charlie'))

  assert('Bob sees 2 remote users', bSees.length === 2)
  assert('Bob sees Alice', bSees.some(u => u.userId === userAId && u.name === 'Alice'))
  assert('Bob sees Charlie', bSees.some(u => u.userId === userCId && u.name === 'Charlie'))

  assert('Charlie sees 2 remote users', cSees.length === 2)
  assert('Charlie sees Alice', cSees.some(u => u.userId === userAId && u.name === 'Alice'))
  assert('Charlie sees Bob', cSees.some(u => u.userId === userBId && u.name === 'Bob'))

  // All three have distinct colors
  const colorA = userColor(userAId)
  const colorB = userColor(userBId)
  const colorC = userColor(userCId)
  assert('All 3 colors are distinct', colorA !== colorB && colorB !== colorC && colorA !== colorC)

  // Charlie leaves → A and B each see only 1
  c.provider.destroy()
  c.ydoc.destroy()
  await wait(1500)

  const aSeesAfter = getRemoteUsers(a.provider, a.ydoc.clientID)
  const bSeesAfter = getRemoteUsers(b.provider, b.ydoc.clientID)
  assert('Alice sees 1 after Charlie leaves', aSeesAfter.length === 1 && aSeesAfter[0].userId === userBId)
  assert('Bob sees 1 after Charlie leaves', bSeesAfter.length === 1 && bSeesAfter[0].userId === userAId)

  a.provider.destroy(); b.provider.destroy()
  a.ydoc.destroy(); b.ydoc.destroy()
  console.log()
}

// ═══════════════════════════════════════════════════════════════════════════
// Test 7: Name display — awareness entries contain correct display names
// ═══════════════════════════════════════════════════════════════════════════
async function testNameDisplay() {
  console.log('═══ Test 7: Name display in awareness ═══')

  const seedDoc = new Y.Doc()
  seedDoc.getText('content').insert(0, 'name test')
  const seedState = Y.encodeStateAsUpdate(seedDoc)
  seedDoc.destroy()

  const doc = await createTestDoc('Name-Display-' + Date.now(), 'name test')

  const a = openDoc(clientA, doc.id, seedState, userAId, 'Alice Wonderland')
  await wait(1500)
  a.provider.setLocalPresence({ userId: userAId, name: 'Alice Wonderland', cursorIndex: 0 })

  const b = openDoc(clientB, doc.id, seedState, userBId, 'Bob Builder')
  await wait(2000)
  b.provider.setLocalPresence({ userId: userBId, name: 'Bob Builder', cursorIndex: 0 })
  await wait(1500)

  const aliceSees = getRemoteUsers(a.provider, a.ydoc.clientID)
  const bobSees = getRemoteUsers(b.provider, b.ydoc.clientID)

  // Full display names preserved in awareness
  assert('Alice sees "Bob Builder"', aliceSees[0]?.name === 'Bob Builder')
  assert('Bob sees "Alice Wonderland"', bobSees[0]?.name === 'Alice Wonderland')

  // Colors are present
  assert('Bob entry has a color', aliceSees[0]?.color != null)
  assert('Alice entry has a color', bobSees[0]?.color != null)

  // Verify the avatar initial would be correct (first char of name)
  assert('Bob\'s initial would be "B"', aliceSees[0]?.name[0] === 'B')
  assert('Alice\'s initial would be "A"', bobSees[0]?.name[0] === 'A')

  // Name can be updated live (simulates user editing their profile)
  b.provider.setLocalPresence({ userId: userBId, name: 'Robert Builder', cursorIndex: 0 })
  await wait(1500)

  const aliceSeesUpdated = getRemoteUsers(a.provider, a.ydoc.clientID)
  assert('Name updates live: "Robert Builder"', aliceSeesUpdated.find(u => u.userId === userBId)?.name === 'Robert Builder')

  a.provider.destroy(); b.provider.destroy()
  a.ydoc.destroy(); b.ydoc.destroy()
  console.log()
}

// ═══════════════════════════════════════════════════════════════════════════
// Run all tests
// ═══════════════════════════════════════════════════════════════════════════
async function main() {
  console.log('╔═══════════════════════════════════════════════════════════╗')
  console.log('║  Presence & Awareness E2E Test Suite                     ║')
  console.log('╚═══════════════════════════════════════════════════════════╝\n')

  await setup()

  await testPresenceAppears()
  await wait(500)
  await testConsistentColors()
  await wait(500)
  await testUserLeaves()
  await wait(500)
  await testRapidReconnect()
  await wait(500)
  await testCursorPosition()
  await wait(500)
  await testMultipleUsers()
  await wait(500)
  await testNameDisplay()

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
