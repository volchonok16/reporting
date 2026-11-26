"""Boundary tests for the Reporting -> existing Dogtags workspace gateway."""
import unittest
from unittest.mock import MagicMock, patch

import httpx
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.db import get_db
from app.dogtags_routes import router


class DogtagsGatewayTests(unittest.TestCase):
    def setUp(self):
        app = FastAPI()
        app.include_router(router)
        app.dependency_overrides[get_db] = lambda: MagicMock()
        self.client = TestClient(app)
        self.meta = {'app_role': 'full', 'app_login': 'operator@example.test'}
        self.auth = patch('app.app_access.get_session_with_meta', side_effect=lambda sid: (object(), self.meta) if sid == 'valid' else (None, {}))
        self.auth.start()
        self.addCleanup(self.auth.stop)
        self.headers = {'X-Session-Id': 'valid'}
        self.config = patch('app.dogtags_routes.settings', dogtags_manager_url='http://dogtags-upstream:8000', dogtags_manager_origin='http://127.0.0.1:8000')
        self.config.start()
        self.addCleanup(self.config.stop)

    def transport(self, handler):
        real_client = httpx.AsyncClient
        patcher = patch('app.dogtags_routes.httpx.AsyncClient', side_effect=lambda **kw: real_client(transport=httpx.MockTransport(handler), **kw))
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_requires_reporting_login_before_upstream(self):
        self.transport(lambda request: self.fail('unauthorized request reached upstream'))
        self.assertEqual(self.client.get('/api/dogtags-manager/intakes').status_code, 401)

    def test_voice_only_and_roadmap_users_cannot_access_workspace(self):
        self.transport(lambda request: self.fail('forbidden request reached upstream'))
        for flags in ({'voice_only': True}, {'app_role': 'roadmap'}, {'must_change_password': True}):
            with self.subTest(flags=flags):
                self.meta.update(flags)
                self.assertEqual(self.client.get('/api/dogtags-manager/intakes', headers=self.headers).status_code, 403)
                self.meta = {'app_role': 'full'}

    def test_proxies_query_and_download_bytes_without_reporting_credentials(self):
        data = b'INN;MSISDN\r\n123;79990000001\r\n'
        def handler(request):
            self.assertEqual(str(request.url), 'http://dogtags-upstream:8000/api/intakes?limit=5&after=a%2Bb')
            self.assertNotIn('x-session-id', request.headers)
            self.assertNotIn('authorization', request.headers)
            self.assertEqual(request.headers['host'], '127.0.0.1:8000')
            return httpx.Response(200, stream=httpx.ByteStream(data), headers={'Content-Type': 'text/csv', 'Content-Disposition': 'attachment; filename=result.csv'})
        self.transport(handler)
        r = self.client.get('/api/dogtags-manager/intakes?limit=5&after=a%2Bb', headers={**self.headers, 'Authorization': 'do-not-forward'})
        self.assertEqual(r.content, data)
        self.assertEqual(r.headers['content-disposition'], 'attachment; filename=result.csv')

    def test_preserves_multipart_operation_and_csrf_scopes_cookie(self):
        def handler(request):
            self.assertEqual(request.headers['origin'], 'http://127.0.0.1:8000')
            self.assertEqual(request.headers['x-csrf-token'], 'csrf')
            self.assertEqual(request.headers['x-operation-id'], 'op')
            self.assertEqual(request.headers['cookie'], 'dogtags_session=upstream-session')
            self.assertIn(b'smoke.csv', request.read())
            return httpx.Response(201, stream=httpx.ByteStream(b'{"id":"upload"}'), headers={'set-cookie': 'dogtags_session=new; HttpOnly; SameSite=Strict; Path=/'})
        self.transport(handler)
        self.client.cookies.set('dogtags_session', 'upstream-session')
        self.client.cookies.set('unrelated_secret', 'never-forward')
        r = self.client.post('/api/dogtags-manager/intakes', headers={**self.headers, 'Origin': 'http://localhost:5173', 'X-CSRF-Token': 'csrf', 'X-Operation-ID': 'op'}, files={'file': ('smoke.csv', b'A,B\n1,2')})
        self.assertEqual(r.status_code, 201)
        self.assertIn('Path=/api/dogtags-manager', r.headers['set-cookie'])
        self.assertIn('HttpOnly', r.headers['set-cookie'])

    def test_upstream_unavailable_returns_actionable_error(self):
        self.transport(lambda request: (_ for _ in ()).throw(httpx.ConnectError('unavailable')))
        r = self.client.get('/api/dogtags-manager/session', headers=self.headers)
        self.assertEqual(r.status_code, 502)
        self.assertEqual(r.json()['error']['code'], 'dogtags_unavailable')

    def test_failed_download_closes_upstream_stream(self):
        class BrokenStream(httpx.AsyncByteStream):
            closed = False

            async def __aiter__(self):
                yield b'first chunk'
                raise httpx.ReadError('connection interrupted')

            async def aclose(self):
                self.closed = True

        stream = BrokenStream()
        self.transport(lambda request: httpx.Response(200, stream=stream))
        with self.assertRaises(httpx.ReadError):
            self.client.get('/api/dogtags-manager/cases/download', headers=self.headers)
        self.assertTrue(stream.closed)

    def test_unconfigured_workspace_returns_503(self):
        with patch('app.dogtags_routes.settings.dogtags_manager_url', ''):
            self.assertEqual(self.client.get('/api/dogtags-manager/session', headers=self.headers).status_code, 503)


if __name__ == '__main__':
    unittest.main()
