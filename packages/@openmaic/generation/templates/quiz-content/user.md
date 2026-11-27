Title: {{title}}
Description: {{description}}
Test Points: {{keyPoints}}
Question Count: {{questionCount}}, Difficulty: {{difficulty}}, Question Types: {{questionTypes}}{{#if hasSourceContext}}

## Approved textbook source these questions test

{{sourceContextText}}

Write every question and every option from this text only, with its numbers, values and units exactly as printed. The correct option is the approved answer when one is given for the item below; otherwise it must be stated in this text or follow directly from it. Never test anything this text does not contain, and never invent a value, an example or a fact.{{/if}}

## Language Directive
{{languageDirective}}

Output a JSON array directly (no explanation, no code blocks, no LaTeX). Use the exact object shape from the system prompt — `options` as `{ "label", "value" }` objects with single-letter values (A, B, C, ...) and `answer` as an array of the correct option VALUES:
[{"id":"q1","type":"single","question":"Question text","options":[{"label":"Option A content","value":"A"},{"label":"Option B content","value":"B"},{"label":"Option C content","value":"C"},{"label":"Option D content","value":"D"}],"answer":["A"]}]{{#if hasSacredTextPolicy}}

## Protected quotes (copy exactly, never explain) / النصوص المحمية (تُنقل حرفيًا ولا تُشرح)

{{sacredQuotesText}}{{/if}}
