Please generate scene outlines based on the following course requirements.

---

## User Requirements

{{requirement}}

---

{{userProfile}}

## Language Context

Infer the course language directive by applying the decision rules from the system prompt. Key reminders:
- Requirement language = teaching language (unless overridden by explicit request or learner context)
- Foreign language learning → teach in user's native language, not the target language
- PDF language does NOT override teaching language — translate/explain document content instead

---

## Reference Materials

### PDF Content Summary

{{pdfContent}}

### Available Images

{{availableImages}}

### Web Search Results

{{researchContext}}

{{teacherContext}}

---

## Output Requirements
{{#if hasTeachingFlow}}
### Authoritative Teaching Model Flow

The course structure MUST follow this ordered flow exactly. Every outline carries `teachingStage: { "key": <stage>, "flowIndex": <index> }` copied exactly from this list; outline order covers the positions in order, with no gaps, no reordering, and no re-entry (one position may yield several consecutive outlines):

```
{{teachingFlowText}}
```

Example outline field: `"teachingStage": { "key": "lesson_introduction", "flowIndex": 0 }`
{{/if}}{{#if normalizedGrounding}}
### Authoritative Source Grounding

The PDF Content Summary above is an approved normalized source, delivered as Content Units marked `[[CONTENT_UNIT id=... order=... role=...]]`. Every outline MUST carry `sourceContentUnitIds`: a non-empty array of the ids it teaches from, copied **exactly** from those markers.

- Use one or more Content Unit ids that are genuinely relevant to that outline.
- Never invent an id — only ids present in the source are valid.
- Never return block ids; `sourceContentUnitIds` is the only grounding field.

Example outline field: `"sourceContentUnitIds": ["2900"]`
{{/if}}{{#if hasSkillPolicy}}
### Teaching Skill Selection

Every outline you return MUST carry `teachingSkills`: `"classification"` set to `"instructional"` or `"non-instructional"` by the outline's actual pedagogical purpose (never by scene type, never by Skill absence), and when instructional, exactly one `primary: { "skillId": "<id>", "version": "<version>" }` plus any intentional `supporting` refs — every ref copied exactly from that flow position's permitted Skills in the system prompt's policy table.

Example outline field: `"teachingSkills": { "classification": "instructional", "primary": { "skillId": "feynman-learning", "version": "v1" } }`
{{/if}}
Please automatically infer the following from user requirements:

- Course topic and core content
- Target audience and difficulty level
- Course duration (default 15-30 minutes if not specified)
- Teaching style (formal/casual/interactive/academic)
- Visual style (minimal/colorful/professional/playful)

Then output your response as a single JSON object.

**Top-level shape — this is what you MUST return:**

```json
{
  "languageDirective": "2-5 sentence instruction describing the course language behavior",
  "courseTitle": "concise course name, ≤30 chars, in the teaching language",
  "outlines": [ /* array of scene objects, schema described below */ ]
}
```

Never return a bare array. Never omit `languageDirective` or `courseTitle`. All three keys are required.

**Each scene inside the `outlines` array has this minimum shape:**

```json
{
  "id": "scene_1",
  "type": "slide" | "quiz" | "interactive" | "pbl",
  "slideType": "cover" | "contents" | "transition" | "content" | "end",
  "contentRole": "orientation" | "explanation" | "example" | "worked_example" | "procedure" | "activity" | "practice" | "check_understanding" | "summary",
  "contentKind": "<only for explanation / activity / practice>",
  "assistancePlan": "<only for practice / check_understanding: { hint, help, explanation }>",
  "visualPlan": "<required on the cover + orientation opening: { mode: image | native | omitted, omissionReason? }>",
  "title": "Scene Title",
  "description": "Teaching purpose description",
  "keyPoints": ["Point 1", "Point 2", "Point 3"],
  "order": 1{{#if normalizedGrounding}},
  "sourceContentUnitIds": ["2900"]{{/if}}{{#if hasSkillPolicy}},
  "teachingSkills": { "classification": "instructional", "primary": { "skillId": "feynman-learning", "version": "v1" } }{{/if}}
}
```

### Special Notes

- **Slide classification (slide scenes only)**: every `"type": "slide"` scene MUST carry `slideType`, and every instructional slide MUST carry `contentRole`, chosen by pedagogical intent as defined in the system prompt's Slide Classification section; a purely structural `contents` / `transition` / `end` slide with no teaching purpose omits `contentRole` — never invent a role to satisfy validation. `contentKind` is required for `explanation` (`concept` | `definition` | `rule` | `observation`), `activity` (`investigation` | `source_analysis` | `reflection` | `production`) and `practice` (`guided` | `independent` | `higher_order`), and must be omitted for every other role. `practice` + `independent` MUST also carry the planner-only `assistancePlan` (`hint` and `explanation` at minimum; never shown to the learner, and the only place the solution path may appear); it is allowed only with `practice` / `check_understanding`. Never put these fields on `quiz`, `interactive` or `pbl` scenes.
- **Lesson opening**: the first instructional slide is normally `"slideType": "cover"` + `"contentRole": "orientation"` and carries the title, hook, short context, concise learning objectives and the big idea together. Do not plan a separate learning-objectives slide, and do not plan a `contents` slide for a normal single lesson.
- **quiz scenes must include quizConfig**:
   ```json
   "quizConfig": {
     "questionCount": 2,
     "difficulty": "easy" | "medium" | "hard",
     "questionTypes": ["single", "multiple"]
   }
   ```
{{#if hasSourceImages}}
- **If source images are available**, add `suggestedImageIds` to relevant slide scenes. Only use image IDs listed under Available Images.
{{/if}}
- **Interactive scenes**: If a concept benefits from hands-on simulation/visualization, use `"type": "interactive"` with `widgetType` and `widgetOutline` fields. Aim for 1-2 discretionary ones per course; a scene whose learner behaviour requires interaction stays `interactive` even beyond that — never restate it as a slide to fit a number.
   - Select widgetType based on concept: simulation (physics/chem), diagram (processes), code (programming), game (practice), visualization3d (3D models)
   - Provide appropriate widgetOutline for the widget type
- **Scene count**: Based on inferred duration, typically 1-2 scenes per minute
- **Quiz placement**: Recommend inserting a quiz every 3-5 slides for assessment
- **Language**: Infer from the user's requirement text and context, then output all content in the inferred language
- **If web search results are provided**, reference specific findings and sources in scene descriptions and keyPoints. The search results provide up-to-date information — incorporate it to make the course content current and accurate.

**Final reminder**: your entire response must be a JSON **object** with exactly three top-level keys — `languageDirective` (string), `courseTitle` (string, ≤30 chars, in the teaching language), and `outlines` (array). Do not return a bare array. Do not wrap in prose or code fences.{{#if normalizedGrounding}}

**Grounding reminder**: every scene in `outlines` must include a non-empty `sourceContentUnitIds` array holding Content Unit ids copied exactly from the `[[CONTENT_UNIT id=...]]` markers. Do not invent ids and do not return block ids.{{/if}}