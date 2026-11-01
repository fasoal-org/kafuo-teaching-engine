'use client';

/**
 * W6 one question source: a quiz Scene marked `questionSource: 'bank'` shows
 * the objective's approved Kafuo question-bank questions, one per slide, and
 * grades them through Kafuo (`/api/stages/:id/bank-quiz`). Before approval it
 * says the questions are prepared after approval; a Scene Kafuo does not treat
 * as a bank position (`not_bank`) falls back to the Scene's own questions.
 * Answers are kept in the view only; nothing is graded locally.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock,
  Loader2,
  PieChart,
  RotateCcw,
  XCircle,
} from 'lucide-react';

import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/hooks/use-i18n';
import { createLogger } from '@/lib/logger';
import type { QuizQuestion } from '@/lib/types/stage';
import {
  bankAnswersPayload,
  fetchBankQuestions,
  isBankAnswerComplete,
  submitBankAnswers,
  type BankAnswer,
  type BankGradeResult,
  type BankGradesResponse,
  type BankQuestion,
} from '@/lib/quiz/bank-quiz';
import { QuizMathText, QuizView } from './quiz-view';

const log = createLogger('BankQuizView');

interface BankQuizViewProps {
  /** The Scene's own questions: shown only when Kafuo answers `not_bank`. */
  readonly questions: QuizQuestion[];
  readonly sceneId: string;
  readonly stageId: string;
}

type LoadState =
  | { kind: 'loading' }
  | { kind: 'error' }
  | { kind: 'pending' }
  | { kind: 'not_bank' }
  | { kind: 'ready'; questions: BankQuestion[] };

type Phase = 'answering' | 'grading' | 'grade_error' | 'reviewing';

function typeLabelKey(type: BankQuestion['questionType']): string {
  switch (type) {
    case 'single_choice':
      return 'quiz.singleChoice';
    case 'true_false':
      return 'quiz.trueFalse';
    case 'multiple_answer':
      return 'quiz.multipleChoice';
    default:
      return 'quiz.shortAnswer';
  }
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-4 bg-gray-50 px-6 text-center dark:bg-gray-900">
      {children}
    </div>
  );
}

function BankQuestionSlide({
  question,
  answer,
  onAnswer,
  result,
}: {
  question: BankQuestion;
  answer: BankAnswer | undefined;
  onAnswer: (value: BankAnswer) => void;
  result?: BankGradeResult;
}) {
  const { t } = useI18n();
  const review = result !== undefined;
  const correctSet = new Set(result?.correctAnswer ?? []);
  const selected = Array.isArray(answer) ? answer : typeof answer === 'string' ? [answer] : [];
  const multiple = question.questionType === 'multiple_answer';

  const choose = (choiceId: string) => {
    if (review) return;
    if (!multiple) return onAnswer(choiceId);
    onAnswer(
      selected.includes(choiceId)
        ? selected.filter((id) => id !== choiceId)
        : [...selected, choiceId],
    );
  };

  return (
    <div
      className={cn(
        'rounded-2xl border bg-white p-5 shadow-sm dark:bg-gray-800',
        !review && 'border-gray-200 dark:border-gray-700',
        review && result.status === 'correct' && 'border-emerald-300 dark:border-emerald-800',
        review && result.status !== 'correct' && 'border-red-300 dark:border-red-800',
      )}
    >
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="text-sm font-medium leading-relaxed text-gray-800 dark:text-gray-100">
          <QuizMathText text={question.text} allowDisplayMode />
          <p className="mt-0.5 text-xs text-gray-400">
            {t(typeLabelKey(question.questionType))} · {question.points} {t('quiz.pointsSuffix')}
          </p>
        </div>
        {review &&
          (result.status === 'correct' ? (
            <CheckCircle2 className="h-6 w-6 shrink-0 text-emerald-500" />
          ) : (
            <XCircle className="h-6 w-6 shrink-0 text-red-400" />
          ))}
      </div>

      {question.assets.map((asset) => (
        <img
          key={asset.url}
          src={asset.url}
          alt={asset.alt ?? ''}
          className="mb-3 max-h-48 rounded-lg object-contain"
        />
      ))}

      {question.questionType === 'short_answer' ? (
        <textarea
          value={typeof answer === 'string' ? answer : ''}
          onChange={(event) => onAnswer(event.target.value)}
          disabled={review}
          placeholder={t('quiz.inputPlaceholder')}
          aria-label={question.text}
          className="min-h-[100px] w-full resize-none rounded-xl border border-gray-200 p-3 text-sm focus:border-violet-300 focus:outline-none disabled:bg-gray-50 dark:border-gray-600 dark:bg-gray-800/50 dark:text-gray-200"
        />
      ) : (
        <div className="grid gap-2" role={multiple ? 'group' : 'radiogroup'}>
          {multiple && !review && (
            <p className="text-xs text-gray-400 dark:text-gray-500">
              {t('quiz.multipleChoiceHint')}
            </p>
          )}
          {question.choices.map((choice) => {
            const isSelected = selected.includes(choice.id);
            const isCorrect = review && correctSet.has(choice.id);
            const isWrong = review && isSelected && !isCorrect;
            return (
              <button
                key={choice.id}
                type="button"
                role={multiple ? 'checkbox' : 'radio'}
                aria-checked={isSelected}
                disabled={review}
                onClick={() => choose(choice.id)}
                className={cn(
                  'flex items-center gap-3 rounded-xl border px-4 py-3 text-start text-sm transition-all',
                  !review &&
                    !isSelected &&
                    'border-gray-200 hover:border-violet-200 dark:border-gray-600',
                  !review &&
                    isSelected &&
                    'border-violet-400 bg-violet-50 ring-1 ring-violet-200 dark:bg-violet-900/30',
                  isCorrect && 'border-emerald-400 bg-emerald-50 dark:bg-emerald-900/30',
                  isWrong && 'border-red-300 bg-red-50 dark:bg-red-900/30',
                )}
              >
                <span
                  className={cn(
                    'flex h-6 w-6 shrink-0 items-center justify-center border text-xs',
                    multiple ? 'rounded-md' : 'rounded-full',
                    isSelected
                      ? 'border-violet-500 bg-violet-500 text-white'
                      : 'border-gray-300 dark:border-gray-500',
                  )}
                >
                  {isSelected ? '✓' : ''}
                </span>
                <span className="flex-1">
                  <QuizMathText text={choice.text} />
                </span>
              </button>
            );
          })}
        </div>
      )}

      {review && (
        <div className="mt-3 space-y-2 text-xs">
          <p className="font-semibold text-gray-600 dark:text-gray-300">
            {result.earned}/{result.possible} {t('quiz.pointsSuffix')}
          </p>
          {result.explanation && (
            <div className="rounded-lg border border-blue-100 bg-blue-50/70 p-3 text-blue-700 dark:border-blue-800 dark:bg-blue-900/30 dark:text-blue-300">
              <span className="font-medium">{t('quiz.analysis')}</span>
              <QuizMathText text={result.explanation} allowDisplayMode />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function BankQuizView({ questions: sceneQuestions, sceneId, stageId }: BankQuizViewProps) {
  const { t } = useI18n();
  const [load, setLoad] = useState<LoadState>({ kind: 'loading' });
  const [reloadVersion, setReloadVersion] = useState(0);
  const [index, setIndex] = useState(0);
  const [answers, setAnswers] = useState<Record<string, BankAnswer>>({});
  const [phase, setPhase] = useState<Phase>('answering');
  const [grades, setGrades] = useState<BankGradesResponse | null>(null);

  useEffect(() => {
    // Starts as `loading` (the view is keyed by Scene); a retry sets it first.
    let cancelled = false;
    void fetchBankQuestions(stageId, sceneId)
      .then((response) => {
        if (cancelled) return;
        // A marked bank Scene has no questions of its own, so `not_bank` here means Kafuo
        // could not resolve it: show the retry rather than an empty quiz (W6 review).
        if (response.status === 'not_bank') {
          return setLoad(sceneQuestions.length > 0 ? { kind: 'not_bank' } : { kind: 'error' });
        }
        if (response.status === 'pending_approval' || response.questions.length === 0) {
          return setLoad({ kind: 'pending' });
        }
        setLoad({ kind: 'ready', questions: response.questions });
      })
      .catch((error) => {
        log.warn('Failed to load bank quiz questions:', error);
        if (!cancelled) setLoad({ kind: 'error' });
      });
    return () => {
      cancelled = true;
    };
  }, [reloadVersion, sceneId, stageId, sceneQuestions.length]);

  const bankQuestions = useMemo(() => (load.kind === 'ready' ? load.questions : []), [load]);
  const allAnswered = bankQuestions.every((question) =>
    isBankAnswerComplete(question, answers[question.id]),
  );
  const resultById = useMemo(
    () => new Map((grades?.results ?? []).map((result) => [result.questionId, result])),
    [grades],
  );

  const submit = useCallback(async () => {
    setPhase('grading');
    try {
      const graded = await submitBankAnswers(
        stageId,
        sceneId,
        bankAnswersPayload(bankQuestions, answers),
      );
      setGrades(graded);
      setIndex(0);
      setPhase('reviewing');
    } catch (error) {
      log.warn('Failed to grade bank quiz:', error);
      setPhase('grade_error');
    }
  }, [answers, bankQuestions, sceneId, stageId]);

  const restart = useCallback(() => {
    setAnswers({});
    setGrades(null);
    setIndex(0);
    setPhase('answering');
  }, []);

  if (load.kind === 'not_bank') {
    return <QuizView questions={sceneQuestions} sceneId={sceneId} stageId={stageId} />;
  }
  if (load.kind === 'loading' || phase === 'grading') {
    return (
      <Centered>
        <Loader2 className="h-6 w-6 animate-spin text-gray-400" aria-label={t('quiz.aiGrading')} />
      </Centered>
    );
  }
  if (load.kind === 'pending') {
    return (
      <Centered>
        <Clock className="h-8 w-8 text-violet-500" />
        <p className="text-base font-semibold text-gray-700 dark:text-gray-200">
          {t('quiz.bankPending')}
        </p>
      </Centered>
    );
  }
  if (load.kind === 'error' || phase === 'grade_error') {
    const gradeError = phase === 'grade_error';
    return (
      <Centered>
        <p className="text-sm text-gray-600 dark:text-gray-300">
          {gradeError ? t('quiz.gradingUnavailable') : t('quiz.bankUnavailable')}
        </p>
        <button
          type="button"
          onClick={() => {
            if (gradeError) return void submit();
            setLoad({ kind: 'loading' });
            setReloadVersion((version) => version + 1);
          }}
          className="flex items-center gap-2 rounded-lg bg-violet-600 px-4 py-2 text-sm font-medium text-white hover:bg-violet-700"
        >
          <RotateCcw className="h-4 w-4" />
          {t('quiz.retry')}
        </button>
      </Centered>
    );
  }

  const total = bankQuestions.length;
  const current = bankQuestions[Math.min(index, total - 1)]!;
  const reviewing = phase === 'reviewing';
  const last = index >= total - 1;

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-gradient-to-b from-gray-50 to-white dark:from-gray-900 dark:to-gray-900">
      <div className="flex shrink-0 items-center justify-between border-b border-gray-100 bg-white/80 px-6 py-3 dark:border-gray-700 dark:bg-gray-900/80">
        <div className="flex items-center gap-2">
          <PieChart className="h-4 w-4 text-violet-500" />
          <span className="text-sm font-semibold text-gray-700 dark:text-gray-200">
            {reviewing ? t('quiz.quizReport') : t('quiz.answering')}
          </span>
          <span className="ms-1 text-xs text-gray-400">
            {t('quiz.questionOf', { current: index + 1, total })}
          </span>
        </div>
        {reviewing && grades && (
          <div className="flex items-center gap-3">
            <span className="text-sm font-bold text-gray-700 dark:text-gray-200">
              {grades.earned} / {grades.possible}
            </span>
            <button
              type="button"
              onClick={restart}
              className="flex items-center gap-1.5 text-xs text-gray-500 hover:text-violet-600 dark:text-gray-400"
            >
              <RotateCcw className="h-3.5 w-3.5" />
              {t('quiz.retry')}
            </button>
          </div>
        )}
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-4">
        <BankQuestionSlide
          key={`${phase}:${current.id}`}
          question={current}
          answer={answers[current.id]}
          onAnswer={(value) => setAnswers((prev) => ({ ...prev, [current.id]: value }))}
          result={reviewing ? resultById.get(current.id) : undefined}
        />
      </div>

      <div className="flex shrink-0 items-center justify-between border-t border-gray-100 px-6 py-3 dark:border-gray-700">
        <button
          type="button"
          onClick={() => setIndex((value) => Math.max(0, value - 1))}
          disabled={index === 0}
          className="flex items-center gap-1 rounded-lg px-3 py-1.5 text-xs font-medium text-gray-600 disabled:opacity-40 dark:text-gray-300"
        >
          <ChevronLeft className="h-4 w-4 rtl:rotate-180" />
          {t('quiz.previous')}
        </button>
        {!last ? (
          <button
            type="button"
            onClick={() => setIndex((value) => Math.min(total - 1, value + 1))}
            className="flex items-center gap-1 rounded-lg bg-violet-500 px-4 py-1.5 text-xs font-medium text-white"
          >
            {t('quiz.next')}
            <ChevronRight className="h-4 w-4 rtl:rotate-180" />
          </button>
        ) : (
          !reviewing && (
            <button
              type="button"
              onClick={() => void submit()}
              disabled={!allAnswered}
              className={cn(
                'rounded-lg px-4 py-1.5 text-xs font-medium',
                allAnswered
                  ? 'bg-gradient-to-r from-violet-500 to-purple-500 text-white'
                  : 'cursor-not-allowed bg-gray-100 text-gray-400 dark:bg-gray-700',
              )}
            >
              {t('quiz.submitAnswers')}
            </button>
          )
        )}
      </div>
    </div>
  );
}
