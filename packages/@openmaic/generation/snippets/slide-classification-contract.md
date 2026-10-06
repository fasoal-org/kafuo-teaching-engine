## Slide Classification (MANDATORY for every `slide` scene)

Every scene with `"type": "slide"` MUST be explicitly classified with structured fields: every slide carries `slideType`, and every **instructional** slide MUST carry `contentRole`. A purely structural `contents` / `transition` / `end` slide with no teaching purpose omits `contentRole` (and `contentKind`) — never invent a role to satisfy validation. Four concepts are involved — keep them apart, never merge or substitute one for another:

| Field         | Answers                                                              | Values                                                                                                                         |
| ------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `type`        | Which scene kind delivers this learning experience                   | `slide`, `quiz`, `interactive`, `pbl`                                                                                          |
| `slideType`   | The slide's structural place in the deck (becomes `Slide.type`)      | `cover`, `contents`, `transition`, `content`, `end`                                                                            |
| `contentRole` | The pedagogical purpose — WHY this slide exists in the lesson        | `orientation`, `explanation`, `example`, `worked_example`, `procedure`, `activity`, `practice`, `check_understanding`, `summary` |
| `contentKind` | An OPTIONAL specialization of that purpose (three roles only)        | see the role table                                                                                                             |

Only the values listed here are valid. Never invent a value, and never copy a Teaching Model stage name, a source role/subtype label, or a layout name into these fields.

### Step 1 — choose the scene `type` first

Decide by the learner experience the purpose requires, not by the purpose's name:

- Learner answers must be **captured and checked**, graded, or retried → `quiz`.
- The learner must **manipulate, simulate, drag/drop, keep state, or otherwise interact** with something → `interactive`.
- The experience is **multi-step project work**, progresses through stages, or runs in a project or roleplay runtime → `pbl`.
- Otherwise → `slide`.

For an `activity`, `practice` or `check_understanding` purpose, decide the scene type FIRST: if the learner must manipulate, keep state, drag/drop, submit, be graded, retry, progress through stages, or work in a project or roleplay runtime, this is NOT a slide. A practice slide is a static task the learner works on their own; a game — scoring, levels, moves, win/lose state — is an `interactive` scene with a game widget, never a slide and never a `contentRole`, `contentKind` or `slideType` value.

A scene that needs a runtime KEEPS that runtime. Never restate a quiz, interactive or pbl experience as a slide because of a scene budget, a missing configuration, or an unavailable feature.
{{#if hasUnavailableRuntimes}}
Runtime availability for THIS course: {{unavailableRuntimesText}} scenes cannot be delivered. Do not plan a lesson that depends on them — choose learning experiences that the available scene types genuinely fit. Never disguise an unavailable runtime experience as a slide.
{{/if}}{{#if hasProhibitedWidgetTypes}}
Widget availability for THIS course: {{prohibitedWidgetTypesText}} interactive widgets cannot be generated. Never plan an interactive scene that uses one, and never restate that experience as a quiz, a slide or another widget to keep it in the lesson — leave it out and plan only what each flow position requires.
{{/if}}
`slideType`, `contentRole` and `contentKind` belong ONLY on `slide` scenes — never put them on `quiz`, `interactive` or `pbl` scenes. Do not force a purpose into a slide: a comprehension check that needs answers validated is a `quiz`, not a slide. `check_understanding` is a slide only when the check needs no answer capture (e.g. a question to think about or discuss).

### Step 2 — choose `contentRole` (and `contentKind`) by pedagogical intent

| `contentRole`         | The slide's purpose                                                                              | `contentKind`                                                                                                                                                                                                                                        |
| --------------------- | ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `orientation`         | Opens the learning: hook, context, relevance, prior knowledge, learning objectives, the big idea | — (none)                                                                                                                                                                                                                                             |
| `explanation`         | Presents new knowledge                                                                           | Optional: `concept` (an idea or phenomenon — what it is, how or why it works) · `definition` (the precise meaning of a term) · `rule` (a law, formula, principle or convention to be applied) · `observation` (evidence, data or facts to notice) |
| `example`             | A short concrete instance that illustrates knowledge already presented                           | — (none)                                                                                                                                                                                                                                             |
| `worked_example`      | One complete problem solved from start to finish with the reasoning shown                        | — (none)                                                                                                                                                                                                                                             |
| `procedure`           | The reusable steps of a method or process the learner will follow                                | — (none)                                                                                                                                                                                                                                             |
| `activity`            | A learner task that BUILDS understanding by doing                                                | Optional: `investigation` (explore, experiment, inquire, collect) · `source_analysis` (examine a text, image, map, dataset or artefact) · `reflection` (think about one's own learning, views or experience) · `production` (create an output)   |
| `practice`            | Exercises that APPLY what was already taught                                                     | Optional: `guided` (with scaffolds, hints or shared steps) · `independent` (the learner works alone) · `higher_order` (analysis, evaluation, transfer, non-routine problems)                                                                     |
| `check_understanding` | A formative check of comprehension that needs no answer capture                                  | — (none)                                                                                                                                                                                                                                             |
| `summary`             | Consolidates what was learned                                                                    | — (none)                                                                                                                                                                                                                                             |

Pairing rules:

- `contentRole` is the classification that matters: it is REQUIRED on every instructional slide and must describe what the slide is for.
- `contentKind` is OPTIONAL. For `explanation`, `activity` and `practice`, add one only when a kind from that role's OWN row clearly fits; otherwise omit it — the role alone is a complete classification.
- Every other role MUST NOT carry `contentKind` at all — omit the field. A kind never comes from another row or from the role list: `explanation` + `procedure` is invalid (`procedure` is a role), as are `example` + `concept`, `summary` + `guided`, `procedure` + `observation`. A kind that does not belong to the slide's role is discarded and the role is kept.
- A slide with no `contentRole` (structural-only) MUST NOT carry `contentKind`.

Assistance plan — `assistancePlan` (planner-only, never shown to the learner):

- `assistancePlan` is an object `{ "hint": "...", "help": "...", "explanation": "..." }` planning the on-demand support for a learner task: `hint` = what a nudge should point toward without revealing the method, `help` = the approach or partial structure to offer, `explanation` = the full solution path and reasoning.
- `practice` + `independent` MUST carry `assistancePlan` with at least `hint` and `explanation`. The solution path goes ONLY there: the slide's `description` and `keyPoints` carry the task alone, never how to solve it.
- `practice` + `higher_order` and `check_understanding` MAY carry `assistancePlan`. `practice` + `guided` normally omits it — its scaffolding is learner-visible and belongs in `keyPoints`.
- Every other role, every structural slide, and every `quiz` / `interactive` / `pbl` scene MUST NOT carry `assistancePlan`.

Telling close roles apart:

- `example` vs `worked_example`: a brief illustration vs a complete, reasoned solution.
- `worked_example` vs `procedure`: one specific problem solved vs the general steps to reuse on any problem.
- `activity` vs `practice`: building new understanding by doing vs applying what was already taught.

Classify by what the slide is FOR. Never classify from the visual layout, the wording of the title, the Teaching Model stage name, the source's role or subtype label, or the number of key points. Those may inform your judgement; they are never the classification.

### Step 3 — choose `slideType` by the slide's structural role

- `content` — the default. Nearly every teaching slide is `content`, whatever its `contentRole`.
- `cover` — the lesson's opening slide. At most one per lesson.
- `contents` — an agenda / table of contents. Do **NOT** generate one for a normal single lesson. Use it only when the user explicitly asks for an agenda, or for a long multi-part course whose learners need a map.
- `transition` — a genuine pedagogical transition between MAJOR lesson sections or learning objectives. Never insert one between ordinary scenes; most lessons need none. Give it a `contentRole` only when it genuinely teaches; a purely structural transition omits `contentRole`.
- `end` — the genuine closing slide of the lesson. At most one per lesson. A summary slide is `content` unless it is itself the lesson's closing slide — never choose `end` merely because the `contentRole` is `summary`.

### Step 4 — give each slide what its role needs (`description` / `keyPoints`)

The slide generator sees ONLY this outline. `keyPoints` is the learner-visible teaching content the slide is built from; `description` is a planner's note (never shown) stating the slide's teaching purpose. Plan enough substance for the role — never a bare topic label:

- `orientation`: the hook or framing question, short context, the concise learning objectives, the big idea — and plan one useful supporting visual whenever source images or media generation are available to this course, unless none would genuinely help.
- `explanation`: the one concept / term / rule / observation, the substance of its explanation, supporting ideas, and the takeaway; for `rule` the conditions and exceptions that matter; for `observation` the evidence or visual being observed.
- `example`: the concrete case, the approach, the reasoning, and the link to the concept or rule.
- `worked_example`: the FULL problem and EVERY meaningful solution step (what is done and why), the final result, and the takeaway.
- `procedure`: the goal, required prerequisites/materials, every ordered step, important warnings, the expected result.
- `activity`: `investigation` — question, actions, what to observe/record, how to interpret (not the finding); `source_analysis` — the source and the analysis prompts (not the analysis); `reflection` — one focus and 1–3 open prompts; `production` — the output, purpose, requirements and success criteria (not the finished work).
- `activity` with no kind: what the learner does, the focus or material, the guiding actions or prompts, and what to notice or produce (never the finding).
- `practice` with no kind: the task and only the scaffolding it genuinely needs; never the solution.
- `practice` + `guided`: the task AND its visible scaffolding (hints, partial structure, shared first steps).
- `practice` + `independent`: the task ONLY. The hint / approach / solution go in `assistancePlan` and must not appear in `description` or `keyPoints`.
- `practice` + `higher_order`: a task needing analysis, transfer, evaluation or justification, with an explicit "explain your reasoning" demand; never the conclusion.
- `check_understanding`: one focused question (or a small same-concept set); never the answer.
- `summary`: the 3–5 key ideas already taught, their relationships, the overall takeaway — no new concept.

When a worked example, procedure or concept cannot fit readably on one slide, plan CONSECUTIVE slides with the same `contentRole` (and `contentKind`) that continue it coherently — never an overcrowded or abbreviated slide.

### The lesson opening

The first instructional slide of a lesson is normally `"type": "slide"`, `"slideType": "cover"`, `"contentRole": "orientation"`. Plan this ONE slide to carry the whole opening, and say so in its `description` and `keyPoints`:

- the lesson title
- a hook or framing question
- a short introduction / context
- concise learning objectives
- one pedagogically useful supporting visual — tied to the hook, the context or the big idea, never decoration
- the big idea / key framing message

The opening's visual is REQUIRED planning, recorded in `visualPlan` (planner-only, never shown to the learner) on this slide:

- `{ "mode": "image" }` — an available source image or a generated image carries the visual;
- `{ "mode": "native" }` — the visual is composed from native slide elements (a diagram, chart, or illustrative shape group), e.g. when no image is available;
- `{ "mode": "omitted", "omissionReason": "…" }` — ONLY when no visual would genuinely improve understanding, framing or engagement for this lesson; the reason must say why, specifically. A missing or boilerplate reason invalidates the response.

Do **NOT** plan a separate learning-objectives slide: the objectives live on the orientation slide. Plan a separate one only when the user requirement{{#if hasTeachingFlow}} or a Teaching Model Flow position's instructions{{/if}} explicitly demands it — and it is then still `"contentRole": "orientation"`.
{{#if hasTeachingFlow}}
The Teaching Model Flow decides which positions exist and their order; classification never changes that. Classify each outline by what it does for the learner inside its flow position — a stage key is context, never a value of `slideType`, `contentRole` or `contentKind`.
{{/if}}{{#if hasLegacyFlowVisualRule}}
For every outline at Teaching Model Flow stage `outcome_visual_explanations`, the visual is mandatory and textbook-grounded:

- use `visualPlan: { "mode": "image" }` and select a relevant Available Image in `suggestedImageIds` when the textbook supplies one for the same Content Unit;
- otherwise use `visualPlan: { "mode": "native" }` so the canvas builds a diagram only from that outline's authoritative source facts, relationships and sequence;
- never add an AI image request to `mediaGenerations` for this stage, and never use decorative filler as its visual.
{{/if}}{{#if hasScenePolicies}}
A flow position that lists a `policy` constrains every outline at that position, and its `contentRole` list is the complete set of purposes allowed there: choose, for each slide, the listed role that matches what the slide does for the learner (an explanation, the steps of a procedure, a worked example, a short example, a learner activity) — never force a different purpose into one role, and never pick a role the position does not list.

For every outline at a position whose policy says `visual: textbook-grounded`, the visual is mandatory and textbook-grounded, whatever its `contentRole`:

- use `visualPlan: { "mode": "image" }` and select a relevant Available Image in `suggestedImageIds` when the textbook supplies one for the same Content Unit;
- otherwise use `visualPlan: { "mode": "native" }` so the canvas builds a diagram only from that outline's authoritative source facts, relationships and sequence;
- never add an AI image request to `mediaGenerations` at such a position, and never use decorative filler as its visual.
{{/if}}
