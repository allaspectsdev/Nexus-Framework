import type { TaskNotification } from './types.js'
import type { Message } from '../engine/types.js'
import { escapeXml } from '../utils/escapeXml.js'

/**
 * Format a task notification as XML for injection into the coordinator's messages.
 * Pattern from Claude Code's coordinatorMode.ts — workers report back via
 * <task-notification> XML blocks in user messages.
 */
export function formatNotification(notification: TaskNotification): string {
  return `<task-notification>
<task-id>${escapeXml(notification.taskId)}</task-id>
<name>${escapeXml(notification.name)}</name>
<status>${escapeXml(notification.status)}</status>
<summary>${escapeXml(notification.summary)}</summary>
${notification.result ? `<result>${escapeXml(notification.result)}</result>` : ''}
<usage>
  <total-tokens>${notification.usage.totalTokens}</total-tokens>
  <tool-uses>${notification.usage.toolUses}</tool-uses>
  <duration-ms>${notification.usage.durationMs}</duration-ms>
</usage>
</task-notification>`
}

/**
 * Create a user message containing a task notification.
 */
export function notificationToMessage(notification: TaskNotification, turn: number): Message {
  return {
    role: 'user',
    content: [{ type: 'text', text: formatNotification(notification) }],
    turn,
  }
}
