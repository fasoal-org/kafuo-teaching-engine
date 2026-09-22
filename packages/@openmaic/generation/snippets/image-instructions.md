### AI-Generated Image Requests

Use image generation only for slide scenes that need a static visual and have no suitable source image.

- Prefer `suggestedImageIds` when a suitable source/PDF image exists
- Add a `mediaGenerations` entry only when a generated image genuinely enhances the content. **Every visual must have a pedagogical job** — clarify a relationship, show a structure, ground an observation, frame the lesson opening, or synthesise ideas. Decorative filler is prohibited
- Use `type: "image"`
- Each image request specifies: `prompt` (description for the generation model), `elementId` (unique placeholder), and optionally `aspectRatio` (default "16:9") and `style`
- **Image IDs**: use `"gen_img_1"`, `"gen_img_2"`, etc. IDs are globally unique across the entire course, not reset per scene
- The prompt should describe the desired image clearly and specifically
- **Text inside images**: {{imageTextPolicy}}
- **Avoid duplicate images across slides**: Each generated image must be visually distinct. Do not request near-identical images for different slides. If multiple slides cover the same topic, vary the visual angle, scope, or style
- **Cross-scene reuse**: To reuse a generated image in a different scene, reference the same `elementId` in the later scene's content without adding a new `mediaGenerations` entry. Only the scene that first defines the `elementId` in its `mediaGenerations` should include the generation request
- Use generated images for static content: diagrams, charts, illustrations, portraits, landscapes

Image example:

```json
"mediaGenerations": [
  {
    "type": "image",
    "prompt": "A colorful diagram showing the water cycle with evaporation, condensation, and precipitation arrows",
    "elementId": "gen_img_1",
    "aspectRatio": "16:9"
  }
]
```
