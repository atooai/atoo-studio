import React, { useState } from 'react';
import type { SessionEvent } from '../types/index.js';

interface Props {
  request: SessionEvent;
  onRespond: (requestId: string, approved: boolean, updatedInput?: any) => void;
  responded?: boolean;
}

interface QuestionDef {
  question: string;
  header?: string;
  options: { label: string; description?: string }[];
  multiSelect?: boolean;
}

export default function UserQuestion({ request, onRespond, responded }: Props) {
  const requestId = request.request_id || request.response?.request_id || '';
  const input = request.request?.input || {};
  const questions: QuestionDef[] = input.questions || [];
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [customTexts, setCustomTexts] = useState<Record<string, string>>({});
  const [usingCustom, setUsingCustom] = useState<Record<string, boolean>>({});
  const [submitted, setSubmitted] = useState(false);
  const [cancelled, setCancelled] = useState(false);

  const setAnswer = (question: string, value: string) => {
    setUsingCustom((prev) => ({ ...prev, [question]: false }));
    setAnswers((prev) => ({ ...prev, [question]: value }));
  };

  const setCustom = (question: string, text: string) => {
    setUsingCustom((prev) => ({ ...prev, [question]: true }));
    setCustomTexts((prev) => ({ ...prev, [question]: text }));
    setAnswers((prev) => ({ ...prev, [question]: text }));
  };

  const enableCustom = (question: string) => {
    setUsingCustom((prev) => ({ ...prev, [question]: true }));
    setAnswers((prev) => ({ ...prev, [question]: customTexts[question] || '' }));
  };

  const allAnswered = questions.every((q) => answers[q.question]);

  const handleSubmit = () => {
    if (!allAnswered) return;
    setSubmitted(true);
    const updatedInput = { ...input, answers };
    onRespond(requestId, true, updatedInput);
  };

  const handleCancel = () => {
    setCancelled(true);
    onRespond(requestId, false);
  };

  // Already responded (from replayed events or after submit/cancel)
  if (responded || submitted || cancelled) {
    const displayAnswers = submitted ? answers : null;
    return (
      <div style={styles.answeredContainer}>
        {questions.map((q, qi) => (
          <div key={qi} style={styles.answeredItem}>
            <span style={styles.answeredHeader}>{q.header || 'Q'}: </span>
            <span style={styles.answeredValue}>
              {displayAnswers?.[q.question] || (cancelled ? 'Skipped' : 'Answered')}
            </span>
          </div>
        ))}
      </div>
    );
  }

  return (
    <div style={styles.container}>
      {questions.map((q, qi) => (
        <div key={qi} style={styles.questionBlock}>
          {q.header && <div style={styles.header}>{q.header}</div>}
          <div style={styles.question}>{q.question}</div>
          <div style={styles.options}>
            {q.options.map((opt, oi) => {
              const selected = !usingCustom[q.question] && answers[q.question] === opt.label;
              return (
                <div
                  key={oi}
                  style={{
                    ...styles.option,
                    ...(selected ? styles.optionSelected : {}),
                  }}
                  onClick={() => setAnswer(q.question, opt.label)}
                >
                  <div style={styles.optionRadio}>
                    <div style={{
                      ...styles.radioInner,
                      ...(selected ? styles.radioSelected : {}),
                    }} />
                  </div>
                  <div>
                    <div style={styles.optionLabel}>{opt.label}</div>
                    {opt.description && (
                      <div style={styles.optionDesc}>{opt.description}</div>
                    )}
                  </div>
                </div>
              );
            })}
            {/* Free text "Other" option */}
            <div
              style={{
                ...styles.option,
                ...(usingCustom[q.question] ? styles.optionSelected : {}),
                flexDirection: 'column',
                gap: 6,
              }}
              onClick={() => enableCustom(q.question)}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <div style={styles.optionRadio}>
                  <div style={{
                    ...styles.radioInner,
                    ...(usingCustom[q.question] ? styles.radioSelected : {}),
                  }} />
                </div>
                <div style={styles.optionLabel}>Other</div>
              </div>
              {usingCustom[q.question] && (
                <input
                  type="text"
                  style={styles.customInput}
                  placeholder="Type your answer..."
                  value={customTexts[q.question] || ''}
                  onChange={(e) => setCustom(q.question, e.target.value)}
                  autoFocus
                  onClick={(e) => e.stopPropagation()}
                />
              )}
            </div>
          </div>
        </div>
      ))}
      <div style={styles.buttonRow}>
        <button
          style={{
            ...styles.submitBtn,
            opacity: allAnswered ? 1 : 0.4,
            cursor: allAnswered ? 'pointer' : 'default',
          }}
          onClick={handleSubmit}
          disabled={!allAnswered}
        >
          Submit
        </button>
        <button style={styles.cancelBtn} onClick={handleCancel}>
          Skip
        </button>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    margin: '12px 0',
    padding: 16,
    background: '#1c2128',
    border: '1px solid #58a6ff',
    borderRadius: 8,
  },
  answeredContainer: {
    margin: '4px 0',
    padding: '6px 12px',
    display: 'flex',
    gap: 12,
    flexWrap: 'wrap',
  },
  answeredItem: {
    fontSize: 11,
  },
  answeredHeader: {
    color: '#484f58',
    textTransform: 'uppercase' as const,
  },
  answeredValue: {
    color: '#8b949e',
  },
  questionBlock: {
    marginBottom: 12,
  },
  header: {
    fontSize: 10,
    fontWeight: 600,
    color: '#58a6ff',
    textTransform: 'uppercase' as const,
    letterSpacing: 1,
    marginBottom: 4,
  },
  question: {
    fontSize: 14,
    color: '#e6edf3',
    marginBottom: 8,
  },
  options: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 6,
  },
  option: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: 10,
    padding: '8px 12px',
    background: '#0d1117',
    border: '1px solid #21262d',
    borderRadius: 6,
    cursor: 'pointer',
    transition: 'border-color 0.15s ease',
  },
  optionSelected: {
    borderColor: '#58a6ff',
  },
  optionRadio: {
    width: 16,
    height: 16,
    borderRadius: '50%',
    border: '2px solid #30363d',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    marginTop: 2,
  },
  radioInner: {
    width: 8,
    height: 8,
    borderRadius: '50%',
    background: 'transparent',
    transition: 'background 0.15s ease',
  },
  radioSelected: {
    background: '#58a6ff',
  },
  optionLabel: {
    fontSize: 13,
    color: '#e6edf3',
    fontWeight: 500,
  },
  optionDesc: {
    fontSize: 11,
    color: '#8b949e',
    marginTop: 2,
  },
  customInput: {
    width: '100%',
    background: '#161b22',
    color: '#e6edf3',
    border: '1px solid #30363d',
    borderRadius: 4,
    padding: '4px 8px',
    fontSize: 12,
    outline: 'none',
    fontFamily: 'inherit',
  },
  buttonRow: {
    display: 'flex',
    gap: 8,
    marginTop: 4,
  },
  submitBtn: {
    padding: '6px 20px',
    background: '#238636',
    color: '#fff',
    border: 'none',
    borderRadius: 6,
    fontSize: 13,
    cursor: 'pointer',
  },
  cancelBtn: {
    padding: '6px 16px',
    background: 'transparent',
    color: '#8b949e',
    border: '1px solid #30363d',
    borderRadius: 6,
    fontSize: 13,
    cursor: 'pointer',
  },
};
