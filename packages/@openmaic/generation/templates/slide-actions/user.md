## VISIBLE SLIDE — what the learner sees
Elements: {{elements}}
Title: {{title}}
Key Points: {{keyPoints}}

## PLANNING GUIDANCE — for your understanding only; never read it out or quote it
Planner's note: {{description}}
{{#if hasRoleGuidance}}

### What this slide is for

{{roleGuidance}}
{{/if}}{{#if hasSourceContext}}

### Approved textbook source this slide teaches

{{sourceContextText}}

Explain the slide from this source: the definitions, reasoning and worked-example steps the slide covers must be spoken accurately and in full, in natural speech. Do not read the source out word for word, never mention "source sections", and do not go beyond this slide's key points.
{{/if}}
{{courseContext}}
{{agents}}
{{userProfile}}

**Language Directive**: {{languageDirective}}

Output as a JSON array directly (no explanation, no code fences; typically 5-10 segments — as many as the slide genuinely needs):
[{"type":"action","name":"spotlight","params":{"elementId":"text_xxx"}},{"type":"text","content":"Opening speech content"}]
