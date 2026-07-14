const WHOLE_STRING_PLACEHOLDER = /^\{\{\s*([\w.]+)\s*\}\}$/;
const PLACEHOLDER = /\{\{\s*([\w.]+)\s*\}\}/g;

export interface StepOutputs {
  [stepId: string]: { output?: string };
}

interface TemplateContext {
  workflowInput: Record<string, unknown>;
  steps: StepOutputs;
}

function getPath(root: TemplateContext, path: string): unknown {
  return path.split(".").reduce<unknown>((current, segment) => {
    if (current && typeof current === "object" && segment in (current as Record<string, unknown>)) {
      return (current as Record<string, unknown>)[segment];
    }
    return undefined;
  }, root);
}

// A template that is *entirely* one placeholder (e.g. "{{workflowInput.body}}")
// resolves to the raw referenced value, including `undefined` when the value
// is absent — so the caller can omit that field instead of sending an empty
// string. A template with surrounding text interpolates missing values as "".
function resolveTemplateValue(template: string, context: TemplateContext): unknown {
  const wholeMatch = template.match(WHOLE_STRING_PLACEHOLDER);
  if (wholeMatch) {
    return getPath(context, wholeMatch[1]);
  }

  return template.replace(PLACEHOLDER, (_match, path: string) => {
    const value = getPath(context, path);
    return value === undefined ? "" : String(value);
  });
}

export function resolveStepInput(
  inputTemplates: Record<string, string> | undefined,
  workflowInput: Record<string, unknown>,
  stepOutputs: StepOutputs,
): Record<string, unknown> | undefined {
  if (!inputTemplates) {
    return undefined;
  }

  const context: TemplateContext = { workflowInput, steps: stepOutputs };
  const resolved: Record<string, unknown> = {};

  for (const [key, template] of Object.entries(inputTemplates)) {
    const value = resolveTemplateValue(template, context);
    if (value !== undefined) {
      resolved[key] = value;
    }
  }

  return resolved;
}
