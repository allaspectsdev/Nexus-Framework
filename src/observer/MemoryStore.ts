import type { Memory, MemoryEntry } from './types.js'
import { shortId } from '../utils/format.js'
import { levenshteinSimilarity } from './utils.js'
import { mkdir } from 'fs/promises'
import { dirname } from 'path'

export type MemoryStoreConfig = {
  memoryDir: string
  maxEntries: number
  maxPromptEntries: number
}

const MEMORY_FILE = 'memories.jsonl'
const DEDUP_THRESHOLD = 0.85

export function createMemoryStore(config: MemoryStoreConfig) {
  const memoryFile = `${config.memoryDir}/${MEMORY_FILE}`
  let cache: Memory[] | null = null

  async function ensureDir(): Promise<void> {
    await mkdir(config.memoryDir, { recursive: true })
  }

  async function load(): Promise<Memory[]> {
    if (cache) return cache
    try {
      const file = Bun.file(memoryFile)
      if (!(await file.exists())) {
        cache = []
        return cache
      }
      const text = await file.text()
      const lines = text.trim().split('\n').filter(Boolean)
      cache = lines.map(line => JSON.parse(line) as Memory)
      // Prune expired
      const now = Date.now()
      cache = cache.filter(m => !m.expiresAt || m.expiresAt > now)
      return cache
    } catch {
      cache = []
      return cache
    }
  }

  async function persist(): Promise<void> {
    await ensureDir()
    const memories = await load()
    const content = memories.length > 0
      ? memories.map(m => JSON.stringify(m)).join('\n') + '\n'
      : ''
    await Bun.write(memoryFile, content)
  }

  return {
    async getAll(): Promise<Memory[]> {
      return [...(await load())]
    },

    async write(entry: MemoryEntry & { source: string }): Promise<Memory> {
      const memories = await load()

      // Dedup: skip if content is identical or very similar to existing memory
      const existing = memories.find(m =>
        m.content === entry.content ||
        (m.type === entry.type && levenshteinSimilarity(m.content, entry.content) > DEDUP_THRESHOLD)
      )
      if (existing) return existing

      const memory: Memory = {
        ...entry,
        id: `mem_${shortId()}`,
        createdAt: Date.now(),
        useCount: 0,
      }
      memories.push(memory)

      // Enforce max — evict lowest-scoring memories
      if (memories.length > config.maxEntries) {
        memories.sort((a, b) => {
          const scoreA = a.useCount * 10 + (a.createdAt / 1e10)
          const scoreB = b.useCount * 10 + (b.createdAt / 1e10)
          return scoreB - scoreA
        })
        memories.length = config.maxEntries
      }

      cache = memories
      await persist()
      return memory
    },

    async delete(id: string): Promise<boolean> {
      const memories = await load()
      const index = memories.findIndex(m => m.id === id)
      if (index === -1) return false
      memories.splice(index, 1)
      cache = memories
      await persist()
      return true
    },

    /** Build the memory block for system prompt injection. */
    async buildPromptBlock(): Promise<string> {
      const memories = await load()
      if (memories.length === 0) return ''

      // Score by utility (useCount) + recency
      const scored = memories.map(m => ({
        memory: m,
        score: m.useCount * 5 + (1 / ((Date.now() - m.createdAt) / 86_400_000 + 1)),
      }))
      scored.sort((a, b) => b.score - a.score)

      const selected = scored.slice(0, config.maxPromptEntries)

      // Increment useCount for injected memories
      for (const { memory } of selected) {
        memory.useCount++
      }
      await persist()

      const lines = selected.map(({ memory }) => {
        const tags = memory.tags?.length ? ` (${memory.tags.join(', ')})` : ''
        return `- [${memory.type}] ${memory.content}${tags}`
      })

      return `<memories>
The following are observations from previous conversations. Use them to inform your responses:
${lines.join('\n')}
</memories>`
    },

    async count(): Promise<number> {
      return (await load()).length
    },

    async clear(): Promise<void> {
      cache = []
      await persist()
    },

    /** Reset the in-memory cache (useful for testing) */
    resetCache(): void {
      cache = null
    },
  }
}

export type MemoryStore = ReturnType<typeof createMemoryStore>
