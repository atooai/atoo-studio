import React, { useState, useMemo, useCallback } from 'react';
import type { AskUserQuestion, AskUserAnswer, AskUserFormAnswer, AskUserAnswers } from './types';

interface Props {
  sessionId: string;
  requestId: string;
  questions: AskUserQuestion[];
  onSubmit: (answers: AskUserAnswers) => void;
  onCancel: () => void;
}

/** Evaluate show_if condition for a question. */
function isVisible(q: AskUserQuestion, answers: AskUserAnswers): boolean {
  if (!q.show_if) return true;
  const dep = answers[q.show_if.question_id];
  if (!dep) return false;
  const depValue = 'value' in dep ? dep.value : undefined;
  if (depValue === undefined) return false;
  const expected = q.show_if.value;
  if (Array.isArray(expected)) {
    return Array.isArray(depValue)
      ? depValue.some((v: string) => expected.includes(v))
      : expected.includes(depValue);
  }
  return Array.isArray(depValue) ? depValue.includes(expected) : depValue === expected;
}

export function AskUserWizard({ sessionId, requestId, questions, onSubmit, onCancel }: Props) {
  const [answers, setAnswers] = useState<AskUserAnswers>({});
  const [currentStep, setCurrentStep] = useState(0);
  const [submitting, setSubmitting] = useState(false);

  const visibleQuestions = useMemo(
    () => questions.filter((q) => isVisible(q, answers)),
    [questions, answers],
  );

  const question = visibleQuestions[currentStep];
  const isFirst = currentStep === 0;
  const isLast = currentStep === visibleQuestions.length - 1;

  const updateAnswer = useCallback((id: string, answer: AskUserAnswer | AskUserFormAnswer) => {
    setAnswers((prev) => ({ ...prev, [id]: answer }));
  }, []);

  const handleSubmit = useCallback(async () => {
    setSubmitting(true);
    // Only include answers for visible questions
    const visibleIds = new Set(visibleQuestions.map((q) => q.id));
    const filtered: AskUserAnswers = {};
    for (const [id, ans] of Object.entries(answers)) {
      if (visibleIds.has(id)) filtered[id] = ans;
    }
    onSubmit(filtered);
  }, [answers, visibleQuestions, onSubmit]);

  const handleNext = useCallback(() => {
    if (isLast) {
      handleSubmit();
    } else {
      setCurrentStep((s) => Math.min(s, visibleQuestions.length - 1) + 1);
    }
  }, [isLast, handleSubmit, visibleQuestions.length]);

  const handleBack = useCallback(() => {
    setCurrentStep((s) => Math.max(0, s - 1));
  }, []);

  // Clamp step if visibility changed
  const clampedStep = Math.min(currentStep, visibleQuestions.length - 1);
  if (clampedStep !== currentStep) {
    setCurrentStep(clampedStep);
  }

  if (!question) return null;

  return (
    <div className="ask-user-overlay">
      <div className="ask-user-card">
        {/* Header */}
        <div className="ask-user-header">
          <div className="ask-user-step-info">
            Question {currentStep + 1} of {visibleQuestions.length}
          </div>
          <div className="ask-user-progress">
            {visibleQuestions.map((_, i) => (
              <div
                key={i}
                className={`ask-user-dot ${i === currentStep ? 'active' : i < currentStep ? 'done' : ''}`}
              />
            ))}
          </div>
        </div>

        {/* Question content */}
        <div className="ask-user-body">
          <div className="ask-user-question-title">{question.display_text}</div>
          {question.description && (
            <div className="ask-user-question-desc">{question.description}</div>
          )}

          {question.type === 'single_choice' && (
            <SingleChoiceStep
              question={question}
              answer={answers[question.id] as AskUserAnswer | undefined}
              onChange={(a) => updateAnswer(question.id, a)}
            />
          )}
          {question.type === 'multiple_choice' && (
            <MultipleChoiceStep
              question={question}
              answer={answers[question.id] as AskUserAnswer | undefined}
              onChange={(a) => updateAnswer(question.id, a)}
            />
          )}
          {question.type === 'form' && (
            <FormStep
              question={question}
              answer={answers[question.id] as AskUserFormAnswer | undefined}
              onChange={(a) => updateAnswer(question.id, a)}
            />
          )}
        </div>

        {/* Navigation */}
        <div className="ask-user-nav">
          <button className="ask-user-btn cancel" onClick={onCancel} disabled={submitting}>
            Cancel
          </button>
          <div className="ask-user-nav-right">
            {!isFirst && (
              <button className="ask-user-btn secondary" onClick={handleBack} disabled={submitting}>
                Back
              </button>
            )}
            <button
              className="ask-user-btn primary"
              onClick={handleNext}
              disabled={submitting}
            >
              {submitting ? 'Submitting...' : isLast ? 'Submit' : 'Next'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ───────── Single Choice ───────── */

function SingleChoiceStep({
  question,
  answer,
  onChange,
}: {
  question: AskUserQuestion;
  answer?: AskUserAnswer;
  onChange: (a: AskUserAnswer) => void;
}) {
  const [showFreeText, setShowFreeText] = useState(false);

  return (
    <div className="ask-user-options">
      {question.options?.map((opt) => (
        <label key={opt.value} className={`ask-user-option ${answer?.value === opt.value && !answer?.free_text_override ? 'selected' : ''}`}>
          <input
            type="radio"
            name={question.id}
            checked={answer?.value === opt.value && !answer?.free_text_override}
            onChange={() => onChange({ value: opt.value, discuss_further: answer?.discuss_further })}
          />
          <div className="ask-user-option-content">
            <div className="ask-user-option-label">{opt.display_text}</div>
            {opt.description && <div className="ask-user-option-desc">{opt.description}</div>}
          </div>
        </label>
      ))}

      <FreeTextOverride
        show={showFreeText}
        onToggle={() => setShowFreeText(!showFreeText)}
        value={answer?.free_text_override || ''}
        onChange={(text) =>
          onChange({ value: answer?.value, free_text_override: text || undefined, discuss_further: answer?.discuss_further })
        }
      />
      <DiscussFurther
        checked={answer?.discuss_further || false}
        onChange={(checked) => onChange({ ...answer, value: answer?.value, discuss_further: checked })}
      />
    </div>
  );
}

/* ───────── Multiple Choice ───────── */

function MultipleChoiceStep({
  question,
  answer,
  onChange,
}: {
  question: AskUserQuestion;
  answer?: AskUserAnswer;
  onChange: (a: AskUserAnswer) => void;
}) {
  const [showFreeText, setShowFreeText] = useState(false);
  const selected: string[] = Array.isArray(answer?.value) ? answer.value : [];

  const toggle = (val: string) => {
    const next = selected.includes(val) ? selected.filter((v) => v !== val) : [...selected, val];
    onChange({ value: next, free_text_override: answer?.free_text_override, discuss_further: answer?.discuss_further });
  };

  return (
    <div className="ask-user-options">
      {question.options?.map((opt) => (
        <label key={opt.value} className={`ask-user-option ${selected.includes(opt.value) ? 'selected' : ''}`}>
          <input
            type="checkbox"
            checked={selected.includes(opt.value)}
            onChange={() => toggle(opt.value)}
          />
          <div className="ask-user-option-content">
            <div className="ask-user-option-label">{opt.display_text}</div>
            {opt.description && <div className="ask-user-option-desc">{opt.description}</div>}
          </div>
        </label>
      ))}

      <FreeTextOverride
        show={showFreeText}
        onToggle={() => setShowFreeText(!showFreeText)}
        value={answer?.free_text_override || ''}
        onChange={(text) => onChange({ value: selected, free_text_override: text || undefined, discuss_further: answer?.discuss_further })}
      />
      <DiscussFurther
        checked={answer?.discuss_further || false}
        onChange={(checked) => onChange({ value: selected, free_text_override: answer?.free_text_override, discuss_further: checked })}
      />
    </div>
  );
}

/* ───────── Form ───────── */

function FormStep({
  question,
  answer,
  onChange,
}: {
  question: AskUserQuestion;
  answer?: AskUserFormAnswer;
  onChange: (a: AskUserFormAnswer) => void;
}) {
  const fields = answer?.fields || {};

  const setField = (name: string, value: string) => {
    onChange({ fields: { ...fields, [name]: value }, discuss_further: answer?.discuss_further });
  };

  // Initialize defaults on first render
  React.useEffect(() => {
    if (!answer && question.fields) {
      const defaults: Record<string, string> = {};
      let hasDefaults = false;
      for (const f of question.fields) {
        if (f.default_value !== undefined) {
          defaults[f.name] = f.default_value;
          hasDefaults = true;
        }
      }
      if (hasDefaults) onChange({ fields: defaults });
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="ask-user-form">
      {question.fields?.map((field) => (
        <div key={field.name} className="ask-user-form-field">
          <label className="ask-user-form-label">
            {field.display_text}
            {field.required && <span className="ask-user-required">*</span>}
          </label>
          {field.info_text && <div className="ask-user-form-info">{field.info_text}</div>}
          <FormInput field={field} value={fields[field.name] || ''} onChange={(v) => setField(field.name, v)} />
        </div>
      ))}
      <DiscussFurther
        checked={answer?.discuss_further || false}
        onChange={(checked) => onChange({ fields, discuss_further: checked })}
      />
    </div>
  );
}

function FormInput({
  field,
  value,
  onChange,
}: {
  field: NonNullable<AskUserQuestion['fields']>[number];
  value: string;
  onChange: (v: string) => void;
}) {
  if (field.input_type === 'select') {
    return (
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">{field.placeholder || 'Select...'}</option>
        {field.options?.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    );
  }

  if (field.input_type === 'textarea') {
    return (
      <textarea
        value={value}
        placeholder={field.placeholder}
        onChange={(e) => onChange(e.target.value)}
        rows={3}
      />
    );
  }

  if (field.input_type === 'checkbox') {
    return (
      <label className="ask-user-checkbox-field">
        <input
          type="checkbox"
          checked={value === 'true'}
          onChange={(e) => onChange(e.target.checked ? 'true' : 'false')}
        />
        <span>{field.placeholder || field.display_text}</span>
      </label>
    );
  }

  return (
    <input
      type={field.input_type}
      value={value}
      placeholder={field.placeholder}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

/* ───────── Shared sub-components ───────── */

function FreeTextOverride({
  show,
  onToggle,
  value,
  onChange,
}: {
  show: boolean;
  onToggle: () => void;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="ask-user-free-text">
      <button className="ask-user-free-text-toggle" onClick={onToggle} type="button">
        {show ? '▾' : '▸'} Answer in your own words
      </button>
      {show && (
        <textarea
          className="ask-user-free-text-input"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="Type your own answer..."
          rows={2}
        />
      )}
    </div>
  );
}

function DiscussFurther({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="ask-user-discuss">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>I'd like to discuss this further</span>
    </label>
  );
}
