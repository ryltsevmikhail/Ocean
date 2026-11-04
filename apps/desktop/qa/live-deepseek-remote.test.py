"""Offline protocol/custody tests; these never contact DeepSeek or read a key."""
import base64
import importlib.util
import io
import json
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location(
    'remote', Path(__file__).with_name('live-deepseek-remote.py')
)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
run = module.run


class Source:
    def __init__(self, body):
        self.buffer = io.BytesIO(body)


class Remote(unittest.TestCase):
    def test_fixed_authority_bytes_and_no_secret_output(self):
        observed = []
        body = b'{"model":"deepseek-flash","stream":true,"messages":[]}'
        chunks = [b'data: {"content":"\xe2\x98\x83"}\n\n', b'data: [DONE]\n\n']

        class Connection:
            status = 200

            def __init__(self, host, timeout):
                observed.append((host, timeout))
                self.chunks = iter([*chunks, b''])

            def request(self, method, path, body, headers):
                observed.append((method, path, body, headers))

            def getresponse(self):
                return self

            def read1(self, _size):
                return next(self.chunks)

            def close(self):
                observed.append('closed')

        out = io.StringIO()
        run(Source(body), out, lambda: 'secret-canary', Connection)
        frames = [json.loads(line) for line in out.getvalue().splitlines()]
        self.assertEqual(observed[0], ('api.deepseek.com', 180))
        self.assertEqual(observed[1][:3], ('POST', '/chat/completions', body))
        self.assertEqual(observed[1][3]['Authorization'], 'Bearer secret-canary')
        self.assertNotIn('secret-canary', out.getvalue())
        self.assertEqual(frames[-1], {'type': 'done'})
        self.assertEqual(observed[-1], 'closed')
        forwarded = b''.join(
            base64.b64decode(frame['base64'])
            for frame in frames if frame['type'] == 'data'
        )
        self.assertEqual(forwarded, b''.join(chunks))

    def test_ambiguous_failure_is_unknown_and_never_retried(self):
        calls = []

        class Connection:
            def __init__(self, *_args, **_kwargs):
                pass

            def request(self, *_args, **_kwargs):
                calls.append(1)
                raise RuntimeError('secret-canary')

            def close(self):
                pass

        out = io.StringIO()
        run(Source(b'{"stream":true,"messages":[]}'), out,
            lambda: 'secret-canary', Connection)
        self.assertEqual(calls, [1])
        self.assertNotIn('secret-canary', out.getvalue())
        self.assertEqual(json.loads(out.getvalue().splitlines()[-1]),
                         {'type': 'failure', 'outcome': 'unknown'})

    def test_invalid_input_does_not_read_key_or_connect(self):
        def forbid(*_args, **_kwargs):
            self.fail('unexpected effect')

        out = io.StringIO()
        run(Source(b'{}'), out, forbid, forbid)
        self.assertEqual(json.loads(out.getvalue()),
                         {'type': 'failure', 'outcome': 'not_started'})


if __name__ == '__main__':
    unittest.main()
