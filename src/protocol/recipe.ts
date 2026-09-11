import { z } from 'zod';
import { LIMITS } from './limits';
import { selectorSchema } from './common';

/**
 * Declarative extraction recipe. Contains selectors and read
 * operations only. There is intentionally no place to put code, regexes,
 * property paths or URLs.
 */

export const RECIPE_SCHEMA_VERSION = 1 as const;

/** Attributes we refuse to read no matter what a recipe asks for. */
export const FORBIDDEN_ATTRIBUTE_PATTERNS: readonly RegExp[] = [
  /^on/i, // event handlers
  /^srcdoc$/i,
  /^value$/i, // input/textarea values (also blocked by element type)
  /^nonce$/i,
  /^integrity$/i,
];

/** Elements whose content we never read (drafts, credentials, form data). */
export const SENSITIVE_ELEMENT_SELECTOR = 'input, textarea, select, option, [contenteditable]:not([contenteditable="false"]), script, style, template, noscript, object, embed';

export const attributeNameSchema = z
  .string()
  .min(1)
  .max(LIMITS.recipeMaxAttributeNameLength)
  .regex(/^[A-Za-z_][A-Za-z0-9_:.-]*$/, 'not a valid attribute name')
  .refine((name) => !FORBIDDEN_ATTRIBUTE_PATTERNS.some((re) => re.test(name)), {
    message: 'attribute is not permitted',
  });

const fieldBase = {
  /** Resolved relative to each record element. ":scope" means the record itself. */
  selector: selectorSchema,
  required: z.boolean().default(false),
  /** Short human note; never used for matching. */
  note: z.string().max(200).optional(),
};

export const fieldSchema = z.discriminatedUnion('read', [
  z.object({ ...fieldBase, read: z.literal('text'), multiple: z.boolean().default(false) }),
  z.object({
    ...fieldBase,
    read: z.literal('attribute'),
    attribute: attributeNameSchema,
    multiple: z.boolean().default(false),
  }),
  z.object({ ...fieldBase, read: z.literal('exists') }),
  z.object({ ...fieldBase, read: z.literal('count') }),
]);
export type RecipeField = z.infer<typeof fieldSchema>;
export type RecipeFieldInput = z.input<typeof fieldSchema>;

export const fieldNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'field names must be identifiers');

export const recipeSchema = z
  .object({
    schemaVersion: z.literal(RECIPE_SCHEMA_VERSION),
    name: z.string().min(1).max(LIMITS.recipeMaxNameLength),
    /** Optional: when present the recipe expects this root; the session root is still what is used. */
    rootSelector: selectorSchema.optional(),
    recordSelector: selectorSchema,
    fields: z.record(fieldNameSchema, fieldSchema).refine((f) => Object.keys(f).length >= 1, 'at least one field required'),
    /** Field names whose combined values form the extracted identity. */
    identityFields: z.array(fieldNameSchema).max(LIMITS.recipeMaxFields).default([]),
  })
  .strict()
  .superRefine((recipe, ctx) => {
    const names = Object.keys(recipe.fields);
    if (names.length > LIMITS.recipeMaxFields) {
      ctx.addIssue({
        code: 'custom',
        path: ['fields'],
        message: `too many fields (max ${LIMITS.recipeMaxFields})`,
      });
    }
    for (const id of recipe.identityFields) {
      if (!names.includes(id)) {
        ctx.addIssue({ code: 'custom', path: ['identityFields'], message: `unknown field "${id}"` });
        continue;
      }
      const f = recipe.fields[id]!;
      if (f.read === 'exists' || f.read === 'count') {
        ctx.addIssue({ code: 'custom', path: ['identityFields'], message: `field "${id}" cannot be an identity (${f.read})` });
      } else if (f.multiple) {
        ctx.addIssue({ code: 'custom', path: ['identityFields'], message: `multi-valued field "${id}" cannot be an identity` });
      }
    }
  });

export type Recipe = z.infer<typeof recipeSchema>;
export type RecipeInput = z.input<typeof recipeSchema>;

/**
 * Parse an untrusted recipe (e.g. pasted JSON). Returns a structured failure
 * with paths only — never echoes back values, which may be sensitive selectors.
 */
export function parseRecipe(input: unknown): { ok: true; recipe: Recipe } | { ok: false; issues: string[] } {
  const result = recipeSchema.safeParse(input);
  if (result.success) return { ok: true, recipe: result.data };
  const issues = result.error.issues.slice(0, 20).map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
  return { ok: false, issues };
}
