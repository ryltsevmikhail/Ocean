import type { ToolPermissionPort } from '@runnets/application';
import type { RequestPermissionResult } from '@runnets/contracts';
import type { JsonRpcPeer } from './transport.js';

/** Only a recognized selected option authorizes an operation; disconnect and abort deny it. */
export function acpPermissions(peer: JsonRpcPeer, sessionId: string): ToolPermissionPort {
  let counter = 0;
  return {
    async review(tool, signal) {
      counter++;
      try {
        const result = await peer.request<RequestPermissionResult>(
          'session/request_permission',
          {
            sessionId,
            toolCall: {
              toolCallId: `${sessionId}_approval_${counter}`,
              title: tool.title,
              kind: tool.kind,
              content: [{ type: 'content', content: { type: 'text', text: tool.preview } }],
            },
            options: [
              { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
              {
                optionId: 'allow_session',
                name: 'Allow this exact operation for this session',
                kind: 'allow_always',
              },
              { optionId: 'reject', name: 'Deny', kind: 'reject_once' },
            ],
          },
          signal,
        );
        if (result.outcome.outcome !== 'selected') return 'reject';
        const id = result.outcome.optionId;
        return id === 'allow_once' || id === 'allow_session' ? id : 'reject';
      } catch {
        return 'reject';
      }
    },
  };
}
