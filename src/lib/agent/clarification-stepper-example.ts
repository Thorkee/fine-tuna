// Clarification payload schema + example for step-by-step cards.
// Use the example to emit a ```clarification JSON``` block in assistant responses.

export const clarificationPayloadSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  required: ["questions"],
  properties: {
    version: { type: "number" },
    title: { type: "string" },
    description: { type: "string" },
    response_format: {
      type: "string",
      description: "Optional template using {{questionId}} placeholders.",
    },
    submit_label: { type: "string" },
    layout: { type: "string", enum: ["stacked", "stepper"] },
    questions: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        required: ["id", "prompt"],
        properties: {
          id: { type: "string" },
          prompt: { type: "string" },
          help: { type: "string" },
          type: {
            type: "string",
            enum: ["multiple_choice", "text", "textarea", "number", "date", "boolean"],
            description:
              "When omitted, defaults to `multiple_choice` if `options` is provided, otherwise defaults to `text`.",
          },
          allow_multiple: { type: "boolean" },
          required: { type: "boolean" },
          allow_custom: {
            type: "boolean",
            description: "For multiple_choice only; defaults to true.",
          },
          custom_label: {
            type: "string",
            description: "Label for the multiple_choice custom input (defaults to 'Add details').",
          },
          placeholder: { type: "string" },
          rows: { type: "number" },
          min: { type: "number" },
          max: { type: "number" },
          step: { type: "number" },
          options: {
            type: "array",
            minItems: 1,
            items: {
              type: "object",
              required: ["id", "label"],
              properties: {
                id: { type: "string" },
                label: { type: "string" },
                description: { type: "string" },
                value: { type: "string" },
              },
            },
          },
        },
      },
    },
  },
} as const;

export const clarificationStepperExample = {
  version: 1,
  layout: "stepper",
  title: "Tailor the response",
  description: "Answer a few quick questions so I can shape the output.",
  response_format:
    "Goal: {{goal}}\nAudience: {{audience}}\nFormat: {{format}}\nDetail: {{detail}}\nConstraints: {{constraints}}\nTone: {{tone}}",
  submit_label: "Send answers",
  questions: [
    {
      id: "goal",
      prompt: "What do you want from the response?",
      help: "Pick the closest outcome. Add a custom option if needed.",
      required: true,
      options: [
        { id: "summarize", label: "Summarize the content" },
        { id: "convert", label: "Convert into a step-by-step guide" },
        { id: "critique", label: "Review for issues or gaps" },
      ],
    },
    {
      id: "audience",
      prompt: "Who is the audience?",
      allow_multiple: true,
      options: [
        { id: "founders", label: "Founders / leadership" },
        { id: "engineering", label: "Engineering team" },
        { id: "design", label: "Design / UX team" },
        { id: "customers", label: "End users" },
      ],
    },
    {
      id: "format",
      prompt: "Preferred delivery format?",
      required: true,
      options: [
        { id: "cards", label: "Step-by-step cards" },
        { id: "checklist", label: "Checklist" },
        { id: "doc", label: "One-page doc" },
      ],
    },
    {
      id: "detail",
      prompt: "How much detail do you want?",
      options: [
        { id: "high", label: "Deep detail with examples" },
        { id: "medium", label: "Balanced detail" },
        { id: "low", label: "Short and crisp" },
      ],
    },
    {
      id: "constraints",
      type: "textarea",
      prompt: "Any constraints or must-haves?",
      help: "Examples: budget, deadlines, technologies to use/avoid, compliance needs.",
      placeholder: "Type your constraints here…",
      rows: 4,
    },
    {
      id: "tone",
      prompt: "Preferred tone?",
      options: [
        { id: "direct", label: "Direct and concise" },
        { id: "friendly", label: "Friendly and helpful" },
        { id: "executive", label: "Executive summary style" },
      ],
    },
  ],
} as const;

export const clarificationStepperExampleBlock = `\`\`\`clarification
${JSON.stringify(clarificationStepperExample, null, 2)}
\`\`\``;
