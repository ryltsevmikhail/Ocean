import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deterministicProvider } from './github-fixture.mjs';

test('qualification provider requests the selected repository and reports actual tool content', async () => {
  const provider = deterministicProvider({ repository: 'selected/project', issueNumber: 5 });
  const events = [];
  for await (const event of provider.stream({
    messages: [{ role: 'user', content: 'read' }],
    tools: [{ name: 'issue_read' }],
  }))
    events.push(event);
  assert.deepEqual(JSON.parse(events.find((event) => event.type === 'tool_call').call.arguments), {
    owner: 'selected',
    repo: 'project',
    method: 'get',
    issue_number: 5,
  });
  const answer = [];
  for await (const event of provider.stream({
    messages: [{ role: 'tool', content: 'actual unique endpoint marker' }],
    tools: [],
  }))
    answer.push(event);
  assert.match(
    answer.find((event) => event.type === 'text_delta').text,
    /actual unique endpoint marker/,
  );
  assert.doesNotMatch(JSON.stringify(answer), /Composer loses focus|team\/api/);
});
