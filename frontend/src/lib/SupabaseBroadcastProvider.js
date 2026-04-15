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
    this._subscribed = false
    this._documentId = documentId
    /** @type {Array<object>} Updates buffered before the channel reaches SUBSCRIBED */
    this._pendingUpdates = []

    /** @type {Record<string, Set<Function>>} */
    this._listeners = {}

    const channelName = `doc-collab-${documentId}`
    console.log('[BroadcastProvider] Creating channel:', channelName)

    // ── Channel setup ────────────────────────────────────────────────────
    this.channel = supabaseClient.channel(channelName, {
      config: { broadcast: { self: false } },
    })

    // ── Remote → local: incremental updates ──────────────────────────────
    this.channel.on('broadcast', { event: 'yjs-update' }, ({ payload }) => {
      console.log('[BroadcastProvider] [A] RECEIVED yjs-update, destroyed=', this.destroyed, 'payload keys=', Object.keys(payload || {}))
      if (this.destroyed) return
      if (!payload?.update) {
        console.warn('[BroadcastProvider] [C] yjs-update missing payload.update — skipping')
        return
      }
      try {
        const update = toUint8Array(payload.update)
        console.log('[BroadcastProvider] [D] Applying Yjs update, bytes=', update.byteLength)
        Y.applyUpdate(this.ydoc, update, 'remote')
        console.log('[BroadcastProvider] [D] Yjs update applied OK')
      } catch (err) {
        console.error('[BroadcastProvider] [D] Yjs applyUpdate FAILED:', err)
      }
    })

    // ── Sync protocol: respond to requests from other clients ────────────
    this.channel.on('broadcast', { event: 'sync-request' }, () => {
      console.log('[BroadcastProvider] [A] RECEIVED sync-request, destroyed=', this.destroyed)
      if (this.destroyed) return
      const state = Y.encodeStateAsUpdate(this.ydoc)
      console.log('[BroadcastProvider] Sending sync-response, bytes=', state.byteLength)
      this.channel.send({
        type: 'broadcast',
        event: 'sync-response',
        payload: { state: fromUint8Array(state) },
      })
    })

    // ── Sync protocol: receive response when we join ─────────────────────
    this.channel.on('broadcast', { event: 'sync-response' }, ({ payload }) => {
      console.log('[BroadcastProvider] [A] RECEIVED sync-response, destroyed=', this.destroyed, 'already synced=', this.synced)
      if (this.destroyed || this.synced) return
      if (!payload?.state) {
        console.warn('[BroadcastProvider] [C] sync-response missing payload.state — skipping')
        return
      }
      try {
        const state = toUint8Array(payload.state)
        console.log('[BroadcastProvider] [D] Applying sync-response Yjs state, bytes=', state.byteLength)
        Y.applyUpdate(this.ydoc, state, 'remote')
        this.synced = true
        this._emit('synced')
        clearTimeout(this._syncTimeout)
        console.log('[BroadcastProvider] [D] sync-response applied OK, emitted synced')
      } catch (err) {
        console.error('[BroadcastProvider] [D] sync-response Yjs applyUpdate FAILED:', err)
      }
    })

    // ── Title sync: instant broadcast (avoids DB round-trip) ──────────────
    this.channel.on('broadcast', { event: 'title-update' }, ({ payload }) => {
      console.log('[BroadcastProvider] [A] RECEIVED title-update, title=', payload?.title)
      if (this.destroyed) return
      this._emit('title-update', payload.title)
    })

    // ── Local → remote: broadcast own updates ────────────────────────────
    // Buffer messages until the channel reaches SUBSCRIBED so they aren't
    // silently dropped by the Supabase client.
    this._updateHandler = (update, origin) => {
      if (this.destroyed || origin === 'remote') return
      console.log('[BroadcastProvider] Local Yjs update origin=', origin, 'subscribed=', this._subscribed, 'bytes=', update.byteLength)
      const msg = {
        type: 'broadcast',
        event: 'yjs-update',
        payload: { update: fromUint8Array(update) },
      }
      if (this._subscribed) {
        this.channel.send(msg)
        console.log('[BroadcastProvider] Sent yjs-update broadcast')
      } else {
        this._pendingUpdates.push(msg)
        console.log('[BroadcastProvider] Buffered yjs-update (not yet subscribed), pending=', this._pendingUpdates.length)
      }
    }
    this.ydoc.on('update', this._updateHandler)

    // ── Subscribe and request sync ───────────────────────────────────────
    this._subscribe()
  }

  // ── (Re-)subscribe to the channel ──────────────────────────────────────
  // Extracted so it can be called again on CHANNEL_ERROR for automatic retry.
  _subscribe() {
    this.channel.subscribe((status) => {
      console.log('[BroadcastProvider] [A] Channel status changed:', status, '— channel= doc-collab-', this._documentId)
      if (this.destroyed) return

      if (status === 'SUBSCRIBED') {
        this._subscribed = true
        this._retryCount = 0

        // Allow re-sync on reconnection (peers may have newer state)
        this.synced = false
        clearTimeout(this._syncTimeout)

        // Flush any updates that were buffered while disconnected
        if (this._pendingUpdates.length > 0) {
          console.log('[BroadcastProvider] Flushing', this._pendingUpdates.length, 'pending updates')
          for (const msg of this._pendingUpdates) {
            this.channel.send(msg)
          }
          this._pendingUpdates = []
        }

        // Ask existing peers for their current state
        console.log('[BroadcastProvider] Sending sync-request to peers')
        this.channel.send({
          type: 'broadcast',
          event: 'sync-request',
          payload: {},
        })

        // If no peer responds within the timeout, signal the consumer
        this._syncTimeout = setTimeout(() => {
          if (!this.synced && !this.destroyed) {
            console.log('[BroadcastProvider] No peer responded within', SYNC_TIMEOUT_MS, 'ms — emitting no-peers')
            this.synced = true
            this._emit('no-peers')
          }
        }, SYNC_TIMEOUT_MS)
      } else if (status === 'CHANNEL_ERROR') {
        this._subscribed = false
        // Auto-retry: remove broken channel, create a fresh one, resubscribe.
        this._retryCount = (this._retryCount || 0) + 1
        const delay = Math.min(1000 * this._retryCount, 5000)
        console.warn('[BroadcastProvider] CHANNEL_ERROR — will retry in', delay, 'ms (attempt', this._retryCount, ')')
        clearTimeout(this._retryTimer)
        this._retryTimer = setTimeout(() => {
          if (this.destroyed) return
          console.log('[BroadcastProvider] Retrying subscription for doc-collab-', this._documentId)
          // Remove the dead channel and create a fresh one with the same
          // event handlers re-attached.
          this.supabase.removeChannel(this.channel)
          this.channel = this.supabase.channel(`doc-collab-${this._documentId}`, {
            config: { broadcast: { self: false } },
          })
          this._reattachHandlers()
          this._subscribe()
        }, delay)
      } else {
        // TIMED_OUT / CLOSED — mark as disconnected so outgoing updates
        // are buffered until the channel re-subscribes.
        console.warn('[BroadcastProvider] [B] Non-SUBSCRIBED status:', status, '— buffering outgoing updates')
        this._subscribed = false
      }
    })
  }

  // ── Re-attach broadcast event handlers to a fresh channel ─────────────
  _reattachHandlers() {
    this.channel.on('broadcast', { event: 'yjs-update' }, ({ payload }) => {
      if (this.destroyed) return
      if (!payload?.update) return
      try {
        const update = toUint8Array(payload.update)
        Y.applyUpdate(this.ydoc, update, 'remote')
        console.log('[BroadcastProvider] [retry] Yjs update applied OK, bytes=', update.byteLength)
      } catch (err) {
        console.error('[BroadcastProvider] [retry] Yjs applyUpdate FAILED:', err)
      }
    })
    this.channel.on('broadcast', { event: 'sync-request' }, () => {
      if (this.destroyed) return
      const state = Y.encodeStateAsUpdate(this.ydoc)
      this.channel.send({
        type: 'broadcast',
        event: 'sync-response',
        payload: { state: fromUint8Array(state) },
      })
    })
    this.channel.on('broadcast', { event: 'sync-response' }, ({ payload }) => {
      if (this.destroyed || this.synced) return
      if (!payload?.state) return
      try {
        const state = toUint8Array(payload.state)
        Y.applyUpdate(this.ydoc, state, 'remote')
        this.synced = true
        this._emit('synced')
        clearTimeout(this._syncTimeout)
      } catch { /* ignore malformed */ }
    })
    this.channel.on('broadcast', { event: 'title-update' }, ({ payload }) => {
      if (this.destroyed) return
      this._emit('title-update', payload.title)
    })
  }

  // ── Simple event emitter ───────────────────────────────────────────────

  /** @param {'synced' | 'no-peers' | 'title-update'} event */
  on(event, fn) {
    (this._listeners[event] ??= new Set()).add(fn)
    return this
  }

  off(event, fn) {
    this._listeners[event]?.delete(fn)
    return this
  }

  _emit(event, ...args) {
    this._listeners[event]?.forEach((fn) => fn(...args))
  }

  /** Broadcast a title change to all connected peers. */
  sendTitle(title) {
    if (this.destroyed || !this._subscribed) return
    this.channel.send({
      type: 'broadcast',
      event: 'title-update',
      payload: { title },
    })
  }

  // ── Teardown ───────────────────────────────────────────────────────────

  destroy() {
    if (this.destroyed) return
    console.log('[BroadcastProvider] Destroying channel doc-collab-', this._documentId)
    this.destroyed = true
    this._subscribed = false
    this._pendingUpdates = []
    clearTimeout(this._syncTimeout)
    clearTimeout(this._retryTimer)
    this.ydoc.off('update', this._updateHandler)
    this.supabase.removeChannel(this.channel)
    this._listeners = {}
  }
}
