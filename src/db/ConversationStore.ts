import { Database } from 'bun:sqlite'
import type { Message } from '../engine/types.js'
import { shortId } from '../utils/format.js'
import { mkdir } from 'fs/promises'
import { dirname } from 'path'

export type Conversation = {
  id: string
  title: string
  mode: string
  createdAt: number
  updatedAt: number
}

export type ConversationSummary = Conversation & {
  messageCount: number
}

export type ConversationWithMessages = Conversation & {
  messages: Message[]
}

export function createConversationStore(dbPath: string) {
  // Ensure directory exists
  mkdirSync(dbPath)

  const db = new Database(dbPath)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA synchronous = NORMAL')
  db.exec('PRAGMA foreign_keys = ON')

  // Create tables
  db.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      mode TEXT NOT NULL DEFAULT 'single',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `)
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      turn INTEGER NOT NULL,
      provider TEXT,
      token_estimate INTEGER,
      created_at INTEGER NOT NULL
    )
  `)
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, turn)
  `)

  // Prepared statements
  const insertConversation = db.query(
    'INSERT INTO conversations (id, title, mode, created_at, updated_at) VALUES ($id, $title, $mode, $createdAt, $updatedAt)'
  )
  const insertMessage = db.query(
    'INSERT INTO messages (id, conversation_id, role, content, turn, provider, token_estimate, created_at) VALUES ($id, $conversationId, $role, $content, $turn, $provider, $tokenEstimate, $createdAt)'
  )
  const listConversations = db.query(`
    SELECT c.*, COUNT(m.id) as message_count
    FROM conversations c
    LEFT JOIN messages m ON m.conversation_id = c.id
    GROUP BY c.id
    ORDER BY c.updated_at DESC
    LIMIT $limit OFFSET $offset
  `)
  const getConversation = db.query('SELECT * FROM conversations WHERE id = $id')
  const getMessages = db.query('SELECT * FROM messages WHERE conversation_id = $id ORDER BY turn ASC, created_at ASC')
  const updateTitleStmt = db.query('UPDATE conversations SET title = $title, updated_at = $updatedAt WHERE id = $id')
  const updateTimestamp = db.query('UPDATE conversations SET updated_at = $updatedAt WHERE id = $id')
  const deleteConversation = db.query('DELETE FROM conversations WHERE id = $id')

  return {
    create(title: string, mode: string = 'single'): Conversation {
      const now = Date.now()
      const conv: Conversation = {
        id: `conv_${shortId()}`,
        title,
        mode,
        createdAt: now,
        updatedAt: now,
      }
      insertConversation.run({
        $id: conv.id,
        $title: conv.title,
        $mode: conv.mode,
        $createdAt: conv.createdAt,
        $updatedAt: conv.updatedAt,
      })
      return conv
    },

    list(limit = 50, offset = 0): ConversationSummary[] {
      const rows = listConversations.all({ $limit: limit, $offset: offset }) as Array<{
        id: string; title: string; mode: string; created_at: number; updated_at: number; message_count: number
      }>
      return rows.map(r => ({
        id: r.id,
        title: r.title,
        mode: r.mode,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        messageCount: r.message_count,
      }))
    },

    get(id: string): ConversationWithMessages | undefined {
      const row = getConversation.get({ $id: id }) as {
        id: string; title: string; mode: string; created_at: number; updated_at: number
      } | null
      if (!row) return undefined

      const msgRows = getMessages.all({ $id: id }) as Array<{
        id: string; role: string; content: string; turn: number; provider: string | null; token_estimate: number | null
      }>

      const messages: Message[] = msgRows.map(m => ({
        role: m.role as 'user' | 'assistant',
        content: JSON.parse(m.content),
        turn: m.turn,
        provider: m.provider as 'local' | 'claude' | undefined,
        tokenEstimate: m.token_estimate ?? undefined,
      }))

      return {
        id: row.id,
        title: row.title,
        mode: row.mode,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        messages,
      }
    },

    addMessage(conversationId: string, message: Message): void {
      insertMessage.run({
        $id: `msg_${shortId()}`,
        $conversationId: conversationId,
        $role: message.role,
        $content: JSON.stringify(message.content),
        $turn: message.turn,
        $provider: message.provider ?? null,
        $tokenEstimate: message.tokenEstimate ?? null,
        $createdAt: Date.now(),
      })
      updateTimestamp.run({ $id: conversationId, $updatedAt: Date.now() })
    },

    updateTitle(id: string, title: string): void {
      updateTitleStmt.run({ $id: id, $title: title, $updatedAt: Date.now() })
    },

    delete(id: string): boolean {
      const result = deleteConversation.run({ $id: id })
      return result.changes > 0
    },

    close(): void {
      db.close()
    },
  }
}

function mkdirSync(dbPath: string) {
  try {
    const dir = dirname(dbPath)
    require('fs').mkdirSync(dir, { recursive: true })
  } catch {}
}

export type ConversationStore = ReturnType<typeof createConversationStore>
