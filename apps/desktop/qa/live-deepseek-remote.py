"""Ephemeral fixed-origin transport. No remote files, retries or key output."""
import base64
import http.client
import json
from pathlib import Path
import sys


def run(source, sink, key_reader=None, connection_factory=None):
    def emit(value):
        sink.write(json.dumps(value) + '\n')
        sink.flush()
    started = False
    connection = None
    try:
        body = source.buffer.read(2 * 1024 * 1024 + 1)
        if len(body) > 2 * 1024 * 1024:
            raise ValueError('body_limit')
        payload = json.loads(body)
        if payload.get('stream') is not True or not isinstance(payload.get('messages'), list):
            raise ValueError('invalid_request')
        key = (key_reader or (lambda: (Path.home() / '.config/ocean/deepseek.key').read_text()))().strip()
        if not key:
            raise ValueError('empty_key')
        connection = (connection_factory or http.client.HTTPSConnection)('api.deepseek.com', timeout=180)
        emit({'type': 'dispatching'})
        started = True
        connection.request('POST', '/chat/completions', body=body, headers={
            'Authorization': 'Bearer ' + key,
            'Content-Type': 'application/json', 'Accept': 'text/event-stream'})
        response = connection.getresponse()
        emit({'type': 'headers', 'status': response.status})
        while True:
            chunk = response.read1(8192)
            if not chunk:
                break
            emit({'type': 'data', 'base64': base64.b64encode(chunk).decode('ascii')})
        emit({'type': 'done'})
    except BaseException:
        emit({'type': 'failure', 'outcome': 'unknown' if started else 'not_started'})
    finally:
        if connection is not None:
            connection.close()


if __name__ == '__main__':
    run(sys.stdin, sys.stdout)
