import * as Y from 'yjs'
import { fromUint8Array, toUint8Array } from 'js-base64'

/**
 * Syncs a Y.Doc over Supabase Realtime Broadcast.
 *
 * Protocol:
 *   1. On channel join → broadcast `sync-request`
 *   2. Existing peers respond with `sync-response` (full encoded state)
 *   3. If no response within SYNC_TIMEOUT_MS → emit `no-peers`
 *   4. Ongoing edits are broadcast as incremental `yjs-update` messages
 *
 * Usage:
 *   const provider = new SupabaseBroadcastProvider(supabase, docId, ydoc)
 *   provider.on('synced',   () => { … })   // peer state received
 *   provider.on('no-peers', () => { … })   // no peers online, load from DB
 *   // later:
 *   provider.destroy()
 */

const SYNC_TIMEOUT_MS = 1500

export class SupabaseBroadcastProvider {
  /** @param {import('@supabase/supabase-js').SupabaseClient} supabaseClient */
  constructor(supabaseClient, documentId, ydoc) {
    this.supabase = supabaseClient
    this.ydoc = ydoc
    this.synced = false
    this.destroyed = false

    /** @type {Record<string, Set<Function>>} */
    this._listeners = {}

    // ── Channel setup ────────────────────────────────────────────────────
    this.channel = supabaseClient.channel(`doc-collab-${documentId}`, {
      config: { broadcast: { self: false } },
    })

    // ── Remote → local: incremental updates ──────────────────────────────
    this.channel.on('broadcast', { event: 'yjs-update' }, ({ payload }) => {
      if (this.destroyed) return
      try {
        const update = toUint8Array(payload.update)
        Y.applyUpdate(this.ydoc, update, 'remote')
      } catch { /* ignore malformed payloads */ }
    })

    // ── Sync protocol: respond to requests from other clients ────────────
    this.channel.on('broadcast', { event: 'sync-request' }, () => {
      if (this.destroyed) return
      const state = Y.encodeStateAsUpdate(this.ydoc)
      this.channel.send({
        type: 'broadcast',
        event: 'sync-response',
        payload: { state: fromUint8Array(state) },
      })
    })

    // ── Sync protocol: receive response when we join ─────────────────────
    this.channel.on('broadcast', { event: 'sync-response' }, ({ payload }) => {
      if (this.destroyed || this.synced) return
      try {
        const state = toUint8Array(payload.state)
        Y.applyUpdate(this.ydoc, state, 'remote')
        this.synced = true
        this._emit('synced')
        clearTimeout(this._syncTimeout)
      } catch { /* ignore malformed payloads */ }
    })

    // ── Local → remote: broadcast own updates ────────────────────────────
    this._updateHandler = (update, origin) => {
      if (this.destroyed || origin === 'remote') return
      this.channel.send({
        type: 'broadcast',
        event: 'yjs-update',
        payload: { update: fromUint8Array(update) },
      })
    }
    this.ydoc.on('update', this._updateHandler)

    // ── Subscribe and request sync ───────────────────────────────────────
    this.channel.subscribe((status) => {
      if (status !== 'SUBSCRIBED' || this.destroyed) return

      // Ask existing peers for their current state
      this.channel.send({
        type: 'broadcast',
        event: 'sync-request',
        payload: {},
      })

      // If no peer responds within the timeout, signal the consumer
      this._syncTimeout = setTimeout(() => {
        if (!this.synced && !this.destroyed) {
          this.synced = true
          this._emit('no-peers')
        }
      }, SYNC_TIMEOUT_MS)
    })
  }

  // ── Simple event emitter ───────────────────────────────────────────────

  /** @param {'synced' | 'no-peers'} event */
  on(event, fn) {
    (this._listeners[event] ??= new Set()).add(fn)
    return this
  }

  off(event, fn) {
    this._listeners[event]?.delete(fn)
    return this
  }

  _emit(event) {
    this._listeners[event]?.forEach((fn) => fn())
  }

  // ── Teardown ───────────────────────────────────────────────────────────

  destroy() {
    if (this.destroyed) return
    this.destroyed = true
    clearTimeout(this._syncTimeout)
    this.ydoc.off('update', this._updateHandler)
    this.supabase.removeChannel(this.channel)
    this._listeners = {}
  }
}
