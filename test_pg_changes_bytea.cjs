/**
 * Test: what format does Supabase Realtime deliver bytea (yjs_state) in
 * postgres_changes events?  And verify bidirectional Yjs broadcast between
 * owner and shared-user authenticated Supabase clients.
 *
 * Usage: node test_pg_changes_bytea.cjs
 */

const { createClient } = require('./frontend/node_modules/@supabase/supabase-js')

const URL = 'http://127.0.0.1:54321'
const ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0'

const wait = ms => new Promise(r => setTimeout(r, ms))

async function main() {
  const Y = await import('./frontend/node_modules/yjs/dist/yjs.mjs')
  const { fromUint8Array, toUint8Array } = await import('./frontend/node_modules/js-base64/base64.mjs')

  // ── Sign in as Alice (owner) and Bob (shared user) ─────────────────────
  const alice = createClient(URL, ANON)
  const bob   = createClient(URL, ANON)

  const { data: aAuth } = await alice.auth.signInWithPassword({ email: 'alice@example.com', password: 'password123' })
  const { data: bAuth } = await bob.auth.signInWithPassword({ email: 'bob@example.com', password: 'password123' })
  console.log('Alice uid:', aAuth.user.id)
  console.log('Bob   uid:', bAuth.user.id)

  // ── Create a document owned by Alice ────────────────────────────────────
  const ydoc = new Y.Doc()
  ydoc.getText('content').insert(0, 'initial content')
  const yjsB64 = fromUint8Array(Y.encodeStateAsUpdate(ydoc))

  const { data: doc, error: createErr } = await alice
    .from('documents')
    .insert({ user_id: aAuth.user.id, title: 'Bytea Test', body: 'initial content', yjs_state: yjsB64 })
    .select()
    .single()
  if (createErr) { console.error('Create error:', createErr); process.exit(1) }
  console.log('Created doc:', doc.id)
  ydoc.destroy()

  // ── Share with Bob (edit) ──────────────────────────────────────────────
  const { error: shareErr } = await alice
    .from('document_shares')
    .insert({ document_id: doc.id, owner_id: aAuth.user.id, shared_with_id: bAuth.user.id, permission: 'edit' })
  if (shareErr) { console.error('Share error:', shareErr); process.exit(1) }
  console.log('Shared with Bob\n')

  // ── Test 1: postgres_changes bytea encoding ────────────────────────────
  console.log('═══ Test 1: postgres_changes yjs_state encoding ═══')

  let receivedRow = null
  const pgChan = bob
    .channel('test-pg-changes')
    .on(
      'postgres_changes',
      { event: 'UPDATE', schema: 'public', table: 'documents', filter: `id=eq.${doc.id}` },
      ({ new: newRow }) => {
        receivedRow = newRow
        console.log('  postgres_changes received!')
        console.log('  yjs_state type:', typeof newRow.yjs_state)
        console.log('  yjs_state value (first 60 chars):', String(newRow.yjs_state).slice(0, 60))
        console.log('  yjs_state starts with \\x?', String(newRow.yjs_state).startsWith('\\x'))
        console.log('  body:', JSON.stringify(newRow.body))
      }
    )
    .subscribe()

  await wait(1500)

  // Alice updates the doc
  const ydoc2 = new Y.Doc()
  ydoc2.getText('content').insert(0, 'updated content')
  const yjsB64_2 = fromUint8Array(Y.encodeStateAsUpdate(ydoc2))

  console.log('  Alice updating doc...')
  const { error: updateErr } = await alice
    .from('documents')
    .update({ body: 'updated content', yjs_state: yjsB64_2 })
    .eq('id', doc.id)
  if (updateErr) console.error('  Update error:', updateErr)

  await wait(2000)

  if (receivedRow) {
    console.log('\n  Trying toUint8Array on yjs_state...')
    try {
      const decoded = toUint8Array(receivedRow.yjs_state)
      console.log('  ✅ toUint8Array succeeded, length:', decoded.length)
      const testDoc = new Y.Doc()
      Y.applyUpdate(testDoc, decoded)
      console.log('  ✅ Y.applyUpdate succeeded, text:', JSON.stringify(testDoc.getText('content').toString()))
      testDoc.destroy()
    } catch (err) {
      console.log('  ❌ toUint8Array failed:', err.message)
    }
  } else {
    console.log('  ❌ No postgres_changes event received')
  }
  ydoc2.destroy()

  await bob.removeChannel(pgChan)
  await wait(500)

  // ── Test 2: Bidirectional Yjs broadcast (owner ↔ shared user) ──────────
  console.log('\n═══ Test 2: Bidirectional Yjs Broadcast ═══')
  const { SupabaseBroadcastProvider } = await import('./frontend/src/lib/SupabaseBroadcastProvider.js')

  // Load the doc's yjs_state from DB for both users
  const { data: docData } = await alice.from('documents').select('yjs_state, body').eq('id', doc.id).single()

  const ydocA = new Y.Doc()
  const ydocB = new Y.Doc()
  if (docData.yjs_state) {
    try {
      Y.applyUpdate(ydocA, toUint8Array(docData.yjs_state))
      Y.applyUpdate(ydocB, toUint8Array(docData.yjs_state))
    } catch (err) {
      console.log('  ⚠️ Failed to load yjs_state from DB:', err.message)
    }
  }
  console.log('  [A] initial:', JSON.stringify(ydocA.getText('content').toString()))
  console.log('  [B] initial:', JSON.stringify(ydocB.getText('content').toString()))

  const provA = new SupabaseBroadcastProvider(alice, doc.id, ydocA)
  await wait(2000)
  const provB = new SupabaseBroadcastProvider(bob, doc.id, ydocB)
  await wait(2500)

  // Alice → Bob
  console.log('\n  [A] typing " - alice"...')
  ydocA.getText('content').insert(ydocA.getText('content').toString().length, ' - alice')
  await wait(2000)
  console.log('  [A]:', JSON.stringify(ydocA.getText('content').toString()))
  console.log('  [B]:', JSON.stringify(ydocB.getText('content').toString()))
  const aliceToBob = ydocA.getText('content').toString() === ydocB.getText('content').toString()
  console.log('  Alice→Bob:', aliceToBob ? '✅' : '❌')

  // Bob → Alice
  console.log('\n  [B] typing " - bob"...')
  ydocB.getText('content').insert(ydocB.getText('content').toString().length, ' - bob')
  await wait(2000)
  console.log('  [A]:', JSON.stringify(ydocA.getText('content').toString()))
  console.log('  [B]:', JSON.stringify(ydocB.getText('content').toString()))
  const bobToAlice = ydocA.getText('content').toString() === ydocB.getText('content').toString()
  console.log('  Bob→Alice:', bobToAlice ? '✅' : '❌')

  // ── Cleanup ────────────────────────────────────────────────────────────
  provA.destroy()
  provB.destroy()
  ydocA.destroy()
  ydocB.destroy()

  await alice.from('document_shares').delete().eq('document_id', doc.id)
  await alice.from('documents').delete().eq('id', doc.id)
  console.log('\nCleaned up test data.')

  const allPassed = aliceToBob && bobToAlice
  console.log(allPassed ? '\n✅ ALL TESTS PASSED' : '\n❌ SOME TESTS FAILED')
  setTimeout(() => process.exit(allPassed ? 0 : 1), 500)
}

main().catch(err => { console.error(err); process.exit(1) })
