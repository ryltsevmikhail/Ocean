import type { ToolSchema } from '@runnets/application';
const text = { type: 'string' };
const object = (
  properties: Record<string, unknown>,
  required: readonly string[],
): Record<string, unknown> => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});
/** Fixed schemas; the adapter validates arguments again before preparing an effect. */
export const TOOL_DEFINITIONS: readonly ToolSchema[] = [
  {
    name: 'list_files',
    description:
      'List immediate children of a project directory. Hidden secrets, .git and node_modules are excluded.',
    parameters: object({ path: text }, ['path']),
  },
  {
    name: 'read_file',
    description:
      'Read a UTF-8 project file, optionally selecting a 1-based line range. Output includes line numbers.',
    parameters: object(
      {
        path: text,
        start_line: { type: 'integer', minimum: 1 },
        end_line: { type: 'integer', minimum: 1 },
      },
      ['path'],
    ),
  },
  {
    name: 'write_file',
    description:
      'Create or replace a UTF-8 file. Existing files must first be read. Requires approval and rejects concurrent modifications.',
    parameters: object({ path: text, content: text }, ['path', 'content']),
  },
  {
    name: 'replace_text',
    description:
      'Replace exactly one occurrence of old_text in a previously read file. Requires approval.',
    parameters: object({ path: text, old_text: text, new_text: text }, [
      'path',
      'old_text',
      'new_text',
    ]),
  },
  {
    name: 'run_command',
    description:
      'Run a program with structured arguments in a project directory, without an implicit shell. Requires approval. Use for search, build and tests. Never use to bypass a denied file operation.',
    parameters: object({ program: text, args: { type: 'array', items: text }, cwd: text }, [
      'program',
      'args',
      'cwd',
    ]),
  },
];
