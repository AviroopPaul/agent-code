import { useEffect, useMemo, useRef, useState } from 'react';
import {
  LuArrowUp,
  LuChevronDown,
  LuChevronRight,
  LuFolder,
  LuFolderPlus,
  LuPanelLeftClose,
  LuPanelLeftOpen,
  LuSparkles,
  LuSettings2,
  LuSlidersHorizontal,
  LuSquarePen,
} from 'react-icons/lu';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

import { useCodexStore, type PendingApproval, type TranscriptEntry } from './store/useCodexStore';

import type { ReasoningEffort } from './shared/protocol/ReasoningEffort';
import type { ResponseItem } from './shared/protocol/ResponseItem';
import type { Model } from './shared/protocol/v2/Model';
import type { DynamicToolCallOutputContentItem } from './shared/protocol/v2/DynamicToolCallOutputContentItem';
import type { UserInput } from './shared/protocol/v2/UserInput';
import type { ProjectThread } from './shared/bridge';

const EFFORT_PRIORITY: ReasoningEffort[] = ['low', 'medium', 'high', 'xhigh'];
const RECENT_PROJECTS_KEY = 'agent-code:recent-projects'; // codex-only; claude uses RECENT_PROJECTS_CLAUDE_KEY
const RECENT_PROJECTS_CLAUDE_KEY = 'agent-code:recent-projects:claude';
const SELECTED_AGENT_KEY = 'agent-code:selected-agent';
const AGENT_OPTIONS = [
  { id: 'codex', label: 'Codex', icon: 'https://openai.com/favicon.ico', available: true },
  { id: 'claude', label: 'Claude Code', icon: 'https://claude.com/favicon.ico', available: true },
  { id: 'gemini', label: 'Gemini CLI', icon: 'https://www.gstatic.com/marketing-cms/assets/images/7e/a4/253561a944f4a8f5e6dec4f5f26f/gemini.webp=s48-fcrop64=1,00000000ffffffff-rw', available: false },
  { id: 'opencode', label: 'Opencode', icon: 'https://opencode.ai/favicon.ico', available: false },
] as const;

type ThreadOrganizeMode = 'byProject' | 'chronological';
type ThreadSortMode = 'created' | 'updated';
type ThreadScopeMode = 'all' | 'relevant';
type ComposerImage = { id: string; url: string };

function clampThreadTitle(title: string, maxWords = 5): string {
  const words = title.trim().split(/\s+/).filter(Boolean);
  if (words.length <= maxWords) {
    return title;
  }

  return `${words.slice(0, maxWords).join(' ')}…`;
}

function formatWorkspaceName(workspacePath: string): string {
  if (!workspacePath) {
    return 'No project';
  }

  const normalizedPath = workspacePath.replace(/\/+$/, '');
  const segments = normalizedPath.split('/');
  return segments[segments.length - 1] || workspacePath;
}

function formatUpdatedAt(timestamp: number): string {
  const date = new Date(timestamp * 1000);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMinutes = Math.max(0, Math.floor(diffMs / (1000 * 60)));
  const diffHours = Math.floor(diffMinutes / 60);

  if (diffMinutes < 1) {
    return 'now';
  }

  if (diffMinutes < 60) {
    return `${diffMinutes}m`;
  }

  if (diffHours < 24) {
    return `${diffHours}h`;
  }

  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
  }).format(date);
}

function isToolEntry(entry: TranscriptEntry): boolean {
  return [
    'commandExecution',
    'dynamicToolCall',
    'mcpToolCall',
    'webSearch',
    'fileChange',
    'collabAgentToolCall',
    'imageView',
    'imageGeneration',
    'rawResponseItem',
  ].includes(entry.kind);
}

function normalizeApprovalLabel(decision: string): string {
  switch (decision) {
    case 'accept':
      return 'Allow';
    case 'acceptForSession':
      return 'Always allow';
    case 'decline':
      return 'Deny';
    case 'cancel':
      return 'Cancel';
    default:
      return decision;
  }
}

function humanizeEffort(effort: ReasoningEffort): string {
  if (effort === 'xhigh') {
    return 'X-High';
  }

  return effort.charAt(0).toUpperCase() + effort.slice(1);
}

function SidebarToggleIcon({ open }: { open: boolean }) {
  const Icon = open ? LuPanelLeftClose : LuPanelLeftOpen;
  return <Icon aria-hidden="true" size={20} />;
}

function LoaderDot() {
  return <span aria-hidden="true" className="inline-loader" />;
}

function PickerMenu<T extends string>({
  label,
  value,
  options,
  open,
  onToggle,
  onSelect,
  menuRef,
}: {
  label: string;
  value: T;
  options: Array<{ value: T; label: string }>;
  open: boolean;
  onToggle: () => void;
  onSelect: (value: T) => void;
  menuRef: React.RefObject<HTMLDivElement | null>;
}) {
  const selected = options.find((option) => option.value === value);

  return (
    <div className="picker-menu" ref={menuRef}>
      <button className={`picker-trigger ${open ? 'picker-trigger-open' : ''}`} onClick={onToggle} type="button">
        <span className="picker-trigger-label">{selected?.label ?? label}</span>
        <LuChevronDown aria-hidden="true" size={14} />
      </button>
      {open ? (
        <div className="picker-popover">
          {options.map((option) => (
            <button
              key={option.value}
              className={`picker-option ${option.value === value ? 'picker-option-active' : ''}`}
              onClick={() => onSelect(option.value)}
              type="button"
            >
              <span>{option.label}</span>
              {option.value === value ? <span className="picker-option-check">✓</span> : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function MarkdownContent({ children }: { children: string }) {
  return (
    <Markdown
      components={{
        a: ({ ...props }) => <a {...props} className="markdown-link" target="_blank" rel="noreferrer" />,
        code: ({ className, children, ...props }) => {
          const isBlock = Boolean(className);
          if (isBlock) {
            return (
              <code {...props} className={className}>
                {children}
              </code>
            );
          }

          return (
            <code {...props} className="markdown-inline-code">
              {children}
            </code>
          );
        },
        pre: ({ children }) => <pre className="markdown-pre">{children}</pre>,
      }}
      remarkPlugins={[remarkGfm]}
    >
      {children}
    </Markdown>
  );
}

function JsonBlock({ value }: { value: unknown }) {
  if (value === null || value === undefined) {
    return null;
  }

  return <pre className="tool-json">{JSON.stringify(value, null, 2)}</pre>;
}

function renderImageSource(source: string): string {
  if (source.startsWith('http://') || source.startsWith('https://') || source.startsWith('file://')) {
    return source;
  }

  if (source.startsWith('/')) {
    return `file://${source}`;
  }

  return source;
}

function formatPatchKind(kind: { type: 'add' } | { type: 'delete' } | { type: 'update'; move_path: string | null }): string {
  if (kind.type === 'update' && kind.move_path) {
    return `update -> ${kind.move_path}`;
  }

  return kind.type;
}

function basename(filePath: string): string {
  const parts = filePath.split('/');
  return parts[parts.length - 1] || filePath;
}

function countDiffLines(diff: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;

  for (const line of diff.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) {
      continue;
    }
    if (line.startsWith('+')) {
      additions += 1;
    } else if (line.startsWith('-')) {
      deletions += 1;
    }
  }

  return { additions, deletions };
}

function summarizeToolEntry(entry: TranscriptEntry): { title: string; detail?: string } {
  const item = entry.rawItem;
  if (!item) {
    return { title: entry.title };
  }

  if (
    item.type === 'function_call' ||
    item.type === 'custom_tool_call' ||
    item.type === 'function_call_output' ||
    item.type === 'custom_tool_call_output' ||
    item.type === 'local_shell_call' ||
    item.type === 'web_search_call' ||
    item.type === 'image_generation_call' ||
    item.type === 'ghost_snapshot' ||
    item.type === 'compaction'
  ) {
    switch (item.type) {
      case 'local_shell_call':
        return {
          title: `Ran ${item.action.command}`,
        };
      case 'function_call':
      case 'custom_tool_call':
        return {
          title: `Called ${item.name}`,
        };
      case 'function_call_output':
      case 'custom_tool_call_output':
        return {
          title: 'Tool output',
        };
      case 'web_search_call':
        return {
          title: 'Searched web',
        };
      case 'image_generation_call':
        return {
          title: 'Generated image',
        };
      case 'ghost_snapshot':
        return {
          title: 'Created snapshot',
        };
      case 'compaction':
        return {
          title: 'Compacted context',
        };
    }
  }

  switch (item.type) {
    case 'commandExecution': {
      const readCount = item.commandActions.filter((action) => action.type === 'read').length;
      const searchCount = item.commandActions.filter((action) => action.type === 'search').length;
      const listCount = item.commandActions.filter((action) => action.type === 'listFiles').length;
      const exploredCount = readCount + searchCount + listCount;

      if (exploredCount > 0) {
        return {
          title: `Explored ${exploredCount} ${exploredCount === 1 ? 'item' : 'items'}`,
          detail: item.durationMs ? `Ran ${item.command} for ${Math.round(item.durationMs / 1000)}s` : item.command,
        };
      }

      return {
        title: item.command,
        detail: item.durationMs ? `Ran for ${Math.round(item.durationMs / 1000)}s` : undefined,
      };
    }
    case 'fileChange': {
      if (item.changes.length === 1) {
        const change = item.changes[0];
        const { additions, deletions } = countDiffLines(change.diff);
        return {
          title: `Edited ${basename(change.path)} +${additions} -${deletions}`,
        };
      }

      return {
        title: `Edited ${item.changes.length} files`,
      };
    }
    case 'mcpToolCall':
      return {
        title: `Called ${item.server}/${item.tool}`,
      };
    case 'dynamicToolCall':
      return {
        title: `Called ${item.tool}`,
      };
    case 'collabAgentToolCall':
      return {
        title: `Used ${item.tool}`,
      };
    case 'webSearch':
      return {
        title: `Searched web`,
        detail: item.query,
      };
    case 'imageView':
      return {
        title: `Viewed image`,
        detail: basename(item.path),
      };
    case 'imageGeneration':
      return {
        title: `Generated image`,
      };
    default:
      return { title: entry.title };
  }
}

function RawResponseBody({ item }: { item: ResponseItem }) {
  switch (item.type) {
    case 'local_shell_call':
      return (
        <div className="tool-sections">
          <div className="tool-section">
            <div className="tool-section-label">Command</div>
            <pre className="tool-json">{item.action.command}</pre>
          </div>
        </div>
      );
    case 'function_call':
      return (
        <div className="tool-sections">
          <div className="tool-section">
            <div className="tool-section-label">Arguments</div>
            <pre className="tool-json">{item.arguments}</pre>
          </div>
        </div>
      );
    case 'custom_tool_call':
      return (
        <div className="tool-sections">
          <div className="tool-section">
            <div className="tool-section-label">Input</div>
            <pre className="tool-json">{item.input}</pre>
          </div>
        </div>
      );
    case 'function_call_output':
    case 'custom_tool_call_output':
      return (
        <div className="tool-sections">
          <div className="tool-section">
            <div className="tool-section-label">Output</div>
            <JsonBlock value={item.output.body} />
          </div>
        </div>
      );
    case 'web_search_call':
      return (
        <div className="tool-sections">
          <div className="tool-section">
            <div className="tool-section-label">Action</div>
            <JsonBlock value={item.action} />
          </div>
        </div>
      );
    case 'image_generation_call':
      return (
        <div className="tool-sections">
          {item.revised_prompt ? (
            <div className="tool-section">
              <div className="tool-section-label">Prompt</div>
              <div className="markdown-body">
                <MarkdownContent>{item.revised_prompt}</MarkdownContent>
              </div>
            </div>
          ) : null}
          <img alt="Generated" className="message-image" src={renderImageSource(item.result)} />
        </div>
      );
    case 'ghost_snapshot':
      return (
        <div className="tool-sections">
          <div className="tool-section">
            <div className="tool-section-label">Snapshot</div>
            <JsonBlock value={item.ghost_commit} />
          </div>
        </div>
      );
    case 'compaction':
      return (
        <div className="tool-sections">
          <div className="tool-section">
            <div className="tool-section-label">Event</div>
            <pre className="tool-json">Conversation history was compacted.</pre>
          </div>
        </div>
      );
    case 'message':
    case 'reasoning':
    case 'other':
      return <pre className="tool-body">{JSON.stringify(item, null, 2)}</pre>;
  }
}

function UserInputContent({ content }: { content: UserInput[] }) {
  const [selectedImage, setSelectedImage] = useState<string | null>(null);
  const imageItems = content.filter((item) => item.type === 'image' || item.type === 'localImage');
  const otherItems = content.filter((item) => item.type !== 'image' && item.type !== 'localImage');

  return (
    <>
      <div className="user-input-stack">
        {imageItems.length > 0 ? (
          <div className="user-image-strip">
            {imageItems.map((item, index) => {
              const source = renderImageSource(item.type === 'image' ? item.url : item.path);
              return (
                <button className="user-image-button" key={`${item.type}-${index}`} onClick={() => setSelectedImage(source)} type="button">
                  <img alt="User supplied" className="user-message-image" src={source} />
                </button>
              );
            })}
          </div>
        ) : null}
        {otherItems.map((item, index) => {
          if (item.type === 'text') {
            return (
              <div className="markdown-body" key={`${item.type}-${index}`}>
                <MarkdownContent>{item.text}</MarkdownContent>
              </div>
            );
          }

          return (
            <span className="message-chip" key={`${item.type}-${index}`}>
              {item.name}
            </span>
          );
        })}
      </div>
      {selectedImage ? (
        <button className="image-modal" onClick={() => setSelectedImage(null)} type="button">
          <img alt="Expanded user supplied" className="image-modal-content" src={selectedImage} />
        </button>
      ) : null}
    </>
  );
}

function ToolOutputItems({ items }: { items: DynamicToolCallOutputContentItem[] | null }) {
  if (!items?.length) {
    return null;
  }

  return (
    <div className="tool-sections">
      {items.map((item, index) => (
        <div className="tool-section" key={`${item.type}-${index}`}>
          <div className="tool-section-label">{item.type}</div>
          {item.type === 'inputText' ? (
            <div className="markdown-body">
              <MarkdownContent>{item.text}</MarkdownContent>
            </div>
          ) : (
            <img alt="Tool output" className="message-image" src={renderImageSource(item.imageUrl)} />
          )}
        </div>
      ))}
    </div>
  );
}

function ToolBody({ entry }: { entry: TranscriptEntry }) {
  const item = entry.rawItem;

  if (!item) {
    return <pre className="tool-body">{entry.body}</pre>;
  }

  if (entry.kind === 'rawResponseItem') {
    return <RawResponseBody item={item as ResponseItem} />;
  }

  switch (item.type) {
    case 'commandExecution':
      return (
        <div className="tool-sections">
          <div className="tool-section">
            <div className="tool-section-label">Command</div>
            <pre className="tool-json">{item.command}</pre>
          </div>
          <div className="tool-section">
            <div className="tool-section-label">Working directory</div>
            <pre className="tool-json">{item.cwd}</pre>
          </div>
          {item.aggregatedOutput ? (
            <div className="tool-section">
              <div className="tool-section-label">Output</div>
              <pre className="tool-body">{item.aggregatedOutput}</pre>
            </div>
          ) : null}
          {item.exitCode !== null || item.durationMs !== null ? (
            <div className="tool-section">
              <div className="tool-section-label">Metadata</div>
              <JsonBlock value={{ exitCode: item.exitCode, durationMs: item.durationMs, processId: item.processId }} />
            </div>
          ) : null}
        </div>
      );
    case 'fileChange':
      return (
        <div className="tool-sections">
          {item.changes.map((change, index) => (
            <div className="tool-section" key={`${change.path}-${index}`}>
              <div className="tool-section-label">{formatPatchKind(change.kind)} {change.path}</div>
              <pre className="tool-body">{change.diff}</pre>
            </div>
          ))}
        </div>
      );
    case 'mcpToolCall':
      return (
        <div className="tool-sections">
          <div className="tool-section">
            <div className="tool-section-label">Arguments</div>
            <JsonBlock value={item.arguments} />
          </div>
          {item.result ? (
            <div className="tool-section">
              <div className="tool-section-label">Result</div>
              <JsonBlock value={item.result} />
            </div>
          ) : null}
          {item.error ? (
            <div className="tool-section">
              <div className="tool-section-label">Error</div>
              <JsonBlock value={item.error} />
            </div>
          ) : null}
        </div>
      );
    case 'dynamicToolCall':
      return (
        <div className="tool-sections">
          <div className="tool-section">
            <div className="tool-section-label">Arguments</div>
            <JsonBlock value={item.arguments} />
          </div>
          <ToolOutputItems items={item.contentItems} />
          {item.success !== null || item.durationMs !== null ? (
            <div className="tool-section">
              <div className="tool-section-label">Metadata</div>
              <JsonBlock value={{ success: item.success, durationMs: item.durationMs }} />
            </div>
          ) : null}
        </div>
      );
    case 'collabAgentToolCall':
      return (
        <div className="tool-sections">
          {item.prompt ? (
            <div className="tool-section">
              <div className="tool-section-label">Prompt</div>
              <div className="markdown-body">
                <MarkdownContent>{item.prompt}</MarkdownContent>
              </div>
            </div>
          ) : null}
          <div className="tool-section">
            <div className="tool-section-label">Agents</div>
            <JsonBlock value={{ senderThreadId: item.senderThreadId, receiverThreadIds: item.receiverThreadIds, agentsStates: item.agentsStates }} />
          </div>
        </div>
      );
    case 'webSearch':
      return (
        <div className="tool-sections">
          <div className="tool-section">
            <div className="tool-section-label">Query</div>
            <pre className="tool-json">{item.query}</pre>
          </div>
          {item.action ? (
            <div className="tool-section">
              <div className="tool-section-label">Action</div>
              <JsonBlock value={item.action} />
            </div>
          ) : null}
        </div>
      );
    case 'imageView':
      return (
        <div className="tool-sections">
          <img alt="Viewed" className="message-image" src={renderImageSource(item.path)} />
          <pre className="tool-json">{item.path}</pre>
        </div>
      );
    case 'imageGeneration':
      return (
        <div className="tool-sections">
          {item.revisedPrompt ? (
            <div className="tool-section">
              <div className="tool-section-label">Prompt</div>
              <div className="markdown-body">
                <MarkdownContent>{item.revisedPrompt}</MarkdownContent>
              </div>
            </div>
          ) : null}
          <img alt="Generated" className="message-image" src={renderImageSource(item.result)} />
        </div>
      );
    default:
      return <pre className="tool-body">{entry.body}</pre>;
  }
}

function ApprovalCard({
  approval,
  onResolve,
}: {
  approval: PendingApproval;
  onResolve: (id: string | number, result: unknown) => Promise<void>;
}) {
  if (approval.method === 'item/commandExecution/requestApproval') {
    const params = approval.params;
    const decisions = params.availableDecisions?.length
      ? params.availableDecisions
      : ['accept', 'decline', 'cancel'];

    return (
      <div className="approval">
        <div className="approval-icon">!</div>
        <div className="approval-content">
          <div className="approval-label">Run command</div>
          <code className="approval-command">{params.command ?? 'Command'}</code>
        </div>
        <div className="approval-actions">
          {decisions.map((decision) => (
            <button
              key={typeof decision === 'string' ? decision : JSON.stringify(decision)}
              className={`btn btn-sm ${
                decision === 'accept'
                  ? 'btn-primary'
                  : decision === 'decline' || decision === 'cancel'
                    ? 'btn-danger'
                    : 'btn-ghost'
              }`}
              onClick={() => onResolve(approval.id, { decision })}
              type="button"
            >
              {normalizeApprovalLabel(String(decision))}
            </button>
          ))}
        </div>
      </div>
    );
  }

  if (approval.method === 'item/fileChange/requestApproval') {
    const params = approval.params;

    return (
      <div className="approval">
        <div className="approval-icon">F</div>
        <div className="approval-content">
          <div className="approval-label">File change</div>
          <span className="approval-detail">{params.reason ?? 'The agent wants to edit files.'}</span>
        </div>
        <div className="approval-actions">
          {['accept', 'acceptForSession', 'decline'].map((decision) => (
            <button
              key={decision}
              className={`btn btn-sm ${
                decision === 'accept' ? 'btn-primary' : decision === 'decline' ? 'btn-danger' : 'btn-ghost'
              }`}
              onClick={() => onResolve(approval.id, { decision })}
              type="button"
            >
              {decision === 'acceptForSession' ? 'Always allow' : normalizeApprovalLabel(decision)}
            </button>
          ))}
        </div>
      </div>
    );
  }

  if (approval.method === 'item/permissions/requestApproval') {
    const params = approval.params;

    return (
      <div className="approval">
        <div className="approval-icon">P</div>
        <div className="approval-content">
          <div className="approval-label">Permission request</div>
          <span className="approval-detail">{params.reason ?? 'Additional permissions were requested.'}</span>
        </div>
        <div className="approval-actions">
          <button
            className="btn btn-sm btn-primary"
            onClick={() => onResolve(approval.id, { permissions: params.permissions, scope: 'session' })}
            type="button"
          >
            Grant session
          </button>
          <button
            className="btn btn-sm btn-ghost"
            onClick={() => onResolve(approval.id, { permissions: params.permissions, scope: 'turn' })}
            type="button"
          >
            Grant once
          </button>
          <button
            className="btn btn-sm btn-danger"
            onClick={() => onResolve(approval.id, { permissions: {}, scope: 'turn' })}
            type="button"
          >
            Deny
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="approval">
      <div className="approval-icon">?</div>
      <div className="approval-content">
        <div className="approval-label">{approval.method}</div>
      </div>
      <div className="approval-actions">
        <button
          className="btn btn-sm btn-danger"
          onClick={() => onResolve(approval.id, { action: 'cancel', content: null, _meta: null })}
          type="button"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

function TranscriptRow({ entry }: { entry: TranscriptEntry }) {
  const [expanded, setExpanded] = useState(false);

  if (entry.kind === 'userMessage') {
    const item = entry.rawItem?.type === 'userMessage' ? entry.rawItem : null;
    return (
      <div className="msg msg-user">
        <div className="msg-bubble msg-bubble-user">
          {item ? <UserInputContent content={item.content} /> : <div className="markdown-body"><MarkdownContent>{entry.body}</MarkdownContent></div>}
        </div>
      </div>
    );
  }

  if (isToolEntry(entry)) {
    const summary = summarizeToolEntry(entry);
    return (
      <div className="msg msg-ai">
        <div className="tool-card" data-expanded={expanded}>
          <button className="tool-header" onClick={() => setExpanded((value) => !value)} type="button">
            <span className="tool-copy">
              <span className="tool-title">{summary.title}</span>
              {summary.detail ? <span className="tool-detail">{summary.detail}</span> : null}
            </span>
            {entry.status && entry.status !== 'completed' ? (
              <span className={`tool-status ${entry.status === 'completed' ? 'tool-status-done' : ''}`}>{entry.status}</span>
            ) : null}
            <span className="tool-chevron">{expanded ? '▴' : '▾'}</span>
          </button>
          {expanded ? <ToolBody entry={entry} /> : null}
        </div>
      </div>
    );
  }

  return (
    <div className="msg msg-ai">
      <div className="msg-bubble msg-bubble-ai">
        <div className="markdown-body">
          <MarkdownContent>{entry.body || ' '}</MarkdownContent>
        </div>
      </div>
    </div>
  );
}

function ThinkingRow() {
  return (
    <div className="msg msg-ai">
      <div className="thinking">
        <span className="thinking-dot" />
        <span className="thinking-dot" />
        <span className="thinking-dot" />
      </div>
    </div>
  );
}

export default function App() {
  const models = useCodexStore((state) => state.models);
  const selectedModel = useCodexStore((state) => state.selectedModel);
  const selectedEffort = useCodexStore((state) => state.selectedEffort);
  const workspacePath = useCodexStore((state) => state.workspacePath);
  const threadId = useCodexStore((state) => state.threadId);
  const currentThreadName = useCodexStore((state) => state.currentThreadName);
  const currentTurnId = useCodexStore((state) => state.currentTurnId);
  const turnStatus = useCodexStore((state) => state.turnStatus);
  const transcriptOrder = useCodexStore((state) => state.transcriptOrder);
  const transcript = useCodexStore((state) => state.transcript);
  const approvals = useCodexStore((state) => state.approvals);
  const setWorkspace = useCodexStore((state) => state.setWorkspace);
  const setSelectedModel = useCodexStore((state) => state.setSelectedModel);
  const setSelectedEffort = useCodexStore((state) => state.setSelectedEffort);
  const startBackend = useCodexStore((state) => state.startBackend);
  const handleBridgeEvent = useCodexStore((state) => state.handleBridgeEvent);
  const createSession = useCodexStore((state) => state.createSession);
  const resumeSession = useCodexStore((state) => state.resumeSession);
  const replaceTranscript = useCodexStore((state) => state.replaceTranscript);
  const beginTurn = useCodexStore((state) => state.beginTurn);
  const clearApproval = useCodexStore((state) => state.clearApproval);
  const resetTranscript = useCodexStore((state) => state.resetTranscript);

  const [draft, setDraft] = useState('');
  const [connecting, setConnecting] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(() => (typeof window === 'undefined' ? true : window.innerWidth > 960));
  const [recentProjects, setRecentProjects] = useState<string[]>(() => {
    if (typeof window === 'undefined') {
      return [];
    }

    try {
      const agentKey = window.localStorage.getItem(SELECTED_AGENT_KEY) === 'claude'
        ? RECENT_PROJECTS_CLAUDE_KEY
        : RECENT_PROJECTS_KEY;
      const stored = window.localStorage.getItem(agentKey);
      return stored ? (JSON.parse(stored) as string[]) : [];
    } catch {
      return [];
    }
  });
  const [projectThreads, setProjectThreads] = useState<Record<string, ProjectThread[]>>({});
  const [loadingProjects, setLoadingProjects] = useState<Record<string, boolean>>({});
  const [collapsedProjects, setCollapsedProjects] = useState<Record<string, boolean>>({});
  const [selectedAgent, setSelectedAgent] = useState<(typeof AGENT_OPTIONS)[number]['id'] | null>(() => {
    if (typeof window === 'undefined') {
      return null;
    }

    try {
      const stored = window.localStorage.getItem(SELECTED_AGENT_KEY);
      return AGENT_OPTIONS.some((agent) => agent.id === stored && agent.available)
        ? (stored as (typeof AGENT_OPTIONS)[number]['id'])
        : null;
    } catch {
      return null;
    }
  });
  const [composerImages, setComposerImages] = useState<ComposerImage[]>([]);
  const [selectedComposerImage, setSelectedComposerImage] = useState<string | null>(null);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [effortMenuOpen, setEffortMenuOpen] = useState(false);
  const [autoAcceptMenuOpen, setAutoAcceptMenuOpen] = useState(false);
  const [autoAccept, setAutoAccept] = useState(false);
  const [organizeMode, setOrganizeMode] = useState<ThreadOrganizeMode>('byProject');
  const [sortMode, setSortMode] = useState<ThreadSortMode>('updated');
  const [scopeMode, setScopeMode] = useState<ThreadScopeMode>('all');

  const messageScrollRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const filterMenuRef = useRef<HTMLDivElement | null>(null);
  const modelMenuRef = useRef<HTMLDivElement | null>(null);
  const effortMenuRef = useRef<HTMLDivElement | null>(null);
  const autoAcceptMenuRef = useRef<HTMLDivElement | null>(null);

  const codex = typeof window !== 'undefined' ? window.codex : undefined;

  const selectedModelData = useMemo<Model | null>(() => {
    return models.find((model) => model.model === selectedModel) ?? models[0] ?? null;
  }, [models, selectedModel]);

  const effortOptions = useMemo<ReasoningEffort[]>(() => {
    const supported = selectedModelData?.supportedReasoningEfforts.map((option) => option.reasoningEffort) ?? [];
    return EFFORT_PRIORITY.filter((effort) => supported.includes(effort));
  }, [selectedModelData]);

  const transcriptEntries = useMemo(
    () => transcriptOrder.map((id) => transcript[id]).filter(Boolean),
    [transcript, transcriptOrder],
  );
  const displayThreadName = useMemo(() => clampThreadTitle(currentThreadName), [currentThreadName]);
  const selectedAgentLabel = useMemo(
    () => AGENT_OPTIONS.find((agent) => agent.id === selectedAgent)?.label ?? 'Codex',
    [selectedAgent],
  );

  const isTurnActive = currentTurnId !== null && turnStatus !== 'completed';
  const canSubmit = Boolean(threadId) && !connecting && (draft.trim().length > 0 || composerImages.length > 0);
  const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.platform);
  const visibleProjects = useMemo(
    () => (scopeMode === 'relevant' && workspacePath ? recentProjects.filter((projectPath) => projectPath === workspacePath) : recentProjects),
    [recentProjects, scopeMode, workspacePath],
  );
  const chronologicalThreads = useMemo(
    () =>
      visibleProjects
        .flatMap((projectPath) =>
          (projectThreads[projectPath] ?? []).map((thread) => ({
            projectPath,
            thread,
          })),
        )
        .sort((left, right) =>
          sortMode === 'created'
            ? right.thread.createdAt - left.thread.createdAt
            : right.thread.updatedAt - left.thread.updatedAt,
        ),
    [projectThreads, sortMode, visibleProjects],
  );

  useEffect(() => {
    const viewport = messageScrollRef.current;
    if (viewport) {
      viewport.scrollTop = viewport.scrollHeight;
    }
  }, [transcriptEntries.length, approvals.length, isTurnActive]);

  useEffect(() => {
    if (!filtersOpen && !modelMenuOpen && !effortMenuOpen && !autoAcceptMenuOpen) {
      return;
    }

    function handlePointerDown(event: MouseEvent): void {
      const target = event.target as Node;
      if (!filterMenuRef.current?.contains(target)) {
        setFiltersOpen(false);
      }
      if (!modelMenuRef.current?.contains(target)) {
        setModelMenuOpen(false);
      }
      if (!effortMenuRef.current?.contains(target)) {
        setEffortMenuOpen(false);
      }
      if (!autoAcceptMenuRef.current?.contains(target)) {
        setAutoAcceptMenuOpen(false);
      }
    }

    window.addEventListener('mousedown', handlePointerDown);
    return () => window.removeEventListener('mousedown', handlePointerDown);
  }, [effortMenuOpen, filtersOpen, modelMenuOpen, autoAcceptMenuOpen]);

  useEffect(() => {
    if (!autoAccept || approvals.length === 0) return;
    for (const approval of approvals) {
      if (approval.method === 'item/permissions/requestApproval') {
        void resolveApproval(approval.id, { permissions: approval.params.permissions, scope: 'session' });
      } else {
        void resolveApproval(approval.id, { decision: 'accept' });
      }
    }
  }, [autoAccept, approvals, resolveApproval]);

  useEffect(() => {
    if (!effortOptions.length) {
      if (selectedEffort !== null) {
        setSelectedEffort(null);
      }
      return;
    }

    if (!selectedEffort || !effortOptions.includes(selectedEffort)) {
      setSelectedEffort(selectedModelData?.defaultReasoningEffort ?? effortOptions[0]);
    }
  }, [effortOptions, selectedEffort, selectedModelData, setSelectedEffort]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const agentKey = selectedAgent === 'claude' ? RECENT_PROJECTS_CLAUDE_KEY : RECENT_PROJECTS_KEY;
    window.localStorage.setItem(agentKey, JSON.stringify(recentProjects));
  }, [recentProjects, selectedAgent]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    if (selectedAgent) {
      window.localStorage.setItem(SELECTED_AGENT_KEY, selectedAgent);
    } else {
      window.localStorage.removeItem(SELECTED_AGENT_KEY);
    }

    // Load the correct project list for the newly selected agent
    const agentKey = selectedAgent === 'claude' ? RECENT_PROJECTS_CLAUDE_KEY : RECENT_PROJECTS_KEY;
    try {
      const stored = window.localStorage.getItem(agentKey);
      setRecentProjects(stored ? (JSON.parse(stored) as string[]) : []);
    } catch {
      setRecentProjects([]);
    }
    setProjectThreads({});
  }, [selectedAgent]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    if (selectedAgent) {
      window.localStorage.setItem(SELECTED_AGENT_KEY, selectedAgent);
      return;
    }

    window.localStorage.removeItem(SELECTED_AGENT_KEY);
  }, [selectedAgent]);

  useEffect(() => {
    if (!codex) {
      setConnecting(false);
      setErrorMessage('This renderer is not running inside Electron.');
      return;
    }

    if (selectedAgent !== 'codex' && selectedAgent !== 'claude') {
      setConnecting(false);
      return;
    }

    return codex.subscribe((event) => handleBridgeEvent(event));
  }, [codex, handleBridgeEvent, selectedAgent]);

  function rememberProject(projectPath: string): void {
    setRecentProjects((currentProjects) => [projectPath, ...currentProjects.filter((entry) => entry !== projectPath)]);
  }

  async function refreshThreads(cwd: string): Promise<void> {
    if (!codex || !cwd) {
      return;
    }

    setLoadingProjects((current) => ({
      ...current,
      [cwd]: true,
    }));

    try {
      const response = await codex.listThreads(cwd);
      setProjectThreads((current) => ({
        ...current,
        [cwd]: response.data,
      }));
    } finally {
      setLoadingProjects((current) => ({
        ...current,
        [cwd]: false,
      }));
    }
  }

  async function syncThreadHistory(nextThreadId: string): Promise<void> {
    if (!codex || !nextThreadId) {
      return;
    }

    try {
      replaceTranscript(await codex.readThread(nextThreadId));
    } catch {
      // Newly created threads can fail includeTurns until the first user message exists.
    }
  }

  useEffect(() => {
    if (!codex || (selectedAgent !== 'codex' && selectedAgent !== 'claude')) {
      return;
    }

    let cancelled = false;

    void (async () => {
      try {
        if (selectedAgent === 'claude') {
          await codex.setAgent('claude');
          const backendResponse = await codex.startBackend();
          if (cancelled) return;
          startBackend(backendResponse);
          // Load threads for all previously used Claude projects from disk
          const stored = window.localStorage.getItem(RECENT_PROJECTS_CLAUDE_KEY);
          const savedProjects: string[] = stored ? (JSON.parse(stored) as string[]) : [];
          await Promise.all(savedProjects.map((p) => refreshThreads(p)));
        } else {
          await codex.setAgent('codex');
          const cwd = await codex.getCwd();
          if (cancelled) return;

          setWorkspace(cwd);
          rememberProject(cwd);

          const backendResponse = await codex.startBackend();
          if (cancelled) return;

          startBackend(backendResponse);

          const session = await codex.createSession(cwd);
          if (cancelled) return;

          createSession(cwd, session);

          // Load threads for all recent Codex projects
          const stored = window.localStorage.getItem(RECENT_PROJECTS_KEY);
          const savedProjects: string[] = stored ? (JSON.parse(stored) as string[]) : [];
          await Promise.all(savedProjects.map((p) => refreshThreads(p)));
        }
      } catch (error) {
        if (!cancelled) {
          setErrorMessage(error instanceof Error ? error.message : String(error));
        }
      } finally {
        if (!cancelled) {
          setConnecting(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [codex, createSession, selectedAgent, setWorkspace, startBackend]);

  useEffect(() => {
    if (!workspacePath || !codex) {
      return;
    }

    void refreshThreads(workspacePath);
  }, [codex, workspacePath]);

  useEffect(() => {
    if (workspacePath && !isTurnActive) {
      void refreshThreads(workspacePath);
    }
  }, [isTurnActive, workspacePath]);

  useEffect(() => {
    if (!threadId || isTurnActive) {
      return;
    }

    void syncThreadHistory(threadId);
  }, [isTurnActive, threadId]);

  async function submitTurn(event?: React.FormEvent<HTMLFormElement>): Promise<void> {
    event?.preventDefault();

    if (!codex || !threadId || !workspacePath || (!draft.trim() && composerImages.length === 0)) {
      return;
    }

    const nextDraft = draft.trim();
    const nextImages = composerImages;
    setDraft('');
    setComposerImages([]);

    try {
      const response = await codex.sendTurn({
        threadId,
        cwd: workspacePath,
        text: nextDraft,
        images: nextImages.map((image) => image.url),
        model: selectedModel,
        effort: effortOptions.length ? selectedEffort : null,
      });

      beginTurn(response);
    } catch {
      setDraft(nextDraft);
      setComposerImages(nextImages);
    }

    composerRef.current?.focus();
  }

  async function interruptTurn(): Promise<void> {
    if (!codex || !threadId || !currentTurnId) {
      return;
    }

    await codex.interruptTurn({ threadId, turnId: currentTurnId });
  }

  async function resolveApproval(id: string | number, result: unknown): Promise<void> {
    if (!codex) {
      return;
    }

    await codex.resolveServerRequest({ id, result });
    clearApproval(id);
  }

  async function chooseWorkspace(): Promise<void> {
    if (!codex) {
      return;
    }

    const nextWorkspace = await codex.selectWorkspace();
    if (!nextWorkspace) {
      return;
    }

    setWorkspace(nextWorkspace);
    rememberProject(nextWorkspace);
    createSession(nextWorkspace, await codex.createSession(nextWorkspace));
    await refreshThreads(nextWorkspace);
    setSidebarOpen(true);
  }

  async function openThread(projectPath: string, nextThreadId: string): Promise<void> {
    if (!codex || nextThreadId === threadId) {
      return;
    }

    if (projectPath !== workspacePath) {
      setWorkspace(projectPath);
      rememberProject(projectPath);
    }

    resumeSession(projectPath, await codex.resumeThread(nextThreadId, projectPath));
    await syncThreadHistory(nextThreadId);
  }

  async function startNewChatForProject(projectPath: string): Promise<void> {
    if (!codex || !projectPath) {
      return;
    }

    if (projectPath !== workspacePath) {
      setWorkspace(projectPath);
      rememberProject(projectPath);
    }

    resetTranscript();
    createSession(projectPath, await codex.createSession(projectPath));
    await refreshThreads(projectPath);
  }

  function handleComposerKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>): void {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      if (canSubmit) {
        void submitTurn();
      }
    }
  }

  function handleDraftChange(value: string): void {
    setDraft(value);

    const textarea = composerRef.current;
    if (!textarea) {
      return;
    }

    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(textarea.scrollHeight, 200)}px`;
  }

  function handleComposerPaste(event: React.ClipboardEvent<HTMLTextAreaElement>): void {
    const imageFiles = Array.from(event.clipboardData.items)
      .filter((item) => item.type.startsWith('image/'))
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null);

    if (imageFiles.length === 0) {
      return;
    }

    event.preventDefault();

    void Promise.all(
      imageFiles.map(
        (file) =>
          new Promise<ComposerImage>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () =>
              resolve({
                id: `${file.name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                url: String(reader.result),
              });
            reader.onerror = () => reject(reader.error);
            reader.readAsDataURL(file);
          }),
      ),
    )
      .then((images) => {
        setComposerImages((current) => [...current, ...images]);
      })
      .catch(() => {
        // Ignore failed clipboard reads and leave the draft unchanged.
      });
  }

  function removeComposerImage(imageId: string): void {
    setComposerImages((current) => current.filter((image) => image.id !== imageId));
  }

  function toggleProjectCollapsed(projectPath: string): void {
    setCollapsedProjects((current) => ({
      ...current,
      [projectPath]: !current[projectPath],
    }));
  }

  function handleAgentSelect(agentId: (typeof AGENT_OPTIONS)[number]['id']): void {
    if (agentId !== 'codex' && agentId !== 'claude') {
      return;
    }

    setErrorMessage(null);
    setConnecting(true);
    setSelectedAgent(agentId);
  }

  function handleChangeAgent(): void {
    setSelectedAgent(null);
    setConnecting(false);
    setErrorMessage(null);
    setDraft('');
    setComposerImages([]);
    resetTranscript();
  }

  if (!selectedAgent) {
    return (
      <div className="agent-select-screen">
        <div className="agent-select-card">
          <div className="agent-select-kicker">Agent Code</div>
          <h1>Select your agent</h1>
          <div className="agent-select-grid">
            {AGENT_OPTIONS.map((agent) => (
              <button
                key={agent.id}
                className={`agent-option ${agent.available ? '' : 'agent-option-disabled'}`}
                onClick={() => handleAgentSelect(agent.id)}
                type="button"
              >
                <img alt="" className="agent-option-icon" src={agent.icon} />
                <div className="agent-option-title">{agent.label}</div>
                {!agent.available ? <div className="agent-option-subtitle">Coming soon</div> : null}
              </button>
            ))}
          </div>
        </div>
      </div>
    );
  }

  if ((selectedAgent === 'codex' || selectedAgent === 'claude') && connecting && !threadId && !errorMessage) {
    const agentOption = AGENT_OPTIONS.find((a) => a.id === selectedAgent) ?? AGENT_OPTIONS[0];
    return (
      <div className="agent-select-screen">
        <div className="agent-select-card agent-connecting-card">
          <img alt="" className="agent-option-icon" src={agentOption.icon} />
          <h1>Connecting to {agentOption.label}</h1>
          <div className="spinner" />
        </div>
      </div>
    );
  }

  return (
    <div className={`app ${isMac ? 'platform-macos' : ''}`}>
      <div className={`app-shell ${sidebarOpen ? 'sidebar-open' : 'sidebar-closed'}`}>
        <aside className="sidebar">
          <div className="sidebar-header">
            <div className="sidebar-header-spacer" />
          </div>

          <div className="sidebar-brand">Agent Code</div>

          <div className="sidebar-nav">
            <button
              className="sidebar-nav-item"
              disabled={connecting}
              onClick={() => void (workspacePath ? startNewChatForProject(workspacePath) : chooseWorkspace())}
              type="button"
            >
              <LuSquarePen aria-hidden="true" size={16} />
              <span>New thread</span>
            </button>
          </div>

          <div className="chat-list">
            <div className="sidebar-section-row">
              <div className="sidebar-section-label">Threads</div>
              <div className="sidebar-section-tools" ref={filterMenuRef}>
                <button className="sidebar-icon-btn" disabled={connecting} onClick={() => void chooseWorkspace()} title="Add project" type="button">
                  <LuFolderPlus aria-hidden="true" size={16} />
                </button>
                <button className={`sidebar-icon-btn ${filtersOpen ? 'sidebar-icon-btn-active' : ''}`} onClick={() => setFiltersOpen((value) => !value)} title="Filter threads" type="button">
                  <LuSlidersHorizontal aria-hidden="true" size={16} />
                </button>
                {filtersOpen ? (
                  <div className="filter-menu">
                    <div className="filter-menu-section">
                      <div className="filter-menu-label">Organize</div>
                      <button className="filter-menu-item" onClick={() => setOrganizeMode('byProject')} type="button">
                        <span>By project</span>
                        {organizeMode === 'byProject' ? <span className="filter-menu-check">✓</span> : null}
                      </button>
                      <button className="filter-menu-item" onClick={() => setOrganizeMode('chronological')} type="button">
                        <span>Chronological list</span>
                        {organizeMode === 'chronological' ? <span className="filter-menu-check">✓</span> : null}
                      </button>
                    </div>
                    <div className="filter-menu-divider" />
                    <div className="filter-menu-section">
                      <div className="filter-menu-label">Sort by</div>
                      <button className="filter-menu-item" onClick={() => setSortMode('created')} type="button">
                        <span>Created</span>
                        {sortMode === 'created' ? <span className="filter-menu-check">✓</span> : null}
                      </button>
                      <button className="filter-menu-item" onClick={() => setSortMode('updated')} type="button">
                        <span>Updated</span>
                        {sortMode === 'updated' ? <span className="filter-menu-check">✓</span> : null}
                      </button>
                    </div>
                    <div className="filter-menu-divider" />
                    <div className="filter-menu-section">
                      <div className="filter-menu-label">Show</div>
                      <button className="filter-menu-item" onClick={() => setScopeMode('all')} type="button">
                        <span>All threads</span>
                        {scopeMode === 'all' ? <span className="filter-menu-check">✓</span> : null}
                      </button>
                      <button className="filter-menu-item" onClick={() => setScopeMode('relevant')} type="button">
                        <span>Relevant</span>
                        {scopeMode === 'relevant' ? <span className="filter-menu-check">✓</span> : null}
                      </button>
                    </div>
                  </div>
                ) : null}
              </div>
            </div>
            {visibleProjects.length === 0 ? <div className="sidebar-empty">No projects yet.</div> : null}
            {organizeMode === 'chronological'
              ? chronologicalThreads.map(({ projectPath, thread }) => (
                  <button
                    key={thread.id}
                    className={`chat-list-item ${thread.id === threadId ? 'chat-list-item-active' : ''}`}
                    onClick={() => void openThread(projectPath, thread.id)}
                    type="button"
                  >
                    <div className="chat-list-title-row">
                      <span className="chat-list-title-wrap">
                        {thread.id === threadId && isTurnActive ? <LoaderDot /> : null}
                        <span className="chat-list-title">{thread.preview?.trim() || 'New chat'}</span>
                      </span>
                      <span className="chat-list-time">{formatUpdatedAt(sortMode === 'created' ? thread.createdAt : thread.updatedAt)}</span>
                    </div>
                  </button>
                ))
              : visibleProjects.map((projectPath) => {
              const projectName = formatWorkspaceName(projectPath);
              const threads = [...(projectThreads[projectPath] ?? [])].sort((left, right) =>
                sortMode === 'created' ? right.createdAt - left.createdAt : right.updatedAt - left.updatedAt,
              );
              const isActiveProject = projectPath === workspacePath;
              const isLoadingProject = loadingProjects[projectPath] ?? false;
              const isCollapsed = collapsedProjects[projectPath] ?? false;

              return (
                <div className={`project-group ${isActiveProject ? 'project-group-active' : ''}`} key={projectPath}>
                  <div className={`project-group-row ${isActiveProject ? 'project-group-row-active' : ''}`}>
                    <button
                      className={`project-group-header ${isActiveProject ? 'project-group-header-active' : ''}`}
                      onClick={() => toggleProjectCollapsed(projectPath)}
                      title={projectPath}
                      type="button"
                    >
                      {isCollapsed ? (
                        <LuChevronRight aria-hidden="true" className="project-group-chevron" size={16} />
                      ) : (
                        <LuChevronDown aria-hidden="true" className="project-group-chevron" size={16} />
                      )}
                      <LuFolder aria-hidden="true" className="project-group-icon" size={18} />
                      <span className="project-group-name">{projectName}</span>
                    </button>

                    <div className="project-group-actions">
                      <button
                        className={`project-new-chat btn btn-ghost ${isActiveProject ? 'project-new-chat-active' : ''}`}
                        disabled={connecting}
                        onClick={() => void startNewChatForProject(projectPath)}
                        title="New chat"
                        type="button"
                      >
                        <span aria-hidden="true" className="project-new-chat-glyph">+</span>
                      </button>
                    </div>
                  </div>

                  <div className={`project-thread-list ${isCollapsed ? 'project-thread-list-collapsed' : ''}`}>
                    {isLoadingProject ? <div className="sidebar-empty">Loading chats...</div> : null}
                    {threads.map((thread) => (
                      <button
                        key={thread.id}
                        className={`chat-list-item ${thread.id === threadId ? 'chat-list-item-active' : ''}`}
                        onClick={() => void openThread(projectPath, thread.id)}
                        type="button"
                      >
                        <div className="chat-list-title-row">
                          <span className="chat-list-title-wrap">
                            {thread.id === threadId && isTurnActive ? <LoaderDot /> : null}
                            <span className="chat-list-title">{thread.preview?.trim() || 'New chat'}</span>
                          </span>
                          <span className="chat-list-time">{formatUpdatedAt(sortMode === 'created' ? thread.createdAt : thread.updatedAt)}</span>
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>

          <div className="sidebar-footer">
            <button className="sidebar-nav-item" onClick={handleChangeAgent} type="button">
              <LuSparkles aria-hidden="true" size={16} />
              <span>Change agent</span>
            </button>
            <button className="sidebar-nav-item" type="button">
              <LuSettings2 aria-hidden="true" size={16} />
              <span>Settings</span>
            </button>
          </div>

        </aside>

        <div className="app-main">
          <header className="topbar">
            <div className="topbar-left">
              <button
                className="sidebar-toggle btn btn-sm btn-ghost"
                onClick={() => setSidebarOpen((value) => !value)}
                aria-label={sidebarOpen ? 'Close sidebar' : 'Open sidebar'}
                title={sidebarOpen ? 'Close sidebar' : 'Open sidebar'}
                type="button"
              >
                <SidebarToggleIcon open={sidebarOpen} />
              </button>
              <div className="topbar-heading">
                <div className="topbar-title-group">
                  <div className="topbar-title" title={currentThreadName}>{displayThreadName}</div>
                </div>
              </div>
            </div>

            <div className="topbar-right">
            </div>
          </header>

          <main className="messages" ref={messageScrollRef}>
            <div className="messages-inner">
              {connecting ? (
                <div className="empty-state">
                  <div className="spinner" />
                  <p>Connecting to the local agent runtime...</p>
                </div>
              ) : null}

              {!connecting && errorMessage ? (
                <div className="empty-state">
                  <p className="error-text">{errorMessage}</p>
                </div>
              ) : null}

              {!connecting && !errorMessage && transcriptEntries.length === 0 ? (
                <div className="empty-state">
                  <h1>What should {selectedAgentLabel} work on?</h1>
                  <p className="empty-sub">{workspacePath ? formatWorkspaceName(workspacePath) : 'Choose a project to begin.'}</p>
                </div>
              ) : null}

              {transcriptEntries.map((entry) => (
                <TranscriptRow entry={entry} key={entry.id} />
              ))}

              {approvals.map((approval) => (
                <ApprovalCard approval={approval} key={approval.id} onResolve={resolveApproval} />
              ))}

              {isTurnActive ? <ThinkingRow /> : null}
            </div>
          </main>

          <footer className="composer">
            <form className="composer-form" onSubmit={(event) => void submitTurn(event)}>
              {composerImages.length > 0 ? (
                <div className="composer-image-strip">
                  {composerImages.map((image) => (
                    <div className="composer-image-chip" key={image.id}>
                      <button className="user-image-button" onClick={() => setSelectedComposerImage(image.url)} type="button">
                        <img alt="Pending upload" className="user-message-image" src={image.url} />
                      </button>
                      <button className="composer-image-remove" onClick={() => removeComposerImage(image.id)} type="button">
                        ×
                      </button>
                    </div>
                  ))}
                </div>
              ) : null}
              <textarea
                className="composer-input"
                disabled={!threadId || connecting}
                onChange={(event) => handleDraftChange(event.target.value)}
                onKeyDown={handleComposerKeyDown}
                onPaste={handleComposerPaste}
                placeholder={threadId ? `Message ${selectedAgentLabel}...` : 'Waiting for connection...'}
                ref={composerRef}
                rows={1}
                value={draft}
              />

              <div className="composer-bar">
                <div className="composer-bar-left">
                  {models.length > 0 ? (
                    <PickerMenu
                      label="Select model"
                      menuRef={modelMenuRef}
                      onSelect={(nextModel) => {
                        setSelectedModel(nextModel);
                        setModelMenuOpen(false);

                        const nextModelData = models.find((model) => model.model === nextModel) ?? null;
                        const nextEfforts = EFFORT_PRIORITY.filter((effort) =>
                          nextModelData?.supportedReasoningEfforts.some((option) => option.reasoningEffort === effort),
                        );

                        setSelectedEffort(nextEfforts.length ? nextModelData?.defaultReasoningEffort ?? nextEfforts[0] : null);
                      }}
                      onToggle={() => {
                        setEffortMenuOpen(false);
                        setModelMenuOpen((value) => !value);
                      }}
                      open={modelMenuOpen}
                      options={models.map((model) => ({ value: model.model, label: model.displayName }))}
                      value={(selectedModel && models.some((model) => model.model === selectedModel) ? selectedModel : models[0]?.model) ?? ''}
                    />
                  ) : null}

                  {effortOptions.length > 0 ? (
                    <PickerMenu
                      label="Select effort"
                      menuRef={effortMenuRef}
                      onSelect={(effort) => {
                        setSelectedEffort(effort);
                        setEffortMenuOpen(false);
                      }}
                      onToggle={() => {
                        setModelMenuOpen(false);
                        setEffortMenuOpen((value) => !value);
                      }}
                      open={effortMenuOpen}
                      options={effortOptions.map((effort) => ({ value: effort, label: `${humanizeEffort(effort)} effort` }))}
                      value={selectedEffort ?? effortOptions[0]}
                    />
                  ) : null}

                  <PickerMenu
                    label="Accept edits"
                    menuRef={autoAcceptMenuRef}
                    onSelect={(value) => {
                      setAutoAccept(value === 'on');
                      setAutoAcceptMenuOpen(false);
                    }}
                    onToggle={() => {
                      setModelMenuOpen(false);
                      setEffortMenuOpen(false);
                      setAutoAcceptMenuOpen((value) => !value);
                    }}
                    open={autoAcceptMenuOpen}
                    options={[
                      { value: 'off', label: 'Accept edits: Off' },
                      { value: 'on', label: 'Accept edits: On' },
                    ]}
                    value={autoAccept ? 'on' : 'off'}
                  />
                </div>

                <div className="composer-bar-right">
                  {currentTurnId ? (
                    <button className="composer-stop-btn" onClick={() => void interruptTurn()} type="button">
                      Stop
                    </button>
                  ) : null}

                  <button className="btn btn-send" disabled={!canSubmit} type="submit">
                    <LuArrowUp aria-hidden="true" size={20} />
                  </button>
                </div>
              </div>
            </form>
            {selectedComposerImage ? (
              <button className="image-modal" onClick={() => setSelectedComposerImage(null)} type="button">
                <img alt="Expanded pending upload" className="image-modal-content" src={selectedComposerImage} />
              </button>
            ) : null}
          </footer>
        </div>
      </div>
    </div>
  );
}
