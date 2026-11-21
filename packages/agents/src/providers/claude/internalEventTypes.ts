/**
 * Known internal Claude Code / Claude Agent SDK event types that should be skipped.
 *
 * These records are telemetry or internal state transitions, not conversation messages.
 * Keeping them out of Happier transcripts avoids confusing "[Unsupported agent output]" rows.
 *
 * `attachment` records carry context injections (hook output, reminders, tool/skill listings,
 * file snapshots) rather than conversation content, so they belong here too.
 */
const INTERNAL_CLAUDE_EVENT_TYPES = new Set<string>([
  'file-history-snapshot',
  'change',
  'queue-operation',
  'rate_limit_event',
  'attachment',
  'last-prompt',
  'mode',
  'pr-link',
  'tool_progress',
  // Claude Agent SDK 0.3.206+: per-command queue/execution state, not conversation output.
  'command_lifecycle',
]);

/** Classify transcript-only exclusions; raw lifecycle observers must still receive these events. */
export function isClaudeInternalEventType(type: unknown): boolean {
  return typeof type === 'string' && INTERNAL_CLAUDE_EVENT_TYPES.has(type);
}

/** Explicit metadata is internal; synthetic user content is internal only when it is text-only. */
export function isClaudeInternalUserPrompt(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (record.type !== 'user') return false;
  if (record.isMeta === true) return true;
  if (record.isSynthetic !== true) return false;
  const message = record.message;
  if (!message || typeof message !== 'object' || Array.isArray(message)) return false;
  const content = (message as Record<string, unknown>).content;
  if (typeof content === 'string') return true;
  return Array.isArray(content) && content.length > 0 && content.every((block: unknown) => {
    if (!block || typeof block !== 'object' || Array.isArray(block)) return false;
    const item = block as Record<string, unknown>;
    return item.type === 'text' && typeof item.text === 'string';
  });
}
