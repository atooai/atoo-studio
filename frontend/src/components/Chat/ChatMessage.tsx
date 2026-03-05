import React, { useRef, useCallback } from 'react';
import { useStore } from '../../state/store';
import { escapeHtml, renderMd, getAttachIcon, svgCopy, svgCheck } from '../../utils';
import type { FilteredMessage, Session } from '../../types';

export function ChatMessageItem({ m, fi, session }: { m: FilteredMessage; fi: number; session: Session }) {
  if (m.role === '_collapsed' as any) {
    return <CollapsedIndicator m={m} />;
  }
  if (m.role === 'thinking') return <ThinkingBlock m={m} />;
  if (m.role === 'tool') return <ToolBlock m={m} fi={fi} />;
  if (m.role === 'control_request') return <ControlRequest m={m} session={session} />;

  const isUser = m.role === 'user';
  return (
    <div className={`chat-msg ${m.role}`}>
      <div className={`chat-avatar ${isUser ? 'you' : 'claude'}`}>{isUser ? 'Y' : 'C'}</div>
      <div className="chat-bubble">
        <AttachmentDisplay attachments={m._attachments} />
        {isUser ? (
          <span>{escapeHtml(m.content)}</span>
        ) : (
          <AssistantContent m={m} />
        )}
      </div>
    </div>
  );
}

function AttachmentDisplay({ attachments }: { attachments?: any[] }) {
  if (!attachments || !attachments.length) return null;
  return (
    <>
      {attachments.map((a: any, i: number) => {
        if (a.text) {
          const icon = getAttachIcon(a.kind || 'text');
          return <div key={i} className="chat-attach-chip-inline">{icon} {escapeHtml(a.name || 'file')}</div>;
        }
        if (a.media_type === 'application/pdf') {
          return <div key={i} className="chat-attach-chip-inline">📄 {escapeHtml(a.name || 'document.pdf')}</div>;
        }
        return <img key={i} className="chat-attachment-img" src={`data:${a.media_type};base64,${a.data}`} alt="attachment" />;
      })}
    </>
  );
}

function AssistantContent({ m }: { m: FilteredMessage }) {
  const { mdToggleState, setMdToggle } = useStore();
  const uuid = m._eventUuid || '';
  const mode = mdToggleState[uuid] || 'md';

  const toggle = () => {
    const next = mode === 'md' ? 'txt' : mode === 'txt' ? 'raw' : 'md';
    setMdToggle(uuid, next);
  };

  return (
    <>
      <span className="chat-bubble-toolbar">
        <CopyButton content={m.content} />
        <span className="chat-bubble-btn" onClick={(e) => { e.stopPropagation(); toggle(); }} title="Toggle view mode">{mode}</span>
      </span>
      {mode === 'txt' ? (
        <div className="chat-text-raw" data-raw-md={m.content}>{escapeHtml(m.content)}</div>
      ) : mode === 'raw' ? (
        <div className="chat-text-raw" data-raw-md={m.content}>{escapeHtml(m._rawEvent ? JSON.stringify(m._rawEvent, null, 2) : m.content)}</div>
      ) : (
        <div className="md-content" data-raw-md={m.content} dangerouslySetInnerHTML={{ __html: renderMd(m.content) }} />
      )}
    </>
  );
}

function CopyButton({ content }: { content: string }) {
  const [copied, setCopied] = React.useState(false);

  const copy = (e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard.writeText(content).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <span className={`chat-bubble-btn ${copied ? 'copied' : ''}`} onClick={copy} title="Copy"
      dangerouslySetInnerHTML={{ __html: copied ? svgCheck : svgCopy }} />
  );
}

function CollapsedIndicator({ m }: { m: any }) {
  return (
    <div className="chat-collapsed-indicator" onClick={() => {
      // Expand collapsed — toggle verbose mode on
      const store = useStore.getState();
      const proj = store.getActiveProject();
      if (!proj) return;
      const active = proj.sessions.filter(s => s.status !== 'ended');
      const session = active[proj.activeSessionIdx || 0];
      if (session) {
        session.showVerbose = true;
        store.updateProject(proj.id, p => ({ ...p }));
      }
    }}>
      <span>⋯</span>
      <span className="chat-collapsed-count">{m.toolCount > 0 ? m.toolCount + ' tool call' + (m.toolCount > 1 ? 's' : '') : ''}</span>
      <span style={{ fontSize: 10 }}>click to show</span>
    </div>
  );
}

function ThinkingBlock({ m }: { m: FilteredMessage }) {
  const { mdToggleState, setMdToggle } = useStore();
  const uuid = m._eventUuid || '';
  const mode = mdToggleState[uuid] || 'md';
  const toggle = () => setMdToggle(uuid, mode === 'md' ? 'txt' : mode === 'txt' ? 'raw' : 'md');

  return (
    <div className="chat-thinking">
      <div className="chat-thinking-header">Thinking</div>
      <span className="chat-bubble-toolbar">
        <CopyButton content={m.content} />
        <span className="chat-bubble-btn" onClick={(e) => { e.stopPropagation(); toggle(); }} title="Toggle view mode">{mode}</span>
      </span>
      {mode === 'txt' ? (
        <div className="chat-text-raw" data-raw-md={m.content}>{escapeHtml(m.content)}</div>
      ) : mode === 'raw' ? (
        <div className="chat-text-raw" data-raw-md={m.content}>{escapeHtml(m._rawEvent ? JSON.stringify(m._rawEvent, null, 2) : m.content)}</div>
      ) : (
        <div className="md-content" data-raw-md={m.content} dangerouslySetInnerHTML={{ __html: renderMd(m.content) }} />
      )}
    </div>
  );
}

function ToolBlock({ m, fi }: { m: FilteredMessage; fi: number }) {
  const { mdToggleState, setMdToggle } = useStore();
  const uuid = m._eventUuid || '';
  const mode = mdToggleState[uuid] || 'md';
  const toggleMode = () => setMdToggle(uuid, mode === 'md' ? 'txt' : mode === 'txt' ? 'raw' : 'md');
  const toolName = m._toolName || '';

  // Build detail section
  let detail: React.ReactNode = null;
  if (m._toolInput) {
    const input = m._toolInput;
    if (toolName === 'Bash' && input.command) {
      detail = <div className="chat-tool-command">{escapeHtml(input.command)}</div>;
    } else if ((toolName === 'Read' || toolName === 'Write' || toolName === 'Edit') && input.file_path) {
      detail = (
        <>
          <div className="chat-tool-filepath">{escapeHtml(input.file_path)}</div>
          {toolName === 'Edit' && input.old_string && (
            <details className="chat-tool-details">
              <summary>diff</summary>
              <pre>{escapeHtml(input.old_string)}{'\n→\n'}{escapeHtml(input.new_string || '')}</pre>
            </details>
          )}
        </>
      );
    } else if ((toolName === 'Grep' || toolName === 'Glob') && input.pattern) {
      detail = <div className="chat-tool-filepath">{escapeHtml(input.pattern)}{input.path ? ' in ' + escapeHtml(input.path) : ''}</div>;
    } else {
      const json = JSON.stringify(input, null, 2);
      if (json.length > 2) {
        detail = <details className="chat-tool-details"><summary>params</summary><pre>{escapeHtml(json)}</pre></details>;
      }
    }
  }

  // Pending
  if (m._pending) {
    return (
      <div className="chat-tool-use pending">
        <div className="chat-tool-header"><span className="tool-icon">⚡</span><span className="chat-tool-name">{escapeHtml(toolName || 'Tool')}</span></div>
        {detail}
        <div className="chat-tool-pending">Running...</div>
      </div>
    );
  }

  // Tool output
  let outputContent: React.ReactNode = null;
  if (m._toolOutput) {
    if (mode === 'raw') {
      const rawJson = m._rawEvent ? JSON.stringify(m._rawEvent, null, 2) : m._toolOutput;
      outputContent = <div className="chat-tool-output"><pre>{escapeHtml(rawJson)}</pre></div>;
    } else if (mode === 'txt') {
      outputContent = <div className="chat-tool-output"><pre>{escapeHtml(m._toolOutput)}</pre></div>;
    } else {
      const output = m._toolOutput;
      if (output.length > 300) {
        outputContent = (
          <details className="chat-tool-output">
            <summary>output ({output.length} chars){m._isError ? ' ⚠ error' : ''}</summary>
            <pre>{escapeHtml(output)}</pre>
          </details>
        );
      } else if (output.trim()) {
        outputContent = <div className={`chat-tool-output${m._isError ? ' error' : ''}`}><pre>{escapeHtml(output)}</pre></div>;
      }
    }
  }

  // Fallback for tools without structured data
  if (!toolName && !m._toolInput && !m._toolOutput) {
    return <div className="chat-tool-use"><span className="tool-icon">⚡</span>{escapeHtml(m.content)}</div>;
  }

  return (
    <div className="chat-tool-use">
      <div className="chat-tool-header">
        <span className="tool-icon">⚡</span>
        <span className="chat-tool-name">{escapeHtml(toolName || 'Tool')}</span>
        <span className="chat-bubble-btn" onClick={(e) => { e.stopPropagation(); toggleMode(); }} title="Toggle view mode">{mode}</span>
      </div>
      {detail}
      {outputContent}
    </div>
  );
}

function ControlRequest({ m, session }: { m: FilteredMessage; session: Session }) {
  const req = m.content;
  const toolName = req?.tool_use?.name || req?.tool_name || req?.request?.tool_name || req?.name || '';
  const input = req?.tool_use?.input || req?.input || req?.request?.input || req?.tool_use || {};
  const isResponded = m._responded;

  if (toolName === 'AskUserQuestion' || req?.subtype === 'ask_user_question') {
    return <UserQuestion m={m} session={session} input={input} isResponded={!!isResponded} />;
  }

  if (toolName === 'ExitPlanMode' || req?.subtype === 'plan_approval') {
    const plan = req?.plan || input?.plan || '';
    return <PlanApproval m={m} session={session} plan={plan} isResponded={!!isResponded} />;
  }

  if (isResponded) return null;

  return <ToolApproval m={m} session={session} toolName={toolName} input={input} />;
}

function UserQuestion({ m, session, input, isResponded }: { m: FilteredMessage; session: Session; input: any; isResponded: boolean }) {
  const { questionAnswers, setQuestionAnswer, setQuestionAnswers } = useStore();
  const questions = input.questions || [];
  const uuid = m._eventUuid || '';
  const answers = questionAnswers[uuid] || {};

  if (isResponded) {
    return (
      <div className="chat-question-answered">
        {questions.map((q: any, i: number) => {
          const header = q.header || 'Q';
          const answer = answers[q.question] || 'Answered';
          return (
            <span key={i}>
              <span className="chat-question-answered-header">{escapeHtml(header)}: </span>
              <span className="chat-question-answered-value">{escapeHtml(answer)}</span>
            </span>
          );
        })}
      </div>
    );
  }

  const allAnswered = questions.every((q: any) => answers[q.question]);

  return (
    <div className="chat-question-panel">
      {questions.map((q: any, qi: number) => (
        <QuestionItem
          key={qi}
          q={q}
          uuid={uuid}
          sessionId={session.id}
          answers={answers}
        />
      ))}
      <div className="chat-question-buttons">
        <button className="chat-question-submit" disabled={!allAnswered} onClick={() => (window as any).submitQuestion(uuid, session.id)}>Submit</button>
        <button className="chat-question-skip" onClick={() => (window as any).skipQuestion(uuid, session.id)}>Skip</button>
      </div>
    </div>
  );
}

function QuestionItem({ q, uuid, sessionId, answers }: { q: any; uuid: string; sessionId: string; answers: Record<string, string> }) {
  const { setQuestionAnswer } = useStore();
  const qKey = q.question;
  const isCustom = !!answers['_custom_' + qKey];

  return (
    <div>
      {q.header && <div className="chat-question-header">{escapeHtml(q.header)}</div>}
      <div className="chat-question-text">{escapeHtml(q.question)}</div>
      <div className="chat-question-options">
        {(q.options || []).map((opt: any, oi: number) => {
          const selected = answers[qKey] === opt.label && !isCustom;
          return (
            <div
              key={oi}
              className={`chat-question-option ${selected ? 'selected' : ''}`}
              onClick={() => {
                const store = useStore.getState();
                const newAnswers: Record<string, string> = { ...(store.questionAnswers[uuid] || {}), [qKey]: opt.label };
                delete newAnswers['_custom_' + qKey];
                store.setQuestionAnswers(uuid, newAnswers);
              }}
            >
              <div className="chat-question-radio"><div className="chat-question-radio-inner"></div></div>
              <div>
                <div className="chat-question-option-label">{escapeHtml(opt.label)}</div>
                {opt.description && <div className="chat-question-option-desc">{escapeHtml(opt.description)}</div>}
              </div>
            </div>
          );
        })}
        {/* Other option */}
        <div
          className={`chat-question-option ${isCustom ? 'selected' : ''}`}
          onClick={() => {
            const store = useStore.getState();
            const newAnswers = { ...(store.questionAnswers[uuid] || {}), ['_custom_' + qKey]: 'true', [qKey]: store.questionAnswers[uuid]?.['_customText_' + qKey] || '' };
            store.setQuestionAnswers(uuid, newAnswers);
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%' }}>
            <div className="chat-question-radio"><div className="chat-question-radio-inner"></div></div>
            <div className="chat-question-option-label">Other</div>
          </div>
          {isCustom && (
            <input
              type="text"
              className="chat-question-custom-input"
              placeholder="Type your answer..."
              value={answers['_customText_' + qKey] || ''}
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => {
                const store = useStore.getState();
                const newAnswers = { ...(store.questionAnswers[uuid] || {}), ['_customText_' + qKey]: e.target.value, [qKey]: e.target.value };
                store.setQuestionAnswers(uuid, newAnswers);
              }}
              autoFocus
            />
          )}
        </div>
      </div>
    </div>
  );
}

function PlanApproval({ m, session, plan, isResponded }: { m: FilteredMessage; session: Session; plan: string; isResponded: boolean }) {
  if (isResponded) {
    const approved = m._response === 'approved';
    return (
      <div className="chat-plan-responded">
        <span className="chat-plan-responded-icon">{approved ? '✅' : '❌'}</span>
        <span>Plan {approved ? 'approved' : 'denied'}</span>
      </div>
    );
  }
  return (
    <div className="chat-plan-approval">
      <div className="chat-plan-header">Plan Approval</div>
      <div className="chat-plan-content" dangerouslySetInnerHTML={{ __html: renderMd(plan) }} />
      <div className="chat-plan-buttons">
        <button className="chat-plan-approve" onClick={() => (window as any).approveControl(session.id)}>Approve Plan</button>
        <button className="chat-plan-deny" onClick={() => (window as any).denyControl(session.id)}>Deny</button>
      </div>
    </div>
  );
}

function ToolApproval({ m, session, toolName, input }: { m: FilteredMessage; session: Session; toolName: string; input: any }) {
  const isBash = toolName === 'Bash';

  return (
    <div className="chat-tool-approval">
      <div className="chat-tool-approval-header">
        <span className="chat-tool-approval-icon">{isBash ? '>' : '⚠'}</span>
        <span className="chat-tool-approval-name">{escapeHtml(toolName || 'Tool')}</span>
      </div>
      {isBash ? (
        <BashApprovalContent input={input} />
      ) : (
        <GenericApprovalContent toolName={toolName} input={input} />
      )}
      <div className="chat-tool-approval-buttons">
        <button className="chat-tool-approval-allow" onClick={() => (window as any).approveControl(session.id)}>Allow</button>
        <button className="chat-tool-approval-deny" onClick={() => (window as any).denyControl(session.id)}>Deny</button>
      </div>
    </div>
  );
}

function BashApprovalContent({ input }: { input: any }) {
  return (
    <>
      {input.description && <div className="chat-tool-approval-desc">{escapeHtml(input.description)}</div>}
      <div className="chat-tool-approval-command">
        <span className="chat-tool-approval-prompt">$ </span>{escapeHtml(input.command || '')}
      </div>
      {(input.timeout || input.run_in_background) && (
        <div className="chat-tool-approval-meta">
          {input.run_in_background && <span className="chat-tool-approval-tag">background</span>}
          {input.timeout && <span className="chat-tool-approval-tag">timeout: {input.timeout}ms</span>}
        </div>
      )}
    </>
  );
}

function GenericApprovalContent({ toolName, input }: { toolName: string; input: any }) {
  const primaryFields: Record<string, string[]> = {
    Read: ['file_path'], Write: ['file_path'], Edit: ['file_path'],
    Glob: ['pattern', 'path'], Grep: ['pattern', 'path'],
    WebFetch: ['url'], WebSearch: ['query'],
  };
  const primaries = primaryFields[toolName] || [];
  const primaryEntries: [string, any][] = [];
  const otherEntries: [string, any][] = [];
  for (const [k, v] of Object.entries(input || {})) {
    if (primaries.includes(k)) primaryEntries.push([k, v]);
    else otherEntries.push([k, v]);
  }

  if (primaryEntries.length > 0) {
    return (
      <>
        {primaryEntries.map(([k, v]) => (
          <div key={k} className="chat-tool-approval-field">
            <span className="chat-tool-approval-field-label">{escapeHtml(k)}: </span>
            <span className="chat-tool-approval-field-value">{escapeHtml(String(v))}</span>
          </div>
        ))}
        {otherEntries.length > 0 && (
          <details className="chat-tool-approval-other-params">
            <summary>{otherEntries.length} more param{otherEntries.length !== 1 ? 's' : ''}</summary>
            <pre>{escapeHtml(JSON.stringify(Object.fromEntries(otherEntries), null, 2))}</pre>
          </details>
        )}
      </>
    );
  }

  return <pre className="chat-tool-approval-command" style={{ whiteSpace: 'pre-wrap' }}>{escapeHtml(JSON.stringify(input, null, 2))}</pre>;
}
