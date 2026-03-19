export interface AskUserQuestion {
  id: string;
  display_text: string;
  description?: string;
  type: 'single_choice' | 'multiple_choice' | 'form';
  options?: Array<{
    value: string;
    display_text: string;
    description?: string;
  }>;
  fields?: Array<{
    name: string;
    display_text: string;
    input_type: string;
    placeholder?: string;
    info_text?: string;
    default_value?: string;
    options?: Array<{ value: string; label: string }>;
    required?: boolean;
  }>;
  show_if?: { question_id: string; value: string | string[] };
}

export interface AskUserAnswer {
  value: any;
  free_text_override?: string;
  discuss_further?: boolean;
}

export interface AskUserFormAnswer {
  fields: Record<string, string>;
  discuss_further?: boolean;
}

export type AskUserAnswers = Record<string, AskUserAnswer | AskUserFormAnswer>;
