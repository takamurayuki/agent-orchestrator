/** UI-local answer state for one question card (before it is sent via draft.answer). */
export interface QuestionDraftAnswer {
  /** Selected option value or free text. */
  value: string;
  skipped: boolean;
}
