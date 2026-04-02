import { useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { supabase } from '../lib/supabase'

// rerender-no-inline-components: SearchBar defined at module scope, receives props
function SearchBar({ value, onChange, onClear }) {
  return (
    <div className="search-bar">
      <input
        className="search-bar-input field-input"
        type="search"
        placeholder="Search notes…"
        value={value}
        onChange={onChange}
        aria-label="Search notes"
      />
      {value !== '' && (
        <button
          className="search-bar-clear"
          onClick={onClear}
          aria-label="Clear search"
          type="button"
        >
          ✕
        </button>
      )}
    </div>
  )
}

// rerender-no-inline-components: NoteItem defined at module scope, receives props
function NoteItem({ note, view, onEdit, onTogglePin, onArchive, onUnarchive, onDeletePermanently, onTagClick }) {
  const dateValue = view === 'archived' ? note.archived_at : note.updated_at
  return (
    <li className={`note-item${note.pinned && view === 'active' ? ' note-item--pinned' : ''}`}>
      <div className="note-item-body">
        <h3 className="note-title">{note.title}</h3>
        {note.content && <p className="note-content">{note.content}</p>}
        <time className="note-date" dateTime={dateValue}>
          {new Date(dateValue).toLocaleDateString(undefined, {
            year: 'numeric', month: 'short', day: 'numeric',
          })}
        </time>
        {view === 'active' && note.tags && note.tags.length > 0 && (
          <div className="tags-row">
            {note.tags.map(tag => (
              <button
                key={tag.id}
                className="tag-pill tag-pill--interactive"
                onClick={() => onTagClick(tag)}
                type="button"
              >
                {tag.name}
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="note-item-actions">
        {view === 'active' ? (
          <>
            <button
              className={`btn-pin${note.pinned ? ' is-pinned' : ''}`}
              onClick={() => onTogglePin(note)}
              aria-label={note.pinned ? 'Unpin note' : 'Pin note'}
              title={note.pinned ? 'Unpin' : 'Pin'}
            >
              📌
            </button>
            <button className="btn-secondary" onClick={() => onEdit(note)}>Edit</button>
            <button className="btn-secondary" onClick={() => onArchive(note)}>Archive</button>
          </>
        ) : (
          <>
            <button className="btn-secondary" onClick={() => onUnarchive(note)}>Unarchive</button>
            <button className="btn-danger" onClick={() => onDeletePermanently(note.id)}>Delete</button>
          </>
        )}
      </div>
    </li>
  )
}

const PAGE_SIZE = 10

/**
 * Fetches and displays notes for the given user.
 * Exposes `onSaved` to let a parent push optimistic updates without re-fetching.
 *
 * @param {{
 *   userId: string,
 *   view: 'active' | 'archived',
 *   activeTagId: number | null,
 *   onEdit: (note: object) => void,
 *   onTagClick: (tag: object) => void
 * }} props
 */
export function NotesList({ userId, view, activeTagId, onEdit, onTagClick, listRef }) {
  const [notes, setNotes] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  // totalCount: total rows matching current filters; null when search is active (no pagination).
  // rerender-split-combined-hooks: independent of `loading` — different lifecycles.
  const [totalCount, setTotalCount] = useState(null)
  const [loadingMore, setLoadingMore] = useState(false)

  // Inline error toast — auto-dismissed after 4 s.
  // rerender-use-ref-transient-values: dismiss timer lives in a ref so updates don't re-render.
  const [toastError, setToastError] = useState(null)
  const toastTimerRef = useRef(null)

  // rerender-move-effect-to-event: showError is called from handlers, never from effects.
  function showError(message) {
    clearTimeout(toastTimerRef.current)
    setToastError(message)
    toastTimerRef.current = setTimeout(() => setToastError(null), 4000)
  }

  // Search state: searchInput is bound to the <input> value (updates on every keystroke).
  // debouncedSearch is what actually triggers the fetch (updated 300ms after typing stops).
  // rerender-use-ref-transient-values: timer ID lives in a ref — updating it must not re-render.
  const [searchInput, setSearchInput] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const debounceTimerRef = useRef(null)

  // advanced-use-latest: updated every render so the Realtime handler always reads
  // current values without recreating the channel subscription on every prop change.
  const viewRef = useRef(view)
  viewRef.current = view
  const activeTagIdRef = useRef(activeTagId)
  activeTagIdRef.current = activeTagId

  // rerender-move-effect-to-event: timer management lives in the event handler, not an effect.
  function handleSearchChange(e) {
    const value = e.target.value
    setSearchInput(value)
    clearTimeout(debounceTimerRef.current)
    debounceTimerRef.current = setTimeout(() => setDebouncedSearch(value), 300)
  }

  // Explicit clear skips the debounce — the list should revert immediately.
  function handleSearchClear() {
    clearTimeout(debounceTimerRef.current)
    setSearchInput('')
    setDebouncedSearch('')
  }

  // rerender-dependencies: depend on userId + view + activeTagId + debouncedSearch (all primitives)
  useEffect(() => {
    if (!userId) return

    let cancelled = false

    async function fetchNotes() {
      setLoading(true)
      setError(null)
      setLoadingMore(false)

      const isSearching = debouncedSearch.trim() !== ''

      // Use inner join when filtering by tag so only notes with that tag are returned
      const tagSelect = activeTagId != null
        ? 'note_tags!inner(tag_id, tags(id, name))'
        : 'note_tags(tag_id, tags(id, name))'

      const selectStr = `id, title, content, pinned, archived_at, created_at, updated_at, ${tagSelect}`

      // Search returns all matches (no pagination). Normal browsing paginates with count.
      let query = isSearching
        ? supabase.from('notes').select(selectStr)
        : supabase.from('notes').select(selectStr, { count: 'exact' })

      if (view === 'active') {
        query = query.is('archived_at', null)
      } else {
        query = query.not('archived_at', 'is', null)
      }

      if (isSearching) {
        // Full-text search via the generated search_vector column.
        // 'websearch' maps to websearch_to_tsquery — safely handles arbitrary user input
        // without tsquery injection (e.g. bare & | ! chars won't cause a parse error).
        query = query.textSearch('search_vector', debouncedSearch.trim(), {
          type: 'websearch',
          config: 'english',
        })
      } else {
        // No search active — use normal sort: pinned first, then most recently updated.
        if (view === 'active') {
          query = query
            .order('pinned', { ascending: false })
            .order('updated_at', { ascending: false })
        } else {
          query = query.order('archived_at', { ascending: false })
        }
        query = query.range(0, PAGE_SIZE - 1)
      }

      if (activeTagId != null) {
        query = query.eq('note_tags.tag_id', activeTagId)
      }

      const { data, count, error: fetchError } = await query

      if (cancelled) return

      if (fetchError) {
        setError(fetchError.message)
      } else {
        // Flatten note_tags[].tags → note.tags[] for cleaner component access
        setNotes(data.map(n => ({
          ...n,
          tags: (n.note_tags ?? []).map(nt => nt.tags).filter(Boolean),
        })))
        // null during search (pagination disabled); exact count when browsing
        setTotalCount(isSearching ? null : count)
      }
      setLoading(false)
    }

    fetchNotes()
    return () => { cancelled = true }
  }, [userId, view, activeTagId, debouncedSearch])

  // Expose an imperative handle so App can push a saved note into the list
  // without triggering a network round-trip.
  // rerender-functional-setstate: functional form so this callback never stales
  useImperativeHandle(listRef, () => ({
    upsert: (savedNote) => {
      // rerender-functional-setstate + js-tosorted-immutable: merge then re-sort immutably.
      // Filter out notes that no longer belong to the current view
      // (e.g. a note archived from the active view disappears immediately).
      setNotes(curr => {
        const noteMatchesView = view === 'active'
          ? savedNote.archived_at == null
          : savedNote.archived_at != null
        if (!noteMatchesView) {
          return curr.filter(n => n.id !== savedNote.id)
        }
        const merged = curr.findIndex(n => n.id === savedNote.id) === -1
          ? [savedNote, ...curr]
          : curr.map(n => n.id === savedNote.id ? savedNote : n)
        return merged.toSorted((a, b) =>
          Number(b.pinned) - Number(a.pinned) ||
          new Date(b.updated_at) - new Date(a.updated_at)
        )
      })
    },
  }), [view])

  // rerender-split-combined-hooks: Realtime subscription has a different lifecycle
  // from the fetch effect — only recreated when the signed-in user changes.
  useEffect(() => {
    if (!userId) return

    const channel = supabase
      .channel(`notes-realtime-${userId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'notes', filter: `user_id=eq.${userId}` },
        (payload) => {
          const { eventType, new: newRow, old: oldRow } = payload
          const currentView = viewRef.current
          const currentTagId = activeTagIdRef.current

          // ── INSERT ────────────────────────────────────────────────────────
          if (eventType === 'INSERT') {
            // Raw Realtime payload has no joined tag data, so we can't verify
            // the tag filter match without an extra round-trip. Skip the insert
            // and let the next full fetch reconcile it.
            if (currentTagId != null) return
            const noteMatchesView = currentView === 'active'
              ? newRow.archived_at == null
              : newRow.archived_at != null
            if (!noteMatchesView) return
            const sortFn = currentView === 'active'
              ? (a, b) => Number(b.pinned) - Number(a.pinned) || new Date(b.updated_at) - new Date(a.updated_at)
              : (a, b) => new Date(b.archived_at) - new Date(a.archived_at)
            // rerender-functional-setstate + js-tosorted-immutable
            setNotes(curr => {
              // Dedup: same-tab inserts via listRef.upsert() may have already applied this note
              if (curr.some(n => n.id === newRow.id)) return curr
              return [{ ...newRow, tags: [] }, ...curr].toSorted(sortFn)
            })
            setTotalCount(c => c !== null ? c + 1 : null)
          }

          // ── UPDATE ────────────────────────────────────────────────────────
          if (eventType === 'UPDATE') {
            setNotes(curr => {
              const existing = curr.find(n => n.id === newRow.id)
              if (!existing) return curr // note not in the current page/view
              const noteMatchesView = currentView === 'active'
                ? newRow.archived_at == null
                : newRow.archived_at != null
              if (!noteMatchesView) return curr.filter(n => n.id !== newRow.id)
              // Preserve joined tags (not present in raw Realtime payload)
              const updated = { ...existing, ...newRow, tags: existing.tags }
              const sortFn = currentView === 'active'
                ? (a, b) => Number(b.pinned) - Number(a.pinned) || new Date(b.updated_at) - new Date(a.updated_at)
                : (a, b) => new Date(b.archived_at) - new Date(a.archived_at)
              return curr.map(n => n.id === newRow.id ? updated : n).toSorted(sortFn)
            })
          }

          // ── DELETE ────────────────────────────────────────────────────────
          if (eventType === 'DELETE') {
            setNotes(curr => curr.filter(n => n.id !== oldRow.id))
            setTotalCount(c => c !== null ? c - 1 : null)
          }
        }
      )
      .subscribe()

    return () => { supabase.removeChannel(channel) }
  }, [userId])

  async function handleLoadMore() {
    if (loadingMore) return
    setLoadingMore(true)

    const tagSelect = activeTagId != null
      ? 'note_tags!inner(tag_id, tags(id, name))'
      : 'note_tags(tag_id, tags(id, name))'

    let query = supabase
      .from('notes')
      .select(`id, title, content, pinned, archived_at, created_at, updated_at, ${tagSelect}`)

    if (view === 'active') {
      query = query
        .is('archived_at', null)
        .order('pinned', { ascending: false })
        .order('updated_at', { ascending: false })
    } else {
      query = query
        .not('archived_at', 'is', null)
        .order('archived_at', { ascending: false })
    }

    if (activeTagId != null) {
      query = query.eq('note_tags.tag_id', activeTagId)
    }

    // notes.length is captured at call time — safe here since this runs in an event handler
    query = query.range(notes.length, notes.length + PAGE_SIZE - 1)

    const { data, error: fetchError } = await query

    if (!fetchError) {
      const newNotes = data.map(n => ({
        ...n,
        tags: (n.note_tags ?? []).map(nt => nt.tags).filter(Boolean),
      }))
      // rerender-functional-setstate: append without stale closure risk
      setNotes(curr => [...curr, ...newNotes])
    }
    setLoadingMore(false)
  }

  // rerender-functional-setstate: stable callback, no deps needed
  const handleTogglePin = useCallback(async (note) => {
    const previousPinned = note.pinned
    const newPinned = !previousPinned
    // Optimistically apply: flip the flag and re-sort before hitting the network.
    // js-tosorted-immutable: toSorted() returns a new array without mutating state.
    setNotes(curr =>
      curr
        .map(n => n.id === note.id ? { ...n, pinned: newPinned } : n)
        .toSorted((a, b) =>
          Number(b.pinned) - Number(a.pinned) ||
          new Date(b.updated_at) - new Date(a.updated_at)
        )
    )
    const { error: updateError } = await supabase
      .from('notes')
      .update({ pinned: newPinned })
      .eq('id', note.id)

    if (updateError) {
      // Rollback: restore the previous pinned value and re-sort.
      setNotes(curr =>
        curr
          .map(n => n.id === note.id ? { ...n, pinned: previousPinned } : n)
          .toSorted((a, b) =>
            Number(b.pinned) - Number(a.pinned) ||
            new Date(b.updated_at) - new Date(a.updated_at)
          )
      )
      showError('Failed to update pin. Please try again.')
    }
  }, [])

  // rerender-functional-setstate: stable callbacks, no stale-closure risk
  const handleArchive = useCallback(async (note) => {
    const archivedAt = new Date().toISOString()
    // Optimistically remove from the active list and decrement the count.
    setNotes(curr => curr.filter(n => n.id !== note.id))
    setTotalCount(c => c !== null ? c - 1 : null)

    const { error: updateError } = await supabase
      .from('notes')
      .update({ archived_at: archivedAt })
      .eq('id', note.id)

    if (updateError) {
      // Rollback: restore the note in its sorted position.
      setNotes(curr =>
        [...curr, { ...note, archived_at: archivedAt }].toSorted((a, b) =>
          Number(b.pinned) - Number(a.pinned) ||
          new Date(b.updated_at) - new Date(a.updated_at)
        )
      )
      setTotalCount(c => c !== null ? c + 1 : null)
      showError('Failed to archive note. Please try again.')
    }
  }, [])

  const handleUnarchive = useCallback(async (note) => {
    // Optimistically remove from the archived list and decrement the count.
    setNotes(curr => curr.filter(n => n.id !== note.id))
    setTotalCount(c => c !== null ? c - 1 : null)

    const { error: updateError } = await supabase
      .from('notes')
      .update({ archived_at: null })
      .eq('id', note.id)

    if (updateError) {
      // Rollback: restore the note in its archived_at-sorted position.
      setNotes(curr =>
        [...curr, note].toSorted((a, b) =>
          new Date(b.archived_at) - new Date(a.archived_at)
        )
      )
      setTotalCount(c => c !== null ? c + 1 : null)
      showError('Failed to unarchive note. Please try again.')
    }
  }, [])

  const handleDeletePermanently = useCallback(async (noteId) => {
    const { error: deleteError } = await supabase
      .from('notes')
      .delete()
      .eq('id', noteId)

    if (deleteError) { showError('Failed to delete note. Please try again.'); return }
    setNotes(curr => curr.filter(n => n.id !== noteId))
    setTotalCount(c => c !== null ? c - 1 : null)
  }, [])

  if (loading) return (
    <>
      <SearchBar value={searchInput} onChange={handleSearchChange} onClear={handleSearchClear} />
      <p className="notes-status">Loading notes…</p>
    </>
  )
  if (error) return (
    <>
      <SearchBar value={searchInput} onChange={handleSearchChange} onClear={handleSearchClear} />
      <p className="notes-status notes-error" role="alert">Error: {error}</p>
    </>
  )

  if (notes.length === 0) {
    const emptyMessage = debouncedSearch.trim() !== ''
      ? `No results for "${debouncedSearch.trim()}".`
      : view === 'archived'
        ? 'No archived notes.'
        : 'No notes yet. Create your first one!'
    return (
      <>
        <SearchBar value={searchInput} onChange={handleSearchChange} onClear={handleSearchClear} />
        <p className="notes-status">{emptyMessage}</p>
      </>
    )
  }

  return (
    <>
      {toastError && (
        <div className="toast-error" role="alert">{toastError}</div>
      )}
      <SearchBar value={searchInput} onChange={handleSearchChange} onClear={handleSearchClear} />
      <ul className="notes-list">
        {notes.map(note => (
          <NoteItem
            key={note.id}
            note={note}
            view={view}
            onEdit={onEdit}
            onTogglePin={handleTogglePin}
            onArchive={handleArchive}
            onUnarchive={handleUnarchive}
            onDeletePermanently={handleDeletePermanently}
            onTagClick={onTagClick}
          />
        ))}
      </ul>
      {debouncedSearch.trim() === '' && totalCount !== null && notes.length < totalCount && (
        <div className="load-more-row">
          <button className="btn-secondary" onClick={handleLoadMore} disabled={loadingMore}>
            {loadingMore ? 'Loading…' : 'Load more'}
          </button>
        </div>
      )}
    </>
  )
}
